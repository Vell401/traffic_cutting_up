import bpy,json,pathlib,sys
from mathutils import Vector
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from w204_collada_normals import restore_file,POSITION_TOLERANCE,NORMAL_TOLERANCE_DEGREES
w=pathlib.Path('/tmp/opencode/w204');m=json.loads((w/'selected.json').read_text());s=pathlib.Path(m['source'])
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
normals=[]
for p in sorted(s.rglob('*.dae')):
 before=set(bpy.context.scene.objects)
 bpy.ops.wm.collada_import(filepath=str(p))
 normals.extend(restore_file(p,set(bpy.context.scene.objects)-before))
audit={'meshCount':len(normals),'cornerCount':sum(r['corners'] for r in normals),'zeroNormalFallbackCount':sum(len(r['zeroNormalFallbackCorners']) for r in normals),'positionTolerance':POSITION_TOLERANCE,'normalToleranceDegrees':NORMAL_TOLERANCE_DEGREES,'meshes':normals}
(w/'normals.json').write_text(json.dumps(audit,indent=2))
print('NORMALS',json.dumps({k:v for k,v in audit.items() if k!='meshes'}))
report=[]
for o in bpy.context.scene.objects:
 if o.type=='MESH':
  pts=[o.matrix_world@Vector(c) for c in o.bound_box]
  report.append({'name':o.name,'location':list(o.location),'rotation':list(o.rotation_euler),'scale':list(o.scale),'bounds':[[min(p[i] for p in pts) for i in range(3)],[max(p[i] for p in pts) for i in range(3)]],'triangles':sum(len(p.vertices)-2 for p in o.data.polygons),'uv':[u.name for u in o.data.uv_layers],'materials':[s.material.name if s.material else None for s in o.material_slots]})
(w/'import.json').write_text(json.dumps(report,indent=2));bpy.ops.wm.save_as_mainfile(filepath=str(w/'import.blend'));print('IMPORTED',len(report))
