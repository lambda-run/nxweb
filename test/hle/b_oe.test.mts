// nn::oe (src/hle/oe.ts, nxnative hle_oe.c). The scenarios of nxnative's dm/host/tests/t_oe.c, in its order, driven
// through hle_call; the concurrent bursts of t_oe.c (child_burst 0-3) are run as their sequential interleavings.
import assert from "node:assert/strict";
import { test, Hle } from "./harness.mts";

const TRYPOP = "_ZN2nn2oe25TryPopNotificationMessageEPj";
function oe(o: { ntf?: boolean } = {}) {
  const h = new Hle(), msg = h.alloc(8);
  const t = {
    h,
    focus: (s: 1 | 2 | 3) => h.host.focusSet(s),
    opmode: (m: 0 | 1) => h.host.setOpmode(m),
    getFocus: () => h.w0("h_oe_GetFocus"), getOp: () => h.w0("h_oe_GetOpMode"), getPerf: () => h.w0("h_oe_GetPerfMode"),
    popIs: (want: number) => { h.dv.setUint32(msg, 999, true); return h.w0(TRYPOP, msg) === 1 && h.u32(msg) === want; },
    empty: () => { h.dv.setUint32(msg, 999, true); return h.w0(TRYPOP, msg) === 0 && h.u32(msg) === 999; },
    ntf: (op: number, perf: number) => { h.call("h_oe_SetOpModeNtf", op); h.call("h_oe_SetPerfModeNtf", perf); },
    enter: () => { const n = h.str("test"); h.x.hle_applet_enter(n); }, leave: () => h.x.hle_applet_leave(),
  };
  if (o.ntf) t.ntf(1, 1);
  return t;
}

test("oe (t_oe): the inactivity extension modes", () => {
  const { h } = oe();
  const mode = () => h.w0("h_oe_InactivityMode"), q = () => h.w0("h_oe_InactivityExtQ");
  assert.deepEqual([mode(), q()], [0, 0], "starts disabled");
  h.call("h_oe_InactivityExtSafe", 1); assert.deepEqual([mode(), q()], [1, 1], "the normal extension is mode 1");
  h.call("h_oe_InactivityExt", 1); assert.deepEqual([mode(), q()], [2, 1], "the unsafe extension is mode 2");
  h.call("h_oe_InactivityExtSafe", 0x100); assert.deepEqual([mode(), q()], [0, 0], "clearing restores mode 0; only bit 0 of the bool counts");
});

test("oe (t_oe): each state notification keeps its first queue position until popped", () => {
  let t = oe();
  assert.ok(t.empty(), "empty queue at start: false, the output left alone");
  t.focus(1); t.opmode(1); assert.ok(t.empty(), "the same state sends no notification");
  t.focus(3); assert.equal(t.getFocus(), 3, "background can be queried before popping");
  assert.ok(t.popIs(15) && t.empty(), "background change: 15 exactly once");
  t.focus(2); t.focus(1);
  assert.ok(t.popIs(15) && t.empty() && t.getFocus() === 1, "unpopped focus lost / resume merged, the final focus is 1");
  t = oe({ ntf: true });
  t.focus(2); t.opmode(0); t.focus(3); t.opmode(1);
  assert.ok(t.popIs(15) && t.popIs(30) && t.popIs(31) && t.empty(), "first positions FIFO = 15, 30, 31; repeats do not move them");
  assert.deepEqual([t.getFocus(), t.getOp(), t.getPerf()], [3, 1, 1], "no stale value: the latest state is queried");
  t = oe({ ntf: true });
  t.opmode(0); t.focus(2); t.opmode(1);
  assert.ok(t.popIs(30) && t.popIs(31) && t.popIs(15) && t.empty(), "mode first: FIFO = 30, 31, 15");
  t = oe({ ntf: true });
  t.focus(2); assert.ok(t.popIs(15), "the focus notification pops first");
  t.opmode(0); t.focus(1);
  assert.ok(t.popIs(30) && t.popIs(31) && t.popIs(15) && t.empty(), "a resume after the pop notifies again, behind the pending mode messages");
  assert.equal(t.getFocus(), 1);
  assert.equal(t.h.red.length, 0);
});

test("oe (t_oe): the notification switches read only the low 8 bits; per-occurrence messages are not merged", () => {
  let t = oe();
  t.opmode(0);
  assert.ok(t.empty() && t.getOp() === 0, "notifications off: only the state changes");
  t.ntf(0x100, 0x101); t.opmode(1);
  assert.ok(t.popIs(31) && t.empty(), "performance alone sends only 31");
  t.ntf(0x101, 0x100); t.opmode(0);
  assert.ok(t.popIs(30) && t.empty(), "operation mode alone sends only 30");
  t = oe();
  t.h.x.hle_notify(16); t.h.x.hle_notify(16);
  assert.ok(t.popIs(16) && t.popIs(16) && t.empty(), "event 16 is kept twice, in order");
  t = oe({ ntf: true }); t.opmode(0);
  assert.ok(t.popIs(30), "of the mode pair 30 pops first");
  t.opmode(1);
  assert.ok(t.popIs(31) && t.popIs(30) && t.empty() && t.getOp() === 1, "popping across a new change: the old 31 keeps its place, 30 is queued again");
});

test("oe (t_oe): bursts across the 32 slots, and the ring wrapping", () => {
  let t = oe({ ntf: true });
  for (let i = 0; i < 17; i++) { t.focus(2); t.focus(1); }
  assert.ok(t.getFocus() === 1 && t.popIs(15) && t.empty(), "34 focus changes: one 15");
  t = oe({ ntf: true });
  for (let i = 0; i < 17; i++) t.opmode((i % 2) as 0 | 1);
  assert.ok(t.getOp() === 0 && t.getPerf() === 0 && t.popIs(30) && t.popIs(31) && t.empty(), "17 mode changes: 30, 31");
  t = oe({ ntf: true });   // two producers interleaved
  for (let i = 0; i < 17; i++) { t.focus(2); t.opmode((i % 2) as 0 | 1); t.focus(1); }
  const seen: number[] = []; for (const m of [15, 30, 31]) if (t.popIs(m)) seen.push(m);
  assert.ok(seen.length === 3 && t.empty() && t.getFocus() === 1 && t.getOp() === 0, "exactly one of each kind, 30 before 31");
  t = oe({ ntf: true });
  let rotated = true;
  for (let i = 0; i < 31; i++) { t.focus((2 - i % 2) as 1 | 2); rotated &&= t.popIs(15) && t.empty(); }
  assert.ok(rotated, "31 pops one at a time move the ring head to the last slot");
  t.focus(1); t.opmode(0); t.focus(3); t.opmode(1);
  assert.ok(t.popIs(15) && t.popIs(30) && t.popIs(31) && t.empty(), "after wrapping still deduplicated in first-seen order");
  t = oe({ ntf: true });   // child_burst(3): a new change after the consumer popped and before it queried
  t.focus(2); assert.ok(t.popIs(15));
  t.focus(1); t.opmode(0);
  assert.ok(t.getFocus() === 1 && t.popIs(15) && t.popIs(30) && t.popIs(31) && t.empty() && t.getOp() === 0 && t.getPerf() === 0, "the new resume is not missed");
  assert.equal(t.h.red.length, 0);
});

test("oe (t_oe): the notification event is bound once and follows the queue", () => {
  const t = oe({ ntf: true }), h = t.h;
  // the SDK's nn::os makes the event: CreateSystemEvent(event, clear mode, inter-process) then GetWritableHandleOfSystemEvent
  const made: { ev: bigint; mode: bigint; ipc: bigint; w: number; r: number }[] = [];
  h.fn((ev, mode, ipc) => { const e = h.host.env.eventNew(); made.push({ ev, mode, ipc, w: e.w, r: e.r }); return 0; }, "_ZN2nn2os17CreateSystemEventEPNS0_15SystemEventTypeENS0_14EventClearModeEb");
  h.fn(ev => made.find(m => m.ev === ev)!.w, "_ZN2nn2os30GetWritableHandleOfSystemEventEPKNS0_15SystemEventTypeE");
  t.focus(2); assert.ok(t.popIs(15));   // before the event exists nothing is signalled
  const ev = h.call("h_oe_GetMsgEv").x0;
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].ev, made[0].mode, made[0].ipc], [ev, 1n, 1n], "auto-clear, inter-process, at the address the call returns");
  assert.equal(h.x.hle_event_handle(Number(ev)), made[0].w);
  const sig = () => h.ev(made[0].w).signaled;
  assert.ok(!sig(), "bound on first use, not signalled while the queue is empty");
  assert.equal(h.call("h_oe_GetMsgEv").x0, ev); assert.equal(made.length, 1, "bound once");
  t.focus(1); assert.ok(sig(), "signalled when a notification is queued");
  assert.ok(t.popIs(15) && !sig(), "cleared when the last notification is popped");
  t.focus(2); t.opmode(0);
  assert.ok(t.popIs(15) && sig(), "still signalled after a pop that leaves notifications queued");
  assert.ok(t.popIs(30) && sig() && t.popIs(31) && !sig(), "cleared only when the queue is empty");
  h.ev(made[0].w).signaled = true;
  assert.ok(t.empty() && !sig(), "a pop from an empty queue clears a signal left behind");
  // a notification queued before the first GetNotificationMessageEvent: the event comes out signalled
  const t2 = oe(); t2.focus(3);
  const ev2 = Number(t2.h.call("h_oe_GetMsgEv").x0);
  assert.equal(t2.h.red.length, 1, "no SDK in this guest: one red line, a host-only event");
  assert.ok(t2.h.ev(t2.h.x.hle_event_handle(ev2)).signaled);
});

test("oe (t_oe): focus handling modes 0 and 3 get no focus notifications, 1 and 2 do", () => {
  const t = oe({ ntf: true }), mode = (m: number) => t.h.call("h_oe_SetFocusMode", m);
  mode(3); t.focus(2); t.focus(3);
  assert.ok(t.empty() && t.getFocus() === 3, "mode 3: nothing queued, the state is still 3");
  t.opmode(0); t.focus(1);
  assert.ok(t.popIs(30) && t.popIs(31) && t.empty() && t.getFocus() === 1, "mode 3: mode notifications still queued, no 15");
  mode(0); t.focus(2); assert.ok(t.empty(), "mode 0: no focus notification");
  mode(2); t.focus(1); assert.ok(t.popIs(15) && t.empty(), "mode 2: 15");
  mode(1); t.focus(2); assert.ok(t.popIs(15) && t.empty(), "mode 1: 15");
});

test("oe (t_oe): a library applet takes the game's focus until it closes; the front end's state is kept apart", () => {
  const t = oe(), front = () => t.h.x.hle_focus_front();
  t.enter(); assert.ok(t.getFocus() === 2 && t.popIs(15) && t.empty(), "applet opens over a game in focus: 15, state 2");
  t.leave(); assert.ok(t.getFocus() === 1 && t.popIs(15) && t.empty(), "applet closes: 15, state 1");
  t.enter(); t.leave();
  assert.ok(t.popIs(15) && t.empty() && t.getFocus() === 1, "an applet answered at once: one 15, queried as 1");
  assert.equal(front(), 1, "an applet leaves the front end's own state alone");
  t.enter(); t.popIs(15);
  t.focus(2); assert.ok(t.empty() && t.getFocus() === 2 && front() === 2, "window loses focus while an applet is open: no change the game sees");
  t.focus(1); assert.ok(t.empty() && t.getFocus() === 2, "window regains focus while an applet is open: still 2");
  t.leave(); assert.ok(t.popIs(15) && t.empty() && t.getFocus() === 1, "then the applet closes: 15, state 1");
  t.enter(); t.popIs(15); t.focus(2); t.leave();
  assert.ok(t.empty() && t.getFocus() === 2, "applet closes while the window is out of focus: still 2, no notification");
  t.focus(1); assert.ok(t.popIs(15) && t.empty() && t.getFocus() === 1, "window regains focus after the applet closed");
  t.enter(); t.popIs(15); t.focus(3);
  assert.ok(t.popIs(15) && t.empty() && t.getFocus() === 3, "background while an applet is open: 15, state 3");
  t.focus(2); t.focus(1); assert.ok(t.popIs(15) && t.empty() && t.getFocus() === 2, "back to the foreground with the applet still open: 15, state 2");
  t.enter(); t.leave(); assert.ok(t.empty() && t.getFocus() === 2, "a nested applet: the outer one keeps the game out of focus");
  t.leave(); assert.ok(t.popIs(15) && t.empty() && t.getFocus() === 1, "the outer applet closes");
  t.h.call("h_oe_SetFocusMode", 3); t.enter();
  assert.ok(t.empty() && t.getFocus() === 2, "focus mode 3: an applet changes the state without a notification");
  t.leave(); assert.ok(t.empty() && t.getFocus() === 1);
  t.leave(); assert.equal(t.h.red.length, 1, "a leave without an enter is a red line (nxnative stops)");
  // every transition of the front end's instance
  const u = oe();
  for (const s of [3, 2, 3, 1, 2, 1] as const) { u.focus(s); assert.equal(u.h.x.hle_focus_front(), s); assert.equal(u.getFocus(), s); }
  u.h.x.hle_focus_set(7); assert.equal(u.h.red.length, 1, "an invalid state is refused in red");
});

test("oe: a take-over that stands for an applet brackets its answer with the focus pair (DM_APPLET)", () => {
  const t = oe(), h = t.h, uid = h.alloc(16);
  assert.equal(h.call("_ZN2nn7account16ShowUserSelectorEPNS0_3UidERKNS0_21UserSelectionSettingsE", uid, 0).x0, 0n);
  assert.ok(t.popIs(15) && t.empty() && t.getFocus() === 1, "one 15 for the round trip, back in focus");
  h.call("_ZN2nn3err9ShowErrorENS_6ResultE", 0x2A2);   // compiled from the C body
  assert.ok(t.popIs(15) && t.empty() && t.getFocus() === 1);
  assert.ok(h.logs.some(l => l === "oe library applet: error"));
});

test("oe: PopNotificationMessage waits on a host event while the queue is empty and is entered again", () => {
  const t = oe(), h = t.h;
  let r = h.call("_ZN2nn2oe22PopNotificationMessageEv");
  assert.ok(r.wait && r.wait.timeoutNs === -1n, "empty queue: wait, no time limit");
  const e = h.ev(r.wait!.handle);
  assert.ok(!e.signaled);
  r = h.resume("cancelled"); assert.ok(r.wait, "woken with nothing queued: waits again");
  t.focus(2);
  assert.ok(e.signaled, "a notification signals what the thread waits on");
  r = h.resume("signaled");
  assert.ok(!r.wait); assert.equal(r.x0, 15n);
  assert.ok(!e.signaled, "cleared with the last message");
  t.focus(1);
  assert.equal(h.call("_ZN2nn2oe22PopNotificationMessageEv").x0, 15n, "a queued message is returned at once");
});

test("oe: operation mode, performance mode and what follows them", () => {
  const h = new Hle();
  const res = (): number[] => { const w = h.alloc(4, 0xAA), ht = h.alloc(4, 0xAA); h.call("h_oe_DefRes", w, ht); return [h.i32(w), h.i32(ht)]; };
  assert.equal(h.w0("h_oe_GetOpMode"), 1, "console unless configured");
  assert.deepEqual(res(), [1920, 1080]);
  assert.equal(h.w0("h_oe_GfxScale"), 1);
  h.host.setOpmode(0);
  assert.deepEqual([h.w0("h_oe_GetOpMode"), h.w0("h_oe_GetPerfMode"), h.w0("h_oe_GfxScale")], [0, 0, 0]);
  assert.deepEqual(res(), [1280, 720]);
  h.call("h_oe_DefRes", 0, 0);   // null outputs are skipped
  assert.equal(h.w0("h_oe_GetPerfCfg", 1), 0x00010001); assert.equal(h.w0("h_oe_GetPerfCfg", 0), 0x00010000);
  const b = new Hle(); b.host.config({ opmode: 0, perfBoost: true });
  assert.deepEqual([b.w0("h_oe_GetOpMode"), b.w0("h_oe_GetPerfMode")], [0, 1], "profile perf_mode boost: Boost whatever the operation mode");
  // CPU overclock: what was set (low 8 bits); auto-sleep sections are counted
  assert.equal(h.w0("h_oe_CpuOc"), 0); h.call("h_oe_SetCpuOc", 0x101); assert.equal(h.w0("h_oe_CpuOc"), 1); h.call("h_oe_SetCpuOc", 0x100); assert.equal(h.w0("h_oe_CpuOc"), 0);
  assert.equal(h.w0("h_oe_NoSleepQ"), 0); h.call("h_oe_NoSleepBegin"); h.call("h_oe_NoSleepBegin"); h.call("h_oe_NoSleepEnd"); assert.equal(h.w0("h_oe_NoSleepQ"), 1);
  h.call("h_oe_NoSleepEnd"); h.call("h_oe_NoSleepEnd"); assert.equal(h.w0("h_oe_NoSleepQ"), 0);
  assert.equal(h.call("_ZN2nn6applet23GetAppletResourceUserIdEv").x0, 0x80n);
  assert.equal(h.w0("_ZN2nn2oe24IsInStoreDemoModeEnabledEv"), 0);
  h.call("h_oe_DemoExit"); h.call("h_oe_DemoExit"); assert.equal(h.red.length, 1, "the demo exit is one red line");
  h.call("h_gs_FrameLength", 2); h.call("h_gs_FrameLength", 2); h.call("h_gs_FrameLength", 3);
  assert.equal(h.logs.filter(l => l.startsWith("gs: graphics frame length mode")).length, 2, "logged on change");
});

test("oe: language code, region, pseudo device id: bytes as nxnative writes them", () => {
  const h = new Hle();
  const code = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return b; };
  assert.deepEqual(code(h.call("h_oe_GetLang").x0), Buffer.from("en-US\0\0\0"));
  assert.equal(h.w0("h_oe_GetRegion"), 1);
  const reg = (lang: string) => { const g = new Hle(); g.host.config({ lang }); return g.w0("h_oe_GetRegion"); };
  assert.deepEqual(["ja", "ko", "zh-Hans", "zh-TW", "en-US", "fr-CA", "es-419", "pt-BR", "en-GB", "fr", "de", "es"].map(reg), [0, 4, 4, 4, 1, 1, 1, 1, 2, 2, 2, 2]);
  const g = new Hle(); g.host.config({ lang: "zh-Hans" });
  assert.deepEqual(code(g.call("h_oe_GetLang").x0), Buffer.from("zh-Hans\0"), "seven characters and the terminator");
  const g2 = new Hle(); g2.host.config({ lang: "abcdefghij" });
  assert.deepEqual(code(g2.call("h_oe_GetLang").x0), Buffer.from("abcdefg\0"), "strncpy of 7");
  const id = h.alloc(24, 0xEE);
  h.call("h_oe_GetDevId", id);
  assert.deepEqual(h.read(id, 24), Buffer.from([0x78, 0x62, 0x6c, 0x00, 0x53, 0x57, 0x4e, 0x41, 0x54, 0x49, 0x56, 0x45, 0x31, 0x30, 0x30, 0x31, 0xEE, 0xEE, 0xEE, 0xEE, 0xEE, 0xEE, 0xEE, 0xEE]));
});

test("oe: the launch parameter is handed over once: the starting program's bytes, else the profile's fields", () => {
  const pop = (h: Hle, n: number) => { const out = h.alloc(8, 0xFF), buf = h.alloc(64, 0xCC); const r = h.w0("h_oe_PopLaunchParam", out, buf, n); return { r, size: h.u64(out), buf: h.read(buf, 64) }; };
  let h = new Hle();
  assert.deepEqual([pop(h, 64).r, pop(h, 64).size], [0, 0n], "none: false, size 0");
  h = new Hle(); h.host.config({ launchSpec: "lang8 f32:0.5 u32:0x10 hex:0aFF u32:7 bogus" });
  let p = pop(h, 64);
  const want = Buffer.concat([Buffer.from("en-US\0\0\0"), Buffer.from(new Float32Array([0.5]).buffer), Buffer.from([0x10, 0, 0, 0, 0x0a, 0xff, 7, 0, 0, 0])]);
  assert.equal(p.r, 1); assert.equal(p.size, BigInt(want.length));
  assert.deepEqual(p.buf.subarray(0, want.length), want); assert.equal(p.buf[want.length], 0xCC, "nothing past the fields");
  assert.equal(h.red.length, 1, "the field that is not understood is red");
  assert.deepEqual([pop(h, 64).r, pop(h, 64).size], [0, 0n], "handed over once");
  h = new Hle(); h.host.config({ launchSpec: "lang8 u32:1" });
  p = pop(h, 5); assert.equal(p.size, 5n, "cut to the buffer"); assert.deepEqual(p.buf.subarray(0, 6), Buffer.from("en-US\xCC", "latin1"));
  h = new Hle(); h.host.config({ launchSpec: "u32:1", launchBytes: new Uint8Array([1, 2, 3, 4, 5]) });
  p = pop(h, 3); assert.deepEqual([p.r, p.size], [1, 3n], "the starting program's bytes win, at most the buffer"); assert.deepEqual(p.buf.subarray(0, 4), Buffer.from([1, 2, 3, 0xCC]));
  h = new Hle(); h.host.config({ launchBytes: new Uint8Array(0) });
  assert.equal(pop(h, 64).r, 0, "started with no parameter");
  assert.equal(h.w0("h_oe_PrevProgram"), 0xFFFFFFFF, "launched from HOME: -1");
  h.host.config({ prevProgram: 2 }); assert.equal(h.w0("h_oe_PrevProgram"), 2);
});
