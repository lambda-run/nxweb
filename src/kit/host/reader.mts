// Embedder side of the kit: reads the trace ring, the tables and the hit bitmap of a wasm module that exports
// src/kit/exports.ts. Works in Node and in the browser (no Node APIs).
import { DIR_REC, NONE } from "./defs.mts";

export interface KitExports {
  memory: WebAssembly.Memory;
  kit_trace_ptr(): number; kit_trace_cap(): number; kit_trace_rec(): number; kit_trace_total(): number;
  kit_trace_enable(on: number): void; kit_trace_enabled(): number; kit_trace_clear(): void;
  kit_refused_total(): number; kit_cover_enable(on: number): void;
  kit_machine_count(): number; kit_blob_ptr(): number; kit_hits_ptr(): number; kit_hits_size(): number;
}

export interface TraceRecord { seq: number; machine: number; instance: number; from: number; to: number; event: number; refused: boolean; reason: number }

export const REASONS = ["", "no transition", "unknown event", "bad data"];

// The records still in the ring, oldest first (at most kit_trace_cap(); older ones were overwritten)
export function readTrace(x: KitExports): TraceRecord[] {
  const total = x.kit_trace_total() >>> 0, cap = x.kit_trace_cap(), rec = x.kit_trace_rec();
  const dv = new DataView(x.memory.buffer), base = Number(x.kit_trace_ptr()), out: TraceRecord[] = [];
  for (let n = Math.max(0, total - cap); n < total; n++) {
    const p = base + (n % cap) * rec, fl = dv.getUint8(p + 13);
    out.push({ seq: dv.getUint32(p, true), instance: dv.getUint32(p + 4, true), machine: dv.getUint16(p + 8, true),
      from: dv.getUint8(p + 10), to: dv.getUint8(p + 11), event: dv.getUint8(p + 12), refused: (fl & 1) !== 0, reason: (fl >> 1) & 3 });
  }
  return out;
}

export interface WasmMachine {
  id: number; name: string; states: string[]; events: string[]; initial: number;
  table: Uint8Array;     // [from * events.length + event] = to, or NONE
  dataMax: Uint8Array;   // per state
  hits: Uint8Array;      // a copy of the hit bitmap, same cells as table
}

// The machines as the compiled module has them
export function readMachines(x: KitExports): WasmMachine[] {
  const mem = new Uint8Array(x.memory.buffer), dv = new DataView(x.memory.buffer);
  const blob = Number(x.kit_blob_ptr()), hits = Number(x.kit_hits_ptr()), out: WasmMachine[] = [];
  for (let id = 0; id < x.kit_machine_count(); id++) {
    const rec = blob + id * DIR_REC;
    const nS = mem[rec + 12], nE = mem[rec + 13], tab = blob + dv.getUint32(rec, true);
    let p = blob + dv.getUint32(rec + 4, true);
    const names: string[] = [];
    for (let i = 0; i < 1 + nS + nE; i++) { names.push(String.fromCharCode(...mem.subarray(p + 1, p + 1 + mem[p]))); p += 1 + mem[p]; }
    const h = hits + dv.getUint32(rec + 8, true);
    out.push({ id, name: names[0], states: names.slice(1, 1 + nS), events: names.slice(1 + nS), initial: mem[rec + 14],
      table: mem.slice(tab, tab + nS * nE), dataMax: mem.slice(tab + nS * nE, tab + nS * nE + nS), hits: mem.slice(h, h + nS * nE) });
  }
  return out;
}

// One trace record as text: "kthread#3 Running -Yield-> Runnable" or "kthread#3 Exited x Start (refused: no transition)"
export function formatRecord(r: TraceRecord, machines: WasmMachine[]): string {
  const m = machines[r.machine];
  if (!m) return `machine${r.machine}#${r.instance} ${r.from} -${r.event}-> ${r.to}`;
  const ev = m.events[r.event] ?? `event ${r.event}`;
  return r.refused ? `${m.name}#${r.instance} ${m.states[r.from]} x ${ev} (refused: ${REASONS[r.reason]})`
    : `${m.name}#${r.instance} ${m.states[r.from]} -${ev}-> ${m.states[r.to]}`;
}

// The transitions of the tables that no hit bitmap has seen, as "machine: From -Event-> To"
export function unexercised(machines: WasmMachine[], hits: Uint8Array[]): string[] {
  const out: string[] = [];
  machines.forEach((m, i) => m.table.forEach((to, cell) => {
    if (to !== NONE && !hits[i][cell]) out.push(`${m.name}: ${m.states[Math.floor(cell / m.events.length)]} -${m.events[cell % m.events.length]}-> ${m.states[to]}`);
  }));
  return out;
}
