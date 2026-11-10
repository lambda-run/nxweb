// nn::hid (src/hle/hid.ts, padslots.ts, haptics.ts; port of nxnative dm/host/hle_hid.c, pad_slots.h, hle_haptics.c).
// nxnative's dm/host/tests/t_hid.c and t_haptics.c, ported check for check where the thing checked exists here (the
// embedder's snapshot stands for dm_input_set / dm_pad_set_player / dm_pad_players / dm_joy_* / dm_motion_*), then
// what is new: one snapshot per read, the input hold with reasons, slots by source id, the prompt as a wait.
// Not ported from t_hid.c: t_script and t_rec (DM_KEYS, DM_CTL, DM_REC are not in this port), t_rumble_log
// (DM_RUMBLE_LOG) and t_motion_threads (one thread here).
import assert from "node:assert/strict";
import { test, Hle, status } from "./harness.mts";
import { BTN, type InputSnapshot } from "../../src/glue/hle_host.ts";

const HANDHELD = 0x20, FULLKEY = 1, HH = 2, JOYDUAL = 4, JOYLEFT = 8, JOYRIGHT = 16, JOYDUAL2 = 1 << 12;
const ATTR_CONNECTED = 1, ATTR_WIRED = 2, ATTR_LEFT_CONN = 4, ATTR_LEFT_WIRED = 8, ATTR_RIGHT_CONN = 16, ATTR_RIGHT_WIRED = 32;
const RES_CTRL_CANCELED = 202 | 3101 << 9;
const B = (k: keyof typeof BTN) => Number(BTN[k]);
const NAMES = new Map(status().filter(r => r.file === "hle_hid.c").map(r => [r.cname, r.mangled]));
const STATE: Record<number, string> = { 1: "FullKey", 2: "Handheld", 4: "JoyDual", 8: "JoyLeft", 16: "JoyRight" };

// The hid take-overs by nxnative's identifiers, on one instance
class Hid {
  h: Hle;
  constructor(o: { opmode?: 0 | 1; sdk?: boolean } = {}) { this.h = new Hle(); if (o.sdk !== false) this.h.sdk(); if (o.opmode !== undefined) this.h.host.config({ opmode: o.opmode }); }
  c(cname: string, ...x: (bigint | number)[]) { const n = NAMES.get(cname); if (!n) throw new Error(`no hid take-over ${cname}`); return this.h.call(n, ...x); }
  w(cname: string, ...x: (bigint | number)[]) { return Number(this.c(cname, ...x).x0 & 0xFFFF_FFFFn); }
  id(v: number) { return this.h.u32s([v]); }
  input(p: number, s: InputSnapshot = {}) { return this.h.host.input(p, s); }
  style(id: number) { return this.w("h_hid_GetStyle", this.id(id)); }
  ids(v: number[]) { this.c("h_hid_SetIds", this.h.u32s(v), v.length); }
  styles(m: number) { this.c("h_hid_SetStyles", m); }
  npad(id: number, style: number) {
    const h = this.h, p = h.alloc(0x28 + 32, 0xEE) + 16;
    this.c(`h_hid_State${STATE[style]}`, p, this.id(id));
    assert.ok(h.read(p - 16, 16).every(b => b === 0xEE) && h.read(p + 0x28, 16).every(b => b === 0xEE), "an NpadState is 0x28 bytes");
    assert.equal(h.u32(p + 0x24), 0, "the padding is zero");
    return { sampling: h.i64(p), buttons: Number(h.u64(p + 8)), lx: h.i32(p + 16), ly: h.i32(p + 20), rx: h.i32(p + 24), ry: h.i32(p + 28), attr: h.u32(p + 32) };
  }
  buttons(id: number, style: number) { const s = this.npad(id, style); return s.attr ? s.buttons & 0xffff : 0; }
  lx(id: number) { return this.npad(id, FULLKEY).lx; }
  // ShowControllerSupport(info, arg): [result, player count, selected id]
  ctrl(min: number | null, max = 0, cname = "h_hid_ShowCtrl") {
    const h = this.h, info = h.alloc(8, 0xEE), arg = min === null ? 0 : h.bytes([min & 0xff, max & 0xff, 0, 0, 0, 0, 0, 0]);
    const r = cname === "h_hid_ShowCtrl" ? this.c(cname, info, arg) : this.c(cname, arg);
    return { r, info, done: (x = r) => [Number(x.x0 & 0xFFFF_FFFFn), h.i32(info), h.i32(info + 4)] };
  }
}

test("pad slots (t_hid.c t_slots, pad_slots.h): a source keeps its player across a reconnect, by its stable id", () => {
  const { h } = new Hid(), s = h.host;
  const [A, B2, C, D, KBD] = [0xA001, 0xB002, 0xC003, 0xD004, 1];
  assert.equal(s.padSlot("take", A), 0, "the first controller is player 1");
  assert.equal(s.padSlot("take", B2), 1, "the second controller is player 2");
  assert.equal(s.padSlot("take", A), 0, "taking again keeps the slot");
  assert.equal(s.padSlotMask, 0x3, "two slots held");
  assert.ok(s.padSlot("free", B2) === 1 && s.padSlot("of", B2) < 0, "a disconnected controller frees its slot");
  assert.equal(s.padSlot("take", C), 2, "another controller does not take the slot kept for the one that went away");
  assert.equal(s.padSlot("take", B2), 1, "the same controller reconnected gets its player back");
  assert.equal(s.padSlot("free", A), 0, "player 1's controller goes away");
  assert.equal(s.padSlot("take", D), 0, "a new controller fills player 1 first");
  assert.ok(s.padSlot("free", D) === 0 && s.padSlot("take", A) === 0, "player 1's slot goes back to the source that held it last");
  // nxnative: "back to its name before any other". Here D held it last, so A (which also held it once) gets it as player 1 being free
  for (let i = 0; i < 5; i++) assert.equal(s.padSlot("take", 0x100 + i), 3 + i, "the lowest unused slot");
  assert.equal(s.padSlotMask, 0xff, "every slot held");
  assert.equal(s.padSlot("take", 0x999), -1, "a ninth controller gets no player");
  assert.ok(s.padSlot("take", 0) === -1 && s.padSlot("free", 0) === -1, "no source id, no slot");
  // the keyboard holds player 1 for good (nxnative DM_KBD_PLAYER=own)
  const k = new Hid().h.host;
  assert.ok(k.padSlot("take", KBD) === 0 && k.padSlot("take", A) === 1, "with the keyboard on its own the first controller is player 2");
  // press to join (nxnative DM_PAD_PRESS_TO_JOIN): the lowest free slot, whatever slot the source held before
  const q = new Hid().h.host;
  assert.equal(q.padSlot("takeLowest", 11), 0, "press: the first to press is player 1");
  assert.equal(q.padSlot("takeLowest", 12), 1, "press: the next is player 2");
  assert.equal(q.padSlot("takeLowest", 11), 0, "press: pressing again keeps the slot");
  q.padSlot("free", 11);
  assert.equal(q.padSlot("takeLowest", 13), 0, "press: a freed player 1 goes to whoever presses next");
  const f = new Hid().h.host;
  for (let i = 0; i < 8; i++) f.padSlot("takeLowest", 50 + i);
  assert.equal(f.padSlot("takeLowest", 60), -1, "press: none left when every player is held");
  assert.equal(f.padSlot("takeLowest", 0), -1, "press: no source id, no slot");
});

test("pad slots: a snapshot with a source id takes and frees its player; two controllers of one model do not trade places", () => {
  const t = new Hid(), s = t.h.host;
  // two pads of the same model: nxnative knows them by one name; here each has its id
  assert.equal(t.input(-1, { sourceId: 7001, buttons: BTN.A }), 0);
  assert.equal(t.input(-1, { sourceId: 7002, buttons: BTN.B }), 1);
  assert.equal(t.style(1), FULLKEY, "the second source is player 2 on No2");
  assert.equal(t.buttons(1, FULLKEY), B("B"));
  assert.equal(t.input(-1, { sourceId: 7001, connected: false }), 0, "the first goes away: its slot is told");
  assert.equal(t.input(-1, { sourceId: 7002, connected: false }), 1);
  assert.equal(t.style(1), 0, "a disconnected player's npad is gone");
  assert.equal(t.input(-1, { sourceId: 7002, buttons: BTN.X }), 1, "the second comes back first and is player 2 again");
  assert.equal(t.input(-1, { sourceId: 7001, buttons: BTN.Y }), 0, "the first is player 1 again");
  assert.equal(t.buttons(0, FULLKEY), B("Y") | B("A"), "with the press nobody read before it went away, still latched"); assert.equal(t.buttons(0, FULLKEY), B("Y"));
  assert.equal(t.buttons(1, FULLKEY), B("X"));
  assert.equal(t.input(-1, { sourceId: 7009, connected: false }), -1, "a source that holds no slot frees none");
  assert.equal(t.input(-1, { sourceId: 0 }), -1); assert.equal(t.input(8, {}), -1, "there is no player 9");
  assert.equal(s.padSlotMask, 3);
});

test("npads (t_hid.c t_npads): players, supported ids, the style event, the applet, handheld", () => {
  const t = new Hid(), h = t.h;
  assert.ok(t.style(0) === FULLKEY && t.style(1) === 0 && t.style(HANDHELD) === 0, "one player: No1 only");
  assert.deepEqual([0, 1, 7].map(p => h.host.playerNpad(p)), [0, 1, 7], "player n on No n docked");
  t.input(0, { buttons: BTN.X | BTN.A, lx: -200 });
  assert.ok(t.buttons(0, FULLKEY) === (B("X") | B("A")) && t.lx(0) === -200, "player 1's snapshot (the embedder ORs its keyboard and controller into it)");
  t.input(0); t.buttons(0, FULLKEY);

  // two controllers: player 2 on No2 with its own input, the style event of No2 signalled
  const ev1 = h.alloc(0x40);
  t.c("h_hid_BindStyleEv", t.id(1), ev1, 0);
  const e1 = () => h.ev(h.created[0].w);
  assert.equal(h.created.length, 1); assert.equal(e1().signals, 0, "no signal on binding an npad with no controller");
  t.input(1);
  assert.equal(e1().signals, 1, "No2's style event signalled when player 2's controller connects");
  assert.equal(t.style(1), FULLKEY, "player 2 is a full-key controller on No2");
  t.input(1, { buttons: BTN.B, lx: 300 }); t.input(0, { buttons: BTN.Y });
  assert.equal(e1().signals, 1, "a snapshot of a connected player is no connection");
  assert.ok(t.buttons(1, FULLKEY) === B("B") && t.lx(1) === 300, "player 2 reads its own controller");
  assert.ok(t.buttons(0, FULLKEY) === B("Y") && t.lx(0) === 0, "player 1 does not see player 2");
  assert.equal(t.buttons(1, HH), 0, "player 2 is not a handheld controller");
  assert.deepEqual([0, 1, 7, HANDHELD, 0x10].map(i => t.w("h_hid_Led", t.id(i))), [0x1, 0x3, 0x6, 1, 1], "player LED patterns");
  let c = t.ctrl(1, 4);
  assert.deepEqual(c.done(), [0, 2, 0], "the controller applet reports two players, player 1 selected");
  assert.equal(h.logs.filter(l => l === "oe library applet: controller support").length, 1); assert.equal(h.x.hle_focus_seen(), 1, "the applet opens and closes once around its answer (focus 2, then 1)");
  assert.deepEqual(h.logs.filter(l => l.startsWith("oe focus state")), ["oe focus state -> 2 (library applet open)", "oe focus state -> 1 (library applet closed)"]);
  assert.equal(t.ctrl(1, 1).done()[1], 1, "the applet's count is capped at the game's maximum");
  assert.deepEqual(t.ctrl(3, 4).done(), [RES_CTRL_CANCELED, 2, 0], "fewer players than the game's minimum: canceled (2202-3101), as the player closing the applet");
  assert.equal(t.ctrl(3, 4, "h_hid_ShowCtrl0").done()[0], RES_CTRL_CANCELED, "the overload without a result: canceled too");
  assert.equal(t.ctrl(2, 4, "h_hid_ShowCtrl0").done()[0], 0, "the overload without a result: OK when the minimum is met");
  assert.deepEqual(h.prompts, [{ min: 3, max: 4 }, { min: 3, max: 4 }], "below the minimum the front end's prompt is asked, with the game's minimum and maximum");
  assert.match(h.logs.findLast(l => l.includes("too few"))!, /^hid controller applet: 3 to 4 players wanted, 2 connected: too few, closed as the player would \(canceled\)$/);
  {   // with a window the prompt waits for players to join
    h.promptWindow = true;
    h.onPrompt = () => { t.input(2); h.host.ctrlAnswer(true); };   // answered inside the import
    assert.deepEqual(t.ctrl(3, 4).done(), [0, 3, 0], "a third player joins while the prompt is up: OK with three");
    t.input(2, { connected: false });
    h.onPrompt = () => { h.host.ctrlAnswer(true); };
    assert.deepEqual(t.ctrl(3, 4).done(), [RES_CTRL_CANCELED, 2, 0], "the prompt done with fewer than the minimum: canceled all the same");
    h.onPrompt = () => { t.input(2); h.host.ctrlAnswer(false); };
    assert.deepEqual(t.ctrl(3, 4).done(), [RES_CTRL_CANCELED, 3, 0], "the player closes the prompt (B): canceled, whoever joined");
    t.input(2, { connected: false }); h.onPrompt = null;
    const calls = h.prompts.length;
    h.host.config({ inputScripted: true });
    assert.equal(t.ctrl(3, 4).done()[0], RES_CTRL_CANCELED); assert.equal(h.prompts.length, calls, "scripted input: no prompt, canceled at once");
    h.host.config({ inputScripted: false });
    assert.equal(t.ctrl(2, 4).done()[0], 0); assert.equal(h.prompts.length, calls, "the minimum met: no prompt");
    h.promptWindow = false;
  }
  assert.ok(t.w("h_hid_Strap") === 0 && t.w("h_hid_StrapArg", 0) === 0, "both strap guide overloads answer as the player closing the guide");
  assert.equal(h.x.hle_focus_seen(), 1, "every answer opened and closed its applet");
  const six = (handle: number) => { const o = h.alloc(0x60); return t.w("h_hid_SixStates", o, 1, t.id(handle)); };
  assert.ok(six(0x0100 | 0) === 1 && six(0x0200 | 0) === 0, "player 2 has a six-axis sensor, No3 none");

  // a one-player game ({No1, Handheld}): player 2's controller plays as player 1, No2 reads as not connected
  const before = e1().signals; t.ids([0, HANDHELD]);
  assert.equal(e1().signals, before + 1, "No2's style event signalled when the game stops supporting it");
  assert.ok(t.style(1) === 0 && t.buttons(1, FULLKEY) === 0, "No2 not reported");
  assert.ok(t.buttons(0, FULLKEY) === (B("Y") | B("B")) && t.lx(0) === 300, "player 2's controller feeds player 1");
  assert.equal(t.ctrl(null).done()[1], 1, "the applet reports one player");
  assert.ok(h.logs.includes("hid: player 2's controller feeds player 1: the game supports one player (no npad 1)"));

  // a four-player game: a fifth controller is not used, nor merged into player 1
  t.ids([0, 1, 2, 3, HANDHELD]);
  for (let p = 1; p <= 3; p++) t.input(p); t.input(4, { buttons: BTN.ZR });
  assert.ok(t.style(3) === FULLKEY && t.style(4) === 0, "players 1..4 reported, player 5 not");
  assert.ok(!(t.buttons(0, FULLKEY) & B("ZR")), "player 5 does not feed player 1 in a game for four");
  assert.equal(t.ctrl(null).done()[1], 4, "the applet reports four players");
  assert.ok(h.logs.includes("hid: player 5's controller is not used: the game supports no npad 4"));

  // player 2 goes away: No2 disconnected, its input released
  for (let p = 1; p <= 4; p++) t.input(p, { connected: false });
  assert.equal(t.style(1), 0); t.input(1); assert.equal(t.buttons(1, FULLKEY), 0, "a disconnected player's npad and input are cleared");

  // handheld mode: player 1 on Handheld, player 2 on No2 (No1 stays empty)
  h.host.setOpmode(0); t.input(1, { buttons: BTN.L });
  assert.deepEqual([h.host.playerNpad(0), h.host.playerNpad(1)], [HANDHELD, 1], "handheld: player 1 on Handheld, player 2 on No2");
  assert.deepEqual([t.style(HANDHELD), t.style(0), t.style(1)], [HH, 0, FULLKEY], "handheld styles");
  assert.ok(t.buttons(HANDHELD, HH) === B("Y") && t.buttons(1, FULLKEY) === B("L"), "handheld: each player its own input");
  assert.deepEqual(t.ctrl(null).done(), [0, 2, HANDHELD], "handheld: the applet selects the handheld controller");
  assert.equal(t.npad(HANDHELD, HH).attr, ATTR_CONNECTED | ATTR_WIRED | ATTR_LEFT_CONN | ATTR_LEFT_WIRED | ATTR_RIGHT_CONN | ATTR_RIGHT_WIRED, "the handheld controller is wired, both halves");
  assert.equal(t.npad(1, FULLKEY).attr, ATTR_CONNECTED | ATTR_LEFT_CONN | ATTR_RIGHT_CONN);
  assert.deepEqual(h.red, []);
});

test("the controller applet's prompt is a wait: the calling thread parks until the embedder answers; one prompt at a time", () => {
  const t = new Hid(), h = t.h;
  h.promptWindow = true;
  const first = t.ctrl(2, 4);
  assert.ok(first.r.wait, "too few players and a window: the call waits"); assert.equal(first.r.wait!.timeoutNs, -1n);
  const pend = h.last!;
  assert.equal(h.x.hle_ctrl_state(), 1, "Asking"); assert.equal(h.x.hle_focus_seen(), 2, "the game is out of focus while the applet is open");
  // a second thread's applet finds the prompt busy and looks again later
  const second = t.ctrl(2, 4);
  assert.equal(second.r.wait!.timeoutNs, 100000000n); const pend2 = h.last!;
  assert.equal(h.prompts.length, 1, "one prompt");
  // a spurious wake changes nothing
  h.last = pend; let r = h.resume("timeout"); assert.ok(r.wait, "not answered yet: waits again");
  const pendAgain = h.last!;
  t.input(1);
  assert.ok(h.host.ctrlAnswer(true)); assert.ok(h.ev(first.r.wait!.handle).signaled, "the answer wakes the waiting call");
  assert.ok(!h.host.ctrlAnswer(true), "a second answer finds no prompt"); assert.equal(h.red.length, 1);
  h.last = pendAgain; r = h.resume("signaled");
  assert.deepEqual(first.done(r), [0, 2, 0], "OK with two players");
  assert.match(h.logs.findLast(l => l.includes("the prompt waited"))!, /^hid controller applet: 2 to 4 players wanted, 1 connected: the prompt waited, 2 now \(OK\)$/);
  h.last = pend2; r = h.resume("timeout");
  assert.deepEqual(second.done(r), [0, 2, 0], "the second applet now finds two players and asks nobody");
  assert.equal(h.prompts.length, 1); assert.equal(h.x.hle_focus_seen(), 1); assert.equal(h.x.hle_ctrl_state(), 0);
});

test("Joy-Cons (t_hid.c t_joycons): dual, single assignment, the split by the applet, rail buttons, vibration handles", () => {
  const t = new Hid(), h = t.h;
  t.ids([0, 1, 2, 3]);
  t.styles(FULLKEY | JOYDUAL | JOYLEFT | JOYRIGHT);
  assert.equal(t.style(0), FULLKEY, "no Joy-Con reported: player 1 is full-key, as before");
  h.host.haptics({ output: true });
  const mounted = (handle: number) => t.w("h_hid_VibMounted", t.id(handle));
  const info = (handle: number) => { const p = h.alloc(8); t.c("h_hid_VibInfo", p, t.id(handle)); return [h.u32(p), h.u32(p + 4)]; };
  t.input(0, { rumble: true });
  assert.deepEqual(info(0x0003), [1, 1], "and its full-key vibration handle reaches it (motor 0)");
  const ev = h.alloc(0x40); t.c("h_hid_BindStyleEv", t.id(0), ev, 0);
  const signals = () => h.ev(h.created[0].w).signals, s0 = signals();
  const pair: InputSnapshot = { rumble: true, joyLeft: { buttons: BTN.Up | BTN.LSL, stick: [-20000, 0] }, joyRight: { buttons: BTN.A | BTN.RSR, stick: [0, 15000] } };
  t.input(0, pair);
  assert.ok(signals() > s0 && t.style(0) === JOYDUAL, "a left and a right Joy-Con on player 1: one JoyDual npad, the style event signalled");
  const s1 = signals(); t.input(0, pair); assert.equal(signals(), s1, "the same halves again: no event");
  let st = t.npad(0, JOYDUAL);
  const all = B("Up") | B("A") | B("LSL") | B("RSR");
  assert.equal(st.buttons & all, all, "JoyDual: both Joy-Cons' buttons, the rail buttons kept");
  assert.ok(st.lx === -20000 && st.ry === 15000 && st.attr === (ATTR_CONNECTED | ATTR_LEFT_CONN | ATTR_RIGHT_CONN), "JoyDual: each Joy-Con's stick on its side, both halves connected");
  assert.equal(st.buttons & (1 << 16), 1 << 16, "the left stick's direction bit"); assert.equal(st.buttons & 0xf0000000, 0);
  const hs = h.alloc(16, 0xEE);
  assert.equal(t.w("h_hid_VibHandles", hs, 2, t.id(0), JOYDUAL), 2); assert.deepEqual([h.u32(hs) & 0xff, h.u32(hs + 4)], [5, h.u32(hs) | 1 << 16], "JoyDual vibration handles: type 5, a motor per Joy-Con");
  assert.deepEqual(info(h.u32(hs + 4)), [1, 2], "the right Joy-Con's JoyDual handle reaches motor 1");
  assert.deepEqual([info(0x10003), info(0x0003)], [[1, 2], [1, 1]], "the full-key handles the game got before the pair connected still reach both Joy-Cons");

  // the game supports no Joy-Con style: the pad's merged state as full-key, as before
  t.styles(FULLKEY); assert.equal(t.style(0), FULLKEY, "no Joy-Con style supported: full-key");
  t.styles(FULLKEY | JOYDUAL | JOYLEFT | JOYRIGHT);

  // single assignment: the left Joy-Con stays on No1, the right one takes No2 (no player of its own there)
  t.c("h_hid_JoySingle", t.id(0));
  assert.deepEqual([t.w("h_hid_GetJoyAssign", t.id(0)), t.style(0), t.style(1)], [1, JOYLEFT, JOYRIGHT], "single: JoyLeft on No1, JoyRight on No2");
  st = t.npad(1, JOYRIGHT);
  assert.ok((st.buttons & (B("A") | B("RSR"))) === (B("A") | B("RSR")) && !(st.buttons & B("Up")) && st.ry === 15000 && st.lx === 0 && st.attr === (ATTR_CONNECTED | ATTR_RIGHT_CONN), "the right half on No2: its own buttons and stick only");
  assert.equal(t.w("h_hid_VibHandles", hs, 2, t.id(1), JOYRIGHT), 1); assert.equal(h.u32(hs) & 0xff, 7, "JoyRight: one vibration handle, type 7");
  assert.deepEqual(info(h.u32(hs)), [1, 2], "it reaches player 1's right motor, on No2");
  const other = h.u32s([9]);
  assert.equal(t.w("h_hid_JoySingleOut", other, t.id(0), 0), 1); assert.equal(h.u32(other), 1, "single assignment with the other half: No2");
  assert.equal(h.host.playersReported, 2, "a split pair is two players");
  t.c("h_hid_JoyDual", t.id(0));
  assert.deepEqual([t.style(0), t.style(1), t.w("h_hid_GetJoyAssign", t.id(0))], [JOYDUAL, 0, 0], "dual again: one JoyDual npad, No2 empty");
  // keeping the right one: it stays on No1 and the left one goes to No2
  t.c("h_hid_JoySingleT", t.id(0), 1);
  assert.deepEqual([t.style(0), t.style(1)], [JOYRIGHT, JOYLEFT]); assert.equal(t.npad(1, JOYLEFT).lx, -20000);
  t.c("h_hid_JoyDual", t.id(0));
  assert.ok(h.logs.includes("hid: npad 0: single Joy-Con assignment (right)") && h.logs.includes("hid: npad 0: dual Joy-Con assignment"));

  // the controller applet asks for two players with one pair connected: it splits the pair
  const calls = h.prompts.length;
  assert.deepEqual(t.ctrl(2, 4).done(), [0, 2, 0]); assert.equal(t.style(1), JOYRIGHT, "the applet splits the pair for a second player");
  assert.ok(h.prompts.length === calls && h.host.playersReported === 2, "the split pair is enough: no controller prompt");
  t.c("h_hid_JoyDual", t.id(0));
  // no npad for the other half: the split is undone and the applet is canceled
  t.ids([0]);
  assert.deepEqual(t.ctrl(2, 4).done(), [RES_CTRL_CANCELED, 1, 0]); assert.equal(t.w("h_hid_GetJoyAssign", t.id(0)), 0, "a split with no npad to go to is taken back");
  t.ids([0, 1, 2, 3]);

  // handheld mode: player 1's Joy-Cons count as attached to the console, and are never split
  h.host.setOpmode(0); t.ids([0, 1, HANDHELD]);
  assert.ok(t.style(HANDHELD) === HH && t.style(0) === 0, "handheld: player 1's Joy-Cons are the Handheld npad");
  h.host.setOpmode(1); t.ids([0, 1, 2, 3]);

  // one Joy-Con alone on player 2: JoyRight on No2; leaving: full-key again
  t.input(1, { joyRight: { buttons: BTN.B } });
  assert.equal(t.style(1), JOYRIGHT, "one right Joy-Con alone: JoyRight on its own npad");
  assert.equal(t.npad(1, JOYRIGHT).buttons & 0xffff, B("B"));
  t.input(1); t.input(0);
  assert.deepEqual([t.style(0), t.style(1)], [FULLKEY, FULLKEY], "no Joy-Con reported any more: full-key controllers, as before");
  // a Joy-Con's short press is latched like a pad's
  t.input(1, { joyLeft: { buttons: BTN.Left } }); t.input(1, { joyLeft: {} });
  assert.equal(t.npad(1, JOYLEFT).buttons & 0xffff, B("Left")); assert.equal(t.npad(1, JOYLEFT).buttons & 0xffff, 0);
  assert.deepEqual(h.red, []);
});

test("Joy-Con 2 mouse sensor and pointer (t_hid.c t_jcms and its Nmouse block): rings, handles, the pointer state, the Joy-Con 2 styles", () => {
  const t = new Hid(), h = t.h;
  t.ids([0, 1]);
  const J = (o: InputSnapshot = {}): InputSnapshot => ({ joyLeft: {}, joyRight: {}, ...o });
  t.input(0, J());
  const hl = t.w("h_hid_JcmsHandle", t.id(0), t.id(0)), hr = t.w("h_hid_JcmsHandle", t.id(0), t.id(1));
  const st = h.alloc(32 * 4 + 32, 0xFF) + 16;
  const states = (handle: number, n = 4) => { h.u8.fill(0xFF, st - 16, st + 32 * 4 + 16); return t.w("h_hid_JcmsStates", st, n, t.id(handle)); };
  const f = (i: number) => ({ unk0: h.i64(st + 32 * i), sampling: h.i64(st + 32 * i + 8), dx: h.i32(st + 32 * i + 16), dy: h.i32(st + 32 * i + 20), attr: h.u32(st + 32 * i + 24), pad: h.u32(st + 32 * i + 28) });
  assert.ok(hl === 0x000 && hr === 0x100 && states(hr) === 0, "no mouse samples before a front end reports them");
  assert.equal(h.host.x.hle_joy_mouse_wanted(), 0, "the sensors stay off until the game sets them up");
  t.c("h_hid_JcmsInit", 0, 0); assert.equal(h.host.x.hle_joy_mouse_wanted(), 1, "InitializeJcms asks for the sensors");
  t.c("h_hid_NmouseInit", 0, 0, 1920, 1080); t.c("h_hid_JcmsFini"); assert.equal(h.host.x.hle_joy_mouse_wanted(), 1, "the pointer still wants them after FinalizeJcms");
  t.c("h_hid_NmouseFini"); assert.equal(h.host.x.hle_joy_mouse_wanted(), 0, "off again once both are finalized");
  assert.deepEqual(h.mouseWanted, [true, false], "the embedder is told at each change");
  const mouse = (side: "joyLeft" | "joyRight", dx: number, dy: number, onSurface = true) => t.input(0, J({ [side]: { mouse: { dx, dy, onSurface } } }));
  mouse("joyRight", 5, -3); mouse("joyRight", 7, 2);
  assert.equal(states(hr), 2);
  assert.deepEqual([f(0), f(1)], [{ unk0: 0n, sampling: 2n, dx: 7, dy: 2, attr: 3, pad: 0 }, { unk0: 0n, sampling: 1n, dx: 5, dy: -3, attr: 3, pad: 0 }], "the right Joy-Con's samples, newest first");
  assert.equal(h.u8[st + 64], 0xFF, "two states written, no more");
  assert.equal(states(hl), 0, "the left Joy-Con has reported none");
  h.u8.fill(0xFF, st, st + 64); t.c("h_hid_JcmsState", st, t.id(hr));
  assert.deepEqual(f(0), { unk0: 0n, sampling: 2n, dx: 7, dy: 2, attr: 3, pad: 0 }, "GetJcmsState: the newest"); assert.equal(h.u8[st + 32], 0xFF);
  h.u8.fill(0xFF, st, st + 64); t.c("h_hid_JcmsState", st, t.id(hl)); assert.ok(h.read(st, 32).every(b => b === 0), "no sensor: a cleared state");
  for (let i = 0; i < 40; i++) t.input(0, J({ joyRight: { mouse: { dx: i, dy: 0, onSurface: false } } }));
  assert.equal(states(hr), 4); assert.deepEqual([f(0).dx, f(3).dx, f(0).attr], [39, 36, 1], "a full ring keeps the newest");
  assert.equal(states(hr, 40), 16, "at most the ring");
  assert.equal(states(0x200), 0, "a JcmsType past 1 has no states"); assert.equal(t.w("h_hid_JcmsStates", st, 4, 0), 0);
  // the pointer: a handle per Joy-Con whose sensor reports, the one last used on a surface first, kept first while lifted
  const nh = h.alloc(32), handles = () => { const n = t.w("h_hid_NmouseHandles", nh, 4, 0); return Array.from({ length: n }, (_, i) => h.u64(nh + 8 * i)); };
  let hh = handles(); assert.ok(hh.length === 1 && hh[0] === 0x4e4d0001n, "one pointer handle: the right Joy-Con, the only one that reported");
  mouse("joyLeft", 1, 1);
  hh = handles(); assert.deepEqual(hh, [0x4e4d0000n, 0x4e4d0001n], "the left Joy-Con, last on a surface, comes first");
  mouse("joyLeft", 0, 0, false);
  assert.equal(handles()[0], 0x4e4d0000n, "it stays first while lifted");
  // NmouseState, 48 bytes: the pointer starts in the middle of 1920x1080 and moves a quarter pixel per count
  const ns = h.alloc(48 + 32, 0xEE) + 16;
  t.input(0, J({ joyLeft: { buttons: BTN.L | BTN.ZL, mouse: { dx: 10, dy: -22, onSurface: false } } }));
  assert.equal(t.w("h_hid_NmouseState", ns, hh[0]), 1);
  const exp = Buffer.alloc(48); exp.writeBigInt64LE(3n, 8); exp.writeInt32LE(963, 16); exp.writeInt32LE(535, 20); exp.writeInt32LE(2, 24); exp.writeInt32LE(-6, 28); exp.writeUInt32LE(3, 40); exp.writeUInt32LE(2, 44);
  assert.deepEqual(h.read(ns, 48), exp, "its state: sample 3, at (960.25 + 2.5, 540.25 - 5.5) rounded, moved (2, -6) (ties to even), L and ZL, connected, off the surface");
  assert.ok(h.read(ns - 16, 16).every(b => b === 0xEE) && h.read(ns + 48, 16).every(b => b === 0xEE));
  assert.equal(t.w("h_hid_NmouseState", ns, 0), 0, "the merged handle has none"); assert.equal(t.w("h_hid_NmouseState", 0, hh[0]), 0);
  assert.equal(t.w("h_hid_NmousePos", hh[0], 100, 200), 1); t.c("h_hid_NmouseState", ns, hh[0]); assert.deepEqual([h.i32(ns + 16), h.i32(ns + 20)], [100, 200], "SetNmousePointerPosition moves a Joy-Con's pointer");
  // the Joy-Con 2 styles: a Joy-Con 2 pair shows JoyDual's Joy-Con 2 form to a game that supports only that
  t.styles(JOYDUAL2); t.input(0, J({ joyCon2: true }));
  assert.equal(t.style(0) & (JOYDUAL | JOYDUAL2), JOYDUAL | JOYDUAL2, "a Joy-Con 2 pair: JoyDual with its Joy-Con 2 bit");
  t.input(0, J()); assert.equal(t.style(0) & JOYDUAL2, 0, "a plain pair: no Joy-Con 2 bit");
  t.styles(0xffffffff); t.input(0);

  // Nmouse with no device (SDK 21's forms)
  const wh = h.alloc(8), std = h.alloc(8, 0x07), npad = h.u32s([9]), merged = h.alloc(8, 0x01);
  t.c("h_hid_NmouseInitT", 0, 0, 1920, 1080, 1); t.c("h_hid_NmouseGetRange", wh, wh + 4);
  assert.deepEqual([h.i32(wh), h.i32(wh + 4)], [1920, 1080], "InitializeNmouse with a pointer type keeps the range");
  t.c("h_hid_NmouseSetRange", 1280, 720); t.c("h_hid_NmouseGetRange", wh, wh + 4);
  assert.deepEqual([h.i32(wh), h.i32(wh + 4)], [1280, 720], "SetNmousePointerRanges is what GetNmousePointerRanges reads");
  assert.ok(t.w("h_hid_NmouseStd", std) === 0 && h.u8[std] === 7, "no standard mouse handle");
  assert.ok(t.w("h_hid_NmouseMerged", merged) === 1 && h.u64(merged) === 0n, "the merged handle is 0");
  assert.ok(t.w("h_hid_NmouseEnable", 0, 0x101) === 1 && t.w("h_hid_NmousePos", 0, 10, 10) === 1, "the merged handle takes the pointer settings");
  assert.ok(t.w("h_hid_NmouseEnable", 5, 1) === 0 && t.w("h_hid_NmousePos", 5, 0, 0) === 0, "an unknown handle does not");
  assert.ok(t.w("h_hid_NmouseNpad", npad, 0) === 0 && h.u32(npad) === 9, "no controller behind the merged handle");
  const sp = t.c("h_hid_MouseSpeed"); assert.equal(sp.d0, 0x3f800000n, "the mouse pointer speed setting: 1.0f in d0");
  assert.deepEqual(h.red, []);
});

const V = (h: Hle, v: number[]) => h.f32s(v);
test("vibration (t_hid.c t_vibration): handles, routing, the values forwarded to the embedder, merged players, handheld, the rumble switch", () => {
  const t = new Hid(), h = t.h;
  const hs = h.alloc(16), id0 = t.id(0), v = V(h, [0.25, 160, 0.5, 320]);
  const handles = (n: number, id: number, style: number) => t.w("h_hid_VibHandles", hs, n, id, style);
  const permit = () => t.w("h_hid_VibPermit"), H0 = () => h.u32(hs), H1 = () => h.u32(hs + 4);
  const actual = (handle: number) => { const p = h.alloc(16 + 32, 0xEE) + 16; t.c("h_hid_VibActual", p, t.id(handle)); assert.ok(h.read(p + 16, 16).every(b => b === 0xEE)); return [0, 4, 8, 12].map(o => h.f32(p + o)); };
  const last = (p: number) => h.vibrations.findLast(s => s.player === p)!;
  t.ids([0, 1, HANDHELD]); t.input(1);
  assert.ok(!permit() && !handles(2, id0, FULLKEY), "no sink: no vibration devices");
  h.host.haptics({ output: true });
  assert.equal(h.vibrations.length, 8, "the sink gets every player's idle state at once");
  assert.deepEqual(h.vibrations[3], { player: 3, epoch: 2n /* SetSupportedNpadIdType cleared every player once before */, motors: [{ amplitudeLow: 0, frequencyLow: 160, amplitudeHigh: 0, frequencyHigh: 320 }, { amplitudeLow: 0, frequencyLow: 160, amplitudeHigh: 0, frequencyHigh: 320 }] });
  assert.ok(!permit() && handles(2, id0, FULLKEY) === 2, "startup handles do not wait for a routed haptics output");
  assert.equal(t.w("h_hid_VibMounted", hs), 0, "no routed output: device not mounted");
  t.c("h_hid_SendVib", hs, v);
  assert.deepEqual(actual(H0()), [0, 160, 0, 320], "a value before routing is not retained");
  t.input(0, { rumble: true }); t.input(1, { rumble: true });
  t.c("h_hid_SendVib", hs, v);
  assert.deepEqual(last(0).motors[0], { amplitudeLow: 0.25, frequencyLow: 160, amplitudeHigh: 0.5, frequencyHigh: 320 }, "cached startup handles reach an output routed later");
  assert.ok(permit() && handles(2, id0, FULLKEY) === 2, "two vibration motors available");
  assert.deepEqual([H0(), H1()], [3, 0x10003], "SDK vibration handle bytes: style 3, npad 0, motors 0 and 1");
  assert.equal(handles(2, id0, HH), 0, "wrong controller style gets no motors");
  assert.equal(handles(2, t.id(2), FULLKEY), 0, "disconnected player gets no motors");
  assert.equal(handles(1, id0, FULLKEY), 1, "handle count respects caller capacity");
  assert.equal(handles(0, id0, FULLKEY), 0); assert.equal(t.w("h_hid_VibHandles", 0, 2, id0, FULLKEY), 0); assert.equal(t.w("h_hid_VibHandles", hs, 2, 0, FULLKEY), 0);
  handles(2, id0, FULLKEY);
  t.c("h_hid_SendVib", hs, v);
  assert.deepEqual(actual(H0()), [0.25, 160, 0.5, 320]); assert.equal(last(1).motors[0].amplitudeLow, 0, "game value is retained for the addressed player only");
  const info = h.alloc(8); t.c("h_hid_VibInfo", info, hs + 4); assert.deepEqual([h.u32(info), h.u32(info + 4)], [1, 2], "right motor is a right LRA");
  assert.ok(t.w("h_hid_VibMounted", hs) && t.w("h_hid_VibMounted", hs + 4), "both motors of a routed controller are mounted");
  assert.ok(t.w("h_hid_VibMountedOunce", hs) && t.w("h_hid_VibMountedOunce", hs + 4) && !t.w("h_hid_VibMountedOunce", 0), "the Switch 2's form answers the same");
  const invalid = [0, 0x20003, 0x1000003, 0x203];
  assert.ok(invalid.every(x => !t.w("h_hid_VibMounted", t.id(x))) && !t.w("h_hid_VibMounted", 0), "invalid style, motor, reserved byte, disconnected player and no handle are not mounted");
  let calls = h.vibrations.length;
  for (const x of invalid) t.c("h_hid_SendVib", t.id(x), v);
  assert.equal(h.vibrations.length, calls, "invalid style, motor, reserved byte and disconnected player are ignored");
  t.c("h_hid_SendVibs", hs, V(h, [0.1, 160, 0, 320, 0.6, 160, 0, 320]), 2);
  assert.equal(h.vibrations.length, calls + 1); assert.deepEqual([last(0).motors[0].amplitudeLow, last(0).motors[1].amplitudeLow], [Math.fround(0.1), Math.fround(0.6)], "HID batch publishes one complete pair");
  assert.equal(t.w("h_hid_SendVibs", hs, 0, 2), 0); assert.equal(t.w("h_hid_SendVibs", 0, v, 1), 0);
  t.c("h_hid_InitVib", hs);
  assert.deepEqual([actual(H0())[0], actual(H1())[0]], [0, Math.fround(0.6)], "initializing one motor leaves its partner intact");
  t.ids([0, HANDHELD]);
  t.c("h_hid_SendVib", hs, v);
  assert.equal(last(1).motors[0].amplitudeLow, 0.25, "one-player rumble reaches controllers whose input is merged into player 1");
  t.input(0, { rumble: false });
  assert.equal(handles(2, id0, FULLKEY), 2, "merged controller supplies rumble when player 1 has no physical output");
  h.host.setOpmode(0);
  assert.equal(handles(2, t.id(HANDHELD), HH), 2); assert.deepEqual([H0(), H1()], [0x2004, 0x12004], "handheld SDK vibration handles");
  assert.ok(!t.w("h_hid_VibMounted", t.id(3)) && t.w("h_hid_VibMounted", hs), "mounted follows the connected controller's style: the old docked handle is not valid in handheld mode");
  t.input(1, { rumble: false });
  assert.ok(!permit(), "disconnecting the last output disables vibration");
  h.host.haptics({ output: true, enabled: false }); t.input(0, { rumble: true });
  assert.ok(!permit() && handles(2, t.id(HANDHELD), HH) === 2, "rumble disabled: not permitted, but the handles exist, as on a Switch");
  h.host.hapticsEnable(true);
  assert.ok(permit(), "rumble turned on while the game runs: the handles it took work");
  assert.deepEqual(h.red, []);
});

test("vibration state (t_haptics.c): batches, both edges of a pulse, epochs, suspension, sanitized values, the rumble switch", () => {
  const t = new Hid(), h = t.h, x = h.host.x;
  t.ids([0, 1, HANDHELD]);
  h.host.haptics({ output: true });
  assert.equal(x.hle_haptics_available(), 0);
  const send = (p: number, m: number, a: number) => t.c("h_hid_SendVib", t.id(3 | p << 8 | m << 16), V(h, [a, 160, 0, 320]));
  const actual = (p: number, m: number) => { const o = h.alloc(16); t.c("h_hid_VibActual", o, t.id(3 | p << 8 | m << 16)); return [0, 4, 8, 12].map(q => h.f32(o + q)); };
  const last = (p: number) => h.vibrations.findLast(s => s.player === p)!;
  t.input(1);
  send(0, 0, 0.5); assert.equal(actual(0, 0)[0], 0);
  t.input(0, { rumble: true }); t.input(1, { rumble: true });
  assert.equal(x.hle_haptics_available(), 3);
  let calls = h.vibrations.length;
  t.c("h_hid_SendVibs", h.u32s([3, 0x10003]), V(h, [0.2, 160, 0, 320, 0.4, 160, 0, 320]), 2);
  assert.ok(h.vibrations.length === calls + 1 && last(0).motors[0].amplitudeLow === Math.fround(0.2) && last(0).motors[1].amplitudeLow === Math.fround(0.4));
  send(1, 0, 0.7); send(0, 1, 0);
  assert.ok(last(1).motors[0].amplitudeLow === Math.fround(0.7) && last(0).motors[0].amplitudeLow === Math.fround(0.2));
  calls = h.vibrations.length; send(0, 1, 0.3); send(0, 1, 0);
  assert.ok(h.vibrations.length === calls + 2 && last(0).motors[1].amplitudeLow === 0, "both edges of a short pulse survive");
  calls = h.vibrations.length; send(0, 1, 0); assert.equal(h.vibrations.length, calls, "an unchanged value is not sent again");
  h.monoNs += 600_000_000n; h.guestNs += 600_000_000n;
  assert.equal(actual(0, 0)[0], Math.fround(0.2), "steady state never times out");
  const old = last(0).epoch;
  h.host.hapticsRoute(0, false); h.host.hapticsRoute(0, true);
  assert.ok(x.hle_haptics_epoch(0) !== old && actual(0, 0)[0] === 0, "a new route is a new epoch with idle motors");
  assert.equal(x.hle_haptics_epoch(8), 0n);
  assert.equal(actual(1, 0)[0], Math.fround(0.7), "other player unaffected");
  h.host.hapticsSuspend("inactive", true); h.host.hapticsSuspend("interrupted", true);
  send(1, 0, 0.8);
  h.host.hapticsSuspend("inactive", false);
  send(1, 0, 0.8); assert.equal(actual(1, 0)[0], 0, "still suspended for the other reason");
  h.host.hapticsSuspend("interrupted", false);
  assert.equal(actual(1, 0)[0], 0);
  send(1, 0, 0.8); assert.equal(actual(1, 0)[0], Math.fround(0.8));
  t.c("h_hid_SendVib", t.id(0x10103), V(h, [NaN, Infinity, 2, -1]));
  assert.deepEqual(actual(1, 1), [0, 160, 1, 320], "NaN, infinity and out of range values are sanitized");
  t.c("h_hid_SendVib", t.id(0x10103), V(h, [0.5, 10, 0.5, 5000])); assert.deepEqual(actual(1, 1), [0.5, 40, 0.5, 1250], "frequencies are kept within 40..1250 Hz");
  h.host.hapticsRoute(-1, true); h.host.hapticsRoute(8, true); assert.equal(x.hle_haptics_available(), 3);
  h.host.haptics({ output: true, enabled: false }); h.host.hapticsRoute(0, true); send(0, 0, 1);
  assert.ok(!x.hle_haptics_available() && actual(0, 0)[0] === 0);
  h.host.hapticsEnable(true); send(0, 0, 1);
  assert.ok(x.hle_haptics_available() && actual(0, 0)[0] > 0);
  h.host.hapticsEnable(false);
  assert.ok(!x.hle_haptics_available() && actual(0, 0)[0] === 0, "and off: every motor stops at once");
  assert.ok(h.vibrations.at(-8)!.motors.every(m => m.amplitudeLow === 0 && m.amplitudeHigh === 0));
  // no sink at all: nothing is forwarded
  const n = new Hid(), before = n.h.vibrations.length; n.h.host.haptics({ output: false }); n.h.host.hapticsRoute(0, true);
  assert.equal(n.h.vibrations.length, before); assert.equal(n.w("h_hid_VibPermit"), 0);
});

test("npad states: the 0x28 bytes, histories with consecutive sampling numbers, stick direction bits, 16-bit sticks, every style's name", () => {
  const t = new Hid(), h = t.h;
  const S0 = 1 << 16;
  t.input(0, { buttons: BTN.A | BTN.Down | BTN.LSL | BTN.SHAKE | (1n << 40n), lx: -20000, ly: 30000, rx: 0x4000, ry: -0x4001 });
  const p = h.alloc(0x28 * 16 + 32, 0xEE) + 16, FK = "_ZN2nn3hid13GetNpadStatesEPNS0_16NpadFullKeyStateEiRKj";
  assert.equal(h.w0(FK, p, 16, t.id(0)), 16, "every requested entry");
  const exp = Buffer.alloc(0x28);
  exp.writeBigUInt64LE(BigInt(B("A") | B("Down") | 1 << 16 | 1 << 17 | 1 << 23), 8);   // left stick left and up, right stick down (0x4000 is not past the threshold)
  exp.writeInt32LE(-20000, 16); exp.writeInt32LE(30000, 20); exp.writeInt32LE(0x4000, 24); exp.writeInt32LE(-0x4001, 28);
  exp.writeUInt32LE(ATTR_CONNECTED | ATTR_LEFT_CONN | ATTR_RIGHT_CONN, 32);
  for (let i = 0; i < 16; i++) { exp.writeBigInt64LE(BigInt(S0 + 1 - i), 0); assert.deepEqual(h.read(p + 0x28 * i, 0x28), exp, `entry ${i}: the current state, sampling number ${S0 + 1 - i}`); }
  assert.ok(h.read(p - 16, 16).every(b => b === 0xEE) && h.read(p + 0x28 * 16, 16).every(b => b === 0xEE));
  assert.equal(h.x.hle_input_samples(), BigInt(S0 + 1));
  assert.equal(h.w0(FK, p, 0, t.id(0)), 0); assert.equal(h.w0(FK, p, -5 >>> 0, t.id(0)), 0, "n <= 0: nothing");
  assert.equal(h.x.hle_input_samples(), BigInt(S0 + 1), "and no sample taken");
  // a style the controller is not: the entry is zero but for its sampling number
  h.u8.fill(0xEE, p, p + 0x50);
  assert.equal(h.w0("_ZN2nn3hid13GetNpadStatesEPNS0_17NpadHandheldStateEiRKj", p, 2, t.id(0)), 2);
  const zero = Buffer.alloc(0x28); zero.writeBigInt64LE(BigInt(S0 + 2), 0); assert.deepEqual(h.read(p, 0x28), zero); zero.writeBigInt64LE(BigInt(S0 + 1), 0); assert.deepEqual(h.read(p + 0x28, 0x28), zero);
  for (const [name, n] of [["16NpadJoyDualState", 1], ["16NpadJoyLeftState", 1], ["17NpadJoyRightState", 1]] as const) {
    assert.equal(h.w0(`_ZN2nn3hid13GetNpadStatesEPNS0_${name}EiRKj`, p, n, t.id(0)), 1); assert.equal(h.u32(p + 32), 0, `${name}: not connected`);
    h.call(`_ZN2nn3hid12GetNpadStateEPNS0_${name}ERKj`, p, t.id(0)); assert.equal(h.u32(p + 32), 0);
  }
  assert.equal(h.x.hle_input_samples(), BigInt(S0 + 2 + 6), "every read is one sampling number, whatever n");
  // an id that is no npad, and the "Other" id
  for (const id of [8, 0x10, 0x21, 0xffffffff]) { assert.equal(t.style(id), 0); assert.equal(t.npad(id, FULLKEY).attr, 0); }
  // sticks are kept as 16 bits, as nxnative packs them
  t.input(0, { lx: 32767, ly: -32767 }); let s = t.npad(0, FULLKEY); assert.deepEqual([s.lx, s.ly], [32767, -32767]);
  // the shake bit and bits past 15 never reach a pad's buttons
  assert.equal(s.buttons & ~0xffffff, 0);
  // the other entry points
  assert.equal(t.w("h_hid_GetStyles"), 0xffffffff); t.styles(0x1f); assert.equal(t.w("h_hid_GetStyles"), 0x1f); t.styles(0xffffffff);
  assert.deepEqual(h.logs.filter(l => l.startsWith("hid supported controller styles")), ["hid supported controller styles 0x1f", "hid supported controller styles 0xffffffff"]);
  t.c("h_hid_HoldType", 0x100000001n); assert.equal(t.w("h_hid_GetHold"), 1, "an enum argument is 32 bits");
  t.c("h_hid_SetComm", 2); assert.equal(t.w("h_hid_GetComm"), 2); t.c("h_hid_SetHh", 1); assert.equal(t.w("h_hid_GetHh"), 1);
  const col = h.alloc(24, 0xEE);
  assert.equal(t.w("h_hid_Color", col, t.id(0)), 0); assert.deepEqual([h.u32(col), h.u32(col + 4), h.u32(col + 8)], [0xff828282, 0xff0f0f0f, 0xEEEEEEEE], "grey body, black buttons");
  assert.equal(t.w("h_hid_Color2", col + 8, col + 16, t.id(0)), 0); assert.deepEqual([h.u32(col + 8), h.u32(col + 12), h.u32(col + 16), h.u32(col + 20)], [0xff828282, 0xff0f0f0f, 0xff828282, 0xff0f0f0f]);
  t.ids([0, HANDHELD]); t.ids([0, HANDHELD]);
  assert.deepEqual(h.logs.filter(l => l.startsWith("hid supported controller ids")), ["hid supported controller ids 0x101 (bit n: No n+1, bit 8 Handheld, bit 9 Other)"], "logged when it changes");
  assert.deepEqual(h.red, []);
});

test("mouse, keyboard, debug pad, Poke Ball Plus: never connected, with the layouts nxnative writes", () => {
  const t = new Hid(), h = t.h, p = h.alloc(0x30 * 4 + 32, 0xEE) + 16;
  const fresh = () => h.u8.fill(0xEE, p - 16, p + 0x30 * 4 + 16);
  const s0 = Number(h.x.hle_input_samples());
  fresh(); t.c("h_hid_MouseState", p); assert.equal(h.i64(p), BigInt(s0 + 1)); assert.ok(h.read(p + 8, 0x20).every(b => b === 0) && h.u8[p + 0x28] === 0xEE, "MouseState: 0x28 bytes, zero but for the sampling number");
  fresh(); t.c("h_hid_KbdState", p); assert.equal(h.i64(p), BigInt(s0 + 2)); assert.ok(h.read(p + 8, 0x28).every(b => b === 0) && h.u8[p + 0x30] === 0xEE, "KeyboardState: 0x30 bytes");
  fresh(); assert.equal(t.w("h_hid_KbdStates", p, 3), 3); assert.deepEqual([0, 1, 2].map(i => h.i64(p + 0x30 * i)), [BigInt(s0 + 3), BigInt(s0 + 2), BigInt(s0 + 1)], "the history form: newest first"); assert.equal(h.u8[p + 0x90], 0xEE);
  fresh(); assert.equal(t.w("h_hid_DbgPadStates", p, 4), 4); assert.deepEqual([0, 3].map(i => h.i64(p + 32 * i)), [BigInt(s0 + 4), BigInt(s0 + 1)]); assert.ok(h.read(p + 8, 24).every(b => b === 0) && h.u8[p + 128] === 0xEE, "DebugPadState: 32 bytes each");
  assert.equal(t.w("h_hid_KbdStates", p, -1 >>> 0), 0); assert.equal(t.w("h_hid_DbgPadStates", p, 0), 0);
  fresh(); t.c("h_hid_DbgPadState", p); assert.ok(h.read(p, 32).every(b => b === 0) && h.u8[p + 32] === 0xEE);
  assert.equal(t.w("h_hid_MouseStates", p, 16), 0); assert.equal(t.w("h_hid_SevenStates", p, 16), 0); assert.equal(t.w("h_hid_SevenRest"), 1); assert.equal(t.w("h_hid_SevenInit", 0, 0), 0);
  fresh(); t.c("h_kpr_Map", p); assert.equal(h.u8[p], 0xEE, "the key code map is left as the game made it");
  const hd = h.alloc(8, 0xEE); assert.equal(t.w("h_hid_PalmaHandle", hd, t.id(0)), 202 | 3302 << 9); assert.equal(h.u64(hd), 0n);
  assert.equal(t.w("h_hid_PalmaHandle", 0, 0), 202 | 3302 << 9); assert.equal(t.w("h_hid_PalmaInit", hd), 202 | 3302 << 9); assert.equal(t.w("h_hid_PalmaAnyOn"), 0);
  const fu = h.f32s([7, 7]); t.c("h_hid_FusionGet", fu, fu + 4, 0); assert.deepEqual([h.u32(fu), h.u32(fu + 4)], [0, 0], "fusion parameters: 0");
  assert.deepEqual([t.w("h_hid_GyroGet", 0), t.w("h_hid_SixFusionQ", 0), t.w("h_hid_SixFw", 0), t.w("h_hid_Merge", 0, 0)], [1, 0, 0, 0]);
  assert.deepEqual(h.red, []);
});

test("the press latch, the applet's peek, the cheat key mask", () => {
  const t = new Hid(), h = t.h;
  t.input(0, { buttons: BTN.A }); t.input(0);
  assert.equal(t.buttons(0, FULLKEY), B("A"), "a press and release between two reads is latched until the game reads");
  assert.equal(t.buttons(0, FULLKEY), 0, "and is read once");
  t.input(0, { buttons: BTN.B }); t.input(0, { buttons: BTN.B });
  assert.equal(t.buttons(0, FULLKEY), B("B")); assert.equal(t.buttons(0, FULLKEY), B("B"), "a held button stays");
  t.input(0);
  // a read of another style does not take the latch
  t.input(0, { buttons: BTN.X }); t.input(0);
  assert.equal(t.buttons(0, HH), 0); assert.equal(t.buttons(0, FULLKEY), B("X"));
  // the peek: every player ORed, each axis the most deflected, presses since the last peek
  assert.equal(h.host.inputPeek().buttons, B("A") | B("B") | B("X"), "everything pressed since the start");
  t.input(1, { buttons: BTN.Y, lx: -900, ry: 5 }); t.input(0, { buttons: BTN.A | BTN.SHAKE, lx: 300, ry: -6 }); t.input(0, { lx: 300, ry: -6 });
  assert.deepEqual(h.host.inputPeek(), { buttons: B("A") | B("Y"), axes: [-900, 0, 0, -6] }, "a tap between two peeks is reported once (A), held buttons as they are, the shake bit never");
  assert.deepEqual(h.host.inputPeek(), { buttons: B("Y"), axes: [-900, 0, 0, -6] });
  assert.equal(t.buttons(0, FULLKEY), B("A"), "the peek takes nothing from the game's latch");
  // the cheat VM's mask: buttons of every player and the merged sticks' directions; no latch, no sample
  const s = h.x.hle_input_samples();
  t.input(0, { buttons: BTN.L, lx: -20000 }); t.input(1, { buttons: BTN.R, ry: 20000 });
  assert.equal(h.x.hle_cheat_keys(), BigInt(B("L") | B("R") | 1 << 16 | 1 << 21));
  assert.equal(h.x.hle_input_samples(), s);
  t.input(0, { buttons: BTN.Plus }); t.input(0); assert.equal(h.x.hle_cheat_keys() & BigInt(B("Plus")), 0n, "a latched press is not held");
});

test("the input hold has reasons: a second holder's release does not give the game its input back", () => {
  const t = new Hid(), h = t.h;
  t.input(0, { buttons: BTN.A, lx: 1000 }); t.input(1, { buttons: BTN.B });
  h.host.hold("web", true);
  assert.deepEqual(h.host.holds, ["web"]);
  let s = t.npad(0, FULLKEY);
  assert.deepEqual([s.buttons, s.lx, s.attr], [0, 0, ATTR_CONNECTED | ATTR_LEFT_CONN | ATTR_RIGHT_CONN], "held: no buttons, centred sticks, still connected");
  assert.equal(t.buttons(1, FULLKEY), 0, "on every npad");
  h.host.hold("embedder", true); h.host.hold("embedder", true);
  assert.deepEqual(h.host.holds, ["web", "embedder"]);
  h.host.hold("web", false);
  assert.equal(t.npad(0, FULLKEY).buttons, 0, "nxnative's one boolean would have given the input back here");
  t.input(0, { buttons: BTN.A | BTN.X, lx: 1000 }); t.input(0, { buttons: BTN.A, lx: 1000 });   // X pressed for the applet
  h.host.hold("web", false);   // not holding: nothing
  h.host.hold("embedder", false);
  assert.deepEqual(h.host.holds, []);
  s = t.npad(0, FULLKEY);
  assert.deepEqual([s.buttons, s.lx], [B("A"), 1000], "given back: what is held now, and the press made meanwhile is dropped");
  // a press latched before the hold is dropped when the hold starts
  t.input(0, { buttons: BTN.Y }); t.input(0);
  h.host.hold("keyboard", true); h.host.hold("keyboard", false);
  assert.equal(t.buttons(0, FULLKEY), 0);
  h.host.hold("controllerPrompt", true); assert.equal(h.x.hle_hold_state(), 1 << 2); h.host.hold("controllerPrompt", false);
  h.x.hle_hold(9, 1); h.x.hle_hold(0, 1);
  assert.deepEqual(h.red, ["[RED] hid: input hold with unknown reason 9: ignored", "[RED] hid: input hold with unknown reason 0: ignored"]);
  assert.equal(h.x.kit_refused_total(), 0, "asking twice is not a refusal");
});

test("one snapshot per read: the style, the state and the six-axis answer of a call agree, whatever changed before it", () => {
  // every combination of mode, players, supported ids, styles and assignment: what GetNpadStyleSet says is what the
  // states, the sensors and the vibration handles of that npad answer for, for all nine npads
  const t = new Hid(), h = t.h;
  h.host.haptics({ output: true });
  let seed = 7; const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const six = h.alloc(0x60 * 2), hs = h.alloc(16);
  for (let round = 0; round < 400; round++) {
    switch (rnd(6)) {
      case 0: h.host.setOpmode(rnd(2) as 0 | 1); break;
      case 1: { const p = rnd(8), k = rnd(5); t.input(p, k === 0 ? { connected: false } : { rumble: rnd(2) === 1, joyLeft: k & 1 ? {} : undefined, joyRight: k & 2 ? {} : undefined, joyCon2: rnd(4) === 0 }); break; }
      case 2: t.ids([0, 1, 2, 3, 4, 5, 6, 7, HANDHELD].filter(() => rnd(3) > 0)); break;
      case 3: t.styles([0xffffffff, FULLKEY | HH, FULLKEY | HH | JOYDUAL, JOYLEFT | JOYRIGHT | HH, 0x1f, 0x7000 | HH][rnd(6)]); break;
      case 4: t.c(["h_hid_JoySingle", "h_hid_JoyDual"][rnd(2)], t.id(rnd(8))); break;
      default: t.c("h_hid_JoySingleT", t.id(rnd(8)), rnd(2));
    }
    let seen = 0;
    for (const id of [0, 1, 2, 3, 4, 5, 6, 7, HANDHELD]) {
      const style = t.style(id);
      assert.ok([0, FULLKEY, HH, JOYDUAL, JOYLEFT, JOYRIGHT].includes(style & 0x1f) && (style & ~0x701f) === 0, `round ${round}: npad ${id} has one style (${style})`);
      if (style) seen++;
      for (const st of [FULLKEY, HH, JOYDUAL, JOYLEFT, JOYRIGHT]) assert.equal(t.npad(id, st).attr !== 0, (style & st) !== 0, `round ${round}: npad ${id} reads as connected for style ${st} exactly when it has it (${style})`);
      // a sensor per controller, two for the styles made of two Joy-Cons
      for (const st of [FULLKEY, HH, JOYDUAL, JOYLEFT, JOYRIGHT]) {
        const n = t.w("h_hid_SixHandles", hs, 2, t.id(id), st); assert.equal(n, st === HH || st === JOYDUAL ? 2 : 1);
        assert.equal(t.w("h_hid_SixStates", six, 2, hs), (style & st) ? 2 : 0, `round ${round}: npad ${id} six-axis for style ${st}`);
      }
      const nv = t.w("h_hid_VibHandles", hs, 2, t.id(id), style || FULLKEY);
      assert.equal(nv, !style ? 0 : (style & (JOYLEFT | JOYRIGHT)) ? 1 : 2, `round ${round}: npad ${id} vibration handles`);
      if (nv) assert.equal(h.u32(hs) & 0xff, (style & FULLKEY) ? 3 : (style & HH) ? 4 : (style & JOYDUAL) ? 5 : (style & JOYLEFT) ? 6 : 7);
    }
    // equal, but for nxnative's own case of a split pair on a player the game does not support: its other half still shows on a free npad
    assert.ok(h.host.playersReported <= seen && h.host.playersReported >= 1, `round ${round}: the applet counts ${h.host.playersReported} players, ${seen} npads have a style`);
    assert.equal(h.host.playerNpad(0), h.x.hle_opmode() === 0 ? HANDHELD : 0);
  }
  assert.deepEqual(h.red, []);
});

// ---------- six-axis sensors ----------
function sixRead(t: Hid, handle: number, n = 1) {
  const h = t.h, p = h.alloc(0x60 * n + 32, 0xEE) + 16, count = t.w("h_hid_SixStates", p, n, t.id(handle));
  assert.ok(h.read(p - 16, 16).every(b => b === 0xEE) && h.read(p + 0x60 * n, 16).every(b => b === 0xEE), "a SixAxisSensorState is 0x60 bytes");
  return { count, p, e: (i: number) => { const e = p + 0x60 * i; return { delta: h.i64(e), sampling: h.i64(e + 8), acc: [0, 1, 2].map(k => h.f32(e + 16 + 4 * k)), gyro: [0, 1, 2].map(k => h.f32(e + 28 + 4 * k)),
    angle: [0, 1, 2].map(k => h.f32(e + 40 + 4 * k)), dir: [...Array(9)].map((_, k) => h.f32(e + 52 + 4 * k)), attr: h.u32(e + 88), pad: h.u32(e + 92) }; } };
}

test("six-axis sensors: handles, the state at rest byte for byte, samples numbered by guest time, the shake in whole cycles", () => {
  const t = new Hid(), h = t.h, hs = h.alloc(16, 0xEE);
  assert.equal(t.w("h_hid_SixHandles", hs, 2, t.id(0), FULLKEY), 1); assert.deepEqual([h.u32(hs), h.u32(hs + 4)], [0, 0xEEEEEEEE], "one handle: style bit 0, npad 0");
  assert.equal(t.w("h_hid_SixHandles", hs, 2, t.id(HANDHELD), HH), 2); assert.deepEqual([h.u32(hs), h.u32(hs + 4)], [1 | 0x20 << 8, 1 | 0x20 << 8 | 1 << 16], "handheld: two, the device in byte 2");
  assert.equal(t.w("h_hid_SixHandles", hs, 1, t.id(3), JOYDUAL), 1); assert.equal(h.u32(hs), 2 | 3 << 8);
  assert.equal(t.w("h_hid_SixHandles", hs, 0, t.id(3), JOYDUAL), 0); assert.equal(t.w("h_hid_SixHandles", hs, 2, t.id(1), 0), 1); assert.equal(h.u32(hs), 1 << 8, "no style: bit number 0");
  h.guestNs = 1_000_000_000n;
  let r = sixRead(t, 0, 3);
  assert.equal(r.count, 3);
  const exp = Buffer.alloc(0x60); exp.writeBigInt64LE(5000000n, 0); exp.writeFloatLE(-1, 16 + 8); exp.writeFloatLE(1, 52); exp.writeFloatLE(-0, 52 + 12) /* dir[3] = -sin(0): the C code writes a negative zero */; exp.writeFloatLE(1, 52 + 16); exp.writeFloatLE(1, 52 + 32); exp.writeUInt32LE(1, 88);
  for (let i = 0; i < 3; i++) { exp.writeBigInt64LE(BigInt(200 - i), 8); assert.deepEqual(h.read(r.p + 0x60 * i, 0x60), exp, `entry ${i}: flat, sample ${200 - i} (5 ms apart on the guest clock)`); }
  h.guestNs = 1_004_999_999n; assert.equal(sixRead(t, 0).e(0).sampling, 200n); h.guestNs = 1_005_000_000n; assert.equal(sixRead(t, 0).e(0).sampling, 201n);
  // not connected: zero entries, count 0
  r = sixRead(t, 1 | 0x20 << 8, 2); assert.equal(r.count, 0); assert.ok(h.read(r.p, 0xC0).every(b => b === 0), "a handle of a style the controller is not: entries zeroed");
  assert.equal(sixRead(t, 40).count, 0, "a style bit number past 31"); assert.equal(t.w("h_hid_SixStates", r.p, 0, t.id(0)), 0);
  assert.equal(t.w("h_hid_SixRest", t.id(0)), 1);
  // the shake: side to side at 6 Hz, x acceleration +-3 G, yaw +-1.5 rev/s, in whole cycles from the press
  const T0 = 2_000_000_000n, CYCLE = 166666666n;
  h.guestNs = T0; t.input(0, { shake: true, buttons: BTN.A });
  assert.equal(t.npad(0, FULLKEY).buttons, B("A"), "the shake never reaches the buttons");
  const at = (ns: bigint) => { h.guestNs = ns; return sixRead(t, 0).e(0); };
  const want = (ns: bigint) => { const samp = ns / 5000000n, tt = Number(samp * 5000000n - T0), ph = 2 * Math.PI * 6 * tt / 1e9, yaw = 1.5 / (2 * Math.PI * 6) * (1 - Math.cos(ph));
    return { acc0: 3 * Math.sin(ph), gyro2: 1.5 * Math.sin(ph), yaw, c: Math.cos(2 * Math.PI * yaw), s: Math.sin(2 * Math.PI * yaw) }; };
  for (const dt of [5_000_000n, 40_000_000n, 80_000_000n, 125_000_000n, 300_000_000n]) {
    const e = at(T0 + dt), w = want(T0 + dt);
    assert.ok(Math.abs(e.acc[0] - w.acc0) < 1e-6 && e.acc[2] === -1 && e.acc[1] === 0, `shaking at +${dt} ns: acceleration ${e.acc[0]} against ${w.acc0}`);
    assert.ok(Math.abs(e.gyro[2] - w.gyro2) < 1e-6 && Math.abs(e.angle[2] - w.yaw) < 1e-6, "yaw rate and angle");
    assert.ok(Math.abs(e.dir[0] - w.c) < 1e-6 && Math.abs(e.dir[1] - w.s) < 1e-6 && Math.abs(e.dir[3] + w.s) < 1e-6 && Math.abs(e.dir[4] - w.c) < 1e-6 && e.dir[8] === 1 && e.dir[2] === 0, "the direction turned by the yaw");
    assert.equal(t.w("h_hid_SixRest", t.id(0)), 0, "not at rest while shaking");
  }
  assert.ok(Math.abs(at(T0 + 40_000_000n).acc[0] - 3 * Math.sin(2 * Math.PI * 6 * 0.04)) < 1e-5, "about a quarter cycle in: near the peak of 3 G");
  // a history read during the shake: each entry at its own time, and none before the press
  h.guestNs = T0 + 20_000_000n; r = sixRead(t, 0, 8);
  assert.deepEqual([...Array(8)].map((_, i) => r.e(i).acc[0] !== 0), [true, true, true, true, false, false, false, false], "samples before the press are at rest (the sample at the press itself is phase 0)");
  // release: the current cycle finishes, then rest
  h.guestNs = T0 + 200_000_000n; t.input(0);   // in the second cycle
  assert.ok(at(T0 + 300_000_000n).acc[0] !== 0, "released: still finishing the cycle");
  assert.equal(at(T0 + 2n * CYCLE + 5_000_000n).acc[0], 0, "the second cycle is over: at rest"); assert.equal(t.w("h_hid_SixRest", t.id(0)), 1);
  // a tap of one frame is one whole shake; a press while a shake is still finishing continues it
  const T1 = 5_000_000_000n; h.guestNs = T1; t.input(0, { shake: true }); h.guestNs = T1 + 1_000_000n; t.input(0);
  assert.ok(Math.abs(at(T1 + 80_000_000n).acc[0] - 3 * Math.sin(2 * Math.PI * 6 * 0.08)) < 1e-5, "one frame's tap: a whole cycle follows");
  h.guestNs = T1 + 100_000_000n; t.input(0, { shake: true });
  assert.ok(Math.abs(at(T1 + 250_000_000n).acc[0] - 3 * Math.sin(2 * Math.PI * 6 * 0.25)) < 1e-5, "pressed again before the cycle ended: the same shake goes on, in phase");
  h.guestNs = T1 + 260_000_000n; t.input(0);
  assert.ok(at(T1 + 2n * CYCLE).acc[0] !== 0, "the sample just before the second cycle's end still moves");
  assert.equal(at(T1 + 2n * CYCLE + 5_000_000n).acc[0], 0); assert.equal(at(T1 + 400_000_000n).gyro[2], 0);
  // only player 1's controller shakes
  t.input(1); h.guestNs = 8_000_000_000n; t.input(0, { shake: true }); h.guestNs += 40_000_000n;
  assert.ok(sixRead(t, 0).e(0).acc[0] !== 0 && sixRead(t, 1 << 8).e(0).acc[0] === 0); assert.equal(t.w("h_hid_SixRest", t.id(1 << 8)), 1);
  t.input(1, { shake: true, connected: true }); assert.equal(sixRead(t, 1 << 8).e(0).acc[0], 0, "player 2's shake bit does nothing");
  for (const c of ["h_hid_SixStart", "h_hid_SixStop"]) t.c(c, t.id(0));
  const one = h.alloc(0x60 + 16, 0xEE); t.c("h_hid_SixState", one, t.id(0)); assert.equal(h.u32(one + 88), 1); assert.equal(h.u8[one + 0x60], 0xEE, "GetSixAxisSensorState writes one state");
  assert.deepEqual(h.red, []);
});

test("live motion (t_hid.c t_motion_live): the controller's samples drive the sensor, expire, and merge as the buttons do", () => {
  const a = [0.5, 0, Math.fround(-0.8660254)], w = [0, 0, Math.fround(3.14159265)];
  const mk = (cfg: Parameters<Hle["host"]["config"]>[0] = {}) => { const t = new Hid(); t.h.host.config(cfg); t.h.guestNs = 1_000_000_000n; t.h.monoNs = 1_000_000_000n; return t; };
  const st = (t: Hid, n = 1) => { const r = sixRead(t, 0, n); return [...Array(r.count)].map((_, i) => r.e(i)); };
  let t = mk();
  let s = st(t, 2); assert.ok(s.length === 2 && s[0].acc[2] === -1 && s[0].acc[0] === 0, "no live motion: flat");
  t.input(0, { motion: { acc: a, rot: w } });
  s = st(t, 2); assert.equal(s.length, 2, "live: every entry");
  assert.ok(Math.abs(s[0].acc[0] - 0.5) < 1e-4 && Math.abs(s[1].acc[0] - 0.5) < 1e-4, "live: the controller's acceleration");
  assert.ok(Math.abs(s[0].gyro[2] - 0.5) < 1e-4, "live: rad/s to revolutions/s");
  assert.ok(Math.abs(-s[0].dir[2] - 0.5) < 0.01, "live: primed tilted with the measured gravity");
  assert.equal(s[0].sampling, s[1].sampling + 1n, "live: numbered by time"); assert.deepEqual([s[0].delta, s[0].attr], [5000000n, 1]);
  assert.equal(t.w("h_hid_SixRest", t.id(0)), 0, "live and turning: not at rest");
  t.input(0, { clearMotion: true });
  s = st(t); assert.ok(s[0].acc[0] === 0 && s[0].acc[2] === -1, "cleared: flat again"); assert.equal(t.w("h_hid_SixRest", t.id(0)), 1, "cleared: at rest");

  // auto uses fresh controller data ahead of the console's own sensors, including when those publish last
  t.input(0, { motion: { acc: a, rot: w } }); t.input(0, { consoleMotion: { acc: [0, -1, 0], rot: [0, 0, 0] } });
  assert.ok(Math.abs(st(t)[0].acc[0] - 0.5) < 1e-4, "auto: console samples do not replace a fresh controller");
  t.input(0, { clearMotion: true });
  s = st(t); assert.ok(s[0].acc[1] === -1 && Math.abs(s[0].dir[5] - 1) < 1e-4, "auto: disconnect falls back to the console's own upright orientation");
  t.h.monoNs += 300_000_001n;
  s = st(t); assert.ok(s[0].acc[2] === -1 && s[0].acc[1] === 0, "stale console data falls back to flat");
  // a sample 300 ms old is still fresh, one ns more is not
  t.input(0, { motion: { acc: a, rot: w } }); t.h.monoNs += 300_000_000n; assert.ok(st(t)[0].acc[0] !== 0); t.h.monoNs += 1n; assert.equal(st(t)[0].acc[0], 0, "a controller that stops sending expires after 300 ms");

  t = mk({ consoleMotion: true });
  t.input(0, { consoleMotion: { acc: [0, -1, 0], rot: [0, 0, 0] } }); t.input(0, { motion: { acc: a, rot: w } });
  assert.equal(st(t)[0].acc[1], -1, "forced console motion: a controller publishing last cannot replace it");
  t = mk({ consoleMotion: false });
  t.input(0, { consoleMotion: { acc: [0, -1, 0], rot: [0, 0, 0] } }); t.input(0, { motion: { acc: a, rot: w } });
  assert.equal(st(t)[0].acc[0], a[0], "console motion off: controller remains live");
  t.input(0, { clearMotion: true, consoleMotion: { acc: [0, -1, 0], rot: [0, 0, 0] } });
  s = st(t); assert.ok(s[0].acc[2] === -1 && s[0].acc[1] === 0, "console motion off: fresh console data cannot take over");

  // the same controller slot must drive buttons and motion when a game supports only one player
  t = mk(); t.input(1); t.ids([0, HANDHELD]);
  t.input(1, { motion: { acc: a, rot: w } });
  assert.ok(st(t)[0].acc[0] === a[0] && !t.w("h_hid_SixRest", t.id(0)), "one-player game: player 2's controller also drives player 1's motion");
  t.ids([0, 1, HANDHELD]);
  assert.ok(st(t)[0].acc[2] === -1 && t.w("h_hid_SixRest", t.id(0)) === 1, "co-op: player 2's motion stays on its own sensor");
  assert.equal(sixRead(t, 1 << 8).e(0).acc[0], a[0]);
  t.input(1, { connected: false }); t.input(1); assert.equal(sixRead(t, 1 << 8).e(0).acc[0], 0, "a controller that went away took its motion with it");

  // the axis map and the switches (nxnative DM_MOTION_AXES, DM_MOTION_ACC_SIGN, DM_MOTION)
  t = mk({ motionAxes: "x,-z,y", motionAccNegative: true });
  t.input(0, { motion: { acc: [0, 1, 0], rot: [0, 2 * Math.PI, 0] } });
  s = st(t); assert.ok(Math.abs(s[0].acc[2] + 1) < 1e-6 && Math.abs(s[0].gyro[2] - 1) < 1e-6, "mapped: the source's y is the Switch's z, the specific force flipped");
  t.input(0, { consoleMotion: { acc: [0, 0, -1], rot: [0, 0, 1] } });
  t = mk({ motionAxes: "x,q" }); t.input(0, { motion: { acc: a, rot: w } });
  assert.ok(t.h.logs.includes("[hid] DM_MOTION_AXES='x,q' is not like \"x,-z,y\": using x,y,z")); assert.ok(Math.abs(st(t)[0].acc[0] - 0.5) < 1e-6);
  t = mk({ motion: false }); t.input(0, { motion: { acc: a, rot: w } }); assert.equal(st(t)[0].acc[0], 0, "motion off: the sensors lie flat");
  // a shake still adds on top of live motion
  t = mk(); t.input(0, { motion: { acc: [0, 0, -1], rot: [0, 0, 0] }, shake: true }); t.h.guestNs += 40_000_000n;
  s = st(t); assert.ok(Math.abs(s[0].acc[0] - 3 * Math.sin(2 * Math.PI * 6 * 0.04)) < 1e-5 && s[0].gyro[2] === 0, "live and shaken: the shake's acceleration on the live sample");
});

test("raw motion (t_hid.c t_motion_hid) and the Joy-Cons' own sensors: sample times, reordering, sources kept apart", () => {
  const flat = [0, 0, -1], tilted = [0.5, 0, Math.fround(-0.8660254)], turn = [0, 0, Math.fround(2 * Math.PI)], still = [0, 0, 0];
  const t = new Hid(); t.h.host.config({ consoleMotion: false }); t.input(1); t.ids([0, 1, HANDHELD]);
  const h = t.h; h.guestNs = 1_000_000_000n; h.monoNs = 2_000_000_000n;
  const st = () => sixRead(t, 0).e(0);
  const raw = (p: number, acc: number[], rot: number[], sampleNs: bigint) => t.input(p, { rawMotion: { acc, rot, sampleNs } });
  for (let i = 0; i < 3; i++) raw(0, flat, turn, h.monoNs - BigInt(2 - i) * 5_000_000n);
  let s = st(); assert.ok(s.acc[0] === 0 && Math.abs(s.angle[2] - 0.01) < 1e-6, "raw: a batch integrates two 5 ms intervals, by its sample times");
  raw(0, tilted, still, h.monoNs - 5_000_000n); raw(0, tilted, turn, h.monoNs + 1n); raw(0, tilted, turn, h.monoNs - 300_000_001n);
  s = st(); assert.ok(s.acc[0] === 0 && s.gyro[2] > 0.99 && Math.abs(s.angle[2] - 0.01) < 1e-6, "raw: reordered, future and stale samples cannot rewind or replace the orientation");
  raw(0, tilted, turn, 0n); assert.equal(st().acc[0], 0, "a raw sample without its time is ignored");
  h.monoNs += 1_000_000n; t.input(0, { motion: { acc: tilted, rot: turn } });
  s = st(); assert.ok(s.acc[0] === 0.5 && s.angle[2] === 0, "raw: usable controller-frame motion takes over with its independent orientation");
  t.input(0, { clearMotion: true }); s = st();
  assert.ok(s.acc[0] === 0 && Math.abs(s.angle[2] - 0.01) < 1e-6, "raw: its removal reveals the raw source's independent orientation");
  t.input(0, { clearRawMotion: true }); s = st();
  assert.ok(s.acc[0] === 0 && s.acc[2] === -1 && s.angle[2] === 0, "raw: removing both controller sources returns to flat");
  raw(0, flat, turn, h.monoNs); s = st(); assert.ok(s.acc[0] === 0 && s.angle[2] === 0, "raw: reconnect starts a new orientation");
  h.monoNs += 300_000_001n; t.input(0, { motion: { acc: tilted, rot: turn } }); assert.equal(st().acc[0], 0.5, "raw: a stale raw stream yields to live controller-frame motion");
  raw(1, flat, turn, h.monoNs); assert.equal(st().acc[0], 0.5, "raw: another player's raw data stays on its own sensor");
  assert.ok(sixRead(t, 1 << 8).e(0).gyro[2] > 0.99);

  // each Joy-Con's own sensor: the dual npad's two handles, a single Joy-Con's one; else the pad's merged stream
  const j = new Hid(); j.h.guestNs = 1_000_000_000n; j.h.monoNs = 2_000_000_000n; j.ids([0, 1, 2]); j.styles(FULLKEY | JOYDUAL | JOYLEFT | JOYRIGHT);
  const now = () => j.h.monoNs;
  j.input(0, { joyLeft: { motion: { acc: [0.25, 0, -1], rot: still, sampleNs: now() } }, joyRight: { motion: { acc: [-0.25, 0, -1], rot: still, sampleNs: now() } } });
  const hd = j.h.alloc(8); assert.equal(j.w("h_hid_SixHandles", hd, 2, j.id(0), JOYDUAL), 2);
  assert.deepEqual([sixRead(j, j.h.u32(hd)).e(0).acc[0], sixRead(j, j.h.u32(hd + 4)).e(0).acc[0]], [0.25, -0.25], "JoyDual: a sensor per Joy-Con");
  j.c("h_hid_JoySingle", j.id(0));
  assert.deepEqual([sixRead(j, 3 | 0 << 8).e(0).acc[0], sixRead(j, 4 | 1 << 8).e(0).acc[0]], [0.25, -0.25], "split: JoyLeft on No1 and JoyRight on No2 keep their own sensors");
  j.input(0, { joyLeft: { clearMotion: true }, joyRight: {}, motion: { acc: tilted, rot: still } });
  assert.equal(sixRead(j, 3 | 0 << 8).e(0).acc[0], 0.5, "a Joy-Con with no stream of its own reports the pad's merged one");
  assert.equal(sixRead(j, 4 | 1 << 8).e(0).acc[0], -0.25);
  j.h.monoNs += 300_000_001n; assert.equal(sixRead(j, 4 | 1 << 8).e(0).acc[2], -1, "and all of it expires");
});
