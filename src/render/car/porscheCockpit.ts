import * as THREE from 'three';
import { clamp, damp } from '../../core/math';
import type { PlayerCar } from '../../sim/vehicle';

// The imported prop's shaft is LOCAL Y. Rotating local Z makes the rim tumble.
export const PORSCHE_STEERING_AXIS = new THREE.Vector3(0, 1, 0);
export function porscheSteeringAngle(roadWheelAngle: number): number {
  if(roadWheelAngle===0)return 0;
  // Right input is positive in the simulation; viewed from the seat it must turn clockwise.
  return -clamp(roadWheelAngle * 12.6, -Math.PI * 1.8, Math.PI * 1.8);
}

const WHITE = '#edf0e9', MUTED = '#8b928f', RED = '#ef4135', GREEN = '#b9d446';
const FONT = 'Arial, sans-serif';
const START = Math.PI * .75, SWEEP = Math.PI * 1.5;
function text(g: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, color = WHITE, weight = '400'): void {
  g.fillStyle = color; g.font = `${weight} ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(value, x, y);
}
function line(g: CanvasRenderingContext2D, x: number, y: number, xx: number, yy: number, color: string, width: number): void {
  g.strokeStyle = color; g.lineWidth = width; g.beginPath(); g.moveTo(x,y); g.lineTo(xx,yy); g.stroke();
}
function dial(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const face = g.createRadialGradient(x,y,0,x,y,r);face.addColorStop(0,'#151918');face.addColorStop(.84,'#080b0b');face.addColorStop(1,'#1d2424');
  g.fillStyle=face;g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fill();
  g.strokeStyle='#606765';g.lineWidth=2.4;g.stroke();
  g.beginPath();g.arc(x,y,r-5,0,Math.PI*2);g.strokeStyle='#292f2f';g.lineWidth=3;g.stroke();
}
function scale(g: CanvasRenderingContext2D, x: number, y: number, r: number, max: number, major: number, minor: number, redFrom = Infinity): void {
  for(let v=0;v<=max+.00001;v+=minor){
    const a=START+SWEEP*v/max,isMajor=Math.abs(v/major-Math.round(v/major))<.001;
    const c=v>=redFrom?RED:WHITE;
    line(g,x+Math.cos(a)*(r-12),y+Math.sin(a)*(r-12),x+Math.cos(a)*(r-(isMajor?31:21)),y+Math.sin(a)*(r-(isMajor?31:21)),c,isMajor?3.5:1.5);
    if(isMajor)text(g,String(Math.round(v)),x+Math.cos(a)*(r-52),y+Math.sin(a)*(r-52),r*.13,c,'600');
  }
}
/** Drawn once. Only the tiny readout atlas and a few needle vertices change afterwards. */
export function drawPorscheClusterBase(g: CanvasRenderingContext2D): void {
  // Only the five pods are solid: a rectangular black canvas protruded beyond the real binnacle.
  g.clearRect(0,0,2048,576);
  // A shaped dark backing covers the stock mounting recess without rectangular protruding corners.
  g.fillStyle='#050808';
  for(const [x,y,r] of [[167,282,166],[532,286,221],[1024,282,279],[1516,286,221],[1881,282,166]]){
    g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fill();
  }
  // Outer temperature/fuel pods, inner digital pods, oversized central tachometer.
  dial(g,167,282,157);dial(g,532,286,201);dial(g,1024,282,259);dial(g,1516,286,201);dial(g,1881,282,157);
  scale(g,1024,282,248,10,1,.2,9);
  text(g,'1/min × 1000',1024,171,21,MUTED);text(g,'GT3 RS',1024,211,30,WHITE,'700');
  // Digital speed sits in the lower part of the tach, as in the original Porsche cluster.
  g.fillStyle='#080c0c';g.fillRect(942,340,164,100);
  text(g,'km/h',1024,424,21,MUTED);
  g.fillStyle='#080c0c';g.fillRect(1120,346,58,90);
  scale(g,532,286,191,350,50,10);text(g,'km/h',532,370,21,MUTED);
  text(g,'SPORT',532,405,24,GREEN,'600');
  text(g,'VEHICLE',1516,180,21,MUTED);
  text(g,'OIL',1435,247,19,MUTED);
  text(g,'WATER',1435,306,18,MUTED);text(g,'90°',1562,306,36,WHITE,'600');
  line(g,1390,346,1642,346,'#343c38',2);
  text(g,'G-FORCE',1516,382,19,MUTED);
  text(g,'OIL PRESS.',167,203,20,MUTED);scale(g,167,282,148,5,1,.5);text(g,'bar',167,359,21,MUTED);
  text(g,'FUEL',1881,203,21,MUTED);scale(g,1881,282,148,1,.5,.1);text(g,'E              F',1881,363,20,MUTED);
}

/** PCM vehicle page: no giant speedometer competing with the driver's instruments. */
export function drawPorschePCM(g: CanvasRenderingContext2D): void {
  g.fillStyle='#101413';g.fillRect(0,0,1536,512);
  text(g,'PORSCHE',156,45,24,WHITE,'600');text(g,'VEHICLE',557,45,24);text(g,'TRIP',812,45,24,MUTED);text(g,'SETTINGS',1090,45,24,MUTED);
  line(g,45,81,1491,81,'#353c39',2);line(g,476,81,637,81,RED,4);
  text(g,'911 GT3 RS',350,144,38,WHITE,'600');text(g,'IRL SPEC 10',350,192,21,MUTED);
  // Restrained side profile, echoing the PCM vehicle-status page.
  g.strokeStyle='#aab2ad';g.lineWidth=3;g.beginPath();g.moveTo(90,331);g.lineTo(110,292);g.lineTo(199,277);g.bezierCurveTo(252,211,386,210,451,270);g.lineTo(534,290);g.lineTo(566,332);g.closePath();g.stroke();
  for(const x of [198,463]){g.fillStyle='#101413';g.beginPath();g.arc(x,329,37,0,Math.PI*2);g.fill();g.strokeStyle='#aab2ad';g.stroke();g.beginPath();g.arc(x,329,20,0,Math.PI*2);g.stroke();}
  line(g,103,267,157,267,WHITE,4);line(g,117,267,122,288,WHITE,3);
  text(g,'4.0  /  FLAT SIX',350,421,23,MUTED);
  line(g,675,118,675,456,'#353c39',2);
  for(const [i,label,value] of [[0,'DRIVE MODE','SPORT'],[1,'CHASSIS','SPORT'],[2,'TRACTION','PSM ON'],[3,'DRIVETRAIN','REAR-WHEEL DRIVE']] as const){
    text(g,label,874,150+i*79,19,MUTED);text(g,value,1234,150+i*79,26,i===0?RED:WHITE,'600');
  }
  text(g,'PDK  •  SPORT CHRONO',1135,468,19,MUTED);
}

export const PORSCHE_DASHBOARD_BUDGET={backgroundWidth:1024,backgroundHeight:288,pcmWidth:768,pcmHeight:256,readoutWidth:512,readoutHeight:128,readoutHz:12} as const;

export class PorscheInstruments {
  private rpmShown = 0;
  readonly group=new THREE.Group();
  readonly cluster: THREE.CanvasTexture;
  readonly pcm: THREE.CanvasTexture;
  readonly readouts: THREE.CanvasTexture;
  private readonly context:CanvasRenderingContext2D;
  private readonly moving:THREE.BufferGeometry;
  private readonly positions:THREE.BufferAttribute;
  private readonly colors:THREE.BufferAttribute;
  private readonly ledOffsets:number[]=[];
  private readonly color=new THREE.Color();
  private timer=1;private seconds=0;private km=0;private steeringAngle=0;private lastReadout='';private lastLights=-1;
  private readonly turn=new THREE.Quaternion();
  constructor(){
    const texture=(w:number,h:number)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.generateMipmaps=false;t.minFilter=THREE.LinearFilter;return {t,g:c.getContext('2d')!};};
    const budget=PORSCHE_DASHBOARD_BUDGET;
    const c=texture(budget.backgroundWidth,budget.backgroundHeight),p=texture(budget.pcmWidth,budget.pcmHeight),d=texture(budget.readoutWidth,budget.readoutHeight);
    this.cluster=c.t;this.pcm=p.t;this.readouts=d.t;this.context=d.g;this.pcm.flipY=false;
    c.g.scale(.5,.5);drawPorscheClusterBase(c.g);p.g.scale(.5,.5);drawPorschePCM(p.g);
    const face=new THREE.Group();face.position.set(-.3445,.820,-.416);face.rotation.x=-.10;this.group.add(face);
    const panel=new THREE.Mesh(new THREE.PlaneGeometry(.441,.124),new THREE.MeshBasicMaterial({map:this.cluster,toneMapped:false,transparent:true,alphaTest:.02}));
    panel.name='Porsche_Cached_Instrument_Cluster';face.add(panel);
    const positions:number[]=[],colors:number[]=[],uv:number[]=[];
    const vertex=(x:number,y:number,z:number,color:string)=>{positions.push((x/2048-.5)*.441,(.5-y/576)*.124,z);this.color.set(color);colors.push(this.color.r,this.color.g,this.color.b);};
    // Four needles, seven shift LEDs, two indicators and four hub caps share a single draw call.
    for(let i=0;i<12;i++)vertex(0,0,.00015,RED);
    for(let i=0;i<9;i++){
      this.ledOffsets.push(colors.length);
      if(i<7){const x=922+i*31;for(const [xx,yy]of [[x,55],[x+23,55],[x,63],[x,63],[x+23,55],[x+23,63]])vertex(xx,yy,.00015,'#1d2520');}
      else {const x=i===7?815:1233,sign=i===7?-1:1;for(const [xx,yy]of [[x+sign*12,67],[x-sign*8,55],[x-sign*8,79]])vertex(xx,yy,.00015,'#18231b');}
    }
    for(const [x,y]of [[1024,282],[532,286],[167,282],[1881,282]])for(let n=0;n<16;n++){
      vertex(x,y,.00025,'#212625');vertex(x+Math.cos(n*Math.PI/8)*11,y+Math.sin(n*Math.PI/8)*11,.00025,'#212625');vertex(x+Math.cos((n+1)*Math.PI/8)*11,y+Math.sin((n+1)*Math.PI/8)*11,.00025,'#212625');
    }
    this.moving=new THREE.BufferGeometry();this.positions=new THREE.BufferAttribute(new Float32Array(positions),3).setUsage(THREE.DynamicDrawUsage);this.colors=new THREE.BufferAttribute(new Float32Array(colors),3).setUsage(THREE.DynamicDrawUsage);
    this.moving.setAttribute('position',this.positions);this.moving.setAttribute('color',this.colors);
    const moving=new THREE.Mesh(this.moving,new THREE.MeshBasicMaterial({vertexColors:true,toneMapped:false,side:THREE.DoubleSide}));moving.frustumCulled=false;face.add(moving);
    // One tiny atlas supplies speed/gear, oil, lateral g and trip distance; no full-panel upload.
    const live:number[]=[];
    const quad=(x:number,y:number,w:number,h:number,tx:number,ty:number,tw:number,th:number)=>{
      for(const [u,v]of [[0,0],[0,1],[1,0],[1,0],[0,1],[1,1]]){
        live.push(((x+w*u)/2048-.5)*.441,(.5-(y+h*v)/576)*.124,.0004);uv.push((tx+tw*u)/512,1-(ty+th*v)/128);
      }
    };
    quad(942,340,236,100,0,0,236,100);quad(1522,222,80,50,240,0,80,50);quad(1444,403,144,50,324,0,144,50);quad(412,425,240,40,240,64,240,40);
    const patches=new THREE.BufferGeometry();patches.setAttribute('position',new THREE.Float32BufferAttribute(live,3));patches.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    face.add(new THREE.Mesh(patches,new THREE.MeshBasicMaterial({map:this.readouts,toneMapped:false})));
  }
  update(car:PlayerCar,dt:number,steering?:THREE.Object3D,rest?:THREE.Quaternion):void{
    this.rpmShown += (car.rpm-this.rpmShown)*(1-Math.exp(-dt*9));
    this.seconds+=dt;this.km+=Math.abs(car.vAlong)*dt/1000;this.timer+=dt;
    this.steeringAngle=damp(this.steeringAngle,porscheSteeringAngle(car.steerAngle),24,dt);
    if(steering&&rest)steering.quaternion.copy(rest).multiply(this.turn.setFromAxisAngle(PORSCHE_STEERING_AXIS,this.steeringAngle));
    if(!this.group.visible)return;
    const speed=Math.round(Math.abs(car.vAlong)*3.6),oil=Math.round(82+Math.min(18,this.seconds/35)),lateral=(Math.abs(car.accLat)/9.81).toFixed(2),trip=this.km.toFixed(1);
    if(this.timer>=1/PORSCHE_DASHBOARD_BUDGET.readoutHz){
      this.timer=0;const key=`${speed}/${car.gear}/${car.manual}/${oil}/${lateral}/${trip}`;
      if(key!==this.lastReadout){
        this.lastReadout=key;const g=this.context;g.fillStyle='#080c0c';g.fillRect(0,0,512,128);
        text(g,String(speed),82,35,66,WHITE,'600');text(g,car.gear===0?'R':car.gear===-1?'N':String(car.gear),207,37,42,WHITE,'600');text(g,car.manual?'M':'PDK',207,81,16,MUTED);
        text(g,'km/h',82,84,21,MUTED);text(g,`${oil}°`,280,25,36,WHITE,'600');text(g,`${lateral} g`,396,25,35,WHITE,'600');text(g,`${trip} km`,360,84,23,WHITE);
        this.readouts.needsUpdate=true;
      }
    }
    const gauges=[[1024,282,249,this.rpmShown/10000],[532,286,191,speed/350],[167,282,145,clamp(1.4+this.rpmShown/2300,0,5)/5],[1881,282,145,clamp(.8-this.km/600,.05,.8)]];
    for(let i=0;i<4;i++){
      const [x,y,r,f]=gauges[i],a=START+SWEEP*clamp(f,0,1),dx=Math.cos(a),dy=Math.sin(a);
      const points=[x-dy*4-dx*15,y+dx*4-dy*15,x+dx*(r-30),y+dy*(r-30),x+dy*4-dx*15,y-dx*4-dy*15];
      for(let v=0;v<3;v++)this.positions.setXYZ(i*3+v,(points[v*2]/2048-.5)*.441,(.5-points[v*2+1]/576)*.124,.00015);
    }
    this.positions.needsUpdate=true;
    let mask=0;for(let i=0;i<7;i++)if(this.rpmShown>6800+i*280)mask|=1<<i;
    if(this.seconds%.72<.36){if(car.blinker===1)mask|=128;if(car.blinker===2)mask|=256;}
    if(mask!==this.lastLights){this.lastLights=mask;for(let i=0;i<9;i++){
      this.color.set(mask&(1<<i)?i<7&&i>4?RED:GREEN:i<7?'#1d2520':'#18231b');
      const start=this.ledOffsets[i]/3,count=i<7?6:3;for(let v=0;v<count;v++)this.colors.setXYZ(start+v,this.color.r,this.color.g,this.color.b);
    }this.colors.needsUpdate=true;}
  }
  dispose():void{this.cluster.dispose();this.pcm.dispose();this.readouts.dispose();this.group.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();(o.material as THREE.Material).dispose();}});}
}
