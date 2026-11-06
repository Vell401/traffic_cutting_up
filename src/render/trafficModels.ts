import * as T from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const catalog = {
  sedan: { title: '01 / Седан', length: 4.75, width: 1.82, height: 1.38, wheel: .33, front: 1.45, rear: -1.4, cabinFront: .82, cabinRear: -1.48, roofFront: .18, roofRear: -.87 },
  hatch: { title: '02 / Хэтчбек', length: 4.2, width: 1.78, height: 1.43, wheel: .32, front: 1.3, rear: -1.3, cabinFront: .83, cabinRear: -1.88, roofFront: .22, roofRear: -1.12 },
  suv: { title: '03 / Кроссовер', length: 4.7, width: 1.9, height: 1.74, wheel: .38, front: 1.45, rear: -1.45, cabinFront: 1.0, cabinRear: -2.14, roofFront: .38, roofRear: -1.88 },
  minivan: { title: '04 / Минивэн', length: 4.85, width: 1.85, height: 1.86, wheel: .34, front: 1.55, rear: -1.5, cabinFront: 1.58, cabinRear: -2.23, roofFront: .77, roofRear: -2.06 },
  boxTruck: { title: '05 / Фургон', length: 8.2, width: 2.35, height: 3.5, wheel: .5, front: 3.35, rear: -2.6, cabinFront: 4, cabinRear: 2.1, roofFront: 3.7, roofRear: 2.15 },
  semi: { title: '06 / Тягач', length: 14.5, width: 2.5, height: 4, wheel: .52, front: 6.2, rear: -5.6, cabinFront: 7.15, cabinRear: 4.65, roofFront: 6.7, roofRear: 4.7 },
  sedanClassic: { title: '07 / Седан Classic', length: 4.75, width: 1.82, height: 1.46, wheel: .32, front: 1.45, rear: -1.4, cabinFront: .92, cabinRear: -1.35, roofFront: .4, roofRear: -.94 },
  sedanModern: { title: '08 / Седан Modern', length: 4.75, width: 1.82, height: 1.4, wheel: .35, front: 1.45, rear: -1.4, cabinFront: 1.08, cabinRear: -1.73, roofFront: .33, roofRear: -.72 },
} as const;
export type Kind = keyof typeof catalog;
export type LOD = 0 | 1 | 2;
export interface Settings { color: string; cargoColor: string; height: number; wheelScale: number; roughness: number; metalness: number }
export const defaults: Settings = { color: '#168bd8', cargoColor: '#d5dce3', height: 1, wheelScale: 1, roughness: .42, metalness: .15 };
export const palette: Record<Kind,string> = { sedan:'#168bd8',hatch:'#f17928',suv:'#647b64',minivan:'#b3bfcf',boxTruck:'#e5c766',semi:'#cb5145',sedanClassic:'#8b4042',sedanModern:'#64758c' };
export interface Model { parts: T.BufferGeometry[]; axles: { f: number; r: number }[]; triangles: number; bytes: number }
type V = [number,number,number];
const mix = T.MathUtils.lerp;
const point = (x:number,y:number,f:number): V => [x,y,-f];

/** Metres; -Z forward. Sculpted, faceted surfaces, three indexed material batches. */
export function buildModel(kind: Kind, lod: LOD = 0, settings: Settings = defaults): Model {
  const d=catalog[kind],truck=kind==='boxTruck'||kind==='semi',suv=kind==='suv',van=kind==='minivan';
  const half=d.length/2,w=truck?d.width-.18:d.width, hw=w/2;
  const r=d.wheel*settings.wheelScale, seg=[16,12,8][lod];
  const belt=truck?(kind==='semi'?1.84:1.61):suv?1.08:van?1.03:.88;
  const roof=truck?(kind==='semi'?3.08:2.57):d.height;
  const back=truck?d.cabinRear:-half, bottom=truck?.48:suv?.32:.23;
  const axles: {f:number;r:number}[]=[{f:d.front,r},{f:d.rear,r}];
  if(kind==='semi')axles.push({f:3.7,r},{f:2.55,r},{f:-4.45,r},{f:-6.65,r});
  const buckets:T.BufferGeometry[][]=[[],[],[]];
  const surfaces = [0,1,2].map(()=>({p:[] as number[],c:[] as number[],role:[] as number[]}));
  // Semantic vertex roles survive merging: cargo=1 in neutral; head=1, tail=2,
  // left/right indicator=3/4 in lights. The game animates these without extra draws.
  const roleAt=(b:number,c:string,x:number,role:number)=>b!==2?role:c==='#cfebff'?1:c==='#ffa931'?(x<0?3:4):2;
  function face(verts:V[],out:V,b=0,color='#ffffff',lower?:string,role=0) {
    const a=new T.Vector3(...verts[0]),n=new T.Vector3();
    for(let j=1;j<verts.length-1;j++){n.copy(new T.Vector3(...verts[j]).sub(a).cross(new T.Vector3(...verts[j+1]).sub(a)));if(n.lengthSq()>1e-14)break;}
    const order=n.dot(new T.Vector3(...out))<0?[...verts].reverse():verts;
    const col=new T.Color(color),lo=lower?new T.Color(lower):col;
    for(let j=1;j<order.length-1;j++) {
      const tri=[order[0],order[j],order[j+1]];
      const cross=new T.Vector3(...tri[1]).sub(new T.Vector3(...tri[0])).cross(new T.Vector3(...tri[2]).sub(new T.Vector3(...tri[0])));
      if(cross.lengthSq()<1e-14)continue;
      for(const v of tri){surfaces[b].p.push(...v);surfaces[b].role.push(roleAt(b,color,v[0],role));(lower?col.clone().lerp(lo,T.MathUtils.clamp((roof-v[1])/(roof-belt),0,1)):col).toArray(surfaces[b].c,surfaces[b].c.length);}
    }
  }
  function add(g:T.BufferGeometry,b:number,c='#ffffff') {
    g.deleteAttribute('uv');const col=new T.Color(c),a=new Float32Array(g.getAttribute('position').count*3);
    for(let i=0;i<a.length;i+=3)col.toArray(a,i);
    g.setAttribute('color',new T.BufferAttribute(a,3));
    g.setAttribute('partRole',new T.Float32BufferAttribute(Array.from({length:a.length/3},(_,i)=>roleAt(b,c,g.getAttribute('position').getX(i),0)),1));buckets[b].push(g);
  }
  function box(x:number,y:number,f:number,sx:number,sy:number,sz:number,b=1,c?:string) { add(new T.BoxGeometry(sx,sy,sz).translate(x,y,-f),b,c??(b===0?'#ffffff':'#1d2630')); }
  function rod(a:V,b:V,width:number,bucket=1,color='#26323e') {
    const av=new T.Vector3(...a),bv=new T.Vector3(...b),g=new T.BoxGeometry(width,av.distanceTo(bv),width);
    g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),bv.clone().sub(av).normalize()));g.translate(...av.add(bv).multiplyScalar(.5).toArray());add(g,bucket,color);
  }
  // Width, crown and crease heights are authored along the length, rather than extruding a slab.
  const bodyAxles=axles.filter(a=>a.f>back&&a.f<half);
  const widthAt=(f:number)=>hw*(1-.12*Math.pow(Math.abs((f-back)/(half-back)*2-1),5));
  const topAt=(f:number)=>belt-(f>d.cabinFront?.14*Math.pow((f-d.cabinFront)/(half-d.cabinFront),1.3):f<d.cabinRear?.035*(d.cabinRear-f)/(d.cabinRear-back||1):0);
  const arch=(f:number)=>Math.max(bottom,...bodyAxles.map(a=>Math.abs(f-a.f)<=r+.065+1e-8?r+Math.sqrt(Math.max(0,(r+.065)**2-(f-a.f)**2)):bottom));
  const stations=new Set<number>([back,back+.12,half-.15,half,d.cabinFront,d.cabinRear]);
  for(const a of bodyAxles){const ar=r+.065;stations.add(a.f-ar-.07);stations.add(a.f+ar+.07);for(let i=0;i<=([10,8,6][lod]);i++)stations.add(a.f+Math.cos(i/[10,8,6][lod]*Math.PI)*ar);}
  const fs=[...stations].filter(f=>f>=back&&f<=half).sort((a,b)=>a-b);
  const sidePoint=(f:number,y:number,side:number):V=>{
    const t=T.MathUtils.clamp((y-bottom)/(topAt(f)-bottom),0,1);
    const waist=t<.32?mix(.91,1,t/.32):t<.78?1:mix(1,.94,(t-.78)/.22);
    return point(side*widthAt(f)*waist,y,f);
  };
  const deck=(f:number,q:number):V=>point(widthAt(f)*.94*q,topAt(f)+(.035*(1-Math.abs(q)))+(Math.abs(q)>.57&&Math.abs(q)<.79?.035:0),f);
  const deckQs=lod===2?[-1,0,1]:[-1,-.78,-.58,0,.58,.78,1];
  const sideLevels=(f:number)=>{const low=arch(f),top=topAt(f);return [low,Math.min(top,low+.035),Math.max(low+.035,bottom+(top-bottom)*.32),Math.max(low+.035,bottom+(top-bottom)*.78),top].map(y=>Math.min(y,top)).sort((a,b)=>a-b);};
  for(let i=0;i<fs.length-1;i++) {
    const f0=fs[i],f1=fs[i+1];
    for(const side of [-1,1]) {
      const y0=sideLevels(f0),y1=sideLevels(f1);
      for(let j=0;j<y0.length-1;j++)face([sidePoint(f0,y0[j],side),sidePoint(f1,y1[j],side),sidePoint(f1,y1[j+1],side),sidePoint(f0,y0[j+1],side)],[side,0,0],j===0&&suv&&arch((f0+f1)/2)>bottom?1:0,j===0&&suv&&arch((f0+f1)/2)>bottom?'#2d343b':j===0?'#c2c9d2':'#ffffff');
    }
    const qs=deckQs;
    for(let j=0;j<qs.length-1;j++)face([deck(f0,qs[j]),deck(f1,qs[j]),deck(f1,qs[j+1]),deck(f0,qs[j+1])],[0,1,0]);
  }
  // Closed wheel tubs use exactly the shell's longitudinal samples and a shared inner wall.
  const innerX=hw-.34;
  for(let i=0;i<fs.length-1;i++) {
    const f0=fs[i],f1=fs[i+1];
    for(const side of [-1,1]) {
      const a=sidePoint(f0,arch(f0),side),b=sidePoint(f1,arch(f1),side);
      const ai:V=[side*innerX,a[1],a[2]],bi:V=[side*innerX,b[1],b[2]];
      face([a,b,bi,ai],[0,-1,0],1,'#161d26');
      face([point(side*innerX,bottom,f0),point(side*innerX,bottom,f1),bi,ai],[side,0,0],1,'#111923');
    }
    face([point(-innerX,bottom,f0),point(innerX,bottom,f0),point(innerX,bottom,f1),point(-innerX,bottom,f1)],[0,-1,0],1,'#111923');
  }
  for(const end of [-1,1]) {
    const f=end===1?half:back,ys=sideLevels(f);
    for(let j=0;j<ys.length-1;j++)face([sidePoint(f,ys[j],-1),sidePoint(f,ys[j],1),sidePoint(f,ys[j+1],1),sidePoint(f,ys[j+1],-1)],[0,0,-end],0,j===0?'#c2c9d2':'#ffffff');
    // Crown closes the upper edge of the fascia.
    for(let j=0;j<deckQs.length-1;j++){const a=deck(f,deckQs[j]),b=deck(f,deckQs[j+1]);face([[a[0],topAt(f),a[2]],[b[0],topAt(f),b[2]],b,a],[0,0,-end]);}
  }
  // Project body details onto the actual triangulated shell, not its analytic approximation.
  const projectionGeometry=new T.BufferGeometry();
  projectionGeometry.setAttribute('position',new T.Float32BufferAttribute([...surfaces[0].p,...surfaces[1].p],3));
  const projectionMaterial=new T.MeshBasicMaterial({side:T.DoubleSide});
  const projectionMesh=new T.Mesh(projectionGeometry,projectionMaterial);
  const ray=new T.Raycaster();
  function onBody(f:number,y:number,side:number,offset=.0025):V {
    ray.set(new T.Vector3(side*(hw+1),y,-f),new T.Vector3(-side,0,0));
    const hit=ray.intersectObject(projectionMesh,false)[0];
    if(!hit)throw new Error(`No body surface for ${kind}: f=${f}, y=${y}`);
    return [hit.point.x+side*offset,y,-f];
  }
  // A thin flat ribbon conforms to every facet; it cannot protrude like a box or a rod.
  function bodyLine(a:[number,number],b:[number,number],side:number,width=.008,color='#28303a') {
    const df=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(df,dy),steps=Math.max(1,Math.ceil(len/.035));
    const of=-dy/len*width/2,oy=df/len*width/2;
    for(let i=0;i<steps;i++){
      const f0=mix(a[0],b[0],i/steps),f1=mix(a[0],b[0],(i+1)/steps),y0=mix(a[1],b[1],i/steps),y1=mix(a[1],b[1],(i+1)/steps);
      face([onBody(f0-of,y0-oy,side),onBody(f1-of,y1-oy,side),onBody(f1+of,y1+oy,side),onBody(f0+of,y0+oy,side)],[side,0,0],1,color);
    }
  }
  // Greenhouse is a painted shell with inset window polygons; pillars belong to the shell.
  const bx=hw*.88,tx=hw*(van?.75:suv?.73:.72),rail=roof-.045;
  const frontLower=[point(-bx,deck(d.cabinFront,bx/(widthAt(d.cabinFront)*.94))[1],d.cabinFront),point(bx,deck(d.cabinFront,bx/(widthAt(d.cabinFront)*.94))[1],d.cabinFront)];
  const rearLower=[point(-bx,deck(d.cabinRear,bx/(widthAt(d.cabinRear)*.94))[1],d.cabinRear),point(bx,deck(d.cabinRear,bx/(widthAt(d.cabinRear)*.94))[1],d.cabinRear)];
  const frontUpper=[point(-tx,rail,d.roofFront),point(tx,rail,d.roofFront)];
  const rearUpper=[point(-tx,rail,d.roofRear),point(tx,rail,d.roofRear)];
  function bilinear(q:V[],u:number,v:number,offset:V=[0,0,0]):V {return [0,1,2].map(k=>mix(mix(q[0][k],q[1][k],u),mix(q[3][k],q[2][k],u),v)+offset[k]) as V;}
  function glazed(q:V[],out:V,panes:number[][]) {
    face(q,out);
    for(const [u0,u1,v0,v1] of panes) {
      const off=out.map(x=>x*.004) as V;
      const pane=[bilinear(q,u0,v0,off),bilinear(q,u1,v0,off),bilinear(q,u1,v1,off),bilinear(q,u0,v1,off)];
      face(pane,out,1,'#17222e','#35495a');
      if(lod===0)for(let i=0;i<4;i++)rod(pane[i],pane[(i+1)%4],.012,1,'#111a23');
    }
  }
  glazed([frontLower[0],frontLower[1],frontUpper[1],frontUpper[0]],[0,.5,-1],[[.065,.935,.12,.9]]);
  glazed([rearLower[1],rearLower[0],rearUpper[0],rearUpper[1]],[0,.4,1],[[.09,.91,.12,.89]]);
  for(const side of [-1,1]) {
    const si=side===1?1:0,q=[frontLower[si],rearLower[si],rearUpper[si],frontUpper[si]];
    const panes=truck?[[.08,.83,.1,.9]]:van||suv?[[.045,.43,.09,.9],[.465,.72,.09,.9],[.75,.92,.09,.9]]:[[.04,.50,.08,.91],[.54,.88,.08,.91]];
    glazed(q,[side,.1,0],panes);
    if(lod<2) {
      // Mirror sail is seated on the front lower corner of the side window frame.
      const anchor=bilinear(q,.025,.12,[side*.009,0,0]);
      const mirrorF=-anchor[2],mx=side*(hw+.075),my=anchor[1]+.018;
      const sail=[bilinear(q,.005,.025,[side*.008,0,0]),bilinear(q,.095,.025,[side*.008,0,0]),bilinear(q,.005,.30,[side*.008,0,0])];
      face(sail,[side,0,0],1,'#202a36');
      rod(anchor,point(mx-side*.025,my,mirrorF),.05,1,'#202a36');
      box(mx,my,mirrorF,.15,.095,.19,0,'#d4e0ed');
      box(mx,my,mirrorF-.099,.115,.06,.008,1,'#657e92');

      // Handle positions follow the door layout; door outlines are intentionally omitted.
      const split=mix(d.cabinFront,d.cabinRear,suv||van?.445:.52);
      const rearEdge=d.rear+r+.16;
      const doors:[number,number][] = truck ? [[d.cabinRear+.10,d.cabinFront-.12]]
        : kind==='hatch' ? [[split,d.cabinFront-.06]]
        : [[split,d.cabinFront-.06],[rearEdge,split]];
      for(const [rear,front] of doors){
        const handleF=van&&rear===rearEdge?front-.19:rear+.19;
        bodyLine([handleF-.065,belt-.12],[handleF+.065,belt-.12],side,.032,'#1c2631');
      }
      if(van&&lod===0){
        // Sliding track follows the body continuously, instead of cutting through the side panel.
        bodyLine([d.cabinRear+.17,belt-.20],[split-.12,belt-.20],side,.014,'#53606c');
      }

    }
  }
  // Crown across the roof, with a bevel at each rail. No floating roof slab.
  const roofQs=[-1,-.84,0,.84,1];
  for(let i=0;i<roofQs.length-1;i++) {
    const p=(q:number,f:number):V=>point(tx*q,rail+.045*(1-Math.abs(q)**3),f);
    face([p(roofQs[i],d.roofFront),p(roofQs[i+1],d.roofFront),p(roofQs[i+1],d.roofRear),p(roofQs[i],d.roofRear)],[0,1,0]);
  }
  // Close the crowned roof edge against the straight windscreen rails.
  for(const [f,dir] of [[d.roofFront,-1],[d.roofRear,1]])for(let i=0;i<roofQs.length-1;i++) {
    const a=roofQs[i],b=roofQs[i+1];
    face([point(tx*a,rail,f),point(tx*b,rail,f),point(tx*b,rail+.045*(1-Math.abs(b)**3),f),point(tx*a,rail+.045*(1-Math.abs(a)**3),f)],[0,0,dir]);
  }
  // Chamfered tyres, annular rim lips and broad five-spoke alloy wheels.
  for(const axle of axles)for(const side of [-1,1]) {
    const ww=truck?.34:.235,cx=side*(d.width/2-ww/2-.022),f=axle.f;
    const ring=(x:number,rad:number,i:number):V=>point(cx+side*x,r+Math.cos(i/seg*Math.PI*2)*rad,f+Math.sin(i/seg*Math.PI*2)*rad);
    const rings=[[ -ww/2,r*.86],[-ww*.32,r],[ww*.29,r],[ww/2,r*.87],[ww/2+.004,r*.66]];
    for(let k=0;k<rings.length-1;k++)for(let i=0;i<seg;i++) {
      const [x0,r0]=rings[k],[x1,r1]=rings[k+1],theta=(i+.5)/seg*Math.PI*2;
      face([ring(x0,r0,i),ring(x0,r0,i+1),ring(x1,r1,i+1),ring(x1,r1,i)],[k===3?side:0,Math.cos(theta),-Math.sin(theta)],1,k===1?'#181e28':'#2b3240');
    }
    const outer=ww/2+.009;
    for(let i=0;i<seg;i++)face([ring(outer,r*.67,i),ring(outer,r*.67,i+1),ring(outer+.008,r*.53,i+1),ring(outer+.008,r*.53,i)],[side,0,0],1,'#b9c7d8');
    add(new T.CylinderGeometry(r*.53,r*.53,.016,seg).rotateZ(Math.PI/2).translate(cx+side*(outer-.015),r,-f),1,'#252e3b');
    if(lod<2) {
      const spokeCount=truck?8:kind==='sedanClassic'?12:kind==='sedanModern'?7:5;
      for(let j=0;j<spokeCount;j++) {
        const theta=j/spokeCount*Math.PI*2;
        const sp=(rad:number,angle:number):V=>point(cx+side*(outer+.015),r+Math.cos(theta+angle)*rad,f+Math.sin(theta+angle)*rad);
        face([sp(r*.17,-.32),sp(r*.17,.32),sp(r*.57,.14),sp(r*.57,-.14)],[side,0,0],1,j%2?'#b8c5d7':'#e1e8ee');
      }
      add(new T.CylinderGeometry(r*.19,r*.19,.026,8).rotateZ(Math.PI/2).translate(cx+side*(outer+.02),r,-f),1,'#8f9caf');
    }
  }
  function fasciaRect(x0:number,x1:number,y0:number,y1:number,f:number,b:number,c:string,slant=0) {
    face([point(x0,y0,f),point(x1,y0,f),point(x1-slant,y1,f),point(x0+slant,y1,f)],[0,0,f>0?-1:1],b,c);
  }
  // Facias use inset planar optics, splitters and shaped intakes instead of stuck-on blocks.
  for(const end of [-1,1]) {
    const f=end*half+end*.013,fw=(truck?d.width:w)*.5*.88,y=truck?1.03:topAt(end===1?half:back)-.075;
    if(!(end===-1&&(suv||van)))fasciaRect(-fw*.94,fw*.94,y-.15,y+.015,f,1,'#202b38',.025);
    if(end===1) {
      for(const side of [-1,1]) {
        const lo=side<0?-fw*.9:fw*.38,hi=side<0?-fw*.38:fw*.9;
        fasciaRect(lo,hi,y-(kind==='sedanModern'?.055:.112),y-.006,f+end*.003,2,'#cfebff',.014);
        fasciaRect(side<0?lo:hi-.045,side<0?lo+.045:hi,y-.112,y-.006,f+.006,2,'#ffa931');
      }
      fasciaRect(-fw*.42,fw*.42,bottom+.07,bottom+.24,f+.006,1,'#121b27',-.045);
      if(lod<2)for(const side of [-1,1])fasciaRect(side*fw*.73-.105,side*fw*.73+.105,bottom+.08,bottom+.18,f+.006,1,'#293547',.02);
    } else if(kind==='sedan'&&lod<2) {
      for(const side of [-1,1])for(const x of [.50,.72])add(new T.CylinderGeometry(.066,.066,.014,10).rotateX(Math.PI/2).translate(side*fw*x,y-.06,-f),2,'#f53b40');
    } else if(!suv&&!van) {
      for(const side of [-1,1])fasciaRect(side<0?-fw*.93:fw*.4,side<0?-fw*.4:fw*.93,y-.11,y-.01,f-.004,2,'#f33b35',.012);
    }
    if(end===-1&&!suv&&!van)for(const side of [-1,1])fasciaRect(side<0?-fw*.94:fw*.84,side<0?-fw*.84:fw*.94,y-.11,y-.01,f-.008,2,'#ffa931');
    if(!truck||end===-1)fasciaRect(-.21,.21,end===1?bottom+.28:bottom+.18,end===1?bottom+.36:bottom+.29,f+end*.008,1,'#c7d4de');
    if(lod<2)box(0,bottom+.025,end*half-end*.03,fw*1.94,.045,.12,1,'#283342');
  }
  if(kind==='sedanClassic') {
    fasciaRect(-.24,.24,belt-.23,belt-.09,half+.025,1,'#aab4c0');
    fasciaRect(-.20,.20,belt-.215,belt-.105,half+.028,1,'#17212c');
    if(lod<2)for(const x of [-.14,-.07,0,.07,.14])box(x,belt-.16,half+.032,.012,.1,.012,1,'#aab4c0');
  }
  if(kind==='sedanModern')fasciaRect(-.5,.5,bottom+.075,bottom+.28,half+.025,1,'#17212c',.12);
  if(lod<2&&!truck){
    if(kind==='sedan') {
      const f=-half+.29,y=belt+.18;
      for(const side of [-1,1]){const x=side*hw*.64,base=deck(f,x/(widthAt(f)*.94))[1];box(x,(base+y)/2,f,.065,y-base+.025,.12,0);}
      // Closed wing with thickness and end caps; no disconnected single-sided blades.
      box(0,y+.025,f,hw*1.8,.055,.28,0);
    }
    if(kind==='hatch')box(0,rail+.01,d.roofRear+.015,tx*2.04,.065,.19,0);
    if(suv)for(const side of [-1,1]) {
      const x=side*tx*.84,base=rail+.045*(1-.84**3),y=base+.07;
      const f0=d.roofRear+.18,f1=d.roofFront-.18;
      rod(point(x,y,f0),point(x,y,f1),.045,1,'#3b4654');
      for(const f of [f0,f1])box(x,base+.026,f,.07,.072,.13,1,'#3b4654');
    }
    // Hollow exhaust tips on near LOD.
    if(lod===0)for(const x of kind==='sedan'?[-hw*.65,hw*.65]:[-hw*.65]) {
      add(new T.CylinderGeometry(.045,.045,.15,8,1,true).rotateX(Math.PI/2).translate(x,bottom+.04,half+.025),1,'#8c9dae');
      add(new T.CircleGeometry(.034,8).translate(x,bottom+.04,half+.102),1,'#101824');
    }
  }
  // Rear lamps are inset into the sloped rear pillars, following their surface.
  if(suv||van){
    const rear=[rearLower[1],rearLower[0],rearUpper[0],rearUpper[1]];
    for(const [u0,u1] of [[.012,.077],[.923,.988]]) {
      const q=[bilinear(rear,u0,.04,[0,0,.007]),bilinear(rear,u1,.04,[0,0,.007]),bilinear(rear,u1,.77,[0,0,.007]),bilinear(rear,u0,.77,[0,0,.007])];
      face(q,[0,.4,1],2,'#ef3535');
      face([bilinear(rear,u0,.04,[0,0,.009]),bilinear(rear,u1,.04,[0,0,.009]),bilinear(rear,u1,.18,[0,0,.009]),bilinear(rear,u0,.18,[0,0,.009])],[0,.4,1],2,'#ffa931');
    }
  }

  if(truck){
    const cf=kind==='semi'?4.35:1.93,cb=-half,cy=kind==='semi'?1.2:1;
    box(0,.66,(cb+d.cabinRear)/2,1.4,.24,d.cabinRear-cb);
    // Chamfered cargo corners, one neutral batch, optional ribs only at near LOD.
    const x=d.width/2,b=.06,z0=-cf,z1=-cb,y0=cy,y1=d.height;
    const ring:V[]=[[-x+b,y0,z0],[x-b,y0,z0],[x,y0+b,z0],[x,y1-b,z0],[x-b,y1,z0],[-x+b,y1,z0],[-x,y1-b,z0],[-x,y0+b,z0]];
    for(let i=0;i<8;i++) {const a=ring[i],bb=ring[(i+1)%8];face([a,bb,[bb[0],bb[1],z1],[a[0],a[1],z1]],[a[0]+bb[0],(a[1]+bb[1])/2-(cy+d.height)/2,0],1,settings.cargoColor,undefined,1);}
    face(ring,[0,0,-1],1,settings.cargoColor,undefined,1);face(ring.map(p=>[p[0],p[1],z1] as V),[0,0,1],1,settings.cargoColor,undefined,1);
    for(const side of [-1,1]) {
      for(const y of [cy+.06,d.height-.07])box(side*x,y,(cf+cb)/2,.025,.045,cf-cb-.1,1,'#9ca9b8');
      if(lod===0)for(let f=cb+.4;f<cf;f+=.85)box(side*(x+.012),(cy+d.height)/2,f,.015,d.height-cy-.18,.018,1,'#aab6c5');
      if(lod<2){const guardBack=(kind==='semi'?-4.45:d.rear)+r+.22,guardFront=(kind==='semi'?2.55:d.front)-r-.22;box(side*(x-.10),.64,(guardFront+guardBack)/2,.07,.1,guardFront-guardBack,1,'#738498');box(side*.5,(cy+d.height)/2,cb-.027,.026,d.height-cy-.23,.025,1,'#8795a6');}
      if(kind==='semi'&&lod<2){box(side*.82,.87,3.25,.28,.34,1.4,1,'#9eacbc');box(side*(hw+.1),2.08,half-.38,.18,.42,.14);}
    }
    box(0,(cy+d.height)/2,cb-.012,.018,d.height-cy,.018,1,'#637181');
    if(lod<2)box(0,.37,cb+.04,d.width*.86,.1,.14,1,'#728194');
  }
  projectionGeometry.dispose();projectionMaterial.dispose();
  const parts=buckets.map((gs,b)=>{
    const surface=new T.BufferGeometry();surface.setAttribute('position',new T.Float32BufferAttribute(surfaces[b].p,3));surface.setAttribute('color',new T.Float32BufferAttribute(surfaces[b].c,3));surface.setAttribute('partRole',new T.Float32BufferAttribute(surfaces[b].role,1));surface.computeVertexNormals();gs.push(surface);
    const flat=gs.map(g=>g.index?g.toNonIndexed():g),merged=mergeGeometries(flat)!;
    const indexed=mergeVertices(merged,.00001);merged.dispose();flat.forEach(g=>g.dispose());gs.forEach(g=>g.dispose());
    indexed.scale(1,settings.height,1);indexed.computeBoundingBox();indexed.computeBoundingSphere();return indexed;
  });
  return {parts,axles,triangles:parts.reduce((s,g)=>s+g.index!.count/3,0),bytes:parts.reduce((s,g)=>s+Object.values(g.attributes).reduce((n,a)=>n+a.array.byteLength,0)+(g.index?.array.byteLength??0),0)};
}
