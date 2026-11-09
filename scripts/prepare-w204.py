"""Resolve the default W204 slot tree; leave source mod read-only."""
import pathlib, json, importlib.util,sys,copy,xml.etree.ElementTree as ET
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1]
SOURCE=ROOT/'mods_to_convert/MercedesW204'
WORK=pathlib.Path('/tmp/opencode/w204');WORK.mkdir(exist_ok=True)
spec=importlib.util.spec_from_file_location('porsche',ROOT/'scripts/prepare-porsche.py')
parser=importlib.util.module_from_spec(spec);spec.loader.exec_module(parser)
defs={};sources={};materials={};errors=[];material_sources={};collisions=[]
for path in sorted(SOURCE.rglob('*')):
    if path.suffix!='.jbeam' and not path.name.endswith('.materials.json'):continue
    try:data=parser.relaxed(path.read_text(encoding='utf-8-sig'))
    except Exception as e:errors.append([str(path),str(e)]);continue
    for k,v in data.items():
        if not isinstance(v,dict):continue
        if path.suffix=='.jbeam':
            defs[k]=v;sources[k]=str(path.relative_to(SOURCE))
        else:
            key=v.get('mapTo',k)
            if key in materials:collisions.append({'material':key,'previous':material_sources[key],'replacement':str(path.relative_to(SOURCE))})
            materials[key]=v;material_sources[key]=str(path.relative_to(SOURCE))
config=json.loads((SOURCE/'vehicles/c63w204kene/c63amg_dorest.pc').read_text())
selected={};missing=[];slot_options={}
def visit(name,options=None):
 if not name or name in selected:return
 if name not in defs:missing.append(name);return
 selected[name]=defs[name];slot_options[name]=options or {}
 for row in defs[name].get('slots',[])[1:]:
  if isinstance(row,list) and len(row)>1:visit(config['parts'].get(row[0],row[1]),row[3] if len(row)>3 and isinstance(row[3],dict) else {})
visit(config['mainPartName'])
meshes=[];props=[]
for name,p in selected.items():
 for key,dest,idx in [('flexbodies',meshes,0),('props',props,1)]:
  options={}
  for row in p.get(key,[])[1:]:
   if isinstance(row,dict):options.update(row)
   elif isinstance(row,list) and len(row)>idx and row[idx]:dest.append({'part':name,'mesh':row[idx],'row':row,'options':dict(options),'slotOptions':slot_options[name]})
# Only selected parts contribute substitutions. Keep the slot name (not the off material
# name) as the export/cache key: left/right and brake/running must remain independent.
glow={};glow_sources={}
for name,p in selected.items():
 for key,v in p.get('glowMap',{}).items():
  glow[key]=v;glow_sources[key]=sources[name]
resolved=copy.deepcopy(materials);aliases={};unresolved=[]
for key,v in glow.items():
 off=v.get('off',key);definition=materials.get(off)
 if definition:
  resolved[key]=copy.deepcopy(definition)
  aliases[key]={'off':off,'on':v.get('on'),'on_intense':v.get('on_intense'),'source':glow_sources[key]}
 else:unresolved.append({'slot':key,'off':off})
# Exact original texture stems retained in legacy DAE slots. These slots have no
# assigned faces in the restored import; definitions cover source revisions that
# still bind them without guessing a different atlas or changing their UVs.
legacy_atlases={
 'c63_tex':'c63w204kene_c63_tex',
 'c63_tex__spec_':'c63w204kene_c63_tex',
 'c63_tex__env_14_spec_':'c63w204kene_c63_tex',
 'c63_tex__env_19_spec_':'c63w204kene_c63_tex',
 'c63_tex__env_1_spec_':'c63w204kene_c63_tex',
 'c63_tex__env_2_spec_':'c63w204kene_c63_tex',
 'c63_tex__env_3_spec_':'c63w204kene_c63_tex',
 'c63_interior__env_4_spec_':'c63w204kene_c63_interior',
 'c63_interior__env_9_spec_':'c63w204kene_c63_interior',
 'c63_interioral':'c63w204kene_c63_interioral',
 'c63_lights__env_19_spec_':'c63w204kene_c63_lights',
 'c63_lights__env_50_spec_trans_':'c63w204kene_c63_lights_trans',
}
for key,target in legacy_atlases.items():
 if key not in resolved and target in materials:
  resolved[key]=copy.deepcopy(materials[target]);aliases[key]={'atlas':target,'evidence':'exact DAE texture stem; source definition uses matching local PNG; UV0 unchanged'}
# Explicit neutral physical approximations for generic source slots, no invented atlas.
for key,color,metal,rough in [('rubber',[.016,.017,.018,1],0,.85),('disc_brake',[.32,.34,.36,1],.9,.38),('mirror',[.65,.68,.7,1],1,.04)]:
 if key not in resolved:
  resolved[key]={'Stages':[{'baseColorFactor':color,'metallicFactor':metal,'roughnessFactor':rough}]}
  aliases[key]={'approximation':'generic '+key+' PBR; no source texture inferred'}
# Record actual DAE bindings rather than guessing that similarly named legacy atlases
# have compatible UVs. This mod currently has no library_images, so those slots stay
# explicit fallbacks. Other revisions with real diffuse image bindings can be restored.
ns={'c':'http://www.collada.org/2005/11/COLLADASchema'};dae_materials={}
for path in sorted(SOURCE.rglob('*.dae')):
 tree=ET.parse(path);images={x.get('id'):x.findtext('c:init_from',namespaces=ns) for x in tree.findall('c:library_images/c:image',ns)}
 effects={x.get('id'):x for x in tree.findall('c:library_effects/c:effect',ns)}
 for mat in tree.findall('c:library_materials/c:material',ns):
  inst=mat.find('c:instance_effect',ns);effect=effects.get(inst.get('url','').lstrip('#')) if inst is not None else None
  if effect is None:continue
  params={x.get('sid'):x for x in effect.findall('.//c:newparam',ns)}
  tex=effect.find('.//c:diffuse/c:texture',ns);image=None
  if tex is not None:
   sampler=params.get(tex.get('texture'));surface=params.get(sampler.findtext('c:sampler2D/c:source',namespaces=ns)) if sampler is not None else None
   image=images.get(surface.findtext('c:surface/c:init_from',namespaces=ns)) if surface is not None else images.get(tex.get('texture'))
  key=mat.get('name',mat.get('id'));entry={'source':str(path.relative_to(SOURCE)),'materialId':mat.get('id'),'baseColorMap':image}
  dae_materials.setdefault(key,[]).append(entry)
  if key not in resolved and image:
   # Only an exact, source-relative local file qualifies; no basename/atlas guessing.
   local=(path.parent/image).resolve()
   if local.is_file() and local.is_relative_to(SOURCE.resolve()):
    resolved[key]={'Stages':[{'baseColorMap':'/'+str(local.relative_to(SOURCE.resolve()))}]}
    aliases[key]={'dae':entry}
m={'source':str(SOURCE),'config':config,'parts':selected,'partSources':{k:sources[k] for k in selected},'meshes':meshes,'props':props,'materials':resolved,'sourceMaterials':materials,'materialSources':material_sources,'glowMap':glow,'materialAliases':aliases,'materialCollisions':collisions,'unresolvedGlowMaterials':unresolved,'daeMaterials':dae_materials,'missingParts':missing,'parseErrors':errors,'slotOptions':slot_options}
(WORK/'selected.json').write_text(json.dumps(m,indent=2))
print('PARTS',len(selected),'MISSING',missing,'ERRORS',errors)
for row in meshes+props:print(json.dumps(row))
