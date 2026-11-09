import * as THREE from 'three';

/** Horizon colour of the current sky (also the background and the fog); changed in place by applySky. */
export const HORIZON = new THREE.Color(0x1c1a2c);
export const MOON_DIR = new THREE.Vector3(-0.45, 0.32, -1).normalize();

export type SkyId = 'night' | 'dusk' | 'midnight' | 'neon' | 'violet' | 'miami-night';

/** A sky look: the dome, the fog it fades into, and the ambient light it casts. */
export interface SkyPreset {
  id: SkyId;
  name: string;
  desc: string;
  top: number;
  horizon: number;
  /** City glow along the horizon. */
  glow: number;
  fogNear: number;
  fogFar: number;
  /** Hemisphere light: sky and ground colours, intensity. */
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  moon: number;
  moonLight: number;
  /** Star brightness, 0..1.5. */
  stars: number;
}

export const SKY_PRESETS: readonly SkyPreset[] = [
  {
    id: 'night', name: 'Ночь', desc: 'Как было: тёмно-синее небо, лунный свет, тёплое зарево города',
    top: 0x020309, horizon: 0x1c1a2c, glow: 0x4a3240, fogNear: 70, fogFar: 950,
    hemiSky: 0x5d6c9c, hemiGround: 0x1d1813, hemi: 1.1, moon: 0xa9bcff, moonLight: 0.55, stars: 1,
  },
  {
    id: 'dusk', name: 'Сумерки', desc: 'Светлее: поздний вечер, синее небо, дальше видно',
    top: 0x0d1a3a, horizon: 0x44486c, glow: 0x9a6070, fogNear: 100, fogFar: 1200,
    hemiSky: 0x8394c4, hemiGround: 0x2c2620, hemi: 1.6, moon: 0xc4d0ff, moonLight: 0.8, stars: 0.35,
  },
  {
    id: 'midnight', name: 'Полночь', desc: 'Темнее: почти чёрное небо, яркие звёзды, свет только от фонарей и фар',
    top: 0x000103, horizon: 0x0a0a12, glow: 0x1e1620, fogNear: 50, fogFar: 760,
    hemiSky: 0x36425f, hemiGround: 0x0e0b09, hemi: 0.7, moon: 0x8aa0ff, moonLight: 0.3, stars: 1.4,
  },
  {
    id: 'neon', name: 'Неон', desc: 'Розоватая дымка: город подсвечивает небо малиновым',
    top: 0x0b0318, horizon: 0x3c1840, glow: 0xb83070, fogNear: 70, fogFar: 950,
    hemiSky: 0x8c5c9e, hemiGround: 0x26101c, hemi: 1.25, moon: 0xffb4e4, moonLight: 0.5, stars: 0.75,
  },
  {
    id: 'violet', name: 'Фиолет', desc: 'Глубокий фиолетовый, в цвет интерфейса',
    top: 0x06021a, horizon: 0x2a1452, glow: 0x6c2cb0, fogNear: 70, fogFar: 950,
    hemiSky: 0x6c5cb0, hemiGround: 0x170f26, hemi: 1.15, moon: 0xc6aaff, moonLight: 0.5, stars: 1,
  },
  {
    id: 'miami-night', name: 'Майами · ночь', desc: 'Синяя бухта, тёплые фонари и пастельный город у воды',
    top: 0x020c1e, horizon: 0x163344, glow: 0x3d5264, fogNear: 100, fogFar: 1400,
    hemiSky: 0x839bb8, hemiGround: 0x333028, hemi: 1.5, moon: 0xb6d4ed, moonLight: 0.8, stars: 0.65,
  },
];

export const skyPreset = (id: string): SkyPreset => SKY_PRESETS.find((p) => p.id === id) ?? SKY_PRESETS[0];

/** CSS gradient of a sky (the picker's swatch): zenith to horizon with the glow at the bottom. */
export function skySwatch(p: SkyPreset): string {
  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
  return `linear-gradient(180deg, ${hex(p.top)} 0%, ${hex(p.horizon)} 72%, ${hex(p.glow)} 100%)`;
}

/** Gradient dome with city glow at the horizon, a moon disc and a star field. Follows the camera. */
export function makeSky(): THREE.Group {
  const group = new THREE.Group();

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(2500, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x020309) },
        horizon: { value: HORIZON },
        glow: { value: new THREE.Color(0x4a3240) },
        moonDir: { value: MOON_DIR },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 horizon;
        uniform vec3 glow;
        uniform vec3 moonDir;
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          float h = dir.y;
          vec3 c = mix(horizon, top, pow(smoothstep(-0.02, 0.5, h), 0.55));
          c += glow * exp(-abs(h) * 16.0) * 0.7;
          float m = dot(dir, moonDir);
          c += vec3(1.5, 1.55, 1.7) * smoothstep(0.99988, 0.99992, m);
          c += vec3(0.05, 0.06, 0.09) * pow(max(m, 0.0), 900.0) + vec3(0.02, 0.025, 0.04) * pow(max(m, 0.0), 60.0);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  dome.frustumCulled = false;
  dome.renderOrder = -2;
  dome.name = 'sky/dome';
  group.add(dome);

  const N = 900;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const u = Math.random() * Math.PI * 2;
    const y = 0.08 + Math.pow(Math.random(), 0.8) * 0.92;
    const r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(u) * r * 2400, y * 2400, Math.sin(u) * r * 2400], i * 3);
    const b = 0.25 + Math.random() * 0.75 * y;
    col.set([b * 0.9, b * 0.95, b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }),
  );
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  stars.name = 'sky/stars';
  group.add(stars);
  return group;
}

/** Repaint a sky made by makeSky (the dome, the stars) and the horizon colour the scene shares. */
export function applySky(group: THREE.Group, p: SkyPreset): void {
  HORIZON.setHex(p.horizon);
  const dome = group.getObjectByName('sky/dome') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  dome.material.uniforms.top.value.setHex(p.top);
  dome.material.uniforms.glow.value.setHex(p.glow);
  const stars = group.getObjectByName('sky/stars') as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  stars.material.color.setScalar(p.stars);
}
