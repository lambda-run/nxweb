// nn::swkbd software keyboard: port of nxnative dm/host/hle_swkbd.c. MakePreset / SetInitialTextUtf8 and the size
// getters keep running in the SDK; here the ShowKeyboardArg they wrote is read and the String written back the way
// the applet does. ShowKeyboardArg: +0x24 title u16[65], +0xa6 subtitle u16[129], +0x1a8 hint u16[257], +0x3ac
// maximum length, +0x3b0 minimum length, +0x3bd isUseUtf8, +0x3c0 offset of the initial text in the work buffer,
// +0x3c4 its UTF-16 length, +0x4d0 work buffer pointer. String = { +0 pointer, +8 capacity }.
//
// nxnative blocks the calling thread in the front end's input box. Here the text is a request to the embedder
// (machine swkbd_request): import hle_text_request, answered by the export hle_text_answer inside the import or any
// time later; until then the calling guest thread waits on a host event and the take-over is entered again.
// The inline keyboard (machine swkbd_inline, one per keyboard, four at most) asks the same way from Calc.
import { Inst } from "../kit/machine";
import { SWKBD_REQUEST, SwkbdRequestS, SwkbdRequestE, SwkbdRequestResult, SWKBD_INLINE, SwkbdInlineS, SwkbdInlineE } from "../kit/gen/tables";
import { X, I, P, C, setC, wait, newEventPair, eventSignal, eventClear, clockFreeze, guestCall0, guestCall1, strPtr, strLen, STR_KBD, ls, ps, pz, pi, px, le, red, zero, copy } from "./base";
import { appletEnterS, appletLeave } from "./oe";

// The request: { u64 title, sub, guide, initial (UTF-8 C strings); i32 maximum characters (0: no limit), i32 minimum
// characters (-1: none), i32 kind (0 ShowKeyboard, 1 inline keyboard) }
// @ts-ignore: decorator
@external("env", "hle_text_request")
declare function envTextRequest(req: usize): void;

const ARG_HEADER: usize = 0x24, ARG_SUB: usize = 0xa6, ARG_GUIDE: usize = 0x1a8, ARG_MAXLEN: usize = 0x3ac, ARG_MINLEN: usize = 0x3b0, ARG_UTF8: usize = 0x3bd,
  ARG_INIT_OFF: usize = 0x3c0, ARG_INIT_LEN: usize = 0x3c4, ARG_WORKBUF: usize = 0x4d0;
const HEADER_N: usize = 65, SUB_N: usize = 129, GUIDE_N: usize = 257;
const SWKBD_RESULT_CANCELED: u64 = 0x29F;

// UTF-16 (at most n units, stops at 0) -> UTF-8 at out (cap includes the terminating 0); the bytes written
export function u16ToU8(s: usize, n: usize, out: usize, cap: usize): usize {
  let o: usize = 0;
  for (let i: usize = 0; i < n && load<u16>(s + (i << 1)); i++) {
    let c: u32 = load<u16>(s + (i << 1));
    if (c >= 0xD800 && c < 0xDC00 && i + 1 < n) { const d: u32 = load<u16>(s + ((i + 1) << 1)); if (d >= 0xDC00 && d < 0xE000) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; } }
    const k: usize = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (o + k + 1 > cap) break;
    if (k == 1) store<u8>(out + o, <u8>c);
    else if (k == 2) { store<u8>(out + o, <u8>(0xC0 | (c >> 6))); store<u8>(out + o, <u8>(0x80 | (c & 63)), 1); }
    else if (k == 3) { store<u8>(out + o, <u8>(0xE0 | (c >> 12))); store<u8>(out + o, <u8>(0x80 | ((c >> 6) & 63)), 1); store<u8>(out + o, <u8>(0x80 | (c & 63)), 2); }
    else { store<u8>(out + o, <u8>(0xF0 | (c >> 18))); store<u8>(out + o, <u8>(0x80 | ((c >> 12) & 63)), 1); store<u8>(out + o, <u8>(0x80 | ((c >> 6) & 63)), 2); store<u8>(out + o, <u8>(0x80 | (c & 63)), 3); }
    o += k;
  }
  if (cap) store<u8>(out + o, 0);
  return o;
}
// UTF-8 -> UTF-16, at most maxUnits units (surrogate pairs are not split), at out (cap units including the terminating 0); the unit count
export function u8ToU16(s: usize, maxUnits: usize, out: usize, cap: usize): usize {
  let o: usize = 0, p = s;
  while (load<u8>(p)) {
    const b: u32 = load<u8>(p);
    let k: usize = b < 0x80 ? 1 : b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4;
    let c: u32 = k == 1 ? b : k == 2 ? b & 31 : k == 3 ? b & 15 : b & 7;
    for (let j: usize = 1; j < k; j++) { const x: u32 = load<u8>(p + j); if ((x & 0xC0) != 0x80) { k = j; break; } c = (c << 6) | (x & 63); }
    const need: usize = c >= 0x10000 ? 2 : 1;
    if (o + need > maxUnits || o + need + 1 > cap) break;
    if (need == 2) { c -= 0x10000; store<u16>(out + (o << 1), <u16>(0xD800 | (c >> 10))); store<u16>(out + ((o + 1) << 1), <u16>(0xDC00 | (c & 0x3FF))); o += 2; }
    else { store<u16>(out + (o << 1), <u16>c); o++; }
    p += k;
  }
  if (cap) store<u16>(out + (o << 1), 0);
  return o;
}

// ---------- the request to the embedder ----------
const REQ_INST: usize = memory.data(16);
const REQ: usize = memory.data(48);
const TITLE: usize = memory.data(196), SUB: usize = memory.data(388), GUIDE: usize = memory.data(772), INIT: usize = memory.data(1504);
const TEXT_CAP: usize = 3007;
const TEXT: usize = memory.data(3008);
const U16: usize = memory.data(2008);
const WH: usize = memory.data(8);
let kbdR: u32 = 0, kbdW: u32 = 0;
// @ts-ignore: decorator
@inline function req(): Inst { return Inst.at(REQ_INST); }
function kbdEvent(): u32 { if (!kbdR) { kbdR = newEventPair(WH); kbdW = load<u32>(WH); } return kbdR; }
// The embedder's answer: result 1 OK (len bytes of UTF-8 at ptr), 0 cancel, -1 no window. Returns 1 when a request was waiting
export function textAnswer(result: i32, ptr: usize, len: usize): i32 {
  if (req().state != SwkbdRequestS.Asking) { red("swkbd: a text answer with no request waiting: ignored"); return 0; }
  if (len > TEXT_CAP - 1) len = TEXT_CAP - 1;
  if (result > 0 && ptr) copy(TEXT, ptr, len); else len = 0;
  store<u8>(TEXT + len, 0);
  req().step(SwkbdRequestE.Answer, result > 0 ? SwkbdRequestResult.ok : result == 0 ? SwkbdRequestResult.cancel : SwkbdRequestResult.noWindow);
  if (kbdW) eventSignal(kbdW);
  return 1;
}
export function textRequestState(): u8 { return req().state; }
// Ask. true: the answer is there already (DM_KBD, or the embedder answered inside the import)
function ask(kind: i32, maxChars: i32, minChars: i32): bool {
  req().step(SwkbdRequestE.Ask);
  if (strLen(STR_KBD) >= 0) {   // DM_KBD="text": no box, that text as OK
    const n = <usize>strLen(STR_KBD);
    copy(TEXT, strPtr(STR_KBD), n); store<u8>(TEXT + n, 0);
    req().step(SwkbdRequestE.Answer, SwkbdRequestResult.ok);
    return true;
  }
  store<u64>(REQ, <u64>TITLE); store<u64>(REQ, <u64>SUB, 8); store<u64>(REQ, <u64>GUIDE, 16); store<u64>(REQ, <u64>INIT, 24);
  store<i32>(REQ, maxChars, 32); store<i32>(REQ, minChars, 36); store<i32>(REQ, kind, 40);
  kbdEvent(); eventClear(kbdW);
  envTextRequest(REQ);
  return req().state == SwkbdRequestS.Answered;
}
// The answer of a finished request: 1 OK (the text is at TEXT), 0 cancel, -1 no window
function take(): i32 {
  const r = <u32>req().data;
  req().step(SwkbdRequestE.Take);
  return r == SwkbdRequestResult.ok ? 1 : r == SwkbdRequestResult.cancel ? 0 : -1;
}

// ---------- ShowKeyboard ----------
// Continuation slot 0: 0 first entry, 1 the request is out
export function h_swkbd_Show(a: usize): u64 {
  const out = P(a, 0), arg = P(a, 1);
  const maxlen = load<i32>(arg + ARG_MAXLEN), minlen = load<i32>(arg + ARG_MINLEN);
  if (C(a, 0) == 0) {
    if (req().state != SwkbdRequestS.Idle) return wait(kbdEvent(), 100000000);   // another thread's keyboard is up: one applet at a time
    appletEnterS("software keyboard");
    u16ToU8(arg + ARG_HEADER, HEADER_N, TITLE, 196); u16ToU8(arg + ARG_SUB, SUB_N, SUB, 388); u16ToU8(arg + ARG_GUIDE, GUIDE_N, GUIDE, 772);
    const ilen = load<i32>(arg + ARG_INIT_LEN), ioff = load<i32>(arg + ARG_INIT_OFF), work = <usize>load<u64>(arg + ARG_WORKBUF);
    store<u8>(INIT, 0);
    if (ilen > 0 && work) u16ToU8(work + <usize>ioff, <usize>ilen, INIT, 1504);
    setC(a, 0, 1);
    if (!ask(0, maxlen > 0 ? maxlen : 0, minlen > 0 ? minlen : -1)) return wait(kbdR, -1);
  } else if (req().state != SwkbdRequestS.Answered) return wait(kbdEvent(), -1);
  const r = take();
  ls(); ps("swkbd: title '"); pz(TITLE); ps("' initial '"); pz(INIT); ps("' limit "); pi(maxlen); ps(" min "); pi(minlen); ps(" -> ");
  if (r > 0) { ps("OK '"); pz(TEXT, 256); ps("'"); } else ps(r == 0 ? "cancel" : "no window, treated as cancel");
  le();
  appletLeave();
  if (kbdW) eventSignal(kbdW);   // a thread that found the keyboard busy looks again
  if (r <= 0) return SWKBD_RESULT_CANCELED;
  const buf = <usize>load<u64>(out), cap = load<u64>(out, 8);
  if (!buf || !cap) return 0;   // as the SDK: with no buffer in String the text is not read
  zero(buf, <usize>cap);
  const n = u8ToU16(TEXT, maxlen > 0 ? <usize>maxlen : 1002, U16, 1003);   // truncated to the character limit (in UTF-16 units)
  if (load<u8>(arg + ARG_UTF8)) u16ToU8(U16, n, buf, <usize>cap);   // String's +8 stays the game's capacity
  else if (<u64>((n + 1) * 2) <= cap) copy(buf, U16, n * 2);
  else if (cap >= 2) copy(buf, U16, (<usize>(cap / 2) - 1) * 2);
  return 0;
}

// ---------- InlineKeyboard ----------
// Per keyboard: +0 Inst, +16 u64 kb, +24 cancel, +32 finInit, +40 released, +48 finished, +56 enter, +64 changed (guest
// function addresses), +72 i32 finInitDue, +76 releasedDue, +80 finishedDue, +84 maxLen
const IKB_REC: usize = 96;
const IKB: usize = memory.data(384);
// ChangedStringArg / DecidedEnterArg as the game reads them: u16 text[502], then i32 length (+0x3ec), dictionary
// start, dictionary end, cursor (+0x3f8)
const STRARG: usize = memory.data(1024, 8);
// @ts-ignore: decorator
@inline function ik(i: i32): usize { return IKB + <usize>i * IKB_REC; }
function ikbSlot(kb: u64): i32 {
  for (let i = 0; i < 4; i++) if (load<u64>(ik(i), 16) == kb) return i;
  for (let i = 0; i < 4; i++) if (!load<u64>(ik(i), 16)) { zero(ik(i), IKB_REC); Inst.at(ik(i)).init(SWKBD_INLINE, <u32>i); store<u64>(ik(i), kb, 16); return i; }
  return -1;
}
function ikbFind(kb: u64): i32 { for (let i = 0; i < 4; i++) if (load<u64>(ik(i), 16) == kb) return i; return -1; }
function setCb(a: usize, off: usize): u64 { const i = ikbSlot(X(a, 0)); if (i >= 0) store<u64>(ik(i) + off, X(a, 1)); return 0; }
// What Calc returns (nn::swkbd::State as Monster Hunter Rise reads it): 0 until initialization has finished, 1 ready / hidden, 3 shown
function ikbState(i: i32): u64 { const s = Inst.at(ik(i)).state; return s == SwkbdInlineS.Unstarted ? 0 : s == SwkbdInlineS.Hidden ? 1 : 3; }
export function h_ikb_Init(a: usize): u64 {
  const i = ikbSlot(X(a, 0)); if (i >= 0) store<i32>(ik(i), 1, 72);
  ls(); ps("swkbd: inline keyboard Initialize "); px(X(a, 0)); ps(" (the host starts no applet; Appear asks for the text the way ShowKeyboard does)"); if (i < 0) ps("[RED] registration table full"); le();
  return 1;
}
function ikbFin(kb: u64): u64 { for (let i = 0; i < 4; i++) if (load<u64>(ik(i), 16) == kb) zero(ik(i), IKB_REC); return 0; }
export function h_ikb_Fin(a: usize): u64 { return ikbFin(X(a, 0)); }
export function h_ikb_Dtor(a: usize): u64 { return ikbFin(X(a, 0)); }
export function h_ikb_SetCancel(a: usize): u64 { return setCb(a, 24); }
export function h_ikb_SetFinInit(a: usize): u64 { return setCb(a, 32); }
export function h_ikb_SetReleased(a: usize): u64 { return setCb(a, 40); }
export function h_ikb_SetFinished(a: usize): u64 { return setCb(a, 48); }
export function h_ikb_SetEnter(a: usize): u64 { return setCb(a, 56); }
export function h_ikb_SetChanged(a: usize): u64 { return setCb(a, 64); }
export function h_ikb_Appear(a: usize): u64 {
  const arg = P(a, 1), max: i32 = arg ? load<i32>(arg, 0x20) : 0;   // AppearArg: textMaxLength at +0x20
  const i = ikbSlot(X(a, 0));
  if (i >= 0) {
    const m = Inst.at(ik(i));
    if (m.can(SwkbdInlineE.Appear)) m.step(SwkbdInlineE.Appear);   // not while a Calc is asking: that request stands
    store<i32>(ik(i), max > 0 && max <= 500 ? max : 0, 84);
  }
  ls(); ps("swkbd: inline keyboard Appear "); px(X(a, 0)); ps(" (at most "); pi(max); ps(" characters) -> text asked for on the next tick"); le();
  return 0;
}
export function h_ikb_Disappear(a: usize): u64 {
  const i = ikbSlot(X(a, 0));
  if (i >= 0) { const m = Inst.at(ik(i)); if (m.can(SwkbdInlineE.Disappear)) m.step(SwkbdInlineE.Disappear); store<i32>(ik(i), 1, 80); }
  return 0;
}
export function h_ikb_UnsetWords(a: usize): u64 { const i = ikbSlot(X(a, 0)); if (i >= 0) store<i32>(ik(i), 1, 76); return 0; }
// Continuation slot 0: 0 first entry, 1 the text is wanted and the request machine was busy, 2 the request is out
export function h_ikb_Calc(a: usize): u64 {
  const kb = X(a, 0);
  let i: i32, phase = C(a, 0);
  if (phase == 0) {
    i = ikbSlot(kb);
    if (i < 0) return 0;
    const r = ik(i), m = Inst.at(r);
    let init: u64 = 0, rel: u64 = 0, fin: u64 = 0, asking = false;
    if (load<i32>(r, 72)) { if (m.state == SwkbdInlineS.Unstarted) m.step(SwkbdInlineE.InitDone); if (load<u64>(r, 32)) { store<i32>(r, 0, 72); init = load<u64>(r, 32); } }
    if (load<i32>(r, 76) && load<u64>(r, 40)) { store<i32>(r, 0, 76); rel = load<u64>(r, 40); }
    if (load<i32>(r, 80)) { store<i32>(r, 0, 80); fin = load<u64>(r, 48); }
    if (m.state == SwkbdInlineS.Shown) { m.step(SwkbdInlineE.Ask); asking = true; }
    if (init) guestCall0(init);   // guest code, on the guest thread that called Calc (as on hardware)
    if (rel) guestCall0(rel);
    if (fin) guestCall0(fin);
    if (!asking) return ikbFind(kb) == i ? ikbState(i) : 0;
    phase = 1; setC(a, 0, 1);
  }
  i = ikbFind(kb);
  const enter: u64 = i >= 0 ? load<u64>(ik(i), 56) : 0, max: i32 = i >= 0 ? load<i32>(ik(i), 84) : 0;
  let r = 0;
  if (enter) {
    if (phase == 1) {
      if (req().state != SwkbdRequestS.Idle) return wait(kbdEvent(), 100000000);
      store<u8>(TITLE, 0); store<u8>(SUB, 0); store<u8>(GUIDE, 0); store<u8>(INIT, 0);
      const script = strLen(STR_KBD) >= 0;
      if (!script) clockFreeze(2, 1);   // the guest clock stands still while the box is up (reason 2)
      setC(a, 0, script ? 3 : 2);
      if (!ask(1, max, -1)) return wait(kbdR, -1);
    } else if (req().state != SwkbdRequestS.Answered) return wait(kbdEvent(), -1);
    r = take();
    if (C(a, 0) == 2) clockFreeze(2, 0);
    if (kbdW) eventSignal(kbdW);
  }
  ls(); ps("swkbd: inline keyboard "); px(kb); ps(" -> ");
  if (r > 0) { ps("OK '"); pz(TEXT, 256); ps("'"); } else ps(enter ? "cancel" : "no enter callback, cancel");
  le();
  i = ikbFind(kb);
  if (i >= 0) { const m = Inst.at(ik(i)); if (m.state == SwkbdInlineS.Asking) m.step(SwkbdInlineE.Decided); }   // the keyboard closes once the text is decided or cancelled
  if (r <= 0) { const cancel: u64 = i >= 0 ? load<u64>(ik(i), 24) : 0; if (cancel) guestCall0(cancel); return 1; }
  zero(STRARG, 1024);
  const n = u8ToU16(TEXT, max > 0 ? <usize>max : 500, STRARG, 502);
  store<i32>(STRARG, <i32>n, 0x3ec); store<i32>(STRARG, <i32>n, 0x3f8);
  const changed: u64 = i >= 0 ? load<u64>(ik(i), 64) : 0;
  if (changed) guestCall1(changed, <u64>STRARG);
  guestCall1(enter, <u64>STRARG);
  return 1;
}
export function swkbdInit(): void { req().init(SWKBD_REQUEST, 0); zero(IKB, 384); kbdR = 0; kbdW = 0; }
