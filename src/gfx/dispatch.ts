// nvn_call: every implemented NVN entry point, by the id nvn_lookup gave for its name (gen/names.ts, generated from
// nxnative's names.txt and from the `case F.<name>:` lines below, which is how the generator knows what is implemented).
// Arguments arrive as the guest passed them (AArch64 procedure call standard): a[0..7] = x0..x7, then d0..d7; a float
// argument is the low 32 bits of its d register, integer and float arguments are numbered separately. The result is
// x0. Object semantics follow nxnative hle_nvn.c function by function; departures are marked DEPARTS.
import * as L from "./log";
import { F, STATUS, NVN_NFUNC, NAMES, NAME_OFFS } from "./gen/names";
import * as O from "./obj";
import * as C from "./cmd";
import * as T from "./tables";
import { texLayout, texLevelOffset } from "./texlayout";
import { progSetKeys } from "./shader";
import { syncInitialize, syncFinalize, syncWait } from "./sync";
import { fenceNew } from "./tables";
import { windowInitialize, windowAcquire, windowPresent, windowGetCrop, windowInterval } from "./window";
import { submit, emitFence, passBreak, blendDefault, dsDefault } from "./lower";
import { hostRec, hostFlush, H_TEX_CREATE, H_TEX_DESTROY, H_FLUSH, H_MEM_DIRTY, H_FENCE } from "./hostops";
import { contentInit, noteFlush, regionCopy, writeTexels } from "./texcontent";
import { profileHas, P_RENDER_COND } from "./profile";
import { nsFromTicks } from "./report";
import { gmemBufInit, gmemBufDrop, gmemBufPlace } from "./gmem";

// Device properties: values measured on Tegra X1 (nxnative g_devinfo). Items 0 and 1 are the API version (apiMajor /
// apiMinor), 0x2E and 0x30 the GPU code version the shader chain translates (1.16)
const DEVINFO: usize = memory.data<i32>([
  55, 15, 14, 65536, 256, 8, 16, 4, 16, 32, 16, 4, 4, 4, 16, 32, 32, 256, 256, 4, 8, 512, 256, 2, 256, 4096, 131072,
  16, 1536, 1024, 64, 1536, 65535, 65535, 65535, 8, 1048576, 4096, 16, 4096, 1, 1, 1, 262144, 15, 2048, 1, 1, 16, 5, 1, 8,
  8, 4, 32, 128, 32, 128, 65536, 1, 4, 16384, 134217728, 2048, 16384, 16384, 1, 1, 1, 1, 5, 1, 1, 1, 1, 1, 1, 16,
  1024, 32, 4096, 65536, 65536, 256, 16384, 262144, 4096, 1, 4, 2, 0, 4096, 16384, 4096, 128, 4096]);
const NDEVINFO: u32 = 0x60;
// The API version a game's own driver would report follows its SDK: 55.15 from SDK 11, 53.313 before. Games check it
let apiMajor: i32 = 55, apiMinor: i32 = 15;
export function setApi(major: i32, minor: i32): void { apiMajor = major; apiMinor = minor; }
// The Switch 2's NVN2 (nxnative g_devinfo2, SDK 21.4.4's newest values): Ampere's limits; -1 (DEVINFO_RT) are items NVN2 reads from
// the GPU's own description at run time, which keep the X1 value below 0x60 and answer 0 with a red line above it. The host
// overrides the constants the game's own sdk holds for its driver's switch (gfx_set_devinfo2: the GPU code versions move with the SDK)
const DEVINFO2: usize = memory.data<i32>([
  231, 39, 14, 65536, 256, 8, 16, 4, 16, 32, 16, 4, 4, 4, 32, 32, 32, 256, 256, 4, 8, 512, 256, -1,
  -1, 4096, 16384, 16, 1024, 1024, 64, 1024, 2147483647, 65535, 65535, 8, 1048576, 4096, 16, 4096, 1, 1, 1, -1, 16, -1,
  201, 201, 20, 0, 1, 8, 8, 4, 32, -1, -1, 128, -1, 1, 4, -1, -1, -1, -1, -1, 1, 1,
  1, 1, 5, 1, 1, 1, 1, 1, 1, 16, 2048, 32, 4096, 65536, 65536, 256, 16384, 262144, 4096, 1, 4, 2, 0, 4096, 16384,
  4096, 128, 32, 65535, 1, -1, 256, 16, 65535, 65535, 256, 1, 16, 16, 16, 1, 1, 1, 256, 0, 16, 8, 16, 32,
  31, 536870912, 16777216, 16777216, 1073741824, 32, 1, 64, -1, 1, 2147483647, 32, 32, 4194303, 512, 256, 32, 16383, -1, 8, 0,
  0, 4, 256, 16, 0, 1, 31, 0, 64, 1, 58368, 24576, 0, 256, 262144, -1, -1, 0, 201, 14, 201, 20, 163840, 8,
  4, 256, 256, 4, 65536, 201, 5, 1]);
const NDEVINFO2: u32 = 0xAA;
let nvn2 = false;
export function setNvn2(on: bool): void { nvn2 = on; }
export function setDevinfo2(item: u32, v: i32): void { if (item < NDEVINFO2) store<i32>(DEVINFO2 + (<usize>item << 2), v); }

const UNIMPL_SEEN: usize = memory.data(1024);
const TMP_L: usize = memory.data(40);
const RANGE: usize = memory.data(16);

function nameOf(id: i32): void {     // into the log line
  for (let i = 0; i < NVN_NFUNC; i++) {
    const e = NAMES + <usize>load<u16>(NAME_OFFS + (<usize>i << 1));
    if (<i32>load<u16>(e) == id) { for (let k: usize = 0, n = <usize>load<u8>(e, 2); k < n; k++) L.ch(load<u8>(e + 3 + k)); return; }
  }
}
// The id of an NVN function name (a NUL-terminated string), -1 for a name NVN does not have
export function lookup(name: usize): i32 {
  let lo = 0, hi = NVN_NFUNC - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, e = NAMES + <usize>load<u16>(NAME_OFFS + (<usize>mid << 1)), n = <usize>load<u8>(e, 2);
    let c = 0;
    for (let k: usize = 0; ; k++) {
      const x = <i32>load<u8>(name + k), y = k < n ? <i32>load<u8>(e + 3 + k) : 0;
      if (x != y) { c = x - y; break; }
      if (!x) break;
    }
    if (!c) return load<u16>(e);
    if (c < 0) hi = mid - 1; else lo = mid + 1;
  }
  L.red("NVN address lookup of an unknown name: "); L.cstr(name); L.end();
  return -1;
}
export function status(id: i32): i32 { return <u32>id < <u32>NVN_NFUNC ? load<u8>(STATUS + <usize>id) : -1; }

// @ts-ignore: decorator
@inline function X(a: usize, i: usize): u64 { return load<u64>(a + (i << 3)); }
// @ts-ignore: decorator
@inline function P(a: usize, i: usize): usize { return <usize>load<u64>(a + (i << 3)); }
// @ts-ignore: decorator
@inline function I(a: usize, i: usize): i32 { return load<i32>(a + (i << 3)); }
// @ts-ignore: decorator
@inline function FL(a: usize, i: usize): f32 { return load<f32>(a + 64 + (i << 3)); }
// @ts-ignore: decorator
@inline function B(a: usize, i: usize): bool { return (load<u32>(a + (i << 3)) & 0xff) != 0; }   // NVNboolean: only the low 8 bits count

// A float result: the low 32 bits of d0, written back at argsPtr + 64 (the upper bits zero, as an FMOV S0 leaves them).
// gen_names.mts finds RETF and FL in each case and builds the ABI table (nvn_abi) from them
function RETF(a: usize, v: f32): u64 { store<u64>(a, 0, 64); store<f32>(a, v, 64); return 0; }
// The name of function id as a NUL-terminated string in static memory (valid until the next call), 0 for no such id
const NAME_BUF: usize = memory.data(128);
export function nameCopy(id: i32): usize {
  for (let i = 0; i < NVN_NFUNC; i++) {
    const e = NAMES + <usize>load<u16>(NAME_OFFS + (<usize>i << 1));
    if (<i32>load<u16>(e) == id) { const n = <usize>load<u8>(e, 2); memory.copy(NAME_BUF, e + 3, n); store<u8>(NAME_BUF + n, 0); return NAME_BUF; }
  }
  return 0;
}
// The fence the last nvnQueueFinish waits for: the embedder parks the thread until it is done (README, "QueueFinish")
let finishFence: u64 = 0;
export function finishFenceLast(): u64 { return finishFence; }

// Bit-field helpers for the state objects (obj.ts)
function bits32(p: usize, shift: u32, width: u32, v: u32): void { const m = ((<u32>1 << width) - 1) << shift; store<u32>(p, (load<u32>(p) & ~m) | ((v << shift) & m)); }
function bits64(p: usize, shift: u64, width: u64, v: u64): void { const m = ((<u64>1 << width) - 1) << shift; store<u64>(p, (load<u64>(p) & ~m) | ((v << shift) & m)); }

function texRelease(t: usize): void {
  const serial = load<u64>(t, O.TEX_serial);
  if (!T.texEntry(serial)) return;
  T.texFree(serial);
  store<u64>(hostRec(H_TEX_DESTROY, 16), serial, 8);
}
let pkgRed = false;
// The channel swizzle as the game reads it back: what TextureBuilderSetSwizzle set, the identity R G B A (2 3 4 5) otherwise (as nxnative tex_swz)
function swizzleOut(set: bool, w: u32, a: usize): void {
  if (!set) w = 2 | 3 << 3 | 4 << 6 | 5 << 9;
  for (let i: usize = 0; i < 4; i++) { const q = P(a, 1 + i); if (q) store<i32>(q, <i32>((w >> (<u32>i * 3)) & 7)); }
}
// nvnTextureFinalize while commands that name the texture are recorded and not yet submitted (a game makes its frame's render targets anew and finalizes the
// old ones before it submits what drew into them): the commands are lowered at the submission, and found no live texture ("draw with render targets that have no
// live texture: skipped"). The texture stays as it is until the next submission has been lowered, or until its object is initialized again
const DOOMED: usize = memory.data(8 * 512);
let nDoomed: i32 = 0;
function texFinalize(t: usize): void {
  if (load<u32>(t) != O.MAGIC_TEX) return;
  for (let i = 0; i < nDoomed; i++) if (<usize>load<u64>(DOOMED + (<usize>i << 3)) == t) return;
  if (nDoomed == 512) texDoomedRelease();
  store<u64>(DOOMED + (<usize>nDoomed << 3), <u64>t); nDoomed++;
}
function texDoomedRelease(): void {
  for (let i = 0; i < nDoomed; i++) { const t = <usize>load<u64>(DOOMED + (<usize>i << 3)); if (load<u32>(t) == O.MAGIC_TEX) { texRelease(t); store<u32>(t, 0); } }
  nDoomed = 0;
}
function texDoomedTake(t: usize): void {      // the object is used again: the texture it was goes now
  for (let i = 0; i < nDoomed; i++) if (<usize>load<u64>(DOOMED + (<usize>i << 3)) == t) { nDoomed--; store<u64>(DOOMED + (<usize>i << 3), load<u64>(DOOMED + (<usize>nDoomed << 3))); return; }
}
function textureInitialize(t: usize, b: usize): u64 {
  if (nDoomed) texDoomedTake(t);
  if (load<u32>(t) == O.MAGIC_TEX && T.texEntry(load<u64>(t, O.TEX_serial))) texRelease(t);   // initialized again without Finalize
  memory.fill(t, 0, O.TEX_SIZE);
  store<u32>(t, O.MAGIC_TEX);
  memory.copy(t + O.TEX_d, b + O.TB_d, O.TD_SIZE);
  const pool = <usize>load<u64>(b, O.TB_pool), off = load<i64>(b, O.TB_off);
  store<u64>(t, pool, O.TEX_pool); store<i64>(t, off, O.TEX_off);
  store<u8>(t, load<u8>(b, O.TB_has_layout), O.TEX_has_layout); memory.copy(t + O.TEX_layout, b + O.TB_layout, 8);
  store<u8>(t, load<u8>(b, O.TB_bits), O.TEX_bits); store<u16>(t, load<u16>(b, O.TB_swz), O.TEX_swz);
  texLayout(t + O.TEX_d, t + O.TEX_L);
  const mem = pool ? load<u64>(pool, O.POOL_mem) : 0;
  store<u64>(t, mem ? mem + off : 0, O.TEX_mem);
  // TextureBuilderSetPackagedTextureData: the packaged texels are in CPU memory, and NVN copies them into the texture's storage here (as nxnative; the
  // storage is then what every other packaged texture's is, and the content scan uploads it)
  const pkg = <usize>load<u64>(b, O.TB_pkg_data), pkgSize = <usize>load<u64>(t, O.TEX_L + O.TL_size);
  if (pkg && mem && pkgSize) memory.copy(<usize>(mem + off), pkg, pkgSize);
  else if (pkg && !pkgRed) { pkgRed = true; L.redLine("TextureBuilderSetPackagedTextureData on a texture with no storage (or a format with no layout): the data is not copied"); }
  const serial = T.texNew();
  store<u64>(t, serial, O.TEX_serial);
  if (serial) {
    const r = hostRec(H_TEX_CREATE, 64); store<u64>(r, serial, 8); memory.copy(r + 16, t + O.TEX_d, O.TD_SIZE);
    // +56: the builder's channel swizzle (3 bits a channel: 0 zero, 1 one, 2..5 R G B A), the identity when none was set
    store<u16>(r, load<u8>(t, O.TEX_bits) & 1 ? load<u16>(t, O.TEX_swz) : <u16>(2 | 3 << 3 | 4 << 6 | 5 << 9), 56);
    contentInit(serial, t);
  }
  return 1;
}
function viewOffset(d: usize, layerSize: u64, v: usize): u64 {
  if (!v) return 0;
  const bits = load<u8>(v);
  let off: u64 = bits & 1 ? texLevelOffset(d, load<u8>(v, O.VIEW_base_level)) : 0;
  if (bits & 2) off += <u64>load<u16>(v, O.VIEW_min_layer) * layerSize;
  return off;
}

let condRed: u32 = 0;
// The guest clock in nanoseconds as the embedder last gave it (gfx_set_now)
let nowNs: u64 = 0;
export function setNow(ns: u64): void { nowNs = ns; }

const ARGS2: usize = memory.data(64);   // the arguments of a call one function makes to another
const SD_PLAIN: usize = memory.data(6 * 16);   // nvnProgramSetShadersExt's stages as plain { data, control } pairs
export function call(fn: i32, a: usize): u64 {
  switch (fn) {
    // ---------- Device ----------
    case F.nvnDeviceBuilderSetDefaults: memory.fill(P(a, 0), 0, O.DEVB_SIZE); return 0;
    case F.nvnDeviceBuilderSetFlags: store<u32>(P(a, 0), I(a, 1)); return 0;
    case F.nvnDeviceBuilderGetFlags: return load<u32>(P(a, 0));
    case F.nvnDeviceInitialize: {
      const d = P(a, 0);
      memory.fill(d, 0, O.DEV_SIZE);
      store<u32>(d, O.MAGIC_DEV); store<u32>(d, load<u32>(P(a, 1)), O.DEV_flags);
      T.setOrigin(true); T.setDepthMode(false);            // NVN's defaults: lower-left origin, near = -w
      return 1;
    }
    case F.nvnDeviceFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnDeviceSetDebugLabel: return 0;
    case F.nvnDeviceGetProcAddress: return <u64>lookupAddress(P(a, 1));
    case F.nvnDeviceGetInteger: {
      const w = <u32>I(a, 1), out = P(a, 2);
      if (nvn2 && w < NDEVINFO2 && (load<i32>(DEVINFO2 + (<usize>w << 2)) != -1 || w >= NDEVINFO)) {
        const v = load<i32>(DEVINFO2 + (<usize>w << 2));
        if (v == -1) { L.red("nvnDeviceGetInteger item 0x"); L.hex(w); L.str(": NVN2 reads it from the GPU at run time, not known here; returning 0"); L.end(); }
        store<i32>(out, w == 0 ? apiMajor : w == 1 ? apiMinor : v == -1 ? 0 : v);
        return 0;
      }
      if (w == 0x67) { store<i32>(out, 256); return 0; }   // shader code alignment in a pool (SDK 19); the host reads shaders by key
      if (w >= NDEVINFO) { L.red("nvnDeviceGetInteger unknown item 0x"); L.hex(w); L.str(", returning 0"); L.end(); store<i32>(out, 0); return 0; }
      store<i32>(out, w == 0 ? apiMajor : w == 1 ? apiMinor : load<i32>(DEVINFO + (<usize>w << 2)));
      return 0;
    }
    case F.nvnDeviceGetImageHandle: return <u64><u32>I(a, 1);
    case F.nvnDeviceGetTextureHandle: return <u64><u32>I(a, 1) | <u64><u32>I(a, 2) << 20;
    case F.nvnDeviceGetTexelFetchHandle: return <u64><u32>I(a, 1);
    case F.nvnDeviceGetSeparateTextureHandle: return <u64><u32>I(a, 1);
    case F.nvnDeviceGetSeparateSamplerHandle: return <u64><u32>I(a, 1) << 20;
    case F.nvnDeviceInstallDebugCallback: { const d = P(a, 0); store<u64>(d, B(a, 3) ? X(a, 1) : 0, O.DEV_dbg_cb); store<u64>(d, X(a, 2), O.DEV_dbg_data); return 0; }
    case F.nvnDeviceSetWindowOriginMode: store<u32>(P(a, 0), I(a, 1), O.DEV_origin); T.setOrigin(I(a, 1) == 0); return 0;
    case F.nvnDeviceSetDepthMode: store<u32>(P(a, 0), I(a, 1), O.DEV_depth_mode); T.setDepthMode(I(a, 1) != 0); return 0;
    case F.nvnDeviceGetWindowOriginMode: return load<u32>(P(a, 0), O.DEV_origin);
    case F.nvnDeviceGetDepthMode: return load<u32>(P(a, 0), O.DEV_depth_mode);
    case F.nvnDeviceFinalizeCommandHandle: return 0;
    case F.nvnDeviceRegisterFastClearColor: return 1;     // a hint to the Tegra hardware
    case F.nvnDeviceRegisterFastClearDepth: return 1;
    case F.nvnDeviceSetIntermediateShaderCache: return 0;

    // ---------- Memory pools ----------
    case F.nvnMemoryPoolBuilderSetDefaults: memory.fill(P(a, 0), 0, O.PB_SIZE); return 0;
    case F.nvnMemoryPoolBuilderSetDevice: store<u64>(P(a, 0), X(a, 1), O.PB_dev); return 0;
    case F.nvnMemoryPoolBuilderSetStorage: store<u64>(P(a, 0), X(a, 1), O.PB_mem); store<u64>(P(a, 0), X(a, 2), O.PB_size); return 0;
    case F.nvnMemoryPoolBuilderSetFlags: store<u32>(P(a, 0), I(a, 1), O.PB_flags); return 0;
    case F.nvnMemoryPoolBuilderGetMemory: return load<u64>(P(a, 0), O.PB_mem);
    case F.nvnMemoryPoolBuilderGetSize: return load<u64>(P(a, 0), O.PB_size);
    case F.nvnMemoryPoolBuilderGetFlags: return load<u32>(P(a, 0), O.PB_flags);
    case F.nvnMemoryPoolInitialize: {
      const p = P(a, 0), b = P(a, 1), flags = load<u32>(b, O.PB_flags);
      store<u32>(p, O.MAGIC_POOL); store<u32>(p, flags, O.POOL_flags);
      store<u64>(p, load<u64>(b, O.PB_mem), O.POOL_mem); store<u64>(p, load<u64>(b, O.PB_size), O.POOL_size);
      store<u64>(p, 0, O.POOL_vp); store<i32>(p, 0, O.POOL_vmode);
      // DEPARTS: a virtual pool (flags 0x200) has no storage until MapVirtual points it at a physical pool (nxnative reserves an address range
      // first, and maps true sparse pools page by page; here only one contiguous mapping is taken)
      if (!load<u64>(p, O.POOL_mem) && !(flags & O.POOLF_VIRTUAL)) L.redLine("MemoryPoolInitialize: non-virtual pool has no storage");
      return 1;
    }
    // Requests (nxnative map_req): { pool *phys, i64 physical offset, i64 virtual offset, u64 size, i32 storage class, pad }
    case F.nvnMemoryPoolMapVirtual: {
      const p = P(a, 0), n = I(a, 1), rq = P(a, 2), vsize = load<u64>(p, O.POOL_size);
      for (let i = 0; i < n; i++) {
        const r = rq + <usize>i * 40, ph = <usize>load<u64>(r);
        if (!ph) continue;   // unmapping: the storage stays as it is
        const pmem = load<u64>(ph, O.POOL_mem), poff = load<i64>(r, 8), voff = load<i64>(r, 16), size = load<u64>(r, 24);
        if (!pmem) { L.redLine("MapVirtual: the physical pool has no storage"); return 0; }
        if (voff < 0 || <u64>voff + size > vsize || <u64>poff + size > load<u64>(ph, O.POOL_size)) { L.redLine("MapVirtual: request out of range"); return 0; }
        const base = pmem + <u64>poff - <u64>voff, cur = load<u64>(p, O.POOL_mem);
        if (cur && cur != base) { L.redLine("MapVirtual: non-contiguous mapping (true sparse) not implemented"); return 0; }
        store<u64>(p, base, O.POOL_mem);
      }
      return 1;
    }
    case F.nvnMemoryPoolFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnMemoryPoolSetDebugLabel: return 0;
    case F.nvnMemoryPoolMap: { const p = P(a, 0); return load<u32>(p, O.POOL_flags) & O.POOLF_CPU_NO_ACCESS ? 0 : load<u64>(p, O.POOL_mem); }
    // Guest memory is the GPU's memory here; a flush is the game saying it wrote: textures over the range get a full check (texcontent.ts)
    case F.nvnMemoryPoolFlushMappedRange: noteFlush(load<u64>(P(a, 0), O.POOL_mem) + X(a, 1), X(a, 2)); return 0;
    case F.nvnMemoryPoolInvalidateMappedRange: return 0;
    case F.nvnMemoryPoolGetBufferAddress: return load<u64>(P(a, 0), O.POOL_mem);
    case F.nvnMemoryPoolGetSize: return load<u64>(P(a, 0), O.POOL_size);
    case F.nvnMemoryPoolGetFlags: return load<u32>(P(a, 0), O.POOL_flags);

    // ---------- Texture and sampler pools ----------
    case F.nvnTexturePoolInitialize: case F.nvnSamplerPoolInitialize: {
      const tp = P(a, 0);
      store<u64>(tp, X(a, 1), O.DPOOL_pool); store<i64>(tp, <i64>X(a, 2), O.DPOOL_off); store<i32>(tp, I(a, 3), O.DPOOL_n);
      T.dpoolAdd(tp, I(a, 3), fn == F.nvnTexturePoolInitialize);
      return 1;
    }
    case F.nvnTexturePoolFinalize: case F.nvnSamplerPoolFinalize: return 0;
    case F.nvnTexturePoolSetDebugLabel: case F.nvnSamplerPoolSetDebugLabel: return 0;
    case F.nvnTexturePoolRegisterTexture: { const t = P(a, 2); T.regTex(<u32>(T.dpoolBase(P(a, 0), true) + I(a, 1)), t ? load<u64>(t, O.TEX_serial) : 0, P(a, 3)); return 0; }
    case F.nvnSamplerPoolRegisterSampler: T.regSamp(<u32>(T.dpoolBase(P(a, 0), false) + I(a, 1)), P(a, 2) + O.SAMP_p); return 0;
    case F.nvnSamplerPoolRegisterSamplerBuilder: T.regSamp(<u32>(T.dpoolBase(P(a, 0), false) + I(a, 1)), P(a, 2) + O.SB_p); return 0;
    case F.nvnTexturePoolGetMemoryPool: case F.nvnSamplerPoolGetMemoryPool: return load<u64>(P(a, 0), O.DPOOL_pool);
    case F.nvnTexturePoolGetMemoryOffset: case F.nvnSamplerPoolGetMemoryOffset: return load<u64>(P(a, 0), O.DPOOL_off);
    case F.nvnTexturePoolGetSize: case F.nvnSamplerPoolGetSize: return <u64>load<i32>(P(a, 0), O.DPOOL_n);

    // ---------- Buffers ----------
    case F.nvnBufferBuilderSetDefaults: { const b = P(a, 0), d = load<u64>(b); memory.fill(b, 0, O.BB_SIZE); store<u64>(b, d); return 0; }
    case F.nvnBufferBuilderSetDevice: store<u64>(P(a, 0), X(a, 1), O.BB_dev); return 0;
    case F.nvnBufferBuilderSetStorage: { const b = P(a, 0); store<u64>(b, X(a, 1), O.BB_pool); store<u64>(b, X(a, 2), O.BB_off); store<u64>(b, X(a, 3), O.BB_size); return 0; }
    case F.nvnBufferBuilderGetMemoryPool: return load<u64>(P(a, 0), O.BB_pool);
    case F.nvnBufferBuilderGetMemoryOffset: return load<u64>(P(a, 0), O.BB_off);
    case F.nvnBufferBuilderGetSize: return load<u64>(P(a, 0), O.BB_size);
    case F.nvnBufferInitialize: {
      const buf = P(a, 0), b = P(a, 1), pool = <usize>load<u64>(b, O.BB_pool);
      if (!pool || !load<u64>(pool, O.POOL_mem)) { L.redLine("BufferInitialize: pool has no storage"); return 0; }
      if (load<u32>(buf) == O.MAGIC_BUF) gmemBufDrop(buf);
      memory.fill(buf, 0, O.BUF_SIZE);
      gmemBufInit(buf);
      store<u32>(buf, O.MAGIC_BUF); store<u64>(buf, pool, O.BUF_pool); store<u64>(buf, load<u64>(b, O.BB_off), O.BUF_off); store<u64>(buf, load<u64>(b, O.BB_size), O.BUF_size);
      gmemBufPlace(buf);
      return 1;
    }
    case F.nvnBufferFinalize: gmemBufDrop(P(a, 0)); store<u32>(P(a, 0), 0); return 0;
    case F.nvnBufferSetDebugLabel: return 0;
    case F.nvnBufferMap: { const b = P(a, 0), pool = <usize>load<u64>(b, O.BUF_pool); return load<u32>(pool, O.POOL_flags) & O.POOLF_CPU_NO_ACCESS ? 0 : load<u64>(pool, O.POOL_mem) + load<u64>(b, O.BUF_off); }
    case F.nvnBufferGetAddress: { const b = P(a, 0); return load<u64>(<usize>load<u64>(b, O.BUF_pool), O.POOL_mem) + load<u64>(b, O.BUF_off); }
    case F.nvnBufferFlushMappedRange: { const b = P(a, 0); noteFlush(load<u64>(<usize>load<u64>(b, O.BUF_pool), O.POOL_mem) + load<u64>(b, O.BUF_off) + X(a, 1), X(a, 2)); return 0; }
    case F.nvnBufferInvalidateMappedRange: return 0;
    case F.nvnBufferGetMemoryPool: return load<u64>(P(a, 0), O.BUF_pool);
    case F.nvnBufferGetMemoryOffset: return load<u64>(P(a, 0), O.BUF_off);
    case F.nvnBufferGetSize: return load<u64>(P(a, 0), O.BUF_size);

    // ---------- Textures ----------
    case F.nvnTextureBuilderSetDefaults: {
      const b = P(a, 0), d = load<u64>(b);
      memory.fill(b, 0, O.TB_SIZE); store<u64>(b, d);
      store<i32>(b, 1, O.TB_d + O.TD_target);
      store<u32>(b, 1, O.TB_d + O.TD_width); store<u32>(b, 1, O.TB_d + O.TD_height); store<u32>(b, 1, O.TB_d + O.TD_depth); store<u32>(b, 1, O.TB_d + O.TD_levels);
      return 0;
    }
    case F.nvnTextureBuilderSetDevice: store<u64>(P(a, 0), X(a, 1), O.TB_dev); return 0;
    case F.nvnTextureBuilderSetFlags: store<i32>(P(a, 0), I(a, 1), O.TB_d + O.TD_flags); return 0;
    case F.nvnTextureBuilderSetTarget: store<i32>(P(a, 0), I(a, 1), O.TB_d + O.TD_target); return 0;
    case F.nvnTextureBuilderSetWidth: store<i32>(P(a, 0), I(a, 1), O.TB_d + O.TD_width); return 0;
    case F.nvnTextureBuilderSetHeight: store<i32>(P(a, 0), I(a, 1), O.TB_d + O.TD_height); return 0;
    case F.nvnTextureBuilderSetDepth: store<i32>(P(a, 0), I(a, 1), O.TB_d + O.TD_depth); return 0;
    case F.nvnTextureBuilderSetSize1D: { const d = P(a, 0) + O.TB_d; store<i32>(d, I(a, 1), O.TD_width); store<i32>(d, 1, O.TD_height); store<i32>(d, 1, O.TD_depth); return 0; }
    case F.nvnTextureBuilderSetSize2D: { const d = P(a, 0) + O.TB_d; store<i32>(d, I(a, 1), O.TD_width); store<i32>(d, I(a, 2), O.TD_height); store<i32>(d, 1, O.TD_depth); return 0; }
    case F.nvnTextureBuilderSetSize3D: { const d = P(a, 0) + O.TB_d; store<i32>(d, I(a, 1), O.TD_width); store<i32>(d, I(a, 2), O.TD_height); store<i32>(d, I(a, 3), O.TD_depth); return 0; }
    case F.nvnTextureBuilderSetLevels: store<i32>(P(a, 0), I(a, 1), O.TB_d + O.TD_levels); return 0;
    case F.nvnTextureBuilderSetFormat: store<i32>(P(a, 0), I(a, 1), O.TB_d + O.TD_format); return 0;
    case F.nvnTextureBuilderSetSamples: store<i32>(P(a, 0), I(a, 1), O.TB_d + O.TD_samples); return 0;
    case F.nvnTextureBuilderSetStride: store<u32>(P(a, 0), <u32>X(a, 1), O.TB_d + O.TD_stride); return 0;
    case F.nvnTextureBuilderSetStorage: store<u64>(P(a, 0), X(a, 1), O.TB_pool); store<u64>(P(a, 0), X(a, 2), O.TB_off); return 0;
    case F.nvnTextureBuilderSetPackagedTextureLayout: {
      const b = P(a, 0), l = P(a, 1);
      store<u8>(b, l ? 1 : 0, O.TB_has_layout);
      if (l) memory.copy(b + O.TB_layout, l, 8);
      store<i32>(b, l ? <i32>load<u8>(l) + 1 : 0, O.TB_d + O.TD_pkg_block_h);
      return 0;
    }
    case F.nvnTextureBuilderSetPackagedTextureData: store<u64>(P(a, 0), X(a, 1), O.TB_pkg_data); return 0;
    case F.nvnTextureBuilderGetSwizzle: swizzleOut((load<u8>(P(a, 0), O.TB_bits) & 1) != 0, load<u16>(P(a, 0), O.TB_swz), a); return 0;
    case F.nvnTextureGetSwizzle: swizzleOut((load<u8>(P(a, 0), O.TEX_bits) & 1) != 0, load<u16>(P(a, 0), O.TEX_swz), a); return 0;
    case F.nvnTextureBuilderSetSwizzle: {
      const b = P(a, 0);
      store<u8>(b, load<u8>(b, O.TB_bits) | 1, O.TB_bits);
      store<u16>(b, <u16>((I(a, 1) & 7) | (I(a, 2) & 7) << 3 | (I(a, 3) & 7) << 6 | (I(a, 4) & 7) << 9), O.TB_swz);
      return 0;
    }
    case F.nvnTextureBuilderSetDepthStencilMode: { const b = P(a, 0); store<u8>(b, (load<u8>(b, O.TB_bits) & ~2) | (I(a, 1) == 1 ? 2 : 0), O.TB_bits); return 0; }
    case F.nvnTextureBuilderGetStorageSize: {
      texLayout(P(a, 0) + O.TB_d, TMP_L);
      if (!load<u32>(TMP_L, O.TL_bpb)) { L.red("TextureBuilderGetStorageSize unknown format 0x"); L.hex(<u32>load<i32>(P(a, 0), O.TB_d + O.TD_format)); L.end(); }
      return load<u64>(TMP_L, O.TL_size);
    }
    case F.nvnTextureBuilderGetStorageAlignment: texLayout(P(a, 0) + O.TB_d, TMP_L); return load<u32>(TMP_L, O.TL_align);
    case F.nvnTextureBuilderGetFlags: return <u64><u32>load<i32>(P(a, 0), O.TB_d + O.TD_flags);
    case F.nvnTextureBuilderGetTarget: return <u64><u32>load<i32>(P(a, 0), O.TB_d + O.TD_target);
    case F.nvnTextureBuilderGetWidth: return load<u32>(P(a, 0), O.TB_d + O.TD_width);
    case F.nvnTextureBuilderGetHeight: return load<u32>(P(a, 0), O.TB_d + O.TD_height);
    case F.nvnTextureBuilderGetDepth: return load<u32>(P(a, 0), O.TB_d + O.TD_depth);
    case F.nvnTextureBuilderGetLevels: return load<u32>(P(a, 0), O.TB_d + O.TD_levels);
    case F.nvnTextureBuilderGetFormat: return <u64><u32>load<i32>(P(a, 0), O.TB_d + O.TD_format);
    case F.nvnTextureBuilderGetSamples: return <u64><u32>load<i32>(P(a, 0), O.TB_d + O.TD_samples);
    case F.nvnTextureBuilderGetMemoryPool: return load<u64>(P(a, 0), O.TB_pool);
    case F.nvnTextureBuilderGetMemoryOffset: return load<u64>(P(a, 0), O.TB_off);
    case F.nvnTextureInitialize: return textureInitialize(P(a, 0), P(a, 1));
    case F.nvnTextureFinalize: texFinalize(P(a, 0)); return 0;
    case F.nvnTextureSetDebugLabel: return 0;
    case F.nvnTextureGetFlags: return <u64><u32>load<i32>(P(a, 0), O.TEX_d + O.TD_flags);
    case F.nvnTextureGetTarget: return <u64><u32>load<i32>(P(a, 0), O.TEX_d + O.TD_target);
    case F.nvnTextureGetWidth: return load<u32>(P(a, 0), O.TEX_d + O.TD_width);
    case F.nvnTextureGetHeight: return load<u32>(P(a, 0), O.TEX_d + O.TD_height);
    case F.nvnTextureGetDepth: return load<u32>(P(a, 0), O.TEX_d + O.TD_depth);
    case F.nvnTextureGetLevels: return load<u32>(P(a, 0), O.TEX_d + O.TD_levels);
    case F.nvnTextureGetFormat: return <u64><u32>load<i32>(P(a, 0), O.TEX_d + O.TD_format);
    case F.nvnTextureGetSamples: return <u64><u32>load<i32>(P(a, 0), O.TEX_d + O.TD_samples);
    case F.nvnTextureGetStride: return load<u32>(P(a, 0), O.TEX_d + O.TD_stride);
    case F.nvnTextureGetStorageSize: return load<u64>(P(a, 0), O.TEX_L + O.TL_size);
    case F.nvnTextureGetMemoryPool: return load<u64>(P(a, 0), O.TEX_pool);
    case F.nvnTextureGetMemoryOffset: return load<u64>(P(a, 0), O.TEX_off);
    case F.nvnTextureGetTextureAddress: { const t = P(a, 0), pool = <usize>load<u64>(t, O.TEX_pool); return pool ? load<u64>(pool, O.POOL_mem) + load<u64>(t, O.TEX_off) : 0; }
    case F.nvnTextureGetViewOffset: { const t = P(a, 0); return viewOffset(t + O.TEX_d, load<u64>(t, O.TEX_L + O.TL_layer_size), P(a, 1)); }
    // Texels between the CPU and a texture. From the storage when it holds the content; a texture the GPU wrote cannot be
    // read back within the call (WebGPU readback is asynchronous): red, and the destination is left as it was
    case F.nvnTextureWriteTexels: case F.nvnTextureWriteTexelsStrided: {
      const v = P(a, 1), s = fn == F.nvnTextureWriteTexelsStrided;
      writeTexels(P(a, 0), v && (load<u8>(v) & 1) ? load<u8>(v, O.VIEW_base_level) : 0, v && (load<u8>(v) & 2) ? load<u16>(v, O.VIEW_min_layer) : 0, P(a, 2), P(a, 3), s ? P(a, 4) : 0, s ? P(a, 5) : 0);
      return 0;
    }
    case F.nvnTextureReadTexels: case F.nvnTextureReadTexelsStrided: {
      const v = P(a, 1), s = fn == F.nvnTextureReadTexelsStrided;
      hostFlush();
      if (!regionCopy(P(a, 0), v && (load<u8>(v) & 1) ? load<u8>(v, O.VIEW_base_level) : 0, v && (load<u8>(v) & 2) ? load<u16>(v, O.VIEW_min_layer) : 0, P(a, 2), P(a, 3), s ? P(a, 4) : 0, s ? P(a, 5) : 0, false))
        L.redLine("ReadTexels of a texture the GPU wrote: not available within the call (use CopyTextureToBuffer and a sync); nothing is written");
      else hostRec(H_MEM_DIRTY, 8);
      return 0;
    }
    case F.nvnTextureViewSetDefaults: memory.fill(P(a, 0), 0, O.VIEW_SIZE); return 0;
    case F.nvnTextureViewSetLevels: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 1); store<u8>(v, <u8>I(a, 1), O.VIEW_base_level); store<u8>(v, <u8>I(a, 2), O.VIEW_nlevels); return 0; }
    case F.nvnTextureViewSetLayers: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 2); store<u16>(v, <u16>I(a, 1), O.VIEW_min_layer); store<u16>(v, <u16>I(a, 2), O.VIEW_nlayers); return 0; }
    case F.nvnTextureViewSetFormat: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 4); store<u16>(v, <u16>I(a, 1), O.VIEW_format); return 0; }
    case F.nvnTextureViewSetTarget: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 8); store<u8>(v, <u8>I(a, 1), O.VIEW_target); return 0; }
    case F.nvnTextureViewSetSwizzle: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 16); for (let i: usize = 0; i < 4; i++) store<u8>(v + O.VIEW_swz + i, <u8>I(a, 1 + i)); return 0; }
    case F.nvnTextureViewSetDepthStencilMode: { const v = P(a, 0); store<u8>(v, (load<u8>(v) & 0x3f) | 32 | (<u8>(I(a, 1) & 3) << 6)); return 0; }
    case F.nvnTextureViewGetFormat: { const v = P(a, 0); if (P(a, 1)) store<i32>(P(a, 1), load<u16>(v, O.VIEW_format)); return (load<u8>(v) >> 2) & 1; }
    case F.nvnTextureViewGetTarget: { const v = P(a, 0); if (P(a, 1)) store<i32>(P(a, 1), load<u8>(v, O.VIEW_target)); return (load<u8>(v) >> 3) & 1; }
    case F.nvnTextureViewGetLayers: { const v = P(a, 0); store<i32>(P(a, 1), load<u16>(v, O.VIEW_min_layer)); store<i32>(P(a, 2), load<u16>(v, O.VIEW_nlayers)); return (load<u8>(v) >> 1) & 1; }
    case F.nvnTextureViewGetLevels: { const v = P(a, 0); store<i32>(P(a, 1), load<u8>(v, O.VIEW_base_level)); store<i32>(P(a, 2), load<u8>(v, O.VIEW_nlevels)); return load<u8>(v) & 1; }

    // ---------- Samplers ----------
    case F.nvnSamplerBuilderSetDefaults: {
      const b = P(a, 0), d = load<u64>(b), p = b + O.SB_p;
      memory.fill(b, 0, O.SB_SIZE); store<u64>(b, d);
      store<u8>(p, 4, O.SP_minf); store<u8>(p, 1, O.SP_magf);            // GL defaults: NEAREST_MIPMAP_LINEAR / LINEAR
      store<u8>(p, 1, O.SP_ws); store<u8>(p, 1, O.SP_wt); store<u8>(p, 1, O.SP_wr); store<u8>(p, 2, O.SP_cmp_func);   // REPEAT, LESS
      store<f32>(p, -1000, O.SP_lod_min); store<f32>(p, 1000, O.SP_lod_max); store<f32>(p, 1, O.SP_aniso);
      return 0;
    }
    case F.nvnSamplerBuilderSetDevice: store<u64>(P(a, 0), X(a, 1), O.SB_dev); return 0;
    case F.nvnSamplerBuilderSetMinMagFilter: { const p = P(a, 0) + O.SB_p; store<u8>(p, <u8>I(a, 1), O.SP_minf); store<u8>(p, <u8>I(a, 2), O.SP_magf); return 0; }
    case F.nvnSamplerBuilderSetWrapMode: { const p = P(a, 0) + O.SB_p; store<u8>(p, <u8>I(a, 1), O.SP_ws); store<u8>(p, <u8>I(a, 2), O.SP_wt); store<u8>(p, <u8>I(a, 3), O.SP_wr); return 0; }
    case F.nvnSamplerBuilderSetLodClamp: { const p = P(a, 0) + O.SB_p; store<f32>(p, FL(a, 0), O.SP_lod_min); store<f32>(p, FL(a, 1), O.SP_lod_max); return 0; }
    case F.nvnSamplerBuilderSetLodBias: store<f32>(P(a, 0) + O.SB_p, FL(a, 0), O.SP_lod_bias); return 0;
    case F.nvnSamplerBuilderSetCompare: { const p = P(a, 0) + O.SB_p; store<u8>(p, <u8>I(a, 1), O.SP_cmp_mode); store<u8>(p, <u8>I(a, 2), O.SP_cmp_func); return 0; }
    case F.nvnSamplerBuilderSetBorderColor: memory.copy(P(a, 0) + O.SB_p + O.SP_border, P(a, 1), 16); return 0;
    case F.nvnSamplerBuilderSetMaxAnisotropy: store<f32>(P(a, 0) + O.SB_p, FL(a, 0), O.SP_aniso); return 0;
    case F.nvnSamplerBuilderSetLodSnap: return 0;
    case F.nvnSamplerBuilderGetMinMagFilter: { const p = P(a, 0) + O.SB_p; store<i32>(P(a, 1), load<u8>(p, O.SP_minf)); store<i32>(P(a, 2), load<u8>(p, O.SP_magf)); return 0; }
    case F.nvnSamplerBuilderGetWrapMode: { const p = P(a, 0) + O.SB_p; store<i32>(P(a, 1), load<u8>(p, O.SP_ws)); store<i32>(P(a, 2), load<u8>(p, O.SP_wt)); store<i32>(P(a, 3), load<u8>(p, O.SP_wr)); return 0; }
    case F.nvnSamplerBuilderGetLodClamp: { const p = P(a, 0) + O.SB_p; store<f32>(P(a, 1), load<f32>(p, O.SP_lod_min)); store<f32>(P(a, 2), load<f32>(p, O.SP_lod_max)); return 0; }
    case F.nvnSamplerInitialize: {      // every byte of the record is written: games hash a sampler from byte 8
      const s = P(a, 0);
      memory.fill(s, 0, O.SAMP_SIZE); store<u32>(s, O.MAGIC_SAMP); memory.copy(s + O.SAMP_p, P(a, 1) + O.SB_p, O.SP_SIZE);
      return 1;
    }
    case F.nvnSamplerFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnSamplerBuilderGetLodBias: return RETF(a, load<f32>(P(a, 0) + O.SB_p, O.SP_lod_bias));
    case F.nvnSamplerBuilderGetMaxAnisotropy: return RETF(a, load<f32>(P(a, 0) + O.SB_p, O.SP_aniso));
    case F.nvnSamplerBuilderGetCompare: { const p = P(a, 0) + O.SB_p; store<i32>(P(a, 1), load<u8>(p, O.SP_cmp_mode)); store<i32>(P(a, 2), load<u8>(p, O.SP_cmp_func)); return 0; }
    case F.nvnSamplerBuilderGetBorderColor: memory.copy(P(a, 1), P(a, 0) + O.SB_p + O.SP_border, 16); return 0;
    case F.nvnSamplerGetMinMagFilter: { const p = P(a, 0) + O.SAMP_p; store<i32>(P(a, 1), load<u8>(p, O.SP_minf)); store<i32>(P(a, 2), load<u8>(p, O.SP_magf)); return 0; }
    case F.nvnSamplerGetWrapMode: { const p = P(a, 0) + O.SAMP_p; store<i32>(P(a, 1), load<u8>(p, O.SP_ws)); store<i32>(P(a, 2), load<u8>(p, O.SP_wt)); store<i32>(P(a, 3), load<u8>(p, O.SP_wr)); return 0; }
    case F.nvnSamplerGetLodClamp: { const p = P(a, 0) + O.SAMP_p; store<f32>(P(a, 1), load<f32>(p, O.SP_lod_min)); store<f32>(P(a, 2), load<f32>(p, O.SP_lod_max)); return 0; }
    case F.nvnSamplerGetLodBias: return RETF(a, load<f32>(P(a, 0) + O.SAMP_p, O.SP_lod_bias));
    case F.nvnSamplerGetCompare: { const p = P(a, 0) + O.SAMP_p; store<i32>(P(a, 1), load<u8>(p, O.SP_cmp_mode)); store<i32>(P(a, 2), load<u8>(p, O.SP_cmp_func)); return 0; }
    case F.nvnSamplerGetBorderColor: memory.copy(P(a, 1), P(a, 0) + O.SAMP_p + O.SP_border, 16); return 0;
    case F.nvnSamplerGetMaxAnisotropy: return RETF(a, load<f32>(P(a, 0) + O.SAMP_p, O.SP_aniso));
    case F.nvnSamplerSetDebugLabel: return 0;

    // ---------- Programs ----------
    case F.nvnProgramInitialize: memory.fill(P(a, 0), 0, O.PROG_SIZE); store<u32>(P(a, 0), O.MAGIC_PROG); return 1;
    // NVN2's program builder (nxnative prog_builder_t { device, shader data, count }): InitializeFromBuilder is Initialize + SetShaders
    case F.nvnProgramBuilderSetDefaults: memory.fill(P(a, 0), 0, 24); return 0;
    case F.nvnProgramBuilderSetDevice: store<u64>(P(a, 0), X(a, 1)); return 0;
    case F.nvnProgramBuilderGetDevice: return load<u64>(P(a, 0));
    case F.nvnProgramBuilderSetShaders: store<u64>(P(a, 0), X(a, 2), 8); store<i32>(P(a, 0), I(a, 1), 16); return 0;
    case F.nvnProgramBuilderGetShaderCount: return <u64>load<i32>(P(a, 0), 16);
    case F.nvnProgramInitializeFromBuilder: {
      const p = X(a, 0), b = P(a, 1), n = load<i32>(b, 16);
      store<u64>(ARGS2, p); call(F.nvnProgramInitialize, ARGS2);
      if (!n) return 1;
      store<u64>(ARGS2, p); store<u64>(ARGS2, <u64>n, 8); store<u64>(ARGS2, load<u64>(b, 8), 16);
      return call(F.nvnProgramSetShaders, ARGS2);
    }
    case F.nvnProgramFinalize: T.progFree(load<u64>(P(a, 0), O.PROG_serial)); store<u32>(P(a, 0), 0); return 0;
    case F.nvnProgramSetDebugLabel: return 0;
    case F.nvnProgramSetShaders: {
      const p = P(a, 0), n = I(a, 1), sd = P(a, 2);
      if (n < 0 || n > 6) { L.red("ProgramSetShaders stage count "); L.i(n); L.end(); return 0; }
      T.progFree(load<u64>(p, O.PROG_serial));
      store<u32>(p, n, O.PROG_nstage); memory.copy(p + O.PROG_sd, sd, <usize>n << 4);
      const e = T.progNew();
      store<u64>(p, e ? load<u64>(e) : 0, O.PROG_serial);
      if (e) progSetKeys(e, n, sd);
      return 1;
    }

    // NVN 55: each stage is 0x18 bytes, { data, control } plus an extension field the host does not use (as nxnative): SetShaders on the pairs
    case F.nvnProgramSetShadersExt: {
      const n = I(a, 1), sd = P(a, 2);
      if (n < 0 || n > 6) { L.red("ProgramSetShadersExt stage count "); L.i(n); L.end(); return 0; }
      for (let i = 0; i < n; i++) memory.copy(SD_PLAIN + (<usize>i << 4), sd + <usize>i * 24, 16);
      store<u64>(ARGS2, X(a, 0)); store<u64>(ARGS2, <u64>n, 8); store<u64>(ARGS2, <u64>SD_PLAIN, 16);
      return call(F.nvnProgramSetShaders, ARGS2);
    }

    // ---------- Sync, queue ----------
    case F.nvnSyncInitialize: syncInitialize(P(a, 0)); return 1;
    case F.nvnSyncFinalize: syncFinalize(P(a, 0)); return 0;
    case F.nvnSyncSetDebugLabel: return 0;
    case F.nvnSyncWait: return syncWait(P(a, 0), X(a, 1));
    // Events: a 32-bit word in a memory pool the game gave as storage (nxnative ev_t); the CPU and command buffers write it
    case F.nvnEventBuilderSetDefaults: memory.fill(P(a, 0), 0, O.EVB_SIZE); return 0;
    case F.nvnEventBuilderSetStorage: store<u64>(P(a, 0), X(a, 1), O.EVB_pool); store<u64>(P(a, 0), X(a, 2), O.EVB_off); return 0;
    case F.nvnEventBuilderGetStorage: { const b = P(a, 0), o = P(a, 1); if (o) store<u64>(o, load<u64>(b, O.EVB_off)); return load<u64>(b, O.EVB_pool); }
    case F.nvnEventBuilderGetMemoryPool: return load<u64>(P(a, 0), O.EVB_pool);
    case F.nvnEventBuilderGetMemoryOffset: return load<u64>(P(a, 0), O.EVB_off);
    case F.nvnEventInitialize: {
      const e = P(a, 0), b = P(a, 1), pool = <usize>load<u64>(b, O.EVB_pool);
      if (!pool || !load<u64>(pool, O.POOL_mem)) { L.red("EventInitialize has no storage"); L.end(); return 0; }
      store<u32>(e, O.MAGIC_EVENT); store<u64>(e, load<u64>(pool, O.POOL_mem) + load<u64>(b, O.EVB_off), O.EV_val);
      store<u64>(e, pool, O.EV_pool); store<u64>(e, load<u64>(b, O.EVB_off), O.EV_off);
      return 1;
    }
    case F.nvnEventFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnEventGetMemoryPool: return load<u64>(P(a, 0), O.EV_pool);
    case F.nvnEventGetMemoryOffset: return load<u64>(P(a, 0), O.EV_off);
    case F.nvnEventGetValue: return load<u32>(<usize>load<u64>(P(a, 0), O.EV_val));
    case F.nvnEventSignal: C.eventPublish(<usize>load<u64>(P(a, 0), O.EV_val), I(a, 1), <u32>I(a, 2)); return 0;
    case F.nvnQueueBuilderSetDefaults: {
      const b = P(a, 0), d = load<u64>(b);
      memory.fill(b, 0, O.QB_SIZE); store<u64>(b, d);
      store<u64>(b, 65536, O.QB_cmd_sz); store<u64>(b, 262144, O.QB_comp_sz); store<u64>(b, 16384, O.QB_ctl_sz); store<u64>(b, 4096, O.QB_flush);
      return 0;
    }
    // NVN2 ties a queue to a primary one; the host runs every queue's submissions in order on its one queue, so the tie needs no work
    case F.nvnQueueBuilderSetPrimaryQueue: return 0;
    case F.nvnQueueBuilderSetDevice: store<u64>(P(a, 0), X(a, 1), O.QB_dev); return 0;
    case F.nvnQueueBuilderSetFlags: store<u32>(P(a, 0), I(a, 1), O.QB_flags); return 0;
    case F.nvnQueueBuilderSetCommandMemorySize: store<u64>(P(a, 0), X(a, 1), O.QB_cmd_sz); return 0;
    case F.nvnQueueBuilderSetComputeMemorySize: store<u64>(P(a, 0), X(a, 1), O.QB_comp_sz); return 0;
    case F.nvnQueueBuilderSetControlMemorySize: store<u64>(P(a, 0), X(a, 1), O.QB_ctl_sz); return 0;
    case F.nvnQueueBuilderSetCommandFlushThreshold: store<u64>(P(a, 0), X(a, 1), O.QB_flush); return 0;
    case F.nvnQueueBuilderGetQueueMemorySize: { const b = P(a, 0); return (load<u64>(b, O.QB_cmd_sz) + load<u64>(b, O.QB_comp_sz) + load<u64>(b, O.QB_ctl_sz) + 4095) & ~<u64>4095; }
    case F.nvnQueueBuilderSetQueueMemory: store<u64>(P(a, 0), X(a, 1), O.QB_mem); store<u64>(P(a, 0), X(a, 2), O.QB_mem_sz); return 0;
    case F.nvnQueueInitialize: {
      const q = P(a, 0), d = <usize>load<u64>(P(a, 1), O.QB_dev);
      memory.fill(q, 0, O.QUEUE_SIZE);
      store<u32>(q, O.MAGIC_QUEUE); store<u64>(q, d, O.QUEUE_dev); store<i32>(q, !d || load<u32>(d, O.DEV_origin) == 0 ? 1 : 0, O.QUEUE_origin_ll);
      store<u64>(q, ++queueSerial, O.QUEUE_serial);
      return 1;
    }
    case F.nvnQueueFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnQueueSetDebugLabel: return 0;
    case F.nvnQueueGetError: return 0;                     // GPU_NO_ERROR
    case F.nvnQueueSubmitCommands: { const q = P(a, 0); store<u64>(q, load<u64>(q, O.QUEUE_submits) + 1, O.QUEUE_submits); submit(I(a, 1), P(a, 2)); texDoomedRelease(); return 0; }
    case F.nvnQueueFlush: hostFlush(); return 0;           // everything submitted so far is with the replayer
    // DEPARTS: nxnative's Finish blocks until the GPU is done. A browser turn cannot block: the work is flushed with a
    // fence behind it (fences also wait for texture and buffer read-backs to land in guest memory), and the embedder
    // parks the thread until gfx_finish_fence() is done
    case F.nvnQueueFinish: passBreak(); finishFence = fenceNew(); store<u64>(hostRec(H_FENCE, 16), finishFence, 8); hostRec(H_FLUSH, 8); hostFlush(); return 0;
    case F.nvnQueueFenceSync: passBreak(); emitFence(P(a, 1)); hostFlush(); return 0;
    case F.nvnQueuePresentTexture: windowPresent(P(a, 1), I(a, 2)); return 0;
    // nxnative queues a wait for the sync's fence ahead of the queue's later work. Here every queue's submissions run in
    // order on one host queue, so a fence submitted before the wait is already ahead of what follows it: nothing to add
    case F.nvnQueueWaitSync: return 1;
    case F.nvnQueueAcquireTexture: return windowAcquire(P(a, 1), 0, P(a, 2));

    // ---------- Windows ----------
    case F.nvnWindowBuilderSetDefaults: { const b = P(a, 0), d = load<u64>(b); memory.fill(b, 0, O.WB_SIZE); store<u64>(b, d); store<i32>(b, 1, O.WB_interval); return 0; }
    case F.nvnWindowBuilderSetDevice: store<u64>(P(a, 0), X(a, 1), O.WB_dev); return 0;
    case F.nvnWindowBuilderSetNativeWindow: store<u64>(P(a, 0), X(a, 1), O.WB_native); return 0;
    case F.nvnWindowBuilderSetTextures: {
      const b = P(a, 0); let n = I(a, 1);
      if (n < 0 || n > 4) { L.red("WindowBuilderSetTextures count "); L.i(n); L.end(); n = n < 0 ? 0 : 4; }
      store<i32>(b, n, O.WB_ntex); memory.copy(b + O.WB_tex, P(a, 2), <usize>n << 3);
      return 0;
    }
    case F.nvnWindowBuilderSetPresentInterval: store<i32>(P(a, 0), I(a, 1), O.WB_interval); return 0;
    // The first n of the swap chain's textures are handed out (0 or more than there are: all of them)
    case F.nvnWindowBuilderSetNumActiveTextures: store<i32>(P(a, 0), I(a, 1), O.WB_nactive); return 0;
    case F.nvnWindowBuilderGetNumActiveTextures: { const b = P(a, 0), n = load<i32>(b, O.WB_ntex), k = load<i32>(b, O.WB_nactive); return k > 0 && (k < n || !n) ? k : n; }
    case F.nvnWindowSetNumActiveTextures: store<i32>(P(a, 0), I(a, 1), O.WIN_nactive); return 0;
    case F.nvnWindowGetNumActiveTextures: { const w = P(a, 0), n = load<i32>(w, O.WIN_ntex), k = load<i32>(w, O.WIN_nactive); return k > 0 && k < n ? k : n; }
    case F.nvnWindowBuilderGetPresentInterval: return <u64><u32>load<i32>(P(a, 0), O.WB_interval);
    case F.nvnWindowBuilderGetNativeWindow: return load<u64>(P(a, 0), O.WB_native);
    case F.nvnWindowInitialize: return windowInitialize(P(a, 0), P(a, 1));
    case F.nvnWindowFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnWindowSetDebugLabel: return 0;
    case F.nvnWindowAcquireTexture: return windowAcquire(P(a, 0), P(a, 1), P(a, 2));
    case F.nvnWindowGetNativeWindow: return load<u64>(P(a, 0), O.WIN_native);
    case F.nvnWindowGetPresentInterval: return <u64><u32>windowInterval(P(a, 0));
    case F.nvnWindowSetPresentInterval: store<i32>(P(a, 0), I(a, 1), O.WIN_interval); return 0;
    case F.nvnWindowSetCrop: { const w = P(a, 0) + O.WIN_crop; store<i32>(w, I(a, 1)); store<i32>(w, I(a, 2), 4); store<i32>(w, I(a, 3), 8); store<i32>(w, I(a, 4), 12); return 0; }
    case F.nvnWindowGetCrop: windowGetCrop(P(a, 0), P(a, 1)); return 0;

    // ---------- State objects ----------
    case F.nvnBlendStateSetDefaults: store<u64>(P(a, 0), blendDefault(0)); return 0;
    case F.nvnBlendStateSetBlendTarget: bits64(P(a, 0), 0, 3, <u64>I(a, 1)); return 0;
    case F.nvnBlendStateSetBlendFunc: { const s = P(a, 0); bits64(s, 3, 7, <u64>I(a, 1)); bits64(s, 10, 7, <u64>I(a, 2)); bits64(s, 17, 7, <u64>I(a, 3)); bits64(s, 24, 7, <u64>I(a, 4)); return 0; }
    case F.nvnBlendStateSetBlendEquation: bits64(P(a, 0), 31, 3, <u64>I(a, 1)); bits64(P(a, 0), 34, 3, <u64>I(a, 2)); return 0;
    case F.nvnBlendStateGetBlendTarget: return load<u64>(P(a, 0)) & 7;
    case F.nvnBlendStateGetBlendFunc: { const v = load<u64>(P(a, 0)); store<i32>(P(a, 1), <i32>((v >> 3) & 127)); store<i32>(P(a, 2), <i32>((v >> 10) & 127)); store<i32>(P(a, 3), <i32>((v >> 17) & 127)); store<i32>(P(a, 4), <i32>((v >> 24) & 127)); return 0; }
    case F.nvnBlendStateGetBlendEquation: { const v = load<u64>(P(a, 0)); store<i32>(P(a, 1), <i32>((v >> 31) & 7)); store<i32>(P(a, 2), <i32>((v >> 34) & 7)); return 0; }
    case F.nvnColorStateSetDefaults: store<u32>(P(a, 0), (3 << 8) | (8 << 12)); return 0;      // logic op COPY, alpha func ALWAYS
    case F.nvnColorStateSetBlendEnable: { const i = I(a, 1); if (i >= 0 && i <= 7) bits32(P(a, 0), i, 1, B(a, 2) ? 1 : 0); return 0; }
    case F.nvnColorStateSetLogicOp: bits32(P(a, 0), 8, 4, I(a, 1)); return 0;
    case F.nvnColorStateSetAlphaTest: bits32(P(a, 0), 12, 4, I(a, 1)); return 0;
    case F.nvnColorStateGetBlendEnable: return (load<u32>(P(a, 0)) >> (I(a, 1) & 7)) & 1;
    case F.nvnChannelMaskStateSetDefaults: store<u32>(P(a, 0), 0xffffffff); return 0;
    case F.nvnChannelMaskStateSetChannelMask: {
      const i = I(a, 1); if (i < 0 || i > 7) return 0;
      bits32(P(a, 0), i * 4, 4, (B(a, 2) ? 1 : 0) | (B(a, 3) ? 2 : 0) | (B(a, 4) ? 4 : 0) | (B(a, 5) ? 8 : 0));
      return 0;
    }
    case F.nvnMultisampleStateSetDefaults: memory.fill(P(a, 0), 0, O.MS_ST_SIZE); store<u8>(P(a, 0), 1); return 0;
    case F.nvnMultisampleStateSetMultisampleEnable: store<u8>(P(a, 0), B(a, 1) ? 1 : 0); return 0;
    case F.nvnMultisampleStateSetSamples: store<u8>(P(a, 0), <u8>I(a, 1), 1); return 0;
    case F.nvnMultisampleStateSetAlphaToCoverageEnable: store<u8>(P(a, 0), B(a, 1) ? 1 : 0, 2); return 0;
    case F.nvnMultisampleStateGetSamples: return load<u8>(P(a, 0), 1);
    case F.nvnMultisampleStateGetMultisampleEnable: return load<u8>(P(a, 0));
    case F.nvnMultisampleStateGetAlphaToCoverageEnable: return load<u8>(P(a, 0), 2);
    case F.nvnPolygonStateSetDefaults: store<u32>(P(a, 0), (1 << 2) | (2 << 3)); return 0;     // no culling, CCW, FILL
    case F.nvnPolygonStateSetCullFace: bits32(P(a, 0), 0, 2, I(a, 1)); return 0;
    case F.nvnPolygonStateSetFrontFace: bits32(P(a, 0), 2, 1, I(a, 1)); return 0;
    case F.nvnPolygonStateSetPolygonMode: bits32(P(a, 0), 3, 2, I(a, 1)); return 0;
    case F.nvnPolygonStateSetPolygonOffsetEnables: bits32(P(a, 0), 5, 3, I(a, 1)); return 0;
    case F.nvnPolygonStateGetCullFace: return load<u32>(P(a, 0)) & 3;
    case F.nvnPolygonStateGetFrontFace: return (load<u32>(P(a, 0)) >> 2) & 1;
    case F.nvnPolygonStateGetPolygonMode: return (load<u32>(P(a, 0)) >> 3) & 3;
    case F.nvnPolygonStateGetPolygonOffsetEnables: return (load<u32>(P(a, 0)) >> 5) & 7;
    case F.nvnDepthStencilStateSetDefaults: store<u64>(P(a, 0), dsDefault()); return 0;
    case F.nvnDepthStencilStateSetDepthTestEnable: bits64(P(a, 0), 0, 1, B(a, 1) ? 1 : 0); return 0;
    case F.nvnDepthStencilStateSetDepthWriteEnable: bits64(P(a, 0), 1, 1, B(a, 1) ? 1 : 0); return 0;
    case F.nvnDepthStencilStateSetDepthFunc: bits64(P(a, 0), 2, 4, <u64>I(a, 1)); return 0;
    case F.nvnDepthStencilStateSetStencilTestEnable: bits64(P(a, 0), 6, 1, B(a, 1) ? 1 : 0); return 0;
    case F.nvnDepthStencilStateSetStencilFunc: { const f = I(a, 1); if (f & 1) bits64(P(a, 0), 7, 4, <u64>I(a, 2)); if (f & 2) bits64(P(a, 0), 11, 4, <u64>I(a, 2)); return 0; }
    case F.nvnDepthStencilStateSetStencilOp: {
      const s = P(a, 0), f = I(a, 1);
      if (f & 1) { bits64(s, 15, 4, <u64>I(a, 2)); bits64(s, 19, 4, <u64>I(a, 3)); bits64(s, 23, 4, <u64>I(a, 4)); }
      if (f & 2) { bits64(s, 27, 4, <u64>I(a, 2)); bits64(s, 31, 4, <u64>I(a, 3)); bits64(s, 35, 4, <u64>I(a, 4)); }
      return 0;
    }
    case F.nvnDepthStencilStateGetDepthTestEnable: return load<u64>(P(a, 0)) & 1;
    case F.nvnDepthStencilStateGetDepthWriteEnable: return (load<u64>(P(a, 0)) >> 1) & 1;
    case F.nvnDepthStencilStateGetDepthFunc: return (load<u64>(P(a, 0)) >> 2) & 15;
    case F.nvnDepthStencilStateGetStencilTestEnable: return (load<u64>(P(a, 0)) >> 6) & 1;
    case F.nvnVertexAttribStateSetDefaults: store<u32>(P(a, 0), 0); return 0;
    case F.nvnVertexAttribStateSetFormat: {
      const off = <i64>X(a, 2);
      if (off < 0 || off >= (1 << 19)) { L.red("vertex attribute offset "); L.i(off); L.str(" exceeds the packed range"); L.end(); }
      bits32(P(a, 0), 0, 8, I(a, 1)); bits32(P(a, 0), 8, 19, <u32>off);
      return 0;
    }
    case F.nvnVertexAttribStateSetStreamIndex: bits32(P(a, 0), 27, 5, I(a, 1)); return 0;
    case F.nvnVertexAttribStateGetFormat: { const v = load<u32>(P(a, 0)); if (P(a, 1)) store<i32>(P(a, 1), v & 0xff); if (P(a, 2)) store<i64>(P(a, 2), (v >> 8) & 0x7ffff); return 0; }
    case F.nvnVertexAttribStateGetStreamIndex: return load<u32>(P(a, 0)) >> 27;
    case F.nvnVertexStreamStateSetDefaults: store<u64>(P(a, 0), 0); return 0;
    case F.nvnVertexStreamStateSetStride: store<u32>(P(a, 0), <u32>X(a, 1)); return 0;
    case F.nvnVertexStreamStateSetDivisor: store<u32>(P(a, 0), I(a, 1), 4); return 0;
    case F.nvnVertexStreamStateGetStride: return load<u32>(P(a, 0));
    case F.nvnVertexStreamStateGetDivisor: return load<u32>(P(a, 0), 4);

    // ---------- Command buffers ----------
    case F.nvnCommandBufferInitialize: return C.cmdInitialize(P(a, 0), X(a, 1));
    case F.nvnCommandBufferFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnCommandBufferSetDebugLabel: return 0;
    case F.nvnCommandBufferSetMemoryCallback: store<u64>(P(a, 0), X(a, 1), O.CMD_cb); return 0;
    case F.nvnCommandBufferSetMemoryCallbackData: store<u64>(P(a, 0), X(a, 1), O.CMD_cb_data); return 0;
    case F.nvnCommandBufferAddCommandMemory: C.addCommandMemory(P(a, 0), P(a, 1), <i64>X(a, 2), X(a, 3)); return 0;
    case F.nvnCommandBufferAddControlMemory: store<u64>(P(a, 0), X(a, 2), O.CMD_ctl_size); return 0;   // the host records no control commands: the whole block stays free
    case F.nvnCommandBufferGetCommandMemorySize: return load<u64>(P(a, 0), O.CMD_cmd_size);
    case F.nvnCommandBufferGetCommandMemoryUsed: return C.memoryUsed(P(a, 0));
    case F.nvnCommandBufferGetCommandMemoryFree: return C.memoryFree(P(a, 0));
    case F.nvnCommandBufferGetControlMemorySize: return load<u64>(P(a, 0), O.CMD_ctl_size);
    case F.nvnCommandBufferGetControlMemoryUsed: return 0;
    case F.nvnCommandBufferGetControlMemoryFree: return load<u64>(P(a, 0), O.CMD_ctl_size);
    case F.nvnCommandBufferBeginRecording: C.beginRecording(P(a, 0)); return 0;
    case F.nvnCommandBufferEndRecording: return C.endRecording(P(a, 0));
    case F.nvnCommandBufferIsRecording: return C.isRecording(P(a, 0)) ? 1 : 0;
    case F.nvnCommandBufferCallCommands: case F.nvnCommandBufferCopyCommands: C.callCommands(P(a, 0), I(a, 1), P(a, 2)); return 0;
    case F.nvnCommandBufferSetRenderTargets: C.setRenderTargets(P(a, 0), I(a, 1), P(a, 2), P(a, 3), P(a, 4), P(a, 5)); return 0;
    case F.nvnCommandBufferClearColor: C.clearColor(P(a, 0), I(a, 1), P(a, 2), I(a, 3), 0); return 0;
    case F.nvnCommandBufferClearColori: C.clearColor(P(a, 0), I(a, 1), P(a, 2), I(a, 3), 1); return 0;
    case F.nvnCommandBufferClearColorui: C.clearColor(P(a, 0), I(a, 1), P(a, 2), I(a, 3), 2); return 0;
    case F.nvnCommandBufferClearDepthStencil: C.clearDepthStencil(P(a, 0), FL(a, 0), <u32>I(a, 1), I(a, 2), I(a, 3)); return 0;
    case F.nvnCommandBufferSetViewport: C.setViewport(P(a, 0), I(a, 1), I(a, 2), I(a, 3), I(a, 4)); return 0;
    case F.nvnCommandBufferSetViewports: C.setViewports(P(a, 0), I(a, 1), I(a, 2), P(a, 3)); return 0;
    case F.nvnCommandBufferSetScissor: C.setScissor(P(a, 0), I(a, 1), I(a, 2), I(a, 3), I(a, 4)); return 0;
    case F.nvnCommandBufferSetScissors: { const r = P(a, 3); if (I(a, 1) == 0 && I(a, 2) >= 1) C.setScissor(P(a, 0), load<i32>(r), load<i32>(r, 4), load<i32>(r, 8), load<i32>(r, 12)); return 0; }   // the host uses only index 0, as nxnative
    case F.nvnCommandBufferSetDepthRange: C.setDepthRange(P(a, 0), FL(a, 0), FL(a, 1)); return 0;
    case F.nvnCommandBufferSetDepthRanges: { const r = P(a, 3); if (I(a, 1) == 0 && I(a, 2) >= 1) C.setDepthRange(P(a, 0), load<f32>(r), load<f32>(r, 4)); return 0; }
    case F.nvnCommandBufferBindProgram: C.bindProgram(P(a, 0), X(a, 1), I(a, 2)); return 0;
    case F.nvnCommandBufferBindBlendState: C.bindState(P(a, 0), 0, P(a, 1), O.BLEND_ST_SIZE); return 0;
    case F.nvnCommandBufferBindColorState: C.bindState(P(a, 0), 1, P(a, 1), O.COLOR_ST_SIZE); return 0;
    case F.nvnCommandBufferBindChannelMaskState: C.bindState(P(a, 0), 2, P(a, 1), O.CHMASK_ST_SIZE); return 0;
    case F.nvnCommandBufferBindMultisampleState: C.bindState(P(a, 0), 3, P(a, 1), O.MS_ST_SIZE); return 0;
    case F.nvnCommandBufferBindPolygonState: C.bindState(P(a, 0), 4, P(a, 1), O.POLY_ST_SIZE); return 0;
    case F.nvnCommandBufferBindDepthStencilState: C.bindState(P(a, 0), 5, P(a, 1), O.DS_ST_SIZE); return 0;
    case F.nvnCommandBufferBindVertexAttribState: C.bindVertexAttribState(P(a, 0), I(a, 1), P(a, 2)); return 0;
    case F.nvnCommandBufferBindVertexStreamState: C.bindVertexStreamState(P(a, 0), I(a, 1), P(a, 2)); return 0;
    case F.nvnCommandBufferBindVertexBuffer: store<u64>(RANGE, X(a, 2)); store<u64>(RANGE, X(a, 3), 8); C.bindVertexBuffers(P(a, 0), I(a, 1), 1, RANGE); return 0;
    case F.nvnCommandBufferBindVertexBuffers: C.bindVertexBuffers(P(a, 0), I(a, 1), I(a, 2), P(a, 3)); return 0;
    case F.nvnCommandBufferBindUniformBuffer: C.bindUniformBuffer(P(a, 0), I(a, 1), I(a, 2), X(a, 3), X(a, 4)); return 0;
    case F.nvnCommandBufferBindUniformBuffers: { const rg = P(a, 4); for (let i = 0, n = I(a, 3); i < n; i++) C.bindUniformBuffer(P(a, 0), I(a, 1), I(a, 2) + i, load<u64>(rg + (<usize>i << 4)), load<u64>(rg + (<usize>i << 4), 8)); return 0; }
    case F.nvnCommandBufferBindTexture: C.bindTexture(P(a, 0), I(a, 1), I(a, 2), X(a, 3)); return 0;
    case F.nvnCommandBufferBindTextures: C.bindTextures(P(a, 0), I(a, 1), I(a, 2), I(a, 3), P(a, 4)); return 0;
    case F.nvnCommandBufferSetStencilValueMask: C.setStencil(P(a, 0), I(a, 1), I(a, 2), 0); return 0;
    case F.nvnCommandBufferSetStencilMask: C.setStencil(P(a, 0), I(a, 1), I(a, 2), 1); return 0;
    case F.nvnCommandBufferSetStencilRef: C.setStencil(P(a, 0), I(a, 1), I(a, 2), 2); return 0;
    case F.nvnCommandBufferSetPolygonOffsetClamp: C.setPolygonOffsetClamp(P(a, 0), FL(a, 0), FL(a, 1), FL(a, 2)); return 0;
    case F.nvnCommandBufferSetBlendColor: C.setBlendColor(P(a, 0), P(a, 1)); return 0;
    case F.nvnCommandBufferDrawArrays: C.drawArrays(P(a, 0), I(a, 1), I(a, 2), I(a, 3), 0, 1); return 0;
    case F.nvnCommandBufferDrawArraysInstanced: C.drawArrays(P(a, 0), I(a, 1), I(a, 2), I(a, 3), I(a, 4), I(a, 5)); return 0;
    case F.nvnCommandBufferDrawElements: C.drawElements(P(a, 0), I(a, 1), I(a, 2), I(a, 3), X(a, 4), 0, 0, 1); return 0;
    case F.nvnCommandBufferDrawElementsBaseVertex: C.drawElements(P(a, 0), I(a, 1), I(a, 2), I(a, 3), X(a, 4), I(a, 5), 0, 1); return 0;
    case F.nvnCommandBufferDrawElementsInstanced: C.drawElements(P(a, 0), I(a, 1), I(a, 2), I(a, 3), X(a, 4), I(a, 5), I(a, 6), I(a, 7)); return 0;
    // NVN2 mesh shading (lower.ts meshDraw): count task workgroups from first, or mesh workgroups in a program with no task shader; the indirect record {count, first} is the GPU's
    case F.nvnCommandBufferDrawMeshTasks: C.drawMeshTasks(P(a, 0), I(a, 1), I(a, 2), 0); return 0;
    case F.nvnCommandBufferDrawMeshTasksIndirect: C.drawMeshTasks(P(a, 0), 0, 0, X(a, 1)); return 0;
    case F.nvnCommandBufferDrawArraysIndirect: C.drawArraysIndirect(P(a, 0), I(a, 1), X(a, 2), 0, 0); return 0;
    case F.nvnCommandBufferDrawElementsIndirect: C.drawElementsIndirect(P(a, 0), I(a, 1), I(a, 2), X(a, 3), X(a, 4), 0, 0); return 0;
    // Multi-draws become `max` indirect draws that carry the count's address and their index (nxnative does the same up to 1024)
    case F.nvnCommandBufferMultiDrawArraysIndirectCount: {
      const max = I(a, 4); if (max > 1024) { L.redLine("MultiDrawArraysIndirectCount with more than 1024 draws: not recorded"); return 0; }
      for (let i = 0; i < max; i++) C.drawArraysIndirect(P(a, 0), I(a, 1), X(a, 2) + <u64>i * X(a, 5), X(a, 3), i);
      return 0;
    }
    case F.nvnCommandBufferMultiDrawElementsIndirectCount: {
      const max = I(a, 6); if (max > 1024) { L.redLine("MultiDrawElementsIndirectCount with more than 1024 draws: not recorded"); return 0; }
      for (let i = 0; i < max; i++) C.drawElementsIndirect(P(a, 0), I(a, 1), I(a, 2), X(a, 3), X(a, 4) + <u64>i * X(a, 7), X(a, 5), i);
      return 0;
    }
    case F.nvnCommandBufferBarrier: C.barrier(P(a, 0), I(a, 1)); return 0;
    case F.nvnCommandBufferSetTexturePool: C.setPool(P(a, 0), X(a, 1), true); return 0;
    case F.nvnCommandBufferSetSamplerPool: C.setPool(P(a, 0), X(a, 1), false); return 0;
    case F.nvnCommandBufferCopyBufferToTexture: C.copyBufferTexture(P(a, 0), X(a, 1), P(a, 2), P(a, 3), P(a, 4), I(a, 5), 0); return 0;
    case F.nvnCommandBufferCopyTextureToBuffer: C.copyBufferTexture(P(a, 0), X(a, 4), P(a, 1), P(a, 2), P(a, 3), I(a, 5), true); return 0;
    case F.nvnCommandBufferCopyTextureToTexture: C.copyTextureToTexture(P(a, 0), P(a, 1), P(a, 2), P(a, 3), P(a, 4), P(a, 5), P(a, 6), I(a, 7)); return 0;
    case F.nvnCommandBufferCopyBufferToBuffer: C.copyBufferToBuffer(P(a, 0), X(a, 1), X(a, 2), X(a, 3)); return 0;
    case F.nvnCommandBufferUpdateUniformBuffer: C.updateUniformBuffer(P(a, 0), X(a, 1), <i64>X(a, 3), X(a, 4), P(a, 5)); return 0;
    case F.nvnCommandBufferSetCopyRowStride: store<u64>(P(a, 0), X(a, 1), O.CMD_copy_row); return 0;
    case F.nvnCommandBufferSetCopyImageStride: store<u64>(P(a, 0), X(a, 1), O.CMD_copy_image); return 0;
    case F.nvnCommandBufferGetCopyRowStride: return load<u64>(P(a, 0), O.CMD_copy_row);
    case F.nvnCommandBufferGetCopyImageStride: return load<u64>(P(a, 0), O.CMD_copy_image);
    case F.nvnCommandBufferFenceSync: C.fenceSync(P(a, 0), X(a, 1)); return 0;
    // Sampler reduction (min / max of the covered texels) is kept for the getters; WebGPU samplers have no reduction mode, so draws filter as usual
    case F.nvnSamplerBuilderSetReductionFilter: store<u8>(P(a, 0), <u8>I(a, 1), O.SB_p + O.SP_reduction); return 0;
    case F.nvnSamplerBuilderGetReductionFilter: return load<u8>(P(a, 0), O.SB_p + O.SP_reduction);
    case F.nvnSamplerGetReductionFilter: return load<u8>(P(a, 0), O.SAMP_p + O.SP_reduction);
    case F.nvnTextureBuilderGetStorageClass: return 0;
    // Guest memory is the GPU's memory: the dirty scan and pool flushes find written texels; nothing to flush here (as nxnative)
    case F.nvnTextureFlushTexels: return 0;
    // Compute runs in submission order on the one host queue, with no overlap or priority (as nxnative)
    case F.nvnCommandBufferSetComputeOverlapMode: return 0;
    case F.nvnCommandBufferSetComputeWorkloadPriority: return 0;
    case F.nvnCommandBufferSetRecordingMode: return 0;   // the host records every command buffer alike (as nxnative)
    case F.nvnCommandBufferSignalEvent: C.signalEvent(P(a, 0), load<u64>(P(a, 1), O.EV_val), I(a, 2), <u32>I(a, 5)); return 0;
    case F.nvnCommandBufferWaitEvent: C.waitEvent(P(a, 0), load<u64>(P(a, 1), O.EV_val), I(a, 2), <u32>I(a, 3)); return 0;
    case F.nvnCommandBufferBindStorageBuffer: C.bindStorageBuffer(P(a, 0), I(a, 1), I(a, 2), X(a, 3), X(a, 4)); return 0;
    case F.nvnCommandBufferBindStorageBuffers: { const rg = P(a, 4); for (let i = 0, n = I(a, 3); i < n; i++) C.bindStorageBuffer(P(a, 0), I(a, 1), I(a, 2) + i, load<u64>(rg + (<usize>i << 4)), load<u64>(rg + (<usize>i << 4), 8)); return 0; }
    case F.nvnCommandBufferBindImage: store<u64>(RANGE, X(a, 3)); C.bindTextures(P(a, 0), I(a, 1), I(a, 2), 1, RANGE, O.OP_BIND_IMG); return 0;
    case F.nvnCommandBufferBindImages: C.bindTextures(P(a, 0), I(a, 1), I(a, 2), I(a, 3), P(a, 4), O.OP_BIND_IMG); return 0;
    case F.nvnCommandBufferDispatchCompute: C.dispatch(P(a, 0), I(a, 1), I(a, 2), I(a, 3), 0); return 0;
    case F.nvnCommandBufferDispatchComputeIndirect: C.dispatch(P(a, 0), 0, 0, 0, X(a, 1)); return 0;
    // As nxnative (hle_nvn.c): discard and restart are state of the walk; the point size comes from the shader, lines are one pixel wide, and conservative
    // raster has no host path (one red line when a game asks for what the host does not do)
    case F.nvnCommandBufferSetRasterizerDiscard: C.rasterizerDiscard(P(a, 0), B(a, 1)); return 0;
    case F.nvnCommandBufferSetPrimitiveRestart: C.primitiveRestart(P(a, 0), B(a, 1), I(a, 2)); return 0;
    case F.nvnCommandBufferClearBuffer: C.clearBuffer(P(a, 0), X(a, 1), X(a, 2), <u32>I(a, 3)); return 0;
    case F.nvnCommandBufferSetLineWidth: if (FL(a, 0) != 1 && !(condRed & 4)) { condRed |= 4; L.redLine("SetLineWidth other than 1: WebGPU has only 1-pixel lines"); } return 0;
    case F.nvnCommandBufferSetConservativeRasterEnable: if (B(a, 1) && !(condRed & 8)) { condRed |= 8; L.redLine("SetConservativeRasterEnable(on): WebGPU has no conservative rasterization, ignored"); } return 0;
    // The handles are read when the command is recorded (nxnative reads them again at execution; a game that changes them in between gets the earlier ones)
    case F.nvnCommandBufferBindTexturesDeferred:
      if (!(condRed & 16)) { condRed |= 16; L.redLine("BindTexturesDeferred: the handles are read at recording time, not at execution"); }
      C.bindTextures(P(a, 0), I(a, 1), I(a, 2), I(a, 3), P(a, 4)); return 0;
    // The zcull storage of a texture: 8 bytes a 32x32 tile, to 256 bytes (nxnative zcull_size)
    case F.nvnTextureBuilderGetZCullStorageSize: case F.nvnTextureGetZCullStorageSize: {
      const d = P(a, 0) + (fn == F.nvnTextureBuilderGetZCullStorageSize ? O.TB_d : O.TEX_d);
      const tiles = <u64>((load<u32>(d, O.TD_width) + 31) / 32) * <u64>((load<u32>(d, O.TD_height) + 31) / 32) * <u64>max<u32>(load<u32>(d, O.TD_depth), 1);
      return tiles ? (tiles * 8 + 0xff) & ~<u64>0xff : 0x100;
    }
    case F.nvnCommandBufferSetDepthClamp: C.depthClamp(P(a, 0), B(a, 1)); return 0;
    case F.nvnCommandBufferClearTexture: C.clearTexture(P(a, 0), P(a, 1), P(a, 2), P(a, 3), P(a, 4), I(a, 5), 0); return 0;
    case F.nvnCommandBufferClearTexturei: C.clearTexture(P(a, 0), P(a, 1), P(a, 2), P(a, 3), P(a, 4), I(a, 5), 2); return 0;
    case F.nvnCommandBufferClearTextureui: C.clearTexture(P(a, 0), P(a, 1), P(a, 2), P(a, 3), P(a, 4), I(a, 5), 1); return 0;
    case F.nvnCommandBufferPushGraphicsConstants: C.pushConstants(P(a, 0), false, X(a, 1), X(a, 2), X(a, 3), P(a, 4)); return 0;
    case F.nvnCommandBufferPushComputeConstants: C.pushConstants(P(a, 0), true, X(a, 1), X(a, 2), X(a, 3), P(a, 4)); return 0;
    case F.nvnCommandBufferDownsample: C.downsample(P(a, 0), P(a, 1), 0, P(a, 2), 0); return 0;
    case F.nvnCommandBufferDownsampleTextureView: C.downsample(P(a, 0), P(a, 1), P(a, 2), P(a, 3), P(a, 4)); return 0;
    // Counter reports, and render enable with the game profile's render_cond (report.ts). Without the key everything
    // draws, as nxnative: a game that only saves GPU time with its conditions is right either way
    case F.nvnCommandBufferReportCounter: C.reportCounter(P(a, 0), I(a, 1), X(a, 2)); return 0;
    case F.nvnCommandBufferResetCounter: C.resetCounter(P(a, 0), I(a, 1)); return 0;
    case F.nvnCommandBufferSetRenderEnable:
      if (profileHas(P_RENDER_COND)) C.renderCond(P(a, 0), B(a, 1) ? 2 : 3, 0);
      else if (!B(a, 1) && !(condRed & 1)) { condRed |= 1; L.redLine("SetRenderEnable(false): the host draws anyway (the game profile's render_cond is off)"); }
      return 0;
    case F.nvnCommandBufferSetRenderEnableConditional:
      if (profileHas(P_RENDER_COND)) C.renderCond(P(a, 0), I(a, 1) & 1, X(a, 2));
      else if (!(condRed & 2)) { condRed |= 2; L.redLine("SetRenderEnableConditional: the host draws anyway (the game profile's render_cond is off)"); }
      return 0;
    // A report's timestamp is in 614.4 MHz ticks on the guest clock; the embedder gives the clock (gfx_set_now) before the second call
    case F.nvnDeviceGetTimestampInNanoseconds: return nsFromTicks(load<u64>(P(a, 1), 8));
    case F.nvnDeviceGetCurrentTimestampInNanoseconds: return nowNs;
  }
  const st = status(fn);
  if (st == 2) return 0;                                   // empty by design (gen_names.mts NOPS)
  if (st < 0) { L.red("nvn_call with an id that is not an NVN function: "); L.i(fn); L.end(); return 0; }
  if (!load<u8>(UNIMPL_SEEN + <usize>fn)) { store<u8>(UNIMPL_SEEN + <usize>fn, 1); L.red(""); nameOf(fn); L.str(" unimplemented"); L.end(); }
  return 0;
}

let queueSerial: u64 = 0;
// What nvnBootstrapLoader and nvnDeviceGetProcAddress return for a name: the embedder turns an id into the guest
// address of its entry stub (env.gfx_proc_address); 0 for an unknown name
// @ts-ignore: decorator
@external("env", "gfx_proc_address")
declare function procAddress(id: i32): f64;
function lookupAddress(name: usize): u64 { const id = lookup(name); return id < 0 ? 0 : <u64>procAddress(id); }
