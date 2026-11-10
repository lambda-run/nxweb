// The host GPU device as the recorder knows it (machine gfx_device). The replayer reports GPUDevice.lost
// (gfx_device_lost) and, once the embedder has given it a new device, gfx_device_restored: host textures, pipelines and
// buffers are then made again from guest state. Between the two, submissions are lowered as usual and the replayer
// runs them against the dead device (WebGPU accepts the calls and draws nothing).
import * as L from "./log";
import { Inst } from "../kit/machine";
import { GFX_DEVICE, GfxDeviceE, GfxDeviceS } from "../kit/gen/tables";
import { contentLost } from "./texcontent";
import { pipelineReset } from "./pipeline";
import { lowerDeviceReset } from "./lower";
import { hostFlush } from "./hostops";

const DEV: usize = memory.data(16);
let losses: u32 = 0;
export function deviceInit(): void { Inst.at(DEV).init(GFX_DEVICE, 0); }
export function deviceLost(): void { Inst.at(DEV).step(GfxDeviceE.Lose); losses++; }
// The number of GPU-written textures whose content could not be brought back
export function deviceRestored(): u32 {
  if (!Inst.at(DEV).step(GfxDeviceE.Restore)) return 0;
  const gone = contentLost();
  pipelineReset();
  lowerDeviceReset();
  hostFlush();
  if (gone) { L.red("the GPU device was lost: "); L.u(gone); L.str(" textures the GPU had written (render targets, copies) are empty until the game writes them again"); L.end(); }
  return gone;
}
export function deviceState(): i32 { return Inst.at(DEV).state; }
export function deviceLosses(): u32 { return losses; }
export function deviceLive(): bool { return Inst.at(DEV).state == GfxDeviceS.Live; }
