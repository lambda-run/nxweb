// NVN sync objects: a kit instance (gfx_sync) inside the guest's NVNsync. A fence is a number in submission order;
// the replayer signals it when the GPU has finished everything submitted before it (onSubmittedWorkDone ->
// gfx_fence_signal), which raises the fence word (tables.ts). nvnSyncWait never blocks: it reports the state, and the
// kernel will do the waiting on the fence word (gfx_fence_done / gfx_fence_word).
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
// NVNsyncWaitResult: 0 already signaled, 2 timeout expired (not fenced, or its fence is not done yet)
export function syncWait(s: usize): u32 {
  const m = Inst.at(s + SYNC_inst);
  if (m.state == GfxSyncS.Signaled) return 0;
  if (m.state == GfxSyncS.Unfenced) return 2;
  if (!fenceDone(m.data)) return 2;
  m.step(GfxSyncE.Complete);
  return 0;
}
// The fence a pending sync waits for (0: none), for the kernel's wait
export function syncFenceOf(s: usize): u64 { const m = Inst.at(s + SYNC_inst); return m.state == GfxSyncS.PendingFence || m.state == GfxSyncS.PendingAcquire ? m.data : 0; }
