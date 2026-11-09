"""Verify delivered W204 body-panel normals against authored COLLADA corners.

Run after export AND compression:
  blender --background --factory-startup --python-exit-code 1 \
    --python scripts/verify-w204-normals.py

Reads import.blend, normals.json, selected.json, raw.glb, inspection.glb,
compression.json and the public delivered GLB. Compression provenance must
contain deliveredSha256, inspectionSha256 and byteRoundtripVerified: true.
Does not import the GLB through Blender (which could recalculate its normals).
Writes only /tmp/opencode/w204/normals-final.json, after successful verification.
"""
import collections
import hashlib
import itertools
import json
import math
import pathlib
import struct
import sys
import xml.etree.ElementTree as ET

import bpy
from mathutils import Matrix, Quaternion, Vector
from mathutils.kdtree import KDTree

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from w204_collada_normals import NS, _geometry_corners

WORK = pathlib.Path('/tmp/opencode/w204')
DELIVERED = pathlib.Path(__file__).resolve().parents[1] / 'public/models/mercedes-w204.glb'
POSITION_TOLERANCE = 5e-5
NORMAL_TOLERANCE_DEGREES = 1.0
PERMUTATIONS = list(itertools.permutations(range(3)))
GROUPS = {
    'body': lambda n: n == 'c63w204kene_body_sedan',
    'hood': lambda n: n.startswith('c63w204kene_hood') and 'logo' not in n,
    'doors': lambda n: n.startswith('c63w204kene_door_'),
    'fenders': lambda n: n.startswith('c63w204kene_fender_'),
    'bumpers': lambda n: n.startswith(('c63w204kene_bumper_F', 'c63w204kene_bumper_R')),
}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def load_glb(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<III', data)
    require((magic, version, length) == (0x46546c67, 2, len(data)), 'Invalid GLB: ' + str(path))
    chunks = {}
    offset = 12
    while offset < len(data):
        size, kind = struct.unpack_from('<II', data, offset)
        chunks[kind] = data[offset + 8:offset + 8 + size]
        offset += size + 8
    return json.loads(chunks[0x4e4f534a]), chunks[0x004e4942]


def accessor(gltf, binary, index):
    a = gltf['accessors'][index]
    require('sparse' not in a and not a.get('normalized'), 'Unsupported sparse/normalized accessor')
    formats = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}
    widths = {'SCALAR': 1, 'VEC3': 3}
    fmt = '<' + formats[a['componentType']] * widths[a['type']]
    size = struct.calcsize(fmt)
    view = gltf['bufferViews'][a['bufferView']]
    require(view.get('buffer', 0) == 0, 'Expected decoded GLB buffer')
    require('EXT_meshopt_compression' not in view.get('extensions', {}), 'inspection.glb must be decoded')
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = view.get('byteStride', size)
    require(a['count'] == 0 or a.get('byteOffset', 0) + (a['count'] - 1) * stride + size <= view['byteLength'], 'Accessor out of bounds')
    return [struct.unpack_from(fmt, binary, start + i * stride) for i in range(a['count'])]


def node_matrix(node):
    if 'matrix' in node:
        values = node['matrix']
        return Matrix([values[i:i + 4] for i in range(0, 16, 4)]).transposed()
    x, y, z, w = node.get('rotation', [0, 0, 0, 1])
    return (Matrix.Translation(Vector(node.get('translation', [0, 0, 0]))) @
            Quaternion((w, x, y, z)).to_matrix().to_4x4() @
            Matrix.Diagonal((*node.get('scale', [1, 1, 1]), 1)))


def delivered_panels(gltf, binary, names):
    result = collections.defaultdict(list)

    def visit(index, parent):
        node = gltf['nodes'][index]
        world = parent @ node_matrix(node)
        name = node.get('name', '').removesuffix('_Selected')
        if name in names and 'mesh' in node:
            normal_matrix = world.to_3x3().inverted().transposed()
            for primitive in gltf['meshes'][node['mesh']]['primitives']:
                require(primitive.get('mode', 4) == 4, 'Panel primitive is not triangles: ' + name)
                attributes = primitive['attributes']
                require('NORMAL' in attributes, 'Missing final NORMAL: ' + name)
                positions = [world @ Vector(v) for v in accessor(gltf, binary, attributes['POSITION'])]
                normals = [normal_matrix @ Vector(v) for v in accessor(gltf, binary, attributes['NORMAL'])]
                require(len(positions) == len(normals), 'Attribute count mismatch: ' + name)
                require(all(all(math.isfinite(x) for x in v) for v in positions + normals), 'Nonfinite attribute: ' + name)
                indices = ([v[0] for v in accessor(gltf, binary, primitive['indices'])]
                           if 'indices' in primitive else list(range(len(positions))))
                require(len(indices) % 3 == 0, 'Incomplete triangle: ' + name)
                for start in range(0, len(indices), 3):
                    ids = indices[start:start + 3]
                    result[name].append(([positions[i] for i in ids], [normals[i] for i in ids]))
        for child in node.get('children', []):
            visit(child, world)

    for root in gltf['scenes'][gltf.get('scene', 0)]['nodes']:
        visit(root, Matrix.Identity(4))
    return result


def main():
    provenance = json.loads((WORK / 'compression.json').read_text())
    delivered_sha256 = hashlib.sha256(DELIVERED.read_bytes()).hexdigest()
    inspection_sha256 = hashlib.sha256((WORK / 'inspection.glb').read_bytes()).hexdigest()
    require(provenance.get('byteRoundtripVerified') is True,
            'compression.json must confirm byteRoundtripVerified: true')
    require(provenance.get('deliveredSha256') == delivered_sha256,
            'Delivered GLB SHA256 does not match compression.json; rerun compression')
    require(provenance.get('inspectionSha256') == inspection_sha256,
            'Inspection GLB SHA256 does not match compression.json; rerun compression')
    for name in ('raw.glb', 'inspection.glb'):
        require((WORK / name).stat().st_mtime_ns >= (WORK / 'import.blend').stat().st_mtime_ns,
                name + ' predates repaired import.blend; finish export/compression first')
    require((WORK / 'inspection.glb').stat().st_mtime_ns >= (WORK / 'raw.glb').stat().st_mtime_ns,
            'inspection.glb predates raw.glb; finish compression first')
    audit = json.loads((WORK / 'normals.json').read_text())
    selected = json.loads((WORK / 'selected.json').read_text())
    names = {r['mesh'] for r in selected['meshes'] + selected['props']}
    panels = {r['object']: r for r in audit['meshes'] if r['object'] in names and
              any(predicate(r['object']) for predicate in GROUPS.values())}
    for group, predicate in GROUPS.items():
        require(any(predicate(n) for n in panels), 'Missing selected source group: ' + group)
    gltf, binary = load_glb(WORK / 'inspection.glb')
    final = delivered_panels(gltf, binary, panels)
    require(set(final) == set(panels), 'Final panel set mismatch: ' + str(set(panels) ^ set(final)))
    bpy.ops.wm.open_mainfile(filepath=str(WORK / 'import.blend'))
    # Source BeamNG Z-up -> 180-degree assembly Z rotation -> glTF Y-up.
    source_to_runtime = Matrix((( -1, 0, 0, 0), (0, 0, 1, 0),
                                (0, 1, 0, 0), (0, 0, 0, 1)))
    trees = {}
    reports = []
    for name, record in sorted(panels.items()):
        tree = trees.setdefault(record['source'], None)
        if tree is None:
            tree = trees[record['source']] = ET.parse(record['source'])
        geometry = next(g for g in tree.findall('.//c:library_geometries/c:geometry', NS)
                        if g.get('id') == record['geometry'])
        positions, normals, sizes = _geometry_corners(geometry.find('c:mesh', NS))
        require(all(size == 3 for size in sizes), 'Source panel must be triangulated: ' + name)
        obj = bpy.data.objects[name]
        world = source_to_runtime @ obj.matrix_world
        normal_matrix = world.to_3x3().inverted().transposed()
        require(len(obj.data.loops) == len(positions), 'Source corner count changed: ' + name)
        require(all((obj.data.vertices[l.vertex_index].co - Vector(p)).length <= POSITION_TOLERANCE
                    for l, p in zip(obj.data.loops, positions)), 'Source corner order changed: ' + name)
        triangles = final[name]
        require(len(triangles) == len(sizes), 'Triangle count changed: ' + name)
        tree3d = KDTree(len(triangles))
        for i, (points, _) in enumerate(triangles):
            tree3d.insert(sum(points, Vector()) / 3, i)
        tree3d.balance()
        used = set()
        errors = []
        degenerate_corners = set(record.get('degenerateFaceCornersExcluded', []))
        skipped_zero = skipped_degenerate = 0
        max_position_error = 0
        for start in range(0, len(positions), 3):
            points = [world @ Vector(p) for p in positions[start:start + 3]]
            expected = [normal_matrix @ Vector(n) for n in normals[start:start + 3]]
            degenerate = (any(i in degenerate_corners for i in range(start, start + 3)) or
                          (points[1] - points[0]).cross(points[2] - points[0]).length_squared == 0)
            valid = [i for i, n in enumerate(expected) if not degenerate and n.length_squared >= 1e-20]
            skipped_degenerate += 3 if degenerate else 0
            skipped_zero += sum(n.length_squared < 1e-20 for n in expected) if not degenerate else 0
            matches = []
            for _, index, _ in tree3d.find_range(sum(points, Vector()) / 3, POSITION_TOLERANCE):
                if index in used:
                    continue
                actual_points, actual_normals = triangles[index]
                for permutation in PERMUTATIONS:
                    distance = max((points[i] - actual_points[permutation[i]]).length for i in range(3))
                    if distance > POSITION_TOLERANCE:
                        continue
                    angles = [math.degrees(expected[i].angle(actual_normals[permutation[i]], math.pi)) for i in valid]
                    matches.append((max(angles, default=0), distance, index, angles))
            require(matches, '%s: no positional triangle match at source corner %d' % (name, start))
            # Coincident faces may have different normals: match complete corners,
            # never accept an arbitrary nearest vertex across an authored crease.
            worst, distance, index, angles = min(matches)
            require(worst <= NORMAL_TOLERANCE_DEGREES,
                    '%s: source corner %d final normal error %.6f degrees' % (name, start, worst))
            used.add(index)
            errors.extend(angles)
            max_position_error = max(max_position_error, distance)
        require(len(used) == len(triangles) and errors, 'Incomplete/nonmeaningful coverage: ' + name)
        errors.sort()
        reports.append({'object': name, 'trianglesMatched': len(used), 'authoredCornersVerified': len(errors),
                        'zeroNormalCornersExcluded': skipped_zero, 'degenerateCornersExcluded': skipped_degenerate,
                        'normalMaxErrorDegrees': max(errors), 'normalP95ErrorDegrees': errors[int(.95 * (len(errors) - 1))],
                        'positionMaxError': max_position_error})
        print('PANEL_NORMALS', json.dumps(reports[-1]))
    result = {'passed': True, 'input': str(WORK / 'inspection.glb'),
              'delivered': str(DELIVERED), 'deliveredSha256': delivered_sha256,
              'inspectionSha256': inspection_sha256, 'byteRoundtripVerified': True,
              'reference': 'authored DAE corner normals; import.blend supplies source object transforms only',
              'positionTolerance': POSITION_TOLERANCE, 'normalToleranceDegrees': NORMAL_TOLERANCE_DEGREES,
              'panelCount': len(reports), 'authoredCornersVerified': sum(r['authoredCornersVerified'] for r in reports),
              'panels': reports}
    (WORK / 'normals-final.json').write_text(json.dumps(result, indent=2))
    print('FINAL_NORMALS_PASS', result['panelCount'], 'panels', result['authoredCornersVerified'], 'authored corners')


if __name__ == '__main__':
    main()
