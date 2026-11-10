// What a module that uses the kit exports to its embedder: `export * from "<...>/kit/exports";` in the module's entry file.
// src/kit/host/reader.mts reads the trace, the tables and the hit bitmap through these.
import { BLOB, HITS, HITS_SIZE, MACHINE_COUNT } from "./gen/tables";
import { traceBase, traceTotal, traceEnable, traceEnabled, traceClear, refusedTotal, coverEnable, TRACE_CAP, TRACE_REC } from "./machine";

export function kit_trace_ptr(): usize { return traceBase(); }
export function kit_trace_cap(): u32 { return TRACE_CAP; }
export function kit_trace_rec(): u32 { return TRACE_REC; }
export function kit_trace_total(): u32 { return traceTotal(); }
export function kit_trace_enable(on: i32): void { traceEnable(on != 0); }
export function kit_trace_enabled(): i32 { return traceEnabled() ? 1 : 0; }
export function kit_trace_clear(): void { traceClear(); }
export function kit_refused_total(): u32 { return refusedTotal(); }
export function kit_cover_enable(on: i32): void { coverEnable(on != 0); }
export function kit_machine_count(): u32 { return MACHINE_COUNT; }
export function kit_blob_ptr(): usize { return BLOB; }
export function kit_hits_ptr(): usize { return HITS; }
export function kit_hits_size(): u32 { return HITS_SIZE; }
