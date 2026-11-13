import * as THREE from 'three';

type Preparation = {
  current?: () => boolean;
  /** Apply a material variant only during synchronous renderer work, never across an await. */
  variant?: () => () => void;
  /** Warm the current scene lighting as-is instead of revealing/isolating the selected subtree. */
  preserveVisibility?: boolean;
};

const queues = new WeakMap<THREE.WebGLRenderer, Promise<void>>();
function serialized(renderer: THREE.WebGLRenderer, work: () => Promise<void>): Promise<void> {
  const task = (queues.get(renderer) ?? Promise.resolve()).then(work);
  queues.set(renderer, task.catch(() => {})); // A failed optional job cannot poison the next choice.
  return task;
}

function variant<T>(options: Preparation, work: () => T): T {
  const restore = options.variant?.();
  try { return work(); } finally { restore?.(); }
}

function visibleTree<T>(scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, work: () => T, batch?: Set<THREE.Object3D>): T {
  const states = new Map<THREE.Object3D, [boolean, boolean, number]>();
  const selected = new Set<THREE.Object3D>(); root.traverse(o => selected.add(o));
  scene.traverse(o => {
    states.set(o, [o.visible, o.frustumCulled, o.layers.mask]);
    if (selected.has(o)) {
      o.visible = true; o.frustumCulled = false;
      // Layers skip a parent's draw without suppressing traversal of its nested meshes.
      o.layers.mask = batch && (o as THREE.Mesh).isMesh && !batch.has(o) ? 0 : camera.layers.mask;
    }
    else if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) o.visible = false;
  });
  // Hidden bumper roots and hidden ancestors must not suppress uploads.
  for (let p: THREE.Object3D | null = root; p; p = p.parent) p.visible = true;
  try { return work(); }
  finally {
    for (const [o, [visible, culled, layers]] of states) { o.visible = visible; o.frustumCulled = culled; o.layers.mask = layers; }
  }
}

/** A tiny framebuffer limits raster work, NOT the cost of geometry/texture uploads. */
function offscreen<T>(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, work: () => T): T {
  const previous = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
  const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest(), color = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
  const autoClear = renderer.autoClear, xr = renderer.xr.enabled;
  try {
    renderer.xr.enabled = false; renderer.autoClear = true;
    renderer.setRenderTarget(target); renderer.setViewport(0, 0, 4, 4); renderer.setScissorTest(false);
    renderer.setClearColor(0, 0);
    return work();
  } finally {
    renderer.setRenderTarget(previous, face, mip);
    renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
    renderer.setClearColor(color, alpha); renderer.autoClear = autoClear; renderer.xr.enabled = xr;
  }
}

function compile(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, target: THREE.WebGLRenderTarget, preserveVisibility = false): Promise<unknown> {
  // The model is already attached. Passing it AND targetScene would double-count its lights.
  return offscreen(renderer, target, () => preserveVisibility
    ? renderer.compileAsync(scene, camera)
    : visibleTree(scene, camera, root, () => renderer.compileAsync(scene, camera)));
}

export function prepareObject(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, options: Preparation = {}): Promise<void> {
  return serialized(renderer, async () => {
    if (options.current && !options.current()) return;
    const target = new THREE.WebGLRenderTarget(4, 4);
    try {
      await variant(options, () => compile(renderer, scene, camera, root, target, options.preserveVisibility));
      if (options.current && !options.current()) return;
      variant(options, () => offscreen(renderer, target, () => options.preserveVisibility
        ? renderer.render(scene, camera)
        : visibleTree(scene, camera, root, () => renderer.render(scene, camera))));
    } finally { target.dispose(); }
  });
}

const yieldUpload = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Lazy remotes: one texture per turn, then at most eight meshes / ~1 MiB geometry per turn.
 * A single large texture/geometry is indivisible here and may still stall a physical GPU. */
export function prepareObjectBatched(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, current: () => boolean): Promise<void> {
  return serialized(renderer, async () => {
    if (!current()) return;
    const target = new THREE.WebGLRenderTarget(4, 4);
    try {
      await compile(renderer, scene, camera, root, target);
      const meshes: THREE.Mesh[] = [], textures = new Set<THREE.Texture>();
      root.traverse(o => {
        const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
        meshes.push(mesh);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
        }
      });
      for (const texture of textures) {
        await yieldUpload(); if (!current()) return;
        renderer.initTexture(texture);
      }
      for (let i = 0; i < meshes.length;) {
        await yieldUpload(); if (!current()) return;
        const batch = new Set<THREE.Object3D>(); let bytes = 0;
        while (i < meshes.length && batch.size < 8) {
          const mesh = meshes[i];
          const size = Object.values(mesh.geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0) + (mesh.geometry.index?.array.byteLength ?? 0);
          if (batch.size > 0 && bytes + size > 1024 * 1024) break;
          i++; batch.add(mesh); bytes += size;
        }
        offscreen(renderer, target, () => visibleTree(scene, camera, root, () => renderer.render(scene, camera), batch));
      }
    } finally { target.dispose(); }
  });
}
