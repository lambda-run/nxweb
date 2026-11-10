// EXPERIMENTAL (spike, see SPIKE.md). One host thread's share of a guest process: a kernel instance, a translator
// instance, a core module instance and the run loop. No Node or DOM APIs: worker_node.mts and worker_web.ts wrap it.
//
// Three configurations, one code path:
//   unshared   today's binaries (build/runtime/kernel.wasm, translator.wasm, helpers.wasm) on an unshared memory,
//              green threads on the deterministic clock. One engine.
//   shared, workers = 0   the mtify'd shared-memory binaries, still green threads, deterministic clock. One engine.
//              (what the shared mode costs a single thread: atomic exclusives, the real kernel lock's code path)
//   shared, workers = N   N engines on N Workers; engine w runs the virtual cores c with c % N == w; wall clock.
import { A64, range } from "../glue/rt_layout.ts";
import { A64MT, type UnitMsg } from "./a64mt.ts";

export const CB = range("rt static").lo;                 // control block (the runtime core's range; rt.wasm is not used here)
export const KERNEL_GLOBALS = range("kernel static").hi - 4096;   // where mtify puts the kernel's former wasm globals
export const TRANSLATOR_GLOBALS = A64.translatorEnd - 4096;
const CB_OUT_LEN = 0x40, CB_FAULT = 0x44, CB_GEN = 0x80, CB_OUT = 0x1000, OUT_CAP = 0x40000;
const PC_YIELD = 0xFFFF_FFE0n, PC_EXIT = 0xFFFF_FFF0n, PC_SPECIAL = 0xFFFF_FF00n, FOREVER = 0xFFFF_FFFF_FFFF_FFFFn;
const ACT_CONTINUE = 0, ACT_SWITCH = 1, ACT_STOP = 2, ACT_ACK = 3;

export interface Mods { kernel: WebAssembly.Module; kernel2?: WebAssembly.Module; translator: WebAssembly.Module; translator2?: WebAssembly.Module; helpers: WebAssembly.Module }
export interface EngineOpts {
  budget?: number;          // budget units per slice (default 100000)
  inplace?: boolean;        // Workers: a thread that blocks waits inside its SVC while its Worker has nothing else to run (default true)
  helpersPrivate?: boolean; // helpers.wasm with a private memory per Worker (default: true when shared)
  nsPerUnit?: number;       // deterministic clock (green threads): ns per budget unit (default 100)
  wallGreen?: boolean;      // green threads on the wall clock
  transport?: "bytes" | "message";   // Workers: how a unit compiled on one Worker reaches the others (a64mt.ts; default "bytes")
  lockSpin?: number;        // Workers: compare-exchange attempts before a contended kernel lock sleeps (default 100)
  oneLock?: boolean;        // an SVC is kernel_svc_at (tick + SVC under one lock; default) instead of kernel_tick, kernel_svc
  noFence?: boolean;        // translator: DMB / DSB compile to nothing even on a shared memory (to show what that breaks)
  spin?: number;            // Workers: polls of the kick word before an idle Worker sleeps in Atomics.wait (default 2000, roughly 10-20 us)
}
export interface Boot {
  worker: number; workers: number;       // workers = 0: green threads, this engine is the only one
  shared: boolean;
  memory?: WebAssembly.Memory;           // shared: the one memory. Unshared: the engine makes its own
  store?: SharedArrayBuffer;             // transport "bytes": the unit store
  mods: Mods;
  guest?: { image: Uint8Array; base: number; entry: number; stackTop: number; top: number };   // the primary (worker 0) loads it
  epochMs: number;                       // performance.timeOrigin + performance.now() of the coordinator at boot
  opts: EngineOpts;
}
export interface EngineStats {
  worker: number; slices: number; svcs: number; idleWaits: number; spinHits: number; timeouts: number; lateMs: number; lateMaxMs: number; inplaceWaits: number; inplaceResumes: number; unwinds: number; ackWaits: number; ackMs: number;
  runMs: number; bufferChanges: number; a64: A64MT["stats"]; exitCode?: number; stopReason?: number; fault?: string; guestNs?: string; out?: string;
}
export interface Io { post(msg: unknown): void; log(line: string): void }

const dec = new TextDecoder();

export class Engine {
  readonly memory: WebAssembly.Memory;
  readonly k: any;
  readonly a64: A64MT;
  readonly core: any;
  readonly par: boolean;
  private boot: Boot; private io: Io;
  private cur = 0; private lastCtx = 0; private next = 0;
  private stopFlag = false; private fault = "";
  private oneLock: boolean; private budget: number; private nsPerUnit: bigint; private spin: number;
  private vnow = 0n; private sliceBudget = 0;
  private genPtr: number; private kickIdx = 0;
  private lastBuf: ArrayBufferLike;
  stats: EngineStats;

  constructor(boot: Boot, io: Io) {
    this.boot = boot; this.io = io;
    const w = boot.worker, primary = w === 0;
    this.par = boot.workers > 0;
    this.budget = boot.opts.budget ?? 100000;
    this.spin = boot.opts.spin ?? 2000;
    this.oneLock = boot.opts.oneLock ?? true;
    this.nsPerUnit = BigInt(boot.opts.nsPerUnit ?? 100);
    const g = boot.guest;
    this.memory = boot.memory ?? new WebAssembly.Memory({ initial: Math.ceil(((g?.top ?? 0) + 0x10000) / 65536) });
    this.lastBuf = this.memory.buffer;
    this.genPtr = CB + CB_GEN + w * 16;
    this.stats = { worker: w, slices: 0, svcs: 0, idleWaits: 0, spinHits: 0, timeouts: 0, lateMs: 0, lateMaxMs: 0, inplaceWaits: 0, inplaceResumes: 0, unwinds: 0, ackWaits: 0, ackMs: 0, runMs: 0, bufferChanges: 0, a64: null as any };
    const kenv = {
      memory: this.memory,
      abort: () => { throw new Error("kernel abort"); },
      log: (ptr: number, len: number) => io.log(dec.decode(new Uint8Array(this.memory.buffer).slice(ptr, ptr + len))),
      // OutputDebugString: called inside kernel_svc, so under the kernel lock: the shared output buffer needs no other
      debug_string: (ptr: number, len: number) => {
        const u8 = this.u8(), i32 = this.i32(), at = i32[(CB + CB_OUT_LEN) >> 2];
        if (at + len > OUT_CAP) return;
        u8.copyWithin(CB + CB_OUT + at, ptr, ptr + len);
        i32[(CB + CB_OUT_LEN) >> 2] = at + len;
      },
    };
    this.k = new WebAssembly.Instance(primary ? boot.mods.kernel : boot.mods.kernel2!, { env: kenv }).exports;
    this.a64 = new A64MT({
      memory: this.memory, layout: A64, cb: CB, worker: w, primary, shared: boot.shared,
      translator: primary ? boot.mods.translator : boot.mods.translator2!, helpers: boot.mods.helpers,
      helpersPrivate: boot.opts.helpersPrivate ?? boot.shared, store: boot.store, noFence: boot.opts.noFence,
      imports: {
        svc: (n: number) => this.svc(n),
        unimpl: (pc: bigint, insn: number) => this.die(`unimplemented instruction ${(insn >>> 0).toString(16).padStart(8, "0")} at 0x${pc.toString(16)}`),
        brk: (pc: bigint, imm: number) => this.die(`brk #${imm} at 0x${pc.toString(16)}`),
        cntpct: () => { this.tick(); return this.k.kernel_guest_ticks(); },
      },
      publish: (u: UnitMsg) => { if (this.par) io.post({ type: "unit", unit: u }); },
    });
    this.core = this.a64.core;
    this.stats.a64 = this.a64.stats;
    if (primary) {
      const e = this.k.kernel_init(0);
      if (e) throw new Error("kernel_init: layout error " + e);
      if (this.par) this.k.kernel_mt_config(boot.workers, boot.opts.lockSpin ?? 0);
      if (!g) throw new Error("the primary needs the guest");
      this.u8().set(g.image, g.base);
      this.a64.addCode(g.base, g.image.length);
      if (!this.k.kernel_create_main_thread(BigInt(g.entry), BigInt(g.stackTop))) throw new Error("no main thread");
    }
    if (this.par) this.kickIdx = this.k.kernel_mt_kick_word(w) >> 2;
  }

  // Views of the memory. A shared memory that another Worker grew keeps its old, shorter SharedArrayBuffer object in
  // this Worker until `memory.buffer` is read again: views are never kept across calls here.
  private u8(): Uint8Array { return new Uint8Array(this.buf()); }
  private i32(): Int32Array { return new Int32Array(this.buf()); }
  private buf(): ArrayBufferLike { const b = this.memory.buffer; if (b !== this.lastBuf) { this.lastBuf = b; this.stats.bufferChanges++; } return b; }

  private wallNs(): bigint { return BigInt(Math.round((performance.timeOrigin + performance.now() - this.boot.epochMs) * 1e6)); }
  private wall(): boolean { return this.par || !!this.boot.opts.wallGreen; }
  private now(): bigint { return this.wall() ? this.wallNs() : this.vnow + BigInt(this.sliceBudget - Math.max(0, this.core.budget.value)) * this.nsPerUnit; }
  private tick(): void { this.k.kernel_tick(this.now()); }
  private die(why: string): void {
    if (!this.fault) this.fault = why;
    this.stopFlag = true;
    Atomics.store(this.i32(), (CB + CB_FAULT) >> 2, 1);
    this.k.kernel_kill();   // every Worker's next scheduling point sees the stop; idle ones are kicked by the kernel
  }

  // `svc #n` in translated code: registers written back, pc = the instruction after it
  private svc(n: number): void {
    const c = this.core, ctx = this.cur, k = this.k;
    this.stats.svcs++;
    c.save_ctx(ctx);
    let act: number = this.oneLock ? k.kernel_svc_at(n, ctx, this.now()) : (this.tick(), k.kernel_svc(n, ctx));
    if (act === ACT_ACK) {
      // a pause this SVC asked for is pending on another Worker: the SVC returns when it has taken effect there
      const p: number = k.kernel_mt_ack_word(ctx), t0 = performance.now();
      this.stats.ackWaits++;
      if (p) while (Atomics.load(this.i32(), p >> 2) !== 0 && !k.kernel_stop_reason()) Atomics.wait(this.i32(), p >> 2, 1, 20);
      this.stats.ackMs += performance.now() - t0;
      act = k.kernel_stop_reason() ? ACT_STOP : ACT_CONTINUE;
    }
    if (act === ACT_CONTINUE) { c.load_ctx(ctx); return; }
    if (act === ACT_SWITCH && this.par && (this.boot.opts.inplace ?? true)) {
      // The thread waits (or gave way). While this Worker's cores have nothing else, stay inside the SVC: no unwind,
      // no re-entry through run(). The moment another thread is chosen, unwind as green threads always do.
      this.stats.inplaceWaits++;
      for (;;) {
        const nx: number = k.kernel_mt_schedule(this.boot.worker, this.genPtr) >>> 0;
        if (nx === ctx) { c.load_ctx(ctx); c.excl_addr.value = -1n; this.stats.inplaceResumes++; return; }
        if (nx) { this.next = nx; break; }
        if (k.kernel_stop_reason()) { act = ACT_STOP; break; }
        this.idle();
      }
    }
    if (act === ACT_STOP) this.stopFlag = true;
    this.stats.unwinds++;
    c.pc.value = PC_YIELD;   // translated code unwinds; the context block holds the real pc
  }
  // Nothing to run on this Worker's cores: sleep until a core is kicked or the next deadline of any wait
  private idle(): void {
    const k = this.k, i32 = this.i32();
    const until = BigInt.asUintN(64, k.kernel_next_timeout());
    let ms = 50;
    if (until !== FOREVER) ms = Math.max(0, Math.min(50, Number(until - this.wallNs()) / 1e6));
    this.stats.idleWaits++;
    if (ms > 0) {
      const gen = i32[this.genPtr >> 2];
      // a wake through the OS costs tens of microseconds; most hand-overs (a lock, a signal) come sooner than that
      for (let s = this.spin; s > 0; s--) if (Atomics.load(i32, this.kickIdx) !== gen) { this.stats.spinHits++; this.tick(); return; }
      const t0 = performance.now();
      if (Atomics.wait(i32, this.kickIdx, gen, ms) === "timed-out") { const late = performance.now() - t0 - ms; this.stats.timeouts++; this.stats.lateMs += late; if (late > this.stats.lateMaxMs) this.stats.lateMaxMs = late; }
    }
    this.tick();
  }

  receive(u: UnitMsg): void { this.a64.receive(u); }

  async run(): Promise<EngineStats> {
    const c = this.core, k = this.k, t0 = performance.now();
    let trap: unknown;
    try {
      for (;;) {
        if (this.stopFlag || k.kernel_stop_reason()) break;
        let ctx = this.next; this.next = 0;
        if (!ctx) ctx = (this.par ? k.kernel_mt_schedule(this.boot.worker, this.genPtr) : k.kernel_schedule()) >>> 0;
        if (!ctx) {
          if (k.kernel_stop_reason()) break;
          if (this.par) { this.idle(); continue; }
          const until = BigInt.asUintN(64, k.kernel_next_timeout());
          if (until === FOREVER) { this.die("deadlock: every thread waits and no wait has a deadline"); break; }
          if (this.wall()) { const ms = Number(until - this.wallNs()) / 1e6; if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); this.tick(); }
          else { this.vnow = until; this.sliceBudget = 0; k.kernel_tick(until); }
          continue;
        }
        if (ctx !== this.lastCtx) c.excl_addr.value = -1n;   // a context switch clears the exclusive monitor
        this.cur = this.lastCtx = ctx;
        c.load_ctx(ctx);
        c.budget.value = this.sliceBudget = this.budget;
        this.stats.slices++;
        for (;;) {
          try { c.run(); }
          catch (e) {
            // an indirect transfer to a function another Worker published beyond this Worker's table: grow, go on at pc
            if (e instanceof WebAssembly.RuntimeError && this.a64.tableMiss(Number((c.pc.value as bigint) & 0xFFFFFFFFn))) { c.budget.value = this.sliceBudget; continue; }
            throw e;
          }
          if (this.a64.error) throw this.a64.error;
          if (!this.a64.need) break;
          // the code at pc was compiled by another Worker and its message is still on the way: everything has unwound
          // (pc = the target, registers in the globals); take messages, then enter the guest again
          await this.a64.waitNeed();
          c.budget.value = this.sliceBudget;
        }
        const left = Math.max(0, c.budget.value);
        if (!this.wall()) { this.vnow += BigInt(this.sliceBudget - left) * this.nsPerUnit; this.sliceBudget = 0; c.budget.value = 0; k.kernel_tick(this.vnow); }
        else this.tick();
        if (this.stopFlag) break;
        const pc: bigint = c.pc.value;
        if (pc === PC_YIELD) continue;
        c.save_ctx(ctx);
        if (pc === PC_EXIT) { k.kernel_thread_returned(ctx); continue; }
        if (pc >= PC_SPECIAL) { this.die(`0x${pc.toString(16)} is a reserved pc value`); break; }
        k.kernel_preempt(ctx);
      }
    } catch (e) { trap = e; }
    if (trap !== undefined) this.die("trap: " + (trap instanceof Error ? trap.stack ?? trap.message : String(trap)));
    const s = this.stats;
    s.runMs = performance.now() - t0;
    s.exitCode = k.kernel_exit_code(); s.stopReason = k.kernel_stop_reason();
    s.fault = this.fault || undefined;
    if (this.boot.worker === 0) {
      s.guestNs = String(BigInt.asUintN(64, k.kernel_guest_ns()));
      const i32 = this.i32();
      s.out = dec.decode(this.u8().slice(CB + CB_OUT, CB + CB_OUT + i32[(CB + CB_OUT_LEN) >> 2]));
    }
    return s;
  }
}
