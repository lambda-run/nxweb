// The kernel module's entry file: what the embedder calls. See README.md.
// Every entry point takes the kernel lock (base.ts); the kernel never blocks and never reads a clock.
export * from "../kit/exports";
import { KthreadS, KthreadE } from "../kit/gen/tables";
import { kLock, kUnlock, mtWorkers, mtSetWorkers, kickWord, ACT_ACK, ACT_CONTINUE, ACT_SWITCH, ACT_STOP, FOREVER, WAITERS_BIT, guestOk, ld32, lineStart, lineEnd, puts, putx } from "./base";
import { handlesInit, handlesUsed, handlesCountEvents, eventsLive, evRefs, O_THREAD, O_EVENT_R, O_EVENT_W, MAX_EVENTS, hPeek, hNew } from "./handle";
import { KThread, thr, MAX_THREADS, NCORES, threadsInit, threadNew, threadOfCtx, threadsAlive, threadObjects, WK_LOCK, WK_SYNC } from "./thread";
import { schedInit, schedReady, scheduleNext, scheduleCore, schedMustSwitch, schedSliceEnded, schedCurrent } from "./sched";
import { syncInit, expire, nextDeadline, wakeClockWaiters } from "./sync";
import { clockInit, clockSetNow, clockFreeze, clockReasons, guestNs, guestTicks, hostTimeOf, entropySeed, REASON_BACKGROUND } from "./clock";
import * as mem from "./mem";
import { svc, procInit, setMainThread, isMainThread, threadExit, stopProcess, stopReason, exitCode, STOP_NONE, STOP_EXIT, STOP_KILL,
  hostEventNew, hostDupReadable, hostEventSignal, hostEventClear, closeHandle, clockWait, pendApply } from "./svc";

export const KERNEL_ACT_CONTINUE: i32 = ACT_CONTINUE;
export const KERNEL_ACT_SWITCH: i32 = ACT_SWITCH;
export const KERNEL_ACT_STOP: i32 = ACT_STOP;

const F_MAP_LIMIT: u64 = 1;    // maps past the application pool fail (nxnative profile key mem_map_limit)
const F_SWITCH2: u64 = 2;      // the system counter runs at 31.25 MHz
const F_NO_INHERIT: u64 = 4;   // lock owners do not inherit their waiters' priority

// Start a process. cfg = 0: the default layout and values. Else a block of 16 little-endian u64:
//   +0 code base, +8 code size, +16 thread-local base, +24 size, +32 heap base, +40 heap region size, +48 stack base,
//   +56 stack region size, +64 alias base, +72 alias region size, +80 application pool, +88 used memory reported
//   beside the heap, +96 system resource size, +104 program id, +112 flags (1 map limit, 2 Switch 2 counter,
//   4 no priority inheritance), +120 process id (0 = 0x50)
// Returns 0, or a layout error (mem.ts E_LAYOUT_*), with a red line.
export function kernel_init(cfg: usize): i32 {
  kLock();
  const flags: u64 = cfg ? load<u64>(cfg, 112) : 0;
  handlesInit(); threadsInit(); syncInit();
  schedInit(!(flags & F_NO_INHERIT));
  clockInit((flags & F_SWITCH2) != 0);
  procInit(cfg ? load<u64>(cfg, 104) : 0, cfg ? load<u64>(cfg, 120) : 0);
  const e = mem.memInit(cfg, (flags & F_MAP_LIMIT) != 0);
  if (e) { lineStart("[RED] kernel: invalid address-space layout (error "); putx(e); puts(")"); lineEnd(); }
  kUnlock();
  return e;
}
// The end of the kernel's own static memory: every guest region must start at or above it when the kernel's
// memory is the guest memory
export function kernel_static_end(): usize { return __heap_base; }

// The main thread: priority 44, core 0, started. x0 = 0, x1 = its handle, sp, pc = entry, x30 = the thread-exit pc.
// Returns its handle (0x1001 in a new process), 0 on failure.
export function kernel_create_main_thread(entry: u64, stackTop: u64): u32 {
  kLock();
  let h: u32 = 0;
  const t = threadNew(entry, 0, stackTop, 44, 0);
  if (t != null) {
    h = hNew(O_THREAD, <u32>t.index);
    t.handle = h; t.setX(1, h);
    setMainThread(t);
    t.m.step(KthreadE.Start); schedReady(t);
  }
  kUnlock();
  return h;
}

// An SVC of the thread whose context block is at ctx (the embedder called save_ctx(ctx) with pc = the instruction
// after the svc). KERNEL_ACT_CONTINUE: results are in the block, load_ctx(ctx) and go on. KERNEL_ACT_SWITCH: the
// thread gave up its core (it waits, yielded, exited, or a better thread is ready); unwind and call kernel_schedule.
// KERNEL_ACT_STOP: the process ended.
export function kernel_svc(n: i32, ctx: usize): i32 {
  kLock();
  const act = svcLocked(n, ctx);
  kUnlock();
  return act;
}
// The same with kernel_tick(now) first, under one taking of the lock (SPIKE: an SVC then costs one lock, not two)
export function kernel_svc_at(n: i32, ctx: usize, now: u64): i32 {
  kLock();
  clockSetNow(now);
  if (stopReason == STOP_NONE) expire();
  const act = svcLocked(n, ctx);
  kUnlock();
  return act;
}
function svcLocked(n: i32, ctx: usize): i32 {
  let act = ACT_STOP;
  if (stopReason == STOP_NONE) {
    const t = threadOfCtx(ctx);
    if (t == null || t.state != KthreadS.Running) {
      lineStart("[RED] kernel: svc "); putx(n); puts(" from a context that is not a running thread: "); putx(ctx); lineEnd();
      act = ACT_SWITCH;
    } else {
      svc(t, n);
      if (mtWorkers()) { pendApply(t); if (t.state != KthreadS.Running) t.ackFor = 0; }
      act = stopReason != STOP_NONE ? ACT_STOP : t.ackFor ? ACT_ACK : schedMustSwitch(t) ? ACT_SWITCH : ACT_CONTINUE;
    }
  }
  return act;
}
// The context block of the thread to run next, 0 when every thread waits (kernel_next_timeout says until when) or
// the process ended. The cores take turns; see kernel_schedule_core for one core.
export function kernel_schedule(): usize {
  kLock();
  const t = stopReason == STOP_NONE ? scheduleNext() : null;
  kUnlock();
  return t != null ? t.ctx : 0;
}
// One core's scheduling point (for an embedder that runs each virtual core on its own host thread)
export function kernel_schedule_core(core: i32): usize {
  kLock();
  const t = stopReason == STOP_NONE && core >= 0 && core < NCORES ? scheduleCore(core) : null;
  kUnlock();
  return t != null ? t.ctx : 0;
}
// The thread's time slice ran out (`budget` reached 0; its context is saved): threads of its priority on its core
// take turns. Then call kernel_schedule.
export function kernel_preempt(ctx: usize): void {
  kLock();
  const t = threadOfCtx(ctx);
  if (t != null) { if (mtWorkers()) pendApply(t); schedSliceEnded(t); }
  kUnlock();
}
// The thread returned from its entry function (pc = 0xFFFF_FFF0). The main thread: the process ends with exit code
// w0 (test guest ABI). Any other thread: a red line, and it exits as by ExitThread.
export function kernel_thread_returned(ctx: usize): i32 {
  kLock();
  const t = threadOfCtx(ctx);
  if (t != null && t.state == KthreadS.Running && stopReason == STOP_NONE) {
    if (isMainThread(t)) stopProcess(STOP_EXIT, <i32>t.x(0));
    else {
      lineStart("[RED] kernel: thread "); putx(t.handle); puts(" returned from its entry function (Horizon requires ExitThread): exited"); lineEnd();
      threadExit(t);
    }
  }
  const act = stopReason != STOP_NONE ? ACT_STOP : ACT_SWITCH;
  kUnlock();
  return act;
}
// ---- SPIKE: guest cores on Workers (src/spike_workers, SPIKE.md). Only in a build with the threads feature. ----
// workers > 0: every Worker has its own instance of this module on the one shared memory; Worker w runs the virtual
// cores c with c % workers == w. 0: green threads (the default). Call once, before any Worker enters the kernel.
const MTCUR: usize = memory.data(16);   // per Worker: which of its cores has the next turn
export function kernel_mt_config(workers: i32, lockSpin: i32): void { mtSetWorkers(workers < 0 || workers > NCORES ? 0 : workers, lockSpin); memory.fill(MTCUR, 0, 16); }
// The word Worker w waits on while none of its cores has a thread (memory.atomic.wait with the value read under the
// lock by kernel_mt_schedule; any change of a core's ready set bumps and notifies it)
export function kernel_mt_kick_word(worker: i32): usize { return kickWord(worker); }
// Worker w's scheduling point: the context block of the thread to run on one of its cores (they take turns), 0 = all
// of them are idle. The kick word's value as of this decision is stored at genOut (u32).
export function kernel_mt_schedule(worker: i32, genOut: usize): usize {
  kLock();
  let t: KThread | null = null;
  const n = mtWorkers();
  if (stopReason == STOP_NONE && n > 0) {
    const turns = (NCORES - worker + n - 1) / n, p = MTCUR + (<usize>(worker & 3) << 2);
    for (let i = 0; i < turns && t == null; i++) {
      const k = (load<i32>(p) + i) % turns;
      t = scheduleCore(worker + k * n);
      if (t != null) store<i32>(p, (k + 1) % turns);
    }
  }
  store<u32>(genOut, load<u32>(kickWord(worker)));
  kUnlock();
  return t != null ? t.ctx : 0;
}
// After kernel_svc returned KERNEL_ACT_ACK: the address of the word (u32) that is 1 until the pause this SVC asked for
// has taken effect on the target's Worker. Wait for 0 (memory.atomic.wait), then go on as after KERNEL_ACT_CONTINUE.
export function kernel_mt_ack_word(ctx: usize): usize {
  kLock();
  const t = threadOfCtx(ctx);
  let p: usize = 0;
  if (t != null && t.ackFor) { p = changetype<usize>(thr(t.ackFor - 1)) + offsetof<KThread>("pendw"); t.ackFor = 0; }
  kUnlock();
  return p;
}
export const KERNEL_ACT_ACK: i32 = ACT_ACK;

// The host's monotonic time in ns. Waits whose deadline has come on the guest clock end here.
export function kernel_tick(now: u64): void {
  kLock();
  clockSetNow(now);
  if (stopReason == STOP_NONE) expire();
  kUnlock();
}
// The host time (kernel_tick's scale) of the earliest wait deadline; u64 max when there is none or the guest clock stands
export function kernel_next_timeout(): u64 {
  kLock();
  const d = nextDeadline();
  const r = d == FOREVER ? FOREVER : hostTimeOf(d);
  kUnlock();
  return r;
}

// ---- guest clock ----
// Hold (on != 0) or release a freeze reason: 0 a test or loading hold, 1 the app is in the background, 2 the system
// keyboard is up. The clock runs only while no reason holds.
export function kernel_clock_freeze(reason: u32, on: i32): void {
  kLock();
  const ended = clockFreeze(reason, on != 0);
  if (ended & (1 << REASON_BACKGROUND)) wakeClockWaiters();
  kUnlock();
}
export function kernel_clock_reasons(): u32 { return clockReasons(); }
export function kernel_guest_ns(): u64 { kLock(); const v = guestNs(); kUnlock(); return v; }
// The system counter, for the translator's `mrs cntpct_el0`. While kernel_clock_reasons() has bit 1 (background) a
// guest read must wait: make the thread yield instead of reading.
export function kernel_guest_ticks(): u64 { kLock(); const v = guestTicks(); kUnlock(); return v; }
export function kernel_seed_entropy(seed: u64): void { entropySeed(seed); }
// `mrs cntpct_el0` of the running thread whose context block is at ctx (saved with pc = the instruction itself, the
// translator's cntYield): while the background freeze holds, the thread waits for the clock and KERNEL_ACT_SWITCH is
// returned; its wake changes no register, so the embedder resumes it at the read. Otherwise KERNEL_ACT_CONTINUE.
export function kernel_clock_wait(ctx: usize): i32 {
  kLock();
  let act = ACT_CONTINUE;
  const t = threadOfCtx(ctx);
  if (stopReason != STOP_NONE) act = ACT_STOP;
  else if (t != null && t.state == KthreadS.Running && clockWait(t)) act = ACT_SWITCH;
  kUnlock();
  return act;
}

// ---- memory the embedder tells the kernel about ----
// A loaded image: [base, base+ro) code, [base+ro, base+data) read-only data, [base+data, base+size) data and bss.
// Returns its index, -1 when refused (not page-aligned, outside the code region, overlapping, table full).
export function kernel_module_add(base: u64, size: u64, ro: u64, data: u64): i32 { kLock(); const r = mem.moduleAdd(base, size, ro, data); kUnlock(); return r; }
// 1 = removed; 0 = unknown, or a mapped thread stack still borrows its data
export function kernel_module_remove(base: u64): i32 { kLock(); const r = mem.moduleRemove(base); kUnlock(); return r ? 1 : 0; }
// Guest memory a device maps (share != 0) or no longer maps: it is not unmapped while registered
export function kernel_device_share(addr: u64, size: u64, share: i32): void { kLock(); mem.deviceShare(addr, size, share != 0); kUnlock(); }

// A stack for a thread the embedder starts itself (the main thread): [base, base + size) in the stack region becomes
// a mapped stack (QueryMemory: state 0xB, read/write) of zeroes. 1 = mapped, 0 = refused.
export function kernel_map_stack(base: u64, size: u64): i32 { kLock(); const r = mem.hostStackMap(base, size); kUnlock(); return r ? 1 : 0; }
// svcQueryMemory for the embedder (fault reports, stack checks): the segment around addr.
// out (32 bytes): +0 base u64, +8 size u64, +16 state u32, +20 attribute u32, +24 permission u32
export function kernel_query_memory(addr: u64, out: usize): void {
  kLock();
  mem.queryMemory(addr);
  store<u64>(out, mem.qBase, 0); store<u64>(out, mem.qSize, 8);
  store<u32>(out, mem.qState, 16); store<u32>(out, mem.qAttr, 20); store<u32>(out, mem.qPerm, 24); store<u32>(out, 0, 28);
  kUnlock();
}

// ---- events for the embedder's services ----
// A new kernel event: returns its readable handle; its writable handle is stored (u32) at writeOut unless that is 0
export function kernel_event_new(writeOut: usize): u32 { kLock(); const r = hostEventNew(writeOut); kUnlock(); return r; }
export function kernel_event_dup_readable(h: u32): u32 { kLock(); const r = hostDupReadable(h); kUnlock(); return r; }
// Signal by writable handle, clear by either end; 1 = done, 0 = no such handle
export function kernel_event_signal(h: u32): i32 { kLock(); const r = hostEventSignal(h); kUnlock(); return r ? 1 : 0; }
export function kernel_event_clear(h: u32): i32 { kLock(); const r = hostEventClear(h); kUnlock(); return r ? 1 : 0; }

// CloseHandle by the embedder, for the handles its services made (kernel_event_new, kernel_event_dup_readable) or
// took over: 1 = closed, 0 = no such handle. An event goes away with its last handle and wait.
export function kernel_handle_close(h: u32): i32 { kLock(); const r = closeHandle(h); kUnlock(); return r ? 1 : 0; }
// The embedder ends the process (the page's stop): every thread leaves whatever it was doing, as at ExitProcess.
// kernel_stop_reason() is 3 afterwards; nothing runs any more. No effect on a process that has ended.
export function kernel_kill(): void { kLock(); if (stopReason == STOP_NONE) stopProcess(STOP_KILL, 0); kUnlock(); }

// ---- state for the embedder, tests and dumps ----
export function kernel_stop_reason(): i32 { return stopReason; }   // 0 running, 1 ExitProcess, 2 Break, 3 killed by the embedder
export function kernel_exit_code(): i32 { return exitCode; }
// The thread index of a thread handle, -1 when it is none
export function kernel_thread_index(h: u32): i32 { return hPeek(h, O_THREAD); }
export function kernel_thread_ctx(index: i32): usize { return index >= 0 && index < MAX_THREADS && thr(index).used ? thr(index).ctx : 0; }
export function kernel_thread_of_ctx(ctx: usize): i32 { const t = threadOfCtx(ctx); return t != null ? t.index : -1; }
export function kernel_core_current(core: i32): i32 { return schedCurrent(core); }
// Thread record index -> out (96 bytes): +0 used u32, +4 state (KthreadS), +8 wait kind, +12 priority i32, +16
// effective priority, +20 ideal core, +24 the core it queues on, +28 handle, +32 id u64, +40 mask, +48 wait address,
// +56 wait key, +64 deadline (guest ns), +72 synchronization wait references, +76 retained objects, +80 cancel
// pending, +84 handle closed, +88 lock owner's thread index
export function kernel_thread_info(index: i32, out: usize): i32 {
  if (index < 0 || index >= MAX_THREADS) return 0;
  const t = thr(index);
  memory.fill(out, 0, 96);
  if (!t.used) return 0;
  store<u32>(out, 1, 0); store<u32>(out, t.state, 4); store<u32>(out, t.waitKind, 8);
  store<i32>(out, t.prio, 12); store<i32>(out, t.eff, 16); store<i32>(out, t.core, 20); store<i32>(out, t.runCore, 24);
  store<u32>(out, t.handle, 28); store<u64>(out, t.id, 32); store<u64>(out, t.mask, 40);
  store<u64>(out, t.waddr, 48); store<u64>(out, t.wkey, 56); store<u64>(out, t.deadline, 64);
  store<i32>(out, t.syncRefs, 72); store<i32>(out, t.wn, 76); store<u32>(out, t.cancel ? 1 : 0, 80); store<u32>(out, t.closed ? 1 : 0, 84);
  store<i32>(out, t.wowner, 88);
  return 1;
}
// 0 handles in use, 1 threads alive, 2 thread records, 3 events alive, 4 MapMemory mappings, 5 heap size,
// 6 bytes mapped in the alias region
export function kernel_count(what: i32): u64 {
  switch (what) {
    case 0: return handlesUsed();
    case 1: return threadsAlive();
    case 2: return threadObjects();
    case 3: return eventsLive();
    case 4: return mem.mapCount();
    case 5: return mem.heapSize();
    case 6: return mem.aliasMappedBytes();
  }
  return 0;
}
export function kernel_alias_page_state(addr: u64): i32 { return mem.aliasPageState(addr); }

// The kernel's own consistency check, for tests (the fuzz test calls it after every step). 0 = consistent.
const REFS: usize = memory.data(8192);   // MAX_EVENTS * 4
export function kernel_check(): i32 {
  // 1x: each core has at most one Running thread, and it is the core's current one
  for (let c = 0; c < NCORES; c++) {
    let n = 0;
    for (let i = 0; i < MAX_THREADS; i++) {
      const t = thr(i);
      if (t.used && t.runCore == c && t.state == KthreadS.Running) { n++; if (schedCurrent(c) != i) return 11; }
    }
    if (n > 1) return 10;
  }
  memory.fill(REFS, 0, 8192);
  for (let i = 0; i < MAX_THREADS; i++) {
    const t = thr(i);
    if (!t.used) continue;
    const k = t.waitKind;
    // 2x: only a waiting thread has a deadline or retained objects; a dead record with nothing left is freed
    if (!k && t.deadline != FOREVER) return 20;
    if (k != WK_SYNC && t.wn) return 21;
    if (t.exited && t.closed && !t.syncRefs) return 22;
    if (t.state == KthreadS.Created) return 23;
    // 4x: a lock waiter's lock word has the waiters bit and names an owner
    if (k == WK_LOCK && t.deadline == FOREVER && guestOk(t.waddr, 4)) {
      const v = ld32(t.waddr);
      if (!(v & WAITERS_BIT)) return 40;
      if (!(v & ~WAITERS_BIT)) return 41;
    }
    let refs = 0;
    for (let j = 0; j < MAX_THREADS; j++) {
      const w = thr(j);
      if (!w.used) continue;
      for (let q = 0; q < w.wn; q++) if (w.wobj(q) == ((O_THREAD << 16) | <u32>i)) refs++;
    }
    if (refs != t.syncRefs) return 50;
    for (let q = 0; q < t.wn; q++) {
      const ref = t.wobj(q);
      if (ref >> 16 == O_EVENT_R) { const p = REFS + (<usize>(ref & 0xFFFF) << 2); store<i32>(p, load<i32>(p) + 1); }
    }
  }
  // 5x: an event's reference count is its handles plus the waits that retain it
  handlesCountEvents(REFS);
  for (let e: u32 = 0; e < MAX_EVENTS; e++) if (evRefs(<i32>e) != load<i32>(REFS + (<usize>e << 2))) return 51;
  return mem.memCheck();
}
