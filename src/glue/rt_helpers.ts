// Helper Workers ("stage 3" of threads; src/runtime/README.md, "Helper Workers"): a compute-bound guest thread runs
// its translated code on another Worker over the one shared memory, for the slices in which it needs nothing from the
// kernel or the host. Everything else stays where it was: the kernel, the take-over table, graphics, files and audio
// are AssemblyScript modules whose state is per-instance wasm globals, so they exist once, on the runtime's Worker.
//
// This file is both halves of the mechanism and no policy (which thread goes out and when is rt_runtime.ts):
//   HelperPool   the runtime's side: the workers, the mailbox, the unit registry's sender
//   helperBody   a helper's side: its own table, core instance (= CPU state), helpers instance and, lazily, its own
//                instance of each translated unit at the same table indices; one job = load_ctx, run, save_ctx
//
// The mailbox is one SharedArrayBuffer. The runtime posts a job (a context block address and a budget) and the helper
// answers with an exit record; both wake the other with Atomics.notify. Units travel as messages
// ({ module, table base, count }: a WebAssembly.Module is structured-cloneable), and a job says how many messages the
// helper must have seen before it may run, so a helper never runs with an older registry than the pc map it reads.
// A context block has one owner: the helper from the job's post to the exit record, the runtime otherwise.
// No Node APIs.
import { A64Host } from "./a64_host.ts";

export interface HelperPort { postMessage(msg: unknown): void; terminate(): void }
export type HelperSpawn = (k: number) => HelperPort;

// why a helper gave a thread back
export const EXIT = { svc: 1, budget: 2, hostCall: 3, counter: 4, needUnit: 5, trap: 6, unimpl: 7, brk: 8, stack: 9, hostError: 10, pc: 11 } as const;
export const EXIT_NAMES = ["", "svc", "slice end", "host call", "counter read", "unit needed", "trap", "unimplemented", "brk", "stack", "host error", "special pc"];

// ---- mailbox layout (bytes) ----
// header: i32 @0 exit signal (every exit adds 1 and notifies), @4 clock valid, @8 Switch 2 tick scale; i64 @16 the
// guest clock's lag (host ns - guest ns); f64 @24 the absolute ms (timeOrigin + now) at which host ns was 0
const HDR = 64, BLOCK = 512, TEXT = 192, TEXT_CAP = BLOCK - TEXT;
// per helper, i32 index within its block
const JOB = 0, STATE = 1, RECALL = 2, REASON = 3, AUX = 4, RECV = 5, CAP = 6, NEED = 7, BUDGET = 8, MAXSL = 9, SLICES = 10, TEXTLEN = 11, INST = 12, LEFT = 13, FLAGS = 14, FIRST = 15;
// ... 8-byte slot index within its block (from byte 64)
const Q_CTX = 8, Q_PC = 9, Q_AUX = 10, Q_FUNC = 11, Q_OFF = 12, F_UNITS = 13, F_RUNMS = 14, F_INSTMS = 15, Q_NOW = 16, F_BUSYMS = 17;
const ST_START = 0, ST_IDLE = 1, ST_RUN = 2, ST_DONE = 3, ST_FAILED = 9;
const HEADROOM = 1 << 17;   // table slots a helper keeps beyond the last unit it knows (the runtime's table may grow while it runs)
const SPIN_MS = 0.25;       // after an exit a helper waits this long for its next job before it goes back to its event loop

export interface HelperExit {
  helper: number; ctx: number; core: number; index: number;
  reason: number; aux: number; pc: bigint; aux64: bigint;
  units: number; left: number; slices: number; runMs: number; nowNs: bigint;
  text: string; frame?: { funcPc: number; offset: number };
  again: boolean;                     // unit needed: asked for at this pc before and still missing there
}
interface Slot { ctx: number; core: number; index: number; recalled: boolean; jobs: number; since: number }

export class HelperPool {
  readonly n: number;
  private sab: SharedArrayBuffer;
  private i32: Int32Array; private big: BigInt64Array; private f64: Float64Array; private u8: Uint8Array;
  private ports: HelperPort[] = [];
  private slot: Slot[] = [];
  private sent = 0;          // registry messages posted so far (units, cleared slots)
  private seen = 0;          // the exit signal as of the last mark()
  busyCount = 0;
  private dead = false;
  readonly t0 = performance.now();

  constructor(o: { n: number; spawn: HelperSpawn; a64: A64Host; thunkModule: WebAssembly.Module; thunk: number; pcYield: bigint; scratch: number[] }) {
    this.n = o.n;
    this.sab = new SharedArrayBuffer(HDR + BLOCK * o.n);
    this.i32 = new Int32Array(this.sab); this.big = new BigInt64Array(this.sab); this.f64 = new Float64Array(this.sab); this.u8 = new Uint8Array(this.sab);
    const a = o.a64, lay = a.layoutInfo;
    for (let k = 0; k < o.n; k++) {
      this.slot.push({ ctx: 0, core: -1, index: -1, recalled: false, jobs: 0, since: 0 });
      const p = o.spawn(k);
      this.ports.push(p);
      p.postMessage({ t: "init", k, mailbox: this.sab, memory: a.memory, mem64: a.mem64, core: a.coreModule, helpers: a.helpersModule, thunkModule: o.thunkModule, thunk: o.thunk,
        tableLen: a.table.length, pcmapBase: lay.pcmapBase, span: lay.span, guardBase: lay.guardBase, scratch: o.scratch[k], pcYield: o.pcYield });
    }
  }
  private b(k: number): number { return (HDR + BLOCK * k) >> 2; }
  private q(k: number): number { return (HDR + BLOCK * k) >> 3; }

  // ---- the unit registry's sender ----
  publish(base: number, count: number, mod: WebAssembly.Module): void { this.sent++; for (const p of this.ports) p.postMessage({ t: "unit", base, n: count, mod }); }
  cleared(base: number, len: number): void { this.sent++; for (const p of this.ports) p.postMessage({ t: "slots", base, len }); }

  // ---- the guest clock, for counter reads on a helper (valid false: a read comes back to the runtime) ----
  setClock(valid: boolean, lag: bigint, switch2: boolean, originAbsMs: number): void {
    Atomics.store(this.i32, 1, 0);
    this.big[2] = lag; this.f64[3] = originAbsMs; this.i32[2] = switch2 ? 1 : 0;
    if (valid) Atomics.store(this.i32, 1, 1);
  }

  // ---- jobs ----
  state(k: number): number { return Atomics.load(this.i32, this.b(k) + STATE); }
  get readyCount(): number { let n = 0; for (let k = 0; k < this.n; k++) { const s = this.state(k); if (s !== ST_START && s !== ST_FAILED) n++; } return n; }
  get failed(): number[] { const f: number[] = []; for (let k = 0; k < this.n; k++) if (this.state(k) === ST_FAILED) f.push(k); return f; }
  failText(k: number): string { return this.text(k); }
  // a helper that is ready and has no thread, -1 when none
  idle(): number { if (this.dead) return -1; for (let k = 0; k < this.n; k++) if (!this.slot[k].ctx && this.state(k) === ST_IDLE) return k; return -1; }
  busy(k: number): boolean { return this.slot[k].ctx !== 0; }
  slotOf(k: number): Readonly<Slot> { return this.slot[k]; }
  // the table length helper k has room for (as of the last registry message it handled)
  cap(k: number): number { return Atomics.load(this.i32, this.b(k) + CAP); }
  dispatch(k: number, ctx: number, core: number, index: number, budget: number, first: number, maxSlices: number, nowNs: bigint): void {
    const s = this.slot[k], b = this.b(k), q = this.q(k);
    if (s.ctx) throw new Error(`runtime: helper ${k} already has a thread`);
    s.ctx = ctx; s.core = core; s.index = index; s.recalled = false; s.jobs++; s.since = performance.now();
    this.busyCount++;
    this.big[q + Q_CTX] = BigInt(ctx); this.big[q + Q_NOW] = nowNs;
    this.i32[b + NEED] = this.sent; this.i32[b + BUDGET] = budget; this.i32[b + FIRST] = first; this.i32[b + MAXSL] = maxSlices;
    Atomics.store(this.i32, b + RECALL, 0);
    Atomics.store(this.i32, b + STATE, ST_RUN);
    Atomics.add(this.i32, b + JOB, 1);
    Atomics.notify(this.i32, b + JOB);
  }
  // ask helper k for its thread: it answers at the end of the slice it is in
  recall(k: number): void { const s = this.slot[k]; if (s.ctx && !s.recalled) { s.recalled = true; Atomics.store(this.i32, this.b(k) + RECALL, 1); } }
  // remember the exit signal: wait() returns at once when an exit came after this
  mark(): void { this.seen = Atomics.load(this.i32, 0); }
  done(k: number): boolean { return this.slot[k].ctx !== 0 && this.state(k) === ST_DONE; }
  // the exit record of a helper that is done; its thread's context block is the runtime's again
  take(k: number): HelperExit {
    const s = this.slot[k], b = this.b(k), q = this.q(k), i = this.i32;
    const flags = i[b + FLAGS];
    const x: HelperExit = { helper: k, ctx: s.ctx, core: s.core, index: s.index, reason: i[b + REASON], aux: i[b + AUX], pc: BigInt.asUintN(64, this.big[q + Q_PC]), aux64: BigInt.asUintN(64, this.big[q + Q_AUX]),
      units: this.f64[q + F_UNITS], left: i[b + LEFT], slices: i[b + SLICES], runMs: this.f64[q + F_RUNMS], nowNs: this.big[q + Q_NOW], text: i[b + TEXTLEN] ? this.text(k) : "",
      frame: flags & 1 ? { funcPc: Number(this.big[q + Q_FUNC]), offset: Number(this.big[q + Q_OFF]) } : undefined, again: (flags & 2) !== 0 };
    s.ctx = 0; s.core = -1; s.index = -1;
    this.busyCount--;
    Atomics.store(i, b + STATE, ST_IDLE);
    return x;
  }
  private text(k: number): string {
    const at = HDR + BLOCK * k + TEXT, n = Math.min(TEXT_CAP, this.i32[this.b(k) + TEXTLEN]);
    return new TextDecoder().decode(this.u8.slice(at, at + n));
  }
  // Block until a helper posts an exit or ms have passed (the runtime's own Worker: never the page's main thread)
  wait(ms: number): void {
    if (ms <= 0) return;
    try { Atomics.wait(this.i32, 0, this.seen, ms); } catch { const end = performance.now() + Math.min(ms, 1); while (performance.now() < end && Atomics.load(this.i32, 0) === this.seen) { /* no blocking wait on this thread */ } }
  }
  // ... the same without blocking: resolves at the next exit (null: one came already, or the engine has no waitAsync)
  waitAsync(): Promise<unknown> | null {
    const wa = (Atomics as any).waitAsync;
    if (typeof wa !== "function") return null;
    const r = wa(this.i32, 0, this.seen);
    return r.async ? r.value : null;
  }
  get exitSignal(): number { return Atomics.load(this.i32, 0); }
  // per helper: jobs run, ms inside translated code, units it instantiated and the ms that took
  stats(k: number): { jobs: number; busyMs: number; units: number; instMs: number } {
    const b = this.b(k), q = this.q(k);
    return { jobs: this.slot[k].jobs, busyMs: this.f64[q + F_BUSYMS], units: this.i32[b + INST], instMs: this.f64[q + F_INSTMS] };
  }
  terminate(): void { this.dead = true; for (const p of this.ports) { try { p.terminate(); } catch { /* gone already */ } } }
}

// ---- a helper's side ----
// Returns the handler of the messages the runtime posts (init, unit, slots). `fail` is told what went wrong outside a
// job (the mailbox also says so, which is what the runtime reads).
export function helperBody(fail: (text: string) => void = () => {}): (msg: any) => void {
  let i32: Int32Array, big: BigInt64Array, f64: Float64Array, u8: Uint8Array, b = 0, q = 0, textAt = 0;
  let core: any, table: WebAssembly.Table, tramp: unknown, hlp: Record<string, unknown>, unitEnv: Record<string, unknown>;
  let memory: WebAssembly.Memory, m64 = false, pcmapBase = 0, span = 0, PC_YIELD = 0n;
  let save: (p: number) => void, load: (p: number) => void;
  const bases: number[] = [], units: { base: number; n: number; mod: WebAssembly.Module; live: boolean }[] = [];   // the registry, sorted by table base
  let received = 0, lastJob = 0, running = false, armed = false, ready = false;
  // the job in hand
  let ctx = 0, reason = 0, aux = 0, aux64 = 0n, left = 0, lastNs = 0n, needPc = -1, needN = 0;
  let instMs = 0, inst = 0, busyMs = 0;

  const setText = (s: string) => { const t = new TextEncoder().encode(s).subarray(0, TEXT_CAP); u8.set(t, textAt); i32[b + TEXTLEN] = t.length; };
  const find = (idx: number) => {
    let lo = 0, hi = bases.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bases[mid] <= idx) lo = mid + 1; else hi = mid; }
    const u = lo ? units[lo - 1] : undefined;
    return u && idx < u.base + u.n ? u : undefined;
  };
  // the pc map (two levels; src/a64/README.md) read from the shared memory: pc -> table index, 0 = not translated
  const pcMap = (pc: number): number => {
    const dv = new DataView(memory.buffer), page = Math.floor(pc / 65536);
    if (!m64) return dv.getUint32(dv.getUint32(pcmapBase + page * 4, true) + (pc % 65536 & 0xFFFC), true);
    if (pc >= span || pc < 0) return 0;
    return dv.getUint32(Number(dv.getBigUint64(pcmapBase + page * 8, true)) + ((pc - page * 65536) & 0xFFFC), true);
  };
  // The core's `translate` import: the pc map has no function for pc, or it names a slot this helper has not filled
  // (every empty slot holds the trampoline). A unit of the registry is instantiated here, on first use; anything
  // else is the runtime's business: the slice ends with pc as it is.
  const translate = (pcBig: bigint): number => {
    const pc = m64 ? Number(BigInt.asUintN(64, pcBig)) : Number(pcBig & 0xFFFFFFFFn);
    const idx = pcMap(pc);
    if (idx > 1) {
      const u = find(idx);
      if (u && !u.live) {
        const t0 = performance.now();
        new WebAssembly.Instance(u.mod, { cpu: core, hlp, env: { ...unitEnv, table_base: new WebAssembly.Global({ value: "i32", mutable: false }, u.base) } } as WebAssembly.Imports);
        u.live = true; inst++; instMs += performance.now() - t0;
        return idx;
      }
      if (idx < table.length && table.get(idx) !== tramp) return idx;
    }
    left = core.budget.value; reason = EXIT.needUnit;
    return A64Host.STOP;
  };

  function init(m: any): void {
    const sab: SharedArrayBuffer = m.mailbox;
    i32 = new Int32Array(sab); big = new BigInt64Array(sab); f64 = new Float64Array(sab); u8 = new Uint8Array(sab);
    b = (HDR + BLOCK * m.k) >> 2; q = (HDR + BLOCK * m.k) >> 3; textAt = HDR + BLOCK * m.k + TEXT;
    try {
      memory = m.memory; m64 = !!m.mem64; pcmapBase = m.pcmapBase; span = m.span; PC_YIELD = m.pcYield;
      table = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
      core = new WebAssembly.Instance(m.core, { env: { memory, table, translate } }).exports;
      const hx = new WebAssembly.Instance(m.helpers, { env: { memory, abort: () => { throw new Error("a64 helpers abort"); } } }).exports as any;
      if (!m.scratch || !hx.setScratch) throw new Error("no scratch blocks for this helper's instance of the a64 helpers");
      hx.setScratch(m64 ? BigInt(m.scratch) : m.scratch);
      hx.libcGuard(BigInt(m.guardBase));
      const { staticBase: _b, staticEnd: _e, memory: _m, libcStat: _s, libcGuard: _g, setScratch: _sc, SCRATCH_BYTES: _sb, ...hfuncs } = hx;
      hlp = hfuncs;
      save = m64 ? (p: number) => core.save_ctx(BigInt(p)) : core.save_ctx;
      load = m64 ? (p: number) => core.load_ctx(BigInt(p)) : core.load_ctx;
      tramp = table.get(0);
      table.grow(m.tableLen + HEADROOM - table.length, tramp);
      // an SVC: the registers are written back and pc is the instruction after it. The kernel is the runtime's.
      const svc = (n: number) => { left = core.budget.value; save(ctx); reason = EXIT.svc; aux = n; core.pc.value = PC_YIELD; };
      // `mrs cntpct_el0` (the translator's cntYield: written back, pc = the instruction): answered here from the
      // clock the runtime published, never earlier than the job's start or this thread's last read
      const cntpct = (): bigint => {
        if (Atomics.load(i32, 1) === 1) {
          let ns = BigInt(Math.round((performance.timeOrigin + performance.now() - f64[3]) * 1e6));
          if (ns < lastNs) ns = lastNs; else lastNs = ns;
          const g = BigInt.asUintN(64, ns - big[2]);
          if (Atomics.load(i32, 1) === 1) return i32[2] ? g / 32n : g * 12n / 625n;
        }
        left = core.budget.value; save(ctx); reason = EXIT.counter; core.pc.value = PC_YIELD;
        return 0n;
      };
      const unimpl = (pc: bigint, insn: number) => { if (!reason) { reason = EXIT.unimpl; aux = insn; aux64 = pc; } };
      const brk = (pc: bigint, imm: number) => { if (!reason) { reason = EXIT.brk; aux = imm; aux64 = pc; } };
      unitEnv = { memory, table, svc, unimpl, brk, cntpct };
      // a host function's stub: pc is the stub's address and the registers are written back
      const hostCall = () => { left = core.budget.value; save(ctx); reason = EXIT.hostCall; core.pc.value = PC_YIELD; };
      table.set(m.thunk, new WebAssembly.Instance(m.thunkModule, { env: { host_call: hostCall } }).exports.f as any);
      Atomics.store(i32, b + CAP, table.length);
      ready = true;
      Atomics.store(i32, b + STATE, ST_IDLE);
      Atomics.add(i32, 0, 1); Atomics.notify(i32, 0);
    } catch (e) {
      const t = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setText(t); Atomics.store(i32, b + STATE, ST_FAILED); fail(t);
    }
  }

  function runJob(): void {
    const budget = i32[b + BUDGET], maxSlices = i32[b + MAXSL];
    let first = i32[b + FIRST];
    ctx = Number(big[q + Q_CTX]); lastNs = big[q + Q_NOW];
    reason = 0; aux = 0; aux64 = 0n; i32[b + TEXTLEN] = 0; i32[b + FLAGS] = 0;
    let units = 0, slices = 0;
    const t0 = performance.now();
    load(ctx);
    core.excl_addr.value = -1n;
    try {
      for (;;) {
        const give = first > 0 ? first : budget;
        first = 0;
        core.budget.value = give; left = -2;
        core.run();
        if (left === -2) left = core.budget.value;
        units += give - (left < 0 ? 0 : left);
        if (reason) break;
        const pc: bigint = core.pc.value;
        if (pc >= 0xFFFFFF00n && (!m64 || pc <= 0xFFFFFFFFn)) { reason = EXIT.pc; break; }
        slices++;
        if (left >= 0 || Atomics.load(i32, b + RECALL) || slices >= maxSlices) { reason = EXIT.budget; break; }
      }
    } catch (e) {
      if (left === -2) left = 0;
      if (reason !== EXIT.unimpl && reason !== EXIT.brk) {
        const fr = e instanceof WebAssembly.RuntimeError ? A64Host.frameOf(e) : undefined;
        reason = e instanceof WebAssembly.RuntimeError ? EXIT.trap : e instanceof RangeError ? EXIT.stack : EXIT.hostError;
        setText(reason === EXIT.hostError ? (e instanceof Error ? `${e.name}: ${e.message}` : String(e)) : (e as Error).message);
        if (fr) { big[q + Q_FUNC] = BigInt(fr.funcPc); big[q + Q_OFF] = BigInt(fr.offset); i32[b + FLAGS] = 1; }
      }
    }
    // the registers go back into the thread's context block, unless an import saved them where it stood
    if (core.pc.value !== PC_YIELD) save(ctx);
    // a unit this helper asked for twice in a row at one pc: the runtime takes the thread instead of answering again
    if (reason === EXIT.needUnit) { const p = Number(BigInt.asUintN(64, core.pc.value)); if (p === needPc) needN++; else { needPc = p; needN = 1; } if (needN > 2) i32[b + FLAGS] |= 2; } else needN = 0;
    const dt = performance.now() - t0;
    busyMs += dt;
    big[q + Q_PC] = BigInt.asIntN(64, reason === EXIT.svc || reason === EXIT.counter || reason === EXIT.hostCall ? 0n : core.pc.value); big[q + Q_AUX] = BigInt.asIntN(64, aux64); big[q + Q_NOW] = lastNs;
    i32[b + REASON] = reason; i32[b + AUX] = aux; i32[b + LEFT] = left; i32[b + SLICES] = slices; i32[b + INST] = inst;
    f64[q + F_UNITS] = units; f64[q + F_RUNMS] = dt; f64[q + F_INSTMS] = instMs; f64[q + F_BUSYMS] = busyMs;
    Atomics.store(i32, b + STATE, ST_DONE);
    Atomics.add(i32, 0, 1); Atomics.notify(i32, 0);
  }

  // Run the posted job if there is one and the registry is as new as the job asks; then wait for the next: a short
  // blocking wait (the same thread's next slice usually comes at once), then from the event loop, where registry
  // messages arrive.
  function pump(): void {
    if (running || !ready) return;
    running = true;
    try {
      let spin = false;
      for (;;) {
        const seq = Atomics.load(i32, b + JOB);
        if (seq !== lastJob) {
          if (i32[b + NEED] > received) break;   // a registry message is still on its way: it calls pump() again
          lastJob = seq;
          runJob();
          spin = true;
          continue;
        }
        if (spin) { spin = false; if (Atomics.wait(i32, b + JOB, lastJob, SPIN_MS) !== "timed-out") continue; }
        if (!armed) {
          const wa = (Atomics as any).waitAsync;
          if (typeof wa === "function") {
            const r = wa(i32, b + JOB, lastJob);
            if (!r.async) continue;
            armed = true;
            r.value.then(() => { armed = false; pump(); });
          } else { armed = true; setTimeout(() => { armed = false; pump(); }, 1); }
        }
        break;
      }
    } finally { running = false; }
  }

  return (m: any) => {
    if (m.t === "init") { init(m); pump(); return; }
    if (!ready) return;
    if (m.t === "unit") {
      let lo = 0, hi = bases.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (bases[mid] < m.base) lo = mid + 1; else hi = mid; }
      bases.splice(lo, 0, m.base); units.splice(lo, 0, { base: m.base, n: m.n, mod: m.mod, live: false });
      if (m.base + m.n + HEADROOM > table.length) table.grow(m.base + m.n + HEADROOM - table.length, tramp);
    } else if (m.t === "slots") {
      // the runtime dropped translations (a module unloaded, code rewritten): the slots are the trampoline again and
      // a unit that lies wholly in them leaves the registry
      for (let i = m.base; i < m.base + m.len && i < table.length; i++) table.set(i, tramp as any);
      for (let k = units.length - 1; k >= 0; k--) if (units[k].base >= m.base && units[k].base + units[k].n <= m.base + m.len) { units.splice(k, 1); bases.splice(k, 1); }
    } else return;
    received++;
    Atomics.store(i32, b + CAP, table.length);
    Atomics.store(i32, b + RECV, received);
    pump();
  };
}
