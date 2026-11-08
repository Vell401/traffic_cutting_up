import bpy,json,pathlib
from mathutils import Vector
work=pathlib.Path('C:/web/traffic_cutting_up/data/porsche');m=json.loads((work/'manifest.json').read_text(encoding='utf8'));bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
for f in m['files']:
 before=set(bpy.data.objects)
 bpy.ops.wm.collada_import(filepath=f['path'],import_units=True)
 for o in set(bpy.data.objects)-before:o['source_dae']=f['source']
report=[]
for o in bpy.context.scene.objects:
 if o.type!='MESH':continue
 v=[o.matrix_world@Vector(c) for c in o.bound_box];report.append({'name':o.name,'source':o.get('source_dae'),'vertices':len(o.data.vertices),'tris':sum(len(p.vertices)-2 for p in o.data.polygons),'min':[min(p[k] for p in v) for k in range(3)],'max':[max(p[k] for p in v) for k in range(3)],'materials':[s.material.name if s.material else None for s in o.material_slots]})
(work/'import-report.json').write_text(json.dumps(report,indent=2));bpy.ops.wm.save_as_mainfile(filepath=str(work/'selected.blend'));print('IMPORTED',len(report),'TRIS',sum(o['tris'] for o in report))
