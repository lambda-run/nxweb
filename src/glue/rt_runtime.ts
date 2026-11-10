// nxweb runtime glue: one guest process = translator + loader + kernel + runtime core on ONE linear memory, the run
// loop, host-function dispatch and fault capture. No Node APIs: the same file runs under Node and in a browser Worker.
// Policy lives in the AssemblyScript modules (scheduling and waits: src/kernel; lifecycle, clock arithmetic, fault
// report: src/runtime); this file moves control between them. See src/runtime/README.md.
import { A64Host } from "./a64_host.ts";
import { Loader, HOST_UNRESOLVED, type LoaderExports, type LoadedSet, type ModuleInfo } from "../loader/host/loader.mts";
import { RANGES, HOST_END, GUEST, PCMAP, STUBS, A64, range } from "./rt_layout.ts";

export interface RuntimeModules {
  rt: WebAssembly.Module; kernel: WebAssembly.Module; loader: WebAssembly.Module;
  translator: WebAssembly.Module; helpers: WebAssembly.Module;
  gfx?: WebAssembly.Module;           // build/runtime/gfx.wasm, for src/glue/rt_gfx.ts
}
export interface RuntimeOptions {
  budget?: number;                    // budget units per time slice (function entries + backward branches); default 100000
  clock?: "deterministic" | "wall";   // deterministic (default): guest time is a function of executed budget
  nsPerUnit?: number;                 // deterministic clock: ns per budget unit (default 100)
  mainStackSize?: number;             // default 1 MB
  codeBase?: number;                  // where the modules are mapped from (default 0x0800_0000; tests move it past the pc map)
  reserve4g?: boolean;                // allocate the whole 4 GB at once instead of growing on demand (default false)
  log?: (line: string) => void;       // every log line (kernel, loader, runtime, host functions); red lines start "[RED] "
  maxInsns?: number; maxFuncs?: number; depthLimit?: number; tailCalls?: boolean; fma?: boolean; nanFix?: boolean;   // translator
}
export const STATES = ["Empty", "Loading", "Ready", "Running", "Paused", "Stopped"] as const;
export type State = typeof STATES[number];
export const FAULT = { unimplemented: 1, brk: 2, trap: 3, jump: 4, stack: 5, deadlock: 6, load: 7, host: 8 } as const;
export const FAULT_NAMES = ["", "unimplemented", "brk", "trap", "jump", "stack", "deadlock", "load", "host"] as const;
export interface StopInfo {
  kind: "exit" | "break" | "fault" | "killed";
  code: number;                       // exit code (exit, break)
  fault?: { kind: typeof FAULT_NAMES[number]; thread: number; threadIndex: number; pc: bigint; aux: bigint; detail: string };
}
export interface RunResult {
  state: State; stop?: StopInfo;
  yielded?: boolean;                  // run({ yieldMs }) gave the host's event loop a turn; the process is still Running
  idle?: boolean;                     // every thread waits for something outside (a GPU completion, a frame, a timer): call again when it happened
  wakeMs?: number;                    // with idle on the wall clock: the next guest deadline is this many ms away
}
export interface RunLimit { slices?: number; ms?: number; yieldMs?: number; async?: boolean }

// ---- host functions ----
export type WaitResult = "signaled" | "timeout" | "cancelled";
const ACTION = Symbol("rt.action");
interface Action { [ACTION]: "jump" | "block"; pc?: bigint; event?: number; timeout?: bigint; resume?: (r: WaitResult, cpu: HostCpu) => HostResult }
export type HostResult = void | number | bigint | Action;
// What a host function sees: the calling guest thread's registers (live CPU state), guest memory, the log.
export interface HostCpu {
  readonly rt: Runtime;
  readonly thread: number;            // the calling thread's handle
  readonly threadIndex: number;
  readonly lr: bigint;                // the return address (x30)
  x(i: number): bigint; w(i: number): number;
  setX(i: number, v: bigint | number): void;
  sp(): bigint;
  u8(): Uint8Array; dv(): DataView;   // views of the whole linear memory (take them again after anything that may grow it)
  read(addr: number | bigint, len: number): Uint8Array;   // a copy
  write(addr: number | bigint, bytes: Uint8Array): void;
  cstr(addr: number | bigint, max?: number): string;
  log(line: string): void;
  // Return these from the handler:
  jump(pc: bigint | number): HostResult;   // continue at pc instead of returning to x30
  // The calling thread waits (kernel WaitSynchronization) until the readable event handle is signaled or the timeout
  // (ns, -1n = forever) passes; other guest threads run meanwhile. Then resume() runs on the same thread and its
  // result is the host function's result. x0..x3 are not preserved across the wait (they are caller-saved).
  block(readableEvent: number, timeoutNs: bigint, resume: (r: WaitResult, cpu: HostCpu) => HostResult): HostResult;
  // Call back into guest code: runs the guest function at `fn` to completion on the calling thread, from inside the
  // host function, and returns its x0. The callback may make SVCs that return at once and call host functions; if it
  // blocks (a wait, a sleep, an exit of its thread) the process stops with a host fault: a host frame cannot be
  // suspended. It is not preempted: its slices are refilled until it returns. x30 of the host call is preserved.
  call(fn: bigint | number, ...args: (bigint | number)[]): bigint;
  // The calling thread waits for something outside the guest: until `done` has resolved (null: nothing to wait for)
  // AND guest time has reached `at` (kernel_tick scale, ns; omitted: now). Return its result from the handler. Other
  // threads run meanwhile; the run loop goes back to the host's event loop when nothing can run (runAsync).
  // Deterministic clock: the guest clock never passes `at` before the thread is woken, so the wake happens at
  // exactly `at` however long the real thing took. Wall clock: `at` is a plain timer.
  waitFor(done: Promise<unknown> | null, at: bigint | undefined, resume: (cpu: HostCpu) => HostResult): HostResult;
  now(): bigint;                      // host time (kernel_tick scale, ns) at this point of the slice
  args(): number;                     // address of a block with x0..x7 then d0..d7 (low 64 bits of v0..v7) as the guest passed them
}
interface Ext { index: number; r: number; w: number; done: boolean; at: bigint; signaled: boolean }
class GuestCallAbort extends Error { }
export interface HostFunctionDef {
  name: string;
  forced?: boolean;                   // true: wins over every module's own definition; false (default): fills an import no module defines
  fn: (cpu: HostCpu) => HostResult;
}

const ACT_CONTINUE = 0, ACT_SWITCH = 1;
const FOREVER = 0xFFFF_FFFF_FFFF_FFFFn;
const PC_YIELD = BigInt(GUEST.pcYield), PC_EXIT = BigInt(GUEST.pcExit), PC_SPECIAL = 0xFFFF_FF00n, M32 = 0xFFFF_FFFFn;
const PC_CALLBACK = 0xFFFF_FFD0n;   // x30 of a guest function a host function calls: its return ends the nested run
const START_NAME = "<rt.start>";
// (module (import "env" "host_call" (func)) (func (export "f") call 0)): the table entry every stub pc maps to
const THUNK = new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0,
  2, 0x11, 1, 3, 0x65, 0x6E, 0x76, 9, 0x68, 0x6F, 0x73, 0x74, 0x5F, 0x63, 0x61, 0x6C, 0x6C, 0, 0,
  3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 1, 0x0A, 6, 1, 4, 0, 0x10, 0, 0x0B]);
const hex = (v: number | bigint) => "0x" + v.toString(16);
const dec = new TextDecoder();

export class Runtime {
  readonly memory: WebAssembly.Memory;
  readonly k: any;                    // kernel exports (kernel_*)
  readonly r: any;                    // runtime core exports (rt_*)
  readonly ld: Loader;
  readonly a64: A64Host;
  readonly core: any;
  readonly logs: string[] = [];
  readonly opts: Required<Pick<RuntimeOptions, "budget" | "clock" | "nsPerUnit" | "mainStackSize">> & RuntimeOptions;
  set: LoadedSet | null = null;
  modules: ModuleInfo[] = [];
  mainThread = 0;
  stats = { slices: 0, svcs: 0, hostCalls: 0, runMs: 0, grows: 0 };

  private out: Uint8Array[] = [];
  private registry = new Map<string, HostFunctionDef>();
  private handlers: (HostFunctionDef | null | undefined)[] = [];   // by host function id; null = unresolved import
  private unresolvedSeen = new Set<string>();
  private pending = new Map<number, (r: WaitResult, cpu: HostCpu) => HostResult>();   // thread index -> the resume of its host-call wait
  private text: { lo: number; hi: number }[] = [];
  private far = new Map<number, number>();    // translated entry pcs the pc map does not cover
  private thunk = 0;
  private cur = 0;                    // context block of the thread in core
  private curIndex = -1;
  private lastCtx = 0;
  private stopFlag = false;
  private pendFault: { kind: number; detail: string; aux: bigint; exact: boolean } | null = null;
  private stop: StopInfo | undefined;
  private flat = false;
  private flatTick = 0n;
  private initQueue: number[] = [];
  private entry = 0;
  private mainStackTop = 0;
  private nextFile = range("file staging").lo;
  private nextBase = GUEST.codeBase;
  private lateStubs = new Map<string, number>();
  private spOk = new Map<number, { lo: number; hi: number }>();
  private pauseAsked = false;
  private wallStart = 0;
  private sleeper: Int32Array | null = null;
  private frozenSeen = false;
  private exts: Ext[] = [];
  private threadEvent = new Map<number, { r: number; w: number }>();
  private wake: (() => void) | null = null;
  times = { hostMs: 0 };               // time inside host functions (ms), for the per-frame breakdown

  constructor(mods: RuntimeModules, opts: RuntimeOptions = {}) {
    this.opts = { budget: 100000, clock: "deterministic", nsPerUnit: 100, mainStackSize: GUEST.mainStackSize, ...opts };
    if (opts.codeBase !== undefined) this.nextBase = opts.codeBase;
    // One memory for everything. It starts as the host area and grows on demand (the kernel grows it for the heap,
    // stacks and thread-local slots; ensure() for images), up to the 4 GB a wasm32 memory can have.
    this.memory = new WebAssembly.Memory({ initial: this.opts.reserve4g ? 65536 : HOST_END >>> 16, maximum: 65536 });
    const log = (ptr: number, len: number) => this.log(this.str(ptr >>> 0, len));
    const env = {
      memory: this.memory, log,
      debug_string: (ptr: number, len: number) => { this.out.push(this.u8().slice(ptr >>> 0, (ptr >>> 0) + len)); },
      abort: () => { throw new Error("abort in an AssemblyScript module"); },
    };
    this.r = new WebAssembly.Instance(mods.rt, { env }).exports;
    const lx = new WebAssembly.Instance(mods.loader, { env }).exports as unknown as LoaderExports;
    this.k = new WebAssembly.Instance(mods.kernel, { env }).exports;
    this.r.rt_init();
    this.checkLayout(lx);
    this.r.rt_clock_init(this.opts.clock === "wall" ? 1 : 0, BigInt(this.opts.nsPerUnit));
    const arena = range("loader arena");
    this.ld = new Loader(lx, { arena: arena.lo, arenaLen: arena.hi - arena.lo, stubBase: STUBS.base, stubCap: STUBS.cap });
    if (this.k.kernel_init(0) !== 0) throw new Error("runtime: kernel_init refused the default layout");

    this.a64 = new A64Host(mods.translator, mods.helpers, {
      memory: this.memory, layout: A64,
      maxInsns: opts.maxInsns, maxFuncs: opts.maxFuncs, depthLimit: opts.depthLimit, tailCalls: opts.tailCalls, fma: opts.fma, nanFix: opts.nanFix,
      onTranslate: (pc: bigint) => this.onTranslate(pc),
      imports: {
        svc: (n: number) => this.svc(n),
        unimpl: (pc: bigint, insn: number) => this.fault(FAULT.unimplemented, `instruction word ${hex(insn >>> 0)} at ${hex(pc)}`, BigInt(insn >>> 0), true),
        brk: (pc: bigint, imm: number) => this.fault(FAULT.brk, `brk #${hex(imm)} at ${hex(pc)}`, BigInt(imm), true),
        cntpct: () => this.cntpct(),
      },
    });
    this.core = this.a64.core;
    // every stub pc maps to one thunk that calls hostCall(); the stub region is inside the pc map, outside the code window
    const thunk = new WebAssembly.Instance(new WebAssembly.Module(THUNK), { env: { host_call: () => this.hostCall() } }).exports.f;
    this.thunk = this.a64.table.length;
    this.a64.table.grow(1);
    this.a64.table.set(this.thunk, thunk);
    this.a64.fillPcMap(STUBS.base, STUBS.cap, this.thunk);
  }

  // ---- memory ----
  u8(): Uint8Array { return new Uint8Array(this.memory.buffer); }
  dv(): DataView { return new DataView(this.memory.buffer); }
  private str(ptr: number, len: number): string { return dec.decode(this.u8().slice(ptr, ptr + len)); }
  log(line: string): void { this.logs.push(line); this.opts.log?.(line); }
  get red(): string[] { return this.logs.filter(l => l.startsWith("[RED] ")); }
  // the linear memory reaches `end`
  ensure(end: number): void {
    const have = this.memory.buffer.byteLength;
    if (end > have) { this.memory.grow(Math.ceil((end - have) / 65536)); this.stats.grows++; }
  }
  private checkLayout(lx: LoaderExports): void {
    const p = this.r.rt_scratch_ptr() >>> 0, dv = this.dv();
    RANGES.forEach((g, i) => { dv.setBigUint64(p + 16 * i, BigInt(g.lo), true); dv.setBigUint64(p + 16 * i + 8, BigInt(g.hi), true); });
    let bad = this.r.rt_ranges_check(p, RANGES.length, BigInt(HOST_END));
    const ends: Record<string, number> = { rt: this.r.rt_static_end() >>> 0, loader: lx.ld_heap_base() >>> 0, kernel: this.k.kernel_static_end() >>> 0 };
    RANGES.forEach((g, i) => { if (g.module && ends[g.module] !== undefined) bad |= this.r.rt_static_check(i, BigInt(g.lo), BigInt(g.hi), BigInt(ends[g.module])); });
    if (bad) throw new Error("runtime: the shared memory layout is not sound: " + this.red.join("; "));
  }

  // ---- state ----
  get state(): State { return STATES[this.r.rt_state()]; }
  stdoutBytes(): Uint8Array {
    const n = this.out.reduce((a, c) => a + c.length, 0), all = new Uint8Array(n);
    let o = 0;
    for (const c of this.out) { all.set(c, o); o += c.length; }
    return all;
  }
  stdout(): string { return dec.decode(this.stdoutBytes()); }
  get units(): number { return Number(this.r.rt_clock_units()); }   // budget units executed (finished slices)
  guestNs(): bigint { return this.k.kernel_guest_ns(); }

  // ---- host function registry ----
  register(def: HostFunctionDef): void {
    if (this.state !== "Empty") throw new Error("runtime: register host functions before loading");
    this.registry.set(def.name, def);
  }

  // A host function added after loading (not bound to any import: its address is handed to the guest by another host
  // function, as nvnBootstrapLoader does). Returns the stub's guest address; the same name gives the same stub.
  lateStub(name: string, fn: (cpu: HostCpu) => HostResult): number {
    let id = this.lateStubs.get(name);
    if (id === undefined) { id = this.ld.hostAdd(name, false); this.lateStubs.set(name, id); this.handlers[id] = { name, fn }; }
    return this.ld.stubAddr(id);
  }

  // ---- loading ----
  // A set of NSO files as at process start: files[0] is the main module, the rest what it depends on (load order =
  // symbol lookup order). Returns false when the process stopped with a load fault.
  loadNso(files: { name: string; bytes: Uint8Array }[], o: { verifyHash?: boolean } = {}): boolean {
    if (!this.r.rt_load_begin()) throw new Error("runtime: a process was loaded already");
    try {
      const stage = range("file staging");
      const staged = files.map(f => {
        const ptr = this.nextFile;
        if (ptr + f.bytes.length > stage.hi) throw new Error(`file ${f.name}: ${f.bytes.length} bytes do not fit the file staging range`);
        this.u8().set(f.bytes, ptr);
        this.nextFile = (ptr + f.bytes.length + 0xFFF) & ~0xFFF;
        return { name: f.name, ptr, len: f.bytes.length };
      });
      for (const d of this.registry.values()) this.ld.hostAdd(d.name, !!d.forced);
      const startId = this.ld.hostAdd(START_NAME, false);
      this.registry.set(START_NAME, { name: START_NAME, fn: cpu => this.startStep(cpu) });
      const set = this.ld.loadSet(staged, (size: number) => {
        const base = this.nextBase;
        this.nextBase = base + size + 0x1000;
        this.ensure(base + size);
        return base;
      }, o);
      this.set = set; this.modules = set.modules;
      for (const m of set.modules) {
        if (this.k.kernel_module_add(BigInt(m.base), BigInt(m.imageSize), BigInt(m.ro.addr - m.base), BigInt(m.data.addr - m.base)) < 0)
          throw new Error(`module ${m.name}: the kernel refused the image at ${hex(m.base)}+${hex(m.imageSize)}`);
        this.text.push({ lo: m.text.addr, hi: m.text.addr + m.text.size });
      }
      const lo = set.modules[0].base, hi = Math.max(...set.modules.map(m => m.base + m.imageSize));
      this.a64.setCode(BigInt(lo), this.u8().subarray(lo, hi));
      // start contract: dependencies' init functions first (load order), the main module's last, then the entry
      for (const m of [...set.modules.slice(1), set.modules[0]]) { if (m.init) this.initQueue.push(m.init); this.initQueue.push(...m.initArray); }
      this.entry = set.entry;
      const stack = GUEST.stackRegion, size = (this.opts.mainStackSize + 0xFFF) & ~0xFFF;
      if (!this.k.kernel_map_stack(BigInt(stack), BigInt(size))) throw new Error("the kernel refused the main thread's stack");
      this.mainStackTop = stack + size;
      this.mainThread = this.k.kernel_create_main_thread(BigInt(this.ld.stubAddr(startId)), BigInt(this.mainStackTop));
      if (!this.mainThread) throw new Error("the kernel could not create the main thread");
    } catch (e) {
      this.faultNow(FAULT.load, (e instanceof Error ? e.message : String(e)).replace(/^\[RED\] /, ""));
      return false;
    }
    this.r.rt_load_ok();
    return true;
  }
  // The host function the main thread starts in: runs the init functions as guest calls, then enters the main module
  private startStep(cpu: HostCpu): HostResult {
    const start = cpu.rt.core.pc.value as bigint;
    const next = this.initQueue.shift();
    if (next !== undefined) { cpu.setX(30, start); return cpu.jump(next); }
    for (const m of this.modules) { this.ld.activate(m.handle); this.ld.pin(m.handle); }
    for (let i = 0; i < 30; i++) cpu.setX(i, 0);
    cpu.setX(1, this.mainThread); cpu.setX(30, PC_EXIT);
    this.core.sp.value = BigInt(this.mainStackTop);
    return cpu.jump(this.entry);
  }

  // A flat test guest of docs/CONTRACT.md ("Test guest ABI") as a single-thread process. The kernel serves its SVCs,
  // except GetSystemTick, which is the contract's counter (0, 1000, 2000, ...), and the initial register state is the
  // contract's (all zero), not Horizon's.
  loadFlat(image: Uint8Array, side: { base: number; entry: number; stack_top: number; bss_end?: number }): boolean {
    if (!this.r.rt_load_begin()) throw new Error("runtime: a process was loaded already");
    try {
      const base = side.base, top = (Math.max(side.stack_top, side.bss_end ?? 0, base + image.length) + 0xFFF) & ~0xFFF;
      this.ensure(top);
      this.u8().set(image, base);
      if (this.k.kernel_module_add(BigInt(base), BigInt(top - base), 0n, 0n) < 0) throw new Error("the kernel refused the flat image");
      this.text.push({ lo: base, hi: base + image.length });
      this.a64.setCode(BigInt(base), image);
      this.flat = true;
      this.mainThread = this.k.kernel_create_main_thread(BigInt(side.entry), BigInt(side.stack_top));
      if (!this.mainThread) throw new Error("the kernel could not create the main thread");
      const ctx = this.k.kernel_thread_ctx(this.k.kernel_thread_index(this.mainThread)) >>> 0, dv = this.dv();
      dv.setBigUint64(ctx + 8, 0n, true); dv.setBigUint64(ctx + 0x118, 0n, true); dv.setBigUint64(ctx + 0x120, 0n, true);
    } catch (e) {
      this.faultNow(FAULT.load, e instanceof Error ? e.message : String(e));
      return false;
    }
    this.r.rt_load_ok();
    return true;
  }

  // ---- time ----
  private wallNs(): bigint { return BigInt(Math.round((performance.now() - this.wallStart) * 1e6)); }
  // host time now (kernel_tick's scale), told to the kernel
  private tick(): void {
    const now: bigint = this.opts.clock === "wall" ? this.r.rt_clock_set(this.wallNs()) : this.r.rt_clock_now(this.core.budget.value);
    this.k.kernel_tick(now);
  }
  private cntpct(): bigint {
    if (this.flat) { this.flatTick += 1000n; return this.flatTick; }
    this.tick();
    if ((this.k.kernel_clock_reasons() & 2) && !this.frozenSeen) {
      // The kernel wants a counter read to wait while the app is in the background. An `mrs` is not a point where
      // translated code can unwind (no pc check after it), so the read returns the value the clock stands at.
      this.frozenSeen = true;
      this.log("[RED] runtime: cntpct_el0 read while the guest clock is frozen for background: the read does not wait (not implemented), it returns the standing value");
    }
    return this.k.kernel_guest_ticks();
  }
  private sleepMs(ms: number): void {
    if (ms <= 0) return;
    try {
      this.sleeper ??= new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(this.sleeper, 0, 0, ms);
    } catch { const end = performance.now() + ms; while (performance.now() < end) { /* no blocking wait on this thread */ } }
  }

  // ---- faults ----
  // From inside translated code (an import): remember it; the run loop reports it when core.run() has unwound
  private fault(kind: number, detail: string, aux = 0n, exact = true): void {
    this.pendFault ??= { kind, detail, aux, exact };
  }
  private faultNow(kind: number, detail: string, aux = 0n, ctx = 0, exact = true): void {
    const cap = this.r.rt_scratch_cap(), bytes = new TextEncoder().encode(detail).subarray(0, cap);
    this.u8().set(bytes, this.r.rt_scratch_ptr() >>> 0);
    const index = ctx ? this.k.kernel_thread_of_ctx(ctx) : -1;
    const handle = index >= 0 ? this.dv().getUint32((this.threadInfo(index)) + 28, true) : 0;
    this.r.rt_fault(kind, handle, index, index >= 0 ? ctx : 0, exact ? 1 : 0, aux, bytes.length);
    const f = this.r.rt_fault_ptr() >>> 0, dv = this.dv();
    this.stop = { kind: "fault", code: 0, fault: { kind: FAULT_NAMES[kind], thread: handle, threadIndex: index, pc: dv.getBigUint64(f + 8, true), aux, detail } };
  }
  private threadInfo(index: number): number {
    const p = (this.r.rt_scratch_ptr() >>> 0) + 2048;
    this.k.kernel_thread_info(index, p);
    return p;
  }

  // ---- translator callbacks ----
  private inText(pc: number): boolean { for (const t of this.text) if (pc >= t.lo && pc < t.hi) return true; return false; }
  // the index-0 trampoline: a pc with no entry in the pc map
  private onTranslate(pc: bigint): number {
    const p = Number(pc & M32);
    if (pc <= M32 && p >= STUBS.base && p < HOST_END) return this.thunk;
    const known = this.far.get(p);
    if (known !== undefined && pc <= M32) return known;
    if (pc > M32 || (p & 3) || !this.inText(p)) {
      this.fault(FAULT.jump, `${hex(pc)} is not in the text of a loaded module (called or returned to from near x30=${hex(this.core.x30.value)})`, pc);
      return A64Host.STOP;
    }
    try {
      const idx = this.a64.translateUnit([pc])[0];
      return idx;
    } catch (e) {
      this.fault(FAULT.jump, `no translatable code at ${hex(pc)}: ${e instanceof Error ? e.message : e}`, pc);
      return A64Host.STOP;
    }
  }
  // `svc #n` in translated code: the registers are written back and pc is the instruction after the svc
  private svc(n: number): void {
    const c = this.core, ctx = this.cur;
    this.stats.svcs++;
    if (this.flat && n === 0x1E) { c.x0.value = this.flatTick; this.flatTick += 1000n; return; }
    c.save_ctx(ctx);
    this.tick();
    if (n === 0x01 || n === 0x04 || n === 0x05 || n === 0x08 || n === 0x2C || n === 0x2D) this.spOk.clear();
    const act = this.k.kernel_svc(n, ctx);
    if (act === ACT_CONTINUE) c.load_ctx(ctx);
    else { if (act !== ACT_SWITCH) this.stopFlag = true; c.pc.value = PC_YIELD; }   // translated code unwinds; the context holds the real pc
  }

  // ---- host calls ----
  private cpuApi(): HostCpu {
    const c = this.core, rt = this, index = this.curIndex;
    const act = (a: Omit<Action, typeof ACTION> & { kind: "jump" | "block" }): Action => ({ [ACTION]: a.kind, pc: a.pc, event: a.event, timeout: a.timeout, resume: a.resume });
    return {
      rt, threadIndex: index,
      get thread() { return index >= 0 ? rt.dv().getUint32(rt.threadInfo(index) + 28, true) : 0; },
      get lr() { return c.x30.value as bigint; },
      x: (i: number) => c["x" + i].value as bigint,
      w: (i: number) => Number((c["x" + i].value as bigint) & M32),
      setX: (i: number, v: bigint | number) => { c["x" + i].value = BigInt.asUintN(64, BigInt(v)); },
      sp: () => c.sp.value as bigint,
      u8: () => rt.u8(), dv: () => rt.dv(),
      read: (addr, len) => rt.u8().slice(Number(addr), Number(addr) + len),
      write: (addr, bytes) => { rt.u8().set(bytes, Number(addr)); },
      cstr: (addr, max = 4096) => { const m = rt.u8(), a = Number(addr); let e = a; while (e < m.length && e - a < max && m[e]) e++; return dec.decode(m.slice(a, e)); },
      log: (line: string) => rt.log(line),
      jump: (pc) => act({ kind: "jump", pc: BigInt(pc) }),
      block: (event, timeout, resume) => act({ kind: "block", event, timeout, resume }),
      call: (fn, ...args) => rt.guestCall(BigInt(fn), args),
      now: () => rt.nowNs(),
      args: () => { c.save_ctx(rt.r.rt_ctx_scratch()); return rt.r.rt_nvn_args(rt.r.rt_ctx_scratch()) >>> 0; },
      waitFor: (done, at, resume) => {
        const ev = rt.eventOf(index), now = rt.nowNs();
        const e: Ext = { index, r: ev.r, w: ev.w, done: done === null, at: at === undefined || at < now ? now : at, signaled: false };
        rt.k.kernel_event_clear(ev.w);
        rt.exts.push(e);
        if (done) done.then(() => { e.done = true; rt.wake?.(); }, () => { e.done = true; rt.wake?.(); });
        return act({ kind: "block", event: ev.r, timeout: -1n, resume: (_how, cpu) => { rt.exts = rt.exts.filter(x => x !== e); rt.k.kernel_event_clear(ev.w); return resume(cpu); } });
      },
    };
  }
  // The thunk: pc is a stub address, registers are written back, x30 is where the guest wants to continue
  private hostCall(): void {
    const c = this.core, pc = Number((c.pc.value as bigint) & M32), id = (pc - STUBS.base) >>> 2;
    this.stats.hostCalls++;
    const t0 = performance.now();
    const cpu = this.cpuApi();
    let res: HostResult;
    const resume = this.pending.get(this.curIndex);
    if (resume) {
      // the thread comes back from a host-call wait: x0 is WaitSynchronization's result
      this.pending.delete(this.curIndex);
      const r = Number((c.x0.value as bigint) & M32);
      res = resume(r === 0 ? "signaled" : r === 0xEA01 ? "timeout" : "cancelled", cpu);
    } else {
      let h = this.handlers[id];
      if (h === undefined) {
        if (id >= this.ld.x.ld_host_count()) { this.fault(FAULT.jump, `${hex(pc)} is in the stub region but no host function has stub ${id}`, BigInt(pc)); c.stop(); return; }
        const f = this.ld.hostFunction(id);
        h = f.kind === HOST_UNRESOLVED ? null : this.registry.get(f.name) ?? null;
        this.handlers[id] = h;
      }
      if (h === null) {
        const name = this.ld.hostFunction(id).name;
        if (!this.unresolvedSeen.has(name)) { this.unresolvedSeen.add(name); this.log(`[RED] call to unresolved import ${name} from ${hex(c.x30.value)}`); }
        res = 0;
      } else res = h.fn(cpu);
    }
    this.finishHostCall(res, cpu, pc);
    this.times.hostMs += performance.now() - t0;
  }
  // A guest function run to completion inside a host call: a nested core.run() that ends when the function returns
  // to PC_CALLBACK. The outer translated frames are still on the wasm stack; they go on when the host call returns.
  // ---- waits for things outside the guest ----
  nowNs(): bigint { return this.opts.clock === "wall" ? this.r.rt_clock_set(this.wallNs()) : this.r.rt_clock_now(this.core.budget.value); }
  private eventOf(index: number): { r: number; w: number } {
    let ev = this.threadEvent.get(index);
    if (!ev) { const p = (this.r.rt_scratch_ptr() >>> 0) + 3072; const r = this.k.kernel_event_new(p); ev = { r, w: this.dv().getUint32(p, true) }; this.threadEvent.set(index, ev); }
    return ev;
  }
  // Signals the waits whose outside thing has happened and whose time has come. Returns the earliest time of a wait
  // not yet signaled (0n: none) and whether one is overdue (its time has come but the outside thing has not).
  private pumpExternals(now: bigint): { next: bigint; overdue: boolean; nextDone: bigint } {
    let next = 0n, nextDone = 0n, overdue = false;
    for (const e of this.exts) {
      if (e.signaled) continue;
      if (e.done && e.at <= now) { this.k.kernel_event_signal(e.w); e.signaled = true; continue; }
      if (!e.done && e.at <= now) overdue = true;
      if (next === 0n || e.at < next) next = e.at;
      if (e.done && (nextDone === 0n || e.at < nextDone)) nextDone = e.at;
    }
    return { next, overdue, nextDone };
  }
  get waitingOutside(): number { return this.exts.filter(e => !e.signaled).length; }
  // The embedder ends the process (Ready, Running or Paused)
  kill(): void {
    if (this.state === "Stopped" || this.state === "Empty" || this.state === "Loading") return;
    this.r.rt_kill(); this.stop = { kind: "killed", code: 0 };
    this.wake?.();
  }
  // run() for a host with an event loop: slices stay synchronous, and between them control goes back to the event
  // loop, every yieldMs while threads run and for as long as every thread waits for something outside the guest.
  async runAsync(o: { yieldMs?: number } = {}): Promise<RunResult> {
    for (;;) {
      const r = this.run({ async: true, yieldMs: o.yieldMs ?? 8 });
      if (!r.idle && !r.yielded) return r;
      await new Promise<void>(res => {
        this.wake = res;
        if (!r.idle) setTimeout(res, 0);
        else {
          if (r.wakeMs !== undefined) setTimeout(res, Math.max(0, r.wakeMs));
          // something finished between run() returning and this promise: do not sleep through it
          const wall = this.opts.clock === "wall", now = wall ? this.wallNs() : 0n;
          for (const e of this.exts) if (e.done && !e.signaled) { if (!wall || e.at <= now) res(); else setTimeout(res, Number(e.at - now) / 1e6); }
          if (this.pauseAsked || this.state === "Stopped") res();
        }
      });
      this.wake = null;
    }
  }

  guestCall(fn: bigint, args: (bigint | number)[]): bigint {
    const c = this.core, r = this.r, lr: bigint = c.x30.value;
    args.forEach((a, i) => { c["x" + i].value = BigInt.asUintN(64, BigInt(a)); });
    c.x30.value = PC_CALLBACK; c.pc.value = fn;
    for (;;) {
      c.run();
      if (this.pendFault || this.stopFlag) throw new GuestCallAbort();
      const pc: bigint = c.pc.value;
      if (pc === PC_CALLBACK) break;
      if (pc === PC_YIELD) { this.fault(FAULT.host, `a guest callback at ${hex(fn)} blocked or gave up its core inside a host function`, fn, false); throw new GuestCallAbort(); }
      if (pc >= PC_SPECIAL) { this.fault(FAULT.jump, `${hex(pc)} reached inside a guest callback at ${hex(fn)}`, pc); throw new GuestCallAbort(); }
      if (c.budget.value < 0) {   // the callback is not preempted: account the slice and give it another
        const now: bigint = this.opts.clock === "wall" ? r.rt_clock_set(this.wallNs()) : r.rt_clock_slice_end(c.budget.value);
        if (this.opts.clock === "wall") r.rt_clock_slice_end(c.budget.value);
        this.k.kernel_tick(now);
        c.budget.value = this.opts.budget; r.rt_clock_slice_begin(this.opts.budget);
      }
    }
    c.x30.value = lr;
    return c.x0.value;
  }
  private finishHostCall(res: HostResult, cpu: HostCpu, stubPc: number): void {
    const c = this.core;
    for (;;) {
      if (typeof res === "number" || typeof res === "bigint") c.x0.value = BigInt.asUintN(64, BigInt(res));
      if (res === undefined || typeof res !== "object") { c.pc.value = c.x30.value; return; }
      if (res[ACTION] === "jump") { c.pc.value = res.pc!; return; }
      // block: WaitSynchronization on the event, made on the thread's behalf, with pc at the stub so that the woken
      // thread enters hostCall() again and finds its resume
      const ctx = this.cur, slot = this.r.rt_wait_slot(this.curIndex) >>> 0;
      c.pc.value = BigInt(stubPc);
      c.save_ctx(ctx);
      const dv = this.dv();
      dv.setUint32(slot, res.event!, true);
      dv.setBigUint64(ctx + 8, BigInt(slot), true); dv.setBigUint64(ctx + 16, 1n, true); dv.setBigInt64(ctx + 24, res.timeout!, true);
      this.tick();
      const act = this.k.kernel_svc(0x18, ctx);
      if (act === ACT_CONTINUE) {   // signaled already, zero timeout, or a bad handle: no wait happened
        c.load_ctx(ctx);
        const r = Number((c.x0.value as bigint) & M32);
        res = res.resume!(r === 0 ? "signaled" : r === 0xEA01 ? "timeout" : "cancelled", cpu);
        continue;
      }
      this.pending.set(this.curIndex, res.resume!);
      if (act !== ACT_SWITCH) this.stopFlag = true;
      c.pc.value = PC_YIELD;
      return;
    }
  }

  // ---- the run loop ----
  requestPause(): void { this.pauseAsked = true; this.wake?.(); }
  // Runs guest threads until the process stops, or pauses (requestPause(), or the limits given here).
  run(limit: RunLimit = {}): RunResult {
    const r = this.r, k = this.k, c = this.core;
    if (this.state === "Stopped") return { state: "Stopped", stop: this.stop };
    if (this.state === "Ready") { r.rt_start(); if (this.opts.clock === "wall") this.wallStart = performance.now(); }
    else if (this.state === "Paused") { r.rt_resume(); this.pauseAsked = false; }
    else if (this.state !== "Running") throw new Error(`runtime: run() in state ${this.state}`);
    const t0 = performance.now(), wall = this.opts.clock === "wall";
    let slices = 0;
    for (;;) {
      if (this.pauseAsked || (limit.slices !== undefined && slices >= limit.slices) || (limit.ms !== undefined && performance.now() - t0 >= limit.ms)) {
        r.rt_pause(); this.pauseAsked = false;
        break;
      }
      if (limit.yieldMs !== undefined && performance.now() - t0 >= limit.yieldMs) { this.stats.runMs += performance.now() - t0; return { state: this.state, yielded: true }; }
      let budget = this.opts.budget;
      const hasExt = this.exts.length > 0;
      let ext = { next: 0n, overdue: false, nextDone: 0n };
      if (hasExt) {
        const now: bigint = wall ? r.rt_clock_set(this.wallNs()) : r.rt_clock_now(0);
        ext = this.pumpExternals(now);
        if (!wall) {
          // deterministic: guest time does not pass the time of a wait whose outside thing has not happened yet
          if (ext.overdue) { const out = this.outside(limit, t0, undefined); if (out) return out; break; }
          if (ext.next > now) { const room = (ext.next - now + BigInt(this.opts.nsPerUnit) - 1n) / BigInt(this.opts.nsPerUnit); if (room < BigInt(budget)) budget = Number(room); }
        }
      }
      const ctx: number = k.kernel_schedule() >>> 0;
      if (!ctx) {
        if (k.kernel_stop_reason()) { this.finish(); break; }
        // every thread waits: time moves to the next deadline
        const until = BigInt.asUintN(64, k.kernel_next_timeout());   // wasm hands a u64 over as a signed BigInt
        if (ext.next !== 0n) {
          if (!wall && ext.next <= until) {
            // the next thing in guest time is an outside wait: if it has happened, time moves there; else wait for it
            if (ext.nextDone === ext.next) { k.kernel_tick(r.rt_clock_set(ext.next)); continue; }
            const out = this.outside(limit, t0, undefined); if (out) return out; break;
          }
          if (wall) {
            const target = ext.nextDone !== 0n && ext.nextDone < until ? ext.nextDone : until;
            const out = this.outside(limit, t0, target === FOREVER ? undefined : Number(target - this.wallNs()) / 1e6); if (out) return out; break;
          }
        }
        if (until === FOREVER) { this.faultNow(FAULT.deadlock, "every thread waits and no wait has a deadline", 0n, this.lastCtx, true); break; }
        if (wall) {
          if (limit.async) { this.stats.runMs += performance.now() - t0; return { state: this.state, idle: true, wakeMs: Number(until - this.wallNs()) / 1e6 }; }
          this.sleepMs(Number(until - this.wallNs()) / 1e6); k.kernel_tick(r.rt_clock_set(this.wallNs()));
        } else k.kernel_tick(r.rt_clock_set(until));
        continue;
      }
      if (ctx !== this.lastCtx) c.excl_addr.value = -1n;   // a context switch clears the exclusive monitor
      this.cur = this.lastCtx = ctx; this.curIndex = k.kernel_thread_of_ctx(ctx);
      c.load_ctx(ctx);
      c.budget.value = budget;
      r.rt_clock_slice_begin(budget);
      slices++; this.stats.slices++;
      let trap: unknown;
      try { c.run(); } catch (e) { trap = e ?? new Error("unknown exception"); }
      k.kernel_tick(wall ? r.rt_clock_set(this.wallNs()) : r.rt_clock_slice_end(c.budget.value));
      if (wall) r.rt_clock_slice_end(c.budget.value);
      if (trap instanceof GuestCallAbort && !this.pendFault && this.stopFlag) trap = undefined;   // the process ended inside a callback
      if (trap !== undefined || this.pendFault) {
        // the registers go into the thread's context for the report (after a trap: as of the last write-back)
        const pf = this.pendFault;
        if (c.pc.value !== PC_YIELD) c.save_ctx(ctx);
        if (pf) this.faultNow(pf.kind, pf.detail, pf.aux, ctx, pf.exact);
        else if (trap instanceof WebAssembly.RuntimeError) this.faultNow(FAULT.trap, trap.message, 0n, ctx, false);
        else if (trap instanceof RangeError) this.faultNow(FAULT.trap, "the wasm stack is exhausted (" + trap.message + ")", 0n, ctx, false);
        else this.faultNow(FAULT.host, trap instanceof Error ? `${trap.name}: ${trap.message}` : String(trap), 0n, ctx, false);
        break;
      }
      if (this.stopFlag) { this.finish(); break; }
      const pc: bigint = c.pc.value;
      if (pc === PC_YIELD) continue;               // an SVC or host call gave up the core; the context was saved there
      c.save_ctx(ctx);
      if (pc === PC_EXIT) { k.kernel_thread_returned(ctx); if (k.kernel_stop_reason()) { this.finish(); break; } continue; }
      if (pc >= PC_SPECIAL) { this.faultNow(FAULT.jump, `${hex(pc)} is a reserved pc value`, pc, ctx); break; }
      if (!this.stackOk(ctx)) break;
      if (c.budget.value < 0) k.kernel_preempt(ctx);
    }
    this.stats.runMs += performance.now() - t0;
    return { state: this.state, stop: this.stop };
  }
  // Every thread waits for something outside the guest (or guest time may not pass it): an asynchronous caller gets
  // `idle` and calls again; a synchronous run() cannot wait and stops with a host fault (it returns nothing then).
  private outside(limit: RunLimit, t0: number, wakeMs: number | undefined): RunResult | null {
    if (limit.async) { this.stats.runMs += performance.now() - t0; return { state: this.state, idle: true, wakeMs }; }
    this.faultNow(FAULT.host, "a guest thread waits for something outside the guest (a GPU completion, a frame); run() cannot wait for it, use runAsync()", 0n, this.lastCtx, true);
    return null;
  }
  private finish(): void {
    const reason = this.k.kernel_stop_reason(), code = this.k.kernel_exit_code();
    if (reason === 2) { this.r.rt_break(code); this.stop = { kind: "break", code }; }
    else { this.r.rt_exit(code); this.stop = { kind: "exit", code }; }
  }
  // At the end of a slice: the stack pointer must be in mapped memory (linear memory has no guard pages)
  private stackOk(ctx: number): boolean {
    const sp64: bigint = this.core.sp.value, sp = Number(sp64 & M32), ok = this.spOk.get(this.curIndex);
    if (sp64 <= M32 && ok && sp > ok.lo && sp <= ok.hi) return true;
    const q = this.r.rt_query_ptr() >>> 0;
    this.k.kernel_query_memory(sp64 - 1n, q);
    const dv = this.dv(), lo = Number(dv.getBigUint64(q, true)), size = Number(dv.getBigUint64(q + 8, true)), state = dv.getUint32(q + 16, true);
    if (sp64 > M32 || state === 0) {
      this.faultNow(FAULT.stack, `sp=${hex(sp64)} is in unmapped memory (free range ${hex(lo)}..${hex(lo + size)})`, sp64, ctx);
      return false;
    }
    this.spOk.set(this.curIndex, { lo, hi: lo + size });
    return true;
  }
}
