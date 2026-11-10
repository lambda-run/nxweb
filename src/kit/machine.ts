// The state machine kit (AssemblyScript). See README.md.
//
// A machine is defined once in defs/<name>.json; gen/tables.ts (generated) holds every table in one static blob.
// An instance (Inst) is a 16-byte record placed wherever its owner wants: a state id, the machine id, an instance id
// and the 64-bit value the current state carries. Inst.step is the only way a state changes. Nothing here allocates.
import { BLOB, HITS, MACHINE_COUNT } from "./gen/tables";

// The embedder's log: UTF-8 bytes in linear memory. Red lines start with "[RED] ".
// @ts-ignore: decorator
@external("env", "log")
declare function log(ptr: usize, len: i32): void;

export const NONE: u8 = 0xFF;       // table cell: no transition
export const DATA_ANY: u8 = 0xFF;   // dataMax: the state carries a free 64-bit value

// Why an event was refused (trace flags, bits 1-2)
export const REFUSED_NO_TRANSITION: u8 = 1;   // the table has no entry for (state, event)
export const REFUSED_UNKNOWN_EVENT: u8 = 2;   // the event id is not one of the machine's events
export const REFUSED_BAD_DATA: u8 = 3;        // the target state carries an enumerated value and the argument is not one

// Trace: a ring of TRACE_CAP records of TRACE_REC bytes at traceBase(). Record n (counted from 0, never reset
// except by traceClear) is at slot n % TRACE_CAP; traceTotal() is how many were written.
//   +0 u32 sequence number   +4 u32 instance id   +8 u16 machine id
//   +10 u8 from   +11 u8 to (= from when refused)   +12 u8 event   +13 u8 flags: bit 0 refused, bits 1-2 the reason
export const TRACE_CAP: u32 = 4096;
export const TRACE_REC: u32 = 16;
const TRACE: usize = memory.data(65536);   // TRACE_CAP * TRACE_REC

const F_TRACE: u32 = 1, F_COVER: u32 = 2;
let flags: u32 = F_TRACE;
let total: u32 = 0;
let refused: u32 = 0;

export function traceBase(): usize { return TRACE; }
export function traceTotal(): u32 { return total; }
export function traceEnabled(): bool { return (flags & F_TRACE) != 0; }
export function traceEnable(on: bool): void { flags = on ? flags | F_TRACE : flags & ~F_TRACE; }
export function traceClear(): void { total = 0; }
// Refused events since the start, counted whether tracing is on or not
export function refusedTotal(): u32 { return refused; }
// Coverage: with it on, every accepted transition sets its byte at HITS (same cell order as the tables). Off by default.
export function coverEnable(on: bool): void { flags = on ? flags | F_COVER : flags & ~F_COVER; }

// Directory record of a machine (layout: host/defs.mts)
// @ts-ignore: decorator
@inline function dir(machine: u8): usize { return BLOB + (<usize>machine << 4); }

function record(inst: Inst, from: u8, to: u8, ev: u8, fl: u8): void {
  const p = TRACE + <usize>((total & (TRACE_CAP - 1)) * TRACE_REC);
  store<u32>(p, total);
  store<u32>(p, inst.id, 4);
  store<u16>(p, <u16>inst.machine, 8);
  store<u8>(p, from, 10);
  store<u8>(p, to, 11);
  store<u8>(p, ev, 12);
  store<u8>(p, fl, 13);
  store<u16>(p, 0, 14);
  total++;
}

// Only reached with tracing or coverage on
function note(inst: Inst, cell: u32, from: u8, to: u8, ev: u8): void {
  if (flags & F_COVER) store<u8>(HITS + <usize>(load<u32>(dir(inst.machine), 8) + cell), 1);
  if (flags & F_TRACE) record(inst, from, to, ev, 0);
}

// ---- the red line of a refusal, built in a static buffer ----
const LINE: usize = memory.data(256);
const LINE_CAP: i32 = 256;
let lineLen: i32 = 0;

function putc(c: u8): void { if (lineLen < LINE_CAP) { store<u8>(LINE + <usize>lineLen, c); lineLen++; } }
function puts(s: string): void { for (let i = 0, n = s.length; i < n; i++) putc(<u8>s.charCodeAt(i)); }
function putu(v: u32): void { if (v >= 10) putu(v / 10); putc(<u8>(48 + v % 10)); }
// Name n of a machine: 0 is the machine, then its states, then its events
function putName(machine: u8, n: u32): void {
  let p = BLOB + <usize>load<u32>(dir(machine), 4);
  for (; n; n--) p += 1 + <usize>load<u8>(p);
  for (let i: usize = 1, len = <usize>load<u8>(p); i <= len; i++) putc(load<u8>(p + i));
}

function refuse(inst: Inst, ev: u8, reason: u8): bool {
  refused++;
  const m = inst.machine, from = inst.state, rec = dir(m);
  if (flags & F_TRACE) record(inst, from, from, ev, 1 | (reason << 1));
  lineLen = 0;
  puts("[RED] kit: "); putName(m, 0); putc(35); putu(inst.id); puts(" refused ");
  if (reason == REFUSED_UNKNOWN_EVENT) { puts("event "); putu(ev); }
  else putName(m, 1 + <u32>load<u8>(rec, 12) + ev);
  puts(" in "); putName(m, 1 + <u32>from);
  puts(reason == REFUSED_NO_TRANSITION ? " (no transition)" : reason == REFUSED_UNKNOWN_EVENT ? " (unknown event)" : " (bad data)");
  log(LINE, lineLen);
  return false;
}

// One instance of a machine. 16 bytes, unmanaged: put it in static memory, in a pool, or inside a larger record
// (Inst.at(pointer)). Read `state` and `data` freely; write them only through init and step.
// @ts-ignore: decorator
@unmanaged
export class Inst {
  state: u8;      // current state id (<Machine>S.* in gen/tables.ts)
  machine: u8;    // machine id
  private pad: u16;
  id: u32;        // which instance of the machine this is (a thread index, ...): only for the trace and the log
  data: u64;      // what the current state carries; 0 in a state that carries nothing

  static readonly SIZE: usize = 16;

  // @ts-ignore: decorator
  @inline static at(ptr: usize): Inst { return changetype<Inst>(ptr); }

  // Put the instance in its machine's initial state
  init(machine: u8, id: u32): void {
    if (machine >= MACHINE_COUNT) {
      lineLen = 0; puts("[RED] kit: no machine with id "); putu(machine); log(LINE, lineLen);
      unreachable();
    }
    this.machine = machine;
    this.state = load<u8>(dir(machine), 14);
    this.pad = 0;
    this.id = id;
    this.data = 0;
  }

  // Whether the table has a transition for ev in the current state. A pure query, for guards: it changes and reports nothing
  // @ts-ignore: decorator
  @inline can(ev: u8): bool {
    const rec = dir(this.machine), nEv = load<u8>(rec, 13);
    return ev < nEv && load<u8>(BLOB + <usize>(load<u32>(rec) + <u32>this.state * nEv + ev)) != NONE;
  }

  // The event ev happened. With a transition for it in the table: the state changes and the result is true.
  // Without one: nothing changes, a red line is logged and the result is false.
  // arg is the value the new state carries, when it carries one (ignored otherwise). A state that carries nothing has
  // data 0; a transition from a state to itself keeps its data.
  step(ev: u8, arg: u64 = 0): bool {
    const rec = dir(this.machine);
    const nEv = load<u8>(rec, 13);
    if (ev >= nEv) return refuse(this, ev, REFUSED_UNKNOWN_EVENT);
    const from = this.state;
    const tab = BLOB + <usize>load<u32>(rec);
    const cell = <u32>from * nEv + ev;
    const to = load<u8>(tab + <usize>cell);
    if (to == NONE) return refuse(this, ev, REFUSED_NO_TRANSITION);
    if (to != from) {
      const max = load<u8>(tab + <usize>(<u32>load<u8>(rec, 12) * nEv + to));   // dataMax[to]
      if (max == 0) this.data = 0;
      else {
        if (max != DATA_ANY && arg - 1 >= <u64>max) return refuse(this, ev, REFUSED_BAD_DATA);
        this.data = arg;
      }
      this.state = to;
    }
    if (flags) note(this, cell, from, to, ev);
    return true;
  }
}
