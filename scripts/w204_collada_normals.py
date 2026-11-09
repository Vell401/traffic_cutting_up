"""Restore COLLADA corner normals discarded by Blender 3.0's importer.

Run inside Blender. Geometry, UVs and object transforms are never changed.
"""
import array
import hashlib
import math
import xml.etree.ElementTree as ET

from mathutils import Vector

NS = {'c': 'http://www.collada.org/2005/11/COLLADASchema'}
POSITION_TOLERANCE = 5e-5
# Blender 3 stores custom normals in a quantized local normal space.
NORMAL_TOLERANCE_DEGREES = 1.0


def _sources(mesh):
    result = {}
    for source in mesh.findall('c:source', NS):
        accessor = source.find('c:technique_common/c:accessor', NS)
        if accessor is None:
            continue
        values = source.find("c:float_array[@id='%s']" % accessor.get('source')[1:], NS)
        if values is None:
            continue
        data = array.array('f', map(float, values.text.split()))
        stride = int(accessor.get('stride', '1'))
        offset = int(accessor.get('offset', '0'))
        count = int(accessor.get('count'))
        assert offset + count * stride <= len(data), source.get('id')
        result[source.get('id')] = (data, stride, offset, count)
    return result


def _vector(source, index):
    data, stride, offset, count = source
    assert stride >= 3, 'Position/normal source needs three components'
    assert 0 <= index < count, ('COLLADA source index', index, count)
    start = offset + index * stride
    return tuple(data[start:start + 3])


def _geometry_corners(mesh):
    sources = _sources(mesh)
    vertices = {v.get('id'): {i.get('semantic'): i.get('source')[1:]
                            for i in v.findall('c:input', NS)}
                for v in mesh.findall('c:vertices', NS)}
    positions, normals, face_sizes = [], [], []
    for part in mesh:
        kind = part.tag.rsplit('}', 1)[-1]
        if kind in ('source', 'vertices', 'extra', 'lines', 'linestrips'):
            continue
        assert kind in ('triangles', 'polylist', 'polygons'), ('Unsupported primitive', kind)
        inputs = {i.get('semantic'): (int(i.get('offset', '0')), i.get('source')[1:])
                  for i in part.findall('c:input', NS)}
        stride = max(offset for offset, _ in inputs.values()) + 1
        vo, vertex_source = inputs['VERTEX']
        no, normal_source = inputs['NORMAL']
        position_source = sources[vertices[vertex_source]['POSITION']]
        normal_source = sources[normal_source]
        assert not part.findall('c:ph', NS), 'Polygons with holes require explicit mapping'
        for p in part.findall('c:p', NS):
            indices = list(map(int, p.text.split()))
            assert len(indices) % stride == 0
            count = len(indices) // stride
            if kind == 'triangles':
                assert count % 3 == 0
                face_sizes.extend([3] * (count // 3))
            elif kind == 'polylist':
                sizes = list(map(int, part.find('c:vcount', NS).text.split()))
                assert sum(sizes) == count
                face_sizes.extend(sizes)
            else:
                face_sizes.append(count)
            for start in range(0, len(indices), stride):
                positions.append(_vector(position_source, indices[start + vo]))
                normals.append(_vector(normal_source, indices[start + no]))
    return positions, normals, face_sizes


def _geometry_digest(mesh):
    """Exclude normal/smoothing state; prove all other mesh data stays identical."""
    digest = hashlib.sha256()
    for collection, prop, width, typecode in [
        (mesh.vertices, 'co', 3, 'f'), (mesh.edges, 'vertices', 2, 'i'),
        (mesh.loops, 'vertex_index', 1, 'i'), (mesh.polygons, 'loop_start', 1, 'i'),
        (mesh.polygons, 'loop_total', 1, 'i'), (mesh.polygons, 'material_index', 1, 'i'),
    ] + [(layer.data, 'uv', 2, 'f') for layer in mesh.uv_layers]:
        values = array.array(typecode, [0]) * (len(collection) * width)
        collection.foreach_get(prop, values)
        digest.update(values.tobytes())
    digest.update(repr([(u.name, u.active_render) for u in mesh.uv_layers]).encode())
    return digest.hexdigest()


def restore_file(path, objects):
    tree = ET.parse(path)
    aliases = {}
    for node in tree.findall('.//c:node', NS):
        instance = node.find('c:instance_geometry', NS)
        if instance is not None:
            aliases.setdefault(instance.get('url')[1:], set()).update(
                value for value in (node.get('name'), node.get('id')) if value)
    remaining = {o for o in objects if o.type == 'MESH'}
    report = []
    for geometry in tree.findall('.//c:library_geometries/c:geometry', NS):
        mesh_xml = geometry.find('c:mesh', NS)
        if mesh_xml is None:
            continue
        names = aliases.get(geometry.get('id'), set())
        if not names:
            continue  # Uninstantiated library geometry is not imported.
        positions, authored, face_sizes = _geometry_corners(mesh_xml)
        candidates = [o for o in remaining if o.name in names]
        # Blender may suffix an object name already used by another DAE/node.
        if not candidates:
            candidates = [o for o in remaining if o.name.rsplit('.', 1)[0] in names]
        assert candidates, ('No imported object for COLLADA geometry', path, geometry.get('id'), names)
        for obj in candidates:
            mesh = obj.data
            assert len(mesh.loops) == len(positions), (obj.name, 'corner count')
            assert [p.loop_total for p in mesh.polygons] == face_sizes, (obj.name, 'face order')
            position_error = max((mesh.vertices[l.vertex_index].co - Vector(p)).length
                                 for l, p in zip(mesh.loops, positions))
            assert position_error <= POSITION_TOLERANCE, (obj.name, 'position/order mismatch', position_error)
            before = _geometry_digest(mesh)
            transform = tuple(tuple(row) for row in obj.matrix_world)
            mesh.calc_normals_split()
            restored, zero_indices = [], []
            for index, (loop, values) in enumerate(zip(mesh.loops, authored)):
                normal = Vector(values)
                assert all(math.isfinite(v) for v in normal), (obj.name, 'nonfinite normal', index)
                if normal.length_squared < 1e-20:
                    zero_indices.append(index)
                    normal = loop.normal.copy()
                    if normal.length_squared < 1e-20:
                        normal = Vector((0, 0, 1))  # Degenerate face and missing source normal.
                restored.append(tuple(normal.normalized()))
            for polygon in mesh.polygons:
                polygon.use_smooth = True
            mesh.use_auto_smooth = True
            mesh.normals_split_custom_set(restored)
            mesh.calc_normals_split()
            # Blender cannot represent split normals on zero-area faces. Preserve
            # those faces verbatim, but report them rather than claim verification.
            degenerate = {i for p in mesh.polygons if p.area == 0
                          for i in range(p.loop_start, p.loop_start + p.loop_total)}
            errors = [math.degrees(Vector(expected).angle(loop.normal, math.pi))
                      for i, (expected, loop) in enumerate(zip(restored, mesh.loops))
                      if i not in degenerate]
            errors.sort()
            assert max(errors) <= NORMAL_TOLERANCE_DEGREES, (obj.name, 'normal verification', max(errors))
            assert before == _geometry_digest(mesh), (obj.name, 'geometry/UV changed')
            assert transform == tuple(tuple(row) for row in obj.matrix_world), (obj.name, 'transform changed')
            report.append({'object': obj.name, 'source': str(path), 'geometry': geometry.get('id'),
                           'corners': len(restored), 'positionMaxError': position_error,
                           'normalMaxErrorDegrees': max(errors),
                           'normalP95ErrorDegrees': errors[int((len(errors) - 1) * .95)],
                           'zeroNormalFallbackCorners': zero_indices,
                           'degenerateFaceCornersExcluded': sorted(degenerate),
                           'geometryUvSha256': before, 'geometryUvTransformsPreserved': True})
            remaining.remove(obj)
    assert not remaining, ('Imported meshes without verified normals', path, sorted(o.name for o in remaining))
    return report
