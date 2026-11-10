// nxweb runtime glue: nn::audio and nn::codec (src/audio) attached to a guest process.
//   - the module is instantiated in the process's linear memory (static data in the "audio static" range; its arena
//     is 16 MB of host-allocated guest-addressable memory, taken at the first call: a game that never calls nn::audio
//     costs nothing);
//   - its 118 names are forced take-overs: a call lands in audio_call with x0..x7, d0..d7, x8 and x30 in the
//     argument block, after audio_tick with both clocks, and x0, x1 or v0 is written back as the result says;
//   - time: audio_tick whenever the run loop has told the kernel the time (Runtime.onTick: every slice end, every
//     idle jump), and audio_next_deadline() is a deadline of the run loop (Runtime.addDeadline): on the deterministic
//     clock a slice ends there and an idle guest's time stops there, so a silent sink releases its buffer at exactly
//     that guest time; on the wall clock the loop wakes then, the catch-up limit is nxnative's 100 ms, and while an
//     output plays on a device the loop is woken every few milliseconds to feed the ring;
//   - events: a guest nn::os::SystemEvent is bound through the take-over table (src/hle sysevent.ts: the SDK's own
//     CreateSystemEvent runs on the calling guest thread); the module's own events are bare kernel events;
//   - the audio renderer: its take-overs run SDK code, which may block or take long, so the module answers them
//     with requests (src/audio/ren.ts): CALL is served by sending the calling guest thread into the SDK function
//     with x30 = a stub of this file's, whose host function hands x0 / x1 back to the module (the thread runs the
//     function as ordinary guest code: it can wait on the SDK's update lock and be preempted); WAIT is a
//     WaitSynchronization of the thread on a kernel event of the module's. The render thread is a thread the SDK's
//     own CreateThread makes (as nxnative's is) whose function is another stub: its body is the module's loop;
//   - the device: AudioDevice (audio_device.ts) on this side, AudioDeviceMain on the page; their { audio } messages
//     go through `send` and handle().
import { Runtime, FOREVER_NS, type HostCpu, type HostResult } from "./rt_runtime.ts";
import { range } from "./rt_layout.ts";
import { AudioHost, RET, REQ, type AudioEmbedder, type OpusBackend } from "./audio_host.ts";
import { AudioDevice, type AudioDeviceOptions } from "./audio_device.ts";
import type { HleHost } from "./hle_host.ts";

export interface AudioRtOptions {
  hle?: HleHost;                       // binds guest SystemEvents (without it an AudioOut opened with an event has none: red)
  // To the page's AudioDeviceMain; omitted: no device, every output plays on the silent sink (Node, tests)
  send?: (m: { audio: Record<string, unknown> }, transfer?: Transferable[]) => void;
  device?: AudioDeviceOptions;
  // true: the page side opens its AudioContext when the process is made. Default: at the first nn::audio call, so
  // that a program without sound never makes one (an output started before the context exists plays on the silent
  // sink until the device calls back)
  openDeviceAtStart?: boolean;
  catchupLimitNs?: bigint;             // wall clock: what a silent sink makes up at most after a gap (default 100 ms, nxnative's)
  arenaBytes?: number;                 // default 16 MB
  opus?: OpusBackend;
  onSignal?: (token: number, guestNs: bigint) => void;   // tests: an event was signalled (a buffer came back)
  // tests, a recorder: a renderer's sink gave its output a block (stereo PCM16 at 48 kHz, a view: copy it)
  onRenderBlock?: (sink: number, pcm: Int16Array, guestNs: bigint) => void;
}
const ARG_BLOCK = 160, NEVER = 0xFFFF_FFFF_FFFF_FFFFn, FEED_NS = 4_000_000n;

export class RtAudio {
  readonly rt: Runtime;
  readonly host: AudioHost;
  readonly x: AudioHost["x"];
  device: AudioDevice | null = null;
  stats = { calls: 0, ticks: 0, signals: 0, binds: 0, guestCalls: 0, sdkCalls: 0, waits: 0, renderThreads: 0 };
  private contStub = 0; private threadStub = 0; private req = 0;
  private played = [0n, 0n, 0n, 0n];
  private inited = false;
  private depth = 0;
  private events = new Map<number, { ev: number; r: number; w: number }>();   // token -> a guest SystemEvent's address, or a bare kernel event
  private nextToken = 1;
  private redOnce = new Set<string>();
  private o: AudioRtOptions;
  private wall: boolean;
  private scratch: number;

  // Before rt.loadNso(): registers the names as forced take-overs
  constructor(rt: Runtime, module: WebAssembly.Module, o: AudioRtOptions = {}) {
    this.rt = rt; this.o = o; this.wall = rt.opts.clock === "wall";
    const red = (key: string, line: string) => { if (!this.redOnce.has(key)) { this.redOnce.add(key); rt.log("[RED] " + line); } };
    const embedder: AudioEmbedder = {
      log: l => rt.log(l),
      eventBind: (ev, auto) => {
        this.stats.binds++;
        if (ev) {
          // a guest nn::os::SystemEvent: the take-over table binds it (the SDK's CreateSystemEvent on this guest thread)
          const hle = o.hle;
          if (!hle) { red("nohle", "audio: a SystemEvent is to be bound and the take-over table is not attached (AudioRtOptions.hle): the event is never signalled"); return 0; }
          hle.x.hle_event_bind(ev, auto ? 1 : 0);
          if (!hle.x.hle_event_handle(ev)) return 0;
          const t = this.nextToken++; this.events.set(t, { ev, r: 0, w: 0 }); return t;
        }
        const p = (rt.r.rt_scratch_ptr() >>> 0) + 3088, r = rt.k.kernel_event_new(p) >>> 0, w = rt.dv().getUint32(p, true);
        if (!r) return 0;
        const t = this.nextToken++; this.events.set(t, { ev: 0, r, w }); return t;
      },
      eventSignal: t => {
        const e = this.events.get(t); if (!e) return;
        this.stats.signals++;
        if (e.ev) o.hle!.x.hle_event_signal(e.ev); else rt.k.kernel_event_signal(e.w);
        o.onSignal?.(t, rt.guestNs());
        rt.requestWake();
      },
      eventRelease: t => {
        const e = this.events.get(t); if (!e) return;
        this.events.delete(t);
        if (!e.ev && !rt.disposed) { rt.k.kernel_handle_close(e.r); rt.k.kernel_handle_close(e.w); }   // a guest SystemEvent stays the guest's
      },
      // the game's own code, even where the name is taken over
      guestFn: name => { for (const m of rt.modules) { const a = rt.ld.lookupIn(m.handle, name); if (a !== undefined && rt.ld.stubId(a) < 0) return BigInt(a); } return 0n; },
      guestCall: (fn, xs) => {
        if (!rt.inHostCall) { red("nocall", "audio: a guest call outside a host function (no guest thread to run it on): answered 0"); return 0n; }
        this.stats.guestCalls++;
        return rt.guestCall(fn, Array.from(xs));
      },
      threadEntry: () => BigInt(this.threadStub),
      handleDup: h => rt.k.kernel_event_dup_readable(h) >>> 0,
      opus: o.opus,
    };
    this.host = new AudioHost(module, embedder, rt.memory);
    this.x = this.host.x;
    const st = range("audio static");
    if (rt.r.rt_static_check(96, BigInt(st.lo), BigInt(st.hi), BigInt(this.x.audio_static_end() >>> 0))) throw new Error("runtime: the audio module's static data is outside its range (was it built with --memoryBase " + st.lo + "?)");
    this.scratch = this.x.audio_scratch() >>> 0;
    for (let id = 1, n = this.x.audio_fn_count(); id <= n; id++) { const name = this.host.fnName(id); rt.register({ name, forced: true, fn: cpu => this.call(cpu, id) }); }
    if (o.send && o.openDeviceAtStart) this.openDevice();
    if (this.wall) this.x.audio_set_catchup_limit(o.catchupLimitNs ?? 100_000_000n);
    rt.onTick(now => { if (this.inited && !rt.disposed) this.tick(now); });
    rt.addDeadline(now => this.deadline(now));
    rt.onDispose(() => { this.device?.close(); this.events.clear(); });
  }
  get names(): number { return this.x.audio_fn_count(); }
  // A message of the page's AudioDeviceMain; false when it is not one
  handle(m: unknown): boolean { return this.device ? this.device.handle(m) : false; }

  private openDevice(): void {
    if (this.device || !this.o.send) return;
    this.device = new AudioDevice(this.host, this.o.send, this.o.device);
    this.host.embedder.device = this.device;
  }
  private init(): void {
    if (this.inited) return;
    this.openDevice();
    const n = this.o.arenaBytes ?? 16 << 20, base = this.rt.hostAlloc(n);
    if (!base) throw new Error(`runtime: no memory for the audio arena (${n} bytes)`);
    this.x.audio_init(base, n);
    this.req = this.x.audio_co_req() >>> 0;
    // where a guest function the module asked for returns to, and where a render thread starts
    this.contStub = this.rt.lateStub("<audio.co>", cpu => this.resume(cpu, cpu.x(0), cpu.x(1)));
    this.threadStub = this.rt.lateStub("<audio.render>", cpu => {
      this.tick(this.rt.syncTime());
      this.stats.renderThreads++;
      this.x.audio_co_thread(cpu.threadIndex);
      const kind = this.x.audio_co_enter(cpu.w(0), cpu.lr);
      this.tap();
      return kind === RET.CO ? this.serve(cpu) : undefined;
    });
    this.inited = true;
  }
  // ---- a renderer take-over that goes on (src/audio/ren.ts) ----
  // The request block holds what the module needs next of the calling thread
  private serve(cpu: HostCpu): HostResult {
    const rt = this.rt, q = this.req, dv = cpu.dv(), kind = dv.getUint32(q, true);
    if (kind === REQ.CALL) {
      // the thread goes into the SDK function as ordinary guest code and returns into our stub
      for (let i = 0; i < 8; i++) cpu.setX(i, dv.getBigUint64(q + 24 + 8 * i, true));
      rt.core.x30.value = BigInt(this.contStub);
      this.stats.sdkCalls++;
      return cpu.jump(dv.getBigUint64(q + 8, true));
    }
    const token = Number(dv.getBigUint64(q + 8, true)), ns = dv.getBigUint64(q + 16, true), e = this.events.get(token);
    this.stats.waits++;
    if (!e || !e.r) {
      // no kernel event of the module's behind the token (it should not happen): the timeout alone, so that time passes
      if (!this.redOnce.has("nowait")) { this.redOnce.add("nowait"); rt.log(`[RED] audio: a renderer call waits on token ${token}, which is no kernel event of the module's`); }
      return cpu.waitFor(null, cpu.now() + ns, c => this.resume(c, 1n, 0n));
    }
    return cpu.block(e.r, ns, (how, c) => {
      if (how === "signaled") rt.k.kernel_event_clear(e.w);   // the module's events are auto-clear for their one kind of waiter
      return this.resume(c, how === "signaled" ? 0n : 1n, 0n);
    });
  }
  private resume(cpu: HostCpu, x0: bigint, x1: bigint): HostResult {
    this.tick(this.rt.syncTime());
    this.x.audio_co_thread(cpu.threadIndex);
    const kind = this.x.audio_co_resume(x0, x1);
    this.tap();
    if (kind === RET.CO) return this.serve(cpu);
    const dv = cpu.dv(), lr = dv.getBigUint64(this.req + 88, true);
    if (kind & 1) cpu.setX(0, dv.getBigUint64(this.req + 8, true));
    if (!lr) { this.rt.log("[RED] audio: a renderer call ended with nowhere to return to: its thread ends"); return cpu.never(); }
    return cpu.jump(lr);
  }
  // tests, a recorder: the blocks the render sinks gave their outputs in this entry (at most one per sink)
  private tap(): void {
    const fn = this.o.onRenderBlock;
    if (!fn) return;
    for (let i = 0; i < 4; i++) {
      const n = BigInt.asUintN(64, this.x.audio_rs_stat(i, 5));
      if (n === this.played[i]) continue;
      const fresh = n > this.played[i];
      this.played[i] = n;
      if (!fresh || !n) continue;
      fn(i, new Int16Array(this.rt.memory.buffer, this.x.audio_rs_played_ptr(i) >>> 0, this.x.audio_rs_played_frames(i) * 2), this.rt.guestNs());
    }
  }
  // both clocks to the module: the guest clock (silent sinks) and a monotonic host clock (the device's watchdog and
  // retry timers; with no device it is the run loop's own time, so that a deterministic run stays one)
  private tick(now: bigint): void {
    const guest = this.rt.guestNs(), hostNs = this.device && !this.wall ? BigInt(Math.round(performance.now() * 1e6)) : now;
    this.stats.ticks++;
    if (this.device) this.device.tick(guest, hostNs); else this.host.tick(guest, hostNs);
  }
  private deadline(now: bigint): bigint {
    if (!this.inited) return FOREVER_NS;
    const g = this.host.nextDeadline();
    let d = g === NEVER ? FOREVER_NS : this.rt.hostTimeOf(g);
    // an output on the device has no deadline of its own: the device's clock consumes its buffers, and the ring must
    // be fed while the guest waits for one to come back
    if (this.wall && this.device && this.started() && now + FEED_NS < d) d = now + FEED_NS;
    return d;
  }
  private started(): boolean { for (let i = 0, n = this.x.audio_out_max(); i < n; i++) if (this.x.audio_out_state(i) > 0) return true; return false; }

  private call(cpu: HostCpu, id: number): HostResult {
    this.init();
    this.stats.calls++;
    if (this.depth >= 5) { this.rt.log("[RED] audio: take-overs nested six deep: answered 0"); return 0; }
    // the block: x0..x7 and d0..d7 as the runtime marshals them, then x8 and the call site
    const block = this.scratch + ARG_BLOCK * this.depth, args = cpu.args(), u8 = cpu.u8(), dv = cpu.dv();
    u8.copyWithin(block, args, args + 128);
    dv.setBigUint64(block + 128, cpu.x(8), true); dv.setBigUint64(block + 136, cpu.lr, true);
    this.tick(this.rt.syncTime());   // time has moved since the last tick: the sinks are brought up to now first
    this.depth++;
    let kind: number;
    this.x.audio_co_thread(cpu.threadIndex);
    try { kind = this.x.audio_call(id, block); } finally { this.depth--; }
    if (this.o.onRenderBlock) this.tap();
    if (kind === RET.CO) return this.serve(cpu);
    const d = cpu.dv();
    if (kind === RET.V0) { cpu.setD(0, BigInt(d.getUint32(block + 64, true))); return; }
    if (kind === RET.X0X1) cpu.setX(1, d.getBigUint64(block + 8, true));
    return kind & 1 ? d.getBigUint64(block, true) : undefined;
  }
}
