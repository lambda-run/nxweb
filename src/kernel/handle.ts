// The handle table and the kernel events behind event handles (nxnative hle_thread.c: g_h, event_t).
// A handle is 0x1000 + slot, the lowest free slot first, so a closed handle's number is the next one handed out.
export const O_FREE: u32 = 0;
export const O_THREAD: u32 = 1;
export const O_EVENT_R: u32 = 2;    // readable end: WaitSynchronization, ResetSignal, ClearEvent
export const O_EVENT_W: u32 = 3;    // writable end: SignalEvent, ClearEvent
export const O_SESSION: u32 = 4;    // a client session of a port nobody serves (ConnectToNamedPort stub)

export const MAX_H: u32 = 4096;
const TAB: usize = memory.data(32768);    // MAX_H * 8: type u32, object u32
export const MAX_EVENTS: u32 = 2048;
const EVT: usize = memory.data(16384);    // MAX_EVENTS * 8: refs i32 (0 = free slot), signaled u32

export function handlesInit(): void { memory.fill(TAB, 0, 32768); memory.fill(EVT, 0, 16384); }

// A new handle for (type, obj), 0 when the table is full
export function hNew(type: u32, obj: u32): u32 {
  for (let i: u32 = 1; i < MAX_H; i++) {
    const p = TAB + (<usize>i << 3);
    if (load<u32>(p) == O_FREE) { store<u32>(p, type); store<u32>(p, obj, 4); return 0x1000 + i; }
  }
  return 0;
}
// @ts-ignore: decorator
@inline function slotOf(h: u32): u32 { const i = h - 0x1000; return i == 0 || i >= MAX_H ? 0 : i; }
export function hType(h: u32): u32 { const i = slotOf(h); return i ? load<u32>(TAB + (<usize>i << 3)) : O_FREE; }
export function hObj(h: u32): u32 { return load<u32>(TAB + (<usize>slotOf(h) << 3), 4); }
// The object of a handle of this type, -1 when it is no such handle
export function hPeek(h: u32, type: u32): i32 { return hType(h) == type ? <i32>hObj(h) : -1; }
export function hFree(h: u32): void { const i = slotOf(h); if (i) store<u64>(TAB + (<usize>i << 3), 0); }
export function handlesUsed(): u32 {
  let n: u32 = 0;
  for (let i: u32 = 1; i < MAX_H; i++) if (load<u32>(TAB + (<usize>i << 3)) != O_FREE) n++;
  return n;
}
// How many handles of this type name obj (the consistency check counts an event's references this way)
export function handlesTo(type: u32, obj: u32): u32 {
  let n: u32 = 0;
  for (let i: u32 = 1; i < MAX_H; i++) {
    const p = TAB + (<usize>i << 3);
    if (load<u32>(p) == type && load<u32>(p, 4) == obj) n++;
  }
  return n;
}

// ---- events ----
// An event lives while a handle or a synchronization wait refers to it (refs).
export function evNew(refs: i32): i32 {
  for (let i: u32 = 0; i < MAX_EVENTS; i++) {
    const p = EVT + (<usize>i << 3);
    if (load<i32>(p) == 0) { store<i32>(p, refs); store<u32>(p, 0, 4); return i; }
  }
  return -1;
}
// @ts-ignore: decorator
@inline export function evRefs(e: i32): i32 { return load<i32>(EVT + (<usize>e << 3)); }
// @ts-ignore: decorator
@inline export function evRetain(e: i32): void { const p = EVT + (<usize>e << 3); store<i32>(p, load<i32>(p) + 1); }
// @ts-ignore: decorator
@inline export function evRelease(e: i32): void { const p = EVT + (<usize>e << 3); store<i32>(p, load<i32>(p) - 1); }
// @ts-ignore: decorator
@inline export function evSignaled(e: i32): bool { return load<u32>(EVT + (<usize>e << 3), 4) != 0; }
// @ts-ignore: decorator
@inline export function evSet(e: i32, on: bool): void { store<u32>(EVT + (<usize>e << 3), on ? 1 : 0, 4); }
export function eventsLive(): u32 {
  let n: u32 = 0;
  for (let i: u32 = 0; i < MAX_EVENTS; i++) if (load<i32>(EVT + (<usize>i << 3)) != 0) n++;
  return n;
}
