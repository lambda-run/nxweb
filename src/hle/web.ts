// nn::web offline HTML pages: port of nxnative dm/host/hle_web.c. The pages a game ships in its HtmlDocument NCA are
// shown by the embedder's web view (imports hle_web_*); without the page or without a view the stand-in answers: the
// page loads at once, sends one empty content message and closes when it appears (exit reason 0, no last URL).
// One page at a time (machine web_session). While a page is shown it holds the input (import hle_input_hold).
// ShowOfflineHtmlPageArg (0x2000 bytes): u16 entry count at +0, entries from +8, each { u16 type, u16 size, u32 0 }
// and its data. OfflineHtmlPageReturnValue: u64 exit reason at +0, the last URL at +8 (0x1000 bytes), its size at +0x1008.
import { Inst } from "../kit/machine";
import { WEB_SESSION, WebSessionS, WebSessionE } from "../kit/gen/tables";
import { X, P, C, setC, wait, newEventPair, eventSignal, eventClear, ls, ps, pz, pu, le, red, zero, copy, zlen, zcopy } from "./base";
import { seBind, seSignal, seClear } from "./sysevent";

// Open the document `path` (inside the game's HTML documents) with the callback URL; hidden: shown only at
// hle_web_show. 0: a web view has it; 1: the page was not found; 2: there is no web view
// @ts-ignore: decorator
@external("env", "hle_web_open")
declare function webOpen(path: usize, callback: usize, hidden: i32, keyRepeatDelay: u32, keyRepeatPulse: u32): i32;
// @ts-ignore: decorator
@external("env", "hle_web_show")
declare function webShow(): void;
// @ts-ignore: decorator
@external("env", "hle_web_send")
declare function webSend(msg: usize, n: usize): void;
// @ts-ignore: decorator
@external("env", "hle_web_close")
declare function webClose(): void;
// The page holds the input (1) or gives it back (0): the game reads nothing meanwhile
// @ts-ignore: decorator
@external("env", "hle_input_hold")
declare function inputHold(on: i32): void;

const TLV_CALLBACK_URL: u32 = 0x3, TLV_DOCUMENT_PATH: u32 = 0x6, TLV_KEY_REPEAT_DELAY: u32 = 0x1c, TLV_KEY_REPEAT_PULSE: u32 = 0x1d, TLV_BOOT_MODE: u32 = 0x41;
const ARG_SIZE: usize = 0x2000, URL_SIZE: usize = 0x1000, MSG_MAX: i32 = 32, MSG_CAP: usize = 2048;
const INST: usize = memory.data(16);
const EV_WEB: usize = memory.data(256, 16);
const URL: usize = memory.data(4096);
const MSGS: usize = memory.data(65536);    // MSG_MAX * MSG_CAP
const MSGN: usize = memory.data(128);      // u32 each
const PATH: usize = memory.data(3072), CB: usize = memory.data(1024);
const WH: usize = memory.data(8);
let real: bool = false, held: bool = false, reason: u32 = 0, msgH: i32 = 0, msgC: i32 = 0, endR: u32 = 0, endW: u32 = 0, tlvSize: u32 = 0, nlog: i32 = 0;
// @ts-ignore: decorator
@inline function m(): Inst { return Inst.at(INST); }
function open_(): bool { return m().state == WebSessionS.Started || m().state == WebSessionS.Shown; }

// The value of entry `type`, 0 when the argument has none; tlvSize = its size
function tlv(arg: usize, type: u32): usize {
  const n: u32 = load<u16>(arg); let o: usize = 8;
  for (let i: u32 = 0; i < n && o + 8 <= ARG_SIZE; i++) {
    const t: u32 = load<u16>(arg + o), sz: usize = load<u16>(arg + o, 2);
    if (o + 8 + sz > ARG_SIZE) break;
    if (t == type) { tlvSize = <u32>sz; return arg + o + 8; }
    o += 8 + sz;
  }
  return 0;
}
function tlvStr(arg: usize, type: u32, out: usize, cap: usize): void {
  const v = tlv(arg, type);
  store<u8>(out, 0);
  if (v) { let n = zlen(v, tlvSize); if (n > cap - 1) n = cap - 1; copy(out, v, n); store<u8>(out + n, 0); }
}
function tlvU32(arg: usize, type: u32, def: u32): u32 { const v = tlv(arg, type); return v && tlvSize >= 4 ? load<u32>(v) : def; }

function msgClear(): void { msgH = 0; msgC = 0; }
function msgPush(p: usize, n: usize): void {
  if (msgC == MSG_MAX) { red("web: 32 content messages from the page not taken by the game; the oldest is dropped"); msgH = (msgH + 1) % MSG_MAX; msgC--; }
  const i = (msgH + msgC++) % MSG_MAX;
  if (n > MSG_CAP - 1) { red("web: a content message longer than 2047 bytes is cut"); n = MSG_CAP - 1; }
  if (n) copy(MSGS + <usize>i * MSG_CAP, p, n);
  store<u8>(MSGS + <usize>i * MSG_CAP + n, 0); store<u32>(MSGN + (<usize>i << 2), <u32>n);
}
function endEvent(): u32 { if (!endR) { endR = newEventPair(WH); endW = load<u32>(WH); } return endR; }
// The page ends: hidden, the input given back, the exit event fired
function webEnd(why: u32, url: usize): void {
  if (!open_()) return;
  reason = why; if (url) zcopy(URL, url, URL_SIZE); else store<u8>(URL, 0);
  m().step(WebSessionE.End);
  if (held) { held = false; inputHold(0); }
  seSignal(EV_WEB);
  if (endW) eventSignal(endW);
}
// ---- the embedder's reports ----
export function webMessage(msg: usize, n: usize): void {
  if (nlog++ < 16) { ls(); ps("web: content message from the page: \""); pz(msg, n > 80 ? 80 : <i32>n); ps("\""); le(); }
  if (open_()) msgPush(msg, n);
}
export function webEnded(why: u32, url: usize): void {
  if (open_()) { ls(); ps("web: the page ended: exit reason "); pu(why); ps(", last URL "); if (url && load<u8>(url)) pz(url); else ps("(none)"); le(); }
  webEnd(why, url);
}
export function webFailed(why: usize): void {   // the page did not load: the stand-in takes over
  if (real && open_()) {
    ls(); ps("[RED] web: the page could not be shown ("); if (why) pz(why); else ps("?"); ps("); the stand-in answers"); le();
    real = false;
    if (m().state == WebSessionS.Started) msgPush(0, 0); else webEnd(0, 0);
  }
}
export function webState(): u8 { return m().state; }

function webStart(arg: usize, sync: bool): void {
  tlvStr(arg, TLV_DOCUMENT_PATH, PATH, 3072); tlvStr(arg, TLV_CALLBACK_URL, CB, 1024);
  if (!load<u8>(CB)) { const s = "http://localhost/"; for (let i = 0; i < s.length; i++) store<u8>(CB + <usize>i, <u8>s.charCodeAt(i)); store<u8>(CB + <usize>s.length, 0); }
  const hidden = !sync && tlvU32(arg, TLV_BOOT_MODE, 0) == 1;   // WebSessionBootMode: 0 all foreground, 1 initially hidden
  const delay = tlvU32(arg, TLV_KEY_REPEAT_DELAY, 0), pulse = tlvU32(arg, TLV_KEY_REPEAT_PULSE, 0);
  if (m().state != WebSessionS.None) { webClose(); if (held) inputHold(0); }
  msgClear(); held = false; reason = 0; store<u8>(URL, 0);
  m().step(WebSessionE.Start);
  // a path inside the document only (its query cut off for the test, as web_find does)
  const bad = !load<u8>(PATH) || load<u8>(PATH) == 0x2F || load<u8>(PATH) == 0x3F || load<u8>(PATH) == 0x23 || hasDotDot(PATH);
  const r: i32 = bad ? 1 : webOpen(PATH, CB, hidden ? 1 : 0, delay, pulse);
  real = r == 0;
  ls(); ps("web: offline page "); pz(PATH);
  if (real) { ps(hidden ? " (hidden until it appears" : " (shown"); ps(", callback URL "); pz(CB); ps(")"); }
  else { ps(r == 2 ? ": no web view" : ": not found"); ps("; the stand-in answers (it loads at once and closes when it appears)"); }
  le();
  if (!real) msgPush(0, 0);   // the stand-in's ready message: the game waits for any message before Appear
  if (real && !hidden) { m().step(WebSessionE.Show); held = true; inputHold(1); }
}
function hasDotDot(p: usize): bool { for (let q = p; load<u8>(q) && load<u8>(q) != 0x3F && load<u8>(q) != 0x23; q++) if (load<u8>(q) == 0x2E && load<u8>(q + 1) == 0x2E) return true; return false; }
// The ended page's result into the return value; the session is over
function webReturn(rv: usize): void {
  if (rv) {
    store<u64>(rv, reason);
    zcopy(rv + 8, URL, URL_SIZE);
    store<u64>(rv + 8 + URL_SIZE, load<u8>(URL) ? <u64>zlen(URL) + 1 : 0);
  }
  if (real) webClose();
  msgClear();
  if (m().can(WebSessionE.Return)) m().step(WebSessionE.Return);
  real = false; seClear(EV_WEB);
}
function waitEnd(): u64 { const r = endEvent(); eventClear(endW); return wait(r, -1); }

export function h_webs_Fini(a: usize): u64 { if (open_()) { webEnded(2, 0); webReturn(0); } return 0; }
export function h_webs_Start(a: usize): u64 {
  const ev = P(a, 1);
  seBind(EV_WEB, 0); seClear(EV_WEB);
  if (ev) store<u64>(ev, <u64>EV_WEB);
  webStart(P(a, 2), false);
  return 0;
}
export function h_webs_Appear(a: usize): u64 {
  if (m().state == WebSessionS.Started && real) { m().step(WebSessionE.Show); held = true; inputHold(1); webShow(); }
  else if (open_()) { if (m().state == WebSessionS.Started) m().step(WebSessionE.Show); webEnd(0, 0); }   // the stand-in closes at once
  return 1;
}
export function h_webs_Send(a: usize): u64 { const msg = P(a, 1); if (real && open_()) webSend(msg, msg ? zlen(msg, <usize>X(a, 2)) : 0); return 1; }
// Oldest first; the size is without the terminating zero
export function h_webs_Recv(a: usize): u64 {
  const out = P(a, 1), buf = P(a, 2), n = X(a, 3);
  if (msgC <= 0) return 0;
  const i = msgH, len: u64 = load<u32>(MSGN + (<usize>i << 2)), k: u64 = len < n ? len : n ? n - 1 : 0;
  if (buf && n) { copy(buf, MSGS + <usize>i * MSG_CAP, <usize>k); store<u8>(buf + <usize>k, 0); }
  if (out) store<u64>(out, k);
  msgH = (i + 1) % MSG_MAX; msgC--;
  return 1;
}
export function h_webs_Needs(a: usize): u64 { return m().state != WebSessionS.None ? 1 : 0; }
export function h_webs_ReqExit(a: usize): u64 { webEnded(2, 0); return 0; }
export function h_webs_Wait(a: usize): u64 {
  if (open_()) return waitEnd();
  webReturn(P(a, 1));
  return 0;
}
// The page as an applet the calling thread waits for. Continuation slot 0: 1 once the page is started
export function h_web_Offline(a: usize): u64 {
  if (C(a, 0) == 0) {
    seBind(EV_WEB, 0); seClear(EV_WEB);
    webStart(P(a, 1), true);
    if (!real) { webReturn(0); return 0x2A2; }
    setC(a, 0, 1);
  }
  if (open_()) return waitEnd();
  webReturn(P(a, 0));
  return 0;
}
export function webInit(): void { m().init(WEB_SESSION, 0); real = false; held = false; reason = 0; msgH = 0; msgC = 0; endR = 0; endW = 0; nlog = 0; store<u8>(URL, 0); }
