import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildVehicle, buildWheel } from '../render/carModels';
import { buildModel, catalog, defaults, palette, type Kind, type LOD, type Settings } from '../render/trafficModels';
const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;
const input = (id: string) => $<HTMLInputElement>(id);
const status = (s: string) => { $('status').textContent = s; };
let kind: Kind = 'sedan', lod: LOD = 0;
let currentView='perspective';
const saved: Partial<Record<Kind, Settings>> = {};
function validate(v: unknown): Settings {
  if(!v || typeof v !== 'object') throw Error('Неверные параметры');
  const s = v as Settings;
  if(!/^#[0-9a-f]{6}$/i.test(s.color)||!/^#[0-9a-f]{6}$/i.test(s.cargoColor)) throw Error('Неверный цвет');
  for(const [k,min,max] of [['height',.9,1.1],['wheelScale',.9,1.1],['roughness',.1,.9],['metalness',0,1]] as const)
    if(typeof s[k] !== 'number'||!Number.isFinite(s[k])||s[k]<min||s[k]>max) throw Error('Параметр вне диапазона: '+k);
  return { color:s.color,cargoColor:s.cargoColor,height:s.height,wheelScale:s.wheelScale,roughness:s.roughness,metalness:s.metalness };
}
try { const data=JSON.parse(localStorage.getItem('traffic-atelier-v3')||'{}'); for(const k of Object.keys(catalog) as Kind[]) if(data[k]) saved[k]=validate(data[k]); } catch { status('Локальные настройки недоступны; используйте JSON.'); }
const settings = () => saved[kind] ||= {...defaults, color:palette[kind]};
const scene = new T.Scene(); scene.background = new T.Color('#d9dce2');
const camera = new T.PerspectiveCamera(38,1,.1,500);
const inspectionCamera=new T.PerspectiveCamera(38,1,.1,500);
let renderer: T.WebGLRenderer;
try { renderer = new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true}); } catch { $('error').style.display='block'; $('error').textContent='Для просмотра нужен браузер с WebGL 2 и включённым аппаратным ускорением.'; throw Error('WebGL unavailable'); }
renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
const room=new RoomEnvironment(),pmrem=new T.PMREMGenerator(renderer);const env=pmrem.fromScene(room,.06);scene.environment=env.texture;scene.environmentIntensity=.55;room.dispose();pmrem.dispose();
$('viewport').prepend(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement); controls.enableDamping=true; controls.maxPolarAngle=Math.PI*.49; controls.minDistance=2; controls.maxDistance=180;
const hemi=new T.HemisphereLight('#e4f2ff','#70798b',1.2); scene.add(hemi);
const key=new T.DirectionalLight('#fff5eb',2.8);key.position.set(-5,9,-4);scene.add(key);key.castShadow=true;key.shadow.mapSize.set(2048,2048);Object.assign(key.shadow.camera,{left:-18,right:18,top:18,bottom:-18,near:.1,far:60});key.shadow.bias=-.0003;key.shadow.normalBias=.025;key.shadow.radius=3;
const rim=new T.DirectionalLight('#c6e6ff',2);rim.position.set(4,4,7);scene.add(rim);
const floor=new T.Mesh(new T.PlaneGeometry(240,240),new T.MeshStandardMaterial({color:'#9ca4b2',roughness:.95}));floor.rotation.x=-Math.PI/2;floor.position.y=-.025;floor.receiveShadow=true;scene.add(floor);
const grid=new T.GridHelper(200,200,'#aab7ae','#bac5bc');grid.position.y=-.018;grid.visible=false;scene.add(grid);
let root=new T.Group(), exportRoot=new T.Group();scene.add(root);
const triangleCount=(g:T.BufferGeometry)=>(g.index?.count??g.getAttribute('position').count)/3;
function clear() { const geos=new Set<T.BufferGeometry>(), mats=new Set<T.Material>(); root.traverse(o=>{if(o instanceof T.Mesh||o instanceof T.LineSegments){geos.add(o.geometry); const m=o.material; (Array.isArray(m)?m:[m]).forEach(x=>mats.add(x));} if(o instanceof T.InstancedMesh)o.dispose();});geos.forEach(g=>g.dispose());mats.forEach(m=>m.dispose());scene.remove(root);root=new T.Group();scene.add(root); }
function rebuild() {
  clear(); const s=settings(),d=catalog[kind],model=buildModel(kind,lod,s),fleet=input('fleet').checked,gallery=input('gallery').checked,compare=input('compare').checked&&!fleet&&!gallery;
  key.castShadow=!fleet;renderer.shadowMap.enabled=!fleet;
  const mats=[new T.MeshStandardMaterial({color:s.color,vertexColors:true,roughness:s.roughness,metalness:s.metalness}),new T.MeshStandardMaterial({vertexColors:true,roughness:.6,metalness:.18,envMapIntensity:.12}),new T.MeshBasicMaterial({vertexColors:true})];
  mats.forEach(m=>m.wireframe=input('wire').checked);
  exportRoot=new T.Group(); exportRoot.name=kind+'-lod'+lod;
  model.parts.forEach((g,i)=>{const mesh=new T.Mesh(g,mats[i]);mesh.castShadow=true;mesh.receiveShadow=true;exportRoot.add(mesh);});
  if(gallery) {
    (Object.keys(catalog) as Kind[]).forEach((k,j)=>{
      const ss=saved[k]??{...defaults,color:palette[k]},mm=k===kind?model:buildModel(k,lod,ss);
      const materials=k===kind?mats:[new T.MeshStandardMaterial({color:ss.color,vertexColors:true,roughness:ss.roughness,metalness:ss.metalness}),mats[1],mats[2]];
      const group=new T.Group();group.position.set((j%4-1.5)*6,0,j<4?-5:6.5);root.add(group);
      if(k===kind)group.add(exportRoot);else mm.parts.forEach((g,i)=>{const mesh=new T.Mesh(g,materials[i]);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);});
    });
  } else if(fleet) {
    const matrix=new T.Matrix4();model.parts.forEach((g,i)=>{const mesh=new T.InstancedMesh(g,mats[i],72);for(let j=0;j<72;j++){matrix.makeTranslation((j%8-3.5)*(d.width+1.2),0,(Math.floor(j/8)-4)*(d.length+1.2));mesh.setMatrixAt(j,matrix);}mesh.instanceMatrix.needsUpdate=true;root.add(mesh);});
  } else {exportRoot.position.x=compare?d.width*.9:0;root.add(exportRoot);}
  const old=buildVehicle(kind.startsWith('sedan')?'sedan':kind,d.length,d.width),wheel=buildWheel();let oldTriangles=triangleCount(old.body)+(old.cargo?triangleCount(old.cargo):0)+old.axles.length*2*triangleCount(wheel);
  if(compare){const oldGroup=new T.Group();oldGroup.position.x=-d.width*.9;root.add(oldGroup);oldGroup.add(new T.Mesh(old.body,mats[0]));if(old.cargo)oldGroup.add(new T.Mesh(old.cargo,new T.MeshStandardMaterial({color:s.cargoColor,vertexColors:true})));for(const axle of old.axles) for(const side of [-1,1]){const mesh=new T.Mesh(wheel,mats[1]);mesh.position.set(side*(d.width/2-axle.width/2-.02),axle.r,-axle.f);mesh.scale.set(axle.width,axle.r,axle.r);oldGroup.add(mesh);}}
  else {old.body.dispose();old.cargo?.dispose();wheel.dispose();}
  if(input('bounds').checked&&!fleet&&!gallery)root.add(new T.BoxHelper(exportRoot,0x347e6b));
  $('tris').textContent=model.triangles.toLocaleString('ru');$('memory').textContent=(model.bytes/1024).toFixed(0);$('oldtris').textContent=oldTriangles.toLocaleString('ru');
  $('name').textContent=gallery?'Коллекция':d.title.slice(5);$('dimensions').textContent=`${gallery?d.title.slice(5)+' · ':''}${d.length.toFixed(2)} × ${d.width.toFixed(2)} м · LOD ${lod}`;
  $('legend').textContent=gallery?'Восемь силуэтов / REF.05':fleet?'72 экземпляра / выбранный тип':compare?'Слева — V1 / справа — REF.05':'Студийный образец / REF.05';
  document.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(b=>b.classList.toggle('active',b.dataset.kind===kind));
}
function frame(view=currentView) {
  currentView=view;
  const d=catalog[kind], fleet=input('fleet').checked, gallery=input('gallery').checked, distance=gallery?40:fleet?Math.max(45,d.length*10):Math.max(7,d.length*1.8)*(input('compare').checked?1.25:1);
  controls.target.set(0,fleet||gallery?0:d.height*.45,gallery?2:0);
  const directions:Record<string,number[]>={front:[0,.14,-1],rear:[0,.14,1],side:[1,.12,0],left:[-1,.12,0],rearRight:[.82,.30,1],rearLeft:[-.82,.30,1],frontLeft:[-.82,.30,-1],top:[0,1,-.001],perspective:[.72,.43,-.85]};
  camera.position.copy(controls.target).add(new T.Vector3(...directions[view]).normalize().multiplyScalar(distance * Math.max(1, .95 / camera.aspect)));controls.update();
}
const fields = {paint:'color',cargo:'cargoColor',height:'height',wheel:'wheelScale',rough:'roughness',metal:'metalness'} as const;
function sync(){for(const [id,k] of Object.entries(fields)){input(id).value=String(settings()[k]);if($(id+'Value'))$(id+'Value').textContent=String(settings()[k]);}}
for(const [id,k] of Object.entries(fields))input(id).addEventListener('input',()=>{const s=settings();if(k==='color'||k==='cargoColor')s[k]=input(id).value;else s[k]=Number(input(id).value);sync();rebuild();try{localStorage.setItem('traffic-atelier-v3',JSON.stringify(saved));status('Изменения сохранены в этом браузере.');}catch{status('Для сохранения скачайте JSON.');}});
for(const k of Object.keys(catalog) as Kind[]){const b=document.createElement('button');b.dataset.kind=k;b.innerHTML=`${catalog[k].title}<span>${catalog[k].length.toFixed(2)} м / ${k}</span>`;b.onclick=()=>{kind=k;sync();rebuild();frame();};$('models').append(b);}
for(const id of ['wire','bounds','compare','fleet','gallery']) input(id).onchange=()=>{if(['fleet','gallery','compare'].includes(id)&&input(id).checked)input('inspect').checked=false;if(['fleet','gallery','compare'].includes(id)&&input(id).checked)for(const other of ['fleet','gallery','compare'])if(other!==id)input(other).checked=false;if(id==='fleet'&&input('fleet').checked)input('compare').checked=false; if(id==='compare'&&input('compare').checked)input('fleet').checked=false;rebuild();if(['compare','fleet','gallery'].includes(id))frame();};
$('lod').onchange=()=>{lod=Number(($('lod') as HTMLSelectElement).value) as LOD;rebuild();};
input('inspect').onchange=()=>{if(input('inspect').checked){input('fleet').checked=false;input('gallery').checked=false;input('compare').checked=false;rebuild();} };
input('grid').onchange=()=>{grid.visible=input('grid').checked;};
$('light').onchange=()=>{const night=($('light') as HTMLSelectElement).value==='night';scene.background=new T.Color(night?'#101b29':'#d9dce2');hemi.intensity=night?.4:1.2;key.intensity=night?.5:2.8;rim.intensity=night?1:2;floor.material.color.set(night?'#202a35':'#9ca4b2');};
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b=>b.onclick=()=>frame(b.dataset.view));
function download(data:Blob,name:string){const a=document.createElement('a');const url=URL.createObjectURL(data);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('png').onclick=()=>{renderScene();renderer.domElement.toBlob(blob=>{if(blob)download(blob,`traffic-${input('gallery').checked?'collection':kind}-preview.png`);},'image/png');};
$('export').onclick=()=>download(new Blob([JSON.stringify({version:3,kind,lod,settings:settings()},null,2)],{type:'application/json'}),`traffic-${kind}.json`);
$('import').onclick=()=>input('file').click();input('file').onchange=async()=>{try{const file=input('file').files?.[0];if(!file)return;if(file.size>100000)throw Error('Слишком большой файл');const data=JSON.parse(await file.text());if(![2,3].includes(data.version)||!Object.hasOwn(catalog,data.kind)||![0,1,2].includes(data.lod))throw Error('Неверный формат модели');const s=validate(data.settings);kind=data.kind;lod=data.lod;saved[kind]=s;($('lod') as HTMLSelectElement).value=String(lod);sync();rebuild();frame();try{localStorage.setItem('traffic-atelier-v3',JSON.stringify(saved));}catch{}status('Правки загружены.');}catch(e){status('Не удалось загрузить: '+(e as Error).message);}input('file').value='';};
$('glb').onclick=async()=>{try{const clone=exportRoot.clone();clone.position.set(0,0,0);clone.children.forEach(child=>{if(child instanceof T.Mesh){child.material=child.material.clone();child.material.wireframe=false;}});const data=await new GLTFExporter().parseAsync(clone,{binary:true});clone.children.forEach(child=>{if(child instanceof T.Mesh)child.material.dispose();});download(new Blob([data as ArrayBuffer],{type:'model/gltf-binary'}),`${kind}-lod${lod}.glb`);status('Модель GLB экспортирована.');}catch(e){status('Ошибка GLB: '+(e as Error).message);}};
$('reset').onclick=()=>{saved[kind]={...defaults,color:palette[kind]};sync();rebuild();try{localStorage.setItem('traffic-atelier-v3',JSON.stringify(saved));}catch{}status('Параметры образца сброшены.');};
new ResizeObserver(()=>{const el=$('viewport');renderer.setSize(el.clientWidth,el.clientHeight);camera.aspect=el.clientWidth/el.clientHeight;camera.updateProjectionMatrix();frame();}).observe($('viewport'));
sync();rebuild();frame();let last=performance.now(),frames=0,start=last;
renderer.setAnimationLoop(()=>{const now=performance.now(),dt=(now-last)/1000;last=now;controls.autoRotate=input('rotate').checked;controls.update(Math.min(dt,.1));renderScene();frames++;if(now-start>700){$('live').textContent=`${Math.round(frames*1000/(now-start))} FPS · ${renderer.info.render.calls} вызовов · ${renderer.info.render.triangles.toLocaleString('ru')} трис / кадр`;frames=0;start=now;}});


function renderScene(){
  const size=renderer.getSize(new T.Vector2());
  if(!input('inspect').checked){renderer.setScissorTest(false);renderer.setViewport(0,0,size.x,size.y);renderer.render(scene,camera);return;}
  const d=catalog[kind],vw=Math.floor(size.x/2),vh=Math.floor(size.y/2);
  inspectionCamera.aspect=vw/vh;inspectionCamera.updateProjectionMatrix();
  const target=new T.Vector3(0,d.height*.48,0),distance=d.length*1.65*Math.max(1,.95/inspectionCamera.aspect);
  const dirs=[[.85,.33,-1],[.85,.33,1],[-.85,.33,-1],[-.85,.33,1]];
  renderer.info.autoReset=false;renderer.info.reset();renderer.setScissorTest(true);
  dirs.forEach((dir,i)=>{
    const x=(i%2)*vw,y=i<2?vh:0;
    renderer.setViewport(x,y,vw,vh);renderer.setScissor(x,y,vw,vh);
    inspectionCamera.position.copy(target).add(new T.Vector3(...dir).normalize().multiplyScalar(distance));inspectionCamera.lookAt(target);
    renderer.render(scene,inspectionCamera);
  });
  renderer.setScissorTest(false);renderer.setViewport(0,0,size.x,size.y);renderer.info.autoReset=true;
}
