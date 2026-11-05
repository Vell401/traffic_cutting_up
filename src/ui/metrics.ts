import { Vector2, type WebGLRenderer } from 'three';
import type { Sim } from '../sim/world';

/** GPU time of the frame via EXT_disjoint_timer_query_webgl2 (Chrome/Edge desktop; absent elsewhere). */
class GpuTimer {
  ms = 0;
  private readonly free: WebGLQuery[] = [];
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number },
  ) {}

  static create(gl: WebGL2RenderingContext): GpuTimer | null {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    return ext ? new GpuTimer(gl, ext) : null;
  }

  begin(): void {
    if (this.active || this.pending.length > 6) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collect finished queries; returns true if a new sample arrived. */
  poll(): boolean {
    const gl = this.gl;
    let got = false;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
        this.ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        got = true;
      }
      this.free.push(this.pending.shift()!);
    }
    return got;
  }
}

interface Window {
  frames: number;
  frameMs: number;
  frameMax: number;
  simMs: number;
  renderMs: number;
  steps: number;
  gpuMs: number;
  gpuN: number;
}

const blank = (): Window => ({ frames: 0, frameMs: 0, frameMax: 0, simMs: 0, renderMs: 0, steps: 0, gpuMs: 0, gpuN: 0 });

/**
 * F1 overlay: FPS, frame / sim / render / GPU milliseconds and renderer counters, averaged over
 * 0.5 s windows. Costs nothing while hidden except a few additions per frame.
 */
export class Metrics {
  visible = false;
  /** Disable GPU queries while stats-gl is open: it runs its own and timer queries cannot nest. */
  gpuAllowed = true;
  private readonly el: HTMLPreElement;
  private readonly gpu: GpuTimer | null;
  private w = blank();
  private elapsed = 0;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly sim: Sim,
    private readonly extra: () => string = () => '',
  ) {
    this.el = document.createElement('pre');
    this.el.id = 'metrics';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.gpu = GpuTimer.create(renderer.getContext() as WebGL2RenderingContext);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
    this.w = blank();
    this.elapsed = 0;
  }

  gpuBegin(): void {
    if (this.visible && this.gpuAllowed) this.gpu?.begin();
  }

  gpuEnd(): void {
    if (this.visible && this.gpuAllowed) this.gpu?.end();
  }

  frame(frameMs: number, simMs: number, renderMs: number, steps: number): void {
    if (!this.visible) return;
    const w = this.w;
    w.frames++;
    w.frameMs += frameMs;
    w.frameMax = Math.max(w.frameMax, frameMs);
    w.simMs += simMs;
    w.renderMs += renderMs;
    w.steps += steps;
    if (this.gpu?.poll()) {
      w.gpuMs += this.gpu.ms;
      w.gpuN++;
    }
    this.elapsed += frameMs;
    if (this.elapsed >= 500) {
      this.draw();
      this.w = blank();
      this.elapsed = 0;
    }
  }

  private draw(): void {
    const w = this.w;
    const n = Math.max(1, w.frames);
    const fps = (1000 * w.frames) / this.elapsed;
    const r = this.renderer;
    const info = r.info;
    const sim = this.sim;
    const p = sim.player;
    const c = sim.road.chunkAt(p.s);
    const dpr = r.getPixelRatio();
    const size = r.getDrawingBufferSize(tmpSize);
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const gpu = !this.gpu ? 'n/a (no timer ext)' : !this.gpuAllowed ? 'off (stats-gl open)' : w.gpuN ? `${(w.gpuMs / w.gpuN).toFixed(2)} ms` : '…';
    const fpsClass = fps >= 55 ? 'ok' : fps >= 30 ? 'warn' : 'bad';
    const d = sim.director;
    this.el.innerHTML = [
      `<b class="${fpsClass}">${fps.toFixed(0)} FPS</b>  frame ${(w.frameMs / n).toFixed(2)} ms  worst ${w.frameMax.toFixed(1)} ms`,
      `CPU  sim ${(w.simMs / n).toFixed(2)} ms (${(w.steps / n).toFixed(1)} steps)  render ${(w.renderMs / n).toFixed(2)} ms`,
      `GPU  ${gpu}`,
      `draw calls ${info.render.calls}  tris ${fmtK(info.render.triangles)}  programs ${info.programs?.length ?? 0}`,
      `geometries ${info.memory.geometries}  textures ${info.memory.textures}${heap ? `  JS heap ${(heap.usedJSHeapSize / 1048576).toFixed(0)} MB` : ''}`,
      `buffer ${size.x}×${size.y}  dpr ${dpr.toFixed(2)}  ${this.extra()}`,
      `traffic ${sim.traffic.activeCount}/${sim.traffic.targetCount()}  mode ${d.mode}  difficulty ${(d.intensity * 100).toFixed(0)}%`,
      `road ${(p.s / 1000).toFixed(2)} km  ${c.kind}/${c.light}  chunks ${sim.road.chunks.length}`,
      `car ${(p.vAlong * 3.6).toFixed(0)} km/h  gear ${p.gear}  ${p.rpm.toFixed(0)} rpm  d ${p.d.toFixed(2)} m  ψ ${((p.psi * 180) / Math.PI).toFixed(1)}°`,
    ].join('\n');
  }
}

const tmpSize = new Vector2();
const fmtK = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));
