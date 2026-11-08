import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';
import { PorscheInstruments } from './porscheCockpit';
import type { PlayerCar } from '../../sim/vehicle';
import { Indicators, type CarParts, type ModelLoad } from './index';
import { cloneInSlices } from './clone';

export const PORSCHE_PAINT = 0xfee1f9;
export const PORSCHE_NAME = 'Porsche 911 GT3 RS · IRL Spec 10';
let source: THREE.Group | null = null;
let pending: Promise<THREE.Group> | null = null;
export const porscheReady = (): boolean => source !== null;

export function loadPorsche(report: (state: ModelLoad) => void): Promise<THREE.Group> {
  if (source) return Promise.resolve(source);
  if (pending) return pending;
  const state: ModelLoad = { name: PORSCHE_NAME, loaded: 0, total: 1, unpacking: false, done: false, failed: false };
  report(state);
  pending = new Promise<THREE.Group>((resolve,reject) => {
    const loader = new GLTFLoader();loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load('/models/porsche-911-irl10.glb?v=irl10-opt4', gltf => {
      source = gltf.scene;
      const materials=new Set<THREE.MeshStandardMaterial>();
      source.traverse(o=>{const mat=(o as THREE.Mesh).material;for(const m of Array.isArray(mat)?mat:mat?[mat]:[]){m.userData.shared=true;materials.add(m as THREE.MeshStandardMaterial);}});
      const symbols=[...materials].find(m=>m.name==='TwiXeR_992_inttex_web')?.map;
      for(const mat of materials){
        // Several mod materials use a grey bump image as their albedo. Restore the preset's black
        // leather/plastic, retaining its normal/colour texture detail instead of a silver dashboard.
        if(/leather/i.test(mat.name)){mat.color.setRGB(.016,.017,.018);mat.metalness=0;mat.roughness=.76;}
        if(/ID01_plastic_lgl_010101FF/.test(mat.name)){mat.color.setRGB(.022,.024,.026);mat.metalness=.12;mat.roughness=.6;}
        if(mat.name==='TwiXeR_992_Interior_D_web'){mat.color.setRGB(.35,.35,.35);mat.metalness=.12;mat.roughness=.52;}
        if(symbols&&/TwiXeR_992_symbols_[56]_web/.test(mat.name)){mat.map=symbols;mat.color.setRGB(.8,.8,.8);mat.metalness=0;}
      }
      report({...state,loaded:state.total,unpacking:false,done:true});resolve(source);
    }, event => {
      state.loaded=event.loaded;
      state.total=event.lengthComputable&&event.total>0?Math.max(event.total,event.loaded):Math.max(state.total,event.loaded+1);
      state.unpacking=event.lengthComputable&&event.loaded>=event.total;report({...state});
    }, error => { pending=null;report({...state,failed:true});reject(error); });
  });
  return pending;
}

/** The BeamNG configuration is baked once; runtime keeps only four wheels and the steering prop animated. */
export function buildPorsche(paint: number, own: boolean, full: boolean, report: (state:ModelLoad)=>void): CarParts {
  const body=new THREE.Group(),wheelRoot=new THREE.Group(),indicators=new Indicators();
  const tail=new THREE.MeshBasicMaterial();
  const painted=new Set<THREE.MeshStandardMaterial>();
  let disposed=false;
  let inCockpit=false;
  const cockpitHidden:THREE.Object3D[]=[];
  const cockpitSurfaces:{mesh:THREE.Mesh;original:THREE.Material|THREE.Material[];inside:THREE.Material|THREE.Material[]}[]=[];
  const simpleMaterials=new Map<THREE.Material,THREE.MeshLambertMaterial>();
  const copies=new Map<THREE.Material,THREE.Material>();
  const applyCockpit=()=>{
    for(const node of cockpitHidden)node.visible=!inCockpit;
    for(const surface of cockpitSurfaces)surface.mesh.material=inCockpit?surface.inside:surface.original;
  };
  const wheelNodes: {pivot:THREE.Group;spin:THREE.Group;front:boolean}[]=[];
  let steering:THREE.Object3D|undefined;
  const steerRest=new THREE.Quaternion();
  const instruments=own&&full&&typeof document!=='undefined'?new PorscheInstruments():null;
  const cockpit=instruments?{
    group:instruments.group,eye:new THREE.Object3D(),
    update(car:PlayerCar,dt:number){instruments.update(car,dt,steering,steerRest);},
  }:null;
  if(cockpit){cockpit.eye.position.set(-.35,1.04,.12);body.add(cockpit.eye,cockpit.group);}
  const ready=full?loadPorsche(report).then(async model=>{
    if(disposed)return;
    const imported=own?model.clone(true):await cloneInSlices(model,()=>disposed);
    if(!imported||disposed)return;
    imported.traverse(o=>{
      if(own&&['exterior-detail','window-glass','stock-gauges'].includes(o.userData.porscheVisibility))cockpitHidden.push(o);
      const mesh=o as THREE.Mesh;if(!mesh.isMesh)return;
      const mats=Array.isArray(mesh.material)?mesh.material:[mesh.material];
      const next=mats.map(mat=>{
        const isPaint=mat.name.startsWith('Porsche_BodyPaint'),isSignal=/signal_[LR]/i.test(mat.name),isTail=/brakelight|taillight_running/i.test(mat.name),isHead=/headlight_high|headlight_1/i.test(mat.name);
        let copy=mat;
        if(own||isPaint||isSignal||isTail){
          copy=copies.get(mat)!;
          if(!copy){copy=mat.clone();delete copy.userData.shared;copies.set(mat,copy);}
        }
        const finish=copy as THREE.MeshStandardMaterial;
        if(instruments&&mat.name.startsWith('TwiXeR_992_gps_screen')){
          finish.map=instruments.pcm;finish.emissiveMap=instruments.pcm;
          finish.color.setRGB(.5,.5,.5);finish.emissive.setRGB(.5,.5,.5);finish.roughness=.45;
        }
        if(isPaint){finish.color.setHex(paint);painted.add(finish);}
        if(isSignal&&!finish.userData.porscheSignal){
          finish.userData.porscheSignal=true;
          indicators.add(finish,/_L/i.test(mat.name)?-1:1,new THREE.Color(.015,.008,.002),new THREE.Color(5,1.8,.03));
        }
        if(isTail&&!finish.userData.porscheSignal){finish.userData.porscheSignal=true;indicators.add(finish,0,new THREE.Color(.8,.015,.008),new THREE.Color(4,.06,.025));}
        if(isHead){finish.emissive.setRGB(2,1.9,1.7);finish.emissiveIntensity=1;}
        if(finish.transparent){finish.depthWrite=false;finish.forceSinglePass=true;}
        return copy;
      });
      mesh.material=Array.isArray(mesh.material)?next:next[0];
      if(own){
        let heroSurface=false;
        for(let node:THREE.Object3D|null=mesh;node;node=node.parent)if(node.name==='SteeringWheel'){heroSurface=true;break;}
        const inside=next.map(mat=>{
          // The matte cockpit does not need clearcoat, environment reflections or normal-map sampling.
          // Restore its original PBR materials outside, including every exterior close-up.
          if(heroSurface||/upper_leather|dashstructurebezels/.test(mat.name)||!/leather|carpet|roof_alc|rubbertrim|plastic|stitch|SV_SKIN/i.test(mat.name))return mat;
          let cheap=simpleMaterials.get(mat);
          if(!cheap){
            const original=mat as THREE.MeshStandardMaterial;
             cheap=new THREE.MeshLambertMaterial({name:mat.name+'_cockpit',color:original.color,map:original.map,side:original.side,transparent:original.transparent,opacity:original.opacity,depthWrite:original.depthWrite});
             // The source rubber uses a grey PBR base. Without its PBR maps it became a bright,
             // protruding-looking instrument surround; keep the cockpit's recess matte black.
             if(/rubbertrim/i.test(mat.name))cheap.color.setRGB(.016,.017,.018);
            cheap.emissive.setRGB(.004,.0045,.005);
            simpleMaterials.set(mat,cheap);
          }
          return cheap;
        });
        if(inside.some((m,i)=>m!==next[i]))cockpitSurfaces.push({mesh,original:mesh.material,inside:Array.isArray(mesh.material)?inside:inside[0]});
      }
    });
    imported.updateMatrixWorld(true);
    // Move assemblies before attaching the model to the moving vehicle, so coordinates stay local.
    const detachedWheels=new THREE.Group();
    for(const name of ['Wheel_FL','Wheel_FR','Wheel_RL','Wheel_RR']){
      const node=imported.getObjectByName(name);if(!node)continue;
      const pivot=new THREE.Group(),spin=new THREE.Group();
      pivot.position.copy(node.getWorldPosition(new THREE.Vector3()));
      detachedWheels.add(pivot);pivot.add(spin);detachedWheels.updateMatrixWorld(true);spin.attach(node);
      for(const child of [...node.children])if(child.name.includes('Caliper'))pivot.attach(child);
      wheelNodes.push({pivot,spin,front:name.includes('_F')});
    }
    steering=imported.getObjectByName('SteeringWheel');
    if(steering){
      // Seat-side column adjustment: leave a clear line of sight through the rim to the binnacle.
      steering.position.y-=.055;
      steerRest.copy(steering.quaternion);
    }
    body.add(imported);wheelRoot.add(detachedWheels);
    applyCockpit();
  }).catch(()=>{/* The loading screen offers retry; keep the rest of the scene alive. */}):Promise.resolve();
  return {
    ready,
    dispose(){disposed=true;instruments?.dispose();tail.dispose();for(const material of copies.values())material.dispose();for(const material of simpleMaterials.values())material.dispose();},
    setCockpit(on){inCockpit=on;applyCockpit();},
    body,wheelRoot,tail,tailIdle:new THREE.Color(.8,.015,.008),tailBrake:new THREE.Color(4,.06,.025),indicators,cockpit,
    lamp:new THREE.Vector3(0,.67,-2.04),lampX:.68,
    wheels:{update(steer,spin){for(const wheel of wheelNodes){wheel.pivot.rotation.y=wheel.front?-steer:0;wheel.spin.rotation.x=-spin;}}},
    setPaint(color){paint=color;for(const material of painted)material.color.setHex(color);},
  };
}
