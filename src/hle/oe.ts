// nn::oe (application operating environment): port of nxnative dm/host/hle_oe.c. On a console the state comes from
// the am / oe services; the host gives it directly. oe::Initialize is in sdkinit.ts.
//
// Machines (src/hle/defs): oe_focus (two instances: the front end's state and what the game sees), oe_msg (one per
// coalescing notification: 15, 30, 31), oe_notify_event (the bind-once event that follows the queue).
// Not ported: DM_OE_SCRIPT (the embedder scripts hle_focus_set / hle_set_opmode itself) and the Mac / iOS process
// hand-over of ExecuteProgram (the embedder gets the request through the exit path).
import { Inst } from "../kit/machine";
import { OE_FOCUS, OeFocusS, OeFocusE, OE_MSG, OeMsgS, OeMsgE, OE_NOTIFY_EVENT, OeNotifyEventS, OeNotifyEventE, HleExitReason } from "../kit/gen/tables";
import { X, W, I, P, wait, noReturn, monoNs, newEventPair, eventSignal, eventClear, cfg, cfgSet, CFG_OPMODE, CFG_PERF_BOOST, CFG_PREV_PROGRAM, CFG_HAS_PROGRAMS,
  strPtr, strLen, STR_LANG, STR_LAUNCH_SPEC, STR_LAUNCH_BYTES, ls, ps, pc, pz, pu, pi, px, le, red, copy, zeq, zstarts } from "./base";
import { seBind, seSignal, seClear } from "./sysevent";
import { exitRequest } from "./lifecycle";
import { parseF64, parseU64 } from "./libc";

const MSG_FOCUS: u32 = 15, MSG_OPMODE: u32 = 30, MSG_PERFMODE: u32 = 31;
const MQ: i32 = 32;
const RING: usize = memory.data(128);        // MQ u32
const INSTS: usize = memory.data(96);        // 6 Inst: focus front, focus seen, msg 15 / 30 / 31, notify event
export const MQ_EV: usize = memory.data(128, 16);   // the SystemEventType GetNotificationMessageEvent returns (g_mq_ev)
const WH: usize = memory.data(8);
let mqh: i32 = 0, mqn: i32 = 0;
let ntfOpmode: u32 = 0, ntfPerfmode: u32 = 0;
let opmode: i32 = -1;
let focusMode: i32 = -1;
let applets: i32 = 0;
let focusInNs: u64 = 0;
let inactivityMode: i32 = 0, nosleep: i32 = 0, cpuOc: u32 = 0, frameLenLast: i32 = -1, launchPopped: bool = false, regionLogged: bool = false, demoRed: bool = false;
let waitR: u32 = 0, waitW: u32 = 0;   // signalled while the queue holds a notification: what a blocked PopNotificationMessage waits on

// @ts-ignore: decorator
@inline function front(): Inst { return Inst.at(INSTS); }
// @ts-ignore: decorator
@inline function seen(): Inst { return Inst.at(INSTS + 16); }
// @ts-ignore: decorator
@inline function msgInst(k: i32): Inst { return Inst.at(INSTS + 32 + (<usize>k << 4)); }
// @ts-ignore: decorator
@inline function notify(): Inst { return Inst.at(INSTS + 80); }
function kindOf(m: u32): i32 { return m == MSG_FOCUS ? 0 : m == MSG_OPMODE ? 1 : m == MSG_PERFMODE ? 2 : -1; }

export function oeInit(): void {
  front().init(OE_FOCUS, 0); seen().init(OE_FOCUS, 1);
  for (let k = 0; k < 3; k++) msgInst(k).init(OE_MSG, k == 0 ? 15 : k == 1 ? 30 : 31);
  notify().init(OE_NOTIFY_EVENT, 0);
  mqh = 0; mqn = 0; ntfOpmode = 0; ntfPerfmode = 0; opmode = -1; focusMode = -1; applets = 0; focusInNs = 0;
  inactivityMode = 0; nosleep = 0; cpuOc = 0; frameLenLast = -1; launchPopped = false; regionLogged = false; demoRed = false;
  waitR = 0; waitW = 0;
  memory.fill(MQ_EV, 0, 128);
}

// ---------- operation mode ----------
export function dmOpmode(): i32 { if (opmode < 0) opmode = <i32>cfg(CFG_OPMODE); return opmode; }

// ---------- the notification queue ----------
function mqSync(): void {
  if (waitW) { if (mqn) eventSignal(waitW); else eventClear(waitW); }
  const n = notify();
  if (n.state == OeNotifyEventS.Unbound) return;
  if (mqn) { n.step(OeNotifyEventE.QueueHolds); seSignal(MQ_EV); }
  else { n.step(OeNotifyEventE.QueueEmpty); seClear(MQ_EV); }
}
function mqPushRaw(m: u32): void {
  // 15 / 30 / 31 mean "query the current state": while one of a kind is queued, its first position is kept
  const k = kindOf(m);
  if (k >= 0) {
    const was = msgInst(k).state;
    msgInst(k).step(OeMsgE.Post);
    if (was == OeMsgS.Queued) return;
  }
  if (mqn == MQ) { red("oe notification queue overflow (is the game not popping?): the notification is dropped"); return; }
  store<u32>(RING + (<usize>((mqh + mqn) % MQ) << 2), m);
  mqn++;
}
export function mqPush(m: u32): void { mqPushRaw(m); mqSync(); }
export function mqCount(): i32 { return mqn; }

// The front end changed the operation mode: 30 / 31 according to the switches the game turned on
export function dmSetOpmode(m: i32): void {
  const old = dmOpmode(); if (old == m) return;
  opmode = m;
  ls(); ps("oe operation mode "); pi(old); ps(" -> "); pi(m); le();
  if (ntfOpmode) mqPush(MSG_OPMODE);
  if (ntfPerfmode) mqPush(MSG_PERFMODE);
}

// ---------- focus ----------
function focusNotifies(): bool { return focusMode != 0 && focusMode != 3; }   // no mode set: notify
// d: +1 an applet opens, -1 one closes, 0 the front end's state changed
function focusSync(d: i32): void {
  applets += d;
  if (applets < 0) { red("dm_applet_leave without dm_applet_enter"); applets = 0; }
  const w = <i32>front().state + 1, s = w == 1 && applets ? 2 : w;
  if (<i32>seen().state + 1 == s) return;
  seen().step(s == 1 ? OeFocusE.ToInFocus : s == 2 ? OeFocusE.ToOutOfFocus : OeFocusE.ToBackground);
  ls(); ps("oe focus state -> "); pi(s); if (d > 0) ps(" (library applet open)"); else if (d < 0) ps(" (library applet closed)"); le();
  if (focusNotifies()) mqPush(MSG_FOCUS);
}
// Library applet stand-ins hold the game out of focus until they return (DM_APPLET in nxnative's hle.h)
export function appletEnter(name: usize): void { ls(); ps("oe library applet: "); pz(name); le(); focusSync(1); }
export function appletEnterS(name: string): void { ls(); ps("oe library applet: "); ps(name); le(); focusSync(1); }
export function appletLeave(): void { focusSync(-1); }
export function dmFocusNow(): i32 { return <i32>front().state + 1; }
export function dmFocusSeen(): i32 { return <i32>seen().state + 1; }
export function dmFocusInSince(): u64 { return focusInNs; }
// The front end: 1 foreground, 2 focus lost, 3 background
export function dmFocusSet(st: i32): void {
  if (st < 1 || st > 3) { ls(); ps("[RED] dm_focus_set: invalid state "); pi(st); le(); return; }
  if (st == 1) focusInNs = monoNs();
  if (<i32>front().state + 1 == st) return;
  front().step(st == 1 ? OeFocusE.ToInFocus : st == 2 ? OeFocusE.ToOutOfFocus : OeFocusE.ToBackground);
  focusSync(0);
}

// ---------- take-overs ----------
export function h_oe_DemoExit(a: usize): u64 {
  if (!demoRed) { demoRed = true; red("oe: ExitApplicationAndGoBackToInStoreDemoMenu called: ignored (no in-store demo menu)"); }
  return 0;
}
export function h_oe_InactivityExt(a: usize): u64 { inactivityMode = (W(a, 0) & 1) ? 2 : 0; return 0; }
export function h_oe_InactivityExtSafe(a: usize): u64 { inactivityMode = <i32>(W(a, 0) & 1); return 0; }
export function h_oe_InactivityMode(a: usize): u64 { return <u64><u32>inactivityMode; }
export function h_oe_InactivityExtQ(a: usize): u64 { return inactivityMode != 0 ? 1 : 0; }
export function h_oe_NoSleepBegin(a: usize): u64 { nosleep++; return 0; }
export function h_oe_NoSleepEnd(a: usize): u64 { if (nosleep > 0) nosleep--; return 0; }
export function h_oe_NoSleepQ(a: usize): u64 { return nosleep > 0 ? 1 : 0; }
export function h_oe_GetOpMode(a: usize): u64 { return <u64><u32>dmOpmode(); }
export function h_oe_GetPerfMode(a: usize): u64 { return cfg(CFG_PERF_BOOST) ? 1 : <u64><u32>dmOpmode(); }
export function h_oe_CpuOc(a: usize): u64 { return cpuOc; }
export function h_oe_SetCpuOc(a: usize): u64 { cpuOc = W(a, 0) & 0xFF; return 0; }
export function h_oe_GfxScale(a: usize): u64 { return dmOpmode() == 1 ? 1 : 0; }
export function h_gs_FrameLength(a: usize): u64 {
  const mode = I(a, 0);
  if (mode != frameLenLast) { ls(); ps("gs: graphics frame length mode "); pi(mode); ps(" (0 auto, 1 30 fps, 2 60 fps, 3 120 fps)"); le(); frameLenLast = mode; }
  return 0;
}
export function h_oe_DefRes(a: usize): u64 {
  const con = dmOpmode() == 1, w = P(a, 0), h = P(a, 1);
  if (w) store<i32>(w, con ? 1920 : 1280);
  if (h) store<i32>(h, con ? 1080 : 720);
  return 0;
}
export function h_oe_GetPerfCfg(a: usize): u64 { return I(a, 0) == 1 ? 0x00010001 : 0x00010000; }
export function h_oe_SetPerfCfg(a: usize): u64 { ls(); ps("oe::SetPerformanceConfiguration mode="); pi(I(a, 0)); ps(" cfg="); px(W(a, 1)); ps(" (ignored)"); le(); return 0; }
export function h_oe_GetFocus(a: usize): u64 { return <u64>seen().state + 1; }
export function h_oe_SetFocusMode(a: usize): u64 {
  focusMode = I(a, 0);
  ls(); ps("oe::SetFocusHandlingMode "); pi(focusMode); ps(focusNotifies() ? " (focus notifications)" : " (suspended out of focus, no focus notifications)"); le();
  return 0;
}
export function tryPop(out: usize): bool {
  const ok = mqn > 0;
  if (ok) {
    const m = load<u32>(RING + (<usize>mqh << 2));
    store<u32>(out, m);
    mqh = (mqh + 1) % MQ; mqn--;
    const k = kindOf(m); if (k >= 0) msgInst(k).step(OeMsgE.Pop);
    ls(); ps("oe notification popped by the game: "); pu(m); le();
  }
  mqSync();   // signalled again while notifications remain, cleared when the queue is empty (also a signal left behind)
  return ok;
}
export function h_oe_TryPopMsg(a: usize): u64 { return tryPop(P(a, 0)) ? 1 : 0; }
// The blocking form: nxnative waits on its queue's condition variable; here the calling thread waits on a host event
// that is signalled while the queue holds a notification, and the call is made again
const POPPED: usize = memory.data(8);
export function h_oe_PopMsg(a: usize): u64 {
  if (!mqn) {
    if (!waitR) { waitR = newEventPair(WH); waitW = load<u32>(WH); }
    eventClear(waitW);
    return wait(waitR, -1);
  }
  store<u32>(POPPED, 0);
  tryPop(POPPED);
  return load<u32>(POPPED);
}
export function h_oe_GetMsgEv(a: usize): u64 {
  if (notify().state == OeNotifyEventS.Unbound) { seBind(MQ_EV, 1); notify().step(OeNotifyEventE.Bind); mqSync(); }   // bound on the game's thread (it runs SDK code)
  return <u64>MQ_EV;
}
// bool arguments: Switch callers do not extend them; only the low 8 bits count
export function h_oe_SetOpModeNtf(a: usize): u64 { ntfOpmode = W(a, 0) & 0xFF; return 0; }
export function h_oe_SetPerfModeNtf(a: usize): u64 { ntfPerfmode = W(a, 0) & 0xFF; return 0; }

// nn::settings::LanguageCode = char[8], returned by value in x0
const CODE: usize = memory.data(16);
function langPtr(): usize { return strLen(STR_LANG) > 0 ? strPtr(STR_LANG) : 0; }
export function langCode(): u64 {
  store<u64>(CODE, 0);
  const p = langPtr();
  if (p) { for (let i: usize = 0; i < 7; i++) { const c = load<u8>(p + i); if (!c) break; store<u8>(CODE + i, c); } }
  else { store<u8>(CODE, 0x65); store<u8>(CODE, 0x6E, 1); store<u8>(CODE, 0x2D, 2); store<u8>(CODE, 0x55, 3); store<u8>(CODE, 0x53, 4); }   // en-US
  return load<u64>(CODE);
}
export function h_oe_GetLang(a: usize): u64 { return langCode(); }
// 0 Japan, 1 the Americas, 2 Europe, 4 Hong Kong / Taiwan / Korea
const EN_US: usize = memory.data<u8>([0x65, 0x6E, 0x2D, 0x55, 0x53, 0]);
export function h_oe_GetRegion(a: usize): u64 {
  let e = langPtr(); if (!e) e = EN_US;
  const r: i32 = zstarts(e, "ja") ? 0 : zstarts(e, "ko") || zstarts(e, "zh") ? 4 : zeq(e, "en-US") || zeq(e, "fr-CA") || zeq(e, "es-419") || zeq(e, "pt-BR") ? 1 : 2;
  if (!regionLogged) { regionLogged = true; ls(); ps("oe::GetRegionCode: "); pi(r); ps(" for language "); pz(e); le(); }
  return <u64>r;
}
const DEVID: usize = memory.data<u8>([0x78, 0x62, 0x6c, 0x00, 0x53, 0x57, 0x4e, 0x41, 0x54, 0x49, 0x56, 0x45, 0x31, 0x30, 0x30, 0x31]);
export function h_oe_GetDevId(a: usize): u64 { copy(P(a, 0), DEVID, 16); return 0; }

// Launch parameter: what the program that started this one handed over (STR_LAUNCH_BYTES), else what the profile's
// launch_param describes (STR_LAUNCH_SPEC: lang8, f32:<value>, u32:<value>, hex:<bytes>). Handed over once.
const LP: usize = memory.data(256);
function hexv(c: u32): i32 { return c >= 48 && c <= 57 ? <i32>c - 48 : c >= 97 && c <= 102 ? <i32>c - 87 : c >= 65 && c <= 70 ? <i32>c - 55 : -1; }
export function h_oe_PopLaunchParam(a: usize): u64 {
  const out = P(a, 0), buf = P(a, 1), n = X(a, 2);
  if (out) store<u64>(out, 0);
  const fileLen = strLen(STR_LAUNCH_BYTES), specLen = strLen(STR_LAUNCH_SPEC);
  if (fileLen < 0 && specLen <= 0) return 0;
  if (launchPopped) return 0;
  launchPopped = true;
  if (fileLen >= 0) {
    const got: u64 = buf ? (n < <u64>fileLen ? n : <u64>fileLen) : 0;
    if (got) copy(buf, strPtr(STR_LAUNCH_BYTES), <usize>got);
    ls(); ps("oe::TryPopLaunchParameter: "); pu(got); ps(" bytes from the program that started this one"); le();
    if (!got) return 0;   // started with no parameter
    if (out) store<u64>(out, got);
    return 1;
  }
  let len: usize = 0, t = strPtr(STR_LAUNCH_SPEC);
  const end = t + <usize>specLen;
  while (t < end && len < 256 - 8) {
    while (t < end && load<u8>(t) == 0x20) t++;
    if (t >= end) break;
    let e = t; while (e < end && load<u8>(e) != 0x20) e++;
    const save = load<u8>(e); store<u8>(e, 0);
    if (zeq(t, "lang8")) { store<u64>(LP + len, langCode()); len += 8; }
    else if (zstarts(t, "f32:")) { store<f32>(LP + len, <f32>parseF64(t + 4, 0)); len += 4; }
    else if (zstarts(t, "u32:")) { store<u32>(LP + len, <u32>parseU64(t + 4, 0, 0)); len += 4; }
    else if (zstarts(t, "hex:")) { for (let h = t + 4; load<u8>(h) && load<u8>(h + 1) && len < 256; h += 2) { const hi = hexv(load<u8>(h)), lo = hexv(load<u8>(h + 1)); store<u8>(LP + len, <u8>(hi < 0 ? 0 : lo < 0 ? hi : hi * 16 + lo)); len++; } }
    else { ls(); ps("[RED] launch_param: field "); pz(t); ps(" not understood"); le(); }
    store<u8>(e, save);
    t = e;
  }
  if (<u64>len > n) len = <usize>n;
  copy(buf, LP, len);
  if (out) store<u64>(out, <u64>len);
  ls(); ps("oe::TryPopLaunchParameter: "); pu(len); ps(" bytes from the profile ("); pz(strPtr(STR_LAUNCH_SPEC)); ps(")"); le();
  return 1;
}
export function h_oe_PrevProgram(a: usize): u64 { return <u64><u32><i32>cfg(CFG_PREV_PROGRAM); }
// End this program and start another of the application: never returns. The embedder gets the index and the
// parameter bytes with the exit request and decides what starts (nxnative: DM_PROGRAMS, DM_EXEC_OUT)
export function h_oe_ExecProgram(a: usize): u64 {
  const index = I(a, 0), param = P(a, 1), n = <usize>X(a, 2);
  ls(); if (!cfg(CFG_HAS_PROGRAMS)) ps("[RED] ");
  ps("oe::ExecuteProgram("); pi(index); ps(", "); pu(n); ps(" bytes of parameters:");
  for (let i: usize = 0; i < n && i < 32; i++) { pc2(load<u8>(param + i)); }
  ps(cfg(CFG_HAS_PROGRAMS) ? "): this program ends" : "): the host has only this program; it ends"); le();
  exitRequest(HleExitReason.executeProgram, <u64><u32>index, param, n);
  return noReturn();
}
function pc2(b: u32): void { const h = "0123456789abcdef"; pc(32); pc(h.charCodeAt(<i32>(b >> 4))); pc(h.charCodeAt(<i32>(b & 15))); }
// For tests and the embedder
export function oeSetOpmodeCfg(): void { opmode = -1; }
