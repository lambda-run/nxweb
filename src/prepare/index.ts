// The prepare module's entry file: what the embedder (host/prepare.ts) calls. See README.md.
// AssemblyScript for everything that is logic on bytes: the prepare machine and its counters, main.npdm, NSO
// identity and registered cuts, the RomFS tables of a directory tree, SHA-256 for the stage hashes, the BNSH scan.
// A standalone module with its own memory (the prepare step runs before a guest process exists).
export * from "../kit/exports";
import { Inst } from "../kit/machine";
import { PREPARE, PrepareS, PrepareE } from "../kit/gen/tables";
import { sha256 } from "../loader/sha256";
import { alloc, arenaReset, arenaUsed, errorPtr, errorLen, errorClear } from "./base";
import * as npdm from "./npdm";
import * as cuts from "./cuts";
import * as rom from "./romfs_build";
import * as bnsh from "./bnsh";

// ---- the machine (defs/prepare.json) and its counters ----
const M: Inst = Inst.at(memory.data(16));
let inited = false;
const NCOUNT: i32 = 16;
const COUNTS: usize = memory.data(128);
// Counter indices (host/wasm.ts COUNT): what a progress display reads beside the state
//   0 stage units done, 1 stage units total (0 = not known), 2 bytes done in the stage, 3 bytes total,
//   4 files seen in the folder, 5 code modules, 6 cuts applied, 7 RomFS files, 8 RomFS directories,
//   9 add-on contents, 10 stages skipped in this run, 11 stages run in this run

function init(): void { if (!inited) { M.init(PREPARE, 0); inited = true; } }
export function prep_reset(): void { M.init(PREPARE, 0); inited = true; memory.fill(COUNTS, 0, 128); arenaReset(); errorClear(); }
export function prep_state(): i32 { init(); return M.state; }
export function prep_reason(): i32 { init(); return M.state == PrepareS.Failed ? <i32>M.data : 0; }
// Start, or start again after Ready, Failed or Cancelled. 1, or 0 when the machine refuses (a run is in progress)
export function prep_start(): i32 {
  init();
  if (!M.step(PrepareE.Start, 0)) return 0;
  store<u64>(COUNTS, 0, 80); store<u64>(COUNTS, 0, 88);
  stageCounters();
  return 1;
}
function stageCounters(): void { store<u64>(COUNTS, 0, 0); store<u64>(COUNTS, 0, 8); store<u64>(COUNTS, 0, 16); store<u64>(COUNTS, 0, 24); }
// The current stage is finished: it did its work (skipped = 0) or its recorded output stands (skipped = 1)
export function prep_stage_end(skipped: i32): i32 {
  init();
  if (!M.step(skipped ? PrepareE.Skip : PrepareE.Done, 0)) return 0;
  const c = COUNTS + (skipped ? 80 : 88);
  store<u64>(c, load<u64>(c) + 1);
  stageCounters();
  return 1;
}
export function prep_fail(reason: i32): i32 { init(); return M.step(PrepareE.Fail, <u64>reason) ? 1 : 0; }
export function prep_cancel(): i32 { init(); return M.step(PrepareE.Cancel, 0) ? 1 : 0; }
export function prep_count(i: i32): f64 { return i >= 0 && i < NCOUNT ? <f64>load<u64>(COUNTS + (<usize>i << 3)) : 0; }
export function prep_count_set(i: i32, v: f64): void { if (i >= 0 && i < NCOUNT) store<u64>(COUNTS + (<usize>i << 3), <u64>v); }
export function prep_count_add(i: i32, v: f64): void { if (i >= 0 && i < NCOUNT) store<u64>(COUNTS + (<usize>i << 3), load<u64>(COUNTS + (<usize>i << 3)) + <u64>v); }

// ---- memory for what goes in and out ----
export function prep_alloc(len: u32): usize { return alloc(len); }
export function prep_arena_reset(): void { arenaReset(); }
export function prep_arena_used(): usize { return arenaUsed(); }
export function prep_error_ptr(): usize { return errorPtr(); }
export function prep_error_len(): i32 { return errorLen(); }
export function prep_error_clear(): void { errorClear(); }
export function prep_sha256(ptr: usize, len: u32, out: usize): void { sha256(ptr, len, out); }

// ---- main.npdm ----
export function npdm_parse(ptr: usize, len: u32): i32 { return npdm.npdmParse(ptr, len); }
export function npdm_program_id(): u64 { return npdm.npdmProgramId(); }
export function npdm_sys_resource(): u32 { return npdm.npdmSysResource(); }
export function npdm_flags(): u32 { return npdm.npdmFlags(); }
export function npdm_stack_size(): u32 { return npdm.npdmStackSize(); }
export function npdm_version(): u32 { return npdm.npdmVersion(); }
export function npdm_main_thread(): u32 { return npdm.npdmMainThread(); }
export function npdm_name_ptr(): usize { return npdm.npdmNamePtr(); }

// ---- code modules ----
export function nso_parse(ptr: usize, len: u32): i32 { return cuts.nsoParse(ptr, len); }
export function nso_peek(ptr: usize, len: u32): i32 { return cuts.nsoPeek(ptr, len); }
export function nso_check(ptr: usize, len: u32): i32 { return cuts.nsoCheck(ptr, len); }
export function nso_build_id_ptr(): usize { return cuts.nsoBuildIdPtr(); }
export function nso_image_size(): u32 { return cuts.nsoImageSize(); }
export function nso_text_size(): u32 { return cuts.nsoTextSize(); }
export function nso_bss(): u32 { return cuts.nsoBss(); }
export function nso_flags(): u32 { return cuts.nsoFlags(); }
export function cut_apply(file: usize, len: u32, list: usize, listLen: u32): i32 { return cuts.cutApply(file, len, list, listLen); }
export function cut_out_ptr(): usize { return cuts.cutOutPtr(); }
export function cut_out_len(): u32 { return cuts.cutOutLen(); }
export function cut_failed_index(): i32 { return cuts.cutFailedIndex(); }
export function cut_applied(): u32 { return cuts.cutApplied(); }

// ---- RomFS tables of a directory tree ----
export function rom_build(list: usize, listLen: u32): i32 { return rom.romBuild(list, listLen); }
export function rom_tables_ptr(): usize { return rom.romTablesPtr(); }
export function rom_tables_len(): u32 { return rom.romTablesLen(); }
export function rom_offsets_ptr(): usize { return rom.romOffsetsPtr(); }
export function rom_dirs(): u32 { return rom.romDirs(); }
export function rom_files(): u32 { return rom.romFiles(); }
export function rom_data_offset(): f64 { return <f64>rom.romDataOffset(); }
export function rom_data_size(): f64 { return <f64>rom.romDataSize(); }

// ---- BNSH ----
export function bnsh_scan(ptr: usize, len: u32, maxRecords: u32): u32 { return bnsh.bnshScan(ptr, len, maxRecords); }
export function bnsh_rec_ptr(): usize { return bnsh.bnshRecPtr(); }
export function bnsh_containers(): u32 { return bnsh.bnshContainers(); }
export function bnsh_dropped(): u32 { return bnsh.bnshDropped(); }
