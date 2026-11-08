import type * as THREE from 'three';

/** Share immutable GPU resources, but spread a large scene graph clone over short tasks. */
export async function cloneInSlices<T extends THREE.Object3D>(source: T, cancelled: () => boolean): Promise<T | null> {
  const root = source.clone(false) as T;
  const queue: [THREE.Object3D, THREE.Object3D][] = [[source, root]];
  let deadline = performance.now() + 2;
  for (let i = 0; i < queue.length; i++) {
    if (cancelled()) return null;
    const [from, to] = queue[i];
    for (const child of from.children) {
      const copy = child.clone(false);
      to.add(copy);
      queue.push([child, copy]);
      if (performance.now() >= deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (cancelled()) return null;
        deadline = performance.now() + 2;
      }
    }
  }
  return root;
}
