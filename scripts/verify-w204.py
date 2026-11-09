"""Validate the decoded delivery and publish the runtime contract and provenance."""
import pathlib,json,struct,io,hashlib
from PIL import Image
R=pathlib.Path(__file__).resolve().parents[1];W=pathlib.Path('/tmp/opencode/w204');path=R/'public/models/mercedes-w204.glb'
f=(W/'inspection.glb').read_bytes();jl=struct.unpack_from('<I',f,12)[0];g=json.loads(f[20:20+jl]);binary=f[28+jl:]
delivered_hash=hashlib.sha256(path.read_bytes()).hexdigest()
normal_report=json.loads((W/'normals-final.json').read_text())
assert normal_report['passed'] and normal_report['deliveredSha256']==delivered_hash
assert normal_report['inspectionSha256']==hashlib.sha256(f).hexdigest()
def accessor(idx):
 a=g['accessors'][idx];v=g['bufferViews'][a['bufferView']];start=v.get('byteOffset',0)+a.get('byteOffset',0);size={5123:2,5125:4}[a['componentType']];return struct.unpack_from('<'+('H' if size==2 else 'I')*a['count'],binary,start)
triangles=0;uv1=0
for n in g['nodes']:
 if 'mesh' not in n:continue
 for p in g['meshes'][n['mesh']]['primitives']:
  a=g['accessors'][p['attributes']['POSITION']];indices=accessor(p['indices']);assert len(indices)%3==0 and max(indices)<a['count'];triangles+=len(indices)//3
  if 'TEXCOORD_1' in p['attributes']:uv1+=1
images=[]
for im in g['images']:
 v=g['bufferViews'][im['bufferView']];raw=binary[v['byteOffset']:v['byteOffset']+v['byteLength']];pic=Image.open(io.BytesIO(raw));images.append({'name':im.get('name'),'width':pic.width,'height':pic.height,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
a=json.loads((W/'assembly.json').read_text());a['steering']['localAxis']=[0,1,0]
a.update({'asset':'/models/mercedes-w204.glb','sourceConfig':'mods_to_convert/MercedesW204/vehicles/c63w204kene/c63amg_dorest.pc','coordinateSystem':'+X right, +Y up, -Z forward; metres; root world coordinates','sourceToRuntime':'(x,y,z) => (-x,z,y)','sourceMassKg':1800,'sourceTyres':'245/40R18','bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'triangles':triangles,'images':images,'textureRgbaMipBytes':round(sum(x['width']*x['height'] for x in images)*16/3),'uv1PrimitiveCount':uv1,'meshPrimitiveCount':sum(len(x['primitives']) for x in g['meshes']),'nodeCount':len(g['nodes']),'meshopt':'EXT_meshopt_compression required; decoded byte-for-byte before inspection','visualInspection':'Four background Cycles renders of decoded final delivery generated. Image-read tool attempted but model reports no image input support; visual approval NOT verified.'})
a['normalVerification']=normal_report
a['visualInspection']='Four Cycles renders of decoded delivery generated; automated DAE normal/material checks passed. Visual approval and in-game frame timing remain unverified (image input unavailable).'
a['materialAliasCount']=len(json.loads((W/'selected.json').read_text()).get('materialAliases',{}))
a['emissiveTextureMaterialCount']=sum('emissiveTexture' in mat for mat in g['materials'])
a['occlusionTextureMaterialCount']=sum('occlusionTexture' in mat for mat in g['materials'])
assert triangles<=260000 and a['bytes']<=24*1024**2 and a['textureRgbaMipBytes']<=192*1024**2
names={n['name'] for n in g['nodes']};assert {'Wheel_FL','Wheel_FR','Wheel_RL','Wheel_RR','SteeringWheel'}<=names
assert uv1>0
(R/'public/models/mercedes-w204.manifest.json').write_text(json.dumps(a,indent=2));print(json.dumps({k:a[k] for k in ['bytes','triangles','textureRgbaMipBytes','uv1PrimitiveCount','nodeCount','meshPrimitiveCount','steering']},indent=2))
