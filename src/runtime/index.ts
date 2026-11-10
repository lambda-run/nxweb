// nxweb runtime core (AssemblyScript): the process lifecycle machine, the fault report, the deterministic guest
// clock's arithmetic and the check of the shared memory's range table. It lives in the same linear memory as the
// kernel, the loader and the guest, so it reads a faulting thread's context block where the kernel keeps it.
// The run loop itself is glue (src/glue/rt_runtime.ts); see README.md.
export * from "../kit/exports";
import { Inst } from "../kit/machine";
import { PROCESS, ProcessS, ProcessE } from "../kit/gen/tables";

// @ts-ignore: decorator
@external("env", "log")
declare function hostLog(ptr: usize, len: i32): void;

// ---- log lines ----
const LINE: usize = memory.data(1024);
const LINE_CAP: i32 = 1024;
let lineLen: i32 = 0;
function putc(c: u8): void { if (lineLen < LINE_CAP) { store<u8>(LINE + <usize>lineLen, c); lineLen++; } }
function puts(s: string): void { for (let i = 0, n = s.length; i < n; i++) putc(<u8>s.charCodeAt(i)); }
function putu(v: u64): void { if (v >= 10) putu(v / 10); putc(<u8>(48 + v % 10)); }
function putx(v: u64): void {
  putc(48); putc(120);
  let started = false;
  for (let sh = 60; sh >= 0; sh -= 4) {
    const d = <u8>((v >> sh) & 15);
    if (d || started || sh == 0) { putc(d < 10 ? 48 + d : 87 + d); started = true; }
  }
}
function putBytes(ptr: usize, len: i32): void { for (let i = 0; i < len; i++) putc(load<u8>(ptr + <usize>i)); }
function lineStart(s: string): void { lineLen = 0; puts(s); }
function lineEnd(): void { hostLog(LINE, lineLen); }

// ---- scratch the glue may write: a detail text, the range table, per-thread wait slots ----
const SCRATCH: usize = memory.data(4096);
const WAIT_SLOTS: usize = memory.data(1024);   // 256 threads * u32: the handle list of a host-call wait
const QUERY: usize = memory.data(32);          // kernel_query_memory's answer
export function rt_scratch_ptr(): usize { return SCRATCH; }
export function rt_scratch_cap(): u32 { return 4096; }
export function rt_wait_slot(threadIndex: u32): usize { return WAIT_SLOTS + (<usize>(threadIndex & 255) << 2); }
export function rt_query_ptr(): usize { return QUERY; }
// A context block (contract layout) the glue saves the live CPU state into to read what JavaScript cannot read from
// globals (the v registers), and the argument block of an NVN call: x0..x7 then d0..d7
const CTX_SCRATCH: usize = memory.data(0x330);
const NVN_ARGS: usize = memory.data(128);
export function rt_ctx_scratch(): usize { return CTX_SCRATCH; }
// Fills the NVN argument block from a saved context: x0..x7, then the low 64 bits of v0..v7. Returns its address.
export function rt_nvn_args(ctx: usize): usize {
  memory.copy(NVN_ARGS, ctx, 64);
  for (let i = 0; i < 8; i++) store<u64>(NVN_ARGS + 64 + (<usize>i << 3), load<u64>(ctx + 0x130 + (<usize>i << 4)));
  return NVN_ARGS;
}
export function rt_static_end(): usize { return __heap_base; }

// ---- the shared memory's range table ----
// The glue writes n records of two u64 (lo, hi) in address order at ptr. 0 = sound: every range is not empty, starts
// where the one before it ends (so none overlaps another and there is no unowned hole) and the last ends at `end`.
// Otherwise the 1-based index of the first bad record, with a red line.
export function rt_ranges_check(ptr: usize, n: i32, end: u64): i32 {
  let at: u64 = 0;
  for (let i = 0; i < n; i++) {
    const lo = load<u64>(ptr + (<usize>i << 4)), hi = load<u64>(ptr + (<usize>i << 4), 8);
    if (lo != at || hi <= lo) {
      lineStart("[RED] runtime: memory range "); putu(i); puts(" ["); putx(lo); puts(", "); putx(hi); puts(") ");
      puts(hi <= lo ? "is empty" : lo < at ? "overlaps the range before it" : "leaves a hole after the range before it"); lineEnd();
      return i + 1;
    }
    at = hi;
  }
  if (at != end) { lineStart("[RED] runtime: the memory ranges end at "); putx(at); puts(", not at "); putx(end); lineEnd(); return n + 1; }
  return 0;
}
// A module's static data [base, staticEnd) must lie inside its range [lo, hi). 0 = fine.
export function rt_static_check(which: i32, lo: u64, hi: u64, staticEnd: u64): i32 {
  if (staticEnd > lo && staticEnd <= hi) return 0;
  lineStart("[RED] runtime: module "); putu(which); puts(": static data ends at "); putx(staticEnd); puts(", outside its range [");
  putx(lo); puts(", "); putx(hi); puts(")"); lineEnd();
  return 1;
}

// ---- the process ----
export const STOP_EXIT: u32 = 1, STOP_BREAK: u32 = 2, STOP_FAULT: u32 = 3, STOP_KILLED: u32 = 4;
export const FAULT_UNIMPLEMENTED: u32 = 1;   // the translator met an instruction it does not translate (aux = the word)
export const FAULT_BRK: u32 = 2;             // a BRK instruction (aux = its immediate)
export const FAULT_TRAP: u32 = 3;            // a WebAssembly trap in translated code (memory access out of bounds, ...)
export const FAULT_JUMP: u32 = 4;            // control reached an address that is not code of a loaded module
export const FAULT_STACK: u32 = 5;           // the stack pointer left mapped memory
export const FAULT_DEADLOCK: u32 = 6;        // every thread waits and no wait has a deadline
export const FAULT_LOAD: u32 = 7;            // the loader refused a file
export const FAULT_HOST: u32 = 8;            // the embedder itself failed (an exception in glue or in a host function)

const PROC: usize = memory.data(16);
// The fault record, for the embedder: +0 kind u32, +4 thread handle u32, +8 pc u64, +16 aux u64, +24 thread index i32
const FAULT: usize = memory.data(32);

// @ts-ignore: decorator
@inline function proc(): Inst { return Inst.at(PROC); }

export function rt_init(): void { proc().init(PROCESS, 0); memory.fill(FAULT, 0, 32); clockInit(0, 0); }
export function rt_state(): u32 { return proc().state; }
export function rt_stop_kind(): u32 { return proc().state == ProcessS.Stopped ? <u32>(proc().data >> 32) : 0; }
export function rt_stop_value(): u32 { return proc().state == ProcessS.Stopped ? <u32>proc().data : 0; }
export function rt_fault_ptr(): usize { return FAULT; }

// Each returns 1 when the machine took the step, 0 when it refused (red, from the kit)
export function rt_load_begin(): i32 { return proc().step(ProcessE.Load) ? 1 : 0; }
export function rt_load_ok(): i32 { return proc().step(ProcessE.LoadOk) ? 1 : 0; }
export function rt_start(): i32 { return proc().step(ProcessE.Start) ? 1 : 0; }
export function rt_pause(): i32 { return proc().step(ProcessE.Pause) ? 1 : 0; }
export function rt_resume(): i32 { return proc().step(ProcessE.Resume) ? 1 : 0; }
export function rt_exit(code: i32): i32 { return proc().step(ProcessE.Exit, (<u64>STOP_EXIT << 32) | <u64><u32>code) ? 1 : 0; }
export function rt_break(code: i32): i32 { return proc().step(ProcessE.Break, (<u64>STOP_BREAK << 32) | <u64><u32>code) ? 1 : 0; }

// The embedder ends the process (the page's stop button): from Ready, Running or Paused
export function rt_kill(): i32 { return proc().step(ProcessE.Kill, <u64>STOP_KILLED << 32) ? 1 : 0; }

function faultName(kind: u32): string {
  switch (kind) {
    case FAULT_UNIMPLEMENTED: return "unimplemented instruction";
    case FAULT_BRK: return "brk instruction";
    case FAULT_TRAP: return "wasm trap";
    case FAULT_JUMP: return "jump to an address that is not code";
    case FAULT_STACK: return "stack overflow";
    case FAULT_DEADLOCK: return "deadlock";
    case FAULT_LOAD: return "load failed";
    case FAULT_HOST: return "host failure";
  }
  return "unknown fault";
}
// The process stops with a fault. ctx: the faulting thread's context block (contract layout; the glue saved the CPU
// state into it), 0 when no thread is involved. pcExact = 0: the pc is where the registers were last written back
// (function entry or the last call), as after a wasm trap. The detail text is at rt_scratch_ptr(), detailLen bytes.
// Red lines: what, where, in which thread; then x0..x30, sp, pc and nzcv on four lines ("[RED]   x0=" starts the first).
export function rt_fault(kind: u32, threadHandle: u32, threadIndex: i32, ctx: usize, pcExact: i32, aux: u64, detailLen: i32): i32 {
  const pc: u64 = ctx ? load<u64>(ctx, 0x100) : 0;
  store<u32>(FAULT, kind, 0); store<u32>(FAULT, threadHandle, 4); store<u64>(FAULT, pc, 8); store<u64>(FAULT, aux, 16); store<i32>(FAULT, threadIndex, 24);
  lineStart("[RED] fault: "); puts(faultName(kind));
  if (ctx) {
    puts(" in thread "); putx(threadHandle); puts(" (#"); putu(<u64>threadIndex); puts(") at pc=");
    putx(pc); if (!pcExact) puts(" (last synced pc, the fault is at or after it)");
  }
  if (detailLen > 0) { puts(": "); putBytes(SCRATCH, detailLen < 900 ? detailLen : 900); }
  lineEnd();
  if (ctx) {
    // every register, eight to a line; the last line ends with sp, pc, nzcv, tpidr_el0 and tpidrro_el0
    for (let i = 0; i < 31; i++) {
      if (!(i & 7)) lineStart("[RED]   "); else putc(32);
      putc(120); putu(i); putc(61); putx(load<u64>(ctx + (<usize>i << 3)));
      if ((i & 7) == 7) lineEnd();
    }
    puts(" sp="); putx(load<u64>(ctx, 0xF8)); puts(" pc="); putx(pc); puts(" nzcv="); putx(load<u32>(ctx, 0x108));
    puts(" tpidr="); putx(load<u64>(ctx, 0x118)); puts(" tpidrro="); putx(load<u64>(ctx, 0x120));
    lineEnd();
  }
  return proc().step(ProcessE.Fault, (<u64>STOP_FAULT << 32) | <u64>kind) ? 1 : 0;
}

// ---- the guest clock's source ----
// Deterministic mode: host time (the kernel_tick scale, ns) is a function of the budget units the guest executed:
// every unit (a function entry or a backward branch of translated code) is nsPerUnit ns. Runs are reproducible.
// The glue brackets each slice with rt_clock_slice_begin/end and asks rt_clock_now(budget left) at each SVC and each
// counter read. Wall mode: the glue passes its own monotonic ns to rt_clock_set and this only keeps the totals.
let nsPerUnit: u64 = 0;
let wall: bool = false;
let now: u64 = 0;          // ns at the start of the current slice
let sliceBudget: i32 = 0;
let units: u64 = 0;        // budget units executed in all finished slices
let slices: u64 = 0;

function clockInit(mode: i32, ns: u64): void { wall = mode != 0; nsPerUnit = ns; now = 0; sliceBudget = 0; units = 0; slices = 0; }
export function rt_clock_init(wallClock: i32, nsPerBudgetUnit: u64): void { clockInit(wallClock, nsPerBudgetUnit); }
// @ts-ignore: decorator
@inline function used(budgetLeft: i32): u64 { return <u64>(sliceBudget - (budgetLeft < 0 ? 0 : budgetLeft)); }
export function rt_clock_slice_begin(budget: i32): void { sliceBudget = budget; }
export function rt_clock_now(budgetLeft: i32): u64 { return wall ? now : now + used(budgetLeft) * nsPerUnit; }
export function rt_clock_slice_end(budgetLeft: i32): u64 {
  const u = used(budgetLeft);
  units += u; slices++;
  if (!wall) now += u * nsPerUnit;
  sliceBudget = 0;
  return now;
}
// Every thread waits: time jumps to the next deadline (deterministic), or is what the host says (wall)
export function rt_clock_set(t: u64): u64 { if (t > now) now = t; return now; }
export function rt_clock_units(): u64 { return units; }
export function rt_clock_slices(): u64 { return slices; }
