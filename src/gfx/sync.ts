// NVN sync objects: a kit instance (gfx_sync) inside the guest's NVNsync. A fence is a number in submission order;
// the replayer signals it when the GPU has finished everything submitted before it (onSubmittedWorkDone ->
// gfx_fence_signal), which raises the fence word (tables.ts). nvnSyncWait never blocks: it reports the state and, when
// the game is willing to wait, which fence the embedder parks the thread on.
import { Inst } from "../kit/machine";
import { GFX_SYNC, GfxSyncE, GfxSyncS } from "../kit/gen/tables";
import { MAGIC_SYNC, SYNC_inst, SYNC_SIZE } from "./obj";
import { fenceDone } from "./tables";

let seq: u32 = 0;
export function syncInitialize(s: usize): void {
  memory.fill(s, 0, SYNC_SIZE);
  store<u32>(s, MAGIC_SYNC);
  Inst.at(s + SYNC_inst).init(GFX_SYNC, ++seq);
}
// The sync waits for fence n from now on (a sync that is already fenced is fenced again, as in NVN)
export function syncFence(s: usize, n: u64, acquire: bool): void {
  if (!s || load<u32>(s) != MAGIC_SYNC) return;
  const m = Inst.at(s + SYNC_inst);
  if (m.state != GfxSyncS.Unfenced) m.step(GfxSyncE.Reset);
  m.step(acquire ? GfxSyncE.Acquire : GfxSyncE.Fence, n);
}
export function syncFinalize(s: usize): void { store<u32>(s, 0); }
// nvnSyncWait(sync, timeout in nanoseconds). The recorder never blocks; the embedder parks the guest thread (README,
// "nvnSyncWait"). NVNsyncWaitResult: 0 ALREADY_SIGNALED, 1 CONDITION_SATISFIED, 2 TIMEOUT_EXPIRED.
//   not fenced                         -> 2
//   fence done                         -> 0, or 1 when an earlier call of this wait was told to park
//   fence not done, timeout 0          -> 2 (a parked wait ends: the embedder calls with timeout 0 when its timer ran out)
//   fence not done, timeout not 0      -> 2 with gfx_wait_fence() = the fence to park on; the call is made again afterwards
let waitFence: u64 = 0;
export function syncWait(s: usize, timeout: u64): u32 {
  waitFence = 0;
  if (!s || load<u32>(s) != MAGIC_SYNC) return 3;      // FAILED
  const m = Inst.at(s + SYNC_inst);
  if (m.state == GfxSyncS.Signaled) return 0;
  if (m.state == GfxSyncS.Unfenced) return 2;
  const f = m.data, parked = m.state == GfxSyncS.Parked;
  if (fenceDone(f)) { m.step(parked ? GfxSyncE.Wake : GfxSyncE.Complete); return parked ? 1 : 0; }
  if (!timeout) { if (parked) m.step(GfxSyncE.Expire, f); return 2; }
  m.step(GfxSyncE.Park, f);
  waitFence = f;
  return 2;
}
export function syncWaitFence(): u64 { return waitFence; }
// The fence a pending sync waits for (0: none), for the kernel's wait
export function syncFenceOf(s: usize): u64 { const m = Inst.at(s + SYNC_inst); return m.state == GfxSyncS.PendingFence || m.state == GfxSyncS.PendingAcquire || m.state == GfxSyncS.Parked ? m.data : 0; }
