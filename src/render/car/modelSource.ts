import type * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';

/** Download state of a heavy car model (the loading indicator shows it). */
export interface ModelLoad {
  name: string;
  loaded: number;
  total: number;
  unpacking: boolean;
  done: boolean;
  failed: boolean;
}

const noop = (): void => {};

/** Cache the parsed source, not just HTTP bytes. Failures never poison the next attempt. */
export class ModelSource {
  private source: THREE.Group | null = null;
  private pending: Promise<THREE.Group> | null = null;
  private state: ModelLoad;
  private readonly listeners = new Set<(state: ModelLoad) => void>();

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly bytes: number,
    private readonly prepare: (model: THREE.Group) => void = noop,
    private readonly configure: (loader: GLTFLoader) => void = noop,
  ) {
    this.state = this.initialState();
  }

  get ready(): boolean { return this.source !== null; }

  private initialState(): ModelLoad {
    return { name: this.name, loaded: 0, total: this.bytes, unpacking: false, done: false, failed: false };
  }

  private publish(): void {
    for (const listener of this.listeners) listener({ ...this.state });
  }

  load(emit: (state: ModelLoad) => void = noop): Promise<THREE.Group> {
    if (this.source) { emit({ ...this.state }); return Promise.resolve(this.source); }
    this.listeners.add(emit);
    if (this.pending) { emit({ ...this.state }); return this.pending; }
    this.state = this.initialState();
    // Assign before starting: synchronous loader/setup failures and concurrent menu/boot requests
    // must see the same promise, and a retry must not inherit a rejected one.
    this.pending = Promise.resolve().then(() => new Promise<THREE.Group>((resolve, reject) => {
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      this.configure(loader);
      loader.load(this.url, gltf => resolve(gltf.scene), event => {
        this.state.loaded = event.loaded;
        this.state.total = Math.max(event.lengthComputable && event.total > 0 ? event.total : this.state.total, event.loaded);
        this.state.unpacking = event.loaded >= this.state.total;
        this.publish();
      }, reject);
    })).then(model => {
      model.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) for (const mat of [mesh.material].flat()) mat.userData.shared = true;
      });
      this.prepare(model);
      this.source = model;
      this.state = { ...this.state, loaded: this.state.total, unpacking: false, done: true };
      this.publish();
      this.listeners.clear();
      return model;
    }).catch(error => {
      this.pending = null;
      this.state = { ...this.state, unpacking: false, failed: true };
      this.publish();
      this.listeners.clear();
      throw error;
    });
    this.publish();
    return this.pending;
  }
}
