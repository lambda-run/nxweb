// nxweb runtime glue: NVN graphics attached to a guest process. The recorder (src/gfx, AssemblyScript) is instantiated
// in the process's linear memory, every NVN function the guest asks for gets a host stub that lands in nvn_call, and
// the three NVN calls that wait on the GPU park the calling guest thread on a kernel event (Runtime waitFor) instead
// of returning at once or spinning. The WebGPU replayer (gfx_host.ts) runs in the same JavaScript context.
// With no device (Node) the recorder runs against a null replayer: every NVN call and the lowering happen, nothing is
// drawn, fences complete at once. See src/runtime/README.md, "Graphics".
import { Runtime, type HostCpu, type HostResult } from "./rt_runtime.ts";
import { GfxHost, type ShaderInfo } from "./gfx_host.ts";
import { range } from "./rt_layout.ts";

export interface GfxOptions {
  device?: any;                       // a GPUDevice; omitted: the null replayer
  canvas?: any;                       // an OffscreenCanvas (or canvas) to present to
  vsyncNs?: bigint;                   // one display refresh in guest time (default 16_666_667n)
  // Wall clock only: resolves at the next display frame (requestAnimationFrame). Omitted: frames are paced by time.
  nextFrame?: () => Promise<unknown>;
  onPresent?: (frame: number) => void;
  unpaced?: boolean;                  // measurements: an acquire waits only for the GPU to finish the previous present
}

export class RtGfx {
  readonly rt: Runtime;
  readonly x: any;                    // the recorder's exports (nvn_*, gfx_*)
  readonly host: GfxHost;             // the replayer (with the null replayer: only its shader library is used)
  readonly live: boolean;             // a real device is attached
  stats = { nvnCalls: 0, frames: 0, syncWaits: 0, syncParked: 0, finishes: 0, acquires: 0, acquireParked: 0 };
  times = { execMs: 0 };              // time inside the replayer (WebGPU calls), part of the runtime's host-call time
  private opts: GfxOptions;
  private fenceWaiters = new Map<number, (() => void)[]>();
  private fenceSeen = 0;
  private lastAcquireAt = -1n;
  private lastPresentDone: Promise<unknown> | null = null;
  private byId = new Map<number, number>();   // NVN function id -> stub address

  // Before rt.loadNso(): registers nvnBootstrapLoader (forced, as nxnative does) and instantiates the recorder.
  constructor(rt: Runtime, module: WebAssembly.Module, opts: GfxOptions = {}) {
    this.rt = rt; this.opts = opts; this.live = !!opts.device;
    const dec = new TextDecoder();
    this.host = new GfxHost(opts.device ?? { queue: {} }, rt.memory, { canvas: this.live ? opts.canvas : undefined, log: l => rt.log(l) });
    const env = {
      memory: rt.memory,
      log: (p: number, n: number) => rt.log(dec.decode(rt.u8().slice(p >>> 0, (p >>> 0) + n))),
      abort: () => { throw new Error("abort in the gfx module"); },
      gfx_exec: (p: number, n: number) => {
        if (this.live) { const t0 = performance.now(); this.host.exec(p >>> 0, n >>> 0); this.times.execMs += performance.now() - t0; }
        else for (let f = this.fenceSeen + 1, last = this.x.gfx_fence_last() >>> 0; f <= last; f++) this.fenceSignal(f);   // null replayer: the "GPU" is done at once
      },
      // the command memory callback: guest code run to completion on the calling thread
      gfx_guest_call: (fn: bigint, a0: bigint, a1: bigint, a2: bigint, a3: bigint) => rt.guestCall(BigInt.asUintN(64, fn), [a0, a1, a2, a3]),
      gfx_proc_address: (id: number) => BigInt(this.stubOfId(id, `nvn#${id}`)),
    };
    this.x = new WebAssembly.Instance(module, { env }).exports;
    const st = range("gfx static"), arena = range("gfx arena"), end = this.x.gfx_static_end() >>> 0, need = this.x.gfx_arena_bytes() >>> 0;
    if (rt.r.rt_static_check(99, BigInt(st.lo), BigInt(st.hi), BigInt(end))) throw new Error("runtime: the gfx module's static data is outside its range (was it built with --memoryBase " + st.lo + "?)");
    if (need > arena.hi - arena.lo) throw new Error(`runtime: the gfx arena needs ${need} bytes, the range has ${arena.hi - arena.lo}`);
    if (!this.x.gfx_init(arena.lo, need)) throw new Error("runtime: gfx_init failed");
    // the replayer's reports go through here so that waiting guest threads hear of them
    this.host.attach({ ...this.x, gfx_fence_signal: (n: number) => this.fenceSignal(n) });
    rt.register({ name: "nvnBootstrapLoader", forced: true, fn: cpu => this.stubOfName(cpu.cstr(cpu.x(0), 128)) });
  }
  registerShader(keyHex: string, info: ShaderInfo): number { return this.host.registerShader(keyHex, { entry: "main", ...info } as ShaderInfo); }

  private fenceSignal(n: number): void {
    this.x.gfx_fence_signal(n);
    if (n > this.fenceSeen) this.fenceSeen = n;
    for (const [f, list] of this.fenceWaiters) if (f <= n) { this.fenceWaiters.delete(f); for (const go of list) go(); }
  }
  private fence(n: number): Promise<void> | null {
    if (this.x.gfx_fence_done(n)) return null;
    return new Promise<void>(res => { const l = this.fenceWaiters.get(n) ?? []; l.push(res); this.fenceWaiters.set(n, l); });
  }
  private workDone(): Promise<unknown> | null { return this.live ? this.opts.device.queue.onSubmittedWorkDone() : null; }

  // ---- stubs ----
  private stubOfName(name: string): number {
    const rt = this.rt, p = (rt.r.rt_scratch_ptr() >>> 0) + 3200, b = new TextEncoder().encode(name + "\0");
    if (b.length > 200) return 0;
    rt.u8().set(b, p);
    const id = this.x.nvn_lookup(p);
    return id < 0 ? 0 : this.stubOfId(id, name);
  }
  private stubOfId(id: number, name: string): number {
    let a = this.byId.get(id);
    if (a === undefined) { a = this.rt.lateStub(name, this.handler(id, name)); this.byId.set(id, a); }
    return a;
  }
  private call(id: number, args: number): bigint { this.stats.nvnCalls++; return BigInt.asUintN(64, this.x.nvn_call(id, args)); }
  // The same call again after the thread waited: x0..x3 are gone from the registers by then, so the argument block is kept
  private keep(cpu: HostCpu): { args: number; saved: Uint8Array } { const args = cpu.args(); return { args, saved: cpu.read(args, 128) }; }
  private handler(id: number, name: string): (cpu: HostCpu) => HostResult {
    const x = this.x;
    switch (name) {
      // a game asks the device for every other entry point by name
      case "nvnDeviceGetProcAddress": return cpu => this.stubOfName(cpu.cstr(cpu.x(1), 128));
      // nvnSyncWait(sync, timeout): the recorder only reports; when the fence is not done and the game is willing to
      // wait, the thread parks until the replayer signals the fence
      case "nvnSyncWait": return cpu => {
        const k = this.keep(cpu), sync = Number(cpu.x(0)), timeout = cpu.x(1);
        this.stats.syncWaits++;
        const res = this.call(id, k.args), fence = res === 2n && timeout !== 0n ? x.gfx_sync_fence(sync) >>> 0 : 0, done = fence ? this.fence(fence) : null;
        if (!done) return res;
        this.stats.syncParked++;
        return cpu.waitFor(done, undefined, cpu => { cpu.write(k.args, k.saved); return this.call(id, k.args); });
      };
      // nvnQueueFinish: returns when the GPU has finished everything submitted
      case "nvnQueueFinish": return cpu => {
        this.stats.finishes++;
        this.call(id, cpu.args());
        const done = this.workDone();
        return done ? cpu.waitFor(done, undefined, () => 0) : 0;
      };
      // nvnWindowAcquireTexture(window, sync, index*): frame pacing. The thread parks until the next display frame:
      // `interval` refreshes after the previous acquire in guest time, and (wall clock) the browser's next frame, or
      // (deterministic clock) the GPU having finished the previous present.
      case "nvnWindowAcquireTexture": {
        const getInterval = this.idOf("nvnWindowGetPresentInterval");
        return cpu => {
          const k = this.keep(cpu), rt = this.rt, wall = rt.opts.clock === "wall", now = cpu.now();
          this.stats.acquires++;
          const interval = getInterval >= 0 ? Number(this.x.nvn_call(getInterval, k.args) & 0xFFn) : 1;
          cpu.write(k.args, k.saved);
          const vs = this.opts.vsyncNs ?? 16_666_667n;
          let at: bigint | undefined, done: Promise<unknown> | null = null;
          if (this.opts.unpaced) done = this.lastPresentDone;
          else if (interval > 0 && this.lastAcquireAt >= 0n) {
            if (wall && this.opts.nextFrame) done = this.opts.nextFrame();
            else { at = this.lastAcquireAt + BigInt(interval) * vs; if (!wall) done = this.lastPresentDone; }
          }
          if (!done && (at === undefined || at <= now)) { this.lastAcquireAt = now; return this.call(id, k.args); }
          this.stats.acquireParked++;
          return cpu.waitFor(done, at, cpu => { this.lastAcquireAt = wall || at === undefined ? cpu.now() : at; cpu.write(k.args, k.saved); return this.call(id, k.args); });
        };
      }
      case "nvnQueuePresentTexture": return cpu => {
        const win = Number(cpu.x(1)), index = cpu.w(2) | 0;
        const res = this.call(id, cpu.args());
        if (!this.live) { this.x.gfx_image_event(win, index, 0); this.x.gfx_image_event(win, index, 1); }   // null replayer: queued and shown at once
        this.stats.frames++;
        this.lastPresentDone = this.workDone();
        this.opts.onPresent?.(this.stats.frames);
        return res;
      };
    }
    return cpu => this.call(id, cpu.args());
  }
  private idOf(name: string): number {
    const rt = this.rt, p = (rt.r.rt_scratch_ptr() >>> 0) + 3200;
    rt.u8().set(new TextEncoder().encode(name + "\0"), p);
    return this.x.nvn_lookup(p);
  }
}
