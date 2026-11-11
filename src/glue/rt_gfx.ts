// nxweb runtime glue: NVN graphics attached to a guest process. The recorder (src/gfx, AssemblyScript) is instantiated
// in the process's linear memory, every NVN function the guest asks for gets a host stub that lands in nvn_call, and
// the three NVN calls that wait on the GPU park the calling guest thread on a kernel event (Runtime waitFor) instead
// of returning at once or spinning. The WebGPU replayer (gfx_host.ts) runs in the same JavaScript context.
// With no device (Node) the recorder runs against a null replayer: every NVN call and the lowering happen, nothing is
// drawn, fences complete at once. See src/runtime/README.md, "Graphics".
import { Runtime, nvn2Items, type HostCpu, type HostResult } from "./rt_runtime.ts";
import { ctlLens, isNvn2, keyControl, NVN2_CTL_READ, NVN2_KEY_CTL } from "../shaders/job.ts";
import { GfxHost, type ShaderInfo, type Capture } from "./gfx_host.ts";
import { range } from "./rt_layout.ts";
import { instantiate } from "./wasm_abi.ts";
import type { RtShaders, ShaderBlob } from "./rt_shaders.ts";
import type { HleGfx } from "./hle_rt.ts";

export interface GfxOptions {
  device?: any;                       // a GPUDevice (requested with GfxHost.deviceDescriptor(adapter)); omitted: the null replayer
  canvas?: any;                       // an OffscreenCanvas (or canvas) to present to
  vsyncNs?: bigint;                   // one display refresh in guest time (default 16_666_667n)
  // Wall clock only: resolves at the next display frame (requestAnimationFrame). Omitted: frames are paced by time.
  nextFrame?: () => Promise<unknown>;
  onPresent?: (frame: number) => void;
  unpaced?: boolean;                  // measurements: an acquire waits only for the GPU to finish the previous present
  // A new device after GPUDevice.lost (adapter.requestDevice(GfxHost.deviceDescriptor(adapter)) again); null: none.
  // Omitted: a lost device stays lost and nothing more is drawn.
  requestDevice?: () => Promise<any>;
  // Tests, null replayer only: while it returns true the "GPU" does not finish (fences stay pending until releaseFences())
  holdFences?: () => boolean;
  // The game profile's graphics switches (rt_process.ts gfxSettingsFor: the bits of src/gfx/profile.ts). Omitted: none
  profile?: { bits: number };
  sdkMajor?: number;                  // the game's SDK major version (nv::GetGraphicsMemoryInfo's record is 0x20 bytes up to SDK 10). Omitted: newer
}
// nvnSyncWait's timeout is in nanoseconds; games pass ~0 (NVN's "wait forever") or values of years: no timer then
const SYNC_FOREVER = 1n << 62n;

export class RtGfx implements HleGfx {
  readonly rt: Runtime;
  readonly x: any;                    // the recorder's exports (nvn_*, gfx_*)
  readonly host: GfxHost;             // the replayer (with the null replayer: its fences, hooks and shader library are used)
  readonly live: boolean;             // a real device is attached
  stats = { nvnCalls: 0, frames: 0, shown: 0, syncWaits: 0, syncParked: 0, syncTimeouts: 0, finishes: 0, finishParked: 0, acquires: 0, acquireParked: 0, acquireLate: 0, floatArgCalls: 0, floatResults: 0,
    deviceLosses: 0, deviceRestores: 0 };
  times = { execMs: 0 };              // time inside the replayer (WebGPU calls), part of the runtime's host-call time
  shaders: RtShaders | null = null;   // where missing shader keys are looked up (rt_shaders.ts attaches itself)
  disposedObjects = 0;
  viLayerSize: { w: number; h: number } | null = null;                       // nn::vi::CreateLayer with a size
  viLayerCrop: { x: number; y: number; w: number; h: number } | null = null;  // nn::vi::SetLayerCrop
  private opts: GfxOptions;
  private abi: Uint8Array;            // nvn_abi_table(): per function, bits 0..3 how many of d0..d7 it reads, bit 4 a float result
  private lastAcquireAt = -1n;
  private lastPresentDone: Promise<unknown> | null = null;
  private byId = new Map<number, number>();   // NVN function id -> stub address
  private presentHooks: ((frames: number) => void)[] = [];
  private shownAt: bigint[] = [];     // when present n reached the screen (host monotonic ns), the last 256
  private queuedOrder: number[] = []; // presents queued and not yet shown (their frame numbers), in order
  private heldTo = 0;                 // null replayer under holdFences: fences up to here were signalled

  // Before rt.loadNso(): registers nvnBootstrapLoader (forced, as nxnative does) and instantiates the recorder.
  constructor(rt: Runtime, module: WebAssembly.Module, opts: GfxOptions = {}) {
    this.rt = rt; this.opts = opts; this.live = !!opts.device;
    const dec = new TextDecoder();
    this.host = new GfxHost(opts.device ?? { queue: {} }, rt.memory, { canvas: this.live ? opts.canvas : undefined, log: l => rt.log(l), requestDevice: this.live ? opts.requestDevice : undefined,
      now: () => this.guestNow() });
    // (addresses the recorder hands over are numbers in either build: wasm_abi.ts)
    const env = {
      memory: rt.memory, ...rt.memImports,
      log: (p: number, n: number) => rt.log(dec.decode(rt.u8().slice(p, p + n))),
      abort: () => { throw new Error("abort in the gfx module"); },
      gfx_exec: (p: number, n: number) => {
        if (this.live) { const t0 = performance.now(); this.host.exec(p, n >>> 0); this.times.execMs += performance.now() - t0; }
        else if (!this.opts.holdFences?.()) this.releaseFences();   // null replayer: the "GPU" is done at once
      },
      // the command memory callback: guest code run to completion on the calling thread
      gfx_guest_call: (fn: bigint, a0: bigint, a1: bigint, a2: bigint, a3: bigint) => rt.guestCall(BigInt.asUintN(64, fn), [a0, a1, a2, a3]),
      gfx_proc_address: (id: number) => BigInt(this.stubOfId(id, `nvn#${id}`)),
    };
    this.x = instantiate(module, { env }, { mem64: rt.mem64, name: "gfx.wasm" });
    const st = range("gfx static"), arena = range("gfx arena"), end = this.x.gfx_static_end(), need = this.x.gfx_arena_bytes();
    if (rt.r.rt_static_check(99, BigInt(st.lo), BigInt(st.hi), BigInt(end))) throw new Error("runtime: the gfx module's static data is outside its range (was it built with --memoryBase " + st.lo + "?)");
    if (need > arena.hi - arena.lo) throw new Error(`runtime: the gfx arena needs ${need} bytes, the range has ${arena.hi - arena.lo}`);
    if (!this.x.gfx_init(arena.lo, need)) throw new Error("runtime: gfx_init failed");
    if (opts.profile?.bits) this.x.gfx_set_profile(opts.profile.bits);
    this.abi = rt.u8().slice(this.x.nvn_abi_table(), this.x.nvn_abi_table() + this.x.nvn_count());
    // The replayer's reports arrive through its hooks; guest threads wait on host.fence(n) promises (Runtime.waitFor
    // wakes the run loop when one resolves)
    this.host.attach(this.x);
    this.host.onImage = (_w, _i, what) => { if (what === 1) this.imageShown(); };
    this.host.onDeviceLost = () => { this.stats.deviceLosses++; rt.requestWake(); };
    this.host.onDeviceRestored = () => { this.stats.deviceRestores++; this.lastPresentDone = null; rt.requestWake(); };
    rt.register({ name: "nvnBootstrapLoader", forced: true, fn: cpu => { this.setApiOnce(rt); return this.stubOfName(cpu.cstr(cpu.x(0), 128)); } });
    this.registerNv(rt);
    rt.onDispose(() => this.dispose());
  }
  // nv:: (the driver glue under NVN) and nn::gs's check, as nxnative dm/gfx/hle_nv.c: NVN is the replayer's, so the
  // SDK's own driver boot must not run (nv::InitializeGraphics -> nn::gs::sdk::BootGraphicsSystem ->
  // nn::gsv::BootWithRemoteMemory asks nn::am for a graphics supervisor nxweb never has: Zelda faulted there at
  // sdk+0x1dd76c, x0 = 0). The allocators and the pool are recorded; GetGraphicsMemoryInfo reports the pool.
  readonly nv = { alloc: [] as bigint[], devtoolsAlloc: [] as bigint[], pool: 0n, poolSize: 0n, inited: false };
  // The NVN API version nvnDeviceGetInteger reports follows the game's SDK, as its own driver's would: 53.313 up to
  // SDK 10, 55.15 from SDK 11 (nxnative nvn_api). Games compare it with the version they were built against
  private apiSet = false;
  private setApiOnce(rt: Runtime): void {
    if (this.apiSet) return;
    this.apiSet = true;
    const m = this.opts.sdkMajor ?? rt.sdkMajor;
    let api = m > 0 && m <= 10 ? [53, 313] : [55, 15], note = "";
    if (rt.sdkOunce) {
      // NVN2 (Switch 2): API 231, its minor and GPU code versions read from the driver compiled into the game's sdk
      const items = rt.sdkModule ? nvn2Items(rt.u8(), rt.sdkModule) : new Map<number, number>();
      this.x.gfx_set_nvn2(1);
      for (const [i, v] of items) if (i > 1) this.x.gfx_set_devinfo2(i, v);
      api = [231, items.get(1) ?? 39];
      note = items.size ? `, Switch 2: ${items.size} of its driver's constants read from the sdk` : ", Switch 2: [RED] the sdk's nvnDeviceGetInteger switch was not found, the newest known values answer";
    }
    this.x.gfx_set_api(api[0], api[1]);
    rt.log(`nvn: device API ${api[0]}.${api[1]} (SDK ${m || "unknown"}${note})`);
  }
  private registerNv(rt: Runtime): void {
    const nv = this.nv, mb = (n: bigint) => (Number(n) / 1048576).toFixed(2);
    const reg = (name: string, fn: (cpu: HostCpu) => HostResult) => rt.register({ name, forced: true, fn });
    reg("_ZN2nv20SetGraphicsAllocatorEPFPvmmS0_EPFvS0_S0_EPFS0_S0_mS0_ES0_", cpu => { nv.alloc = [0, 1, 2, 3].map(i => cpu.x(i)); });
    reg("_ZN2nv28SetGraphicsDevtoolsAllocatorEPFPvmmS0_EPFvS0_S0_EPFS0_S0_mS0_ES0_", cpu => { nv.devtoolsAlloc = [0, 1, 2, 3].map(i => cpu.x(i)); });
    reg("_ZN2nv18InitializeGraphicsEPvm", cpu => {
      nv.pool = cpu.x(0); nv.poolSize = cpu.x(1); nv.inited = true;
      cpu.log(`nv::InitializeGraphics: pool ${mb(nv.poolSize)} MB at 0x${nv.pool.toString(16)}, recorded (the replayer allocates its own)`);
    });
    reg("_ZN2nv16FinalizeGraphicsEv", () => { nv.pool = 0n; nv.poolSize = 0n; nv.inited = false; });
    reg("_ZN2nv9InitCheckEv", cpu => { if (!nv.inited) cpu.log("[RED] nv::InitCheck: graphics not initialised (nv::InitializeGraphics was not called)"); });
    reg("_ZN2nv21GetGraphicsMemoryInfoEPNS_10MemoryInfoE", cpu => {
      const rec = new Uint8Array((this.opts.sdkMajor ?? (rt.sdkMajor || 99)) <= 10 ? 0x20 : 0x40), dv = new DataView(rec.buffer);
      if (nv.inited) { dv.setBigUint64(0, nv.poolSize, true); dv.setBigUint64(16, nv.poolSize, true); }   // total, used 0, free
      cpu.write(cpu.x(0), rec);
    });
    reg("_ZN2nv22DumpGraphicsMemoryInfoEv", cpu => cpu.log(`nv::DumpGraphicsMemoryInfo: pool ${mb(nv.poolSize)} MB, 0 used (the replayer's)`));
    reg("_ZN2nn2gs3sdk30CheckGraphicsSystemInitializedEPKcm", () => {});
  }
  // Releases the GPU objects the replayer made for this process (GfxHost.dispose: every texture and buffer; pipelines,
  // bind groups and samplers have no destroy and go with their last reference), so that the next process starts from
  // nothing on the same device and canvas. Returns how many were destroyed.
  dispose(): number {
    this.lastPresentDone = null;
    if (!this.live) return 0;
    try { this.disposedObjects = this.host.dispose(); } catch (e) { this.rt.log(`[RED] runtime: GfxHost.dispose failed: ${e instanceof Error ? e.message : e}`); }
    return this.disposedObjects;
  }
  registerShader(keyHex: string, info: ShaderInfo): number { this.shaders?.known(keyHex); return this.host.registerShader(keyHex, { entry: "main", ...info } as ShaderInfo); }
  // The next frame as text and target images (GfxHost.captureFrame; README of src/gfx, "Frame capture"); null on the null replayer
  captureFrame(o: { png?: boolean } = { png: true }): Promise<Capture> | null { return this.live ? this.host.captureFrame(o) : null; }
  // Null replayer: everything submitted so far is "done" (called at once unless a test holds the fences)
  releaseFences(): void {
    this.x.gfx_reports_flush(this.guestNow());   // counter reports land before the fences behind them complete
    for (let f = this.heldTo + 1, last = this.x.gfx_fence_last() >>> 0; f <= last; f++) { this.host.signalFence(f); this.heldTo = f; }
    this.rt.requestWake();
  }

  // ---- what nn::vi asks (HleGfx; src/glue/hle_rt.ts) ----
  viLayer(w: number, h: number): void { this.viLayerSize = { w, h }; }
  viCrop(x: number, y: number, w: number, h: number): void { this.viLayerCrop = w || h ? { x, y, w, h } : null; }
  viFrameCount(): bigint { return BigInt(this.stats.frames); }
  viPresentProgress(): { queued: bigint; done: bigint } { return { queued: BigInt(this.stats.frames), done: BigInt(this.stats.shown) }; }
  // when present `ticket` (the frame count it made) reached the screen: 0 not known (yet, or too long ago)
  viPresentedNs(ticket: bigint): bigint { const n = Number(ticket); return n > 0 && n <= this.stats.shown && n > this.stats.shown - 256 ? this.shownAt[n & 255] ?? 0n : 0n; }
  onPresentQueued(fn: (frames: number) => void): void { this.presentHooks.push(fn); }
  private imageShown(): void {
    const n = this.queuedOrder.shift();
    if (n === undefined) return;
    this.stats.shown = n;
    this.shownAt[n & 255] = BigInt(Math.round(performance.now() * 1e6));
  }

  // The key of a stage as the recorder computes it (src/gfx/shader.ts shaderKey; src/shaders/job.ts keyControl, NVN and NVN2)
  // and the bytes it is made of: NVNshaderData { u64 data; u64 control } at sd. The translator's job reads the control
  // section's first 0x880 bytes (NVN2: NVN2_CTL_READ)
  private stageOf(sd: number): { key: string; blob: () => ShaderBlob } | null {
    const rt = this.rt, mem = rt.u8(), dv = rt.dv(), data = Number(dv.getBigUint64(sd, true)), c = Number(dv.getBigUint64(sd + 8, true));
    if (!c || c + NVN2_KEY_CTL > mem.length) return null;
    const nctl = isNvn2(mem.subarray(c, c + NVN2_KEY_CTL)) ? NVN2_CTL_READ : 0x880;
    if (c + nctl > mem.length) return null;
    const { ncode } = ctlLens(mem.subarray(c, c + nctl));
    const hasCode = data !== 0 && ncode !== 0 && ncode < (1 << 24) && data + ncode <= mem.length;
    const control = () => rt.u8().slice(c, c + nctl), code = () => hasCode ? rt.u8().slice(data, data + ncode) : new Uint8Array(0);
    const key = Array.from(rt.sha256Of([keyControl(mem.subarray(c, c + nctl)), hasCode ? mem.subarray(data, data + ncode) : new Uint8Array(0)]).subarray(0, 8), b => b.toString(16).padStart(2, "0")).join("");
    return { key, blob: () => ({ key, control: control(), code: code() }) };
  }
  private workDone(): Promise<unknown> | null {
    if (!this.live) return null;
    try { return this.host.device.queue.onSubmittedWorkDone(); } catch { return null; }   // a device that is gone
  }

  // ---- stubs ----
  private stubOfName(name: string): number {
    const rt = this.rt, p = rt.r.rt_scratch_ptr() + 3200, b = new TextEncoder().encode(name + "\0");
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
      // the guest clock, which the recorder does not have (counter reports are stamped on the same clock)
      case "nvnDeviceGetCurrentTimestampInNanoseconds": return cpu => { x.gfx_set_now(this.guestNow()); return this.call(id, cpu.argsX()); };
      // nvnProgramSetShaders(program, count, NVNshaderData[]): every stage's key is looked up (library, in-page
      // translation) before the recorder notes the keys
      case "nvnProgramSetShaders": return cpu => {
        const n = cpu.w(1) | 0, sd = Number(cpu.x(2));
        if (this.shaders && sd && n > 0 && n <= 6) for (let i = 0; i < n; i++) { const st = this.stageOf(sd + 16 * i); if (st) this.shaders.need(st.key, st.blob); }
        return this.call(id, cpu.argsX());
      };
      // nvnSyncWait(sync, timeout ns). The recorder never blocks and says through gfx_wait_fence() when the thread is
      // to park (src/gfx/README.md, "nvnSyncWait"): on the fence's promise, and for a finite timeout also on a timer
      // of that many nanoseconds (wall clock; on the deterministic clock guest time stands still while the GPU works,
      // so a timeout cannot run out). Woken by the fence the call is made again; woken by the timer it is made again
      // with timeout 0, which ends the parked wait.
      case "nvnSyncWait": return cpu => {
        const k = this.keep(cpu), timeout = cpu.x(1);
        this.stats.syncWaits++;
        const res = this.call(id, k.args), fence = x.gfx_wait_fence() >>> 0;
        if (!fence) return res;                                   // not fenced, done, or timeout 0: the recorder's answer
        const again = (expired: boolean): bigint => {
          const b = k.saved.slice();
          if (expired) new DataView(b.buffer).setBigUint64(8, 0n, true);
          this.rt.u8().set(b, k.args);
          return this.call(id, k.args);
        };
        const done = this.host.fence(fence);
        if (!done) return again(false);                           // it completed inside the call (the null replayer)
        this.stats.syncParked++;
        const deadline = timeout >= SYNC_FOREVER ? undefined : cpu.now() + timeout;
        return cpu.waitFor(done, undefined, (_cpu, timedOut) => { if (timedOut) this.stats.syncTimeouts++; return again(timedOut); }, deadline);
      };
      // nvnQueueFinish flushes and puts a fence behind everything; the thread parks until that fence is done: all
      // submitted work has finished on the GPU and every read-back has landed in guest memory
      case "nvnQueueFinish": return cpu => {
        this.stats.finishes++;
        this.call(id, cpu.argsX());
        const done = this.host.fence(x.gfx_finish_fence() >>> 0);
        if (!done) return 0;
        this.stats.finishParked++;
        return cpu.waitFor(done, undefined, () => 0);
      };
      // nvnWindowAcquireTexture(window, sync, index*): frame pacing. As the Switch blocks the next acquire for the
      // window's present interval, the thread parks until `interval` vertical syncs (1/60 s) after the previous
      // acquire. The interval is the recorder's answer (gfx_present_interval: the game's own, 1 with the profile's
      // present_interval display, 60 / cap under a present cap), never 0.
      //   deterministic clock: guest time is at exactly that slot when the thread wakes, and the GPU has finished the
      //     previous present;
      //   wall clock with the display's frames (nextFrame, the page's requestAnimationFrame): the first display
      //     frame at or after the slot (within a quarter of a vsync). The slots are counted from the previous slot,
      //     not from when the frame was shown, so a 120 Hz screen shows a 60 Hz game on every second frame and a
      //     144 Hz screen keeps 60 frames a second on average (nxnative: virtual 60 Hz ticks); a game that fell more
      //     than a frame behind starts a new schedule instead of catching up in a burst;
      //   wall clock without: a timer.
      case "nvnWindowAcquireTexture": return cpu => {
        const k = this.keep(cpu), rt = this.rt, wall = rt.opts.clock === "wall", now = cpu.now();
        this.stats.acquires++;
        const interval = Math.max(1, this.x.gfx_present_interval(Number(cpu.x(0))) | 0);
        const period = BigInt(interval) * (this.opts.vsyncNs ?? 16_666_667n), quarter = (this.opts.vsyncNs ?? 16_666_667n) / 4n;
        let at: bigint | undefined, done: Promise<unknown> | null = null, slot = now;
        if (this.opts.unpaced) done = this.lastPresentDone;
        else if (this.lastAcquireAt >= 0n) {
          slot = this.lastAcquireAt + period;
          // a game that is already at or past its slot is not held for another display frame: it paces itself slower
          // than the interval (an engine with its own 35 Hz step would lose up to a display frame each time)
          if (wall && this.opts.nextFrame) { if (now >= slot) slot = now; else done = this.displayFrame(slot - quarter); }
          else { at = slot; if (!wall) done = this.lastPresentDone; }
        }
        if (!done && (at === undefined || at <= now)) {
          if (this.lastAcquireAt >= 0n && !this.opts.unpaced) this.stats.acquireLate++;   // at or past its slot: not held
          this.lastAcquireAt = now; return this.call(id, k.args);
        }
        this.stats.acquireParked++;
        return cpu.waitFor(done, at, cpu => { this.lastAcquireAt = this.opts.unpaced || (wall && !this.opts.nextFrame) ? cpu.now() : slot; cpu.write(k.args, k.saved); return this.call(id, k.args); });
      };
      case "nvnQueuePresentTexture": return cpu => {
        const win = Number(cpu.x(1)), index = cpu.w(2) | 0;
        this.stats.frames++;
        this.queuedOrder.push(this.stats.frames);
        if (this.queuedOrder.length > 64) this.queuedOrder.shift();   // a replayer that never shows (a lost device)
        const res = this.call(id, cpu.argsX());
        if (!this.live) { this.host.imageEvent(win, index, 0); this.host.imageEvent(win, index, 1); }   // null replayer: queued and shown at once
        this.lastPresentDone = this.workDone();
        for (const fn of this.presentHooks) fn(this.stats.frames);
        this.opts.onPresent?.(this.stats.frames);
        return res;
      };
    }
    // Every other function. nvn_abi says what the call needs of the floating point registers: 326 of the 332
    // implemented functions read none, so only x0..x7 are marshalled (HostCpu.argsX); four return a float, which is
    // at args + 64 after the call and goes to d0.
    const abi = this.abi[id] ?? 0, floats = abi & 15, retF = (abi & 16) !== 0;
    if (retF) return cpu => {
      const a = floats ? cpu.args() : cpu.argsX();
      this.call(id, a); this.stats.floatResults++;
      cpu.setD(0, cpu.dv().getBigUint64(a + 64, true));
    };
    if (floats) return cpu => { this.stats.floatArgCalls++; return this.call(id, cpu.args()); };
    return cpu => this.call(id, cpu.argsX());
  }
  // The guest clock now, in nanoseconds: what counter reports are stamped with. The kernel's own reading
  // (kernel_guest_ns) is as of its last tick, which can be a while ago when a completion arrives while every thread
  // is parked; this is the host's time now less the guest clock's lag (the clock stands while a freeze holds)
  private guestNow(): bigint {
    const rt = this.rt, lag = BigInt.asUintN(64, rt.k.kernel_host_time_of(0n)), host = BigInt.asUintN(64, rt.nowNs());
    const kernel = BigInt.asUintN(64, rt.guestNs());
    return lag === 0xFFFF_FFFF_FFFF_FFFFn || host < lag || host - lag < kernel ? kernel : host - lag;
  }
  // Resolves at the first display frame at or after host time `at`
  private async displayFrame(at: bigint): Promise<void> { do { await this.opts.nextFrame!(); } while (this.rt.nowNs() < at && !this.rt.disposed); }
  private idOf(name: string): number {
    const rt = this.rt, p = rt.r.rt_scratch_ptr() + 3200;
    rt.u8().set(new TextEncoder().encode(name + "\0"), p);
    return this.x.nvn_lookup(p);
  }
}
