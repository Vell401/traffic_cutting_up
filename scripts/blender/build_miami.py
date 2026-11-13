"""Project-authored coastal kit; Blender 4.5 LTS, no add-ons or pip packages.

Run: blender --background --factory-startup --python scripts/blender/build_miami.py -- --preview-dir <scratch>
All construction is in metres, Blender Z-up/front +Y -> glTF Y-up/front -Z.
One mesh per prototype/material, no object-per-window runtime overhead.
"""
import argparse
import bmesh
import bpy
import json
import math
import random
import sys
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / 'public/models/miami/coastal-kit.glb'
SOURCE = ROOT / 'assets/miami/coastal-kit.blend'
RNG = random.Random(13062026)
TAU = math.tau
MATS = {}
MATERIAL_SPEC = []
PROTOTYPES = {}
FEATURES = {}


def rgba(hex_color):
    # Blender and glTF factors are linear; input palette is sRGB.
    vals = [int(hex_color[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in vals) + (1,)


def material(name, color, roughness=.6, metalness=0, photo=None, normal_scale=.35, emissive=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = True
    mat.diffuse_color = rgba(color)
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = mat.diffuse_color
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metalness
    spec = dict(name=name, baseColor=list(mat.diffuse_color), roughness=roughness, metalness=metalness)
    if emissive:
        shader.inputs['Emission Color'].default_value = rgba(emissive)
        shader.inputs['Emission Strength'].default_value = 2.0
        spec['emissive'] = list(rgba(emissive)[:3])
        spec['emissiveIntensity'] = 2.0
    if photo:
        spec['maps'] = dict(map=photo + '_diffuse', normalMap=photo + '_nor_gl', roughnessMap=photo + '_rough')
        spec['uvTileMeters'] = 2
        spec['normalScale'] = [normal_scale, normal_scale]
        sources = json.loads((ROOT / 'assets/miami/sources.json').read_text())['textures']
        for channel, id_ in spec['maps'].items():
            entry = next(t for t in sources if t['id'] == id_)
            image = bpy.data.images.load(str(ROOT / ('public' + entry['path'])), check_existing=True)
            image.colorspace_settings.name = 'sRGB' if channel == 'map' else 'Non-Color'
            texture = mat.node_tree.nodes.new('ShaderNodeTexImage')
            texture.image = image
            texture.extension = 'REPEAT'
            texture.label = id_
            if channel == 'map':
                multiply = mat.node_tree.nodes.new('ShaderNodeMixRGB')
                multiply.blend_type = 'MULTIPLY'
                multiply.inputs[0].default_value = 1
                multiply.inputs[2].default_value = mat.diffuse_color
                mat.node_tree.links.new(texture.outputs['Color'], multiply.inputs[1])
                mat.node_tree.links.new(multiply.outputs[0], shader.inputs['Base Color'])
            elif channel == 'normalMap':
                normal = mat.node_tree.nodes.new('ShaderNodeNormalMap')
                normal.inputs['Strength'].default_value = normal_scale
                mat.node_tree.links.new(texture.outputs['Color'], normal.inputs['Color'])
                mat.node_tree.links.new(normal.outputs['Normal'], shader.inputs['Normal'])
            else:
                mat.node_tree.links.new(texture.outputs['Color'], shader.inputs['Roughness'])
    MATS[name] = mat
    MATERIAL_SPEC.append(spec)
    return mat


def setup_materials():
    material('plaster_ivory', 'f4e5d0', .78, photo='painted_plaster_wall', normal_scale=.22)
    material('plaster_coral', 'e0a091', .76, photo='painted_plaster_wall', normal_scale=.22)
    material('plaster_mint', 'a6c6bd', .72, photo='painted_plaster_wall', normal_scale=.22)
    material('concrete_warm', 'd1c9b8', .86, photo='concrete_wall_007', normal_scale=.48)
    material('asphalt_road', '9d9fa1', .9, photo='aerial_asphalt_01', normal_scale=.65)
    material('frame_ivory', 'e9e5dc', .38, .15)
    material('glazing_blue', '345d6c', .17, .38)
    material('metal_satin', 'a9b7b6', .29, .82)
    material('bronze_dark', '665044', .35, .7)
    material('roof_graphite', '3d4548', .87)
    material('palm_bark', '86715b', .93)
    material('palm_leaf', '527844', .72)
    material('hedge_leaf', '416948', .8)
    material('hull_pearl', 'f3f0e7', .24, .05)
    material('teak_deck', 'a88357', .66)
    material('light_warm', 'fff1ce', .3, emissive='ffd79b')


@lru_cache(maxsize=4096)
def bevel_shape(dimensions, bevel, segments):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        v.co.x *= dimensions[0]
        v.co.y *= dimensions[1]
        v.co.z *= dimensions[2]
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(bevel, min(dimensions) * .45), segments=segments, affect='EDGES')
    bm.normal_update()
    bm.verts.ensure_lookup_table()
    for i, v in enumerate(bm.verts):
        v.index = i
    verts = [tuple(v.co) for v in bm.verts]
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return verts, faces


class Builder:
    def __init__(self, name):
        self.name = name
        self.parts = defaultdict(lambda: [[], [], []])
        self.features = defaultdict(int)

    def mesh(self, mat, verts, faces, smooth=False, feature=None):
        vertices, polygons, smoothing = self.parts[mat]
        start = len(vertices)
        vertices.extend(tuple(v) for v in verts)
        polygons.extend(tuple(start + i for i in f) for f in faces)
        smoothing.extend([smooth] * len(faces))
        if feature:
            self.features[feature] += 1

    def box(self, mat, center, dims, bevel=.025, rotation=0, feature=None):
        # One actual bevel segment for sub-30cm trim; two for silhouettes/props.
        # This is fixed authored topology, not a runtime quality/LOD switch.
        v, f = bevel_shape(tuple(round(d, 5) for d in dims), round(bevel, 5), 1 if min(dims) < .3 else 2)
        c, s = math.cos(rotation), math.sin(rotation)
        self.mesh(mat, [(center[0] + x*c-y*s, center[1] + x*s+y*c, center[2] + z) for x, y, z in v], f, feature=feature)

    def tube(self, mat, points, radii, sides=10, feature=None):
        points = [Vector(p) for p in points]
        verts = []
        for i, point in enumerate(points):
            tangent = (points[min(i+1, len(points)-1)] - points[max(0, i-1)]).normalized()
            helper = Vector((0, 0, 1)) if abs(tangent.z) < .95 else Vector((0, 1, 0))
            u = tangent.cross(helper).normalized()
            v = tangent.cross(u).normalized()
            radius = radii[i] if isinstance(radii, list) else radii
            verts.extend(point + radius * (u * math.cos(a * TAU/sides) + v * math.sin(a * TAU/sides)) for a in range(sides))
        faces = []
        for i in range(len(points)-1):
            for j in range(sides):
                a, b = i*sides+j, i*sides+(j+1) % sides
                faces.append((a, b, b+sides, a+sides))
        faces += [tuple(reversed(range(sides))), tuple((len(points)-1)*sides + j for j in range(sides))]
        self.mesh(mat, verts, faces, smooth=True, feature=feature)

    def rod(self, mat, a, b, radius=.025, sides=8, feature=None):
        self.tube(mat, [a, b], radius, sides, feature)

    def ellipse(self, mat, center, radius, sides=12, rings=8, feature=None):
        # No degenerate polar quads; poles have real triangle fans.
        verts = [(center[0], center[1], center[2] + radius[2])]
        for i in range(1, rings):
            theta = math.pi*i/rings
            for j in range(sides):
                phi = TAU*j/sides
                verts.append((center[0] + radius[0]*math.sin(theta)*math.cos(phi), center[1] + radius[1]*math.sin(theta)*math.sin(phi), center[2] + radius[2]*math.cos(theta)))
        bottom = len(verts)
        verts.append((center[0], center[1], center[2]-radius[2]))
        faces = [(0, 1+j, 1+(j+1) % sides) for j in range(sides)]
        for i in range(rings-2):
            for j in range(sides):
                a = 1+i*sides+j
                b = 1+i*sides+(j+1) % sides
                faces.append((a, a+sides, b+sides, b))
        faces += [(bottom, bottom-sides+(j+1) % sides, bottom-sides+j) for j in range(sides)]
        self.mesh(mat, verts, faces, smooth=True, feature=feature)

    def slab(self, mat, width, depth, z, thickness, radius=.5, feature=None, top_cap=True):
        outline = rounded_outline(width, depth, radius)
        n = len(outline)
        verts = [(x, y, zz) for zz in [z, z+thickness] for x, y in outline]
        faces = [tuple(reversed(range(n)))]
        if top_cap:
            faces.append(tuple(range(n, n*2)))
        faces += [(i, (i+1) % n, (i+1) % n+n, i+n) for i in range(n)]
        self.mesh(mat, verts, faces, feature=feature)

    def finish(self):
        # Include rails/crowns/overhangs, not just the nominal massing, in pivot bounds.
        all_verts = [v for vertices, _, _ in self.parts.values() for v in vertices]
        low = [min(v[i] for v in all_verts) for i in range(3)]
        high = [max(v[i] for v in all_verts) for i in range(3)]
        shift = ((low[0]+high[0])/2, (low[1]+high[1])/2, low[2])
        parent = bpy.data.objects.new(self.name, None)
        bpy.context.collection.objects.link(parent)
        parent['prototype'] = self.name
        parent['units'] = 'metres'
        parent['front'] = '-Z in glTF / +Y in Blender'
        for mat, (vertices, faces, smoothing) in self.parts.items():
            vertices = [(v[0]-shift[0], v[1]-shift[1], v[2]-shift[2]) for v in vertices]
            mesh = bpy.data.meshes.new(self.name + '__' + mat)
            mesh.from_pydata(vertices, [], faces)
            mesh.materials.append(MATS[mat])
            mesh.update()
            uv = mesh.uv_layers.new(name='UVMap')
            for poly, smooth in zip(mesh.polygons, smoothing):
                poly.use_smooth = smooth
                # Triplanar *authoring* projection, baked to UV0. Physical 2m tiles.
                # No runtime shader grid or procedural window illusion.
                axis = max(range(3), key=lambda i: abs(poly.normal[i]))
                axes = [(1, 2), (0, 2), (0, 1)][axis]
                for loop in poly.loop_indices:
                    v = mesh.vertices[mesh.loops[loop].vertex_index].co
                    uv.data[loop].uv = (v[axes[0]]/2, v[axes[1]]/2)
            obj = bpy.data.objects.new(mesh.name, mesh)
            bpy.context.collection.objects.link(obj)
            obj.parent = parent
            obj['sharedMaterial'] = mat
        PROTOTYPES[self.name] = parent
        FEATURES[self.name] = dict(self.features)
        return parent


def rounded_outline(width, depth, radius, segments=6):
    points = []
    for cx, cy, start in [(width/2-radius, depth/2-radius, 0), (-width/2+radius, depth/2-radius, 90),
                           (-width/2+radius, -depth/2+radius, 180), (width/2-radius, -depth/2+radius, 270)]:
        for i in range(segments+1):
            a = math.radians(start+i*90/segments)
            points.append((cx + radius*math.cos(a), cy + radius*math.sin(a)))
    return points


def window(b, x, face_y, z, width=1.55, height=1.9, rotation=0, mullion=True, sill=True):
    # Local face +Y, window sits 16cm behind wall surface. Rails are 3D.
    c, s = math.cos(rotation), math.sin(rotation)
    def box(mat, a, y, h, dims, bevel=.015):
        b.box(mat, (x+a*c-y*s, face_y+a*s+y*c, z+h), dims, bevel, rotation, 'window_component')
    box('glazing_blue', 0, -.16, 0, (width, .065, height), 0)
    # Continuous extruded/rebated frame. This removes the hidden intersecting
    # ends of four separate bevelled bars while improving the mitred corners.
    rings = [(width/2+.09, height/2+.09, -.155), (width/2+.09, height/2+.09, .075),
             (width/2+.078, height/2+.078, .095), (width/2, height/2, .095),
             (width/2, height/2, -.155)]
    verts = []
    for w, h, y in rings:
        for a, hh in [(-w, -h), (w, -h), (w, h), (-w, h)]:
            verts.append((x+a*c-y*s, face_y+a*s+y*c, z+hh))
    faces = []
    for i in range(len(rings)):
        next_ring = (i+1) % len(rings)
        for j in range(4):
            faces.append((i*4+j, i*4+(j+1) % 4, next_ring*4+(j+1) % 4, next_ring*4+j))
    # The local perimeter is X/Z; +Y is the visible normal.
    b.mesh('frame_ivory', verts, [tuple(reversed(f)) for f in faces], feature='continuous_rebated_frame')
    if sill:
        box('concrete_warm', 0, .065, -height/2-.11, (width+.3, .42, .11))
    if mullion:
        box('frame_ivory', 0, -.075, 0, (.045, .13, height), 0)
    b.features['recessed_windows'] += 1


def wall_floor(b, width, depth, z, height=3.1, wall='plaster_ivory', bay=2.8, balconies=False, top_finish=True):
    # The full-width upper spandrel (or the setback's concrete balcony) closes
    # the core. Do not leave another coplanar core cap under that exposed finish.
    b.slab(wall, width-.65, depth-.65, z, height, .8, 'recessed_core', top_cap=False)
    b.slab('concrete_warm', width+.18, depth+.18, z, .19, .95, 'floor_slab')
    b.slab(wall, width, depth, z+.16, .38, .9)
    # A setback balcony covers this entire footprint and supplies its top cap.
    # Remove the concealed spandrel cap there, rather than offsetting materials
    # or lifting railings/floors. Non-balcony podiums keep this one finish cap.
    b.slab(wall, width, depth, z+height-.38, .38, .9, top_cap=top_finish)
    for rotation, length, face in [(0, width, depth/2), (math.pi, width, depth/2),
                                    (math.pi/2, depth, width/2), (-math.pi/2, depth, width/2)]:
        # Rotate the whole local facade, including its normal, around the building.
        count = max(2, int((length-1.8)/bay))
        spacing = (length-1.5)/count
        c, s = math.cos(rotation), math.sin(rotation)
        for i in range(count):
            x = (i-(count-1)/2)*spacing
            px, py = x*c-face*s, x*s+face*c
            window(b, px, py, z+height/2+.04, min(1.8, spacing-.5), height-1.05, rotation)
        for i in range(count+1):
            x = (i-count/2)*spacing
            b.box(wall, (x*c-face*s, x*s+face*c, z+height/2), (.4, .36, height-.3), .035, rotation, 'facade_pier')
    if balconies:
        balcony_rail(b, width+1.4, depth+1.4, z+.22)
    b.features['authored_floors'] += 1


def curtain_floor(b, width, depth, z, height=3.5):
    """Broad flush curtain panels/fins, deliberately not the hotel's apertures."""
    b.slab('roof_graphite', width-.5, depth-.5, z, height, 1.0, 'curtain_core')
    b.slab('frame_ivory', width+.08, depth+.08, z, .12, 1.2, 'curtain_floor_nosing')
    for rotation, length, face in [(0, width, depth/2), (math.pi, width, depth/2),
                                    (math.pi/2, depth, width/2), (-math.pi/2, depth, width/2)]:
        count = max(2, round((length-1.5)/3.2))
        spacing = (length-1.5)/count
        c, s = math.cos(rotation), math.sin(rotation)
        for i in range(count):
            x = (i-(count-1)/2)*spacing
            window(b, x*c-face*s, x*s+face*c, z+height/2, spacing-.13, height-.18, rotation, False, False)
        for i in range(count+1):
            x = (i-count/2)*spacing
            b.box('frame_ivory', (x*c-face*s, x*s+face*c, z+height/2), (.07, .34, height), .018, rotation, 'curtain_vertical_fin')
    b.features['curtain_floors'] += 1


def balcony_rail(b, width, depth, z, metal='frame_ivory'):
    b.slab('concrete_warm', width+.15, depth+.15, z-.16, .16, .95, 'balcony_slab')
    contour = rounded_outline(width, depth, .85, 5)
    b.tube(metal, [(x, y, z+1.05) for x, y in contour+[contour[0]]], .035, 8, 'balcony_toprail')
    b.tube(metal, [(x, y, z+.18) for x, y in contour+[contour[0]]], .022, 8)
    for a, c in zip(contour, contour[1:]+contour[:1]):
        length = math.dist(a, c)
        for j in range(max(1, int(length/.55))):
            t = j/max(1, int(length/.55))
            x, y = a[0]*(1-t)+c[0]*t, a[1]*(1-t)+c[1]*t
            b.rod(metal, (x, y, z+.14), (x, y, z+1.05), .017, 6, 'balcony_baluster')


def roof(b, width, depth, z):
    b.slab('roof_graphite', width-.3, depth-.3, z, .16, .7, 'roof_membrane')
    for x, y, dims in [(0, depth/2-.2, (width-.4, .22, .7)), (0, -depth/2+.2, (width-.4, .22, .7)),
                        (width/2-.2, 0, (.22, depth-.4, .7)), (-width/2+.2, 0, (.22, depth-.4, .7))]:
        b.box('plaster_ivory', (x, y, z+.35), dims, .04, feature='parapet')
    for x in [-width*.22, width*.22]:
        b.box('metal_satin', (x, -.8, z+.75), (2.2, 1.5, 1.2), .11, feature='hvac')
        for i in range(9):
            b.box('roof_graphite', (x-0.86+i*.215, -.8, z+1.37), (.09, 1.25, .05), .008, feature='hvac_louvre')
        b.rod('metal_satin', (x+.6, -1.5, z+.5), (x+.6, -2.5, z+.5), .17, 12)
    b.box('concrete_warm', (0, -depth*.2, z+.85), (2.8, 2.4, 1.65), .08, feature='roof_access')


def entrance(b, width, depth, z=0):
    for x in [-1.1, 1.1]:
        window(b, x, depth/2+.03, z+1.4, 1.9, 2.65, mullion=False)
        b.rod('bronze_dark', (x, depth/2+.15, z+1.0), (x, depth/2+.15, z+1.7), .022)
    b.box('bronze_dark', (0, depth/2+.8, z+2.95), (6.0, 1.9, .16), .055, feature='entrance_awning')
    b.box('light_warm', (0, depth/2+.8, z+2.85), (5.5, 1.6, .04), .015)


def hotel_deco():
    b = Builder('hotel_deco')
    for i in range(7):
        w, d = (23, 15) if i < 4 else ((19.5, 13) if i < 6 else (15.5, 10.5))
        wall_floor(b, w, d, i*3.2, 3.2, 'plaster_coral' if i < 4 else 'plaster_ivory', top_finish=i not in [3, 5])
        if i in [3, 5]:
            balcony_rail(b, w+.65, d+.65, i*3.2+3.2)
    entrance(b, 23, 15)
    # Rounded corner ribs and stepped central neon blade, not a textured rectangle.
    for side in [-1, 1]:
        for offset in [0, .28, .56]:
            b.box('frame_ivory', (side*(10.3-offset), 7.57, 6.4), (.14, .18, 11.8), .05, feature='deco_vertical_flute')
    for j, h in enumerate([24.6, 25.4, 26.2, 25.4, 24.6]):
        b.box('plaster_mint', ((j-2)*.48, 7.83, h/2), (.43, .6, h), .11, feature='stepped_sign_blade')
        b.box('light_warm', ((j-2)*.48, 8.16, h/2), (.035, .035, h-.8), .012)
    for z in [12.5, 12.78, 13.06]:
        b.slab('frame_ivory', 23.5, 15.5, z, .09, 1.25, 'deco_horizontal_ribbon')
    roof(b, 15.5, 10.5, 22.4)
    return b.finish()


def hotel_colonnade():
    b = Builder('hotel_colonnade')
    b.slab('concrete_warm', 27, 18, 0, .22, .75)
    b.box('plaster_mint', (0, -2, 1.95), (25.8, 12.5, 3.5), .12, feature='recessed_ground_lobby')
    # The forward 4m is genuinely open. No hidden mass behind the columns.
    for x in [-11.4, -8.55, -5.7, -2.85, 0, 2.85, 5.7, 8.55, 11.4]:
        b.box('concrete_warm', (x, 7.5, .4), (.83, .83, .36), .05, feature='column_plinth')
        b.box('plaster_ivory', (x, 7.5, 2.05), (.54, .54, 3.15), .085, feature='colonnade_column')
        b.box('frame_ivory', (x, 7.5, 3.65), (.85, .85, .24), .045, feature='column_capital')
        for offset in [-.14, .14]:
            b.box('frame_ivory', (x+offset, 7.79, 2.05), (.035, .055, 2.9), .01)
    b.box('plaster_ivory', (0, 7.5, 3.95), (26.3, 1.0, .4), .09, feature='colonnade_architrave')
    for i in range(5):
        wall_floor(b, 26, 17, 4.15+i*3.2, 3.2, 'plaster_mint', balconies=i in [1, 3])
    for x in [-9, -6, -3, 0, 3, 6, 9]:
        window(b, x, 4.27, 1.85, 2.3, 2.8)
    roof(b, 26, 17, 20.15)
    b.box('plaster_ivory', (0, 0, 21.2), (7.5, 6, 1.8), .5, feature='stepped_roof_pavilion')
    return b.finish()


def condo_terrace():
    b = Builder('condo_terrace')
    for i in range(8):
        w, d = 29-i*1.5, 20-i*.95
        wall_floor(b, w, d, i*3.35, 3.35, 'plaster_ivory', 3.1)
        balcony_rail(b, w+1.1, d+1.1, i*3.35+.24, 'metal_satin')
        for side in [-1, 1]:
            b.box('plaster_coral', (side*(w/2-.3), d/2+.15, i*3.35+1.4), (.5, .5, 2.7), .07, feature='terrace_pier')
    entrance(b, 29, 20)
    roof(b, 18.5, 13.35, 26.8)
    return b.finish()


def tower(name, setback=False):
    b = Builder(name)
    for i in range(3):
        wall_floor(b, 29, 25, i*3.6, 3.6, 'concrete_warm', 3.0)
    levels = 16 if setback else 21
    for i in range(levels):
        tier = i//5 if setback else 0
        w, d = (24-tier*3.0, 21-tier*2.3) if setback else (22, 19)
        z = 10.8+i*3.5
        # Curtain wall is physically segmented glazing, mullions and spandrels.
        if setback:
            wall_floor(b, w, d, z, 3.5, 'plaster_ivory', 2.8, top_finish=i not in [4, 9, 14])
        else:
            curtain_floor(b, w, d, z)
        for side in [-1, 1]:
            b.box('frame_ivory', (side*(w/2-.25), 0, z+1.75), (.18, d-1.0, .09), .025, feature='curtain_spandrel')
        if setback and i in [4, 9, 14]:
            balcony_rail(b, w+.5, d+.5, z+3.5)
    height = 10.8+levels*3.5
    roof(b, w, d, height)
    b.box('metal_satin', (0, 0, height+1.7), (w*.55, d*.5, 3.2), .45, feature='crown_service_screen')
    for i in range(12):
        b.box('roof_graphite', ((i-5.5)*w*.043, d*.255, height+1.7), (.09, .14, 2.8), .015, feature='crown_louvre')
    entrance(b, 29, 25)
    return b.finish()


def garage():
    b = Builder('garage_canopy')
    b.slab('concrete_warm', 15, 10, 0, .15, .6)
    for x in [-6, 0, 6]:
        for y in [-3.5, 3.5]:
            b.box('concrete_warm', (x, y, .25), (.8, .8, .35), .08)
            b.box('plaster_ivory', (x, y, 2.5), (.42, .42, 4.7), .08, feature='canopy_column')
    b.slab('plaster_ivory', 15.6, 10.6, 4.75, .48, 1.1, 'rounded_canopy')
    b.slab('plaster_mint', 15.9, 10.9, 5.02, .16, 1.1)
    for x in [-5.8, 0, 5.8]:
        b.box('light_warm', (x, 0, 4.7), (3.7, .18, .06), .02)
    for i in range(13):
        b.box('bronze_dark', (-6.8+i*1.13, -4.5, 3.6), (.09, .2, 2.0), .02, feature='sunshade_louvre')
    b.box('roof_graphite', (-5.7, 3.5, 1.25), (.65, .4, 1.8), .12, feature='parking_kiosk')
    b.box('glazing_blue', (-5.7, 3.72, 1.65), (.4, .035, .4), .025)
    return b.finish()


def leaf(b, mat, root, tip, width, ridge=.012, feature='individual_leaflet'):
    a, c = Vector(root), Vector(tip)
    tangent = (c-a).normalized()
    side = tangent.cross(Vector((0, 0, 1))).normalized()*width
    middle = a.lerp(c, .48) + Vector((0, 0, .09))
    # Closed ridged lancet: not a zero-thickness ribbon, 8 real triangles.
    v = [a, middle+side, c, middle-side, middle+Vector((0, 0, ridge)), middle-Vector((0, 0, ridge))]
    b.mesh(mat, v, [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4),
                    (1, 0, 5), (2, 1, 5), (3, 2, 5), (0, 3, 5)], feature=feature)


def palm(name, royal=False):
    b = Builder(name)
    height = 11.3 if royal else 8.0
    def trunk(t):
        return Vector((.3*math.sin(t*1.7) if royal else 1.15*t*t, .18*t if royal else -.45*t*t+.12*math.sin(t*3), height*t))
    points = [trunk(i/44) for i in range(45)]
    radii = [(.32+.14*math.sin(math.pi*i/44))*(1-.45*i/44) if royal else .29*(1-.58*i/44) for i in range(45)]
    b.tube('palm_bark', points, radii, 18, 'curved_trunk')
    for i in range(1, 43):
        p = trunk(i/44)
        r = radii[i]+.012
        b.tube('palm_bark', [p-Vector((0, 0, .018)), p+Vector((0, 0, .018))], [r, r-.004], 16, 'trunk_growth_ring')
    crown = points[-1]
    if royal:
        b.tube('hedge_leaf', [crown-Vector((0, 0, .8)), crown+Vector((0, 0, .65))], [.24, .15], 14, 'royal_crownshaft')
        crown += Vector((0, 0, .55))
    count = 15 if royal else 13
    for i in range(count):
        angle = i*TAU/count + RNG.uniform(-.12, .12)
        direction = Vector((math.cos(angle), math.sin(angle), 0))
        side = Vector((-math.sin(angle), math.cos(angle), 0))
        length = RNG.uniform(3.5, 4.8) if royal else RNG.uniform(4.1, 5.4)
        lift = RNG.uniform(1.1, 2.0) if i % 3 else RNG.uniform(2.2, 2.8)
        drop = RNG.uniform(1.4, 2.9)
        def path(t):
            return crown + direction*(length*t) + side*(.22*math.sin(t*math.pi)) + Vector((0, 0, lift*math.sin(t*math.pi*.85)-drop*t*t))
        rachis = [path(j/16) for j in range(17)]
        b.tube('palm_leaf', rachis, [.045*(1-j/17)+.006 for j in range(17)], 6, 'curved_frond_rachis')
        for j in range(24):
            t = .12+j*.034
            origin = path(t)
            feather_length = (.35+math.sin(t*math.pi)**.7)*(1.15 if royal else 1.35)*RNG.uniform(.86, 1.1)
            for sign in [-1, 1]:
                tip = origin + side*(feather_length*sign) + direction*(feather_length*.38) + Vector((0, 0, -.22-feather_length*.36))
                leaf(b, 'palm_leaf', origin, tip, (.06 if royal else .075)*(1-.35*t), .009)
    # A few upward feathered spears fill the crown silhouette, not eight flat blades.
    for i in range(3):
        a = i*TAU/3+.7
        tip = crown+Vector((math.cos(a)*1.1, math.sin(a)*1.1, 2.4))
        b.rod('palm_leaf', crown, tip, .035, 6)
        side = Vector((-math.sin(a), math.cos(a), 0))
        for j in range(12):
            t = .15+j*.065
            p = crown.lerp(tip, t)
            for sign in [-1, 1]:
                leaf(b, 'palm_leaf', p, p+side*(sign*.6*(1-t))+Vector((0, 0, .12)), .045)
    if not royal:
        for i in range(6):
            a = i*TAU/6
            b.ellipse('palm_bark', crown+Vector((math.cos(a)*.23, math.sin(a)*.23, -.18)), (.13, .13, .17), 10, 6, 'coconut')
    return b.finish()


def yacht():
    b = Builder('yacht')
    length = 17.2
    def section(t):
        # Broad transom, a swelling midship and a genuinely pointed rising bow.
        beam = 2.35*(.8+.2*math.sin(math.pi*t))*(1-.985*t**5)
        sheer = .18*t+.45*t**4
        return beam, sheer
    verts = []
    slices = 28
    for i in range(slices+1):
        t = i/slices
        beam, sheer = section(t)
        for x, z in [(-1, 2.25), (-.97, 1.3), (-.61, .38), (0, .0), (.61, .38), (.97, 1.3), (1, 2.25)]:
            verts.append((beam*x, (t-.5)*length, z+sheer))
    faces = []
    for i in range(slices):
        for j in range(6):
            a = i*7+j
            faces.append((a, a+7, a+8, a+1))
    faces += [tuple(reversed(range(7))), tuple(slices*7+j for j in range(7))]
    b.mesh('hull_pearl', verts, faces, smooth=True, feature='lofted_v_chine_hull')
    outline = [(-section(i/slices)[0], (i/slices-.5)*length, 2.25+section(i/slices)[1]) for i in range(slices+1)]
    outline += [(section(i/slices)[0], (i/slices-.5)*length, 2.25+section(i/slices)[1]) for i in reversed(range(slices+1))]
    b.mesh('hull_pearl', outline, [tuple(reversed(range(len(outline))))], feature='shaped_deck')
    # Teak strips follow the narrowing bow; spaced, shallow, physically modelled.
    for i in range(48):
        t = .02+i*.0197
        width, sheer = section(t)
        if width > .15:
            b.box('teak_deck', (0, (t-.5)*length, 2.28+sheer), (width*1.88, .305, .045), .012, feature='deck_plank')
    rail = [(x*.98, y, z+.86) for x, y, z in outline]
    b.tube('metal_satin', rail+[rail[0]], .028, 8, 'perimeter_safety_rail')
    for i in range(0, len(outline), 3):
        x, y, z = outline[i]
        b.rod('metal_satin', (x*.98, y, z+.04), (x*.98, y, z+.86), .024, 8, 'rail_stanchion')
    # Raked cabin: trapezoid walls and dark inset glazing, not a stack of cuboids.
    cabin = [(-1.7, -5, 2.5), (1.7, -5, 2.5), (1.7, 2.5, 2.5), (-1.7, 2.5, 2.5),
             (-1.35, -4.65, 4.25), (1.35, -4.65, 4.25), (1.35, 1.1, 4.25), (-1.35, 1.1, 4.25)]
    b.mesh('hull_pearl', cabin, [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)], feature='raked_cabin')
    for side in [-1, 1]:
        for j in range(5):
            y = -4.35+j*1.17
            b.mesh('glazing_blue', [(side*1.61, y, 3.03), (side*1.61, y+.92, 3.03),
                                    (side*1.397, y+.69, 4.06), (side*1.397, y-.12, 4.06)],
                   [(0, 1, 2, 3) if side > 0 else (3, 2, 1, 0)], feature='cabin_side_glazing')
        for j in range(5):
            # Actual porthole recess backing and metal perimeter.
            y = -5.9+j*2.25
            beam, sheer = section(y/length+.5)
            x = side*(beam*.984+.015)
            b.box('glazing_blue', (x, y, 1.65+sheer), (.055, .72, .28), .12, feature='hull_porthole')
            b.box('metal_satin', (x, y, 1.48+sheer), (.07, .8, .045), .02)
    b.mesh('glazing_blue', [(-1.5, 2.34, 2.86), (1.5, 2.34, 2.86), (1.24, 1.21, 4.11), (-1.24, 1.21, 4.11)], [(3, 2, 1, 0)], feature='raked_windscreen')
    b.box('hull_pearl', (0, -1.7, 4.3), (3.25, 6.3, .22), .24, feature='cabin_roof')
    b.box('hull_pearl', (0, -2.7, 4.62), (2.6, 2.9, .45), .18, feature='flybridge')
    for x in [-.8, .8]:
        b.box('hull_pearl', (x, -3.1, 5.02), (.68, .8, .36), .14, feature='flybridge_seat')
        b.rod('metal_satin', (x*1.6, -3.9, 4.4), (x*1.6, -3.6, 6.0), .075, 10, 'radar_arch')
    b.rod('metal_satin', (-1.28, -3.6, 6), (1.28, -3.6, 6), .075, 10)
    b.box('hull_pearl', (0, -3.6, 6.13), (1.25, .4, .18), .09, feature='radar')
    b.rod('metal_satin', (.7, -3.6, 6.1), (.7, -3.6, 7.0), .017)
    b.box('hull_pearl', (0, -7.5, 2.62), (3.2, 1.1, .5), .17, feature='aft_bench')
    b.box('teak_deck', (0, -8.8, 1.75), (3.4, .7, .12), .14, feature='swim_platform')
    return b.finish()


def streetlight():
    b = Builder('streetlight')
    b.box('bronze_dark', (0, 0, .12), (.45, .45, .24), .055, feature='bevelled_base')
    b.tube('bronze_dark', [(0, 0, .2), (0, 0, 1), (0, 0, 6.9), (0, .15, 7.3), (0, .55, 7.55), (0, 1.15, 7.58), (0, 1.6, 7.5)], [.14, .1, .07, .065, .06, .055, .045], 14, 'curved_lamp_arm')
    b.box('bronze_dark', (0, 1.6, 7.45), (.56, .95, .18), .12, feature='luminaire')
    b.box('light_warm', (0, 1.6, 7.335), (.43, .73, .055), .075, feature='emissive_diffuser')
    return b.finish()


def bench():
    b = Builder('bench')
    for x in [-.66, .66]:
        b.tube('bronze_dark', [(x, .3, .04), (x, .18, .4), (x, -.22, .4), (x, -.32, .06)], .042, 10, 'curved_bench_leg')
        b.rod('bronze_dark', (x, -.24, .35), (x, -.37, .93), .033, 10)
        b.tube('bronze_dark', [(x, .25, .48), (x, .22, .68), (x, -.2, .68), (x, -.27, .53)], .028, 8, 'bench_armrest')
    for i in range(5):
        b.box('teak_deck', (0, -.22+i*.105, .46), (1.86, .085, .065), .018, feature='seat_slat')
    for i in range(4):
        b.box('teak_deck', (0, -.30-i*.024, .61+i*.093), (1.86, .065, .075), .018, feature='back_slat')
    b.rod('bronze_dark', (-.67, -.04, .26), (.67, -.04, .26), .025)
    return b.finish()


def bollard():
    b = Builder('bollard')
    b.tube('metal_satin', [(0, 0, 0), (0, 0, .08), (0, 0, .84), (0, 0, .94)], [.14, .11, .11, .08], 20, 'bevelled_bollard')
    b.tube('light_warm', [(0, 0, .76), (0, 0, .80)], .114, 20, 'reflective_band')
    b.tube('bronze_dark', [(0, 0, 0), (0, 0, .045)], .18, 20)
    return b.finish()


def planter():
    b = Builder('planter')
    # Hollow tapered rim; dark soil below the top, no solid box plant.
    outer = [(-.42, -.42, 0), (.42, -.42, 0), (.42, .42, 0), (-.42, .42, 0),
             (-.55, -.55, .72), (.55, -.55, .72), (.55, .55, .72), (-.55, .55, .72)]
    inner = [(-.46, -.46, .72), (.46, -.46, .72), (.46, .46, .72), (-.46, .46, .72)]
    b.mesh('concrete_warm', outer+inner, [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
                                          (4, 5, 9, 8), (5, 6, 10, 9), (6, 7, 11, 10), (7, 4, 8, 11)], feature='hollow_planter')
    for x, y, dims in [(0, -.51, (1.1, .12, .1)), (0, .51, (1.1, .12, .1)), (-.51, 0, (.12, 1.1, .1)), (.51, 0, (.12, 1.1, .1))]:
        b.box('concrete_warm', (x, y, .72), dims, .035, feature='bevelled_planter_rim')
    b.box('roof_graphite', (0, 0, .62), (.92, .92, .06), .015, feature='soil')
    for i in range(24):
        a = i*2.39996
        r = .17*math.sqrt(i/24)
        root = (math.cos(a)*r, math.sin(a)*r, .66)
        tip = (math.cos(a)*RNG.uniform(.35, .65), math.sin(a)*RNG.uniform(.35, .65), RNG.uniform(1, 1.5))
        leaf(b, 'hedge_leaf', root, tip, .08, .02, 'planter_leaf')
    return b.finish()


def hedge():
    b = Builder('hedge')
    b.box('concrete_warm', (0, 0, .1), (2.7, .85, .2), .1, feature='hedge_border')
    for i in range(7):
        x = -1.05+i*.35
        b.rod('palm_bark', (x, 0, .15), (x, 0, .7), .03, 6)
        b.ellipse('hedge_leaf', (x, RNG.uniform(-.05, .05), .75+RNG.uniform(-.08, .08)),
                  (RNG.uniform(.38, .49), RNG.uniform(.34, .43), RNG.uniform(.41, .5)), 10, 7, 'rounded_foliage_cluster')
    for i in range(500):
        x, a = RNG.uniform(-1.25, 1.25), RNG.uniform(0, TAU)
        root = (x, math.cos(a)*.33, .75+math.sin(a)*.39)
        leaf(b, 'hedge_leaf', root, (x+RNG.uniform(-.15, .15), root[1]*1.32, root[2]+RNG.uniform(.09, .2)), .075, .008, 'hedge_leaflet')
    return b.finish()


def pontoon():
    b = Builder('marina_pontoon')
    b.box('roof_graphite', (0, 0, .23), (2.85, 11.9, .46), .18, feature='pontoon_float')
    for x in [-1.45, 1.45]:
        b.box('metal_satin', (x, 0, .53), (.12, 12.0, .24), .035, feature='dock_edge')
        for y in [-4.8, -.8, 3.2]:
            b.box('roof_graphite', (x*1.055, y, .47), (.18, 1.1, .3), .09, feature='dock_fender')
    for i in range(60):
        b.box('teak_deck', (0, -5.87+i*.198, .68), (2.86, .183, .08), .014, feature='pontoon_plank')
    for y in [-5.1, -1.5, 2.1, 5.1]:
        for x in [-1.22, 1.22]:
            b.box('metal_satin', (x, y, .79), (.16, .35, .15), .035)
            b.rod('metal_satin', (x, y-.25, .88), (x, y+.25, .88), .035, 8, 'mooring_cleat')
    # A safe rail at the landward end; long sides stay open for boarding.
    for x in [-1.3, 0, 1.3]:
        b.rod('metal_satin', (x, -5.8, .72), (x, -5.8, 1.75), .028, 8, 'dock_guardrail')
    for z in [1.17, 1.75]:
        b.rod('metal_satin', (-1.3, -5.8, z), (1.3, -5.8, z), .025)
    return b.finish()


def export_kit():
    # Keep fully photographic PBR in the .blend, but ship *one* shared map set.
    # Task2 applies the explicit manifest map/channel/colorspace contract.
    export_mats = {}
    for spec in MATERIAL_SPEC:
        original = MATS[spec['name']]
        original.name = spec['name'] + '__authoring'
        mat = bpy.data.materials.new(spec['name'])
        mat.use_nodes = True
        mat.use_backface_culling = True
        p = mat.node_tree.nodes.get('Principled BSDF')
        p.inputs['Base Color'].default_value = spec['baseColor']
        p.inputs['Roughness'].default_value = spec['roughness']
        p.inputs['Metallic'].default_value = spec['metalness']
        if 'emissive' in spec:
            p.inputs['Emission Color'].default_value = (*spec['emissive'], 1)
            p.inputs['Emission Strength'].default_value = spec['emissiveIntensity']
        export_mats[spec['name']] = mat
    bpy.ops.object.select_all(action='DESELECT')
    for root in PROTOTYPES.values():
        root.select_set(True)
        for obj in root.children:
            obj.select_set(True)
            obj.data.materials[0] = export_mats[obj['sharedMaterial']]
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(MODEL), export_format='GLB', use_selection=True,
                              export_yup=True, export_normals=True, export_texcoords=True,
                              export_materials='EXPORT', export_cameras=False, export_lights=False,
                              export_extras=True, export_animations=False, export_apply=True)
    for root in PROTOTYPES.values():
        for obj in root.children:
            obj.data.materials[0] = MATS[obj['sharedMaterial']]
    for name, mat in export_mats.items():
        bpy.data.materials.remove(mat)
        MATS[name].name = name
    bpy.ops.object.select_all(action='DESELECT')
    # Stage the source for useful inspection without baking transforms into GLB.
    for i, (name, root) in enumerate(PROTOTYPES.items()):
        root.location = ((i % 5)*45, (i//5)*45, 0)
    for image in bpy.data.images:
        if image.source == 'FILE':
            image.pack()
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene['asset_contract'] = 'Re-export through build_miami.py. Source inspection staging is not exported. glTF roots identity, bottom centred, Y-up, front -Z.'
    bpy.context.preferences.filepaths.save_version = 0  # Do not leave .blend1 archives in source ownership.
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE), compress=False)
    for root in PROTOTYPES.values():
        root.location = (0, 0, 0)
    stats = dict(generator=dict(name='scripts/blender/build_miami.py', version='1.0.1',
                               blender=bpy.app.version_string, seed=13062026),
                 materials=MATERIAL_SPEC, prototypes=FEATURES)
    (SOURCE.parent / 'authoring.json').write_text(json.dumps(stats, indent=2) + '\n')
    total_tris = 0
    total_parts = 0
    for name, root in PROTOTYPES.items():
        tris = 0
        for child in root.children:
            child.data.calc_loop_triangles()
            tris += len(child.data.loop_triangles)
        print(f'KIT {name}: {len(root.children)} material parts, {tris} triangles, features={FEATURES[name]}')
        total_tris += tris
        total_parts += len(root.children)
    print(f'KIT TOTAL: {len(PROTOTYPES)} prototypes, {total_parts} parts, {total_tris} triangles, GLB {MODEL.stat().st_size} bytes')


def previews(directory):
    directory.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'AgX'
    scene.world.use_nodes = True
    nodes = scene.world.node_tree.nodes
    sky_source = json.loads((ROOT / 'assets/miami/sources.json').read_text())['textures'][-1]
    sky = nodes.new('ShaderNodeTexEnvironment')
    sky.image = bpy.data.images.load(str(ROOT / ('public' + sky_source['path'])), check_existing=True)
    scene.world.node_tree.links.new(sky.outputs['Color'], nodes.get('Background').inputs['Color'])
    nodes.get('Background').inputs['Strength'].default_value = .6
    # Broad neutral key allows inspection of recesses independent of sunset drama.
    lamp_data = bpy.data.lights.new('preview_key', 'AREA')
    lamp_data.energy = 2300
    lamp_data.shape = 'DISK'
    lamp_data.size = 18
    lamp = bpy.data.objects.new('preview_key', lamp_data)
    bpy.context.collection.objects.link(lamp)
    lamp.location = (-10, 20, 30)
    lamp.rotation_euler = (Vector((0, 0, 5))-lamp.location).to_track_quat('-Z', 'Y').to_euler()
    ground_mat = bpy.data.materials.new('preview_ground')
    ground_mat.diffuse_color = (.115, .125, .135, 1)
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, -.025))
    ground = bpy.context.object
    ground.data.materials.append(ground_mat)
    camera_data = bpy.data.cameras.new('preview_camera')
    camera = bpy.data.objects.new('preview_camera', camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = 'ORTHO'
    # True geometry, no preview-only detail. Only arrangement/ortho scale changes.
    shots = [
        ('01-deco-frontage', [('hotel_deco', (-14, 0, 0), 1), ('hotel_colonnade', (15, -1, 0), 1),
                               ('palm_coconut', (-27, 12, 0), 1), ('palm_royal', (3, 12, 0), 1),
                               ('streetlight', (-4, 13, 0), 1), ('bench', (-2, 14, 0), 1)], (48, 70, 40), (0, 0, 11), 65),
        ('02-skyline-terraces', [('condo_terrace', (-29, 5, 0), 1), ('tower_glass', (3, -3, 0), 1),
                                  ('tower_setback', (36, -1, 0), 1)], (95, 145, 90), (2, 0, 40), 145),
        ('03-feathered-palms', [('palm_coconut', (-6, 0, 0), 1), ('palm_royal', (5, 0, 0), 1),
                                 ('planter', (1, 3, 0), 1), ('hedge', (-1.5, 3, 0), 1)], (20, 35, 20), (0, 0, 6.7), 23),
        ('04-yacht-marina', [('yacht', (-2.5, 0, 0), 1), ('marina_pontoon', (3.2, -1, .6), 1)], (23, 28, 20), (0, 0, 3), 25),
        ('05-human-scale-props', [('bench', (-2.4, 0, 0), 1), ('bollard', (-.8, 0, 0), 1),
                                  ('planter', (.6, 0, 0), 1), ('hedge', (3.2, 0, 0), 1),
                                  ('garage_canopy', (0, -9, 0), 1)], (18, 26, 16), (0, -3, 2.2), 23),
        ('06-window-rail-detail', [('condo_terrace', (0, 0, 0), 1)], (17, 31, 12), (6, 9, 7), 14),
    ]
    for filename, visible, position, target, scale in shots:
        for root in PROTOTYPES.values():
            for child in root.children:
                child.hide_render = True
        for name, location, factor in visible:
            root = PROTOTYPES[name]
            root.location = location
            root.scale = (factor,)*3
            for child in root.children:
                child.hide_render = False
        camera.location = position
        camera.rotation_euler = (Vector(target)-camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera_data.ortho_scale = scale
        scene.render.filepath = str(directory / (filename+'.png'))
        bpy.ops.render.render(write_still=True)
        print('PREVIEW ' + scene.render.filepath)
    # Preview scene is intentionally not re-saved over reproducible source.


def main():
    args = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('--preview-dir', type=Path)
    parser.add_argument('--inspect-glb', action='store_true', help='Render the actual reimported delivery binary, without reauthoring or overwriting it')
    options = parser.parse_args(args)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for data in list(bpy.data.materials):
        bpy.data.materials.remove(data)
    if options.inspect_glb:
        if not options.preview_dir:
            parser.error('--inspect-glb requires --preview-dir')
        bpy.ops.import_scene.gltf(filepath=str(MODEL))
        imported = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
        assignments = {obj.name: obj.data.materials[0].name for obj in imported}
        for data in list(bpy.data.materials):
            bpy.data.materials.remove(data)
        setup_materials()
        for obj in imported:
            obj.data.materials.clear()
            obj.data.materials.append(MATS[assignments[obj.name]])
        PROTOTYPES.update((obj.name, obj) for obj in bpy.context.scene.objects if obj.type == 'EMPTY' and obj.parent is None)
        assert len(PROTOTYPES) == 15, 'GLB must reimport all semantic roots'
        previews(options.preview_dir)
        return
    setup_materials()
    hotel_deco()
    hotel_colonnade()
    condo_terrace()
    tower('tower_glass')
    tower('tower_setback', True)
    garage()
    palm('palm_coconut')
    palm('palm_royal', True)
    yacht()
    streetlight()
    bench()
    bollard()
    planter()
    hedge()
    pontoon()
    export_kit()
    if options.preview_dir:
        previews(options.preview_dir)


if __name__ == '__main__':
    main()
