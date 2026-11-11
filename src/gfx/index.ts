// nxweb graphics, the recorder (AssemblyScript): NVN entry points, guest object state, command records, and the
// lowering of submitted commands to the host stream the WebGPU replayer executes (src/glue/gfx_host.ts).
// See README.md. Imports: env.log, env.gfx_exec, env.gfx_guest_call, env.gfx_proc_address; memory is imported
// (the guest's linear memory: guest pointers are below 4 GB and index it directly).
import { call, lookup, status, setApi, setNvn2, setDevinfo2, nameCopy, finishFenceLast, setNow } from "./dispatch";
import { profileSet, profileBits } from "./profile";
import { reportInit, reportLand, reportsFlush, reportsPending, reportStat, renderEnableState } from "./report";
import { NVN_NFUNC, ABI } from "./gen/names";
import { deviceInit, deviceLost, deviceRestored, deviceState, deviceLosses } from "./device";
import { setHostCaps } from "./fmt";
import { astcRows } from "./astc";
import { lowerInit, stat, passState } from "./lower";
import { libRegister, shaderInit, shaderPending, shaderKeyState, shaderWaited, watchKey } from "./shader";
import { arenaInit, ARENA_BYTES } from "./arena";
import { pipelineDone, pipelineState, pipelineCount, pipelineInit } from "./pipeline";
import { fenceDone, fenceSignal, fenceDonePtr, fenceLast, sampTablePtr, tablesInit } from "./tables";
import { imageEvent, imageState, presentInterval, presentCapSet } from "./window";
import { syncFenceOf, syncWaitFence } from "./sync";
import { hostFlush, hostExecs, hostInit } from "./hostops";
import { hostSegsLent, cmdInit } from "./cmd";
import { texLayout, texLevelOffset } from "./texlayout";
import { texContentInit, texStat, texWatchStat, deswizzle, contentState, benchSample, hashFull } from "./texcontent";
import { watchInit } from "./texwatch";
export * from "../kit/exports";

// Once, before anything else: `arena` = gfx_arena_bytes() bytes of linear memory for the module's tables (the embedder
// chooses where; the module's small static data is at the --memoryBase it was compiled with). 1 on success
let inited = false;
export function gfx_arena_bytes(): u32 { return ARENA_BYTES; }
export function gfx_init(arena: usize, bytes: u32): i32 {
  if (inited) return 1;
  if (!arenaInit(arena, bytes)) return 0;
  tablesInit(); hostInit(); texContentInit(); cmdInit(); pipelineInit(); shaderInit(); lowerInit(); deviceInit(); reportInit(); watchInit();
  inited = true;
  return 1;
}

// One NVN call. fnId: from nvn_lookup. argsPtr: x0..x7 (8 x u64) then d0..d7 (8 x f64) as the guest passed them.
// The result is x0. A function whose result is a float (nvn_abi bit 4) writes it at argsPtr + 64: the embedder copies
// those 8 bytes to d0 after the call. Float arguments are only read by functions whose nvn_abi says so.
export function nvn_call(fnId: i32, argsPtr: usize): u64 { return call(fnId, argsPtr); }
// The name of an id (NUL-terminated, in static memory, valid until the next nvn_name), 0 for an id NVN does not have
export function nvn_name(fnId: i32): usize { return nameCopy(fnId); }
// The float side of a function's ABI: bits 0-3 how many of d0..d7 it reads (0: the embedder need not marshal any), bit 4
// its result is a float in d0 (at argsPtr + 64 after nvn_call). nvn_abi_table: the same as nvn_count() bytes, to read once
export function nvn_abi(fnId: i32): i32 { return <u32>fnId < <u32>NVN_NFUNC ? load<u8>(ABI + <usize>fnId) : 0; }
export function nvn_abi_table(): usize { return ABI; }
// The id of an NVN function name (NUL-terminated), for nvnBootstrapLoader / nvnDeviceGetProcAddress; -1 unknown
export function nvn_lookup(namePtr: usize): i32 { return lookup(namePtr); }
export function nvn_count(): i32 { return NVN_NFUNC; }
// 0 unimplemented (logs `[RED] nvnXxx unimplemented` once, returns 0), 1 implemented, 2 empty by design
export function nvn_status(fnId: i32): i32 { return status(fnId); }
export function gfx_set_api(major: i32, minor: i32): void { setApi(major, minor); }
export function gfx_set_nvn2(on: i32): void { setNvn2(on != 0); }
export function gfx_set_devinfo2(item: u32, v: i32): void { setDevinfo2(item, v); }

// The shader library: key = the 8 key bytes as two little-endian words, refl = reflection record (shader.ts)
export function gfx_shader_register(keyLo: u32, keyHi: u32, refl: usize): i32 { return libRegister(<u64>keyLo | <u64>keyHi << 32, refl); }
// What the embedder does about a key that is not registered: 1 it is on its way (draws that need it are skipped without
// a line), 2 it failed (the embedder says so itself), 0 nothing any more. 1 = taken, 0 = not in the key's state
export function gfx_shader_pending(keyLo: u32, keyHi: u32, what: i32): i32 { return shaderPending(<u64>keyLo | <u64>keyHi << 32, what) ? 1 : 0; }
// The pending keys a draw or dispatch was skipped for since the last call: n keys of 8 bytes at gfx_scratch()
export function gfx_shader_waited(): u32 { return shaderWaited(SCRATCH); }
// The replayer is told of this key's dispatches when they cannot run (H_DISPATCH_SKIPPED). 0: the table (16 keys) is full
export function gfx_watch_key(keyLo: u32, keyHi: u32): i32 { return watchKey(<u64>keyLo | <u64>keyHi << 32) ? 1 : 0; }
export function gfx_shader_state(keyLo: u32, keyHi: u32): i32 { return shaderKeyState(<u64>keyLo | <u64>keyHi << 32); }   // 0 Unknown, 1 Pending, 2 Failed, 3 Ready
// The replayer's reports
export function gfx_pipeline_done(id: u32, ok: i32): void { pipelineDone(id, ok != 0); }
export function gfx_fence_signal(n: u32): void { fenceSignal(n); }
export function gfx_image_event(window: usize, index: i32, what: i32): void { imageEvent(window, index, what); }
// For the kernel's waits: whether fence n is done, the fence word's address (u64, the highest fence done), the
// fence a pending NVNsync waits for (0: none), the last fence issued
export function gfx_fence_done(n: u32): i32 { return fenceDone(n) ? 1 : 0; }
export function gfx_fence_word(): usize { return fenceDonePtr(); }
export function gfx_fence_last(): u32 { return <u32>fenceLast(); }
export function gfx_sync_fence(sync: usize): u32 { return <u32>syncFenceOf(sync); }
// After nvnSyncWait returned TIMEOUT_EXPIRED: the fence the thread should be parked on, 0 when it should not wait
// (not fenced, or the timeout was 0). After nvnQueueFinish: the fence that ends the wait (README has both contracts)
export function gfx_wait_fence(): u32 { return <u32>syncWaitFence(); }
export function gfx_finish_fence(): u32 { return <u32>finishFenceLast(); }
// What the replayer's device takes as it is: 1 ASTC textures, 2 16-bit normalized formats (others are converted on upload)
export function gfx_host_caps(bits: u32): void { setHostCaps(bits); }
// GPUDevice.lost and its replacement (device.ts). gfx_device_state: 0 Live, 1 Lost
export function gfx_device_lost(): void { deviceLost(); }
export function gfx_device_restored(): u32 { return deviceRestored(); }
export function gfx_device_state(): i32 { return deviceState(); }
export function gfx_device_losses(): u32 { return deviceLosses(); }
// ASTC blocks to RGBA8 (the tests compare it with an independent decoder): nby rows of nbx blocks of bw x bh texels
export function gfx_astc_decode(src: usize, srcPitch: u32, nbx: u32, nby: u32, bw: u32, bh: u32, out: usize, pitch: u32, srgb: i32): void { astcRows(src, srcPitch, nbx, nby, bw, bh, out, pitch, srgb != 0); }
// Hands what is in the host stream to the replayer now
export function gfx_flush(): void { hostFlush(); }
// Introspection for the replayer and the tests
export function gfx_sampler_table(): usize { return sampTablePtr(); }
export function gfx_pipeline_state(id: u32): i32 { return pipelineState(id); }
export function gfx_pipeline_count(): u32 { return pipelineCount(); }
export function gfx_image_state(window: usize, index: i32): i32 { return imageState(window, index); }
export function gfx_pass_state(): i32 { return passState(); }
// 0 passes begun, 1 draws issued, 2 draws skipped, 3 snapshots, 4 clears drawn as triangles, 5 submissions, 6 host stream hand-overs, 7 host-lent command segments
// 8 texture uploads, 9 KB uploaded, 10 sampled hashes taken, 11 full hashes taken, 12 textures found changed,
// 13 compute dispatches, 14 compute passes, 15 buffer-to-texture copies made in the texture's storage,
// 16 texture handles taken from uniform data (bindless slots bound), 21 mesh draws (DrawMeshTasks), 22 of them indirect, 23 with a task shader, 24 mesh draws skipped
export function gfx_stat(i: i32): u32 { return i >= 13 ? stat(i) : i >= 8 ? texStat(i - 8) : i == 6 ? hostExecs() : i == 7 ? hostSegsLent() : stat(i); }
// Block-linear storage of one level and layer to linear rows (toLinear) or back; desc = nvn_texdesc. -1: no such storage
export function gfx_deswizzle(desc: usize, level: u32, layer: u32, storage: usize, linear: usize, pitch: u32, toLinear: i32): i32 { return deswizzle(desc, level, layer, storage, linear, pitch, toLinear != 0); }
// The content state of a texture object (gfx_texture: 0 Unknown, 1 Uploaded, 2 GpuOwned), -1 when it is not live
// A hash of a memory range (53 bits), for the replayer's upload cache
export function gfx_hash(ptr: usize, len: u32): f64 { return <f64>(hashFull(ptr, len) >> 11); }
export function gfx_bench_sample(tex: usize, n: u32): u32 { return <u32>benchSample(tex, n); }
export function gfx_tex_state(tex: usize): i32 { return contentState(load<u64>(tex, 120)); }
export function gfx_tex_layout(desc: usize, out: usize): void { texLayout(desc, out); }
// The end of the module's static data (it starts at the --memoryBase of the build), and 512 bytes the embedder may use
// to pass a record in (a reflection record for gfx_shader_register)
// The game profile's switches (profile.ts: 1 render_cond, 2 tex_flush_upload, 4 tex_dirty_upload, 8 gpu_timestamps segment,
// 16 present_interval display). Once, before the game's first NVN call
export function gfx_set_profile(bits: u32): void { profileSet(bits); }
export function gfx_profile(): u32 { return profileBits(); }
// The guest clock in nanoseconds, for nvnDeviceGetCurrentTimestampInNanoseconds: the embedder sets it before that call
export function gfx_set_now(ns: u64): void { setNow(ns); }
// Counter reports (report.ts). The replayer: report `id` is done; the GPU start and end of its segment and the end of
// its submission, guest nanoseconds. An embedder with no device: gfx_reports_flush(now) lands everything issued.
// gfx_report_stat: 0 issued, 1 landed, 2 conditions false, 3 true, 4 unknown, 5 draws skipped, 6 clears skipped, 7 segment cuts
export function gfx_report_land(id: u32, startNs: u64, endNs: u64, doneNs: u64): void { reportLand(id, startNs, endNs, doneNs); }
export function gfx_reports_flush(nowNs: u64): void { reportsFlush(nowNs); }
export function gfx_reports_pending(): u32 { return reportsPending(); }
export function gfx_report_stat(i: i32): u32 { return reportStat(i); }
// Textures the CPU keeps writing (texwatch.ts; profile keys tex_flush_upload, tex_dirty_upload): 0 textures taken back from the
// GPU by a flush, 1 KB hashed by the scanner, 2 scans completed, 3 scans that found a rewrite, 4 textures published by a
// flush, 5 textures registered, 6 bytes the scanner hashed in the last submission
export function gfx_tex_watch_stat(i: i32): u32 { return texWatchStat(i); }
// Frame pacing (window.ts): the vertical syncs a frame of the window stays on screen, for which the embedder holds the
// next nvnWindowAcquireTexture; a present cap in frames a second (30, 60; 0 none) that replaces the game's interval
export function gfx_present_interval(window: usize): i32 { return presentInterval(window); }
export function gfx_set_present_cap(fps: i32): void { presentCapSet(fps); }
export function gfx_render_enable_state(): i32 { return renderEnableState(); }   // gfx_render_enable: 0 Drawing, 1 Skipping
export function gfx_static_end(): usize { return __heap_base; }
const SCRATCH: usize = memory.data(512);
export function gfx_scratch(): usize { return SCRATCH; }
export function gfx_tex_level_offset(desc: usize, level: u32): u32 { return <u32>texLevelOffset(desc, level); }
