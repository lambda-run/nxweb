// System service interfaces of newer SDKs: port of nxnative dm/host/hle_sdk16.c (oe, time, pl shared fonts, fontll,
// nfc / nfp, vi vsync event, diag, settings language codes). Constant bodies are compiled from the C text.
import { Inst } from "../kit/machine";
import { HleExitReason } from "../kit/gen/tables";
import { X, W, I, P, LR, noReturn, monoNs, cfg, CFG_SDK_MAJOR, CFG_FONT_DECODE, CFG_SHARED_FONT_TTF, guestSym, guestCall1, guestCall3, guestCall5, hostAlloc, moduleOf,
  strPtr, strLen, STR_DISPLAY_VERSION, ls, ps, pc, pz, pu, pi, px, le, red, zero, zcopy, sput } from "./base";
import { seBind, seSignal, seBinding, seSignalBinding, seHandle } from "./sysevent";
import { breakDown, tSec, tMin, tHour, tMday, tMon, tYear, zoneAt, ZONE } from "./cal";
import { userNow } from "./time";
import { exitRequest } from "./lifecycle";
import { hidConnectedNpad } from "./hid";   // the controller the NFC device is on

// A vsync event was handed out: the embedder calls hle_vsync_tick(binding) at every vertical blank until that returns 0
// @ts-ignore: decorator
@external("env", "hle_vsync_event")
declare function vsyncEvent(binding: u64): void;

let t0: u64 = 0;
// ---------- oe ----------
// DisplayVersion = char[16]: the value of main's build (the embedder resolves it), 1.0.0 when unknown
export function h_oe_DispVer(a: usize): u64 {
  const v = P(a, 0);
  zero(v, 16);
  if (strLen(STR_DISPLAY_VERSION) > 0) zcopy(v, strPtr(STR_DISPLAY_VERSION), 16); else sput(v, "1.0.0");
  return 0;
}
export function h_oe_GetVolBal(a: usize): u64 { store<f32>(P(a, 0), 1.0); store<f32>(P(a, 1), 1.0); return 0; }
// nn::TimeSpan, nanoseconds: the host's monotonic time since the take-overs were set up
export function h_oe_ActiveTime(a: usize): u64 { return monoNs() - t0; }

// ---------- time ----------
// CalendarTime returned by value in x0
export function h_time_ToCalUtc(a: usize): u64 {
  breakDown(load<i64>(P(a, 0)), 0);
  return <u64><u16>(tYear + 1900) | (<u64><u8>(tMon + 1) << 16) | (<u64><u8>tMday << 24) | (<u64><u8>tHour << 32) | (<u64><u8>tMin << 40) | (<u64><u8>tSec << 48);
}
// LocationName = char[0x24]: the host's zone
export function h_time_LocName(a: usize): u64 { const out = P(a, 0); zero(out, 0x24); zoneAt(userNow()); zcopy(out, ZONE, 0x24); return 0; }
// The "ensure network clock availability" task: no request, the finish event fires at once, the result is failure
const EV_NETCLOCK: usize = memory.data(256, 16);
export function h_time_NcStart(a: usize): u64 { seSignal(EV_NETCLOCK); return 0; }
export function h_time_NcEvent(a: usize): u64 { seSignal(EV_NETCLOCK); return <u64>EV_NETCLOCK; }

// ---------- pl: shared fonts ----------
// The host has none of the system's shared fonts and uses stand-ins the embedder provides (export hle_font_set):
// one for the Nintendo extension (type 5: button icons), one for every other type. A font is BFTTF: an 8-byte header
// and the TTF. The host gives the "decoded" marker (0x18029a7f) and the obfuscated length as in the original
// (bswap(length ^ 0x49621806)), then the TTF as it is, so ScalableFontEngineHelper::Decode returns address + 8 untouched.
let stdP: usize = 0, stdN: usize = 0, extP: usize = 0, extN: usize = 0, stdRed: bool = false, extWarn: bool = false, skip: i32 = -1;
// which: 0 standard, 1 Nintendo extension. p: len bytes the guest can address, the TTF from p + 8 (len = 8 + its size)
export function fontSet(which: i32, p: usize, len: usize): void {
  if (p && len > 8) { store<u32>(p, 0x18029a7f); store<u32>(p, bswap<u32>(<u32>(len - 8) ^ 0x49621806), 4); } else { p = 0; len = 0; }
  if (which == 1) { extP = p; extN = len; } else { stdP = p; stdN = len; }
}
let fP: usize = 0, fN: usize = 0;
function fontGet(type: i32): bool {
  if (!stdP && !stdRed) { stdRed = true; red("cannot open the standard shared font (the embedder gave none: hle_font_set)"); }
  if (type == 5 && !extP && !extWarn) { extWarn = true; log_("[YELLOW] Nintendo extended shared font missing: button icons will be drawn as '?'"); }
  if (type == 5 && extP) { fP = extP; fN = extN; } else { fP = stdP; fN = stdN; }
  return fP != 0;
}
function log_(s: string): void { ls(); ps(s); le(); }
// The address points straight at the TTF and the size excludes the header, except for a game on SDK 11 or later
// whose main imports ScalableFontEngineHelper::Decode (the profile's shared_font overrides)
function fontSkip(): usize {
  if (skip < 0) {
    const forced = cfg(CFG_SHARED_FONT_TTF);
    if (forced >= 0) skip = forced ? 8 : 0;
    else { const mj = cfg(CFG_SDK_MAJOR); skip = (mj > 0 && mj <= 10) || !cfg(CFG_FONT_DECODE) ? 8 : 0; }
    ls(); ps("shared font: "); ps(skip ? "the TTF itself" : "BFTTF header + TTF"); le();
  }
  return <usize>skip;
}
export function h_pl_LoadState(a: usize): u64 { return fontGet(I(a, 0)) ? 1 : 0; }
export function h_pl_Addr(a: usize): u64 { return fontGet(I(a, 0)) ? <u64>(fP + fontSkip()) : 0; }
export function h_pl_Size(a: usize): u64 { return fontGet(I(a, 0)) ? <u64>(fN - fontSkip()) : 0; }
// SharedFontData { u32 type, pad, const void *address, size_t size } (0x18 bytes): always the TTF itself, types 0-5 in order
export function h_pl_GetSharedFont(a: usize): u64 {
  const count = P(a, 0), out = P(a, 1), max = I(a, 2);
  let n = 0;
  for (let t = 0; t < 6; t++) {
    if (!fontGet(t)) continue;
    if (n < max) { const e = out + <usize>n * 24; store<u32>(e, <u32>t); store<u32>(e, 0, 4); store<u64>(e, <u64>(fP + 8), 8); store<u64>(e, <u64>(fN - 8), 16); }
    n++;
  }
  store<i32>(count, n);
  return n > 0 ? 1 : 0;
}
// { u8 type, u8 flag, pad[6], const void *address, u64 size }
function builtIn(a: usize): u64 {
  const out = P(a, 0), type = I(a, 1);
  if (!fontGet(type)) return 0;
  store<u64>(out, <u64><u8>type); store<u64>(out, <u64>(fP + fontSkip()), 8); store<u64>(out, <u64>(fN - fontSkip()), 16);
  return 1;
}
export function h_pl_BuiltInNx(a: usize): u64 { return builtIn(a); }
export function h_pl_BuiltInOunce(a: usize): u64 { return builtIn(a); }

// ---------- fontll: the SDK's font engine keeps running; three entries are adjusted on the way in ----------
// LoadFont takes the TTF itself: a game that hands the host's BFTTF base straight to it gets the payload
let fontLoad: u64 = 0, fontLoadLooked: bool = false, fontInit: u64 = 0, fontInitLooked: bool = false, fontGetWork: u64 = 0, fontGetWorkLooked: bool = false;
export function h_font_LoadFont(a: usize): u64 {
  if (!fontLoadLooked) { fontLoadLooked = true; fontLoad = guestSym("_ZN2nn6fontll18ScalableFontEngine8LoadFontEPcPKvjj"); }
  if (!fontLoad) { red("ScalableFontEngine::LoadFont not found in the guest: fails with 403"); return 403; }
  const data = P(a, 2);
  const payload: u64 = data && (data == stdP || data == extP) ? <u64>(data + 8) : X(a, 2);
  return guestCall5(fontLoad, X(a, 0), X(a, 1), payload, W(a, 3), W(a, 4));
}
// A game sizes an engine's work memory for Nintendo's fonts, and the stand-in can be far larger: an engine with less
// than FONT_WORK_MIN gets that much host memory instead; GetPointerToWorkBuffer still gives the game's back
const FONT_WORK_MIN: u32 = 0x80000, FONT_ENGINES: i32 = 16;
const FW: usize = memory.data(384);   // per engine: u64 self, game, host
let fwRed: bool = false;
export function h_font_Initialize(a: usize): u64 {
  if (!fontInitLooked) { fontInitLooked = true; fontInit = guestSym("_ZN2nn6fontll18ScalableFontEngine10InitializeEPvj"); }
  const self = X(a, 0); let buf = X(a, 1), size = W(a, 2);
  if (size < FONT_WORK_MIN) {
    let i = 0;
    while (i < FONT_ENGINES && load<u64>(FW + <usize>i * 24) && load<u64>(FW + <usize>i * 24) != self) i++;
    if (i < FONT_ENGINES) {
      const e = FW + <usize>i * 24;
      if (!load<u64>(e, 16)) store<u64>(e, hostAlloc(FONT_WORK_MIN), 16);
      if (load<u64>(e, 16)) { store<u64>(e, self); store<u64>(e, buf, 8); buf = load<u64>(e, 16); size = FONT_WORK_MIN; }
      else if (!fwRed) { fwRed = true; red("font engine work memory: the embedder gave none, the engine keeps the game's buffer"); }
    } else if (!fwRed) { fwRed = true; red("more than 16 font engines with a small work buffer: this one keeps the game's"); }
  }
  if (!fontInit) { red("ScalableFontEngine::Initialize not found in the guest"); return 0; }
  guestCall3(fontInit, self, buf, size);
  return 0;
}
export function h_font_WorkBuffer(a: usize): u64 {
  if (!fontGetWorkLooked) { fontGetWorkLooked = true; fontGetWork = guestSym("_ZN2nn6fontll18ScalableFontEngine22GetPointerToWorkBufferEv"); }
  const self = X(a, 0);
  let game: u64 = 0;
  for (let i = 0; i < FONT_ENGINES && load<u64>(FW + <usize>i * 24); i++) if (load<u64>(FW + <usize>i * 24) == self) game = load<u64>(FW + <usize>i * 24, 8);
  if (game) return game;
  return fontGetWork ? guestCall1(fontGetWork, self) : 0;
}

// ---------- nfc / nfp: a console whose NFC library works and never finds a tag ----------
let nfcState: i32 = 0, nfpState: i32 = 0, nfpLib: i32 = 0;
export function h_nfc_Init(a: usize): u64 { nfcState = 1; log_("nfc::Initialize: NFC is disabled (the host has no NFC reader)"); return 0; }
export function h_nfc_Fini(a: usize): u64 { nfcState = 0; return 0; }
export function h_nfc_State(a: usize): u64 { return <u64>nfcState; }
export function h_nfp_Init(a: usize): u64 { nfpLib = 1; log_("nfp::Initialize: the host has one NFC device and finds no amiibo tag"); return 0; }
export function h_nfp_InitExt(a: usize): u64 { nfpLib = 1; log_("nfp::InitializeWithExtendedApplicationArea: the host has one NFC device that never finds a tag"); return 0; }
// DeviceHandle = { u32 id, u8 reserved[4] }
export function h_nfp_List(a: usize): u64 {
  const out = P(a, 0), n = P(a, 1), max = I(a, 2);
  store<i32>(n, 0);
  if (max >= 1) { store<u64>(out, 0x4e465030); store<i32>(n, 1); }   // 'NFP0'
  return 0;
}
export function h_nfp_NpadId(a: usize): u64 { store<u32>(P(a, 0), hidConnectedNpad()); return 0; }
export function h_nfp_Start(a: usize): u64 { nfpState = 1; return 0; }
export function h_nfp_Stop(a: usize): u64 { nfpState = 0; return 0; }
export function h_nfp_State(a: usize): u64 { return <u64>nfpState; }
export function h_nfp_LibState(a: usize): u64 { return <u64>nfpLib; }
export function h_nfp_Fini(a: usize): u64 { nfpLib = 0; return 0; }

// ---------- vi ----------
// Image memory of an indirect layer: linear RGBA8, 4 KB aligned
export function h_vi_IndirectReq(a: usize): u64 {
  const w = I(a, 2), h = I(a, 3);
  store<u64>(P(a, 0), (<u64>(w > 0 ? w : 0) * <u64>(h > 0 ? h : 0) * 4 + 0xfff) & ~<u64>0xfff);
  store<u64>(P(a, 1), 0x1000);
  return 0;
}
// The vsync event: auto-clear, signalled by the embedder at every vertical blank (nxnative: a host thread at 60 Hz or
// on the display link). One producer per binding lifetime
const VS: usize = memory.data(64);   // up to 8 binding ids
export function h_vi_VsyncEvent(a: usize): u64 {
  const ev = P(a, 0);
  seBind(ev, 1);
  const binding = seBinding(ev);
  let running = false, free = -1;
  for (let i = 0; i < 8; i++) { const b = load<u64>(VS + (<usize>i << 3)); if (b && b == binding) running = true; if (!b && free < 0) free = i; }
  if (!running && binding) {
    if (free >= 0) store<u64>(VS + (<usize>free << 3), binding);
    vsyncEvent(binding);
  }
  ls(); ps("vi::GetDisplayVsyncEvent: "); px(ev); ps(" signalled by the host at every vertical blank"); if (running) ps(" (already running)"); le();
  return 0;
}
// 1: signalled; 0: the game destroyed the event, stop ticking this binding
export function vsyncTick(binding: u64): i32 {
  if (seSignalBinding(binding)) return 1;
  for (let i = 0; i < 8; i++) if (load<u64>(VS + (<usize>i << 3)) == binding) store<u64>(VS + (<usize>i << 3), 0);
  log_("vi: vsync event destroyed by the game, its ticks end");
  return 0;
}

// ---------- diag ----------
export function h_diag_Put(a: usize): u64 {
  const s = P(a, 1); let n = <usize>X(a, 2);
  while (n && (load<u8>(s + n - 1) == 10 || load<u8>(s + n - 1) == 0)) n--;
  if (n) { ls(); ps("[game] "); for (let i: usize = 0; i < n; i++) pc(load<u8>(s + i)); le(); }
  return 0;
}
// Abort: report the call site, then the process ends (exit reason abort). It never returns to its caller
function diagAbort(res: u32, lr: u64): u64 {
  ls(); ps("[RED] game called nn::diag abort: Result "); px(res); ps(", call site "); px(lr); ps(" (module "); pi(moduleOf(lr)); ps("): game aborted"); le();
  exitRequest(HleExitReason.abort, res, 0, 0);
  return noReturn();
}
export function h_diag_Abort0(a: usize): u64 { return diagAbort(0, LR(a)); }
export function h_diag_AbortR(a: usize): u64 { const r = P(a, 0); return diagAbort(r ? load<u32>(r) : 0, LR(a)); }
// The message's format names the failure on its own; its arguments are not expanded (a __va_list of the guest)
export function h_diag_VAbort(a: usize): u64 {
  const res = P(a, 4);
  ls(); ps("[diag] abort at "); pz0(P(a, 0)); ps(": "); pz0(P(a, 1)); ps(" ("); pz0(P(a, 2)); ps(":"); pi(I(a, 3)); ps(") message format "); pz0(P(a, 6)); le();
  return diagAbort(res ? load<u32>(res) : 0, LR(a));
}
function pz0(p: usize): void { if (p) pz(p, 300); else ps("?"); }
export function h_diag_SymName(a: usize): u64 { const buf = P(a, 0); if (buf && X(a, 1)) store<u8>(buf, 0); return 0; }

// ---------- settings: language enum <-> language code (LanguageCode = char[8]); the table is public and fixed ----------
const NLANG: i32 = 18;
const LANGS: usize = memory.data(144);
let langsMade: bool = false;
const t: string[] = ["ja", "en-US", "fr", "de", "it", "es", "zh-CN", "ko", "nl", "pt", "ru", "zh-TW", "en-GB", "fr-CA", "es-419", "zh-Hans", "zh-Hant", "pt-BR"];
function langs(): usize {
  if (!langsMade) {
    langsMade = true; zero(LANGS, 144);
    for (let k = 0; k < NLANG; k++) for (let i = 0; i < t[k].length; i++) store<u8>(LANGS + (<usize>k << 3) + <usize>i, <u8>t[k].charCodeAt(i));
  }
  return LANGS;
}
// strncmp(table[k], code, 8) == 0
function codeIs(k: i32, code: usize): bool {
  const t = langs() + (<usize>k << 3);
  for (let i: usize = 0; i < 8; i++) { const x = load<u8>(t + i), y = load<u8>(code + i); if (x != y) return false; if (!x) return true; }
  return true;
}
// Older games compare Chinese only with Language::Chinese (6) and Taiwanese (11) while newer ones use
// SimplifiedChinese (15) / TraditionalChinese (16): both spellings of one script match, in both directions
function langMatches(lang: i32, code: usize): u64 {
  if (<u32>lang >= <u32>NLANG) return 0;
  if (codeIs(lang, code)) return 1;
  switch (lang) {
    case 6: return codeIs(15, code) ? 1 : 0;
    case 15: return codeIs(6, code) ? 1 : 0;
    case 11: return codeIs(16, code) ? 1 : 0;
    case 16: return codeIs(11, code) ? 1 : 0;
    default: return 0;
  }
}
export function h_set_LangEq(a: usize): u64 { return langMatches(load<i32>(P(a, 0)), P(a, 1)); }
export function h_set_LangEq2(a: usize): u64 { return langMatches(load<i32>(P(a, 1)), P(a, 0)); }
export function h_set_LangMake(a: usize): u64 { const lang = I(a, 0); return <u32>lang < <u32>NLANG ? load<u64>(langs() + (<usize>lang << 3)) : 0; }
export function h_set_AvailLang(a: usize): u64 {
  const out = P(a, 0), count = I(a, 1);
  let n = 0;
  for (; n < count && n < NLANG; n++) store<u64>(out + (<usize>n << 3), load<u64>(langs() + (<usize>n << 3)));
  return <u64>n;
}
export function h_set_AvailLangN(a: usize): u64 { return <u64>NLANG; }

export function sdk16Init(): void {
  t0 = monoNs(); stdP = 0; stdN = 0; extP = 0; extN = 0; stdRed = false; extWarn = false; skip = -1;
  fontLoad = 0; fontLoadLooked = false; fontInit = 0; fontInitLooked = false; fontGetWork = 0; fontGetWorkLooked = false; fwRed = false;
  zero(FW, 384); zero(VS, 64); nfcState = 0; nfpState = 0; nfpLib = 0;
}
