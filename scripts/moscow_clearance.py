"""Finite OSM ribbon envelopes, not surveyed or rendered-mesh geometry.

Clipping and affine extrema are exact for this constant-width segment model,
not for tangent-normal miters, junction meshes or runtime Hermite elevations.
Expanded end caps remain available as a diagnostic, not clearance constraints.
"""
import collections
import math
import re


def layer(way):
    tags = way['tags']
    try:
        return int(tags['layer']) if 'layer' in tags else (1 if tags.get('bridge') == 'yes' else -1 if tags.get('tunnel') == 'yes' else 0)
    except ValueError:
        return 0


def integer(value):
    # Match JavaScript parseInt, including a numeric prefix in OSM lane tags.
    match = re.match(r'^\s*([+-]?\d+)', value or '')
    return int(match[1]) if match else None


def radius(way):
    tags = way['tags']
    oneway = tags.get('oneway', 'yes' if tags['highway'] == 'motorway' or tags.get('junction') == 'roundabout' else 'no')
    both = oneway not in ('yes', '1', 'true', '-1')
    count = integer(tags.get('lanes'))
    widths = []
    for direction in ((1, -1) if both else ((-1,) if oneway == '-1' else (1,))):
        explicit = integer(tags.get('lanes:forward' if direction == 1 else 'lanes:backward'))
        lanes = max(1, explicit if explicit is not None else (count // 2 if both else count) if count is not None else 2)
        # 2% extra covers the bridge underside strip. Two-way offsets can
        # taper to zero at junctions, so bound both offset and no-offset cases.
        widths.append((lanes * 1.8 + 1.5) * 1.02 + (lanes * 1.8 + .25 if both else 0))
    return max(widths)


def cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def clip(poly, a, b):
    """Convex polygon clipped to the left of directed edge a -> b."""
    if not poly:
        return []
    edge = (b[0] - a[0], b[1] - a[1])
    result = []
    previous = poly[-1]
    dp = cross(edge, (previous[0] - a[0], previous[1] - a[1]))
    for current in poly:
        dc = cross(edge, (current[0] - a[0], current[1] - a[1]))
        if (dp >= 0) != (dc >= 0):
            t = dp / (dp - dc)
            result.append((previous[0] + t * (current[0] - previous[0]), previous[1] + t * (current[1] - previous[1])))
        if dc >= 0:
            result.append(current)
        previous, dp = current, dc
    return result


def rectangle(p, q, width, expanded=False):
    length = math.dist(p, q)
    u = ((q[0] - p[0]) / length, (q[1] - p[1]) / length)
    v = (-u[1], u[0])
    return [(base[0] + width * (along * u[0] + side * v[0]),
             base[1] + width * (along * u[1] + side * v[1]))
            for base, along, side in ((p, -int(expanded), -1), (q, int(expanded), -1), (q, int(expanded), 1), (p, -int(expanded), 1))]


def parameter(point, p, q):
    dx, dz = q[0] - p[0], q[1] - p[1]
    return max(0, min(1, ((point[0] - p[0]) * dx + (point[1] - p[1]) * dz) / (dx * dx + dz * dz)))


def ribbon_constraints(ways, coords, *, expanded=False, junctions=None):
    """Return extrema of clamped affine height differences over overlaps.

    Split the overlap along segment end planes before evaluating vertices:
    checking just polygon corners misses extrema where interpolation clamps.
    """
    bins, seen = collections.defaultdict(list), set()
    # Only a common OSM node is evidence of a merge. Spatial proximity or a
    # short path through unrelated roads is not permission to cross a deck.
    positions = {}
    for way in ways:
        distance, along = 0., {}
        previous = None
        for node in way['nodes']:
            if previous is not None:
                distance += math.dist(coords[previous], coords[node])
            along[node] = distance
            previous = node
        positions[way['id']] = along
    constraints, ambiguous, excluded = [], [], 0
    for way in ways:
        width = radius(way)
        for a, b in zip(way['nodes'], way['nodes'][1:]):
            p, q = coords[a], coords[b]
            if math.dist(p, q) < 1e-8:
                continue
            poly = rectangle(p, q, width, expanded)
            segment = (way, a, b, poly)
            keys = [(x, z) for x in range(math.floor(min(v[0] for v in poly) / 100), math.floor(max(v[0] for v in poly) / 100) + 1)
                    for z in range(math.floor(min(v[1] for v in poly) / 100), math.floor(max(v[1] for v in poly) / 100) + 1)]
            for key in keys:
                for old, c, d, old_poly in bins[key]:
                    identity = tuple(sorted(((way['id'], a, b), (old['id'], c, d))))
                    if identity in seen:
                        continue
                    seen.add(identity)
                    overlap = poly
                    for i in range(4):
                        overlap = clip(overlap, old_poly[i - 1], old_poly[i])
                    area = abs(sum(cross(overlap[i-1], overlap[i]) for i in range(len(overlap)))) / 2
                    if area < 1e-8:
                        continue
                    record = {'wayIds': [way['id'], old['id']], 'nodes': [a, b, c, d]}
                    shared = set(positions[way['id']]) & set(positions[old['id']])
                    # Require the *whole* overlap to be local along both arms,
                    # not just a pair of segments somewhere on connected ways.
                    merge_nodes = []
                    for node in sorted(shared):
                        limit = 2 * (width + radius(old))
                        if all(abs(positions[w['id']][start] + parameter(point, coords[start], coords[end])
                                   * (positions[w['id']][end] - positions[w['id']][start])
                                   - positions[w['id']][node]) <= limit
                               for w, start, end in ((way, a, b), (old, c, d)) for point in overlap):
                            merge_nodes.append(node)
                    if way['id'] == old['id'] or merge_nodes:
                        excluded += 1
                        if junctions is not None and way['id'] != old['id']:
                            junctions.append(record | {'sharedNodes': merge_nodes, 'classification': 'local-shared-node-merge-candidate'})
                        continue
                    if layer(way) == layer(old):
                        ambiguous.append(record)
                        continue
                    points = list(overlap)
                    # Add overlap-edge intersections with all four clamp planes.
                    lines = []
                    for start, end in ((p, q), (coords[c], coords[d])):
                        normal = (-(end[1] - start[1]), end[0] - start[0])
                        lines.extend((endpoint, (endpoint[0] + normal[0], endpoint[1] + normal[1])) for endpoint in (start, end))
                    for start, end in lines:
                        clipped = clip(overlap, start, end)
                        points.extend(clipped)
                    # Intersections between clamp planes can be interior extrema.
                    for i, (start, end) in enumerate(lines):
                        for other_start, other_end in lines[:i]:
                            u = (end[0] - start[0], end[1] - start[1])
                            v = (other_end[0] - other_start[0], other_end[1] - other_start[1])
                            det = cross(u, v)
                            if abs(det) < 1e-8:
                                continue
                            t = cross((other_start[0] - start[0], other_start[1] - start[1]), v) / det
                            point = (start[0] + t * u[0], start[1] + t * u[1])
                            if all(cross((overlap[j][0] - overlap[j-1][0], overlap[j][1] - overlap[j-1][1]), (point[0] - overlap[j-1][0], point[1] - overlap[j-1][1])) >= -1e-7 for j in range(len(overlap))):
                                points.append(point)
                    samples = sorted(set((parameter(point, p, q), parameter(point, coords[c], coords[d])) for point in points))
                    upper_first = layer(way) > layer(old)
                    record['upperNodes'] = [a, b] if upper_first else [c, d]
                    record['lowerNodes'] = [c, d] if upper_first else [a, b]
                    record['samples'] = [(t, u) if upper_first else (u, t) for t, u in samples]
                    constraints.append(record)
                bins[key].append(segment)
    return constraints, ambiguous, excluded


def clearance(record, height):
    a, b = record['upperNodes']
    c, d = record['lowerNodes']
    return min(height(a) * (1-t) + height(b) * t - height(c) * (1-u) - height(d) * u
               for t, u in record['samples'])


def clearance_status(record, height, required=6.4):
    """Distinguish reversed layer labels from actual absolute-gap deficiency.

    The signed affine difference is continuous on the convex overlap. Opposite
    signs therefore imply an interior zero, even if every vertex has a large
    absolute gap. Taking min(abs(vertex)) alone would incorrectly pass it.
    """
    a, b = record['upperNodes']
    c, d = record['lowerNodes']
    values = [height(a) * (1-t) + height(b) * t - height(c) * (1-u) - height(d) * u
              for t, u in record['samples']]
    low, high = min(values), max(values)
    absolute = 0. if low <= 0 <= high else min(abs(low), abs(high))
    return {'minimumSignedSeparation': round(low, 4), 'maximumSignedSeparation': round(high, 4),
            'minimumAbsoluteSeparation': round(absolute, 4),
            'classification': ('insufficient-absolute-separation' if absolute < required - .001
                               else 'reversed-layer-order' if high < 0 else 'clear')}
