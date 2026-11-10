// Player slots of the input sources: port of nxnative dm/host/pad_slots.h. Each connected source (a controller, the
// keyboard) holds one slot, slot p is player p + 1. nxnative knows a controller across a reconnect by its name
// string, so two controllers of one model may trade places; here the embedder gives every source a stable non-zero
// id (the Gamepad API's index and id hashed, a device serial, 1 for the keyboard), which is both the holder and the
// identity. A connecting source takes, in this order: a free slot whose last holder it was (the same controller
// reconnected gets its player back), player 1 when it is free, the lowest slot no source has held yet (so a slot
// stays kept for a source that went away while others are in use), then the lowest free slot. With every slot held it
// gets none (-1). A disconnected source frees its slot and stays remembered on it.
// Machine pad_slot (src/hle/defs): Unused, Held (carries the source), Kept (carries the source that left).
import { Inst } from "../kit/machine";
import { PAD_SLOT, PadSlotS, PadSlotE } from "../kit/gen/tables";

export const DM_PLAYERS: i32 = 8;   // npads No1..No8; player 1 is the Handheld npad in handheld mode
const SLOTS: usize = memory.data(128);   // DM_PLAYERS Inst
// @ts-ignore: decorator
@inline function slot(i: i32): Inst { return Inst.at(SLOTS + (<usize>i << 4)); }
// @ts-ignore: decorator
@inline function held(i: i32): bool { return slot(i).state == PadSlotS.Held; }

export function padSlotsInit(): void { for (let i = 0; i < DM_PLAYERS; i++) slot(i).init(PAD_SLOT, <u32>i); }
export function padSlotOf(id: u32): i32 {
  for (let i = 0; id && i < DM_PLAYERS; i++) if (held(i) && <u32>slot(i).data == id) return i;
  return -1;
}
export function padSlotTake(id: u32): i32 {
  let p = padSlotOf(id); if (p >= 0 || !id) return p;
  for (let i = 0; p < 0 && i < DM_PLAYERS; i++) if (slot(i).state == PadSlotS.Kept && <u32>slot(i).data == id) p = i;
  if (p < 0 && !held(0)) p = 0;
  for (let i = 0; p < 0 && i < DM_PLAYERS; i++) if (slot(i).state == PadSlotS.Unused) p = i;
  for (let i = 0; p < 0 && i < DM_PLAYERS; i++) if (!held(i)) p = i;
  if (p < 0) return -1;
  slot(p).step(PadSlotE.Take, <u64>id);
  return p;
}
// nxnative's DM_PAD_PRESS_TO_JOIN: the lowest free slot at a source's first button press, whatever slot it held before
export function padSlotTakeLowest(id: u32): i32 {
  const p = padSlotOf(id); if (p >= 0 || !id) return p;
  for (let i = 0; i < DM_PLAYERS; i++) if (!held(i)) { slot(i).step(PadSlotE.Take, <u64>id); return i; }
  return -1;
}
export function padSlotFree(id: u32): i32 {
  const p = padSlotOf(id);
  if (p >= 0) slot(p).step(PadSlotE.Free, <u64>id);
  return p;
}
export function padSlotMask(): u32 {   // bit p: slot p is held
  let m: u32 = 0; for (let i = 0; i < DM_PLAYERS; i++) if (held(i)) m |= 1 << i;
  return m;
}
