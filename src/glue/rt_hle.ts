// nxweb runtime glue: the SDK functions a simple game needs besides NVN, taken over by name as nxnative's HLE does.
//   nn::vi   the four calls that lead to a native window (nxnative leaves them to the SDK and serves the vi service
//            underneath; there is no SDK and no service layer here, so they are taken over at the API)
//   nn::hid  the npad path of nxnative dm/host/hle_hid.c: one player, docked (the pad is npad No1, style FullKey),
//            state layout NpadState, 16-entry histories filled with the current state, stick direction bits
// and the input state the embedder feeds: live (keyboard, Gamepad API) and scripted (nxnative's DM_KEYS idea, in frames).
import type { Runtime, HostCpu } from "./rt_runtime.ts";

export const NATIVE_WINDOW = 0x4E57_0001;   // what nn::vi::GetNativeWindow hands out; NVN only stores it
export const BTN = { A: 1 << 0, B: 1 << 1, X: 1 << 2, Y: 1 << 3, LS: 1 << 4, RS: 1 << 5, L: 1 << 6, R: 1 << 7, ZL: 1 << 8, ZR: 1 << 9,
  Plus: 1 << 10, Minus: 1 << 11, Left: 1 << 12, Up: 1 << 13, Right: 1 << 14, Down: 1 << 15 } as const;
const STYLE_FULLKEY = 1, STYLE_HANDHELD = 2, NPAD_NO1 = 0, NPAD_HANDHELD = 0x20, STICK_THRESH = 0x4000;
const ATTR_CONNECTED = 1, ATTR_LEFT_CONN = 4, ATTR_RIGHT_CONN = 16;

export interface PadState { buttons: number; lx: number; ly: number; rx: number; ry: number }   // sticks -32767..32767, up and right positive
interface Step { from: number; to: number; pad: PadState }

// Player 1's input. Sources are ORed (buttons) and the more deflected wins (sticks), as in nxnative.
export class RtInput {
  live: PadState = { buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0 };   // set by the embedder (keyboard, gamepad)
  private latch = 0;                                              // presses shorter than a read interval still count once
  private steps: Step[] = [];
  frame: () => number = () => 0;                                  // the frame counter scripted steps refer to
  reads = 0;
  set(p: Partial<PadState>): void { Object.assign(this.live, p); this.latch |= this.live.buttons; }
  // "frame:key[+key...][~frames]" separated by commas; keys are button names (A B X Y LS RS L R ZL ZR Plus Minus Left
  // Up Right Down) or sticks in hundredths of full tilt, L<x>/<y> and R<x>/<y>. Example: "10:Right~20,40:A,50:L100/0~30".
  // Returns the steps it could not read (each is also a red line through `log`).
  script(spec: string, log: (l: string) => void = () => {}): string[] {
    const bad: string[] = [];
    for (const tok of spec.split(",").map(s => s.trim()).filter(Boolean)) {
      const m = /^(\d+):([^~]+)(?:~(\d+))?$/.exec(tok);
      const pad: PadState = { buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
      let ok = !!m;
      for (const k of m ? m[2].split("+") : []) {
        const s = /^([LR])(-?\d+)\/(-?\d+)$/.exec(k);
        if (s) { const x = Math.round(Number(s[2]) * 327.67), y = Math.round(Number(s[3]) * 327.67); if (s[1] === "L") { pad.lx = x; pad.ly = y; } else { pad.rx = x; pad.ry = y; } }
        else if (k in BTN) pad.buttons |= (BTN as any)[k];
        else ok = false;
      }
      if (!ok || !m) { bad.push(tok); log(`[RED] scripted input: cannot read step "${tok}"`); continue; }
      this.steps.push({ from: Number(m[1]), to: Number(m[1]) + Number(m[3] ?? 1), pad });
    }
    return bad;
  }
  // What a read by the game sees now
  read(): PadState {
    const pick = (a: number, b: number) => Math.abs(a) >= Math.abs(b) ? a : b;
    const out: PadState = { ...this.live, buttons: this.live.buttons | this.latch };
    this.latch = 0; this.reads++;
    const f = this.frame();
    for (const s of this.steps) if (f >= s.from && f < s.to) {
      out.buttons |= s.pad.buttons; out.lx = pick(out.lx, s.pad.lx); out.ly = pick(out.ly, s.pad.ly); out.rx = pick(out.rx, s.pad.rx); out.ry = pick(out.ry, s.pad.ry);
    }
    return out;
  }
}

export function registerVi(rt: Runtime): void {
  const out = (cpu: HostCpu, v: number) => { cpu.dv().setBigUint64(Number(cpu.x(0)), BigInt(v), true); return 0; };
  rt.register({ name: "_ZN2nn2vi10InitializeEv", forced: true, fn: () => {} });
  rt.register({ name: "_ZN2nn2vi18OpenDefaultDisplayEPPNS0_7DisplayE", forced: true, fn: cpu => out(cpu, 0x4E44_0001) });
  rt.register({ name: "_ZN2nn2vi11CreateLayerEPPNS0_5LayerEPNS0_7DisplayE", forced: true, fn: cpu => out(cpu, 0x4E4C_0001) });
  rt.register({ name: "_ZN2nn2vi15GetNativeWindowEPPvPNS0_5LayerE", forced: true, fn: cpu => out(cpu, NATIVE_WINDOW) });
}

// handheld(): whether the console is in handheld mode now (the take-over table's operation mode, hle_opmode() == 0):
// then the pad is the Handheld npad with style Handheld, as nxnative; default docked.
export function registerHid(rt: Runtime, input: RtInput, o: { handheld?: () => boolean } = {}): void {
  let sampling = 1 << 16, styles = 0xFFFF_FFFF, ids = 0x3FF;
  const idBit = (id: number) => id < 8 ? 1 << id : id === NPAD_HANDHELD ? 1 << 8 : id === 0x10 ? 1 << 9 : 0;
  // docked: the pad is npad No1 as a full-key controller; nothing is connected as Handheld
  const styleOf = (id: number) => o.handheld?.() ? (id === NPAD_HANDHELD && (ids & idBit(id)) && (styles & STYLE_HANDHELD) ? STYLE_HANDHELD : 0)
    : id === NPAD_NO1 && (ids & idBit(id)) && (styles & STYLE_FULLKEY) ? STYLE_FULLKEY : 0;
  const fill = (cpu: HostCpu, at: number, id: number, style: number) => {
    const dv = cpu.dv();
    for (let i = 0; i < 40; i += 8) dv.setBigUint64(at + i, 0n, true);
    dv.setBigInt64(at, BigInt(++sampling), true);
    if (!(styleOf(id) & style)) return;            // no controller of this id and style: attributes stay 0
    const p = input.read();
    let b = p.buttons & 0xFFFF;
    if (p.lx < -STICK_THRESH) b |= 1 << 16; if (p.ly > STICK_THRESH) b |= 1 << 17; if (p.lx > STICK_THRESH) b |= 1 << 18; if (p.ly < -STICK_THRESH) b |= 1 << 19;
    if (p.rx < -STICK_THRESH) b |= 1 << 20; if (p.ry > STICK_THRESH) b |= 1 << 21; if (p.rx > STICK_THRESH) b |= 1 << 22; if (p.ry < -STICK_THRESH) b |= 1 << 23;
    dv.setBigUint64(at + 8, BigInt(b >>> 0), true);
    dv.setInt32(at + 16, p.lx, true); dv.setInt32(at + 20, p.ly, true); dv.setInt32(at + 24, p.rx, true); dv.setInt32(at + 28, p.ry, true);
    dv.setUint32(at + 32, ATTR_CONNECTED | ATTR_LEFT_CONN | ATTR_RIGHT_CONN, true);
  };
  const id = (cpu: HostCpu, reg: number) => cpu.dv().getUint32(Number(cpu.x(reg)), true);
  const state = (style: number) => (cpu: HostCpu) => { fill(cpu, Number(cpu.x(0)), id(cpu, 1), style); };
  // GetNpadStates(out, n, id): newest first; the host keeps no history, so the current state is repeated with
  // consecutive sampling numbers (games read all n entries whatever count comes back: nxnative's note)
  const states = (style: number) => (cpu: HostCpu) => {
    const at = Number(cpu.x(0)), n = cpu.w(1) | 0;
    if (n <= 0) return 0;
    fill(cpu, at, id(cpu, 2), style);
    const first = cpu.read(at, 40), dv = cpu.dv(), s0 = dv.getBigInt64(at, true);
    for (let i = 1; i < n; i++) { cpu.write(at + 40 * i, first); dv.setBigInt64(at + 40 * i, s0 - BigInt(i), true); }
    return n;
  };
  rt.register({ name: "_ZN2nn3hid14InitializeNpadEv", forced: true, fn: () => {} });
  rt.register({ name: "_ZN2nn3hid24SetSupportedNpadStyleSetENS_4util10BitFlagSetILi32ENS0_12NpadStyleTagEEE", forced: true,
    fn: cpu => { if (cpu.w(0) !== styles) rt.log(`hid supported controller styles 0x${cpu.w(0).toString(16)}`); styles = cpu.w(0); } });
  rt.register({ name: "_ZN2nn3hid22SetSupportedNpadIdTypeEPKjm", forced: true, fn: cpu => {
    const p = Number(cpu.x(0)), n = Number(cpu.x(1)), dv = cpu.dv();
    let m = 0; for (let i = 0; p && i < n && i < 16; i++) m |= idBit(dv.getUint32(p + 4 * i, true));
    if (m !== ids) rt.log(`hid supported controller ids 0x${m.toString(16)} (bit n: No n+1, bit 8 Handheld, bit 9 Other)`);
    ids = m;
  } });
  rt.register({ name: "_ZN2nn3hid15GetNpadStyleSetERKj", forced: true, fn: cpu => styleOf(id(cpu, 0)) });
  rt.register({ name: "_ZN2nn3hid12GetNpadStateEPNS0_16NpadFullKeyStateERKj", forced: true, fn: state(STYLE_FULLKEY) });
  rt.register({ name: "_ZN2nn3hid12GetNpadStateEPNS0_17NpadHandheldStateERKj", forced: true, fn: state(STYLE_HANDHELD) });
  rt.register({ name: "_ZN2nn3hid13GetNpadStatesEPNS0_16NpadFullKeyStateEiRKj", forced: true, fn: states(STYLE_FULLKEY) });
  rt.register({ name: "_ZN2nn3hid13GetNpadStatesEPNS0_17NpadHandheldStateEiRKj", forced: true, fn: states(STYLE_HANDHELD) });
}
