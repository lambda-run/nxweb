// hle: the SDK functions taken over by name (port of nxnative dm/host/hle_*.c). The embedder's API; see README.md.
import { COUNT, NAMES, DNAMES, NAME_OFF, DNAME_OFF, FLAGS, OP_OFF, SORTED, STUB_RET, F_FORCED, F_IMPL, F_OPS, F_CUT, dispatch } from "./gen/table";
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
import { hidInit, inputSet, inputPeek, holdSet, holdMask, ctrlAnswer, ctrlPromptState, playersSeen, playerNpad, npadStyle, inputSamples, cheatKeys, mouseWanted } from "./hid";
import { padSlotOf, padSlotTake, padSlotTakeLowest, padSlotFree, padSlotMask } from "./padslots";
import { hapticsInit, hapticsRoute, hapticsSetEnabled, hapticsSuspend, hapticsEpoch, hapticsAvailable } from "./haptics";
import { mapParse, motionReset, motionUpdate, motionFill, motionPhoneToSwitch } from "./motion";
import { viInit, viFrameQueued, viLayerSize, viLayerCrop, viNativeWindow } from "./vi";
import { roInit, roRefuse, roLoadedCount } from "./ro";
import { jitInit, jitEnvCount } from "./jit";
import { movieInit } from "./movie";
import { sha256 } from "./sha256";
import { HleExitReason } from "../kit/gen/tables";
export * from "../kit/exports";

const MAX_DEPTH: i32 = 16;
const FRAMES: usize = memory.data(3328);      // MAX_DEPTH * ARGS_SIZE
const SCRATCH_ARGS: usize = memory.data(208, 8);
const SCRATCH: usize = memory.data(8192, 8);
const STUB_SEEN: usize = memory.data(2048);
const CALLS: usize = memory.data(8192);       // u32 per entry (hle_count.c's DM_HLECOUNT)
const INTERNAL_NAMES: usize = memory.data<u8>([
  104, 108, 101, 46, 110, 103, 99, 95, 118, 95, 122, 101, 114, 111, 0, 0,     // hle.ngc_v_zero
  104, 108, 101, 46, 110, 103, 99, 95, 118, 95, 110, 111, 110, 101, 0, 0,     // hle.ngc_v_none
  104, 108, 101, 46, 110, 103, 99, 95, 118, 95, 99, 104, 101, 99, 107, 0,     // hle.ngc_v_check
  104, 108, 101, 46, 110, 103, 99, 95, 118, 95, 109, 97, 115, 107, 0, 0,      // hle.ngc_v_mask
  104, 108, 101, 46, 106, 105, 116, 95, 114, 101, 115, 111, 108, 118, 101, 0, // hle.jit_resolve
  104, 108, 101, 46, 106, 105, 116, 95, 112, 97, 110, 105, 99, 0, 0, 0,       // hle.jit_panic
  104, 108, 101, 46, 106, 105, 116, 95, 97, 98, 111, 114, 116, 0, 0, 0,       // hle.jit_abort
  104, 108, 101, 46, 106, 105, 116, 95, 117, 110, 101, 120, 112, 0, 0, 0,     // hle.jit_unexp
  104, 108, 101, 46, 106, 105, 116, 95, 109, 101, 109, 99, 112, 121, 0, 0,    // hle.jit_memcpy
  104, 108, 101, 46, 106, 105, 116, 95, 109, 101, 109, 109, 111, 118, 101, 0, // hle.jit_memmove
  104, 108, 101, 46, 106, 105, 116, 95, 109, 101, 109, 115, 101, 116, 0, 0]); // hle.jit_memset
let depth: i32 = 0;
let lastFlags: u32 = 0, lastX1: u64 = 0, lastD0: u64 = 0, lastWaitH: u32 = 0, lastWaitT: i64 = -1;
let inited: bool = false;

// Everything back to the state of a fresh process
export function hle_init(): void {
  inited = true; depth = 0;
  zero(STUB_SEEN, 2048); zero(CALLS, 8192);
  baseInit(); seInit(); opsInit(); exitInit(); oeInit(); netInit(); timeInit(); miscInit(); sfInit(); swkbdInit(); webInit(); osInit(); nvdrvInit(); libcInit();
  sdk16Init();
  hidInit(); viInit(); roInit(); jitInit(); movieInit();
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
// from the C text, bit 5 the same name and kind appeared earlier in the table (register the first), bit 6 cut: a stub
// (bit 1 clear) that logs one red line and then answers as nxnative's call on an object with no host decoder
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
    if (fl & F_CUT) {
      if (!load<u8>(STUB_SEEN + <usize>id)) { store<u8>(STUB_SEEN + <usize>id, 1); ls(); ps("[RED] "); pz(hle_demangled(id), 400); ps(" is cut (movies and video codecs are not played): it fails as in nxnative without a decoder"); le(); }
      r = (fl & F_OPS) ? runOps(id, load<u32>(OP_OFF + (<usize>id << 2)), f) : dispatch(id, f);
    }
    else if (fl & F_OPS) r = runOps(id, load<u32>(OP_OFF + (<usize>id << 2)), f);
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
// ---------- controllers, the screen, vibration (hid.ts) ----------
// One player's whole input: a snapshot of SNAP_SIZE (0x1B0) bytes, layout in hid.ts. player 0..7, or -1 to let the
// snapshot's source id take (or, when it says disconnected, free) a player slot. Returns the player, -1 for none
export function hle_input(player: i32, snapshot: usize): i32 { if (!inited) hle_init(); return inputSet(player, snapshot); }
// What an applet in front of the game sees: out = { u64 buttons, i32 axes[4] }, every player ORed, presses since the last peek included
export function hle_input_peek(out: usize): void { inputPeek(out); }
// The game's input is held (on = 1) or given back (0) for a reason: 1 the offline web page (web.ts does it), 2 the
// controller applet's prompt, 3 the software keyboard's box, 4 the embedder's own. The game reads nothing while any holds
export function hle_hold(reason: i32, on: i32): void { holdSet(reason, on != 0); }
export function hle_hold_state(): u32 { return holdMask(); }             // bit r: reason r holds
// The controller prompt's answer (import hle_ctrl_prompt): 1 enough players joined and OK, 0 the player closed it
export function hle_ctrl_answer(result: i32): i32 { return ctrlAnswer(result); }
export function hle_ctrl_state(): u32 { return ctrlPromptState(); }
// The player slots of the input sources by their stable id: op 0 the slot a source holds, 1 take one (a reconnected
// source gets its player back), 2 take the lowest free one (press to join), 3 free it, 4 the mask of held slots
export function hle_pad_slot(op: i32, id: u32): i32 {
  if (!inited) hle_init();
  return op == 0 ? padSlotOf(id) : op == 1 ? padSlotTake(id) : op == 2 ? padSlotTakeLowest(id) : op == 3 ? padSlotFree(id) : <i32>padSlotMask();
}
export function hle_players_reported(): i32 { return playersSeen(); }    // the players the game sees (a split Joy-Con pair is two)
export function hle_player_npad(player: i32): u32 { return playerNpad(player); }
export function hle_npad_style(id: u32): u32 { return npadStyle(id); }
export function hle_input_samples(): u64 { return inputSamples(); }      // how often the game has sampled the controllers
export function hle_cheat_keys(): u64 { return cheatKeys(); }            // the cheat VM's key mask
export function hle_joy_mouse_wanted(): i32 { return mouseWanted(); }
// Vibration: sink = the embedder plays it (import hle_vibration), enabled = rumble is on; a player's controller has a motor
export function hle_haptics_init(sink: i32, enabled: i32): void { if (!inited) hle_init(); hapticsInit(sink != 0, enabled != 0); }
export function hle_haptics_route(player: i32, on: i32): void { hapticsRoute(player, on != 0); }
export function hle_haptics_enable(on: i32): void { hapticsSetEnabled(on != 0); }
export function hle_haptics_suspend(reason: u32, on: i32): void { hapticsSuspend(reason, on != 0); }   // 1 inactive, 2 interrupted
export function hle_haptics_epoch(player: i32): u64 { return hapticsEpoch(player); }
export function hle_haptics_available(): u32 { return hapticsAvailable(); }
// The orientation fusion on its own (motion.ts), for the embedder's own sensors and for the tests
export function hle_motion_map(map: usize, spec: usize): i32 { return mapParse(map, spec) ? 1 : 0; }
export function hle_motion_reset(state: usize): void { motionReset(state); }
export function hle_motion_update(state: usize, map: usize, acc: usize, rot: usize, dt: f32, k: f32): void { motionUpdate(state, map, acc, rot, dt, k); }
export function hle_motion_fill(state: usize, out: usize): void { motionFill(state, out); }
export function hle_motion_phone(orient: i32, inp: usize, out: usize): void { motionPhoneToSwitch(orient, inp, out); }

// ---------- nn::vi (vi.ts), nn::ro (ro.ts), nn::jit (jit.ts) ----------
// At each present the game queues: frame = the frame count with it (for ListFrameHistory)
export function hle_vi_frame_queued(frame: u64): void { viFrameQueued(frame); }
export function hle_vi_layer_size(): u32 { return viLayerSize(); }       // w | h << 16 of the sized CreateLayer, 0 = none
export function hle_vi_layer_crop(): u64 { return viLayerCrop(); }       // x | y << 16 | w << 32 | h << 48, 0 = none
export function hle_vi_native_window(): usize { return viNativeWindow(); }   // what GetNativeWindow hands out
// An NRO that must never be loaded (an online SDK), by the SHA-256 of its image (32 bytes at sha)
export function hle_ro_refuse(sha: usize): void { if (!inited) hle_init(); roRefuse(sha); }
export function hle_ro_loaded(): i32 { return roLoadedCount(); }
export function hle_jit_envs(): i32 { return jitEnvCount(); }
export function hle_sha256(p: usize, n: usize, out: usize): void { sha256(p, n, out); }
// The end of this module's static data, for the embedder's layout check
export function hle_static_end(): usize { return __heap_base; }
