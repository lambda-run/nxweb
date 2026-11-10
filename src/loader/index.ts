// The loader's exports (ld_*) for its embedder, and the kit's. API: README.md; TypeScript wrapper: host/loader.mts.
import * as L from "./module";
import { errorPtr, errorLen, errorClear } from "./util";
import { sha256 } from "./sha256";
import { lz4Decompress } from "./lz4";
export * from "../kit/exports";

export function ld_init(arena: u32, arenaLen: u32, stubBase: u32, stubCap: u32): i32 { return L.init(arena, arenaLen, stubBase, stubCap); }

// host function table and stubs
export function ld_host_add(name: u32, len: u32, kind: u32): i32 { return L.hostAdd(name, len, kind); }
export function ld_host_count(): u32 { return L.hostCountOf(); }
export function ld_host_kind(id: u32): i32 { return L.hostKind(id); }
export function ld_host_name_ptr(id: u32): u32 { return L.hostNamePtr(id); }
export function ld_host_name_len(id: u32): u32 { return L.hostNameLen(id); }
export function ld_host_refs(id: u32): u32 { return L.hostRefs(id); }
export function ld_host_first_module(id: u32): i32 { return L.hostFirstModule(id); }
export function ld_host_find(name: u32, len: u32): i32 { return L.hostLookup(name, len); }
export function ld_stub_base(): u32 { return L.stubRegionBase(); }
export function ld_stub_cap(): u32 { return L.stubRegionCap(); }
export function ld_stub_addr(id: u32): u32 { return L.stubAddr(id); }
export function ld_stub_id(addr: u64): i32 { return L.stubId(addr); }
export function ld_stub_overflow(): u32 { return L.stubOverflowCount(); }
export function ld_check_forced(): u32 { return L.checkForced(); }

// modules
export function ld_parse(file: u32, len: u32, opts: u32): i32 { return L.parse(file, len, opts); }
export function ld_set_name(h: i32, name: u32, len: u32): i32 { return L.setName(h, name, len); }
export function ld_map(h: i32, base: u32): i32 { return L.map(h, base); }
export function ld_relocate(h: i32): i32 { return L.relocate(h); }
export function ld_activate(h: i32): i32 { return L.activate(h); }
export function ld_pin(h: i32): i32 { return L.pin(h); }
export function ld_unload(h: i32): i32 { return L.unload(h); }
export function ld_state(h: i32): i32 { return L.state(h); }
export function ld_get(h: i32, what: u32): u32 { return L.get(h, what); }
export function ld_module_count(): u32 { return L.moduleCount(); }
export function ld_loaded_count(): u32 { return L.loadedCount(); }
export function ld_loaded_at(i: u32): i32 { return L.loadedAt(i); }

// symbols
export function ld_lookup(name: u32, len: u32): u64 { return L.lookup(name, len); }
export function ld_lookup_in(h: i32, name: u32, len: u32): u64 { return L.lookupIn(h, name, len); }
export function ld_lookup_module(): i32 { return L.lookupModule(); }
export function ld_unresolved(h: i32, out: u32, cap: u32): i32 { return L.unresolved(h, out, cap); }
export function ld_code_entries(h: i32, out: u32, cap: u32): i32 { return L.codeEntries(h, out, cap); }

// diagnostics
export function ld_error_ptr(): u32 { return <u32>errorPtr(); }
export function ld_error_len(): i32 { return errorLen(); }
export function ld_error_clear(): void { errorClear(); }
export function ld_faults(): u32 { return L.faultCount(); }
export function ld_arena_used(): u32 { return L.arenaUsed(); }
export function ld_heap_base(): u32 { return <u32>__heap_base; }

// the pieces on their own (tests, tools)
export function ld_sha256(ptr: u32, len: u32, out: u32): void { sha256(ptr, len, out); }
export function ld_lz4(src: u32, srcLen: u32, dst: u32, dstCap: u32): i32 { return lz4Decompress(src, srcLen, dst, dstCap); }
