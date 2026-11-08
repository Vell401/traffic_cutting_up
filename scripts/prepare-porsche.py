"""Select the BeamNG Irl spec 10 configuration without extracting the entire mod.
Usage: python scripts/prepare-porsche.py ARCHIVE [WORKDIR]
"""
import sys,json,re,zipfile,pathlib,xml.etree.ElementTree as ET

def relaxed(text):
    tokens=re.findall(r'"(?:\\.|[^"\\])*"|//[^\r\n]*|/\*[\s\S]*?\*/|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?|true|false|null|[{}\[\]:,]',text)
    tokens=[t for t in tokens if not t.startswith(('//','/*'))];i=0
    def value():
        nonlocal i
        t=tokens[i];i+=1
        if t=='{':
            o={}
            while tokens[i]!='}':
                if tokens[i]==',':i+=1;continue
                k=json.loads(tokens[i]);i+=1
                assert tokens[i]==':';i+=1;o[k]=value()
            i+=1;return o
        if t=='[':
            a=[]
            while tokens[i]!=']':
                if tokens[i]==',':i+=1;continue
                a.append(value())
            i+=1;return a
        return json.loads(t) if t.startswith('"') or t in ('true','false','null') else float(t) if any(c in t for c in '.eE') else int(t)
    return value()

if __name__=='__main__':
 z=zipfile.ZipFile(sys.argv[1]);out=pathlib.Path(sys.argv[2] if len(sys.argv)>2 else 'data/porsche');out.mkdir(parents=True,exist_ok=True)
 root='vehicles/Porsche 911 992 TwiXeR/';config=json.loads(z.read(root+'Irl spec 10.pc'))
 defs={};sources={};materials={};errors=[]
 # Prefer the primary part definitions over duplicated variant copies.
 for n in sorted(z.namelist(),key=lambda n:(-n.count('/'),n)):
  if n.endswith(('.jbeam','.materials.json')):
   try:d=relaxed(z.read(n).decode('utf-8-sig'))
   except Exception as e:errors.append([n,str(e)]);continue
   if n.endswith('.jbeam'):
    for k,v in d.items():defs[k]=v;sources[k]=n
   else:
    for k,v in d.items():materials[v.get('mapTo',k)]=v
 selected={};missing=[]
 def visit(name):
  if not name or name in selected:return
  if name not in defs:missing.append(name);return
  p=defs[name];selected[name]=p
  for row in p.get('slots',[])[1:]:
   if isinstance(row,list) and len(row)>1:visit(config['parts'].get(row[0],row[1]))
 visit(config['mainPartName'])
 # Preserve exterior, cockpit, tyres/rims and visible brake discs. Hidden powertrain is omitted.
 excluded=re.compile(r'engine_|transaxle|halfshafts|fueltank|radiator|bumperbar|coilover|swaybar|differential|enginemount|suspension|oilpan|intake',re.I)
 meshes=[];props=[];overrides={}
 for name,p in selected.items():
  if excluded.search(name):continue
  for row in p.get('flexbodies',[])[1:]:
   if isinstance(row,list) and row and isinstance(row[0],str):meshes.append({'part':name,'mesh':row[0],'row':row,'source':sources[name]})
  for row in p.get('props',[])[1:]:
   if isinstance(row,list) and len(row)>1 and row[1]:props.append({'part':name,'mesh':row[1],'row':row,'source':sources[name]})
  if isinstance(p.get('material'),dict):overrides.update(p['material'])
 # Skin JBeam uses globalSkin/skinName mapping; retain its definition in the manifest.
 wanted={m['mesh'] for m in meshes+props}
 ns={'c':'http://www.collada.org/2005/11/COLLADASchema'};found={};files=[]
 for n in z.namelist():
  if not n.endswith('.dae'):continue
  raw=z.read(n)
  # Quick string test avoids parsing unrelated body-kit documents.
  if not any(('name="'+w+'"').encode() in raw or ('id="'+w+'"').encode() in raw for w in wanted):continue
  tree=ET.fromstring(raw);geos=tree.find('c:library_geometries',ns)
  if geos is None:continue
  keep=[]
  kept_nodes=set()
  for node in tree.findall('.//c:node',ns):
   name=node.get('name',node.get('id',''))
   if name in wanted:
    refs=node.findall('c:instance_geometry',ns)
    if refs:
     kept_nodes.add(node.get('id'));found[name]=n
     keep.extend(ref.get('url','')[1:] for ref in refs)
  for g in list(geos):
   name=g.get('name','');gid=g.get('id','')
   match=next((w for w in wanted if name==w or gid==w or gid==w+'-mesh'),None)
   if match:keep.append(gid);found[match]=n
   elif gid not in keep:geos.remove(g)
  if not keep:continue
  def prune(parent):
   for node in list(parent):
    if node.tag.endswith('}node'):
     prune(node)
     for inst in list(node):
      if inst.tag.endswith('}instance_geometry') and inst.get('url','')[1:] not in keep:node.remove(inst)
     if node.get('id') not in kept_nodes and not node.findall('c:node',ns):parent.remove(node)
  for scene in tree.findall('c:library_visual_scenes/c:visual_scene',ns):prune(scene)
  dest=out/('selected-'+str(len(files))+'.dae');ET.ElementTree(tree).write(dest,encoding='utf-8',xml_declaration=True);files.append({'source':n,'path':str(dest.resolve()),'geometries':keep})
 manifest={'config':config,'parts':selected,'partSources':{n:sources[n] for n in selected},'meshes':meshes,'props':props,'materials':materials,'files':files,'found':found,'missingParts':missing,'missingMeshes':sorted(wanted-found.keys()),'parseErrors':errors}
 (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
 print(json.dumps({'parts':len(selected),'flexbodies':len(meshes),'props':len(props),'daes':len(files),'missingParts':missing,'missingMeshes':manifest['missingMeshes'],'parseErrors':errors},ensure_ascii=False,indent=2))
 for m in meshes+props:print(m['part'],'=>',m['mesh'])
