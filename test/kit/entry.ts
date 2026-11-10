// The module the kit's tests drive (AssemblyScript): the kit's exports plus pools of instances.
import { Inst } from "../../src/kit/machine";
import { HomeQuit, hqBlocksInput } from "../../src/kit/home_quit";
import { KTHREAD, KthreadE } from "../../src/kit/gen/tables";
export * from "../../src/kit/exports";

// ---- any machine: SLOTS instances ----
const SLOTS: u32 = 8192;
const POOL: usize = memory.data(131072);   // SLOTS * Inst.SIZE

// @ts-ignore: decorator
@inline function slot(i: u32): Inst { return Inst.at(POOL + <usize>(i & (SLOTS - 1)) * Inst.SIZE); }

export function m_init(i: u32, machine: u32, id: u32): void { slot(i).init(<u8>machine, id); }
export function m_step(i: u32, ev: u32, arg: u32): i32 { return slot(i).step(<u8>ev, <u64>arg) ? 1 : 0; }
export function m_can(i: u32, ev: u32): i32 { return slot(i).can(<u8>ev) ? 1 : 0; }
export function m_state(i: u32): u32 { return slot(i).state; }
export function m_data(i: u32): u32 { return <u32>slot(i).data; }

// n threads (the kernel's `kthread` machine) through Schedule and Yield, rounds times each: the hot path. Returns the number of accepted steps
export function m_bench(n: u32, rounds: u32): u32 {
  let ok: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const t = slot(i);
    t.init(KTHREAD, i); t.step(KthreadE.Create); t.step(KthreadE.Start);
  }
  for (let r: u32 = 0; r < rounds; r++) {
    for (let i: u32 = 0; i < n; i++) {
      const t = slot(i);
      ok += <u32>t.step(KthreadE.Schedule) + <u32>t.step(KthreadE.Yield);
    }
  }
  return ok;
}

// ---- the Home button's quit machine ----
const HQ: usize = memory.data(256);   // 4 * HomeQuit.SIZE

// @ts-ignore: decorator
@inline function hq(i: u32): HomeQuit { return HomeQuit.at(HQ + <usize>(i & 3) * HomeQuit.SIZE); }

export function hq_init(i: u32): void { hq(i).init(i); }
export function hq_step(i: u32, now: f64, home: i32, a: i32, b: i32): u32 { return hq(i).step(now, home != 0, a != 0, b != 0); }
export function hq_cancel(i: u32): void { hq(i).cancel(); }
export function hq_phase(i: u32): u32 { return hq(i).phase.state; }
export function hq_ring(i: u32, now: f64): f64 { return hq(i).ring(now); }
export function hq_blocks_input(phase: u32): i32 { return hqBlocksInput(<u8>phase) ? 1 : 0; }
export function hq_latch(i: u32, which: u32): u32 { return which == 0 ? hq(i).home.state : which == 1 ? hq(i).a.state : hq(i).b.state; }
