"""Blender 4.5: build only the selected Porsche body/cockpit, preserving source polygons."""
import bpy,json,pathlib,zipfile,re,math,hashlib
from mathutils import Vector,Matrix
work=pathlib.Path('C:/web/traffic_cutting_up/data/porsche');m=json.loads((work/'manifest.json').read_text(encoding='utf8'))
bpy.ops.wm.open_mainfile(filepath=str(work/'selected.blend'))
z=zipfile.ZipFile(r'C:\web\Porsche 911.zip');archive={n.lower():n for n in z.namelist()};texdir=work/'textures';texdir.mkdir(exist_ok=True)
missing=[];used={};cache={}
def texture(path,linear=False):
 if not path:return None
 key=path.lstrip('/').lower();key=archive.get(key)
 if not key:
  # Some mod references omit their extension.
  key=next((n for n in z.namelist() if n.lower().rsplit('.',1)[0]==path.lstrip('/').lower()),None)
 if not key:missing.append(path);return None
 token=hashlib.sha1(key.encode()).hexdigest()[:12]+pathlib.Path(key).suffix
 dest=texdir/token
 if not dest.exists():dest.write_bytes(z.read(key))
 if (key,linear) in cache:return cache[key,linear]
 try:
  im=bpy.data.images.load(str(dest),check_existing=False)
  _ = im.pixels[0]
  if im.size[0]<2:raise RuntimeError('Image has no data')
  if linear:im.colorspace_settings.name='Non-Color'
  used[key]={'width':im.size[0],'height':im.size[1],'bytes':len(z.read(key))}
  cache[key,linear]=im;return im
 except Exception as e:missing.append(path+': '+str(e));return None

def base_name(s):return re.sub(r'\.\d{3}$','',s)
matcache={}
def material(old):
 name=old.name if old.name in m['materials'] else base_name(old.name)
 if name in matcache:return matcache[name]
 definition=m['materials'].get(name+'.skin_interior.black',m['materials'].get(name+'.skin_carbonnn.Trim_Plastic',m['materials'].get(name,{})));st=definition.get('Stages',[{}])[0]
 result=bpy.data.materials.new(name+'_web');result.use_nodes=True;nodes=result.node_tree.nodes;nodes.clear();links=result.node_tree.links
 out=nodes.new('ShaderNodeOutputMaterial');p=nodes.new('ShaderNodeBsdfPrincipled');links.new(p.outputs['BSDF'],out.inputs['Surface'])
 color=st.get('baseColorFactor') or list(old.diffuse_color);color=(color+[1])[:4];p.inputs['Base Color'].default_value=color
 p.inputs['Metallic'].default_value=st.get('metallicFactor') if st.get('metallicFactor') is not None else .05
 p.inputs['Roughness'].default_value=st.get('roughnessFactor') if st.get('roughnessFactor') is not None else .55
 # Restore the preset's dial atlas; these material slots are empty in the mod JSON.
 if name in ['TwiXeR_992_gauges_9000','TwiXeR_992_gauges_900011']:
  st=dict(st,baseColorMap='/vehicles/Porsche 911 992 TwiXeR/TXT/por_911gt3rs_23_gauges_diff_7996d421-b5d8-4fb0-bd2d-d59a9962a449.png');color=[1,1,1,1];p.inputs['Base Color'].default_value=color;p.inputs['Metallic'].default_value=0;p.inputs['Roughness'].default_value=.6
 if name in ['TwiXeR_992_gps_screen','TwiXeR_992_dash_clock_1']:p.inputs['Base Color'].default_value=[.008,.01,.014,1]
 # Engine-specific multilayer paints become an editable PBR clearcoat with the exact preset tint.
 painted=name.startswith('new_body_paint')
 if painted:
  result.name='Porsche_BodyPaint';p.inputs['Base Color'].default_value=[.99,.75,.95,1];p.inputs['Metallic'].default_value=.5;p.inputs['Roughness'].default_value=.22;p.inputs['Coat Weight'].default_value=1;p.inputs['Coat Roughness'].default_value=.03
  result['bodyPaint']=True
 def image_node(path,socket,linear=False):
  image=texture(path,linear)
  if image:
   node=nodes.new('ShaderNodeTexImage');node.image=image
   links.new(node.outputs['Color'],p.inputs[socket]);return node
 if not painted:
  node=image_node(st.get('baseColorMap') or st.get('detailMap'),'Base Color')
  if node:
   # A multiply keeps the material factor without changing the original texture resolution.
   mix=nodes.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=1;mix.inputs[2].default_value=color
   links.new(node.outputs['Color'],mix.inputs[1]);links.new(mix.outputs[0],p.inputs['Base Color'])
   # glTF exporter supports a factor directly, rather than baking a new image.
   # Keep the multiply node: the glTF exporter extracts its constant colour factor.
  norm=texture(st.get('normalMap'),True)
  if norm:
   t=nodes.new('ShaderNodeTexImage');t.image=norm;n=nodes.new('ShaderNodeNormalMap');n.inputs['Strength'].default_value=st.get('normalMapStrength',1) or 1;links.new(t.outputs['Color'],n.inputs['Color']);links.new(n.outputs['Normal'],p.inputs['Normal'])
 if 'carbon' in name:p.inputs['Coat Weight'].default_value=.7
 if name=='TwiXeR_992_body_CSR2_GT3RS':
  for l in list(links):
   if l.to_socket==p.inputs['Base Color']:links.remove(l)
  p.inputs['Base Color'].default_value=[.004,.004,.004,1];p.inputs['Roughness'].default_value=.5
 if 'wheels_black_gloss' in name:p.inputs['Base Color'].default_value=[.012,.012,.012,1]
 if 'glass' in name.lower() and 'blackglass' not in name.lower() and 'gauges' not in name.lower():
  p.inputs['Base Color'].default_value=[.045,.055,.065,.28 if 'tint' in name else .16];p.inputs['Alpha'].default_value=.28 if 'tint' in name else .16;p.inputs['Roughness'].default_value=.08;p.inputs['Metallic'].default_value=.05
  # No opaque glass texture: retain clear sight into/out of the cockpit.
  for l in list(links):
   if l.to_socket==p.inputs['Base Color']:links.remove(l)
  result.surface_render_method='DITHERED';result.use_transparent_shadow=False
 if 'mirror' in name:p.inputs['Metallic'].default_value=1;p.inputs['Roughness'].default_value=.05
 if any(w in name for w in ['leather','plastic','carpet','rubber','seatbelt','roof_alc']):p.inputs['Metallic'].default_value=0
 if name in ['SV_SKIN1']:p.inputs['Base Color'].default_value=old.diffuse_color[:];p.inputs['Metallic'].default_value=.1
 # Light materials retain semantic names for runtime brake/indicator control.
 if any(w in name.lower() for w in ['headlight_high','headlight_1','brakelight','taillight_running','signal_l','signal_r']):
  col=[1,.035,.015,1] if 'brakelight' in name or 'taillight' in name else [1,.5,.02,1] if 'signal' in name.lower() else [1,.95,.85,1]
  p.inputs['Emission Color'].default_value=col;p.inputs['Emission Strength'].default_value=1
 result.use_backface_culling=not definition.get('doubleSided',False)
 matcache[name]=result;return result

original=list(bpy.context.scene.objects);removed=[]
remove=re.compile(r'engbaycrap|frunk$|brakelines|subframe|steeringbox|tierod|radiators_small|muffler$|windshield_dmg|display[1-7DRNP]$')
for o in original:
 if o.type!='MESH' or remove.search(o.name):removed.append(o.name);bpy.data.objects.remove(o,do_unlink=True);continue
 for slot in o.material_slots:
  if slot.material:slot.material=material(slot.material)
for o in bpy.context.scene.objects:
 if o.type=='MESH' and ('carbon_hood' in o.name or 'carbon_Wing' in o.name):
  for slot in o.material_slots:
   if slot.material and slot.material.get('bodyPaint'):slot.material=material(bpy.data.materials['TwiXeR_992_carbon_roof'])
# Discard unused COLLADA UV/color channels before joining, so one shared UV set
# retains each object's original mapping instead of creating dozens of empty streams.
for o in bpy.context.scene.objects:
 if o.type=='MESH':
  while len(o.data.uv_layers)>1:o.data.uv_layers.remove(o.data.uv_layers[-1])
  if o.data.uv_layers:o.data.uv_layers[0].name='UVMap'
  for a in list(o.data.color_attributes):o.data.color_attributes.remove(a)
# Rebuild four wheel assemblies from the spec's actual rim/tyre, with pressure-wheel radius.
wheel_sources=[o for o in bpy.context.scene.objects if o.type=='MESH' and (o.name.startswith(('alfie_','michelin_','992_Brake_')))]
for end,source_y,height,radius,x in [('F',-1.16,.34,.3385,.83),('R',1.29,.35,.349,.84)]:
 for side in [-1,1]:
  pivot=bpy.data.objects.new('Wheel_'+end+('L' if side>0 else 'R'),None);bpy.context.collection.objects.link(pivot);pivot.location=(side*x,source_y,height)
  for src in wheel_sources:
   isrim=src.name.startswith('alfie_') and src.name.endswith('20x9' if end=='F' else '20x11')
   istire=src.name=='michelin_tire_'+end+'_PS4S';isbrake=src.name=='992_Brake_'+end
   if not (isrim or istire or isbrake):continue
   obj=src.copy();obj.data=src.data;obj.name=pivot.name+'_'+('Rim' if isrim else 'Tyre' if istire else 'Caliper');bpy.context.collection.objects.link(obj);obj.matrix_world=Matrix.Identity(4);obj.parent=pivot;obj.location=(0,0,0)
   obj.rotation_euler=(0,0,math.pi if side<0 else 0)
   if istire:
    dims=src.dimensions;obj.scale=(.25/dims.x if end=='F' else .27/dims.x,radius/(max(dims.y,dims.z)/2),radius/(max(dims.y,dims.z)/2))
for src in wheel_sources:bpy.data.objects.remove(src,do_unlink=True)
# Steering prop is already authored at its proper cockpit location in this DAE.
steer=bpy.data.objects.get('TwiXeR_992_steer_3')
if steer:
 bpy.context.scene.cursor.location=sum((steer.matrix_world@Vector(c) for c in steer.bound_box),Vector())/8
 bpy.ops.object.select_all(action='DESELECT');steer.select_set(True);bpy.context.view_layer.objects.active=steer;bpy.ops.object.origin_set(type='ORIGIN_CURSOR');steer.name='SteeringWheel'
 # Props are stored flat for BeamNG; rotate their geometry around the actual wheel hub.
 hub=steer.location.copy();steer.matrix_world=Matrix.Translation(hub)@Matrix.Rotation(math.radians(-70),4,'X')@Matrix.Translation(-hub)@steer.matrix_world
# Preserve the combined shell custom normals; remove only complete hidden components.
hidden_faces=0
# Assemble in BeamNG coordinates. A 180-degree Z turn followed by glTF's Y-up conversion
# makes +X right, +Y up, -Z forward, preserving the source face normals and UVs.
root=bpy.data.objects.new('Porsche_911_GT3RS_IRL10',None);bpy.context.collection.objects.link(root);root.rotation_euler.z=math.pi;root.location=(0,.075,.0)
for o in list(bpy.context.scene.objects):
 if o!=root and o.parent is None:o.parent=root
# Merge compatible static meshes by material, keeping transparent panes and animated props separate.
# Join objects without a decimation modifier: no visible triangles are simplified.
static=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.parent==root and o.name!='SteeringWheel']
if static:
 bpy.ops.object.select_all(action='DESELECT')
 for o in static:o.select_set(True)
 bpy.context.view_layer.objects.active=static[0];bpy.ops.object.join();static[0].name='Body_and_Cockpit'
# No unused material slots/UV sets are exported; original texture dimensions are retained.
bpy.ops.object.select_all(action='DESELECT');root.select_set(True)
for o in root.children_recursive:o.select_set(True)
path=work/'porsche-irl10.raw.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_extras=True,export_yup=True,export_materials='EXPORT',export_texcoords=True,export_normals=True,export_tangents=False,export_cameras=False,export_lights=False,export_animations=False,export_image_format='AUTO')
bpy.ops.wm.save_as_mainfile(filepath=str(work/'porsche-irl10.blend'))
report={'sourceArchiveBytes':pathlib.Path(r'C:\web\Porsche 911.zip').stat().st_size,'sourceSelectedTriangles':346561,'exportBytes':path.stat().st_size,'removedMeshes':removed,'hiddenFacesRemoved':hidden_faces,'triangles':sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH'),'textures':used,'missingTextureReferences':sorted(set(missing))}
(work/'export-report.json').write_text(json.dumps(report,indent=2));print('EXPORT',json.dumps({k:v for k,v in report.items() if k!='textures'}))
# Four inspection views rendered from the same asset, with no post-generation editing.
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=16;scene.render.resolution_x=1000;scene.render.resolution_y=700;scene.render.resolution_percentage=100
scene.world.color=(.4,.4,.4)
for loc,power,size in [((3,-4,6),1800,5),((-4,1,4),1400,4),((0,5,5),1800,4)]:
 light=bpy.data.lights.new('Studio','AREA');light.energy=power;light.shape='DISK';light.size=size;obj=bpy.data.objects.new('Studio',light);scene.collection.objects.link(obj);obj.location=loc;obj.rotation_euler=(Vector((0,0,.6))-obj.location).to_track_quat('-Z','Y').to_euler()
cam=bpy.data.objects.new('Camera',bpy.data.cameras.new('Camera'));scene.collection.objects.link(cam);scene.camera=cam;cam.data.lens=48
for name,loc,target in [('front',(5,6,3),(0,0,.65)),('rear',(-5,-6,3),(0,0,.65)),('side',(6,0,1.6),(0,0,.65)),('cockpit',(-.35,-.12,1.04),(-.35,1,1.0))]:
 cam.location=loc;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();scene.render.filepath=str(work/(name+'.png'));bpy.ops.render.render(write_still=True)
