// The loader's exports (ld_*) for its embedder, and the kit's. API: README.md; TypeScript wrapper: host/loader.mts.
import * as L from "./module";
import { errorPtr, errorLen, errorClear } from "./util";
import { sha256 } from "./sha256";
import { lz4Decompress } from "./lz4";
import { zbicDecompress, zbicBegin, zbicStep, zbicProduced, zbicStat, zbicStatsClear, xxh64 } from "./zbic";
export * from "../kit/exports";

export function ld_init(arena: usize, arenaLen: usize, stubBase: usize, stubCap: u32): i32 { return L.init(arena, arenaLen, stubBase, stubCap); }

// host function table and stubs
export function ld_host_add(name: usize, len: u32, kind: u32): i32 { return L.hostAdd(name, len, kind); }
export function ld_host_count(): u32 { return L.hostCountOf(); }
export function ld_host_kind(id: u32): i32 { return L.hostKind(id); }
export function ld_host_name_ptr(id: u32): usize { return L.hostNamePtr(id); }
export function ld_host_name_len(id: u32): u32 { return L.hostNameLen(id); }
export function ld_host_refs(id: u32): u32 { return L.hostRefs(id); }
export function ld_host_first_module(id: u32): i32 { return L.hostFirstModule(id); }
export function ld_host_find(name: usize, len: u32): i32 { return L.hostLookup(name, len); }
export function ld_stub_base(): usize { return L.stubRegionBase(); }
export function ld_stub_cap(): u32 { return L.stubRegionCap(); }
export function ld_stub_addr(id: u32): usize { return L.stubAddr(id); }
export function ld_stub_id(addr: u64): i32 { return L.stubId(addr); }
export function ld_stub_overflow(): u32 { return L.stubOverflowCount(); }
export function ld_check_forced(): u32 { return L.checkForced(); }
export function ld_force_strict(on: i32): void { L.forceStrict(on != 0); }

// modules
export function ld_parse(file: usize, len: u32, opts: u32): i32 { return L.parse(file, len, opts); }
export function ld_set_name(h: i32, name: usize, len: u32): i32 { return L.setName(h, name, len); }
export function ld_map(h: i32, base: usize): i32 { return L.map(h, base); }
export function ld_relocate(h: i32): i32 { return L.relocate(h); }
export function ld_activate(h: i32): i32 { return L.activate(h); }
export function ld_pin(h: i32): i32 { return L.pin(h); }
export function ld_unload(h: i32): i32 { return L.unload(h); }
export function ld_state(h: i32): i32 { return L.state(h); }
export function ld_get(h: i32, what: u32): usize { return L.get(h, what); }
export function ld_module_count(): u32 { return L.moduleCount(); }
export function ld_loaded_count(): u32 { return L.loadedCount(); }
export function ld_loaded_at(i: u32): i32 { return L.loadedAt(i); }

// symbols
export function ld_lookup(name: usize, len: u32): u64 { return L.lookup(name, len); }
export function ld_lookup_in(h: i32, name: usize, len: u32): u64 { return L.lookupIn(h, name, len); }
export function ld_lookup_module(): i32 { return L.lookupModule(); }
export function ld_unresolved(h: i32, out: usize, cap: u32): i32 { return L.unresolved(h, out, cap); }
export function ld_code_entries(h: i32, out: usize, cap: u32): i32 { return L.codeEntries(h, out, cap); }

// diagnostics
export function ld_error_ptr(): usize { return errorPtr(); }
export function ld_error_len(): i32 { return errorLen(); }
export function ld_error_clear(): void { errorClear(); }
export function ld_faults(): u32 { return L.faultCount(); }
export function ld_arena_used(): u32 { return L.arenaUsed(); }
export function ld_heap_base(): usize { return __heap_base; }

// the pieces on their own (tests, tools)
export function ld_sha256(ptr: usize, len: u32, out: usize): void { sha256(ptr, len, out); }
export function ld_lz4(src: usize, srcLen: u32, dst: usize, dstCap: u32): i32 { return lz4Decompress(src, srcLen, dst, dstCap); }
// ZBIC (zbic.ts): the bytes produced, or a negative reason (ZE_*). The output is at most 2 GB.
export function ld_zbic(src: usize, srcLen: u32, dst: usize, dstCap: u32): i32 { return <i32>zbicDecompress(src, srcLen, dst, dstCap < 0x7FFFFFFF ? dstCap : <u32>0x7FFFFFFF); }
// The same in steps of at least `budget` bytes of output: 1 there is more, 0 done (ld_zbic_produced bytes), negative refused
export function ld_zbic_begin(src: usize, srcLen: u32, dst: usize, dstCap: u32): void { zbicBegin(src, srcLen, dst, dstCap); }
export function ld_zbic_step(budget: u32): i32 { return zbicStep(budget); }
export function ld_zbic_produced(): u32 { return <u32>zbicProduced(); }
// What the streams decoded since the last clear used (the ZS_* indices of zbic.ts)
export function ld_zbic_stat(i: u32): u32 { return zbicStat(i); }
export function ld_zbic_stats_clear(): void { zbicStatsClear(); }
export function ld_xxh64(ptr: usize, len: u32): u64 { return xxh64(ptr, len); }
