import * as THREE from 'three';

export const HORIZON = new THREE.Color(0x1c1a2c);
export const MOON_DIR = new THREE.Vector3(-0.45, 0.32, -1).normalize();

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
  group.add(stars);
  return group;
}
