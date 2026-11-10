// The service layer's SystemEvents: port of nxnative dm/host/hle_thread.c hle_bind_system_event / hle_signal_system_event /
// hle_clear_system_event and the binding table g_se.
//
// On a console a service hands its client the read end of a kernel event and the guest waits on it through the SDK's
// nn::os. nxnative has the SDK make the event: it calls the SDK's own nn::os::CreateSystemEvent(event, clear mode,
// inter-process = true) on the guest thread (the SDK creates the kernel event through svc 0x45 and fills the
// SystemEventType), reads the write end back with GetWritableHandleOfSystemEvent, and remembers it by the address of
// the SystemEventType. The same here, through the imports hle_guest_sym and hle_guest_call.
import { guestSym, guestCall1, guestCall3, eventSignal, eventClear, eventNew, ls, ps, px, le, red } from "./base";

const MAX: i32 = 256;
const REC: usize = 24;                       // +0 u64 event address, +8 u32 write handle, +12 u32 used, +16 u64 binding id
const TAB: usize = memory.data(6144);        // MAX * REC
let count: i32 = 0;
let nextId: u64 = 1;
let fnCreate: u64 = 0, fnGetW: u64 = 0, looked: bool = false, noSdkRed: bool = false;
const WOUT: usize = memory.data(8);

export function seInit(): void { count = 0; nextId = 1; fnCreate = 0; fnGetW = 0; looked = false; noSdkRed = false; }

function find(ev: usize): i32 {
  for (let i = 0; i < count; i++) if (load<u64>(TAB + <usize>i * REC) == <u64>ev) return i;
  return -1;
}
function remove(i: i32): void {
  count--;
  if (i != count) memory.copy(TAB + <usize>i * REC, TAB + <usize>count * REC, REC);
}
// The write handle of a bound event, 0 when it is not bound
export function seHandle(ev: usize): u32 { const i = find(ev); return i < 0 ? 0 : load<u32>(TAB + <usize>i * REC, 8); }
// The binding's lifetime id, 0 when not bound: a rebind gets a new one even at the same address
export function seBinding(ev: usize): u64 { const i = find(ev); return i < 0 ? 0 : load<u64>(TAB + <usize>i * REC, 16); }
export function seCount(): i32 { return count; }

// Bind the guest SystemEventType at ev to a kernel event. Must be on a guest thread (it runs SDK code).
export function seBind(ev: usize, autoclear: i32): void {
  if (find(ev) >= 0) return;
  if (!looked) {
    looked = true;
    fnCreate = guestSym("_ZN2nn2os17CreateSystemEventEPNS0_15SystemEventTypeENS0_14EventClearModeEb");
    fnGetW = guestSym("_ZN2nn2os30GetWritableHandleOfSystemEventEPKNS0_15SystemEventTypeE");
  }
  let wh: u32 = 0;
  if (fnCreate && fnGetW) {
    const r = <u32>guestCall3(fnCreate, <u64>ev, <u64>autoclear, 1);
    if (r) { ls(); ps("[RED] CreateSystemEvent failed "); px(r); ps(" for the event at "); px(ev); ps(": not bound"); le(); return; }
    wh = <u32>guestCall1(fnGetW, <u64>ev);
  } else {
    // No SDK in the guest (nxnative always has one and would call a null pointer here). The event exists for the
    // host's side; the guest's SystemEventType is left as it is, since its layout is the SDK's business
    if (!noSdkRed) { noSdkRed = true; red("no nn::os::CreateSystemEvent in the guest: service events are host-only kernel events, the guest's SystemEventType is not filled"); }
    store<u32>(WOUT, 0);
    eventNew(WOUT);
    wh = load<u32>(WOUT);
  }
  if (count >= MAX) { red("SystemEvent binding table full: the event is not bound"); return; }
  const p = TAB + <usize>count * REC;
  store<u64>(p, <u64>ev); store<u32>(p, wh, 8); store<u32>(p, 1, 12); store<u64>(p, nextId++, 16);
  count++;
}
// Signal; an unbound one is bound on the spot as manual-clear
export function seSignal(ev: usize): void {
  for (let pass = 0; pass < 2; pass++) {
    const i = find(ev);
    if (i >= 0) {
      if (eventSignal(load<u32>(TAB + <usize>i * REC, 8))) return;
      // the game closed the handle and the embedder did not say so (hle_handle_closed): bind again, as after an unbind
      remove(i);
    }
    if (pass) { ls(); ps("[RED] SystemEvent "); px(ev); ps(" still not bound after binding: not signalled"); le(); return; }
    seBind(ev, 0);
  }
}
// Signal only this binding lifetime; false once its write handle is closed
export function seSignalBinding(id: u64): bool {
  for (let i = 0; i < count; i++) if (load<u64>(TAB + <usize>i * REC, 16) == id) {
    if (eventSignal(load<u32>(TAB + <usize>i * REC, 8))) return true;
    remove(i); return false;
  }
  return false;
}
// Clear a bound one; an unbound one has nothing to clear
export function seClear(ev: usize): void {
  const i = find(ev);
  if (i >= 0 && !eventClear(load<u32>(TAB + <usize>i * REC, 8))) remove(i);
}
// The guest closed kernel handle h (CloseHandle unbinds through the table in nxnative)
export function seHandleClosed(h: u32): void {
  for (let i = 0; i < count; i++) if (load<u32>(TAB + <usize>i * REC, 8) == h) { remove(i); return; }
}
