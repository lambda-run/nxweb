// SVC dispatch. The caller's registers are its context block (x0..x30 at +0, docs/CONTRACT.md): arguments are read
// from it and results written to it. Result codes and register conventions are nxnative's (hle_thread.c, hle_svc.c).
import { KthreadS, KthreadE } from "../kit/gen/tables";
import { R_OK, R_OUT_OF_RES, R_BAD_MEMORY, R_BAD_HANDLE, R_TIMEOUT, R_CANCELLED, R_OUT_OF_RANGE, R_BAD_STATE, WAITERS_BIT,
  guestOk, ld32, ld64, st32, st64, lineStart, lineEnd, puts, putx, putu, putc, debugString } from "./base";
import { O_FREE, O_THREAD, O_EVENT_R, O_EVENT_W, O_SESSION, hNew, hType, hObj, hPeek, hFree, evNew, evRelease, evSignaled, evSet, evRetain } from "./handle";
import { KThread, thr, MAX_THREADS, threadNew, threadFree, threadOfHandle, threadsAlive, C_SP, C_PC, C_NZCV, C_FPCR, C_FPSR, C_TPIDR, C_V,
  WK_LOCK, WK_CONDVAR, WK_ADDRESS, WK_SYNC, WK_SLEEP, WK_CLOCK } from "./thread";
import { schedReady, schedYield, schedLeft, schedChanged, schedMoved } from "./sched";
import { PENDING, block, wake, lockHandoff, condSignal, addressWaiters, addressSignal, wakeSyncWaiters, syncOpen, syncClose, syncSignaled,
  refOfThread, refOfEvent } from "./sync";
import { guestTicks, clockReasons, entropy64, REASON_BACKGROUND } from "./clock";
import * as mem from "./mem";

// ---- the process ----
export const STOP_NONE: i32 = 0, STOP_EXIT: i32 = 1, STOP_BREAK: i32 = 2, STOP_KILL: i32 = 3;
export let stopReason: i32 = STOP_NONE;
export let exitCode: i32 = 0;
export let programId: u64 = 0;
export let processId: u64 = 0x50;
let mainThread: i32 = -1;
let breaks: i32 = 0;
const SEEN: usize = memory.data(256);        // unimplemented SVC numbers already reported
const SEEN_INFO: usize = memory.data(64);    // unknown GetInfo types already reported

export function procInit(program: u64, process: u64): void {
  stopReason = STOP_NONE; exitCode = 0; programId = program; processId = process ? process : 0x50; mainThread = -1; breaks = 0;
  memory.fill(SEEN, 0, 256); memory.fill(SEEN_INFO, 0, 64);
}
export function setMainThread(t: KThread): void { mainThread = t.index; }
export function isMainThread(t: KThread): bool { return t.index == mainThread; }

function putHex2(n: u32): void {
  const hi = <u8>((n >> 4) & 15), lo = <u8>(n & 15);
  puts("0x"); putc(hi < 10 ? 48 + hi : 87 + hi); putc(lo < 10 ? 48 + lo : 87 + lo);
}
// Reported once per number, in red: an SVC the kernel does not implement, or only as a stub
function once(n: i32): bool {
  if (load<u8>(SEEN + <usize>(n & 0xFF))) return false;
  store<u8>(SEEN + <usize>(n & 0xFF), 1);
  return true;
}

// The thread ends: synchronization waits on it complete; its record goes once nothing refers to it
export function threadExit(t: KThread): void {
  t.m.step(KthreadE.Exit);
  schedLeft(t);
  wakeSyncWaiters(refOfThread(t));
  if (t.closed && !t.syncRefs) threadFree(t);
}
// Process teardown: every thread leaves, whatever it was doing
export function stopProcess(reason: i32, code: i32): void {
  for (let i = 0; i < MAX_THREADS; i++) {
    const t = thr(i);
    if (!t.alive) continue;
    if (t.waitKind == WK_SYNC) { const n = t.wn; t.wn = 0; for (let k = 0; k < n; k++) syncClose(t.wobj(k)); }
    t.m.step(KthreadE.Terminate);
    schedLeft(t);
  }
  for (let i = 0; i < MAX_THREADS; i++) { const t = thr(i); if (t.used && t.exited && t.closed && !t.syncRefs) threadFree(t); }
  stopReason = reason; exitCode = code;
}

// SetThreadActivity. A pause is a state, never a signal. It takes effect at the target's scheduling point, and under
// green threads every thread but the caller is at one (only the caller executes), so a running thread of another core
// stops at once with its whole context saved. With cores on Workers the machine needs a pending state between the
// request and the target's own scheduling point, and the caller has to wait for it (README, gaps).
function pause(t: KThread): void {
  const s = t.state;
  if (!t.m.can(KthreadE.PauseRequest)) return;   // paused already, or exited: nothing to do, as nxnative
  t.m.step(KthreadE.PauseRequest, t.m.data);
  if (s == KthreadS.Running || s == KthreadS.Runnable) schedLeft(t);
}
function resume(t: KThread): void {
  if (!t.m.can(KthreadE.Resume)) return;
  t.m.step(KthreadE.Resume, t.m.data);
  if (t.state == KthreadS.Runnable) schedReady(t);
}
// Horizon svc::ThreadContext (arm64, 0x320 bytes): r[29], fp, lr, sp, pc, pstate, pad, v[32], fpcr, fpsr, tpidr
function fillContext(t: KThread, out: u64): void {
  const o = <usize>out, c = t.ctx;
  memory.copy(o, c, 0xF8);                                  // x0..x28, fp, lr
  store<u64>(o, load<u64>(c, C_SP), 0xF8);
  store<u64>(o, load<u64>(c, C_PC), 0x100);
  store<u32>(o, load<u32>(c, C_NZCV) << 28, 0x108);         // pstate: N Z C V in bits 31..28
  store<u32>(o, 0, 0x10C);
  memory.copy(o + 0x110, c + C_V, 0x200);
  store<u32>(o, load<u32>(c, C_FPCR), 0x310);
  store<u32>(o, load<u32>(c, C_FPSR), 0x314);
  store<u64>(o, load<u64>(c, C_TPIDR), 0x318);
}

function getInfo(id: u64): u64 {
  switch (<u32>id) {
    case 0: return 7;                  // core mask: cores 0..2, as an application on the Switch
    case 1: return 0;                  // priority mask (nxnative answers 0)
    case 2: return mem.aliasBase;
    case 3: return mem.aliasCap;
    case 4: return mem.heapBase;
    case 5: return mem.heapCap;
    case 6: case 21: return mem.appPool;
    case 7: case 22: return mem.usedMemory();
    case 8: return 0;                  // debugger attached
    case 11: return entropy64();
    case 12: return mem.asBase;
    case 13: return mem.asEnd - mem.asBase;
    case 14: return mem.stackBase;
    case 15: return mem.stackCap;
    case 16: return mem.sysResource;
    case 17: return mem.sysResource ? 0x400000 : 0;
    case 18: return programId;
    case 20: return mem.tlsBase;       // user exception context: a real page (newer SDKs write to +0x1C0)
    case 23: return 1;                 // is application
    case 24: { const u = threadsAlive(); return u < 96 ? 96 - u : 0; }   // free thread count: pm's limit of 96
    case 33: return 0x1000;            // page size (Switch 2 SDKs)
    case 25: case 26: case 27: case 28: case 29: case 30: case 31: case 32: return 0;
    default:
      if (id >= 64 || !load<u8>(SEEN_INFO + <usize>id)) {
        if (id < 64) store<u8>(SEEN_INFO + <usize>id, 1);
        lineStart("[RED] svc GetInfo: unknown info type "); putu(id); puts(" (answered 0)"); lineEnd();
      }
      return 0;
  }
}

// One SVC of thread t. Results are in t's context when this returns, or come later (the thread waits).
export function svc(t: KThread, n: i32): void {
  const x0 = t.x(0), x1 = t.x(1), x2 = t.x(2), x3 = t.x(3);
  let r: u64 = R_OK;
  switch (n) {
    // ---- memory ----
    case 0x01: {  // SetHeapSize(x1 size) -> x1 heap base
      r = mem.setHeapSize(x1);
      if (!r) t.setX(1, mem.heapBase);
      break;
    }
    case 0x02: case 0x03: r = mem.permissionStub(x0, x1); break;
    case 0x04: r = mem.mapMemory(x0, x1, x2); break;
    case 0x05: r = mem.unmapMemory(x0, x1, x2); break;
    case 0x06: {  // QueryMemory(x0 MemoryInfo*, x2 address) -> w1 PageInfo
      if (x0 && !guestOk(x0, 40)) { r = R_BAD_MEMORY; break; }
      mem.queryMemory(x2);
      if (x0) {
        st64(x0, mem.qBase); st64(x0 + 8, mem.qSize);
        st32(x0 + 16, mem.qState); st32(x0 + 20, mem.qAttr); st32(x0 + 24, mem.qPerm);
        st32(x0 + 28, 0); st32(x0 + 32, 0); st32(x0 + 36, 0);   // IPC count, device count, padding
      }
      t.setX(1, 0);
      break;
    }
    case 0x2C: case 0x2D: r = mem.physicalMemory(x0, x1, n == 0x2C); break;

    // ---- process ----
    case 0x07: stopProcess(STOP_EXIT, <i32>x0); return;   // ExitProcess; w0 = exit code (test guest ABI)
    case 0x24: t.setX(1, processId); break;               // GetProcessId
    case 0x26: {  // Break(x0 reason, x1 pointer, x2 size)
      const res: u32 = x1 && x2 >= 4 && guestOk(x1, 4) ? ld32(x1) : 0;
      const fatal = !(x0 & 0x80000000);
      lineStart(fatal ? "[RED] Break#" : "Break#"); putu(++breaks); puts(" reason="); putx(x0); puts(" Result="); putx(res);
      puts(" lr="); putx(t.x(30)); puts(fatal ? ": the process stops" : " (notification only)"); lineEnd();
      if (fatal) stopProcess(STOP_BREAK, 42);
      return;   // a notification leaves the registers as they are
    }
    case 0x27: {  // OutputDebugString(x0 string, x1 length)
      if (!guestOk(x0, x1)) { r = R_BAD_MEMORY; break; }
      debugString(<usize>x0, <i32>x1);
      break;
    }
    case 0x1E: {  // GetSystemTick. A guest read of the counter waits while the app is in the background
      if (clockReasons() & (1 << REASON_BACKGROUND)) { block(t, WK_CLOCK, -1); return; }
      t.setX(0, guestTicks()); t.setX(1, guestTicks());
      return;
    }
    case 0x29: t.setX(1, getInfo(x1)); break;   // GetInfo(w1 type, w2 handle, x3 sub type) -> x1
    case 0x1F: {  // ConnectToNamedPort(x1 name) -> w1 session. No port is served: a stub session
      const h = hNew(O_SESSION, 0);
      if (once(n)) {
        lineStart("[RED] svc "); putHex2(n); puts(" unimplemented: ConnectToNamedPort \"");
        for (let i: u64 = 0; i < 11 && guestOk(x1 + i, 1) && load<u8>(<usize>(x1 + i)); i++) putc(load<u8>(<usize>(x1 + i)));
        puts("\" gets a session nobody serves"); lineEnd();
      }
      if (!h) { r = R_OUT_OF_RES; break; }
      t.setX(1, h);
      break;
    }
    case 0x21: {  // SendSyncRequest(w0 session): success with the message buffer untouched, as nxnative's placeholder
      if (once(n)) { lineStart("[RED] svc "); putHex2(n); puts(" unimplemented: SendSyncRequest on handle "); putx(<u32>x0); puts(" answered 0 with no reply"); lineEnd(); }
      break;
    }

    // ---- threads ----
    case 0x08: {  // CreateThread(x1 entry, x2 argument, x3 stack top, w4 priority, w5 core) -> w1 handle
      const nt = threadNew(x1, x2, x3, <i32>t.x(4), <i32>t.x(5));
      const h = nt != null ? hNew(O_THREAD, <u32>nt.index) : 0;
      if (nt == null || !h) {
        if (nt != null) nt.used = false;
        lineStart("[RED] kernel: CreateThread: no free "); puts(nt == null ? "thread slot" : "handle"); lineEnd();
        r = R_OUT_OF_RES; break;
      }
      nt.handle = h;
      t.setX(1, h);
      break;
    }
    case 0x09: {  // StartThread(w0)
      const s = threadOfHandle(<u32>x0, t);
      if (s == null) { r = R_BAD_HANDLE; break; }
      if (s.m.can(KthreadE.Start)) { s.m.step(KthreadE.Start); if (s.state == KthreadS.Runnable) schedReady(s); }
      break;
    }
    case 0x0A: threadExit(t); return;
    case 0x0B: {  // SleepThread(x0 ns); 0, -1, -2 are the yields
      const ns = <i64>x0;
      if (ns > 0) { block(t, WK_SLEEP, ns); return; }
      t.m.step(KthreadE.Yield);
      schedYield(t, ns == -2);
      return;
    }
    case 0x0C: {  // GetThreadPriority(w1) -> w1
      const s = threadOfHandle(<u32>x1, t);
      t.setX(1, s != null ? <u64>s.prio : 0);
      if (s == null) r = R_BAD_HANDLE;
      break;
    }
    case 0x0D: {  // SetThreadPriority(w0, w1)
      const s = threadOfHandle(<u32>x0, t);
      if (s == null) { r = R_BAD_HANDLE; break; }
      s.prio = <i32>x1; schedChanged();
      break;
    }
    case 0x0E: {  // GetThreadCoreMask(w2) -> w1 ideal core, x2 mask
      const s = threadOfHandle(<u32>x2, t);
      t.setX(1, s != null ? <u64><u32>s.core : 0); t.setX(2, s != null ? s.mask : 0);
      if (s == null) r = R_BAD_HANDLE;
      break;
    }
    case 0x0F: {  // SetThreadCoreMask(w0, w1 ideal core, x2 mask): -2 the process default, -1 no ideal core, -3 keep it
      const s = threadOfHandle(<u32>x0, t);
      if (s == null) { r = R_BAD_HANDLE; break; }
      const c = <i32>x1;
      if (c >= 0) s.core = c;
      if (c == -2) { s.core = 0; s.mask = 1; } else if (x2) s.mask = x2;
      // an ideal core outside the new mask moves to the mask's lowest core, as on Horizon
      if (s.mask && (s.core < 0 || s.core > 63 || !((s.mask >> s.core) & 1))) s.core = <i32>ctz<u64>(s.mask);
      schedMoved(s);
      break;
    }
    case 0x10: {  // GetCurrentProcessorNumber: never negative
      const c = t.core;
      t.setX(0, <u64><u32>(c >= 0 ? c : t.mask ? <i32>ctz<u64>(t.mask) : 0));
      return;
    }
    case 0x25: {  // GetThreadId(w1) -> x1
      const s = threadOfHandle(<u32>x1, t);
      t.setX(1, s != null ? s.id : 0);
      if (s == null) r = R_BAD_HANDLE;
      break;
    }
    case 0x32: {  // SetThreadActivity(w0 thread, w1 activity: 1 paused, else runnable)
      const s = threadOfHandle(<u32>x0, t);
      if (s == null) r = R_BAD_HANDLE;
      else if (s == t) r = R_BAD_STATE;
      else if (<i32>x1 == 1) pause(s);
      else resume(s);
      break;
    }
    case 0x33: {  // GetThreadContext3(x0 ThreadContext*, w1 thread): only of a paused thread
      const s = threadOfHandle(<u32>x1, t);
      if (s == null) r = R_BAD_HANDLE;
      else if (!s.paused) r = R_BAD_STATE;
      else if (!guestOk(x0, 0x320)) r = R_BAD_MEMORY;
      else fillContext(s, x0);
      break;
    }

    // ---- locks and condition variables ----
    case 0x1A: {  // ArbitrateLock(w0 owner handle, x1 address, w2 this thread's tag)
      if (!guestOk(x1, 4)) { r = R_BAD_MEMORY; break; }
      if (ld32(x1) == (<u32>x0 | WAITERS_BIT)) {
        t.waddr = x1; t.wtag = <u32>x2;
        const o = threadOfHandle(<u32>x0, null);
        t.wowner = o != null ? o.index : -1;
        r = block(t, WK_LOCK, -1);
      }
      break;
    }
    case 0x1B: {  // ArbitrateUnlock(x0 address)
      if (!guestOk(x0, 4)) { r = R_BAD_MEMORY; break; }
      lockHandoff(x0);
      break;
    }
    case 0x1C: {  // WaitProcessWideKeyAtomic(x0 lock address, x1 key address, w2 tag, x3 timeout)
      if (!guestOk(x0, 4) || !guestOk(x1, 4)) { r = R_BAD_MEMORY; break; }
      // The order matters: the key says "a waiter exists" before the lock is released. The SDK's Signal reads the
      // key in user mode and makes no SVC when it is 0, so a thread that takes the lock after the release must see it.
      st32(x1, 1);
      t.wkey = x1; t.waddr = x0; t.wtag = <u32>x2;
      lockHandoff(x0);
      r = block(t, WK_CONDVAR, <i64>x3);   // a timeout does not take the lock back: user mode does
      break;
    }
    case 0x1D: {  // SignalProcessWideKey(x0 key address, w1 count)
      if (!guestOk(x0, 4)) { r = R_BAD_MEMORY; break; }
      condSignal(x0, <i32>x1);
      break;
    }

    // ---- address arbiter ----
    case 0x34: {  // WaitForAddress(x0 address, w1 type, x2 value, x3 timeout)
      const type = <i32>x1, val = <i32>x2;
      if (!guestOk(x0, type == 3 ? 8 : 4)) { r = R_BAD_MEMORY; break; }
      const v = ld32(x0);
      // 0 wait if less than, 1 decrement and wait if less than, 2 wait if equal, 3 wait if the 64-bit value is equal
      const ok = type == 3 ? ld64(x0) == x2 : type == 2 ? <i32>v == val : <i32>v < val;
      if (!ok) { r = R_BAD_STATE; break; }
      if (type == 1) st32(x0, v - 1);
      t.waddr = x0;
      r = block(t, WK_ADDRESS, <i64>x3);
      break;
    }
    case 0x35: {  // SignalToAddress(x0 address, w1 type, w2 value, w3 count)
      const type = <i32>x1, val = <i32>x2, cnt = <i32>x3;
      if (!guestOk(x0, 4)) { r = R_BAD_MEMORY; break; }
      if (type != 0) {
        let nv = val + 1;   // 1: increment if equal
        if (type == 2) {    // 2: modify by the number of waiters if equal. Waking all with waiters subtracts 2
          const nw = addressWaiters(x0);
          if (cnt <= 0) nv = nw > 0 ? val - 2 : val + 1;
          else nv = nw == 0 ? val + 1 : nw <= cnt ? val - 1 : val;
        }
        if (ld32(x0) != <u32>val) { r = R_BAD_STATE; break; }
        st32(x0, <u32>nv);
      }
      addressSignal(x0, cnt);
      break;
    }

    // ---- events and synchronization ----
    case 0x45: {  // CreateEvent -> w1 writable end, w2 readable end
      const e = evNew(2);
      const hw = e >= 0 ? hNew(O_EVENT_W, <u32>e) : 0, hr = hw ? hNew(O_EVENT_R, <u32>e) : 0;
      if (!hr) {
        if (hw) hFree(hw);
        if (e >= 0) { evRelease(e); evRelease(e); }
        lineStart("[RED] kernel: CreateEvent: no free event or handle"); lineEnd();
        r = R_OUT_OF_RES; break;
      }
      t.setX(1, hw); t.setX(2, hr);
      break;
    }
    case 0x11: case 0x12: case 0x17: {  // SignalEvent(writable) / ClearEvent(either end) / ResetSignal(readable)
      const h = <u32>x0;
      let e = n == 0x11 ? hPeek(h, O_EVENT_W) : n == 0x17 ? hPeek(h, O_EVENT_R) : hPeek(h, O_EVENT_W);
      if (e < 0 && n == 0x12) e = hPeek(h, O_EVENT_R);
      if (e < 0) r = R_BAD_HANDLE;
      else if (n == 0x11) { evSet(e, true); wakeSyncWaiters(refOfEvent(e)); }
      else if (n == 0x17 && !evSignaled(e)) r = R_BAD_STATE;
      else evSet(e, false);
      break;
    }
    case 0x18: {  // WaitSynchronization(x1 handle array, w2 count, x3 timeout) -> w1 index
      const cnt = <i32>x2, ns = <i64>x3;
      t.setX(1, 0);
      if (cnt < 0 || cnt > 64) { r = R_OUT_OF_RANGE; break; }
      if (cnt && !guestOk(x1, <u64>cnt * 4)) { r = R_BAD_MEMORY; break; }
      // Resolve and retain the whole list before looking at readiness: an invalid later handle is an error even
      // when an earlier object is signaled, and a close cannot redirect the wait to a reused handle number
      let held = 0;
      for (; held < cnt; held++) {
        const ref = syncOpen(ld32(x1 + <u64>held * 4));
        if (!ref) break;
        t.setWobj(held, ref);
      }
      r = R_BAD_HANDLE;
      if (held == cnt) {
        let idx = -1;
        for (let i = 0; i < cnt; i++) if (syncSignaled(t.wobj(i))) { idx = i; break; }
        // ready objects, then a zero-time poll, come before a pending cancellation
        if (idx >= 0) { r = R_OK; t.setX(1, <u64>idx); }
        else if (!ns) r = R_TIMEOUT;
        else if (t.cancel) { t.cancel = false; r = R_CANCELLED; }
        else { t.wn = cnt; t.widx = -1; block(t, WK_SYNC, ns); return; }   // wake() lets the objects go
      }
      for (let i = 0; i < held; i++) syncClose(t.wobj(i));
      break;
    }
    case 0x19: {  // CancelSynchronization(w0 thread): ends its wait now, or else its next one
      const s = threadOfHandle(<u32>x0, t);
      if (s == null) { r = R_BAD_HANDLE; break; }
      if (s.waitKind == WK_SYNC) wake(s, R_CANCELLED); else s.cancel = true;
      break;
    }
    case 0x16: closeHandle(<u32>x0); break;   // CloseHandle(w0): always success, as nxnative

    default:
      if (once(n)) {
        lineStart("[RED] svc "); putHex2(n); puts(" unimplemented (x0="); putx(x0); puts(" x1="); putx(x1); puts(" x2="); putx(x2); puts("; answered 0)"); lineEnd();
      }
      break;
  }
  if (r != PENDING) t.setX(0, r);
}

// ---- what the embedder's services do with events (nxnative hle_new_event, hle_dup_readable_handle) ----
// A new event: its readable handle; its writable handle is stored at writeOut unless that is 0
// CloseHandle, for the SVC and for the embedder (kernel_handle_close). False when h is no handle.
export function closeHandle(h: u32): bool {
  const ty = hType(h);
  if (ty == O_EVENT_R || ty == O_EVENT_W) { evRelease(<i32>hObj(h)); hFree(h); }
  else if (ty == O_THREAD) {
    const s = thr(<i32>hObj(h));
    hFree(h);
    s.closed = true;
    if (s.exited && !s.syncRefs) threadFree(s);
  } else if (ty == O_SESSION) hFree(h);
  else return false;
  return true;
}
// A counter read (`mrs cntpct_el0`) by running thread t while the app is in the background: the thread waits for the
// clock as GetSystemTick does, but its wake writes no result (the embedder runs the read again). False: no wait.
export function clockWait(t: KThread): bool {
  if (!(clockReasons() & (1 << REASON_BACKGROUND))) return false;
  t.quiet = true;
  block(t, WK_CLOCK, -1);
  return true;
}
export function hostEventNew(writeOut: usize): u32 {
  const e = evNew(writeOut ? 2 : 1);
  if (e < 0) return 0;
  const hr = hNew(O_EVENT_R, <u32>e);
  if (writeOut) store<u32>(writeOut, hNew(O_EVENT_W, <u32>e));
  return hr;
}
export function hostDupReadable(h: u32): u32 {
  const e = hPeek(h, O_EVENT_R);
  if (e < 0) return 0;
  evRetain(e);
  return hNew(O_EVENT_R, <u32>e);
}
export function hostEventSignal(h: u32): bool {
  const e = hPeek(h, O_EVENT_W);
  if (e < 0) return false;
  evSet(e, true); wakeSyncWaiters(refOfEvent(e));
  return true;
}
export function hostEventClear(h: u32): bool {
  let e = hPeek(h, O_EVENT_W);
  if (e < 0) e = hPeek(h, O_EVENT_R);
  if (e < 0) return false;
  evSet(e, false);
  return true;
}
