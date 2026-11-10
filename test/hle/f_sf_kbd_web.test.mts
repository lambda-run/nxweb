// Host service sessions (sf.ts, nxnative hle_sf.c), the software keyboard (swkbd.ts, hle_swkbd.c) and offline HTML
// pages (web.ts, hle_web.c). Ported scenarios: nxnative dm/host/tests/t_sf.c and t_swkbd.c.
import assert from "node:assert/strict";
import { test, Hle, RES_FAIL } from "./harness.mts";

const SEND = "_ZN2nn2sf4hipc15SendSyncRequestENS_3svc6HandleEPvm", CONNECT = "_ZN2nn2sf4hipc20ConnectToHipcServiceEPNS_3svc6HandleEPKc";
test("sf (t_sf): a served service answers every request with success and zeroed output; the camera session has no camera", () => {
  const h = new Hle();
  const m = h.alloc(0x110, 0xEE), hp = h.alloc(8);
  // a CMIF request for command cmd on a non-domain session: HIPC type 4, the data words from +8, "SFCI" at +0x10
  const request = (session: number, cmd: number) => {
    h.u8.fill(0xCC, m, m + 0x100);
    [4, 8].forEach((v, i) => h.dv.setUint32(m + 4 * i, v, true));
    [0x49434653, 0, cmd, 0].forEach((v, i) => h.dv.setUint32(m + 16 + 4 * i, v, true));
    return h.call(SEND, session, m, 0x100).x0;
  };
  const w = (i: number) => h.u32(m + 4 * i);
  assert.equal(h.call(CONNECT, hp, h.str("olsc:u")).x0, 0n);
  const s = h.u32(hp); assert.equal(s, 0xd0000, "session handles from 0xd0000, outside the kernel handle table");
  assert.equal(request(s, 0), 0n);
  assert.ok(!(w(1) >>> 31) && w(4) === 0x4f434653 && w(6) === 0, "success, no special header, SFCO at +0x10");
  const want = Buffer.alloc(0x110, 0xEE); want.fill(0, 0, 0x100); want.writeUInt32LE((0x100 - 8) / 4, 4); want.writeUInt32LE(0x4f434653, 16);
  assert.deepEqual(h.read(m, 0x110), want, "the whole response: zero but the data word count and SFCO, nothing past the buffer");
  assert.equal(h.call(CONNECT, hp, h.str("chat:u")).x0, 0xe15n, "a service the host does not serve is not registered"); assert.equal(h.red.length, 1);
  const cp = h.alloc(8);
  assert.equal(h.call("_ZN2nn6camera3sdk19CreateCameraContextEPNS_5gsdrv18UniqueNativeHandleE", cp).x0, 0n);
  const cam = h.u32(cp); assert.equal(cam, 0xd0001);
  assert.ok(request(cam, 3) === 0n && w(4) === 0x4f434653 && w(6) === 0 && !(w(1) >>> 31), "initializing the camera library: success");
  assert.ok(request(cam, 29) === 0n && w(6) === 0x7c4 && !(w(1) >>> 31), "querying the device: 0x7c4, no camera device");
  const before = h.events.size;
  assert.equal(request(cam, 21), 0n, "the camera's event");
  assert.equal(h.events.size, before + 2, "one new kernel event");
  assert.ok(w(1) >>> 31 && (w(2) >> 1 & 15) === 1 && (w(2) & 1) === 0 && (w(2) >> 5 & 15) === 0, "special header: one copy handle, no process ID, no move handle");
  assert.ok(h.events.has(w(3)) && !h.ev(w(3)).signaled, "the copied handle is the new event's read end");
  assert.ok(w(4) === 0x4f434653 && w(6) === 0, "SFCO stays at +0x10 after the special header and handle");
  assert.equal(w(1) & 0x3ff, (0x100 - 0x10) / 4, "the data words start after the handle");
  const dp = h.alloc(8);
  assert.equal(h.call("_ZN2nn2sf4hipc6client16DuplicateSessionEPNS_3svc6HandleES4_", dp, cam).x0, 0n);
  const dup = h.u32(dp); assert.ok(dup && dup !== cam);
  assert.ok(request(dup, 5) === 0n && w(6) === 0x7c4, "the duplicate answers as the camera");
  assert.ok(request(dup, 4) === 0n && w(6) === 0, "finalizing the camera library: success");
  for (const x of [dup, cam, s]) h.call("_ZN2nn2sf4hipc24CloseClientSessionHandleENS_3svc6HandleE", x);
  assert.equal(h.red.length, 1);
  assert.equal(request(s, 0), 0xe401n, "a closed session is no session"); assert.equal(h.red.length, 2);
});

test("sf: control requests, domains, HIPC close, malformed requests", () => {
  const h = new Hle();
  const m = h.alloc(0x100), hp = h.alloc(8), o16 = h.alloc(8, 0xEE);
  h.call(CONNECT, hp, h.str("caps:su")); const s = h.u32(hp);
  assert.equal(h.call("_ZN2nn2sf4hipc6client22QueryPointerBufferSizeEPtNS_3svc6HandleE", o16, s).x0, 0n); assert.deepEqual([...h.read(o16, 3)], [0, 0, 0xEE], "a u16");
  assert.equal(h.call("_ZN2nn2sf4hipc6client22QueryPointerBufferSizeEPtNS_3svc6HandleE", o16, 5).x0, RES_FAIL);
  const dom = h.alloc(8, 0xEE);
  assert.equal(h.call("_ZN2nn2sf4hipc6client22ConvertSessionToDomainEPNS0_4cmif18CmifDomainObjectIdENS_3svc6HandleE", dom, s).x0, 0n); assert.deepEqual([h.u32(dom), h.u32(dom + 4)], [1, 0xEEEEEEEE]);
  // a domain request: the domain header { u8 type, u8 objects, u16 size, u32 object, ... } at +0x10, SFCI at +0x20; the response's SFCO at +0x20
  const put = (words: number[]) => { h.u8.fill(0, m, m + 0x100); words.forEach((v, i) => h.dv.setUint32(m + 4 * i, v, true)); };
  put([4, 12, 0, 0, 1 | 0x18 << 16, 1, 0, 0, 0x49434653, 3, 77, 0]);
  assert.equal(h.call(SEND, s, m, 0x100).x0, 0n);
  assert.deepEqual([h.u32(m + 0x20), h.u32(m + 0x24), h.u32(m + 0x28)], [0x4f434653, 3, 0], "SFCO after the domain's out header, the version echoed");
  assert.ok(h.read(m + 0x10, 0x10).every(b => b === 0), "no out objects");
  put([4, 12, 0, 0, 2, 1, 0, 0]);   // a domain object closed: nothing to answer
  h.u8.fill(0x77, m + 0x20, m + 0x40);
  assert.equal(h.call(SEND, s, m, 0x100).x0, 0n); assert.ok(h.read(m, 16).every(b => b === 0) && h.u8[m + 0x20] === 0x77, "the first 16 bytes cleared, the rest left");
  put([2, 0]); assert.equal(h.call(SEND, s, m, 0x100).x0, 0xf601n, "HIPC Close: the closed-session result");
  put([5, 8, 0, 0, 0x49434653]); assert.equal(h.call(SEND, s, m, 0x100).x0, 0xe401n, "another HIPC type is not served");
  put([4, 8, 0, 0, 0x12345678]);
  const ndom = h.alloc(8); h.call(CONNECT, ndom, h.str("caps:a"));
  assert.equal(h.call(SEND, h.u32(ndom), m, 0x100).x0, 0xe401n, "no SFCI");
  put([4, 0x3ff]); assert.equal(h.call(SEND, h.u32(ndom), m, 0x100).x0, 0xe401n, "more data words than the buffer");
  assert.equal(h.call(SEND, h.u32(ndom), m, 0x3f).x0, 0xe401n, "a buffer under 0x40 bytes");
  // a special header in the request (process ID, 1 copy handle) moves the data
  put([4, 8, 0, 0]); h.dv.setUint32(m + 4, 8 | 0x80000000, true); h.dv.setUint32(m + 8, 1 | 1 << 1, true);
  [0x49434653, 0, 9, 0].forEach((v, i) => h.dv.setUint32(m + 0x20 + 4 * i, v, true));
  assert.equal(h.call(SEND, h.u32(ndom), m, 0x2000).x0, 0n);
  assert.equal(h.u32(m + 4), (0x1000 - 8) / 4, "a big buffer: 0x1000 bytes cleared and counted"); assert.equal(h.u32(m + 16), 0x4f434653);
  const d2 = h.alloc(8); assert.equal(h.call("_ZN2nn2sf4hipc6client18DuplicateSessionExEPNS_3svc6HandleES4_j", d2, s, 7).x0, 0n);
  put([4, 12, 0, 0, 1, 1, 0, 0, 0x49434653, 0, 1, 0]);
  h.call(SEND, h.u32(d2), m, 0x100); assert.equal(h.u32(m + 0x20), 0x4f434653, "a duplicate of a domain session is a domain session");
  assert.equal(h.call("_ZN2nn2sf4hipc31InitializeHipcServiceResolutionEv").x0, 0n);
  // the table is bounded (nxnative stops at 64 sessions)
  let last = 0; for (let i = 0; i < 70; i++) { h.call(CONNECT, hp, h.str("olsc:u")); last = h.u32(hp); }
  assert.equal(last, 0); assert.ok(h.red.some(l => l.includes("more than 64 host service sessions")));
});

// ---------- swkbd ----------
function kbd() {
  const h = new Hle();
  const arg = h.alloc(0x500), work = h.alloc(0x1000), sbuf = h.alloc(0x7d4), str = h.alloc(16);
  const mkarg = (utf8: number, maxlen: number, init: string, ilen: number, minlen = 0) => {
    h.u8.fill(0, arg, arg + 0x500); h.u8.fill(0, work, work + 0x1000); h.u8.fill(0xAA, sbuf, sbuf + 0x7d4);
    h.dv.setBigUint64(str, BigInt(sbuf), true); h.dv.setBigUint64(str + 8, 0x7d4n, true);   // a fresh String per call, its capacity at +8
    h.u8.set(h.u16str("起名"), arg + 0x24);
    h.dv.setInt32(arg + 0x3ac, maxlen, true); h.dv.setInt32(arg + 0x3b0, minlen, true); h.u8[arg + 0x3bd] = utf8;
    h.dv.setInt32(arg + 0x3c0, 0x14, true); h.dv.setInt32(arg + 0x3c4, ilen, true);   // the way SetInitialTextUtf8 writes it
    h.u8.set(h.u16str(init).subarray(0, ilen * 2), work + 0x14);
    h.dv.setBigUint64(arg + 0x4d0, BigInt(work), true);
    h.textRequests.length = 0;
  };
  const show = () => h.call("_ZN2nn5swkbd12ShowKeyboardEPNS0_6StringERKNS0_15ShowKeyboardArgE", str, arg);
  const bytesEq = (want: number[]) => { const b = h.read(sbuf, 0x7d4); return want.every((v, i) => b[i] === v) && b.subarray(want.length).every(v => v === 0); };
  return { h, arg, sbuf, str, mkarg, show, bytesEq, cap: () => h.u64(str + 8) };
}

test("swkbd (t_swkbd): ShowKeyboard decodes the argument and writes the String back as the applet does", () => {
  const t = kbd(), h = t.h;
  let reply: string | null | { noWindow: true } = "Ünï名";
  h.onText = () => { h.host.textAnswer(reply); };   // an input box that answers at once
  t.mkarg(1, 16, "Hero", 4);
  assert.equal(t.show().x0, 0n);
  assert.ok(t.bytesEq([0xC3, 0x9C, 0x6E, 0xC3, 0xAF, 0xE5, 0x90, 0x8D, 0x00]), "UTF-8 write-back, the rest of the buffer zero");
  assert.equal(t.cap(), 0x7d4n, "the SDK leaves the capacity");
  assert.deepEqual(h.textRequests, [{ title: "起名", sub: "", guide: "", initial: "Hero", maxChars: 16, minChars: -1, kind: "keyboard" }]);
  t.mkarg(1, 16, "Hero", 4); reply = null;
  assert.equal(t.show().x0, 0x29Fn, "cancel");
  assert.ok(h.u8[t.sbuf] === 0xAA && h.u8[t.sbuf + 0x7d3] === 0xAA && t.cap() === 0x7d4n, "cancel leaves the buffer");
  t.mkarg(1, 16, "Hero", 4); reply = { noWindow: true };
  assert.equal(t.show().x0, 0x29Fn, "no window is treated as cancel");
  t.mkarg(0, 16, "Hero", 0, 3); reply = "A名";
  assert.equal(t.show().x0, 0n);
  assert.ok(t.bytesEq([0x41, 0x00, 0x0D, 0x54, 0x00, 0x00]), "UTF-16 output (isUseUtf8 = 0)");
  assert.equal(h.textRequests[0].initial, "", "initial length 0: no initial text"); assert.equal(h.textRequests[0].minChars, 3, "the minimum length goes to the input box");
  t.mkarg(1, 3, "Hero", 4); reply = "ABCDE"; t.show();
  assert.ok(t.bytesEq([65, 66, 67, 0]), "truncated to the maximum length");
  t.mkarg(1, 2, "Hero", 4); reply = "a\u{1F600}"; t.show();
  assert.ok(t.bytesEq([97, 0]), "truncation does not split a surrogate pair");
  h.host.config({ kbd: "Kbd" });
  t.mkarg(1, 16, "Hero", 4); reply = null;
  assert.equal(t.show().x0, 0n); assert.ok(t.bytesEq([75, 98, 100, 0])); assert.equal(h.textRequests.length, 0, "DM_KBD gives the text: the input box is not asked");
  h.host.config({ kbd: null });
  // a String with no buffer: the text is not read
  t.mkarg(1, 16, "Hero", 4); reply = "x"; h.dv.setBigUint64(t.str, 0n, true);
  assert.equal(t.show().x0, 0n); assert.equal(h.u8[t.sbuf], 0xAA);
  // a small UTF-16 buffer: as many whole units as fit before the terminator
  t.mkarg(0, 16, "", 0); reply = "ABCDEFGH"; h.dv.setBigUint64(t.str + 8, 9n, true);
  t.show(); assert.deepEqual([...h.read(t.sbuf, 10)], [65, 0, 66, 0, 67, 0, 0, 0, 0, 0xAA]);
  assert.equal(h.red.length, 0);
});

test("swkbd: the keyboard is an applet the thread waits for: focus out, a wait on a host event, focus back", () => {
  const t = kbd(), h = t.h, msg = h.alloc(4);
  const pop = () => h.w0("_ZN2nn2oe25TryPopNotificationMessageEPj", msg) ? h.u32(msg) : 0;
  t.mkarg(1, 16, "", 0);
  let r = t.show();   // the embedder answers later
  assert.ok(r.wait && r.wait.timeoutNs === -1n, "the calling thread waits");
  assert.equal(h.x.hle_focus_seen(), 2, "out of focus while the keyboard is up"); assert.equal(pop(), 15);
  assert.equal(h.textRequests.length, 1);
  r = h.resume("cancelled"); assert.ok(r.wait, "woken without an answer: waits again"); assert.equal(h.textRequests.length, 1, "not asked twice");
  // another thread's ShowKeyboard meanwhile: one applet at a time
  const first = h.last!;
  const r2 = t.show(); assert.ok(r2.wait && r2.wait.timeoutNs === 100_000_000n); const second = h.last!;
  assert.ok(h.host.textAnswer("Zelda")); assert.ok(h.ev(first.pend ? r.wait!.handle : 0).signaled, "the answer signals the waiter");
  h.last = first; r = h.resume("signaled");
  assert.equal(r.x0, 0n); assert.ok(t.bytesEq([90, 101, 108, 100, 97, 0]));
  assert.equal(h.x.hle_focus_seen(), 1); assert.equal(pop(), 15);
  h.last = second; h.onText = () => { h.host.textAnswer("Link"); };
  r = h.resume("timeout"); assert.equal(r.x0, 0n); assert.equal(h.textRequests.length, 2, "then the second keyboard comes up");
  assert.ok(!h.host.textAnswer("late"), "an answer with no request waiting is refused"); assert.equal(h.red.length, 1);
});

test("swkbd: UTF-8 / UTF-16 conversion edge cases through the keyboard", () => {
  const t = kbd(), h = t.h;
  let reply = "";
  h.onText = () => { h.host.textAnswer(reply); };
  t.mkarg(0, 0, "", 0); reply = "\u{1F600}éz";   // no limit: 1002 units
  t.show(); assert.deepEqual([...h.read(t.sbuf, 10)], [0x3D, 0xD8, 0x00, 0xDE, 0xE9, 0x00, 0x7A, 0x00, 0, 0]);
  t.mkarg(1, 0, "a\u{1F600}ü", 4); reply = "ok"; t.show();
  assert.equal(h.textRequests[0].initial, "a\u{1F600}ü", "a surrogate pair in the initial text is one code point");
  t.mkarg(1, 0, "", 0); reply = "x".repeat(1500); t.show();
  assert.equal(h.cstr(t.sbuf).length, 1002, "at most 1002 units without a limit");
});

const IK = "_ZN2nn5swkbd14InlineKeyboard";
test("swkbd: the inline keyboard: Calc's state, the callbacks in order, the changed-string / enter argument layout", () => {
  const h = new Hle(), kb = h.alloc(64), calls: string[] = [];
  let argBytes: Buffer | null = null;
  const cb = (name: string, withArg = false) => h.fn(p => { calls.push(name); if (withArg) argBytes = h.read(Number(p), 0x3fc); });
  const calc = () => h.call(IK + "4CalcEv", kb);
  assert.equal(calc().x0, 0n, "0 until initialization has finished");
  assert.equal(h.w0(IK + "10InitializeEPv", kb, 0), 1);
  h.call(IK + "29SetFinishedInitializeCallbackEPFvvE", kb, cb("finInit"));
  h.call(IK + "24SetDecidedCancelCallbackEPFvvE", kb, cb("cancel"));
  h.call(IK + "23SetDecidedEnterCallbackEPFvPKNS0_15DecidedEnterArgEE", kb, cb("enter", true));
  h.call(IK + "24SetChangedStringCallbackEPFvPKNS0_16ChangedStringArgEE", kb, cb("changed", true));
  h.call(IK + "27SetFinishedKeyboardCallbackEPFvvE", kb, cb("finished"));
  h.call(IK + "31SetReleasedUserWordInfoCallbackEPFvvE", kb, cb("released"));
  assert.equal(calc().x0, 1n, "ready"); assert.deepEqual(calls, ["finInit"]);
  assert.equal(calc().x0, 1n); assert.deepEqual(calls, ["finInit"], "the finished-initialize callback once");
  const appear = h.alloc(0x40); h.dv.setInt32(appear + 0x20, 4, true);   // AppearArg: textMaxLength at +0x20
  h.call(IK + "6AppearERKNS0_9AppearArgE", kb, appear);
  // the Calc after Appear asks for the text; nxnative blocks in the input box with the guest clock frozen (reason 2)
  let r = calc();
  assert.ok(r.wait && r.wait.timeoutNs === -1n); assert.deepEqual(h.freezes, [[2, true]]);
  assert.deepEqual(h.textRequests, [{ title: "", sub: "", guide: "", initial: "", maxChars: 4, minChars: -1, kind: "inline" }]);
  const waiting = h.last!;
  assert.equal(calc().x0, 3n, "another Calc meanwhile: shown"); h.last = waiting;
  h.host.textAnswer("Palico名");
  r = h.resume("signaled");
  assert.equal(r.x0, 1n); assert.deepEqual(h.freezes, [[2, true], [2, false]]);
  assert.deepEqual(calls, ["finInit", "changed", "enter"], "the changed-string callback, then the enter callback");
  const want = Buffer.alloc(0x3fc); Buffer.from("Pali", "utf16le").copy(want); want.writeInt32LE(4, 0x3ec); want.writeInt32LE(4, 0x3f8);
  assert.deepEqual(argBytes, want, "u16 text[502], length at +0x3ec, cursor at +0x3f8; cut to the 4 characters Appear allowed");
  assert.equal(calc().x0, 1n, "the keyboard closed once the text was decided");
  // cancel; Disappear -> the finished callback on the next Calc; UnsetUserWordInfo -> the released callback
  calls.length = 0; h.onText = () => { h.host.textAnswer(null); };
  h.call(IK + "6AppearERKNS0_9AppearArgE", kb, 0);
  assert.equal(calc().x0, 1n); assert.deepEqual(calls, ["cancel"]);
  h.call(IK + "6AppearERKNS0_9AppearArgE", kb, 0); h.call(IK + "6AppearERKNS0_9AppearArgE", kb, 0); h.call(IK + "9DisappearEv", kb);
  assert.equal(h.call(IK + "17UnsetUserWordInfoEv", kb).x0, 0n);
  calls.length = 0; assert.equal(calc().x0, 1n); assert.deepEqual(calls, ["released", "finished"], "a Disappear before the Calc withdraws the request");
  h.call(IK + "9DisappearEv", kb); calls.length = 0; calc(); assert.deepEqual(calls, ["finished"], "Disappear while hidden still reports finished");
  // DM_KBD answers without the box or a frozen clock
  h.host.config({ kbd: "Rex" }); h.freezes.length = 0; calls.length = 0; h.textRequests.length = 0;
  h.call(IK + "6AppearERKNS0_9AppearArgE", kb, 0);
  assert.equal(calc().x0, 1n); assert.deepEqual(calls, ["changed", "enter"]); assert.equal(h.freezes.length, 0); assert.equal(h.textRequests.length, 0);
  assert.equal(argBytes!.readInt32LE(0x3ec), 3);
  // constants
  assert.equal(h.w0(IK + "12GetMaxHeightEv", kb), 400); assert.equal(h.w0(IK + "8GetImageEPvm", kb, 0, 0), 0);
  const wh = h.alloc(12, 0xEE); h.call("_ZNK2nn5swkbd14InlineKeyboard13GetWindowSizeEPiS2_", kb, wh, wh + 4); assert.deepEqual([h.i32(wh), h.i32(wh + 4), h.u32(wh + 8)], [1280, 720, 0xEEEEEEEE]);
  h.call(IK + "8FinalizeEv", kb); assert.equal(calc().x0, 0n, "finalized: a fresh keyboard at the same address is uninitialized");
  assert.equal(h.red.length, 0);
});

test("swkbd: an inline keyboard without an enter callback cancels; Appear before the first Calc; four keyboards at most", () => {
  const h = new Hle(), calls: string[] = [];
  const kb = h.alloc(8);
  h.call(IK + "24SetDecidedCancelCallbackEPFvvE", kb, h.fn(() => { calls.push("cancel"); }));
  h.call(IK + "6AppearERKNS0_9AppearArgE", kb, 0);   // never initialized: Unstarted -> Shown
  assert.equal(h.call(IK + "4CalcEv", kb).x0, 1n); assert.deepEqual(calls, ["cancel"]); assert.equal(h.textRequests.length, 0, "no enter callback: the box is not shown");
  h.call(IK + "DC1Ev".replace("DC1", "D1"), kb);   // the destructor clears the registration
  for (let i = 1; i <= 4; i++) assert.equal(h.w0(IK + "10InitializeEPv", 0x1000 * i, 0), 1);
  assert.equal(h.w0(IK + "10InitializeEPv", 0x9000, 0), 1); assert.ok(h.logs.some(l => l.includes("[RED] registration table full")));
  assert.equal(h.call(IK + "4CalcEv", 0x9000).x0, 0n);
  // the request machine busy with a ShowKeyboard: Calc waits and asks afterwards
  const g = new Hle(), k2 = g.alloc(8), str = g.alloc(16), arg = g.alloc(0x500), got: string[] = [];
  g.call(IK + "23SetDecidedEnterCallbackEPFvPKNS0_15DecidedEnterArgEE", k2, g.fn(p => { got.push(Buffer.from(g.read(Number(p), 4)).toString("utf16le")); }));
  let r = g.call("_ZN2nn5swkbd12ShowKeyboardEPNS0_6StringERKNS0_15ShowKeyboardArgE", str, arg); const show = g.last!;
  g.call(IK + "6AppearERKNS0_9AppearArgE", k2, 0);
  r = g.call(IK + "4CalcEv", k2); assert.equal(r.wait!.timeoutNs, 100_000_000n); const calc = g.last!;
  g.host.textAnswer(null); g.last = show; assert.equal(g.resume().x0, 0x29Fn);
  g.onText = () => { g.host.textAnswer("Hi"); };
  g.last = calc; assert.equal(g.resume("timeout").x0, 1n); assert.deepEqual(got, ["Hi"]);
});

// ---------- web ----------
const WS = "_ZN2nn3web17OfflineWebSession";
function page(h: Hle, o: { path?: string; callback?: string; boot?: number } = {}) {
  const arg = h.alloc(0x2000), tl: [number, Buffer][] = [];
  if (o.callback) tl.push([0x3, Buffer.from(o.callback + "\0")]);
  if (o.path !== undefined) tl.push([0x6, Buffer.from(o.path + "\0")]);
  if (o.boot !== undefined) { const b = Buffer.alloc(4); b.writeUInt32LE(o.boot); tl.push([0x41, b]); }
  tl.push([0x1c, Buffer.from([30, 0, 0, 0])]);
  h.dv.setUint16(arg, tl.length, true);
  let at = arg + 8;
  for (const [t, v] of tl) { h.dv.setUint16(at, t, true); h.dv.setUint16(at + 2, v.length, true); h.u8.set(v, at + 8); at += 8 + v.length; }
  return arg;
}
test("web: without a page or a web view the stand-in answers: one empty message, closed when it appears", () => {
  const h = new Hle(), evp = h.alloc(8), rv = h.alloc(0x1018, 0xEE), n = h.alloc(8), buf = h.alloc(16, 0xEE);
  assert.equal(h.w0(WS + "17GetWorkBufferSizeEv"), 0xd0); assert.equal(h.w0("_ZNK2nn3web17OfflineWebSession16NeedsWaitForExitEv", 0), 0);
  assert.equal(h.call(WS + "5StartEPPNS_2os15SystemEventTypeERKNS0_22ShowOfflineHtmlPageArgE", 0, evp, page(h, { path: "menu.htdocs/index.html?x=1", boot: 1 })).x0, 0n);
  const ev = Number(h.u64(evp)); assert.ok(ev !== 0, "the exit event's address through the out pointer");
  const exit = () => h.ev(h.x.hle_event_handle(ev));
  assert.ok(!exit().signaled);
  assert.deepEqual(h.web.opens, [{ path: "menu.htdocs/index.html?x=1", callback: "http://localhost/", hidden: true, delay: 30, pulse: 0 }], "the default callback URL; initially hidden; the key repeat delay");
  assert.equal(h.w0("_ZNK2nn3web17OfflineWebSession16NeedsWaitForExitEv", 0), 1);
  const recv = () => { h.u8.fill(0xEE, buf, buf + 16); const r = h.w0(WS + "24TryReceiveContentMessageEPmPcm", 0, n, buf, 16); return [r, r ? Number(h.u64(n)) : -1, h.cstr(buf, 16)] as [number, number, string]; };
  assert.deepEqual(recv(), [1, 0, ""], "the stand-in's ready message"); assert.equal(recv()[0], 0);
  assert.equal(h.w0(WS + "21TrySendContentMessageEPKcm", 0, h.str("hello"), 5), 1); assert.deepEqual(h.web.sent, [], "nothing to send to");
  assert.equal(h.w0(WS + "6AppearEv", 0), 1);
  assert.ok(exit().signaled, "the stand-in closes at once: the exit event fires");
  assert.equal(h.call(WS + "11WaitForExitEPNS0_26OfflineHtmlPageReturnValueE", 0, rv).x0, 0n);
  const want = Buffer.alloc(0x1018, 0xEE); want.fill(0, 0, 8); want[8] = 0; want.fill(0, 0x1008, 0x1010);
  assert.deepEqual(h.read(rv, 0x1018), want, "exit reason 0 (u64), an empty last URL (one terminator written), its size 0 at +0x1008");
  assert.ok(!exit().signaled, "the session is over: the event is cleared"); assert.equal(h.w0("_ZNK2nn3web17OfflineWebSession16NeedsWaitForExitEv", 0), 0);
  assert.deepEqual(h.web.holds, [], "the stand-in never held the input");
  // the synchronous form fails without the page
  assert.equal(h.call("_ZN2nn3web19ShowOfflineHtmlPageEPNS0_26OfflineHtmlPageReturnValueERKNS0_22ShowOfflineHtmlPageArgE", rv, page(h, { path: "a.html" })).x0, RES_FAIL);
  assert.equal(h.x.hle_web_state(), 0);
  h.call("_ZN2nn3web17OfflineWebSession5StartEPPNS_2os15SystemEventTypeERKNS0_22ShowOfflineHtmlPageArgE", 0, 0, page(h, { path: "../x.html" })); assert.equal(h.web.opens.length, 2, "a path outside the document is not opened");
  h.call(WS + "8FinalizeEv", 0); assert.equal(h.x.hle_web_state(), 0, "Finalize closes a page still open");
  assert.equal(h.call("_ZN2nn3web11ShowWebPageEPNS0_18WebPageReturnValueERKNS0_14ShowWebPageArgE", 0, 0).x0, RES_FAIL);
});

test("web: a page in the embedder's web view: messages both ways, the input held while shown, the exit reason and last URL", () => {
  const h = new Hle().sdk(), evp = h.alloc(8), rv = h.alloc(0x1018, 0xEE), n = h.alloc(8), buf = h.alloc(8, 0xEE);
  h.web.result = 0;
  const START = WS + "5StartEPPNS_2os15SystemEventTypeERKNS0_22ShowOfflineHtmlPageArgE";
  h.call(START, 0, evp, page(h, { path: "pause.htdocs/index.html", callback: "http://localhost/done", boot: 1 }));
  assert.deepEqual(h.web.opens[0], { path: "pause.htdocs/index.html", callback: "http://localhost/done", hidden: true, delay: 30, pulse: 0 });
  assert.deepEqual(h.web.holds, [], "hidden: the game keeps the input");
  h.host.webMessage("end_sound_load"); h.host.webMessage("0123456789");
  assert.equal(h.w0(WS + "24TryReceiveContentMessageEPmPcm", 0, n, buf, 8), 1); assert.equal(h.u64(n), 7n); assert.equal(h.cstr(buf), "end_sou", "cut to the buffer less its terminator; the size is what was copied");
  assert.equal(h.w0(WS + "24TryReceiveContentMessageEPmPcm", 0, n, 0, 0), 1); assert.equal(h.u64(n), 0n, "no buffer: taken, size 0");
  assert.equal(h.w0(WS + "6AppearEv", 0), 1);
  assert.equal(h.web.shows, 1); assert.deepEqual(h.web.holds, [true], "shown: the page holds the input"); assert.deepEqual(h.host.holds, ["web"], "for the reason \"web\" (hid.ts)");
  assert.equal(h.w0(WS + "21TrySendContentMessageEPKcm", 0, h.str("resume\0junk"), 32), 1); assert.deepEqual(h.web.sent, ["resume"], "the C string, at most the size");
  let r = h.call(WS + "11WaitForExitEPNS0_26OfflineHtmlPageReturnValueE", 0, rv);
  assert.ok(r.wait && r.wait.timeoutNs === -1n, "the page is still up: the caller waits");
  r = h.resume("cancelled"); assert.ok(r.wait);
  h.host.webEnded(3, "http://localhost/done?a=1");
  assert.ok(h.ev(r.wait!.handle).signaled); assert.ok(h.ev(h.x.hle_event_handle(Number(h.u64(evp)))).signaled, "the exit event fires");
  assert.deepEqual(h.web.holds, [true, false], "the input is given back"); assert.deepEqual(h.host.holds, []);
  assert.equal(h.resume("signaled").x0, 0n);
  assert.equal(h.u64(rv), 3n); assert.equal(h.cstr(rv + 8), "http://localhost/done?a=1"); assert.equal(h.u64(rv + 0x1008), 26n, "the URL's size with its terminator");
  assert.equal(h.web.closes, 1);
  // shown at once; the game asks it to close (reason 2); a second Start replaces a page
  h.call(START, 0, evp, page(h, { path: "a.html" })); assert.deepEqual(h.web.holds.slice(2), [true]);
  h.call(START, 0, evp, page(h, { path: "b.html" })); assert.equal(h.web.closes, 2); assert.deepEqual(h.web.holds.slice(2), [true, false, true]);
  h.call(WS + "11RequestExitEv", 0); assert.equal(h.x.hle_web_state(), 3);
  h.call(START, 0, evp, page(h, { path: "c0.html", boot: 1 }));  // Start over an ended page
  h.call(START, 0, evp, page(h, { path: "c.html", boot: 1 }));   // and over one that is started and still hidden
  h.host.webFailed("load error"); assert.equal(h.red.length, 1, "the page did not load: the stand-in takes over");
  assert.equal(h.w0(WS + "24TryReceiveContentMessageEPmPcm", 0, n, buf, 8), 1); assert.equal(h.u64(n), 0n, "its empty ready message");
  h.call(WS + "6AppearEv", 0); assert.equal(h.x.hle_web_state(), 3);
  h.call(WS + "11WaitForExitEPNS0_26OfflineHtmlPageReturnValueE", 0, rv); assert.equal(h.u64(rv), 0n); assert.equal(h.u64(rv + 0x1008), 0n);
  // failing while shown ends it; a full queue drops the oldest message
  h.call(START, 0, evp, page(h, { path: "d.html" })); h.host.webFailed("gone"); assert.equal(h.x.hle_web_state(), 3);
  h.call(START, 0, evp, page(h, { path: "e.html" }));
  for (let i = 0; i < 33; i++) h.host.webMessage(`m${i}`);
  h.call(WS + "24TryReceiveContentMessageEPmPcm", 0, n, buf, 8); assert.equal(h.cstr(buf), "m1"); assert.equal(h.red.length, 3);
  h.call(WS + "8FinalizeEv", 0); assert.equal(h.x.hle_web_state(), 0);
  // the synchronous form: shown at once (never hidden), waited for
  r = h.call("_ZN2nn3web19ShowOfflineHtmlPageEPNS0_26OfflineHtmlPageReturnValueERKNS0_22ShowOfflineHtmlPageArgE", rv, page(h, { path: "f.html", boot: 1 }));
  assert.ok(r.wait); assert.equal(h.web.opens.at(-1)!.hidden, false);
  h.host.webEnded(1);
  assert.equal(h.resume().x0, 0n); assert.equal(h.u64(rv), 1n); assert.equal(h.x.hle_web_state(), 0);
});
