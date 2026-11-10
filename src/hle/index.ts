// hle: the SDK functions taken over by name (port of nxnative dm/host/hle_*.c). The embedder's API; see README.md.
import { COUNT, NAMES, DNAMES, NAME_OFF, DNAME_OFF, FLAGS, OP_OFF, SORTED, STUB_RET, F_FORCED, F_IMPL, F_OPS, dispatch } from "./gen/table";
import { ARGS_SIZE, retFlags, retX1, retD0, waitHandle, waitTimeout, retClear, retRestore, setResume, baseInit, cfgSet, strSet, ls, ps, pz, le, red, copy, zero } from "./base";
import { runOps, opsInit } from "./ops";
import { seInit, seBind, seSignal, seClear, seHandleClosed, seHandle, seCount } from "./sysevent";
import { oeInit, dmFocusSet, dmSetOpmode, dmOpmode, dmFocusSeen, dmFocusNow, appletEnter, appletLeave, mqPush, mqCount, oeSetOpmodeCfg } from "./oe";
import { exitInit, exitRequest, exitDone, exitState, exitReason } from "./lifecycle";
import { netInit, getErrno } from "./net";
import { timeInit } from "./time";
import { miscInit, aocSet, internalCall, INTERNAL_COUNT } from "./misc";
import { sfInit } from "./sf";
import { swkbdInit, textAnswer, textRequestState } from "./swkbd";
import { webInit, webMessage, webEnded, webFailed, webState } from "./web";
import { sdk16Init, fontSet, vsyncTick } from "./sdk16";
import { osInit, entropy64 } from "./os";
import { nvdrvInit } from "./nvdrv";
import { libcInit } from "./libc";
import { miiStandin } from "./mii";
import { HleExitReason } from "../kit/gen/tables";
export * from "../kit/exports";

const MAX_DEPTH: i32 = 16;
const FRAMES: usize = memory.data(3328);      // MAX_DEPTH * ARGS_SIZE
const SCRATCH_ARGS: usize = memory.data(208, 8);
const SCRATCH: usize = memory.data(8192, 8);
const STUB_SEEN: usize = memory.data(1024);
const CALLS: usize = memory.data(4096 + 64);  // u32 per entry (hle_count.c's DM_HLECOUNT)
const INTERNAL_NAMES: usize = memory.data<u8>([
  104, 108, 101, 46, 110, 103, 99, 95, 118, 95, 122, 101, 114, 111, 0, 0,     // hle.ngc_v_zero
  104, 108, 101, 46, 110, 103, 99, 95, 118, 95, 110, 111, 110, 101, 0, 0,     // hle.ngc_v_none
  104, 108, 101, 46, 110, 103, 99, 95, 118, 95, 99, 104, 101, 99, 107, 0,     // hle.ngc_v_check
  104, 108, 101, 46, 110, 103, 99, 95, 118, 95, 109, 97, 115, 107, 0, 0]);    // hle.ngc_v_mask
let depth: i32 = 0;
let lastFlags: u32 = 0, lastX1: u64 = 0, lastD0: u64 = 0, lastWaitH: u32 = 0, lastWaitT: i64 = -1;
let inited: bool = false;

// Everything back to the state of a fresh process
export function hle_init(): void {
  inited = true; depth = 0;
  zero(STUB_SEEN, 1024); zero(CALLS, 4096 + 64);
  baseInit(); seInit(); opsInit(); exitInit(); oeInit(); netInit(); timeInit(); miscInit(); sfInit(); swkbdInit(); webInit(); osInit(); nvdrvInit(); libcInit();
  sdk16Init();
}
// ---------- the table ----------
export function hle_count(): i32 { return COUNT; }
// Host-only functions guest code reaches through a stub (ids hle_count() .. hle_count() + hle_internal_count() - 1)
export function hle_internal_count(): i32 { return INTERNAL_COUNT; }
// The symbol name as it appears in a module's dynamic symbol table (a C string)
export function hle_name(id: i32): usize {
  if (id >= COUNT && id < COUNT + INTERNAL_COUNT) return INTERNAL_NAMES + (<usize>(id - COUNT) << 4);
  return id >= 0 && id < COUNT ? NAMES + <usize>load<u32>(NAME_OFF + (<usize>id << 2)) : 0;
}
export function hle_demangled(id: i32): usize { return id >= 0 && id < COUNT ? DNAMES + <usize>load<u32>(DNAME_OFF + (<usize>id << 2)) : hle_name(id); }
// bit 0 forced (wins over every module's own definition; otherwise it fills an import no module defines), bit 1
// implemented (otherwise a red stub), bit 3 a weak entry whose name also has a forced entry, bit 4 its body was compiled
// from the C text, bit 5 the same name and kind appeared earlier in the table (register the first)
export function hle_flags(id: i32): u32 { return id >= 0 && id < COUNT ? load<u8>(FLAGS + <usize>id) : id < COUNT + INTERNAL_COUNT ? F_FORCED | F_IMPL : 0; }
function cmpName(p: usize, id: i32): i32 {
  const q = NAMES + <usize>load<u32>(NAME_OFF + (<usize>id << 2));
  let i: usize = 0;
  for (;; i++) { const x = <i32>load<u8>(p + i), y = <i32>load<u8>(q + i); if (x != y) return x - y; if (!x) break; }
  return 0;
}
// The id of a name (the forced entry when it has both kinds), -1 when the table has none
export function hle_lookup(name: usize): i32 {
  let lo = 0, hi = COUNT - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, c = cmpName(name, <i32>load<u16>(SORTED + (<usize>mid << 1)));
    if (c == 0) { hit = mid; hi = mid - 1; } else if (c < 0) hi = mid - 1; else lo = mid + 1;
  }
  return hit < 0 ? -1 : <i32>load<u16>(SORTED + (<usize>hit << 1));
}

// ---------- calls ----------
// A block the embedder may build the arguments in (base.ts has the layout); any other address works too
export function hle_args(): usize { return SCRATCH_ARGS; }
function enter(id: i32, args: usize): u64 {
  if (!inited) hle_init();
  if (depth >= MAX_DEPTH) { red("hle: take-overs nested more than 16 deep: the call returns 0"); return 0; }
  const f = FRAMES + <usize>depth * ARGS_SIZE;
  copy(f, args, ARGS_SIZE);
  const sf = retFlags, sx = retX1, sd = retD0, sh = waitHandle, st = waitTimeout;
  depth++; retClear();
  let r: u64 = 0;
  if (id >= COUNT && id < COUNT + INTERNAL_COUNT) r = internalCall(id - COUNT, f);
  else if (id < 0 || id >= COUNT) { red("hle: call of an id outside the table"); }
  else {
    store<u32>(CALLS + (<usize>id << 2), load<u32>(CALLS + (<usize>id << 2)) + 1);
    const fl = load<u8>(FLAGS + <usize>id);
    if (fl & F_OPS) r = runOps(id, load<u32>(OP_OFF + (<usize>id << 2)), f);
    else if (fl & F_IMPL) r = dispatch(id, f);
    else {
      if (!load<u8>(STUB_SEEN + <usize>id)) { store<u8>(STUB_SEEN + <usize>id, 1); ls(); ps("[RED] "); pz(hle_demangled(id), 400); ps(" unimplemented"); le(); }
      r = load<u64>(STUB_RET + (<usize>id << 3));
    }
  }
  depth--;
  copy(args + 144, f + 144, 64);   // the continuation slots, for the embedder to keep across a wait
  lastFlags = retFlags; lastX1 = retX1; lastD0 = retD0; lastWaitH = waitHandle; lastWaitT = waitTimeout;
  retRestore(sf, sx, sd, sh, st);
  return r;
}
// Call take-over id with the argument block at args; the result is x0
export function hle_call(id: i32, args: usize): u64 { setResume(0); zero(args + 144, 64); return enter(id, args); }
// The wait a call asked for has ended (how: 1 signaled, 2 timed out, 3 cancelled): make the same call again, with
// the block as it was after the first call (the continuation slots kept)
export function hle_resume(id: i32, args: usize, how: i32): u64 { setResume(how); return enter(id, args); }
// What the last call returned beside x0: bit 0 x1 is part of the result (hle_ret_x1), bit 1 d0 is (hle_ret_d0: the
// register's low 64 bits; a float is the low 32), bit 2 "wait on hle_wait_handle() for at most hle_wait_timeout() ns
// (-1: no limit), then hle_resume", bit 3 the call does not return to the guest (the process is ending)
export function hle_ret_flags(): u32 { return lastFlags; }
export function hle_ret_x1(): u64 { return lastX1; }
export function hle_ret_d0(): u64 { return lastD0; }
export function hle_wait_handle(): u32 { return lastWaitH; }
export function hle_wait_timeout(): i64 { return lastWaitT; }
// How many times take-over id was called (nxnative's DM_HLECOUNT)
export function hle_call_count(id: i32): u32 { return id >= 0 && id < COUNT ? load<u32>(CALLS + (<usize>id << 2)) : 0; }

// ---------- configuration (before the guest runs) ----------
export function hle_scratch(): usize { return SCRATCH; }           // 8 KB for strings the embedder passes in
export function hle_cfg(key: i32, value: i64): void { if (!inited) hle_init(); cfgSet(key, value); if (key == 0) oeSetOpmodeCfg(); }
export function hle_cfg_str(key: i32, ptr: usize, len: i32): void { if (!inited) hle_init(); strSet(key, ptr, len); }
export function hle_aoc_set(ptr: usize, n: i32): void { aocSet(ptr, n); }
export function hle_font_set(which: i32, ptr: usize, len: usize): void { fontSet(which, ptr, len); }

// ---------- what the front end reports ----------
export function hle_focus_set(state: i32): void { dmFocusSet(state); }          // 1 foreground, 2 focus lost, 3 background
export function hle_set_opmode(mode: i32): void { dmSetOpmode(mode); }          // 0 handheld, 1 console
export function hle_opmode(): i32 { return dmOpmode(); }
export function hle_focus_seen(): i32 { return dmFocusSeen(); }
export function hle_focus_front(): i32 { return dmFocusNow(); }
export function hle_notify(msg: u32): void { mqPush(msg); }                     // an oe notification from another producer
export function hle_notify_count(): i32 { return mqCount(); }
// A library applet stand-in of another area (controller applet, ...) holds the game out of focus until it returns
export function hle_applet_enter(name: usize): void { appletEnter(name); }
export function hle_applet_leave(): void { appletLeave(); }
// The exit path: a shutdown the host started (SIGTERM, the page closing); the embedder's "done"
export function hle_shutdown(): i32 { return exitRequest(HleExitReason.hostShutdown, 0, 0, 0) ? 1 : 0; }
export function hle_exit_done(): void { exitDone(); }
export function hle_exit_state(): u32 { return exitState(); }
export function hle_exit_reason(): u32 { return exitReason(); }
export function hle_text_answer(result: i32, ptr: usize, len: usize): i32 { return textAnswer(result, ptr, len); }
export function hle_text_state(): u32 { return textRequestState(); }
export function hle_web_message(ptr: usize, len: usize): void { webMessage(ptr, len); }
export function hle_web_ended(reason: u32, url: usize): void { webEnded(reason, url); }
export function hle_web_failed(why: usize): void { webFailed(why); }
export function hle_web_state(): u32 { return webState(); }
export function hle_vsync_tick(binding: u64): i32 { return vsyncTick(binding); }

// ---------- for the other service areas (controllers, audio, file system) ----------
// The service layer's SystemEvents by the address of the guest's SystemEventType (nxnative hle_bind_system_event ...)
export function hle_event_bind(ev: usize, autoclear: i32): void { seBind(ev, autoclear); }
export function hle_event_signal(ev: usize): void { seSignal(ev); }
export function hle_event_clear(ev: usize): void { seClear(ev); }
export function hle_event_handle(ev: usize): u32 { return seHandle(ev); }
export function hle_event_count(): i32 { return seCount(); }
// The guest closed a kernel handle (svc CloseHandle): a binding on it ends
export function hle_handle_closed(h: u32): void { seHandleClosed(h); }
export function hle_entropy64(): u64 { return entropy64(); }
export function hle_errno(): i32 { return getErrno(); }
// The MiiModel system data stand-in (kind 0 a texture file, 1 a shape file) for the file system's MountSystemData
export function hle_mii_standin(kind: i32, out: usize, cap: usize): usize { return miiStandin(kind, out, cap); }
// The end of this module's static data, for the embedder's layout check
export function hle_static_end(): usize { return __heap_base; }
