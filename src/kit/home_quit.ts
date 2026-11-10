// Quit with the Home button: port of nxnative dm/host/home_quit.h (hq_step, hq_cancel, hq_blocks_input, hq_ring).
// Holding Home for HQ_HOLD_S seconds opens a "Quit?" prompt: A quits, B or a new press of Home closes it.
//
// All memory is in four machine instances: the phase (machine home_quit; Holding carries the time the hold started)
// and one button_latch each for Home, A and B. The functions below are guards: they read the inputs (button levels,
// the time) and the instances, and decide which events happened. They keep nothing themselves and change nothing
// except through Inst.step. README.md has the mapping from home_quit.h's fields.
import { Inst } from "./machine";
import { HOME_QUIT, HomeQuitS, HomeQuitE, BUTTON_LATCH, ButtonLatchS, ButtonLatchE } from "./gen/tables";

export const HQ_HOLD_S: f64 = 2.0;   // how long Home is held before the prompt opens
export const HQ_RING_S: f64 = 0.3;   // the hold indicator shows only after this, so a short press shows nothing

// The latch follows the button: down spends it, up arms it again
function follow(latch: Inst, down: bool): void {
  if (down) { if (latch.state == ButtonLatchS.Armed) latch.step(ButtonLatchE.Press); }
  else if (latch.state == ButtonLatchS.Spent) latch.step(ButtonLatchE.Release);
}
// The latch starts over as the button is now: one that is down does not count until it has been let go
function rearm(latch: Inst, down: bool): void {
  if (down) { if (latch.state == ButtonLatchS.Armed) latch.step(ButtonLatchE.Suppress); }
  else if (latch.state == ButtonLatchS.Spent) latch.step(ButtonLatchE.Release);
}

// 64 bytes, unmanaged: four Inst in a row
// @ts-ignore: decorator
@unmanaged
export class HomeQuit {
  static readonly SIZE: usize = 4 * Inst.SIZE;

  // @ts-ignore: decorator
  @inline static at(ptr: usize): HomeQuit { return changetype<HomeQuit>(ptr); }
  // @ts-ignore: decorator
  @inline get phase(): Inst { return Inst.at(changetype<usize>(this)); }
  // @ts-ignore: decorator
  @inline get home(): Inst { return Inst.at(changetype<usize>(this) + Inst.SIZE); }
  // @ts-ignore: decorator
  @inline get a(): Inst { return Inst.at(changetype<usize>(this) + 2 * Inst.SIZE); }
  // @ts-ignore: decorator
  @inline get b(): Inst { return Inst.at(changetype<usize>(this) + 3 * Inst.SIZE); }

  // id: which HomeQuit this is, for the trace (the latches get id * 3 + 0, 1, 2 for Home, A, B)
  init(id: u32): void {
    this.phase.init(HOME_QUIT, id);
    this.home.init(BUTTON_LATCH, id * 3);
    this.a.init(BUTTON_LATCH, id * 3 + 1);
    this.b.init(BUTTON_LATCH, id * 3 + 2);
  }

  // When the hold started (seconds); only meaningful in Holding
  // @ts-ignore: decorator
  @inline get since(): f64 { return reinterpret<f64>(this.phase.data); }

  // One step with the buttons as they are now (pressed on any controller) at time now (seconds, any clock that only
  // goes forward). Call it on every change of a button and, while Home is held, from a timer. Returns the phase.
  step(now: f64, home: bool, a: bool, b: bool): u8 {
    const phase = this.phase;
    const pressed = home && this.home.state == ButtonLatchS.Armed;   // a press is a change from up to down
    follow(this.home, home);
    switch (phase.state) {
      case HomeQuitS.Idle:
        if (pressed) phase.step(HomeQuitE.HomePress, reinterpret<u64>(now));
        break;
      case HomeQuitS.Holding:
        if (!home) phase.step(HomeQuitE.HomeRelease);   // let go too early
        else if (now - this.since >= HQ_HOLD_S) {
          phase.step(HomeQuitE.HoldElapsed);
          rearm(this.a, a); rearm(this.b, b);   // a button already held when the prompt opens does not count
        }
        break;
      case HomeQuitS.Prompt:
        if (!a) follow(this.a, false);
        if (!b) follow(this.b, false);
        // B or Home closes it; with A and B at once the safe one wins
        if (b && this.b.state == ButtonLatchS.Armed) phase.step(HomeQuitE.BPress);
        else if (pressed) phase.step(HomeQuitE.HomePress);
        else if (a && this.a.state == ButtonLatchS.Armed) phase.step(HomeQuitE.APress);
        break;
      case HomeQuitS.Settle:
        if (!home && !a && !b) phase.step(HomeQuitE.AllUp);
        break;
      default:   // Quit is final
        break;
    }
    return phase.state;
  }

  // The window lost the focus: whatever was shown closes. A Home still held needs a new press. After Quit nothing changes
  cancel(): void {
    if (!this.phase.can(HomeQuitE.FocusLost)) return;
    this.phase.step(HomeQuitE.FocusLost);
    rearm(this.home, true);
  }

  // How full the hold indicator is (0 to 1), -1 while it is not shown
  ring(now: f64): f64 {
    if (this.phase.state != HomeQuitS.Holding) return -1;
    const t = (now - this.since - HQ_RING_S) / (HQ_HOLD_S - HQ_RING_S);
    return t < 0 ? -1 : t > 1 ? 1 : t;
  }
}

// The game gets no controller input in these phases
export function hqBlocksInput(phase: u8): bool {
  return phase == HomeQuitS.Prompt || phase == HomeQuitS.Settle || phase == HomeQuitS.Quit;
}
