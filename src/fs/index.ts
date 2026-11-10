// The fs module's entry file: what the embedder calls. See README.md.
export * from "../kit/exports";
import { arenaInit, arenaUsed, arenaSize } from "./base";
import { FN_COUNT, NAMES } from "./names";
import * as fs from "./fs";

// Give the module its arena: [base, base + size) of linear memory, for image tables, save trees and directory
// snapshots. Call once, before anything else.
export function fs_init(arenaBase: usize, arenaLen: usize): void { arenaInit(arenaBase, arenaLen); fs.init(); }
// The end of the module's static data (the embedder checks it against the range it gave the module)
export function fs_static_end(): usize { return __heap_base; }

// The id of a mangled nn::fs name (a NUL-terminated string in linear memory), or 0 when the module does not take it over
export function fs_lookup(namePtr: usize): u32 { return fs.lookup(<u64>namePtr); }
// One guest call. argsPtr: x0..x7 as the guest passed them (8 little-endian u64).
// The result is what the guest gets in x0 (a Result, a bool, an open mode; 0 for a void function), or
//   0xFFFFFFFF_<token>   pending: a storage call did not finish; park the guest thread, fs_complete(token, status)
//                        will be called by the storage glue and returns the call's result (or pending again)
//   0xFFFFFFFE_00000000  retry: the save or image is busy with a pending call of another thread; park the guest
//                        thread and make the same fs_call again after any pending call has completed
export function fs_call(fnId: u32, argsPtr: usize): i64 { return fs.call(fnId, argsPtr); }
// The storage call a pending fs_call waits for has finished with `status` (dev_open: the device id or an error;
// others: 0 or an error). Returns as fs_call does.
export function fs_complete(token: i32, status: i32): i64 { return fs.complete(token, status); }

// ---- configuration ----
// The running program's id (IsSaveDataExisting(ApplicationId))
export function fs_set_program_id(id: u64): void { fs.setProgramId(id); }
// Whether the game imports MountSaveData (then device save data is a save of its own): 1, 0, or -1 = decide by
// whether fs_lookup was asked for that name (the default)
export function fs_set_account_save(v: i32): void { fs.setAccountSave(v); }

// ---- for the embedder's report and the tests ----
export function fs_fn_count(): u32 { return FN_COUNT; }
// The name of function id (1..fs_fn_count) as UTF-16 code units at the returned pointer; its length in fs_fn_name_len
export function fs_fn_name(id: u32): usize { return id >= 1 && id <= FN_COUNT ? changetype<usize>(unchecked(NAMES[id - 1])) : 0; }
export function fs_fn_name_len(id: u32): i32 { return id >= 1 && id <= FN_COUNT ? unchecked(NAMES[id - 1]).length : 0; }
export function fs_fn_is_stub(id: u32): i32 { return fs.isStub(id) ? 1 : 0; }
export function fs_save_state(kind: i32, index: i64): i32 { return fs.saveState(kind, index); }
export function fs_save_generation(kind: i32, index: i64): i64 { return fs.saveGen(kind, index); }
export function fs_image_state(kind: i32, index: i64): i32 { return fs.imageState(kind, index); }
export function fs_commit_count(): u64 { return fs.commitCount(); }
export function fs_mount_count(): u32 { return fs.mountCount(); }
export function fs_open_files(): u32 { return fs.openFiles(); }
export function fs_open_dirs(): u32 { return fs.openDirs(); }
export function fs_pending(): u32 { return fs.pendWaiting(); }
export function fs_arena_used(): usize { return arenaUsed(); }
export function fs_arena_size(): usize { return arenaSize(); }
