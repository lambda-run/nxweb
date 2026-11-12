// The kernel's test harness: fresh instances of build/kernel/kernel.wasm (its own memory is the guest memory) and a
// scripted guest: each test says which thread makes which SVC, the harness puts the arguments in that thread's
// context block, calls kernel_svc and reads the results back. No translator is involved.
import { sharedBuild } from "../../src/glue/wasm_shared.ts";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadDefs, KIT_DIR, type MachineDef } from "../../src/kit/host/defs.mts";
import { writeStamp } from "../../src/kit/host/stamp.mts";
import { readMachines, readTrace, formatRecord, type KitExports, type WasmMachine } from "../../src/kit/host/reader.mts";
import { buildPair } from "../../tools/asc64/abi.mjs";
import { instantiate } from "../../src/glue/wasm_abi.ts";
import { makeMemory64, MEM64_MAX_PAGES } from "../../src/glue/a64_host.ts";

export const ROOT = join(KIT_DIR, "..", "..");
// NX_MEM: "32" (default) the kernel built for a 32-bit memory, with a memory of its own; "64" the wasm64 build on a
// 64-bit memory (made here and imported); "64hi" the same with the whole test layout 6 GB up, so that an address the
// kernel truncated to 32 bits would land on untouched pages 4 GB lower.
export const MODE = process.env.NX_MEM ?? "32";
export const M64 = MODE !== "32";
export const SHARED = process.env.NX_SHARED === "1";
export const HI = MODE === "64hi" ? 0x1_8000_0000 : 0;
export const WASM = join(ROOT, "build", "kernel", M64 ? "kernel64.wasm" : "kernel.wasm");

export function build(): void {
  mkdirSync(dirname(WASM), { recursive: true });
  const args = ["--runtime", "stub", "-O2", "--initialMemory", "1536", "--enable", "threads"];   // threads: base.ts cas32 is a wasm atomic
  buildPair("src/kernel/index.ts", join("build", "kernel", "kernel.wasm"), args, { args64: [...args, "--importMemory"] });
  writeStamp(join(ROOT, "build", "kernel", "kernel.wasm")); writeStamp(join(ROOT, "build", "kernel", "kernel64.wasm"));
}

export interface KernelExports extends KitExports {
  kernel_init(cfg: number): number;
  kernel_static_end(): number;
  kernel_create_main_thread(entry: bigint, stackTop: bigint): number;
  kernel_svc(n: number, ctx: number): number;
  kernel_schedule(): number;
  kernel_schedule_core(core: number): number;
  kernel_preempt(ctx: number): void;
  kernel_thread_returned(ctx: number): number;
  kernel_tick(now: bigint): void;
  kernel_next_timeout(): bigint;
  kernel_clock_freeze(reason: number, on: number): void;
  kernel_clock_reasons(): number;
  kernel_guest_ns(): bigint;
  kernel_guest_ticks(): bigint;
  kernel_seed_entropy(seed: bigint): void;
  kernel_module_add(base: bigint, size: bigint, ro: bigint, data: bigint): number;
  kernel_module_remove(base: bigint): number;
  kernel_device_share(addr: bigint, size: bigint, share: number): void;
  kernel_event_new(writeOut: number): number;
  kernel_event_dup_readable(h: number): number;
  kernel_event_signal(h: number): number;
  kernel_event_clear(h: number): number;
  kernel_stop_reason(): number;
  kernel_exit_code(): number;
  kernel_thread_index(h: number): number;
  kernel_thread_ctx(index: number): number;
  kernel_thread_of_ctx(ctx: number): number;
  kernel_core_current(core: number): number;
  kernel_thread_info(index: number, out: number): number;
  kernel_count(what: number): bigint;
  kernel_alias_page_state(addr: bigint): number;
  kernel_alias_arena(base: number, size: number): number;
  kernel_alias_leaves(what: number): number;
  kernel_check(): number;
  kernel_svc_ring(index: number, out: number, cap: number): number;
  kernel_svc_total(index: number): number;
  kernel_poll_backoff(on: number): void;
  kernel_stats_ptr(): number;
  kernel_stats_stride(): number;
}

export const defs: MachineDef[] = loadDefs();
export const def = (name: string): MachineDef => defs.find(d => d.name === name)!;
export const KT = def("kthread");
export const ST = Object.fromEntries(KT.states.map((s, i) => [s, i])) as Record<string, number>;
export const WK = Object.fromEntries(KT.data.Waiting.values!.map((s, i) => [s, i + 1])) as Record<string, number>;

// Result codes
export const R = { OK: 0, OUT_OF_RES: 0xCE01, OOM: 0xD001, LIMIT: 0x10801, BAD_SIZE: 0xCA01, BAD_ADDR: 0xCC01, BAD_MEMORY: 0xD401, BAD_REGION: 0xDC01,
  BAD_HANDLE: 0xE401, TIMEOUT: 0xEA01, CANCELLED: 0xEC01, OUT_OF_RANGE: 0xEE01, BAD_STATE: 0xFA01 };
export const ACT = { CONTINUE: 0, SWITCH: 1, STOP: 2 };
export const WAITERS = 0x40000000, CUR_THREAD = 0xFFFF8000, P = 0x1000;

// The test layout: everything below 96 MB, with a hole between the thread-local region and the heap
// (NX_MEM=64hi: the same, HI higher)
export const L = {
  code: HI + 0x01000000, codeSize: 0x00800000,
  tls: HI + 0x01800000, tlsSize: 0x00100000,
  heap: HI + 0x02000000, heapSize: 0x01000000,
  stack: HI + 0x03000000, stackSize: 0x01100000,
  alias: HI + 0x04200000, aliasSize: 0x01800000,
  pool: 0x03000000, used: 0x00400000,
};
export const END = L.alias + L.aliasSize;
export const DATA = HI + 0x01400000;   // scratch guest memory for the tests' lock words and buffers (inside the code region)
export const CFG = HI + 0x017FF000;    // where the harness writes kernel_init's block

export interface Options { pool?: number; used?: number; sysResource?: number; flags?: number; programId?: bigint; processId?: number; defaults?: boolean; main?: boolean }
type Arg = number | bigint;
const big = (v: Arg) => BigInt.asUintN(64, BigInt(v));

let module: WebAssembly.Module | undefined;
const live: Kernel[] = [];
let sum: Uint8Array[] | undefined;

export class Thread {
  readonly k: Kernel; readonly index: number; readonly handle: number;
  constructor(k: Kernel, index: number, handle: number) { this.k = k; this.index = index; this.handle = handle; }
  [Symbol.for("nodejs.util.inspect.custom")](): string { return `Thread(0x${this.handle.toString(16)} #${this.index} ${this.state})`; }
  get ctx(): number { return this.k.x.kernel_thread_ctx(this.index); }
  x(i: number): bigint { return this.k.dv.getBigUint64(this.ctx + 8 * i, true); }
  w(i: number): number { return this.k.dv.getUint32(this.ctx + 8 * i, true); }
  setX(i: number, v: Arg): void { this.k.dv.setBigUint64(this.ctx + 8 * i, big(v), true); }
  get info() { return this.k.info(this.index); }
  get state(): string { return KT.states[this.info.state]; }
  get wait(): string { return ["", ...KT.data.Waiting.values!][this.info.waitKind]; }
  // The result of the SVC it last made (x0), once its wait has ended
  get result(): number { return Number(this.x(0)); }
}

export class Kernel {
  x!: KernelExports;
  logs: string[] = [];
  out: string[] = [];          // OutputDebugString
  main!: Thread;
  now = 0n;
  private data = DATA;
  get dv(): DataView { return new DataView(this.x.memory.buffer); }
  get u8(): Uint8Array { return new Uint8Array(this.x.memory.buffer); }
  get red(): string[] { return this.logs.filter(l => l.startsWith("[RED] ")); }

  constructor(o: Options = {}) {
    // NX_SHARED=1: the same binary with its memory declared shared (src/glue/wasm_shared.ts), on a shared memory
    module ??= new WebAssembly.Module(SHARED ? sharedBuild(readFileSync(WASM), M64 ? MEM64_MAX_PAGES : 65536) : readFileSync(WASM));
    // addresses are numbers on this side in every mode (src/glue/wasm_abi.ts)
    const mem = M64 ? makeMemory64({ initial: 1536, maximum: MEM64_MAX_PAGES, shared: SHARED }) : null;
    const bytes = (p: number, n: number) => new Uint8Array(this.x.memory.buffer).slice(p, p + n);
    this.x = instantiate<KernelExports>(module, { env: {
      ...(mem ? { memory: mem.memory, ...mem.imports() } : {}),
      log: (p: number, n: number) => { this.logs.push(Buffer.from(bytes(p, n)).toString("utf8")); },
      debug_string: (p: number, n: number) => { this.out.push(Buffer.from(bytes(p, n)).toString("latin1")); },
      abort: () => { throw new Error("abort"); },
    } }, { mem64: M64, name: "kernel.wasm" });
    if (mem && HI) mem.grow(Math.ceil((CFG + 0x1000) / 65536) - mem.pages());   // the harness writes its blocks up there before the kernel commits anything
    this.x.kit_cover_enable(1);
    live.push(this);
    if (this.x.kernel_static_end() > L.code) throw new Error("the kernel's static memory reaches into the test layout");
    let cfg = 0;
    if (!o.defaults) {
      const v = [L.code, L.codeSize, L.tls, L.tlsSize, L.heap, L.heapSize, L.stack, L.stackSize, L.alias, L.aliasSize,
        o.pool ?? L.pool, o.used ?? L.used, o.sysResource ?? 0, o.programId ?? 0x0100000000001000n, o.flags ?? 0, o.processId ?? 0];
      v.forEach((n, i) => this.dv.setBigUint64(CFG + 8 * i, big(n), true));
      cfg = CFG;
    }
    const e = this.x.kernel_init(cfg);
    if (e) throw new Error(`kernel_init: ${e}`);
    if (o.main !== false && !o.defaults) {
      const h = this.x.kernel_create_main_thread(big(L.code), big(L.stack + 0x10000));
      this.main = new Thread(this, this.x.kernel_thread_index(h), h);
      this.known.set(this.main.index, this.main);
    }
  }

  // ---- guest memory ----
  alloc(bytes: number): number { const a = this.data; this.data += (bytes + 15) & ~15; return a; }
  r32(a: number): number { return this.dv.getUint32(a, true); }
  w32(a: number, v: number): void { this.dv.setUint32(a, v >>> 0, true); }
  r64(a: number): bigint { return this.dv.getBigUint64(a, true); }
  w64(a: number, v: Arg): void { this.dv.setBigUint64(a, big(v), true); }
  word(v = 0): number { const a = this.alloc(4); this.w32(a, v); return a; }

  info(index: number) {
    const out = CFG + 0x200, dv = this.dv;
    this.x.kernel_thread_info(index, out);
    return { used: dv.getUint32(out, true), state: dv.getUint32(out + 4, true), waitKind: dv.getUint32(out + 8, true), prio: dv.getInt32(out + 12, true),
      eff: dv.getInt32(out + 16, true), core: dv.getInt32(out + 20, true), runCore: dv.getInt32(out + 24, true), handle: dv.getUint32(out + 28, true),
      id: dv.getBigUint64(out + 32, true), mask: dv.getBigUint64(out + 40, true), waddr: dv.getBigUint64(out + 48, true), wkey: dv.getBigUint64(out + 56, true),
      deadline: dv.getBigUint64(out + 64, true), syncRefs: dv.getInt32(out + 72, true), wn: dv.getInt32(out + 76, true), cancel: dv.getUint32(out + 80, true),
      closed: dv.getUint32(out + 84, true), owner: dv.getInt32(out + 88, true) };
  }
  count(what: "handles" | "alive" | "objects" | "events" | "maps" | "heap" | "aliasMapped"): number {
    return Number(this.x.kernel_count(["handles", "alive", "objects", "events", "maps", "heap", "aliasMapped"].indexOf(what)));
  }

  // ---- the scripted guest ----
  // The thread the kernel runs next (null: all idle)
  schedule(): Thread | null {
    const ctx = this.x.kernel_schedule();
    if (!ctx) return null;
    const i = this.x.kernel_thread_of_ctx(ctx);
    return this.byIndex(i);
  }
  private known = new Map<number, Thread>();
  byIndex(i: number): Thread {
    let t = this.known.get(i);
    if (!t || t.handle !== this.info(i).handle) { t = new Thread(this, i, this.info(i).handle); this.known.set(i, t); }
    return t;
  }
  // Give the cores turns until t is the running thread of its core
  run(t: Thread): void {
    for (let i = 0; i < 8 && t.state !== "Running"; i++) this.x.kernel_schedule();
    if (t.state !== "Running") throw new Error(`thread ${t.handle.toString(16)} does not get its core (it is ${t.state})`);
  }
  // t makes SVC n with these x0.. arguments. Returns what the embedder must do; t.result / t.x(i) hold the results.
  svc(t: Thread, n: number, ...args: Arg[]): number {
    this.run(t);
    args.forEach((a, i) => t.setX(i, a));
    return this.x.kernel_svc(n, t.ctx);
  }
  // The same, for an SVC that must return to the caller at once: its result code (x0)
  call(t: Thread, n: number, ...args: Arg[]): number {
    const act = this.svc(t, n, ...args);
    if (act !== ACT.CONTINUE && t.state !== "Runnable" && t.state !== "Running") throw new Error(`svc ${n.toString(16)}: the thread did not go on (it is ${t.state})`);
    return t.result;
  }
  nextTimeout(): bigint { return BigInt.asUintN(64, this.x.kernel_next_timeout()); }
  tick(ns: number | bigint): void { this.now += BigInt(ns); this.x.kernel_tick(this.now); }

  // CreateThread + StartThread by `by` (the main thread unless given)
  thread(prio: number, core: number, o: { by?: Thread; start?: boolean; entry?: number; arg?: number } = {}): Thread {
    const by = o.by ?? this.main;
    const n = this.count("objects");
    if (this.call(by, 0x08, 0, o.entry ?? L.code + 0x100 * (n + 1), o.arg ?? n, L.stack + 0x10000 * (n + 2), prio, core)) throw new Error("CreateThread failed");
    const h = by.w(1), t = new Thread(this, this.x.kernel_thread_index(h), h);
    this.known.set(t.index, t);
    if (o.start !== false) this.svc(by, 0x09, h);
    return t;
  }
  event(by: Thread = this.main): { w: number; r: number } {
    if (this.call(by, 0x45)) throw new Error("CreateEvent failed");
    return { w: by.w(1), r: by.w(2) };
  }
  // The SDK's user-mode mutex (InternalCriticalSection): the fast paths write the lock word, the kernel arbitrates
  lock(t: Thread, addr: number): number {
    const v = this.r32(addr);
    if (v === 0) { this.w32(addr, t.handle); return ACT.CONTINUE; }
    this.w32(addr, v | WAITERS);
    return this.svc(t, 0x1A, v & ~WAITERS, addr, t.handle);
  }
  unlock(t: Thread, addr: number): void {
    const v = this.r32(addr);
    if (v === t.handle) this.w32(addr, 0);
    else this.svc(t, 0x1B, addr);
  }
  trace(): string[] { const m = readMachines(this.x); return readTrace(this.x).map(r => formatRecord(r, m)); }
  check(): void { const e = this.x.kernel_check(); if (e) throw new Error(`kernel_check: ${e}`); }
}

// ---- coverage of the kernel's machines over every instance the tests made ----
export function harvest(): void {
  for (const k of live.splice(0)) {
    const ms = readMachines(k.x);
    sum ??= ms.map(m => new Uint8Array(m.hits.length));
    ms.forEach((m, i) => m.hits.forEach((h, c) => { if (h) sum![i][c] = 1; }));
  }
}
export function coverage(): { machines: WasmMachine[]; hits: Uint8Array[] } {
  harvest();
  const all = readMachines(new Kernel({ main: false }).x);
  live.splice(0);
  const mine = ["kthread", "guest_clock", "alias_page"];
  const idx = all.map((m, i) => mine.includes(m.name) ? i : -1).filter(i => i >= 0);
  return { machines: idx.map(i => all[i]), hits: idx.map(i => sum![i]) };
}

export const tests: { name: string; fn: () => void }[] = [];
export function test(name: string, fn: () => void): void { tests.push({ name, fn }); }
