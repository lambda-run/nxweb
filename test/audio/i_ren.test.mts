// The audio renderer's SDK-driving half (src/audio/ren.ts, cmdlist.ts; nxnative dm/host/hle_audren.c) with a fake
// SDK: the test plays the embedder (it serves the module's CALL and WAIT requests) and the guest threads (each a
// generator: a thread stops where the module made it wait, or where the test's SDK made it block), and the SDK's
// functions are JavaScript. The command list fixtures are nxnative's t_audren_layout.c. The same take-overs with a
// translated guest and its own SDK stand-in run in `npm run rt:test` (test/runtime/src/audren.c).
import assert from "node:assert/strict";
import { test, Au, R, MS, MANGLED, FN, RET, REQ, REN_S, REN_THREAD_S } from "./harness.mts";

const OPEN_EV = MANGLED[FN.ar_Open - 1], OPEN0 = MANGLED[FN.ar_Open0 - 1], CLOSE = MANGLED[FN.ar_Close - 1], WORK = MANGLED[FN.ar_WorkSize - 1];
const IMPL_EXEC = MANGLED[FN.ar_ImplExec - 1], UPDATE = MANGLED[FN.ars_Update - 1];
const UPDATE_IMPL = "_ZN2nn5audio6server17AudioRenderSystem10UpdateImplEPvmS3_mPKvm";
const EXEC = "_ZN2nn5audio29ExecuteAudioRendererRenderingENS0_19AudioRendererHandleE";
const GEN = "_ZN2nn5audio6server17AudioRenderSystem15GenerateCommandEPvm", GEN20 = "_ZN2nn5audio6server17AudioRenderSystem15GenerateCommandENS_4SpanISt4byteEE";
const MODE = "_ZNK2nn5audio6server17AudioRenderSystem16GetExecutionModeEv", DEVICE = "_ZNK2nn5audio6server17AudioRenderSystem18GetRenderingDeviceEv";
const CBUF = "_ZNK2nn5audio6server17AudioRenderSystem26GetCommandBufferWorkBufferEv", CBSZ = "_ZNK2nn5audio6server17AudioRenderSystem30GetCommandBufferWorkBufferSizeEv";
const TMAX = "_ZN2nn5audio3dsp20CommandListProcessor17SetProcessTimeMaxEj", SETUP = "_ZN2nn5audio3dsp20CommandListProcessor5SetupEPKvm", PROCESS = "_ZN2nn5audio3dsp20CommandListProcessor7ProcessEv";
const SDK_LOCK = "_ZN2nn2os12SdkMutexType4LockEv", SDK_UNLOCK = "_ZN2nn2os12SdkMutexType6UnlockEv", OS_LOCK = "_ZN2nn2os9LockMutexEPNS0_9MutexTypeE", OS_UNLOCK = "_ZN2nn2os11UnlockMutexEPNS0_9MutexTypeE";
const EV_DESTROY = "_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE", EV_ATTACH = "_ZN2nn2os33AttachReadableHandleToSystemEventEPNS0_15SystemEventTypeEjbNS0_14EventClearModeE";
const EV_READABLE = "_ZN2nn2os30GetReadableHandleOfSystemEventEPKNS0_15SystemEventTypeE";
const TH_CREATE = "_ZN2nn2os12CreateThreadEPNS0_10ThreadTypeEPFvPvES3_S3_mi", TH_START = "_ZN2nn2os11StartThreadEPNS0_10ThreadTypeE";
const TH_WAIT = "_ZN2nn2os10WaitThreadEPNS0_10ThreadTypeE", TH_DESTROY = "_ZN2nn2os13DestroyThreadEPNS0_10ThreadTypeE";
const ENTRY = 0x7200_0000n, RES_NOT_MANUAL = 0x40299n;

// What a thread stops on: a wait the module asked for, or something of the fake SDK's
type Stop = { wait: number; ns: bigint } | { hold: string } | { join: Th };
type Co = Generator<Stop, bigint | [bigint, bigint], bigint>;
type SdkFn = (x: bigint[], t: Th) => Co | bigint | number | [bigint, bigint];
const isGen = (v: unknown): v is Co => typeof v === "object" && v !== null && typeof (v as Co).next === "function" && !Array.isArray(v);

// A guest thread
class Th {
  w: World; id: number; g!: Co; at: IteratorResult<Stop, bigint | [bigint, bigint]> | null = null;
  constructor(w: World, id: number) { this.w = w; this.id = id; }
  run(g: Co): this { this.g = g; this.at = g.next(); return this; }
  get done(): boolean { return !!this.at?.done; }
  get result(): bigint { assert.ok(this.done, "the thread has not finished"); const v = this.at!.value as bigint | [bigint, bigint]; return Array.isArray(v) ? v[0] : v; }
  get stop(): Stop { assert.ok(this.at && !this.at.done, "the thread has finished"); return this.at!.value as Stop; }
  get waitsOn(): number { const s = this.stop; return "wait" in s ? s.wait : -1; }
  // the thread goes on: its wait was signalled (0) or timed out (1); a held SDK call returns
  go(how = 0n): this { this.at = this.g.next(how); return this; }
  // guest code calls a taken-over function
  *takeover(name: string, x: (bigint | number)[], lr = 0x4000n): Co {
    const a = this.w.a;
    a.x.audio_co_thread(this.id);
    const r = a.call(name, x, { lr });
    if (r.kind !== RET.CO) return r.x0;
    return yield* this.serve(lr);
  }
  // a render thread reaches the stub the SDK's CreateThread was given
  *enter(arg: number, lr = 0x5000n): Co {
    const a = this.w.a;
    a.x.audio_tick(a.g, a.h);
    a.x.audio_co_thread(this.id);
    if (a.x.audio_co_enter(arg, lr) !== RET.CO) return 0n;
    return yield* this.serve(lr);
  }
  private *serve(lr: bigint): Co {
    const a = this.w.a, q = a.x.audio_co_req() >>> 0;
    for (;;) {
      const kind = a.dv.getUint32(q, true);
      let x0 = 0n, x1 = 0n;
      if (kind === REQ.CALL) {
        const fn = a.dv.getBigUint64(q + 8, true), name = a.sdkNameOf(fn), x: bigint[] = [];
        for (let i = 0; i < 8; i++) x.push(a.dv.getBigUint64(q + 24 + 8 * i, true));
        assert.ok(name && this.w.co[name], `the module asked for a call of ${fn.toString(16)} (${name}), which the fake SDK does not have`);
        this.w.calls.push(name);
        let r = this.w.co[name](x, this);
        if (isGen(r)) r = yield* r;
        if (Array.isArray(r)) { x0 = r[0]; x1 = r[1]; } else x0 = BigInt.asUintN(64, BigInt(r));
      } else {
        assert.equal(kind, REQ.WAIT, "request kind");
        x0 = yield { wait: Number(a.dv.getBigUint64(q + 8, true)), ns: a.dv.getBigUint64(q + 16, true) };
      }
      a.x.audio_tick(a.g, a.h);
      a.x.audio_co_thread(this.id);
      const k = a.x.audio_co_resume(x0, x1);
      if (k === RET.CO) continue;
      assert.equal(a.dv.getBigUint64(q + 88, true), lr, "the take-over returns to its caller");
      return k & 1 ? a.dv.getBigUint64(q + 8, true) : 0n;
    }
  }
}

interface Ren { impl: number; sys: number; state: number; mix: number; cl: number; n: number; ev: number; device: number; mode: number; rev38: number; work: bigint; size: bigint; closed: boolean }
interface WorldOptions { layout?: 16 | 20; without?: string[]; lock?: "sdk" | "os" | "tick"; lockOff?: number; sinkId?: number; samples?: number; rate?: number }

// The fake SDK and the guest's threads
class World {
  a: Au;
  co: Record<string, SdkFn> = {};
  calls: string[] = [];           // the SDK functions the module had run on a guest thread, in order
  nested: string[] = [];          // the ones it called itself
  rens: Ren[] = [];
  threads: { tt: bigint; fn: bigint; arg: number; stack: bigint; size: bigint; prio: bigint; th: Th | null; destroyed: boolean }[] = [];
  mallocs: bigint[] = []; frees: bigint[] = [];
  lockArgs: bigint[] = []; updates: bigint[][] = []; attached: bigint[][] = []; destroyed: bigint[] = [];
  signals = 0;                    // the renderer's event, signalled by ExecuteAudioRendererRendering
  hold = false;                   // the SDK's update lock is held by someone: Lock blocks
  openResult = 0n; createResult = 0n; noMemory = false; nestedOpen = false; need = 0x8000n; updateResult = 0n; notManual = false;
  o: WorldOptions; layout: number; lockOff: number; nextId = 1;
  private setupList = 0;

  constructor(o: WorldOptions = {}) {
    this.o = o; this.layout = o.layout ?? 16; this.lockOff = o.lockOff ?? 0x1d8;
    const w = this, samples = o.samples ?? 240;
    const ren = (sys: bigint) => { const r = w.rens.find(r => BigInt(r.sys) === sys); assert.ok(r, "an AudioRenderSystem of the fake SDK's"); return r; };
    const open = function* (handle: bigint, ev: bigint, param: bigint, work: bigint, size: bigint, t: Th): Co {
      const a = w.a, p = Number(param);
      if (w.nestedOpen && ev) {   // SDK 17: the event form opens through the PLT entry of the form without an event
        const rc = yield* t.takeover("ar_Open0", [handle, param, work, size]) as Co;
        if (!rc) w.rens.at(-1)!.ev = Number(ev);
        return rc as bigint;
      }
      if (w.openResult) return w.openResult;
      const impl = a.alloc(0x800), r: Ren = { impl, sys: w.layout === 20 ? impl : impl + 0x60, state: a.alloc(64), mix: a.alloc(8 * 1024 * 4), cl: a.alloc(0x1000), n: 0, ev: Number(ev),
        device: a.dv.getInt32(p + 0x2c, true), mode: a.dv.getInt32(p + 0x30, true), rev38: a.dv.getUint32(p + 0x38, true), work, size, closed: false };
      if (w.layout === 20) { a.dv.setInt32(r.sys + 0x48, w.notManual ? 0 : 1, true); a.dv.setInt32(r.sys + 0x4c, 1, true); a.dv.setBigUint64(r.sys + 0xf8, BigInt(r.cl), true); a.dv.setBigUint64(r.sys + 0x100, 0x1000n, true); }
      w.rens.push(r);
      a.dv.setBigUint64(Number(handle), BigInt(impl), true); a.dv.setBigUint64(Number(handle) + 8, BigInt(r.state), true);
      return 0n;
    };
    // The command list of one frame: five filler commands and the DeviceSink with inputs 0 and 1 (SDK 8-20 layout)
    const generate = (r: Ren): number => {
      const a = w.a, dv = a.dv, cl = r.cl;
      a.u8.fill(0, cl, cl + 0x1000);
      dv.setUint32(cl + 4, 6, true); dv.setBigUint64(cl + 8, BigInt(r.mix), true); dv.setUint32(cl + 0x14, samples, true); dv.setUint32(cl + 0x18, o.rate ?? 48000, true);
      let q = cl + 0x20;
      const put = (id: number, size: number) => { dv.setUint32(q, 0xcafebabe, true); dv.setUint8(q + 4, 1); dv.setUint8(q + 5, id); dv.setInt16(q + 6, size, true); q += size; return q - size; };
      for (let i = 0; i < 5; i++) put(6, 0x40);
      const sink = put(o.sinkId ?? (w.layout === 20 ? 0x14 : 0x13), 0x148);
      dv.setUint32(sink + 0x130, 2, true); dv.setInt16(sink + 0x134, 0, true); dv.setInt16(sink + 0x136, 1, true);
      return q - cl;
    };
    const lock: SdkFn = function* (x): Co { w.lockArgs.push(x[0]); if (w.hold) yield { hold: "the update lock" }; return 0n; };
    this.co = {
      [OPEN_EV]: (x, t) => open(x[0], x[1], x[2], x[3], x[4], t),
      [OPEN0]: (x, t) => open(x[0], 0n, x[1], x[2], x[3], t),
      [CLOSE]: x => { const r = w.rens.find(r => BigInt(r.impl) === x[0]); assert.ok(r && BigInt(r.state) === x[1], "CloseAudioRenderer gets the handle"); r.closed = true; return 0n; },
      // the SDK's own: one frame through the AudioRendererImpl's function (the host's take-over), then the renderer's event
      [EXEC]: function* (x, t): Co {
        const r = w.rens.find(r => BigInt(r.impl) === x[0])!;
        const rc = yield* t.takeover(w.layout === 20 ? "ars_Exec" : "ar_ImplExec", [w.layout === 20 ? r.sys : r.impl]) as Co;
        w.signals++;
        return rc;
      },
      [SDK_LOCK]: lock, [OS_LOCK]: lock, [SDK_UNLOCK]: x => { w.lockArgs.push(-x[0]); return 0n; }, [OS_UNLOCK]: x => { w.lockArgs.push(-x[0]); return 0n; },
      [GEN]: x => { const r = ren(x[0]); assert.deepEqual([x[1], x[2]], [BigInt(r.cl), 0x1000n], "GenerateCommand gets the command buffer"); return generate(r); },
      [GEN20]: x => { const r = ren(x[0]); assert.deepEqual([x[1], x[2]], [BigInt(r.cl), 0x1000n], "GenerateCommand gets the command buffer span"); return [BigInt(r.cl), BigInt(generate(r))]; },
      // the CPU "DSP": every frame of the block carries the stream's frame number (left: low 15 bits, right: the next 15)
      [PROCESS]: () => {
        const r = w.rens.find(r => r.cl === w.setupList)!;
        const m = new Int32Array(w.a.x.memory.buffer, r.mix, 8 * samples);
        for (let i = 0; i < samples; i++) { const n = ++r.n; m[i] = n & 0x7FFF; m[samples + i] = (n >> 15) & 0x7FFF; }
        return 0n;
      },
      [UPDATE]: x => { ren(x[0]); w.updates.push(x.slice(0, 7)); return w.updateResult; },
      malloc: x => { if (w.noMemory) return 0n; const p = BigInt(w.a.alloc(Number(x[0])) + 8); w.mallocs.push(p); return p; },   // not page aligned: the host aligns the stack
      free: x => { w.frees.push(x[0]); return 0n; },
      [TH_CREATE]: x => { if (!w.createResult) w.threads.push({ tt: x[0], fn: x[1], arg: Number(x[2]), stack: x[3], size: x[4], prio: x[5], th: null, destroyed: false }); return w.createResult; },
      // a thread of higher priority than its maker: it runs at once, until it waits
      [TH_START]: x => { const t = w.threads.findLast(t => t.tt === x[0])!; const th = new Th(w, w.nextId++); t.th = th; th.run(th.enter(t.arg)); return 0n; },
      [TH_WAIT]: function* (x): Co { const t = w.threads.findLast(t => t.tt === x[0])!; while (!t.th!.done) yield { join: t.th! }; return 0n; },
      [TH_DESTROY]: x => { w.threads.findLast(t => t.tt === x[0])!.destroyed = true; return 0n; },
    };
    // what the module calls itself, in the middle of a step: short functions that cannot block
    const direct: Record<string, (x: BigUint64Array) => bigint | number> = {
      [MODE]: x => (ren(x[0]), 1), [DEVICE]: x => (ren(x[0]), w.notManual ? 0 : 1), [CBUF]: x => ren(x[0]).cl, [CBSZ]: x => (ren(x[0]), 0x1000),
      [TMAX]: x => { assert.equal(x[1], 0xffffffffn); return 0; }, [SETUP]: x => { w.setupList = Number(x[1]); assert.ok(x[2] > 0x20n); return 0; },
      [WORK]: x => { const p = Number(x[0]); assert.deepEqual([w.a.dv.getInt32(p + 0x2c, true), w.a.dv.getInt32(p + 0x30, true)], [1, 1], "the SDK is asked for its CPU / manual size"); return w.need; },
      [EV_DESTROY]: x => { w.destroyed.push(x[0]); return 0; }, [EV_READABLE]: x => Number(x[0] & 0xfffn) + 0x100, [EV_ATTACH]: x => { w.attached.push([x[0], x[1], x[2], x[3]]); return 0; },
    };
    const sdk: Record<string, (x: BigUint64Array, au: Au) => bigint | number> = {};
    const without = new Set([...(o.without ?? []), this.layout === 20 ? GEN : GEN20, ...(this.layout === 20 ? [MODE, DEVICE, CBUF, CBSZ] : [])]);
    for (const n of Object.keys(this.co)) if (!without.has(n)) sdk[n] = () => { throw new Error(`${n} was called from inside a step: it may block and must be run on the guest thread`); };
    for (const n of Object.keys(direct)) if (!without.has(n)) sdk[n] = x => { w.nested.push(n); return direct[n](x); };
    if (o.lock === "tick" && !without.has(UPDATE_IMPL)) sdk[UPDATE_IMPL] = () => 0;
    this.a = new Au({ sdk, threadEntry: ENTRY });
    // The SDK's code, as far as the host reads it: Update's (or UpdateImpl's) first instructions take the update
    // lock at `this` + lockOff; AudioRendererImpl's ExecuteAudioRendererRendering adds 0x60 to `this`
    const a = this.a, code = a.alloc(0x400), dv = a.dv;
    const fn = (at: number, off: number, target: number) => {   // pacibsp; add x19, x0, #off; mov x20, x0; mov x0, x19; bl target
      let n = 0;
      dv.setUint32(at + 4 * n++, 0xd503237f, true);
      if (off >= 0) { dv.setUint32(at + 4 * n++, (0x91000000 | off << 10 | 19) >>> 0, true); dv.setUint32(at + 4 * n++, 0xaa0003e0 | 20, true); dv.setUint32(at + 4 * n++, 0xaa0003e0 | 19 << 16, true); }
      dv.setUint32(at + 4 * n, (0x94000000 | (((target - (at + 4 * n)) >> 2) & 0x3ffffff)) >>> 0, true);
    };
    const L_SDK = code + 0x100, L_OS = code + 0x140, TICK = code + 0x180, IMPL = code + 0x200, UIMPL = code + 0x240;
    a.sdkPlace(SDK_LOCK, L_SDK); a.sdkPlace(OS_LOCK, L_OS); a.sdkPlace(UPDATE, code); a.sdkPlace(IMPL_EXEC, IMPL);
    if (o.lock === "tick") { fn(code, -1, TICK); a.sdkPlace(UPDATE_IMPL, UIMPL); fn(UIMPL, this.lockOff, L_SDK); }   // from SDK 19: Update reads the tick, UpdateImpl locks
    else fn(code, this.lockOff, o.lock === "os" ? L_OS : L_SDK);
    dv.setUint32(IMPL, 0x91018000, true); dv.setUint32(IMPL + 4, 0x14000010, true);   // add x0, x0, #0x60; b ...
    sdk[IMPL_EXEC] = () => { throw new Error("the SDK's own AudioRendererImpl::ExecuteAudioRendererRendering never runs"); };
  }
  th(): Th { return new Th(this, this.nextId++); }
  // An AudioRendererParameter as a game fills it: for the DSP, automatic execution
  param(o: { device?: number; mode?: number; rev?: number; rate?: number } = {}): number {
    const a = this.a, p = a.alloc(0x40), dv = a.dv;
    [o.rate ?? 48000, 240, 3, 0, 4, 1, 0, 0].forEach((v, i) => dv.setInt32(p + 4 * i, v, true));
    dv.setInt32(p + 0x2c, o.device ?? 0, true); dv.setInt32(p + 0x30, o.mode ?? 0, true);
    dv.setUint32(p + 0x34, 0x00564552 | (0x30 + (o.rev ?? 8)) << 24, true); dv.setUint32(p + 0x38, 0x12345678, true);
    return p;
  }
  // A game opens a renderer on thread t (a new one by default) with a work buffer of the size the host told it
  open(o: { event?: boolean; t?: Th; param?: number; work?: number; size?: bigint } = {}): { t: Th; handle: number; ev: number; param: number; work: number; size: bigint } {
    const a = this.a, t = o.t ?? this.th(), handle = a.alloc(16), ev = o.event === false ? 0 : a.alloc(0x40), param = o.param ?? this.param();
    const size = o.size ?? a.c("ar_WorkSize", param), work = o.work ?? ((a.alloc(Number(size) + 0x2000) + 0xfff) & ~0xfff);
    t.run(ev ? t.takeover("ar_Open", [handle, ev, param, work, size]) : t.takeover("ar_Open0", [handle, param, work, size]));
    return { t, handle, ev, param, work, size };
  }
  close(i: number, t = this.th()): Th { const r = this.rens[i]; return t.run(t.takeover("ar_Close", [r.impl, r.state])); }
  update(i: number, t = this.th()): Th { const r = this.rens[i]; return t.run(t.takeover("ars_Update", [r.sys, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60])); }
  render(slot: number): Th { return this.threads.findLast(t => t.arg === slot)!.th!; }   // the latest render thread of a renderer slot
  state(i: number): string { return REN_S[Number(this.a.x.audio_ren_stat(i, 0))]; }
  tstate(i: number): string { return REN_THREAD_S[Number(this.a.x.audio_ren_stat(i, 1))]; }
  sink(i: number): number { return Number(BigInt.asIntN(64, this.a.x.audio_ren_stat(i, 2))); }
  rs(i: number, which: number): number { return Number(this.a.x.audio_rs_stat(this.sink(i), which)); }   // 0 frames 1 nonsilent 2 updates 3 renders 4 catchups 5 played 6 queued 7 free 8 discarded
  // the frame numbers of the block renderer i's sink last gave its output (0: silence)
  played(i: number): number[] {
    const s = this.sink(i), n = this.a.x.audio_rs_played_frames(s), pcm = new Int16Array(this.a.x.memory.buffer, this.a.x.audio_rs_played_ptr(s) >>> 0, n * 2);
    return Array.from({ length: n }, (_, k) => pcm[2 * k] + pcm[2 * k + 1] * 32768);
  }
  // guest time moves to the output's next release (5 ms) and the render thread is woken by its release event
  frame(i: number): void {
    const th = this.render(i), ev = this.a.events[th.waitsOn - 1];
    ev.flag = false;
    assert.ok(this.a.toDeadline());
    assert.ok(ev.flag, "the output's release signals the render thread's event");
    th.go(0n);
  }
  noRed(): void { assert.deepEqual(this.a.red, []); assert.equal(this.a.x.kit_refused_total(), 0); }
}
const block = (first: number, n = 240) => Array.from({ length: n }, (_, k) => first + k);
const RENDER = [SDK_LOCK, GEN, SDK_UNLOCK, PROCESS];

test("renderer open (nxnative ar_open): the game asks for the DSP with an event; the SDK is opened for CPU rendering with manual execution, with an event of the host's that outlives the game's object, whose read end the game's event gets; the render thread is made with the SDK's malloc, CreateThread and StartThread and renders four frames at once", () => {
  const w = new World(), a = w.a;
  const o = w.open();
  assert.ok(o.t.done); assert.equal(o.t.result, R.OK);
  const r = w.rens[0];
  // the SDK saw the host's copy of the parameter: device and mode changed, the rest as the game had it (0x40 bytes: SDK 8's revision at +0x38 too)
  assert.deepEqual([r.device, r.mode, r.rev38, r.work, r.size], [1, 1, 0x12345678, BigInt(o.work), o.size]);
  assert.deepEqual([a.dv.getInt32(o.param + 0x2c, true), a.dv.getInt32(o.param + 0x30, true)], [0, 0], "the game's parameter is not written");
  assert.deepEqual([a.dv.getBigUint64(o.handle, true), a.dv.getBigUint64(o.handle + 8, true)], [BigInt(r.impl), BigInt(r.state)]);
  // the event: the SDK got one of the host's (in the arena), not the game's; the SDK's local event in it was destroyed, it was bound as a kernel event (auto-clear), and its read end's copy attached to the game's object, managed, auto-clear
  assert.notEqual(r.ev, o.ev);
  assert.deepEqual(w.destroyed, [BigInt(r.ev)]);
  const bound = a.events.find(e => e.ptr === r.ev)!;
  assert.ok(bound.autoClear);
  assert.deepEqual(w.attached, [[BigInt(o.ev), BigInt((r.ev & 0xfff) + 0x100 + 0x1000), 1n, 1n]]);
  // the render thread, as nxnative's dm_guest_thread_spawn makes it: 64 KB of the SDK's malloc aligned to a page, priority 9, the embedder's stub as its function
  assert.deepEqual(w.calls.slice(0, 4), [OPEN_EV, "malloc", TH_CREATE, TH_START]);
  const t = w.threads[0];
  assert.deepEqual([t.fn, t.arg, t.stack, t.size, t.prio], [ENTRY, 0, (w.mallocs[0] + 0xfffn) & ~0xfffn, 0x10000n, 9n]);
  assert.deepEqual([w.state(0), w.tstate(0)], ["Running", "Waiting"]);
  // it ran inside StartThread: four blocks in flight, one render each, each ExecuteAudioRendererRendering signalling the game's event
  assert.deepEqual(w.calls.slice(4), [0, 1, 2, 3].flatMap(() => [EXEC, ...RENDER]));
  assert.deepEqual([w.rs(0, 3), w.rs(0, 5), w.rs(0, 7), w.signals], [4, 4, 0, 4]);
  // command generation inside the update lock, which the host read off Update's code (+0x1d8); the system is at +0x60 of the AudioRendererImpl
  assert.deepEqual(w.lockArgs.slice(0, 2), [BigInt(r.sys + 0x1d8), -BigInt(r.sys + 0x1d8)]);
  assert.equal(r.sys, r.impl + 0x60);
  assert.deepEqual(w.played(0), block(721));
  // it waits for the output to hand a block back, at most 10 ms
  assert.deepEqual(w.render(0).stop, { wait: a.x.audio_rs_event(w.sink(0)), ns: 10n * MS });
  for (const l of ["audren: OpenAudioRenderer rate 48000 samples per frame 240 mix buffers 3 submixes 0 voices 4 sinks 1 effects 0 splitters 0 (original device 0 mode 0 -> CPU / manual) work buffer ",
    "audren: renderer 0 opened from 0x4000", "audren: render thread 0 started (4 buffers in flight, paced by the output)", "audren: AudioRenderSystem at +0x60 in AudioRendererImpl",
    "audren: AudioRenderSystem in the SDK 16 layout (update lock SdkMutexType at +0x1d8)", "audren: first-frame commands 6, by command ID: 6x5 19x1", "audren: DeviceSink inputs 2 rate 48000 samples per frame 240 mix buffer "])
    assert.ok(a.logs.some(x => x.startsWith(l)), l + "\n" + a.logs.join("\n"));
  w.noRed();
});

test("render thread (nxnative render_main): one render for each 5 ms block the output hands back, at exactly 5 ms of guest time; a wait that times out renders nothing; close waits for the thread (WaitThread), which ends at its next round and closes its output, then DestroyThread, free, the SDK's close, and the host's event is destroyed", () => {
  const w = new World(), a = w.a, o = w.open(), th = w.render(0), t0 = a.g, out = a.x.audio_rs_out(w.sink(0));
  for (let k = 1; k <= 200; k++) {
    assert.equal(a.host.nextDeadline(), t0 + BigInt(k) * 5n * MS);
    w.frame(0);
    assert.deepEqual([w.rs(0, 3), w.signals, w.tstate(0)], [4 + k, 4 + k, "Waiting"]);
    assert.deepEqual(w.played(0), block(4 * 240 + (k - 1) * 240 + 1));
  }
  // 10 ms without a release (it cannot happen on the silent sink; a device that stalls): the loop looks again and waits again
  const calls = w.calls.length;
  th.go(1n);
  assert.deepEqual([w.calls.length, w.tstate(0), w.rs(0, 3)], [calls, "Waiting", 204]);
  // close: the join first
  const c = w.close(0);
  assert.deepEqual(w.calls.slice(calls), [TH_WAIT]);
  assert.deepEqual([w.state(0), c.stop], ["Stopping", { join: th }]);
  assert.equal(a.x.audio_out_state(out), 1, "the output is the thread's until it ends");
  th.go(1n);   // its wait ends: the renderer is no longer Running
  assert.ok(th.done);
  assert.deepEqual([w.tstate(0), w.sink(0), a.x.audio_out_state(out)], ["Idle", -1, -1]);
  c.go();
  assert.ok(c.done);
  assert.deepEqual(w.calls.slice(calls), [TH_WAIT, TH_DESTROY, "free", CLOSE]);
  assert.deepEqual([w.threads[0].destroyed, w.frees, w.rens[0].closed, w.state(0)], [true, [w.mallocs[0]], true, "Free"]);
  // the SDK's close does not touch the event: the host destroys its own (a second time: the first was the SDK's local one) and lets the binding go
  assert.deepEqual(w.destroyed, [BigInt(w.rens[0].ev), BigInt(w.rens[0].ev)]);
  assert.ok(a.events.find(e => e.ptr === w.rens[0].ev)!.released);
  assert.equal(a.x.audio_ren_frames(), 0);
  void o;
  w.noRed();
});

test("renderer close and reopen: twenty rounds leave no renderer call in progress, no output, and the arena as it was after the first", () => {
  const w = new World(), a = w.a;
  let used = 0;
  for (let i = 0; i < 20; i++) {
    w.open();
    w.frame(0);
    const c = w.close(i);   // the i-th renderer of the fake SDK's, in slot 0 again
    w.render(0).go(1n); c.go();
    assert.ok(c.done && w.render(0).done);
    assert.deepEqual([w.state(0), w.state(1), a.x.audio_ren_frames(), a.host.outs().length], ["Free", "Free", 0, 0]);
    if (i === 0) used = a.x.audio_arena_used(); else assert.equal(a.x.audio_arena_used(), used);
  }
  assert.equal(w.rens.every(r => r.closed), true);
  w.noRed();
});

test("the SDK's update lock held by another thread: the render thread blocks inside the SDK's Lock, on its own guest thread, and goes on when it is free; meanwhile the game's update, which found nothing rendered since its last one, waits for its turn to render a catch-up frame (one render at a time: they share the command buffer)", () => {
  const w = new World(), a = w.a;
  w.open();
  const th = w.render(0);
  w.update(0);                       // the first update: nothing to catch up with
  assert.deepEqual(w.updates.length, 1);
  w.hold = true;
  w.frame(0);
  assert.deepEqual(th.stop, { hold: "the update lock" });
  assert.equal(w.tstate(0), "Rendering");
  // the game updates again: no frame was rendered since its last update (one is in progress, which is not one
  // rendered), so it is to render a catch-up frame, and waits its turn (5 ms at a time)
  const u2 = w.update(0);
  const rev = u2.waitsOn;
  assert.deepEqual(u2.stop, { wait: rev, ns: 5n * MS });
  assert.equal(w.updates.length, 1);
  u2.go(1n);                          // 5 ms later: still busy
  assert.deepEqual(u2.stop, { wait: rev, ns: 5n * MS });
  w.hold = false;
  a.events[rev - 1].flag = false;
  th.go();                            // the lock is free: the render thread's render completes
  assert.equal(w.tstate(0), "Waiting");
  assert.ok(a.events[rev - 1].flag, "a render that ends signals the waiting one");
  assert.deepEqual(w.played(0), block(961));
  u2.go(0n);                          // its turn: lock, generate, unlock, process, then the SDK's Update
  assert.ok(u2.done);
  assert.deepEqual(w.calls.slice(-5), [...RENDER, UPDATE]);
  assert.deepEqual([w.updates.length, w.rs(0, 4), w.rs(0, 6)], [2, 1, 1], "updates, catch-up renders, frames in the queue");
  w.noRed();
});

test("update (nxnative h_ars_Update): at least one rendered frame between two updates; a catch-up frame is rendered on the updating thread into a queue, played by the render thread in place of its next render and without signalling the game's event; with the queue full the update waits for the render thread (at most 50 ms), and renders into nothing when the output has stopped", () => {
  const w = new World(), a = w.a;
  w.open();
  const th = w.render(0), sys = BigInt(w.rens[0].sys);
  const u = w.update(0);
  assert.ok(u.done); assert.equal(u.result, 0n);
  assert.deepEqual(w.updates[0], [sys, 0x10n, 0x20n, 0x30n, 0x40n, 0x50n, 0x60n], "the SDK's Update gets the game's arguments");
  assert.equal(w.calls.at(-1), UPDATE);
  // a frame, an update: nothing to catch up
  w.frame(0); w.update(0);
  assert.equal(w.rs(0, 4), 0);
  // four more updates without a frame in between: four catch-up frames, queued (frames 1201..)
  for (let k = 0; k < 4; k++) { const n = w.calls.length; assert.ok(w.update(0).done); assert.deepEqual(w.calls.slice(n), [...RENDER, UPDATE]); }
  assert.deepEqual([w.rs(0, 4), w.rs(0, 6), w.rs(0, 3), w.signals], [4, 4, 9, 5]);
  assert.ok(a.logs.includes("audren: renderer 0: no frame rendered before update 3, rendering a catch-up frame first (1 so far)"));
  // the queue is full: the next update waits for the render thread to play one
  const cq = a.x.audio_rs_cq_event(w.sink(0));
  const full = w.update(0);
  assert.deepEqual(full.stop, { wait: cq, ns: 50n * MS });
  a.events[cq - 1].flag = false;
  const sig = w.signals, calls = w.calls.length;
  w.frame(0);                         // the render thread plays the oldest queued frame: no render, no renderer event
  assert.deepEqual([w.calls.length, w.signals, w.rs(0, 6), w.tstate(0)], [calls, sig, 3, "Waiting"]);
  assert.deepEqual(w.played(0), block(1201));
  assert.ok(a.events[cq - 1].flag);
  full.go(0n);                        // room: its catch-up frame is rendered into the queue
  assert.ok(full.done);
  assert.deepEqual([w.rs(0, 6), w.rs(0, 4), w.rs(0, 8)], [4, 5, 0]);
  // full again, and this time the render thread plays nothing for 50 ms (the output stopped): rendered and discarded
  const stuck = w.update(0);
  assert.deepEqual(stuck.stop, { wait: cq, ns: 50n * MS });
  stuck.go(1n);
  assert.ok(stuck.done);
  assert.deepEqual([w.rs(0, 6), w.rs(0, 4), w.rs(0, 8), w.updates.length], [4, 6, 1, 8]);
  // the queued frames come out in order, one per block, then renders again
  for (const first of [1441, 1681, 1921, 2161]) { w.frame(0); assert.deepEqual(w.played(0), block(first)); }
  assert.equal(w.signals, sig);
  w.frame(0);
  assert.deepEqual(w.played(0), block(2641));   // 2401.. was the discarded frame
  assert.equal(w.signals, sig + 1);
  // the update's result is the SDK's
  w.updateResult = 0x1234n;
  assert.equal(w.update(0).result, 0x1234n);
  w.noRed();
});

test("renderer without an event (the game paces its updates itself): the SDK's form without one is opened, no event is made, the render thread runs all the same", () => {
  const w = new World(), a = w.a, events = a.events.length;
  const o = w.open({ event: false });
  assert.equal(o.t.result, R.OK);
  assert.deepEqual([w.calls[0], w.rens[0].ev, w.destroyed.length, w.attached.length], [OPEN0, 0, 0, 0]);
  assert.equal(a.events.filter((e, i) => i >= events && e.ptr !== 0).length, 0, "no SystemEvent was bound");
  assert.deepEqual([w.state(0), w.tstate(0), w.rs(0, 3)], ["Running", "Waiting", 4]);
  assert.ok(a.logs.some(l => l.startsWith("audren: OpenAudioRenderer (no event) rate 48000")));
  const c = w.close(0); w.render(0).go(1n); c.go();
  assert.ok(c.done); assert.equal(w.destroyed.length, 0);
  w.noRed();
});

test("an SDK whose event form opens through the form without one (SDK 17): the inner call, which lands in the host's take-over, goes straight to the SDK with the host's copy of the parameter; one renderer, one thread", () => {
  const w = new World(), a = w.a;
  w.nestedOpen = true;
  const o = w.open();
  assert.equal(o.t.result, R.OK);
  assert.deepEqual(w.calls.slice(0, 5), [OPEN_EV, OPEN0, "malloc", TH_CREATE, TH_START]);
  assert.deepEqual([w.rens.length, w.threads.length, w.rens[0].device, w.rens[0].mode], [1, 1, 1, 1]);
  assert.deepEqual([w.state(0), w.state(1)], ["Running", "Free"]);
  assert.equal(a.logs.filter(l => l.startsWith("audren: OpenAudioRenderer")).length, 1);
  w.noRed();
});

test("a game that opens a CPU renderer itself keeps the SDK's contract: the SDK keeps the game's event and the work buffer is the game's business", () => {
  const w = new World();
  const o = w.open({ param: w.param({ device: 1, mode: 1 }), size: 0x1000n });
  assert.equal(o.t.result, R.OK);
  assert.deepEqual([w.rens[0].ev, w.destroyed.length, w.attached.length, w.rens[0].size], [o.ev, 0, 0, 0x1000n]);
  assert.equal(w.state(0), "Running");
  w.noRed();
});

test("work buffer: the game's buffer follows the DSP service's budget; the SDK's CPU renderer needs more than that and gets storage of the host's (a page-aligned block of the arena, freed after the SDK's close); a buffer below the service's budget fails the open", () => {
  const w = new World(), a = w.a;
  const p = w.param(), service = a.c("ar_WorkSize", p);
  assert.ok(service >= 0x8000n && !(service & 0xfffn));
  assert.equal(w.nested.length, 0, "the service's budget is the host's own arithmetic");
  w.need = service + 0x5000n;
  const before = a.x.audio_arena_used();
  const o = w.open({ param: p });
  assert.equal(o.t.result, R.OK);
  const r = w.rens[0];
  assert.deepEqual([r.size, r.work & 0xfffn], [w.need, 0n]);
  assert.notEqual(r.work, BigInt(o.work));
  assert.ok(a.x.audio_arena_used() >= before + Number(w.need));
  assert.ok(a.logs.some(l => l.startsWith("audren: host backs local renderer work buffer ")));
  const backed = a.x.audio_arena_used();
  const c = w.close(0); w.render(0).go(1n); c.go();
  assert.ok(a.x.audio_arena_used() <= backed - Number(w.need), "the host's storage is freed");
  // too small for the service: no SDK call at all
  const calls = w.calls.length;
  const small = w.open({ param: p, size: service - 0x1000n });
  assert.equal(small.t.result, R.FAIL);
  assert.equal(w.calls.length, calls);
  assert.match(a.red.at(-1)!, /^\[RED\] audren: work buffer 0x[0-9a-f]+ is smaller than the service requirement 0x[0-9a-f]+$/);
  assert.deepEqual([w.state(0), a.x.audio_ren_frames()], ["Free", 0]);
  assert.equal(a.red.length, 1);
});

test("open failures: the SDK's open fails (its Result is the game's, the host's event and storage are taken back); no memory for the thread's stack; CreateThread fails; an SDK without nn::os threads: the renderer is open without a render thread and its close skips the join", () => {
  const w = new World(), a = w.a;
  w.openResult = 0x499n;
  const failed = w.open();
  assert.equal(failed.t.result, 0x499n);
  assert.deepEqual([w.state(0), w.rens.length, a.host.outs().length], ["Free", 0, 0]);
  assert.equal(a.red.at(-1), "[RED] audren: SDK OpenAudioRenderer failed 0x499");
  w.openResult = 0n;
  // no stack
  w.noMemory = true;
  assert.equal(w.open().t.result, R.OK);
  assert.deepEqual([w.state(0), w.tstate(0), w.threads.length], ["Running", "Idle", 0]);
  assert.match(a.red.at(-1)!, /^\[RED\] audren: the render thread of renderer 0 could not be started \(no memory for its stack\): only the game's updates render/);
  w.noMemory = false;
  // CreateThread refuses
  w.createResult = 0x1234n;
  assert.equal(w.open().t.result, R.OK);
  assert.deepEqual([w.state(1), w.threads.length], ["Running", 0]);
  assert.match(a.red.at(-1)!, /could not be started \(nn::os::CreateThread failed\)/);
  w.createResult = 0n;
  // close without the join
  const n = w.calls.length;
  const c = w.close(0);
  assert.ok(c.done);
  assert.deepEqual(w.calls.slice(n), [CLOSE]);
  assert.deepEqual([w.state(0), a.host.outs().length], ["Free", 1]);
  assert.ok(w.close(1).done);
  assert.equal(a.host.outs().length, 0);
  // an SDK without CreateThread
  const v = new World({ without: [TH_CREATE] });
  assert.equal(v.open().t.result, R.OK);
  assert.deepEqual([v.state(0), v.calls], ["Running", [OPEN_EV]]);
  assert.match(v.a.red.at(-1)!, /could not be started \(the SDK's malloc \/ free \/ nn::os::CreateThread/);
  // without a thread only the game's updates render: every second update a catch-up frame
  v.update(0); v.update(0); v.update(0);
  assert.deepEqual([v.rs(0, 4), v.rs(0, 6)], [2, 2]);
  assert.ok(v.close(0).done);
  assert.deepEqual([v.state(0), v.a.host.outs().length, v.a.red.length], ["Free", 0, 1]);
  assert.equal(a.x.kit_refused_total() + v.a.x.kit_refused_total(), 0);
});

test("four renderers at once, each with its own thread, output and frames; a fifth is opened by the SDK but not rendered (red); an SDK call that names only the AudioRenderSystem finds its renderer, and a system not seen yet is the one open renderer whose system is not known", () => {
  const w = new World(), a = w.a;
  for (let i = 0; i < 4; i++) assert.equal(w.open().t.result, R.OK);
  assert.deepEqual([0, 1, 2, 3].map(i => w.state(i)), ["Running", "Running", "Running", "Running"]);
  assert.deepEqual([0, 1, 2, 3].map(i => w.sink(i)), [0, 1, 2, 3]);
  // each render thread named its system at its first render
  assert.deepEqual([0, 1, 2, 3].map(i => a.x.audio_ren_stat(i, 4)), w.rens.map(r => BigInt(r.sys)));
  for (let i = 0; i < 4; i++) assert.deepEqual(w.played(i), block(721), `renderer ${i} plays its own frames`);
  const fifth = w.open();
  assert.equal(fifth.t.result, R.OK);
  // (the host has four events of its own, as nxnative: the fifth renderer's SDK keeps the game's)
  assert.deepEqual(a.red, ["[RED] audren: all renderer events in use: the SDK keeps the game's event, which must then outlive the renderer", "[RED] audren: more than 4 renderers: this one is not rendered"]);
  assert.equal(w.threads.length, 4);
  // an update of the fifth's system: no renderer of the host's, the SDK's Update alone
  const n = w.calls.length;
  assert.ok(w.update(4).done);
  assert.deepEqual(w.calls.slice(n), [UPDATE]);
  // its close goes to the SDK
  assert.ok(w.close(4).done);
  assert.ok(w.rens[4].closed);
  assert.equal(a.red.length, 2);

  // two renderers without threads: neither has rendered, so neither system is known
  const v = new World({ without: [TH_START] });
  v.open(); v.open();
  assert.deepEqual([v.a.x.audio_ren_stat(0, 4), v.a.x.audio_ren_stat(1, 4)], [0n, 0n]);
  v.update(1); v.update(1);
  assert.deepEqual([v.rs(0, 2), v.rs(1, 2)], [0, 0], "two unknown: not a guess, no catch-up frame");
  // a render of renderer 0 on a game thread (a game that executes its own renderer) cannot name it either
  const g = v.th();
  g.run(g.takeover("ar_ImplExec", [v.rens[0].impl]));
  assert.equal(g.result, R.FAIL);
  assert.equal(v.a.red.at(-1), "[RED] audren: a render of a renderer the host did not open");
  // once one is closed, the other is the one unknown
  assert.ok(v.close(0).done);
  v.update(1); v.update(1);
  assert.deepEqual([v.a.x.audio_ren_stat(1, 4), v.rs(1, 2), v.rs(1, 4)], [BigInt(v.rens[1].sys), 2, 1]);
  // and a game thread's own render of it renders into nothing
  const played = v.rs(1, 5), frames = v.rs(1, 0);
  const g2 = v.th();
  g2.run(g2.takeover("ar_ImplExec", [v.rens[1].impl]));
  assert.equal(g2.result, R.OK);
  assert.deepEqual([v.rs(1, 5), v.rs(1, 0), v.rs(1, 8)], [played, frames + 1, 1]);
});

test("the SDK 20 layout: GenerateCommand takes and returns a span (x0, x1), mode, device and command buffer are read from the system's fields, the DeviceSink is ID 0x14, the take-over is AudioRenderSystem's own ExecuteAudioRendererRendering; the update lock is in UpdateImpl (from SDK 19: Update reads the tick first)", () => {
  const w = new World({ layout: 20, lock: "tick", lockOff: 0x2d8 }), a = w.a;
  assert.equal(w.open().t.result, R.OK);
  assert.deepEqual(w.calls.slice(4, 9), [EXEC, SDK_LOCK, GEN20, SDK_UNLOCK, PROCESS]);
  assert.deepEqual(w.lockArgs.slice(0, 2), [BigInt(w.rens[0].sys + 0x2d8), -BigInt(w.rens[0].sys + 0x2d8)]);
  assert.ok(a.logs.includes("audren: AudioRenderSystem in the SDK 20 layout (update lock SdkMutexType at +0x2d8)"));
  assert.ok(!w.nested.includes(MODE) && !w.nested.includes(CBUF));
  assert.equal(a.x.audio_ren_layout() >>> 8, 0x14);
  assert.deepEqual(w.played(0), block(721));
  w.frame(0);
  assert.deepEqual(w.played(0), block(961));
  w.noRed();
});

test("nn::os::MutexType as the update lock (SDK 3 to 8): LockMutex / UnlockMutex are what the render calls", () => {
  const w = new World({ lock: "os", lockOff: 0x1d0 });
  assert.equal(w.open().t.result, R.OK);
  assert.deepEqual(w.calls.slice(4, 9), [EXEC, OS_LOCK, GEN, OS_UNLOCK, PROCESS]);
  assert.equal(w.lockArgs[0], BigInt(w.rens[0].sys + 0x1d0));
  assert.ok(w.a.logs.includes("audren: AudioRenderSystem in the SDK 16 layout (update lock nn::os::MutexType at +0x1d0)"));
  w.noRed();
});

test("the update lock read off the SDK's code (nxnative t_audren_layout test_update_lock): Update through a PLT stub or a straight bl, UpdateImpl when Update does not lock first; a miss keeps the guess and is a red line", () => {
  const read = (w: World, guess: number) => { const v = w.a.x.audio_ren_probe_lock(BigInt(guess)); return { off: Number(v & 0xffffffffn), os: !!(v & (1n << 32n)), found: !!(v & (1n << 33n)) }; };
  // before SDK 19: Update locks, and it wins over a lock in UpdateImpl
  assert.deepEqual(read(new World({ lockOff: 0x1f0 }), 1), { off: 0x1f0, os: false, found: true });
  assert.deepEqual(read(new World({ lock: "os", lockOff: 0x1f8 }), 1), { off: 0x1f8, os: true, found: true });
  // from SDK 19: Update's first call is the tick, UpdateImpl has the lock, whatever the guess
  assert.deepEqual(read(new World({ lock: "tick", lockOff: 0x2d8 }), 0x2d0), { off: 0x2d8, os: false, found: true });
  // through a PLT stub: adrp x16, page; ldr x17, [x16, #slot]; the GOT slot holds the function
  {
    const w = new World({ lockOff: 0x1f0 }), a = w.a, dv = a.dv;
    const page = (a.alloc(0x3000) + 0xfff) & ~0xfff, update = page + 0x100, stub = page + 0x200, got = page + 0x1008, lockFn = page + 0x300;
    const pages = ((got & ~0xfff) - (stub & ~0xfff)) >> 12;
    dv.setUint32(stub, (0x90000010 | (pages & 3) << 29 | ((pages >> 2) & 0x7ffff) << 5) >>> 0, true);
    dv.setUint32(stub + 4, (0xf9400211 | ((got & 0xfff) / 8) << 10) >>> 0, true);
    dv.setBigUint64(got, BigInt(lockFn), true);
    dv.setUint32(update, (0x91000000 | 0x208 << 10 | 19) >>> 0, true); dv.setUint32(update + 4, 0xaa0003e0 | 19 << 16, true);
    dv.setUint32(update + 8, (0x94000000 | ((stub - (update + 8)) >> 2)) >>> 0, true);
    a.sdkPlace(UPDATE, update); a.sdkPlace(SDK_LOCK, lockFn);
    assert.deepEqual(read(w, 1), { off: 0x208, os: false, found: true });
    dv.setBigUint64(got, BigInt(lockFn + 0x40), true);   // the slot holds something else: not the lock
    assert.deepEqual(read(w, 0x1f0), { off: 0x1f0, os: false, found: false });
    assert.equal(a.red.at(-1), "[RED] audren: no update lock read off AudioRenderSystem::Update or UpdateImpl: keeping +0x1f0, where command generation may race the game's RequestUpdate");
  }
  // neither locks first, and an SDK without UpdateImpl: the guess stays and the log says so
  {
    const w = new World({ lock: "tick", without: [UPDATE_IMPL] });
    assert.deepEqual(read(w, 0x2d0), { off: 0x2d0, os: false, found: false });
    assert.equal(w.a.red.length, 1);
  }
});

test("a renderer that is not CPU + manual, and an SDK that lacks what a render needs: the render fails as the SDK's own would (0x40299), or with a red line naming the symbol; nothing is played but silence, at the pace of the output", () => {
  const w = new World(), a = w.a;
  w.notManual = true;
  assert.equal(w.open().t.result, R.OK);
  assert.deepEqual(w.calls.slice(4), [EXEC, EXEC, EXEC, EXEC], "no lock, no command generation");
  assert.deepEqual([w.rs(0, 3), w.rs(0, 5), w.signals], [0, 4, 4]);
  assert.deepEqual(w.played(0), new Array(240).fill(0));
  const g = w.th();
  g.run(g.takeover("ar_ImplExec", [w.rens[0].impl]));
  assert.equal(g.result, RES_NOT_MANUAL);
  w.noRed();
  const v = new World({ without: [PROCESS] });
  assert.equal(v.open().t.result, R.OK);
  assert.equal(v.a.red[0], "[RED] audren: missing SDK symbol " + PROCESS);
  assert.deepEqual([v.rs(0, 3), v.rs(0, 5), v.a.red.length], [0, 4, 1]);
  // an SDK without the renderer at all: the open fails with a red line, once
  const n = new World({ without: [OPEN_EV, CLOSE, UPDATE] });
  for (let i = 0; i < 2; i++) assert.equal(n.open().t.result, R.FAIL);
  const t = n.th(); t.run(t.takeover("ar_Close", [1, 2])); assert.ok(t.done);
  const u = n.th(); u.run(u.takeover("ars_Update", [1, 2, 3, 4, 5, 6, 7])); assert.equal(u.result, R.FAIL);
  assert.deepEqual(n.a.red, [OPEN_EV, CLOSE, UPDATE].map(s => "[RED] audren: missing SDK symbol " + s));
});

// ---- the command list (nxnative dm/host/tests/t_audren_layout.c) ----
const SAMPLES = 240, NCMD = 6;
class Lists {
  a = new Au(); sink: number; mix: number; list: number;
  constructor(sdk: number) {
    this.sink = this.a.x.audio_rs_open(); this.mix = this.a.alloc(8 * SAMPLES * 4); this.list = this.a.alloc(0x20 + (NCMD + 2) * 0x148 + 16) + 1;   // an odd address: wire fields are read unaligned
    // render_once starts with ID 0x14 for SDK 20+ (the span version of GenerateCommand), 0x13 otherwise
    this.a.x.audio_ren_sink_id(sdk === 21 ? 0x14 : 0x13);
    this.fill(1000, -1000);
  }
  fill(l: number, r: number): void { const m = new Int32Array(this.a.x.memory.buffer, this.mix, 8 * SAMPLES); m.fill(l, 0, SAMPLES); m.fill(r, SAMPLES, 2 * SAMPLES); }
  put(q: number, sdk: number, id: number, size: number): number {
    const dv = this.a.dv;
    this.a.u8.fill(0, q, q + size);
    if (sdk === 21) { dv.setUint8(q, 1); dv.setUint8(q + 1, id); dv.setInt16(q + 2, size, true); }
    else {
      dv.setUint32(q, 0xcafebabe, true);
      if (sdk <= 6) { dv.setInt16(q + 4, size, true); dv.setInt16(q + 6, id, true); dv.setUint8(q + 0x10, 1); }
      else { dv.setUint8(q + 4, 1); dv.setUint8(q + 5, id); dv.setInt16(q + 6, size, true); }
    }
    return q + size;
  }
  header(ncmd: number): void { const dv = this.a.dv, l = this.list; this.a.u8.fill(0, l, l + 0x20); dv.setUint32(l + 4, ncmd, true); dv.setBigUint64(l + 8, BigInt(this.mix), true); dv.setUint32(l + 0x14, SAMPLES, true); dv.setUint32(l + 0x18, 48000, true); }
  // ncmd - 1 filler commands and the DeviceSink of that SDK, inputs 0 and 1; returns the list's length
  build(sdk: number, ncmd: number): number {
    const dv = this.a.dv;
    this.header(ncmd);
    let q = this.list + 0x20;
    for (let i = 0; i < ncmd - 1; i++) q = this.put(q, sdk, 6, 0x40);
    const id = sdk <= 5 ? 0xf : sdk === 6 ? 0x10 : sdk === 21 ? 0x14 : 0x13, sink = q;
    q = this.put(q, sdk, id, sdk === 4 ? 0x130 : sdk === 5 ? 0x138 : sdk === 21 ? 0x140 : 0x148);
    const count = sdk <= 5 ? 0x120 : sdk === 21 ? 0x128 : 0x130;
    dv.setUint32(sink + count, 2, true);
    if (sdk === 4) { dv.setUint8(sink + 0x124, 0); dv.setUint8(sink + 0x125, 1); }
    else { dv.setInt16(sink + count + 4, 0, true); dv.setInt16(sink + count + 6, 1, true); }
    return q - this.list;
  }
  capture(len: number): number { return this.a.x.audio_ren_capture(this.sink, 0, this.list, len); }
  layout(): { done: boolean; hdr6: boolean; hdr21: boolean; sink4: boolean; sink5: boolean; id: number } { const v = this.a.x.audio_ren_layout(); return { done: !!(v & 1), hdr6: !!(v & 2), hdr21: !!(v & 4), sink4: !!(v & 8), sink5: !!(v & 16), id: v >>> 8 }; }
}
// A captured frame goes to the sink's frame: hand it to the output and read the block
function stereo(L: Lists, len: number): { n: number; pcm: Int16Array } {
  const x = L.a.x;
  if (!x.audio_rs_ready(L.sink)) { L.a.toDeadline(); assert.equal(x.audio_rs_ready(L.sink), 1); }
  assert.equal(x.audio_rs_next(L.sink), 1);
  const n = L.capture(len);
  x.audio_rs_rendered(L.sink);
  return { n, pcm: new Int16Array(x.memory.buffer.slice(x.audio_rs_played_ptr(L.sink) >>> 0, (x.audio_rs_played_ptr(L.sink) >>> 0) + x.audio_rs_played_frames(L.sink) * 4)) };
}
const isStereo = (pcm: Int16Array, l: number, r: number) => pcm.length === SAMPLES * 2 && pcm.every((v, i) => v === (i & 1 ? r : l));

for (const sdk of [4, 5, 6, 16, 21]) for (const incomplete of [false, true]) {
  test(`command list, SDK ${sdk} wire layout${incomplete ? ", after start-up lists with a zeroed command" : ""}: the header layout is taken from the first list that walks in exactly one layout, the DeviceSink is found by ID or by its size, and its two inputs come out as stereo PCM16`, () => {
    const L = new Lists(sdk);
    // an empty start-up list chooses no layout
    L.build(sdk, NCMD); L.a.dv.setUint32(L.list + 4, 0, true);
    assert.equal(L.capture(0x20), 0);
    if (incomplete) {
      // the third command is zeroed, as a first list generated before the game's first update can be: several such frames leave detection open
      const n = L.build(sdk, NCMD);
      L.a.u8.fill(0, L.list + 0x20 + 2 * 0x40, L.list + 0x20 + 3 * 0x40);
      for (let i = 0; i < 3; i++) assert.equal(L.capture(n), 0);
      assert.deepEqual(L.layout(), { done: false, hdr6: false, hdr21: false, sink4: false, sink5: false, id: sdk === 21 ? 0x14 : 0x13 });
      assert.equal(L.a.logs.filter(l => l.includes("walks in no header layout")).length, 1);
    }
    if (sdk === 5) {
      // a first list of two commands with the SDK 6 header, the first of ID 0x14 and 0x14 bytes, then one of ID 0xa and 0x28 bytes: in the SDK 8-20 layout the IDs read as sizes and both still walk
      L.header(2);
      const q = L.put(L.put(L.list + 0x20, 5, 0x14, 0x14), 5, 0xa, 0x28);
      assert.equal(L.capture(q - L.list), 0);
      assert.equal(L.layout().done, false);
      if (!incomplete) assert.ok(L.a.logs.some(l => l.includes("walks in more than one header layout")));
    }
    // SDK 21 starts with short valid lists: its header is detected before the first full list's sink scan
    let s = stereo(L, L.build(sdk, sdk === 21 ? 2 : NCMD));
    assert.deepEqual(L.layout(), { done: true, hdr6: sdk <= 6, hdr21: sdk === 21, sink4: sdk <= 5, sink5: sdk === 5, id: sdk <= 5 ? 0xf : sdk === 6 ? 0x10 : sdk === 21 ? 0x14 : 0x13 });
    assert.equal(s.n, SAMPLES);
    assert.ok(isStereo(s.pcm, 1000, -1000));
    // detection stays valid for later full frames, with other samples
    L.fill(-32768 - 5, 40000);
    s = stereo(L, L.build(sdk, NCMD));
    assert.equal(s.n, SAMPLES);
    assert.ok(isStereo(s.pcm, -32768, 32767), "clamped to 16 bits");
    assert.deepEqual(L.a.red, []);
  });
}
for (const sdk of [4, 5, 6, 16, 21]) for (const bad of [0, 1, 2]) {
  test(`command list, SDK ${sdk}: a malformed list after the layout is chosen (${["its first command zeroed", "its second command zeroed", "one command more than the list holds"][bad]}) gives no PCM even when a valid sink precedes the damage, and leaves the sink scan for the next whole list`, () => {
    const L = new Lists(sdk);
    L.build(sdk, NCMD); L.a.dv.setUint32(L.list + 4, 1, true);
    assert.equal(L.capture(0x20 + 0x40), 0);   // one filler command: the layout is chosen, no sink, no histogram
    assert.equal(L.layout().done, true);
    const id = L.layout().id;
    let n = L.build(sdk, NCMD);
    if (bad < 2) L.a.u8.fill(0, L.list + 0x20 + bad * 0x40, L.list + 0x20 + (bad + 1) * 0x40);
    else { L.a.dv.setUint32(L.list + 4, NCMD + 1, true); L.a.u8.fill(0, L.list + n, L.list + n + 0x40); n += 0x40; }
    const s = stereo(L, n);
    assert.equal(s.n, 0);
    assert.ok(s.pcm.every(v => v === 0), "silence");
    assert.ok(!L.a.logs.some(l => l.includes("by command ID:")));
    assert.match(L.a.red[0], /^\[RED\] audren: command \d in the command list is malformed \(offset 0x[0-9a-f]+, list 0x[0-9a-f]+ bytes\)$/);
    assert.deepEqual([L.layout().id, L.layout().sink4, L.layout().sink5], [id, false, false]);
    // a following whole list still discovers the sink
    L.fill(700, -900);
    const ok = stereo(L, L.build(sdk, NCMD));
    assert.equal(ok.n, SAMPLES); assert.ok(isStereo(ok.pcm, 700, -900));
    // and validation applies after the histogram was logged too
    n = L.build(sdk, NCMD); L.a.dv.setUint32(L.list + 4, NCMD + 1, true); L.a.u8.fill(0, L.list + n, L.list + n + 0x40);
    assert.equal(L.capture(n + 0x40), 0);
    assert.equal(L.a.red.length, 1, "the red line once");
  });
}

test("command list: truncated headers and bodies and impossible sizes are refused before any field is read; a sink with another ID is taken by its size (SDK 8: 0x10); a list without a DeviceSink is a red line; a disabled sink, a sink without inputs and a rate the SDK does not have give silence; six inputs are downmixed; 32 kHz is resampled to 48 kHz", () => {
  for (const sdk of [4, 6, 16, 21]) {
    const L = new Lists(sdk), n = L.build(sdk, 2), sinkLen = n - 0x60;
    // cut anywhere inside the list: nothing captured, no layout chosen from a list that does not walk
    for (let cut = 0; cut < n; cut += cut < 0x70 ? 1 : 0x33) assert.equal(L.capture(cut), 0, `SDK ${sdk} cut at ${cut}`);
    assert.equal(L.layout().done, false);
    for (const size of [0, -1, 4, sinkLen + 1]) {
      L.build(sdk, 2);
      L.a.dv.setInt16(L.list + 0x60 + (sdk === 21 ? 2 : sdk <= 6 ? 4 : 6), size, true);
      assert.equal(L.capture(n), 0, `SDK ${sdk} size ${size}`);
    }
    assert.equal(L.layout().done, false);
  }
  // SDK 8: four commands fewer before the sink, so it is ID 0x10 in the 0x148-byte layout
  {
    const L = new Lists(16), dv = L.a.dv;
    const n = L.build(16, NCMD);
    dv.setUint8(L.list + 0x20 + 5 * 0x40 + 5, 0x10);
    const s = stereo(L, n);
    assert.equal(s.n, SAMPLES);
    assert.ok(L.a.logs.includes("audren: no command with ID 0x13 in the command list; the only 0x148-byte command is ID 0x10, taking it as DeviceSink"));
    assert.equal(L.layout().id, 0x10);
    // disabled: silence
    L.build(16, NCMD); dv.setUint8(L.list + 0x20 + 5 * 0x40 + 5, 0x10); dv.setUint8(L.list + 0x20 + 5 * 0x40 + 4, 0);
    assert.equal(L.capture(n), 0);
    // no inputs
    L.build(16, NCMD); dv.setUint8(L.list + 0x20 + 5 * 0x40 + 5, 0x10); dv.setUint32(L.list + 0x20 + 5 * 0x40 + 0x130, 0, true);
    assert.equal(L.capture(n), 0);
    // 44.1 kHz: the SDK takes 32000 or 48000
    L.build(16, NCMD); dv.setUint8(L.list + 0x20 + 5 * 0x40 + 5, 0x10); dv.setUint32(L.list + 0x18, 44100, true);
    assert.equal(L.capture(n), 0); assert.equal(L.capture(n), 0);
    assert.deepEqual(L.a.red, ["[RED] audren: renderer sample rate 44100 (the SDK takes 32000 or 48000): no sound"]);
  }
  // no sink at all
  {
    const L = new Lists(16);
    L.header(NCMD);
    let q = L.list + 0x20;
    for (let i = 0; i < NCMD; i++) q = L.put(q, 16, 6, 0x40);
    assert.equal(L.capture(q - L.list), 0);
    assert.deepEqual(L.a.red, ["[RED] audren: no DeviceSink (ID 0x13) in the command list, 0 commands of 0x148 bytes: the game will have no sound"]);
    assert.ok(L.a.logs.includes("audren: first-frame commands 6, by command ID: 6x6"));
  }
  // six inputs (front left, front right, centre, LFE, back left, back right) from mix buffers 2..7: the system's downmix
  {
    const L = new Lists(16), dv = L.a.dv, n = L.build(16, NCMD), sink = L.list + 0x20 + 5 * 0x40;
    dv.setUint32(sink + 0x130, 6, true);
    for (let j = 0; j < 6; j++) dv.setInt16(sink + 0x134 + 2 * j, 2 + j, true);
    const m = new Int32Array(L.a.x.memory.buffer, L.mix, 8 * SAMPLES), v = [1000, 2000, 3000, 4000, 5000, 6000];
    v.forEach((x, j) => m.fill(x, (2 + j) * SAMPLES, (3 + j) * SAMPLES));
    const s = stereo(L, n), c = 3000 * 23167 + 4000 * 8224;
    assert.ok(isStereo(s.pcm, (1000 * 32768 + c + 5000 * 23167) >> 15, (2000 * 32768 + c + 6000 * 23167) >> 15));
  }
  // a renderer at 32 kHz: 160 samples per frame become 240
  {
    const L = new Lists(16), dv = L.a.dv;
    const m = new Int32Array(L.a.x.memory.buffer, L.mix, 8 * SAMPLES);
    let got = 0, last: Int16Array = new Int16Array(0);
    for (let f = 0; f < 4; f++) {
      const n = L.build(16, NCMD);
      dv.setUint32(L.list + 0x14, 160, true); dv.setUint32(L.list + 0x18, 32000, true);
      m.fill(8000, 0, 160); m.fill(-8000, 160, 320);
      const s = stereo(L, n); got += s.n; last = s.pcm;
    }
    assert.equal(got, 4 * 240);
    assert.ok(last.every((v, i) => Math.abs(v - (i & 1 ? -8000 : 8000)) <= 1), "a constant comes out as the constant");
    assert.ok(L.a.logs.some(l => l.endsWith("(32 kHz: resampled to 48 kHz on the host)")));
    assert.deepEqual(L.a.red, []);
  }
});

test("command list: the first full list's line of commands by ID is bounded however many IDs there are", () => {
  const L = new Au(), COUNT = 6400, SIZE = 8, len = 0x20 + COUNT * SIZE, cl = L.alloc(len), dv = L.dv;
  dv.setUint32(cl + 4, COUNT, true);
  for (let i = 0; i < COUNT; i++) { const q = cl + 0x20 + i * SIZE; dv.setUint32(q, 0xcafebabe, true); dv.setUint8(q + 5, i / 100 | 0); dv.setInt16(q + 6, SIZE, true); }   // disabled: no sink payload is read
  assert.equal(L.x.audio_ren_capture(L.x.audio_rs_open(), 0, cl, len), 0);
  const line = L.logs.find(l => l.includes("by command ID:"))!;
  assert.ok(line.startsWith("audren: first-frame commands 6400, by command ID: 0x100 1x100 ") && line.endsWith(" ...") && line.length < 512, line);
});
