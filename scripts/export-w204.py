"""Blender 3.0.1: selected W204, explicit wheel transforms, retained UV0/UV1."""
import bpy,json,pathlib,re,math
from mathutils import Matrix,Vector
ROOT=pathlib.Path(__file__).resolve().parents[1];W=pathlib.Path('/tmp/opencode/w204');m=json.loads((W/'selected.json').read_text());textures=json.loads((W/'textures.json').read_text())
bpy.ops.wm.open_mainfile(filepath=str(W/'import.blend'))
sources={o.name:o for o in bpy.context.scene.objects if o.type=='MESH'}
cache={};images={};fallback=[];kept=[];omitted=[]
def material(old):
 canonical=re.sub(r'\.\d{3}$','',old.name)
 name=old.name if old.name in m['materials'] or canonical not in m['materials'] else canonical
 if name in cache:return cache[name]
 d=m['materials'].get(name,{});st=d.get('Stages',[{}])[0];t=textures['materials'].get(name,{})
 mat=bpy.data.materials.new('W204_BodyPaint' if name=='c63w204kene_paint' else name+'_PBR');mat.use_nodes=True;n=mat.node_tree.nodes;l=mat.node_tree.links;p=next(x for x in n if x.type=='BSDF_PRINCIPLED')
 def factor(key,default):return default if st.get(key) is None else st[key]
 color=st.get('baseColorFactor') or st.get('diffuseColor') or ([1,1,1,1] if t.get('base') else [.055,.055,.055,1]);p.inputs['Base Color'].default_value=(color+[1])[:4];p.inputs['Metallic'].default_value=factor('metallicFactor',0);p.inputs['Roughness'].default_value=factor('roughnessFactor',.55)
 mat['sourceMaterial']=name
 alias=m.get('materialAliases',{}).get(name)
 if alias:mat['materialAlias']=json.dumps(alias)
 def disconnect(socket):
      for link in list(socket.links):l.remove(link)
 def tex(key):
      path=t.get(key)
      if not path:return None
      linear=key in ['normal','orm','ao']
      if (path,linear) not in images:
          im=bpy.data.images.load(path,check_existing=False)
          if linear:
              try:im.colorspace_settings.name='Non-Color'
              except TypeError:im.colorspace_settings.name='Linear'
          images[path,linear]=im
      node=n.new('ShaderNodeTexImage');node.image=images[path,linear]
      uv=n.new('ShaderNodeUVMap');index=t.get(key+'UV',0);uv.uv_map='UVMap' if index==0 else 'UV1' if index==1 else 'UV'+str(index);l.new(uv.outputs['UV'],node.inputs['Vector']);return node
 base=tex('base')
 if base:
  mix=n.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=1;mix.inputs[2].default_value=(color+[1])[:4];l.new(base.outputs['Color'],mix.inputs[1]);l.new(mix.outputs[0],p.inputs['Base Color'])
 if base and (st.get('opacityMap') or d.get('translucent')):
      alpha=n.new('ShaderNodeMath');alpha.operation='MULTIPLY';alpha.inputs[1].default_value=factor('opacityFactor',1);l.new(base.outputs['Alpha'],alpha.inputs[0]);l.new(alpha.outputs[0],p.inputs['Alpha']);mat.blend_method='HASHED'
 if not base and d.get('translucent'):
      p.inputs['Alpha'].default_value=factor('opacityFactor',1);mat.blend_method='BLEND'
 normal=tex('normal')
 if normal:
   nn=n.new('ShaderNodeNormalMap');index=t.get('normalUV',0);nn.uv_map='UVMap' if index==0 else 'UV1' if index==1 else 'UV'+str(index);nn.inputs['Strength'].default_value=factor('normalMapStrength',1);l.new(normal.outputs['Color'],nn.inputs['Color']);l.new(nn.outputs['Normal'],p.inputs['Normal'])
 orm=tex('orm')
 if orm:
      sep=n.new('ShaderNodeSeparateRGB');l.new(orm.outputs['Color'],sep.inputs[0]);l.new(sep.outputs['G'],p.inputs['Roughness']);l.new(sep.outputs['B'],p.inputs['Metallic'])
 ao=tex('ao')
 if ao:
      group=bpy.data.node_groups.get('glTF Settings')
      if group is None:
          group=bpy.data.node_groups.new('glTF Settings','ShaderNodeTree');group.inputs.new('NodeSocketFloat','Occlusion')
      settings=n.new('ShaderNodeGroup');settings.node_tree=group;l.new(ao.outputs['Color'],settings.inputs['Occlusion'])
 p.inputs['Clearcoat'].default_value=min(max(factor('clearCoatFactor',0),0),1);p.inputs['Clearcoat Roughness'].default_value=factor('clearCoatRoughnessFactor',.03)
 if not d:fallback.append(name)
 lower=name.lower()
 if any(x in lower for x in ['plastic','leather','carpet','alcantara','tire','seat','interior']):disconnect(p.inputs['Metallic']);p.inputs['Metallic'].default_value=0
 if any(x in lower for x in ['plastic','leather','carpet','tire']) and not base:p.inputs['Base Color'].default_value=[.025,.026,.028,1]
 if canonical in {'mirror','mirror__env_9_spec_'}:p.inputs['Base Color'].default_value=[.65,.68,.7,1];p.inputs['Metallic'].default_value=1;p.inputs['Roughness'].default_value=.04
 if 'chrome' in lower:p.inputs['Metallic'].default_value=1
 if name=='c63w204kene_paint':
  # Palette/multilayer base and metal maps cannot represent editable single-coat paint.
  # Keep authored AO, normal and roughness when available, with the Porsche finish.
  disconnect(p.inputs['Base Color']);disconnect(p.inputs['Metallic'])
  p.inputs['Base Color'].default_value=[.88,.88,.88,1];p.inputs['Metallic'].default_value=.5;p.inputs['Roughness'].default_value=.22;p.inputs['Clearcoat'].default_value=1;p.inputs['Clearcoat Roughness'].default_value=.03;mat['bodyPaint']=True
 if 'glass' in lower and 'black' not in lower and 'invisible' not in lower:
  disconnect(p.inputs['Base Color']);disconnect(p.inputs['Alpha']);disconnect(p.inputs['Metallic']);disconnect(p.inputs['Roughness'])
  p.inputs['Base Color'].default_value=[.12,.18,.17,1];p.inputs['Alpha'].default_value=.12 if any(x in lower for x in ['headlight','fog']) else .16;p.inputs['Metallic'].default_value=0;p.inputs['Roughness'].default_value=.09;mat.blend_method='BLEND';mat.use_screen_refraction=True
 if any(x in lower for x in ['screen','gauges']):p.inputs['Metallic'].default_value=0
 emission=tex('emissive');runtime=t.get('runtimeEmission',False)
 emission_color=[0,0,0,1] if runtime else [max(0,min(1,x)) for x in (t.get('emissiveFactor') or [0,0,0])]+[1]
 p.inputs['Emission Strength'].default_value=1
 if emission:
  # A multiply exposes both the glTF emissiveTexture and an explicit black factor;
  # runtime supplies per-instance emission without losing the original mask.
  mix=n.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=1;mix.inputs[2].default_value=emission_color;l.new(emission.outputs['Color'],mix.inputs[1]);l.new(mix.outputs[0],p.inputs['Emission'])
 else:p.inputs['Emission'].default_value=emission_color
 if runtime:mat['runtimeEmission']=True
 if 'screen_dorest' in lower and base and not emission:
  mix=n.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=1;mix.inputs[2].default_value=[0,0,0,1];l.new(base.outputs['Color'],mix.inputs[1]);l.new(mix.outputs[0],p.inputs['Emission'])
 mat.use_backface_culling=not d.get('doubleSided',False);cache[name]=mat;return mat
def convert(obj):
 for slot in obj.material_slots:
  if slot.material:slot.material=material(slot.material)
 # Normalize names without discarding the second authored UV channel.
 for i,u in enumerate(obj.data.uv_layers):u.name='UVMap' if i==0 else 'UV1' if i==1 else 'UV'+str(i)
def empty(name,loc):
 o=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(o);o.location=loc;return o
root=empty('Mercedes_W204',(0,0,0));root.rotation_euler.z=math.pi
exclude=re.compile(r'enginebay|trunkbay|radsupport|heatshield|bumperbar|fueltank|engine_v8|enginev8|header_v8|transmission|radiator|lowerarm|upperarm|tierod|subframe|halfshaft|spring_|shock_|swaybar|strut_|steeringbox|driveshaft|_diff$|_hub_[FR]$|windshield_dmg')
wheelmesh={'c63w204kene_wheel','tire_01a_19x9_26_michelin'}
wheelcenters={}
for axle,y,x in [('F',-1.4,.745),('R',1.295,.73)]:
 for side,sign in [('L',1),('R',-1)]:
  name='Wheel_'+axle+side;center=(sign*x,y,.33);pivot=empty(name,center);pivot.parent=root;wheelcenters[name]=[-center[0],center[2],center[1]]
  for mesh,label in [('c63w204kene_wheel','Rim'),('tire_01a_19x9_26_michelin','Tyre')]:
   src=sources[mesh];o=src.copy();o.data=src.data.copy();bpy.context.collection.objects.link(o);o.name=name+'_'+label;o.parent=pivot;o.matrix_parent_inverse=Matrix.Identity(4);o.location=(0,0,0);o.rotation_euler=(0,0,math.pi if sign<0 else 0)
   # Selected nodeOffset: ±(.51 + .245-.01) / ±(.51 + .225-.005).
   # Standard rim is 18in at bead seat (outer flange diameter 0.501m).
   o.scale=(1,1,1) if label=='Rim' else (.245/src.dimensions.x,.65/src.dimensions.y,.65/src.dimensions.z);convert(o);kept.append(o)
  # Missing BeamNG base disc: local, correctly sized replacement. Caliper remains nonspinning.
  bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=.18 if axle=='F' else .165,depth=.018,location=(sign*(x-.045),y,.33),rotation=(0,math.pi/2,0));disc=bpy.context.object;disc.name=name+'_BrakeDisc';disc.parent=root
  disc.data.materials.append(material(type('M',(),{'name':'c63w204kene_aluminium'})()));kept.append(disc)
for row in m['meshes']+m['props']:
 name=row['mesh']
 if name in wheelmesh or name.startswith(('brake_hub','brake_disc')) or name=='SPOTLIGHT':continue
 if exclude.search(name):omitted.append(name);continue
 src=sources.get(name)
 if not src:omitted.append(name);continue
 o=src.copy();o.data=src.data.copy();bpy.context.collection.objects.link(o);o.name=name+'_Selected';o.parent=None;o.matrix_world=src.matrix_world.copy()
 options=next((x for x in row['row'][3:] if isinstance(x,dict) and 'pos' in x),None)
 if options:
  from mathutils import Euler
  pos=Vector(tuple(options.get('pos',{}).get(k,0) for k in 'xyz'));rot=Euler(tuple(math.radians(options.get('rot',{}).get(k,0)) for k in 'xyz'))
  scale=tuple(options.get('scale',{}).get(k,1) for k in 'xyz');o.matrix_world=Matrix.Translation(pos)@rot.to_matrix().to_4x4()@Matrix.Diagonal((*scale,1))@src.matrix_world
 if name=='c63w204kene_steer':o.name='SteeringWheel'
 o.parent=root;convert(o);kept.append(o)
for o in list(sources.values()):bpy.data.objects.remove(o,do_unlink=True)
for o in list(bpy.context.scene.objects):
 if o!=root and o not in kept and o.parent!=root:bpy.data.objects.remove(o,do_unlink=True)
# Plate replacements have no external dependencies and don't pretend to reproduce a registration.
for label,y,z in [('F',-2.232,.486),('R',2.209,.864)]:
 bpy.ops.mesh.primitive_cube_add(size=1,location=(0,y,z));o=bpy.context.object;o.name='LicensePlate_'+label;o.scale=(.52,.008,.11);o.parent=root;o.data.materials.append(material(type('M',(),{'name':'c63w204kene_paint'})()));kept.append(o)
anchors={'CockpitCamera':(.344,.17,1.16),'Headlamp_L':(.6,-2.04,.7),'Headlamp_R':(-.6,-2.04,.7),'InstrumentCluster':(.341,-.59,.95),'DashboardScreen':(0,-.72,.99)}
for name,loc in anchors.items():o=empty(name,loc);o.parent=root
steer=bpy.data.objects['SteeringWheel'];pivot=steer.location.copy();axis=steer.rotation_euler.to_matrix()@Vector((0,0,1));runtime_axis=[-axis.x,axis.z,axis.y]
bpy.context.view_layer.update()
report={'selectedPartCount':len(m['parts']),'selectedParts':list(m['parts']),'missingParts':m['missingParts'],'omittedMeshes':sorted(set(omitted)),'fallbackMaterials':sorted(set(fallback)),'wheelCenters':wheelcenters,'wheelRadius':.325,'wheelSpinAxis':[1,0,0],'frontSteerAxis':[0,1,0],'steering':{'node':'SteeringWheel','pivot':[-pivot.x,pivot.z,pivot.y],'axis':runtime_axis,'localAxis':[0,1,0]},'anchors':{k:[-v[0],v[2],v[1]] for k,v in anchors.items()},'materials':{k:v.name for k,v in cache.items()},'triangles':sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in kept),'uv1Objects':[o.name for o in kept if len(o.data.uv_layers)>1]}
(W/'assembly.json').write_text(json.dumps(report,indent=2));bpy.ops.wm.save_as_mainfile(filepath=str(W/'assembled.blend'))
bpy.ops.export_scene.gltf(filepath=str(W/'raw.glb'),export_format='GLB',export_yup=True,export_extras=True,export_normals=True,export_animations=False,export_cameras=False,export_lights=False)
print('ASSEMBLY',json.dumps({k:v for k,v in report.items() if k in ['triangles','wheelCenters','steering']}))
