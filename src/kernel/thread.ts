// Thread records. Each holds its kit instance (machine `kthread`), the scheduler and wait fields, the thread's context
// block in the contract's save_ctx layout, and the objects a WaitSynchronization retains.
import { Inst } from "../kit/machine";
import { KTHREAD, KthreadS, KthreadE, KthreadWaitKind } from "../kit/gen/tables";
import { FOREVER, H_CUR_THREAD, st32, st64 } from "./base";
import { O_THREAD, hPeek } from "./handle";
import { commit, tlsSlots, tlsSlotAddr, TLS_SLOT, TLS_TLR, TLS_THREAD_OBJ, TLS_BLOCK } from "./mem";

export const MAX_THREADS: i32 = 256;
export const CTX_OFF: usize = 160;
export const CTX_SIZE: usize = 0x330;
const WOBJ_OFF: usize = 976;       // CTX_OFF + CTX_SIZE
export const STRIDE: usize = 1232; // WOBJ_OFF + 64 * 4
const POOL: usize = memory.data(315392);   // MAX_THREADS * STRIDE

// The context block (docs/CONTRACT.md, save_ctx / load_ctx)
export const C_SP: usize = 0xF8, C_PC: usize = 0x100, C_NZCV: usize = 0x108, C_FPCR: usize = 0x10C, C_FPSR: usize = 0x110,
  C_TPIDR: usize = 0x118, C_TPIDRRO: usize = 0x120, C_V: usize = 0x130;
export const PC_THREAD_EXIT: u64 = 0xFFFFFFF0;

export const WK_NONE: u32 = 0;
export const WK_LOCK: u32 = <u32>KthreadWaitKind.lock;
export const WK_CONDVAR: u32 = <u32>KthreadWaitKind.condvar;
export const WK_ADDRESS: u32 = <u32>KthreadWaitKind.address;
export const WK_SYNC: u32 = <u32>KthreadWaitKind.sync;
export const WK_SLEEP: u32 = <u32>KthreadWaitKind.sleep;
export const WK_CLOCK: u32 = <u32>KthreadWaitKind.clock;

// @ts-ignore: decorator
@unmanaged
export class KThread {
  private i0: u64; private i1: u64;   // the kit instance: this.m
  id: u64;            // svcGetThreadId's answer, from 0x51 up
  entry: u64; arg: u64; stackTop: u64;
  mask: u64;          // affinity
  waddr: u64;         // the lock word (lock, condvar) or the address (address arbiter) of the current wait
  wkey: u64;          // the condition variable's key word
  wseq: u64;          // order of wait registration: at equal priority first come, first woken
  deadline: u64;      // guest ns at which the wait times out, FOREVER = never
  rqSeq: u64;         // order among runnable threads of one priority on a core
  prio: i32;          // what the guest set (0 highest .. 63)
  eff: i32;           // what the scheduler uses: prio, or better while a higher-priority thread waits for a lock this one owns
  core: i32;          // ideal core
  runCore: i32;       // the virtual core it is queued or running on
  wtag: u32;          // this thread's tag for the lock it waits for
  wn: i32;            // WaitSynchronization: how many objects are retained
  widx: i32;          // and the index the completing signal recorded
  wowner: i32;        // lock waits: the owner's thread index, -1 unknown
  syncRefs: i32;      // synchronization waits that retain this thread
  handle: u32;        // the handle CreateThread returned (for logs)
  index: i32;
  used: bool; cancel: bool; closed: bool; yieldAny: bool;
  pendw: u32;         // SPIKE, Workers: 1 while a pause was asked of this thread as it ran on another Worker and has not taken effect (the asker waits on this word)
  ackFor: i32;        // SPIKE, Workers: thread index + 1 whose pendw this thread's SVC waits for, 0 none
  quiet: bool;        // the clock wait in progress was made by the embedder for a counter read: its wake leaves x0 / x1 alone

  // @ts-ignore: decorator
  @inline get m(): Inst { return Inst.at(changetype<usize>(this)); }
  // @ts-ignore: decorator
  @inline get ctx(): usize { return changetype<usize>(this) + CTX_OFF; }
  // @ts-ignore: decorator
  @inline get state(): u8 { return this.m.state; }
  // @ts-ignore: decorator
  @inline x(i: i32): u64 { return load<u64>(this.ctx + (<usize>i << 3)); }
  // @ts-ignore: decorator
  @inline setX(i: i32, v: u64): void { store<u64>(this.ctx + (<usize>i << 3), v); }
  // @ts-ignore: decorator
  @inline wobj(i: i32): u32 { return load<u32>(changetype<usize>(this) + WOBJ_OFF + (<usize>i << 2)); }
  // @ts-ignore: decorator
  @inline setWobj(i: i32, v: u32): void { store<u32>(changetype<usize>(this) + WOBJ_OFF + (<usize>i << 2), v); }

  // What the thread waits for (WK_*), 0 when it does not wait. Contending is a lock wait.
  get waitKind(): u32 {
    const s = this.m.state;
    if (s == KthreadS.Waiting || s == KthreadS.PausedWaiting) return <u32>this.m.data;
    return s == KthreadS.Contending || s == KthreadS.PausedContending ? WK_LOCK : WK_NONE;
  }
  // Runnable or running: it wants a core
  // @ts-ignore: decorator
  @inline get ready(): bool { const s = this.m.state; return s == KthreadS.Runnable || s == KthreadS.Running; }
  get paused(): bool {
    const s = this.m.state;
    return s == KthreadS.PausedDormant || s == KthreadS.PausedRunnable || s == KthreadS.PausedWaiting || s == KthreadS.PausedContending;
  }
  // Created by CreateThread and not exited: holds a slot of the thread resource limit
  // @ts-ignore: decorator
  @inline get alive(): bool { return this.used && this.m.state != KthreadS.Exited && this.m.state != KthreadS.Created; }
  // @ts-ignore: decorator
  @inline get exited(): bool { return this.m.state == KthreadS.Exited; }
  // @ts-ignore: decorator
  @inline get tls(): u64 { return tlsSlotAddr(<u32>this.index); }
}

// @ts-ignore: decorator
@inline export function thr(i: i32): KThread { return changetype<KThread>(POOL + <usize>i * STRIDE); }
// The thread whose context block is at ctx, null when ctx is not one
export function threadOfCtx(ctx: usize): KThread | null {
  if (ctx < POOL + CTX_OFF) return null;
  const d = ctx - POOL - CTX_OFF;
  if (d % STRIDE || d / STRIDE >= <usize>MAX_THREADS) return null;
  const t = thr(<i32>(d / STRIDE));
  return t.used ? t : null;
}
// A thread handle, or the current-thread pseudo-handle
export function threadOfHandle(h: u32, cur: KThread | null): KThread | null {
  if (h == H_CUR_THREAD) return cur;
  const i = hPeek(h, O_THREAD);
  return i < 0 ? null : thr(i);
}

let nextId: u64 = 0x51;
export function threadsInit(): void {
  assert(offsetof<KThread>() <= CTX_OFF);
  memory.fill(POOL, 0, 315392);
  nextId = 0x51;
}
export function threadLimit(): i32 { const s = tlsSlots(); return s < <u64>MAX_THREADS ? <i32>s : MAX_THREADS; }

// A new thread in Dormant with its first context: x0 = arg, sp, pc = entry, x30 = the thread-exit pc, and its
// thread-local memory. null when no slot is free or the linear memory cannot grow to its thread-local slot.
export function threadNew(entry: u64, arg: u64, stackTop: u64, prio: i32, core: i32): KThread | null {
  const lim = threadLimit();
  let i = 0;
  while (i < lim && thr(i).used) i++;
  if (i == lim || !commit(tlsSlotAddr(<u32>i) + TLS_SLOT)) return null;
  const t = thr(i);
  memory.fill(changetype<usize>(t), 0, STRIDE);
  t.used = true; t.index = i;
  t.m.init(KTHREAD, <u32>i);
  t.id = nextId++;
  t.entry = entry; t.arg = arg; t.stackTop = stackTop & ~<u64>0xF;
  // Core -2 (use the process's default) and any other negative value: core 0, pinned there, as nxnative
  t.prio = prio; t.eff = prio; t.core = core >= 0 ? core : 0; t.mask = <u64>1 << (<u64>t.core & 63); t.runCore = runCoreOf(t);
  t.deadline = FOREVER; t.widx = -1; t.wowner = -1;
  // The kernel's two fields of the ThreadLocalRegion: the thread object at +0x1F8, the thread ID at +0x110 (SDK 22)
  const tls = t.tls;
  memory.fill(<usize>tls, 0, <usize>TLS_SLOT);
  st64(tls + TLS_TLR + 0x1F8, tls + TLS_THREAD_OBJ);
  st32(tls + TLS_TLR + 0x110, <u32>t.id);
  t.setX(0, arg); t.setX(30, PC_THREAD_EXIT);
  store<u64>(t.ctx, t.stackTop, C_SP); store<u64>(t.ctx, entry, C_PC);
  store<u64>(t.ctx, tls + TLS_BLOCK, C_TPIDR); store<u64>(t.ctx, tls + TLS_TLR, C_TPIDRRO);
  t.m.step(KthreadE.Create);
  return t;
}
export const NCORES: i32 = 4;
// The virtual core a thread queues on: its ideal core when its mask allows it and the core exists, else the lowest
// core of its mask that exists, else core 0
export function runCoreOf(t: KThread): i32 {
  if (t.core < NCORES && ((t.mask >> t.core) & 1)) return t.core;
  for (let c = 0; c < NCORES; c++) if ((t.mask >> c) & 1) return c;
  return 0;
}
// Give the slot back: after handle close, exit and the last synchronization wait reference (nxnative thr_free)
export function threadFree(t: KThread): void {
  for (let i = 0; i < MAX_THREADS; i++) if (thr(i).used && thr(i).wowner == t.index) thr(i).wowner = -1;
  t.used = false;
}
export function threadsAlive(): i32 {
  let n = 0;
  for (let i = 0; i < MAX_THREADS; i++) if (thr(i).alive) n++;
  return n;
}
export function threadObjects(): i32 {
  let n = 0;
  for (let i = 0; i < MAX_THREADS; i++) if (thr(i).used) n++;
  return n;
}
