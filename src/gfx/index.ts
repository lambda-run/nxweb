// nxweb graphics, the recorder (AssemblyScript): NVN entry points, guest object state, command records, and the
// lowering of submitted commands to the host stream the WebGPU replayer executes (src/glue/gfx_host.ts).
// See README.md. Imports: env.log, env.gfx_exec, env.gfx_guest_call, env.gfx_proc_address; memory is imported
// (the guest's linear memory: guest pointers are below 4 GB and index it directly).
import { call, lookup, status, setApi } from "./dispatch";
import { NVN_NFUNC } from "./gen/names";
import { lowerInit, stat, passState } from "./lower";
import { libRegister, shaderInit } from "./shader";
import { arenaInit, ARENA_BYTES } from "./arena";
import { pipelineDone, pipelineState, pipelineCount, pipelineInit } from "./pipeline";
import { fenceDone, fenceSignal, fenceDonePtr, fenceLast, sampTablePtr, tablesInit } from "./tables";
import { imageEvent, imageState } from "./window";
import { syncFenceOf } from "./sync";
import { hostFlush, hostExecs, hostInit } from "./hostops";
import { hostSegsLent, cmdInit } from "./cmd";
import { texLayout, texLevelOffset } from "./texlayout";
import { texContentInit, texStat, deswizzle, contentState, benchSample } from "./texcontent";
export * from "../kit/exports";

// Once, before anything else: `arena` = gfx_arena_bytes() bytes of linear memory for the module's tables (the embedder
// chooses where; the module's small static data is at the --memoryBase it was compiled with). 1 on success
let inited = false;
export function gfx_arena_bytes(): u32 { return ARENA_BYTES; }
export function gfx_init(arena: usize, bytes: u32): i32 {
  if (inited) return 1;
  if (!arenaInit(arena, bytes)) return 0;
  tablesInit(); hostInit(); texContentInit(); cmdInit(); pipelineInit(); shaderInit(); lowerInit();
  inited = true;
  return 1;
}

// One NVN call. fnId: from nvn_lookup. argsPtr: x0..x7 (8 x u64) then d0..d7 (8 x f64) as the guest passed them.
// The result is x0. (No function implemented so far returns a float; one that does will write d0 back at argsPtr + 64.)
export function nvn_call(fnId: i32, argsPtr: usize): u64 { return call(fnId, argsPtr); }
// The id of an NVN function name (NUL-terminated), for nvnBootstrapLoader / nvnDeviceGetProcAddress; -1 unknown
export function nvn_lookup(namePtr: usize): i32 { return lookup(namePtr); }
export function nvn_count(): i32 { return NVN_NFUNC; }
// 0 unimplemented (logs `[RED] nvnXxx unimplemented` once, returns 0), 1 implemented, 2 empty by design
export function nvn_status(fnId: i32): i32 { return status(fnId); }
export function gfx_set_api(major: i32, minor: i32): void { setApi(major, minor); }

// The shader library: key = the 8 key bytes as two little-endian words, refl = reflection record (shader.ts)
export function gfx_shader_register(keyLo: u32, keyHi: u32, refl: usize): i32 { return libRegister(<u64>keyLo | <u64>keyHi << 32, refl); }
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
// Hands what is in the host stream to the replayer now
export function gfx_flush(): void { hostFlush(); }
// Introspection for the replayer and the tests
export function gfx_sampler_table(): usize { return sampTablePtr(); }
export function gfx_pipeline_state(id: u32): i32 { return pipelineState(id); }
export function gfx_pipeline_count(): u32 { return pipelineCount(); }
export function gfx_image_state(window: usize, index: i32): i32 { return imageState(window, index); }
export function gfx_pass_state(): i32 { return passState(); }
// 0 passes begun, 1 draws issued, 2 draws skipped, 3 snapshots, 4 clears drawn as triangles, 5 submissions, 6 host stream hand-overs, 7 host-lent command segments
// 8 texture uploads, 9 KB uploaded, 10 sampled hashes taken, 11 full hashes taken, 12 textures found changed
export function gfx_stat(i: i32): u32 { return i >= 8 ? texStat(i - 8) : i == 6 ? hostExecs() : i == 7 ? hostSegsLent() : stat(i); }
// Block-linear storage of one level and layer to linear rows (toLinear) or back; desc = nvn_texdesc. -1: no such storage
export function gfx_deswizzle(desc: usize, level: u32, layer: u32, storage: usize, linear: usize, pitch: u32, toLinear: i32): i32 { return deswizzle(desc, level, layer, storage, linear, pitch, toLinear != 0); }
// The content state of a texture object (gfx_texture: 0 Unknown, 1 Uploaded, 2 GpuOwned), -1 when it is not live
export function gfx_bench_sample(tex: usize, n: u32): u32 { return <u32>benchSample(tex, n); }
export function gfx_tex_state(tex: usize): i32 { return contentState(load<u64>(tex, 120)); }
export function gfx_tex_layout(desc: usize, out: usize): void { texLayout(desc, out); }
// The end of the module's static data (it starts at the --memoryBase of the build), and 64 bytes the embedder may use
// to pass a record in (a reflection record for gfx_shader_register)
export function gfx_static_end(): usize { return __heap_base; }
const SCRATCH: usize = memory.data(64);
export function gfx_scratch(): usize { return SCRATCH; }
export function gfx_tex_level_offset(desc: usize, level: u32): u32 { return <u32>texLevelOffset(desc, level); }
