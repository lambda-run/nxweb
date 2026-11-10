// nxweb runtime glue: the embedder's input sources, merged and published to the take-over table (src/hle, hid.ts)
// through HleHost.input(player, snapshot). The table has the players, the npads, the press latch and the input hold;
// this file only knows where input comes from:
//   the keyboard        source KEYBOARD: always part of player 1
//   scripted steps      nxnative's DM_KEYS idea with frames (presents) as the time base, so that a run is
//                       reproducible: always part of player 1
//   controllers         one source per Gamepad API controller, with a stable non-zero id: each takes a player slot
//                       (the table's pad_slot machine: the same controller gets its player back after a reconnect).
//                       The one that holds player 1 is merged with the keyboard and the script (buttons ORed, each
//                       stick axis the more deflected one: nxnative's rule for player 1's three paths); the others
//                       are players 2..8.
// Nothing here is read by the game: every change is one hle.input() call.
import { type HleHost, type InputSnapshot, BTN as HBTN } from "./hle_host.ts";

export const BTN = { A: 1 << 0, B: 1 << 1, X: 1 << 2, Y: 1 << 3, LS: 1 << 4, RS: 1 << 5, L: 1 << 6, R: 1 << 7, ZL: 1 << 8, ZR: 1 << 9,
  Plus: 1 << 10, Minus: 1 << 11, Left: 1 << 12, Up: 1 << 13, Right: 1 << 14, Down: 1 << 15 } as const;
export const KEYBOARD = 1;          // the keyboard's source id
export interface PadState { buttons: number; lx: number; ly: number; rx: number; ry: number; rumble?: boolean; shake?: boolean }   // sticks -32767..32767, up and right positive
interface Step { from: number; to: number; pad: PadState }
const ZERO: PadState = { buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
const pick = (a: number, b: number) => Math.abs(a) >= Math.abs(b) ? a : b;
const merge = (a: PadState, b: PadState): PadState => ({ buttons: a.buttons | b.buttons, lx: pick(a.lx, b.lx), ly: pick(a.ly, b.ly), rx: pick(a.rx, b.rx), ry: pick(a.ry, b.ry),
  rumble: a.rumble || b.rumble, shake: a.shake || b.shake });

export class RtInput {
  readonly hle: HleHost;
  private keyboard: PadState = { ...ZERO };
  private pads = new Map<number, { state: PadState; player: number }>();   // by source id
  private steps: Step[] = [];
  private frameNow = 0;
  private sent = new Map<number, string>();   // player -> the snapshot last published, as text
  publishes = 0;

  constructor(hle: HleHost) { this.hle = hle; }

  // A source's state now. source KEYBOARD: the keyboard. Any other id: a controller, which takes a player slot;
  // null: it went away (its slot is kept for it). Returns the player the source feeds (0 = player 1), -1 for none.
  set(source: number, pad: Partial<PadState> | null): number {
    if (source === KEYBOARD) { this.keyboard = pad ? { ...ZERO, ...pad } : { ...ZERO }; this.publish(0); return 0; }
    if (!source) return -1;
    let e = this.pads.get(source);
    if (!pad) {
      if (!e) return -1;
      this.pads.delete(source);
      this.hle.padSlot("free", source);
      if (e.player === 0) this.publish(0);
      else if (e.player > 0) { this.sent.delete(e.player); this.hle.input(e.player, { connected: false, sourceId: source }); this.publishes++; }
      return e.player;
    }
    if (!e) { e = { state: { ...ZERO }, player: this.hle.padSlot("take", source) }; this.pads.set(source, e); }
    e.state = { ...ZERO, ...pad };
    if (e.player >= 0) this.publish(e.player);
    return e.player;
  }
  // The source that feeds a player (0 = player 1), 0 when it is the keyboard or nobody: where its vibration goes
  sourceOf(player: number): number { for (const [id, e] of this.pads) if (e.player === player) return id; return 0; }
  get players(): { player: number; source: number }[] { return [...this.pads].map(([source, e]) => ({ player: e.player, source })).sort((a, b) => a.player - b.player); }

  // "frame:key[+key...][~frames]" separated by commas; keys are button names (A B X Y LS RS L R ZL ZR Plus Minus Left
  // Up Right Down) or sticks in hundredths of full tilt, L<x>/<y> and R<x>/<y>. Example: "10:Right~20,40:A,50:L100/0~30".
  // Returns the steps it could not read (each is also a red line through `log`). With a script the controller
  // applet does not wait for players (config inputScripted).
  script(spec: string, log: (l: string) => void = () => {}): string[] {
    const bad: string[] = [];
    for (const tok of spec.split(",").map(s => s.trim()).filter(Boolean)) {
      const m = /^(\d+):([^~]+)(?:~(\d+))?$/.exec(tok);
      const pad: PadState = { ...ZERO };
      let ok = !!m;
      for (const k of m ? m[2].split("+") : []) {
        const s = /^([LR])(-?\d+)\/(-?\d+)$/.exec(k);
        if (s) { const x = Math.round(Number(s[2]) * 327.67), y = Math.round(Number(s[3]) * 327.67); if (s[1] === "L") { pad.lx = x; pad.ly = y; } else { pad.rx = x; pad.ry = y; } }
        else if (k in BTN) pad.buttons |= (BTN as Record<string, number>)[k];
        else ok = false;
      }
      if (!ok || !m) { bad.push(tok); log(`[RED] scripted input: cannot read step "${tok}"`); continue; }
      this.steps.push({ from: Number(m[1]), to: Number(m[1]) + Number(m[3] ?? 1), pad });
    }
    if (this.steps.length) { this.hle.config({ inputScripted: true }); this.publish(0); }
    return bad;
  }
  // The frame counter the scripted steps refer to moved (call it at every present)
  frame(n: number): void {
    if (n === this.frameNow) return;
    this.frameNow = n;
    if (this.steps.length) this.publish(0);
  }

  private publish(player: number): void {
    let p: PadState, source = 0;
    if (player === 0) {
      p = { ...this.keyboard };
      for (const [id, e] of this.pads) if (e.player === 0) { p = merge(p, e.state); source = id; }
      for (const s of this.steps) if (this.frameNow >= s.from && this.frameNow < s.to) p = merge(p, s.pad);
    } else {
      const hit = [...this.pads].find(([, e]) => e.player === player);
      if (!hit) return;
      p = hit[1].state; source = hit[0];
    }
    const text = `${p.buttons}/${p.lx}/${p.ly}/${p.rx}/${p.ry}/${p.rumble ? 1 : 0}/${p.shake ? 1 : 0}/${source}`;
    if (this.sent.get(player) === text) return;
    this.sent.set(player, text);
    const snap: InputSnapshot = { connected: true, sourceId: source, buttons: BigInt(p.buttons >>> 0) & ~HBTN.SHAKE, shake: p.shake, lx: p.lx, ly: p.ly, rx: p.rx, ry: p.ry, rumble: p.rumble };
    this.hle.input(player, snap);
    this.publishes++;
  }
}
