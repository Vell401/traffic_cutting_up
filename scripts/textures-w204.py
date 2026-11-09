"""Pillow texture staging: case-insensitive local lookup, repaired Seat paths, PBR packing."""
import pathlib,json,hashlib
from PIL import Image,ImageOps
W=pathlib.Path('/tmp/opencode/w204');m=json.loads((W/'selected.json').read_text());S=pathlib.Path(m['source']);T=W/'textures';T.mkdir(exist_ok=True)
files={str(p.relative_to(S)).lower():p for p in S.rglob('*') if p.is_file()};missing=set();repairs={};used={}
def resolve(ref):
 if not ref or ref.startswith('@'):return None
 key=ref.lstrip('/').lower();p=files.get(key)
 if not p:
  key=key.replace('/seat/seat/','/seat/');p=files.get(key)
 if not p:
  # Missing mod paths sometimes add/remove a Seat directory; only unique filenames qualify.
  candidates=[v for k,v in files.items() if pathlib.Path(k).name==pathlib.Path(key).name]
  if len(candidates)==1:p=candidates[0]
 if not p:missing.add(ref);return None
 if str(p.relative_to(S)).lower()!=ref.lstrip('/').lower():repairs[ref]=str(p.relative_to(S))
 return p
def load(ref,limit=1024):
 p=resolve(ref)
 if not p:return None
 try:
  im=Image.open(p).convert('RGBA');im.thumbnail((limit,limit),Image.Resampling.LANCZOS);return im
 except Exception as e:missing.add(ref+': '+str(e));return None
def save(im,key,linear=False,lossless=False):
 token=hashlib.sha256((key+str(im.size)+str(linear)+str(lossless)).encode()).hexdigest()[:16];alpha=im.mode=='RGBA' and im.getextrema()[3]!=(255,255)
 ext='.png' if linear or alpha or lossless else '.jpg';p=T/(token+ext)
 if ext=='.jpg':im.convert('RGB').save(p,quality=91,optimize=True)
 else:im.save(p,optimize=True)
 used[str(p)]={'width':im.width,'height':im.height,'source':key,'bytes':p.stat().st_size};return str(p)
def factor(st,key,default):
 value=st.get(key)
 return default if value is None else value
def uv(st,key):return int(factor(st,key+'UseUV',0))
def limits(name,st):
 label=(name+' '+str(st.get('baseColorMap',''))).lower()
 if any(x in label for x in ['tire','tyre','michelin','michlen','badge','logo']):return 2048,1024
 if any(x in label for x in ['c63_tex','interior','gauges','symbols','headlight','taillight','c63_hl','c63_lights','screen']):return 1024,512
 return 512,512
out={};uv_mismatches=[]
for name,d in m['materials'].items():
    if '.skin' in name:continue
    st=d.get('Stages',[{}])[0];r={};color_limit,data_limit=limits(name,st)
    basekey=next((k for k in ['baseColorMap','diffuseMap','colorMap'] if st.get(k)), 'baseColorMap')
    base=st.get(basekey);op=st.get('opacityMap');im=load(base,color_limit)
    if im:
        mask=load(op,color_limit) if op else None
        if mask:
            mask=mask.resize(im.size,Image.Resampling.LANCZOS)
            if uv(st,'opacityMap')!=uv(st,basekey):
                uv_mismatches.append({'material':name,'maps':[basekey,'opacityMap']})
            else:im.putalpha(mask.getchannel('A') if mask.getextrema()[3]!=(255,255) else mask.getchannel('R'))
        lossless=any(x in (name+' '+str(base)).lower() for x in ['symbols','gauges','logo','badge','decals','screen'])
        r['base']=save(im,str(base)+'|'+str(op),lossless=lossless);r['baseUV']=uv(st,basekey)
    normal=load(st.get('normalMap'),data_limit)
    if normal:
        red,green,blue,alpha=normal.split();normal=Image.merge('RGB',(red,ImageOps.invert(green),blue));r['normal']=save(normal,str(st.get('normalMap'))+'|DirectX-to-OpenGL',True);r['normalUV']=uv(st,'normalMap')
    rough=load(st.get('roughnessMap'),data_limit);metal=load(st.get('metallicMap'),data_limit)
    if rough and metal and uv(st,'roughnessMap')!=uv(st,'metallicMap'):
        uv_mismatches.append({'material':name,'maps':['roughnessMap','metallicMap']});metal=None
    if rough or metal:
        size=(rough or metal).size;r['ormUV']=uv(st,'roughnessMap' if rough else 'metallicMap')
        rough=rough.getchannel('R').resize(size) if rough else Image.new('L',size,round(255*factor(st,'roughnessFactor',.55)))
        metal=metal.getchannel('R').resize(size) if metal else Image.new('L',size,round(255*factor(st,'metallicFactor',0)))
        r['orm']=save(Image.merge('RGB',(Image.new('L',size,255),rough,metal)),str(st.get('roughnessMap'))+'|'+str(st.get('metallicMap'))+'|'+str(factor(st,'roughnessFactor',.55))+'|'+str(factor(st,'metallicFactor',0)),True)
    ao=load(st.get('ambientOcclusionMap'),color_limit)
    if ao:r['ao']=save(ao.getchannel('R').convert('RGB'),str(st['ambientOcclusionMap'])+'|AO',True);r['aoUV']=uv(st,'ambientOcclusionMap')
    alias=m.get('materialAliases',{}).get(name,{});on=m.get('sourceMaterials',m['materials']).get(alias.get('on'),d);em=on.get('Stages',[{}])[0]
    emission=load(em.get('emissiveMap'),color_limit)
    if emission:r['emissive']=save(emission,str(em['emissiveMap'])+'|emissive',lossless=True);r['emissiveUV']=uv(em,'emissiveMap')
    r['emissiveFactor']=em.get('emissiveFactor');r['runtimeEmission']=name in m.get('glowMap',{})
    out[name]=r
(W/'textures.json').write_text(json.dumps({'materials':out,'images':used,'missing':sorted(missing),'repairs':repairs,'uvMismatches':uv_mismatches,'rgbaMipBytes':round(sum(v['width']*v['height']*4*4/3 for v in used.values()))},indent=2));print('STAGED',len(used),'REPAIRS',repairs,'UV_MISMATCHES',uv_mismatches)
