#!/usr/bin/env python3
"""Build both carriageways and local interchange arms from the cached OSM extract."""
import collections
import heapq
import json
import math
from pathlib import Path
from moscow_clearance import clearance, clearance_status, ribbon_constraints

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data/moscow'
RADIUS = 6371008.8


def project(p):
    return (RADIUS * math.radians(p['lon'] - 37.616692) * math.cos(math.radians(55.576894)),
            -RADIUS * math.radians(p['lat'] - 55.576894))


def build():
    raw = json.loads((DATA / 'roads.osm.json').read_text())
    route = json.loads((DATA / 'route.json').read_text())
    ways = {w['id']: w for w in raw['elements'] if w.get('tags', {}).get('access') not in ('no', 'private')
            and w.get('tags', {}).get('motor_vehicle') not in ('no', 'private')}
    coords, incident = {}, collections.defaultdict(set)
    for w in ways.values():
        for n, p in zip(w['nodes'], w['geometry']):
            # Audit exactly the coordinates that will be serialized.
            coords[n] = tuple(round(v, 4) for v in project(p))
            incident[n].add(w['id'])
    seeds = {s['wayId'] for s in route['sections']}
    # Sample the real route into a spatial hash; include crossing roads and the opposite
    # carriageway, not an invented mirrored copy of the selected itinerary.
    cells = collections.defaultdict(list)
    for wid in seeds:
        w = ways[wid]
        for a, b in zip(w['nodes'], w['nodes'][1:]):
            p, q = coords[a], coords[b]
            count = max(1, math.ceil(math.dist(p, q) / 30))
            for i in range(count + 1):
                t = i / count
                x, z = p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
                cells[math.floor(x / 200), math.floor(z / 200)].append((x, z))

    def nearby(n):
        p = coords[n]
        cx, cz = math.floor(p[0] / 200), math.floor(p[1] / 200)
        return any(math.dist(p, q) <= 200 for dx in (-1, 0, 1) for dz in (-1, 0, 1)
                   for q in cells[cx + dx, cz + dz])

    major = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}
    selected = seeds | {wid for wid, w in ways.items()
                        if w['tags']['highway'].removesuffix('_link') in major
                        and any(nearby(n) for n in w['nodes'])}
    # Follow every attached ramp to its actual terminal road, recursively. Do not
    # truncate a cloverleaf simply because it leaves the route's narrow corridor.
    pending = list(selected)
    while pending:
        wid = pending.pop()
        for n in ways[wid]['nodes']:
            for other in incident[n] - selected:
                if ways[other]['tags']['highway'].endswith('_link'):
                    selected.add(other)
                    pending.append(other)
    # Include whole approach ways up to 800 m from the ramp terminals and crossings.
    ramp_nodes = {n for wid in selected for n in ways[wid]['nodes']
                  if ways[wid]['tags']['highway'].endswith('_link') or nearby(n)}
    graph = collections.defaultdict(list)
    for wid, w in ways.items():
        if w['tags']['highway'].removesuffix('_link') not in major:
            continue
        for a, b in zip(w['nodes'], w['nodes'][1:]):
            d = math.dist(coords[a], coords[b])
            graph[a].append((b, d, wid))
            graph[b].append((a, d, wid))
    distances = {n: 0 for n in ramp_nodes}
    queue = [(0, n) for n in ramp_nodes]
    heapq.heapify(queue)
    while queue:
        d, n = heapq.heappop(queue)
        if d != distances[n] or d > 800:
            continue
        for target, length, wid in graph[n]:
            selected.add(wid)
            candidate = d + length
            if candidate < distances.get(target, math.inf) and candidate <= 800:
                distances[target] = candidate
                heapq.heappush(queue, (candidate, target))
    # Keep only the physical component containing the itinerary. A nearby but
    # disconnected parallel street must not turn into an isolated traffic world.
    reachable, todo = set(), [next(iter(seeds))]
    while todo:
        wid = todo.pop()
        if wid in reachable or wid not in selected:
            continue
        reachable.add(wid)
        for n in ways[wid]['nodes']:
            todo.extend(incident[n] & selected - reachable)
    chosen = [ways[wid] for wid in sorted(reachable)]
    # Heights are an explicit engineering approximation: relative OSM layer * 8m,
    # bridge without layer = +1, tunnel without layer = -1. Shared OSM nodes share
    # one elevation. Propagate elevation envelopes along roads to keep grades <=6%.
    adjacency = collections.defaultdict(list)
    heights, anchors = {}, {}
    for w in chosen:
        tags = w['tags']
        try:
            level = int(tags.get('layer', '0'))
        except ValueError:
            level = 0
        if 'layer' not in tags:
            level = 1 if tags.get('bridge') == 'yes' else -1 if tags.get('tunnel') == 'yes' else 0
        if level:
            for n in w['nodes'][1:-1] or w['nodes']:
                if abs(level * 8) > abs(anchors.get(n, 0)):
                    anchors[n] = level * 8
        for n in w['nodes']:
            heights[n] = 0
        for a, b in zip(w['nodes'], w['nodes'][1:]):
            d = math.dist(coords[a], coords[b])
            adjacency[a].append((b, d))
            adjacency[b].append((a, d))

    def envelope(sign, source=anchors):
        values = {n: max(0, h * sign) for n, h in source.items() if h * sign > 0}
        queue = [(-h, n) for n, h in values.items()]
        heapq.heapify(queue)
        while queue:
            minus, n = heapq.heappop(queue)
            if -minus != values[n]:
                continue
            for b, distance in adjacency[n]:
                h = -minus - .06 * distance
                if h > values.get(b, 0):
                    values[b] = h
                    heapq.heappush(queue, (-h, b))
        return values
    up, down = envelope(1), envelope(-1)
    # Enforce actual centreline crossing clearance, not merely distinct layer labels.
    # Approach envelopes can otherwise lift the lower road near a short ramp.
    bins, checked, crossings, ambiguous_pairs = collections.defaultdict(list), set(), [], []
    def level(w):
        tags = w['tags']
        try:
            return int(tags['layer']) if 'layer' in tags else (1 if tags.get('bridge') == 'yes' else -1 if tags.get('tunnel') == 'yes' else 0)
        except ValueError:
            return 0
    for w in chosen:
        for a, b in zip(w['nodes'], w['nodes'][1:]):
            p, q = coords[a], coords[b]
            for cx in range(math.floor(min(p[0], q[0]) / 100), math.floor(max(p[0], q[0]) / 100) + 1):
                for cz in range(math.floor(min(p[1], q[1]) / 100), math.floor(max(p[1], q[1]) / 100) + 1):
                    for old, c, d in bins[cx, cz]:
                        key = tuple(sorted(((w['id'], a, b), (old['id'], c, d))))
                        if key in checked or w['id'] == old['id'] or {a, b} & {c, d}:
                            continue
                        checked.add(key)
                        r, s = coords[c], coords[d]
                        ux, uz, vx, vz = q[0] - p[0], q[1] - p[1], s[0] - r[0], s[1] - r[1]
                        det = ux * vz - uz * vx
                        if abs(det) < 1e-8:
                            continue
                        dx, dz = r[0] - p[0], r[1] - p[1]
                        t, u = (dx * vz - dz * vx) / det, (dx * uz - dz * ux) / det
                        if 0 < t < 1 and 0 < u < 1:
                            if level(w) == level(old):
                                ambiguous_pairs.append({'wayIds': [w['id'], old['id']], 'nodes': [a, b, c, d]})
                            high, low = ((a, b, t), (c, d, u)) if level(w) > level(old) else ((c, d, u), (a, b, t))
                            crossings.append((high, low, level(w) != level(old)))
                    bins[cx, cz].append((w, a, b))
    def height(n):
        return up.get(n, 0) - down.get(n, 0)
    def at(segment):
        a, b, t = segment
        return height(a) * (1 - t) + height(b) * t
    initial_up = dict(up)
    for iteration in range(120):
        raises = {}
        for high, low, distinct in crossings:
            if not distinct:
                continue
            gap = at(high) - at(low)
            if gap < 6:
                for n in high[:2]:
                    raises[n] = max(raises.get(n, 0), up.get(n, 0) + 6.05 - gap)
        if not raises:
            break
        # Re-propagate the same grade-bounded envelope, retaining prior constraints.
        source = dict(up)
        source.update(raises)
        candidate = envelope(1, source)
        if any(value > initial_up.get(n, 0) + 16 + 1e-8 for n, value in candidate.items()):
            break
        up = candidate
    unresolved = [{'upperNodes': list(h[:2]), 'lowerNodes': list(l[:2]), 'clearance': round(at(h) - at(l), 3)}
                  for h, l, distinct in crossings if distinct and at(h) - at(l) < 5.99]
    ambiguous = sum(not distinct for _, _, distinct in crossings)
    # Inconsistent ordering is a reported unresolved constraint, never a reason
    # to keep elevating the connected component indefinitely.
    # Full-width conservative envelopes catch edge-only overlaps and clearance
    # loss on grades. Never let inconsistent/near-junction constraints send an
    # entire connected component to arbitrary altitude: bound extra correction.
    junctions = []
    ribbons, ribbon_ambiguous, excluded = ribbon_constraints(chosen, coords, junctions=junctions)
    baseline = dict(up)
    baseline_down = dict(down)
    before = [clearance(record, height) for record in ribbons]
    correction_limit = 16.0
    for ribbon_iteration in range(120):
        raises = {}
        for record in ribbons:
            gap = clearance(record, height)
            if gap >= 6.4:
                continue
            proposed = {n: up.get(n, 0) + 6.45 - gap for n in record['upperNodes']}
            if any(value > baseline.get(n, 0) + correction_limit for n, value in proposed.items()):
                continue
            for n, value in proposed.items():
                raises[n] = max(raises.get(n, 0), value)
        if not raises:
            break
        source = dict(up)
        source.update(raises)
        candidate = envelope(1, source)
        # Envelope propagation itself must obey the same node-local budget.
        if any(value > baseline.get(n, 0) + correction_limit + 1e-8 for n, value in candidate.items()):
            break
        def candidate_at(segment):
            a, b, t = segment
            return ((candidate.get(a, 0) - down.get(a, 0)) * (1-t)
                    + (candidate.get(b, 0) - down.get(b, 0)) * t)
        if any(candidate_at(h) - candidate_at(l) < 5.9999 for h, l, distinct in crossings if distinct):
            # Retry independent constraints in deterministic order rather than
            # allowing one conflict to block every safe correction.
            changed = False
            for record in ribbons:
                gap = clearance(record, height)
                if gap >= 6.4:
                    continue
                source = dict(up)
                for n in record['upperNodes']:
                    source[n] = up.get(n, 0) + 6.45 - gap
                candidate = envelope(1, source)
                if any(value > baseline.get(n, 0) + correction_limit + 1e-8 for n, value in candidate.items()):
                    continue
                if any(candidate_at(h) - candidate_at(l) < 5.9999 for h, l, distinct in crossings if distinct):
                    continue
                up = candidate
                changed = True
            if not changed:
                break
            continue
        up = candidate
    # A local relative separation can also be restored by lowering the lower
    # approach. Never sacrifice a previously satisfied finite ribbon or a
    # centreline crossing, and retain the same finite per-node budget on both
    # signed envelopes. This avoids repeatedly lifting an entire interchange.
    relative_corrections = 0
    for _ in range(24):
        changed = False
        for record in ribbons:
            gap = clearance(record, height)
            if gap >= 6.399:
                continue
            source = dict(down)
            for n in record['lowerNodes']:
                source[n] = down.get(n, 0) + 6.45 - gap
            candidate = envelope(-1, {n: -v for n, v in source.items()})
            if any(value > baseline_down.get(n, 0) + correction_limit + 1e-8 for n, value in candidate.items()):
                continue
            def trial_height(n):
                return up.get(n, 0) - candidate.get(n, 0)
            if clearance(record, trial_height) <= gap + .001:
                continue
            if any(clearance(other, trial_height) < min(6.4, clearance(other, height)) - 1e-7 for other in ribbons):
                continue
            if any(trial_height(h[0]) * (1-h[2]) + trial_height(h[1]) * h[2]
                   - trial_height(l[0]) * (1-l[2]) - trial_height(l[1]) * l[2] < 5.9999
                   for h, l, distinct in crossings if distinct):
                continue
            down = candidate
            relative_corrections += 1
            changed = True
        if not changed:
            break
    for n in heights:
        # Separate signed envelopes can overlap; their maximum signed slope is 12%.
        heights[n] = round(.2 + up.get(n, 0) - down.get(n, 0), 4)
    # A correction can lift a different crossing's lower road. Report the final
    # serialized heights, never the pre-ribbon solver's now-stale success.
    def final_at(segment):
        a, b, t = segment
        return heights[a] * (1 - t) + heights[b] * t
    unresolved = [{'upperNodes': list(h[:2]), 'lowerNodes': list(l[:2]), 'clearance': round(final_at(h) - final_at(l), 4)}
                  for h, l, distinct in crossings if distinct and final_at(h) - final_at(l) < 5.99]
    ribbon_gaps = [clearance(record, heights.__getitem__) for record in ribbons]
    ribbon_unresolved = [{key: value for key, value in record.items() if key != 'samples'} | {'clearance': round(gap, 4)}
                         | clearance_status(record, heights.__getitem__)
                         for record, gap in zip(ribbons, ribbon_gaps) if gap < 6.4 - .001]
    expanded, _, _ = ribbon_constraints(chosen, coords, expanded=True)
    finite_keys = {tuple(record['nodes']) for record in ribbons}
    expanded_deficient = [record for record in expanded if clearance(record, heights.__getitem__) < 6.399]
    output = {'id': 'moscow-osm-network', 'source': route['source'],
              'heightModel': 'OSM relative layers, 8m per level, 6% approach envelopes; not surveyed',
              'coverage': '200m route corridor, complete attached link chains, 800m major-road approaches; whole OSM ways retained',
              'crossingAudit': {'crossings': len(crossings), 'ambiguousSameLayer': ambiguous,
                                'ambiguousPairs': ambiguous_pairs,
                                'minimumClearance': min((final_at(h) - final_at(l) for h, l, distinct in crossings if distinct), default=0),
                                 'unresolved': unresolved},
              'ribbonAudit': {'model': 'exact convex overlap of finite constant-width OSM segment envelopes; affine heights; not exact rendered mesh',
                              'requiredSurfaceSeparation': 6.4, 'bridgeUndersideAllowance': .4,
                               'extraCorrectionLimit': correction_limit,
                               'centrelineCorrectionLimit': 16.0,
                               'maximumUpCorrectionFromLayerEnvelope': round(max(up.get(n, 0) - initial_up.get(n, 0) for n in heights), 4),
                               'maximumLowerCorrectionFromLayerEnvelope': round(max(down.get(n, 0) - baseline_down.get(n, 0) for n in heights), 4),
                               'boundedLowerApproachCorrections': relative_corrections,
                               'expandedDiagnostic': {'checkedPairs': len(expanded), 'deficientPairs': len(expanded_deficient),
                                                      'deficientPairsAbsentFromFiniteConstraints': sum(tuple(r['nodes']) not in finite_keys for r in expanded_deficient)},
                              'checkedDistinctLayerPairs': len(ribbons),
                              'initialDeficientPairs': sum(gap < 6.4 - .001 for gap in before),
                              'minimumClearance': min(ribbon_gaps, default=None),
                               'unresolved': ribbon_unresolved,
                               'unresolvedClassifications': dict(sorted(collections.Counter(r['classification'] for r in ribbon_unresolved).items())),
                               'ambiguousSameLayerPairs': ribbon_ambiguous,
                               'localMergeCandidates': junctions,
                              'excludedConnectedOrSameWayPairs': excluded,
                               'runtimeValidationRequired': True,
                               'runtimeValidationReason': 'Nonovershooting Hermite heights can differ from affine heights inside segments; planar smoothing and mitered strips also require runtime mesh validation. The 0.4m allowance is bridge thickness, not a bound on Hermite error.',
                               'notChecked': ['same-way joins and local shared-node merge candidates', 'same-layer ordering', 'bridge support columns',
                                             'tunnel shells and portals', 'exact rendered mesh and vehicles'],
                              'correctionIterations': ribbon_iteration},
              'nodes': {str(n): [round(coords[n][0], 4), heights[n], round(coords[n][1], 4)] for n in sorted(heights)},
              'ways': [{'id': w['id'], 'nodes': w['nodes'], 'tags': w['tags']} for w in chosen],
              'startWayId': route['sections'][0]['wayId']}
    (DATA / 'network.json').write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'ways': len(chosen), 'nodes': len(heights), 'elevatedNodes': sum(h > 1 for h in heights.values()),
                      'rampWays': sum(w['tags']['highway'].endswith('_link') for w in chosen),
                      'ribbonChecked': len(ribbons), 'ribbonInitialDeficient': sum(gap < 6.399 for gap in before),
                      'ribbonUnresolved': len(ribbon_unresolved), 'ribbonMinimumClearance': min(ribbon_gaps, default=None)}, indent=2))


if __name__ == '__main__':
    build()
