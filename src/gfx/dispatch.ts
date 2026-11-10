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
import { windowInitialize, windowAcquire, windowPresent, windowGetCrop } from "./window";
import { submit, emitFence, passBreak, blendDefault, dsDefault } from "./lower";
import { hostRec, hostFlush, H_TEX_CREATE, H_TEX_DESTROY, H_FLUSH } from "./hostops";

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

// Bit-field helpers for the state objects (obj.ts)
function bits32(p: usize, shift: u32, width: u32, v: u32): void { const m = ((<u32>1 << width) - 1) << shift; store<u32>(p, (load<u32>(p) & ~m) | ((v << shift) & m)); }
function bits64(p: usize, shift: u64, width: u64, v: u64): void { const m = ((<u64>1 << width) - 1) << shift; store<u64>(p, (load<u64>(p) & ~m) | ((v << shift) & m)); }

function texRelease(t: usize): void {
  const serial = load<u64>(t, O.TEX_serial);
  if (!T.texEntry(serial)) return;
  T.texFree(serial);
  store<u64>(hostRec(H_TEX_DESTROY, 16), serial, 8);
}
function textureInitialize(t: usize, b: usize): u64 {
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
  const serial = T.texNew();
  store<u64>(t, serial, O.TEX_serial);
  if (serial) { const r = hostRec(H_TEX_CREATE, 56); store<u64>(r, serial, 8); memory.copy(r + 16, t + O.TEX_d, O.TD_SIZE); }
  return 1;
}
function viewOffset(d: usize, layerSize: u64, v: usize): u64 {
  if (!v) return 0;
  const bits = load<u8>(v);
  let off: u64 = bits & 1 ? texLevelOffset(d, load<u8>(v, O.VIEW_base_level)) : 0;
  if (bits & 2) off += <u64>load<u16>(v, O.VIEW_min_layer) * layerSize;
  return off;
}

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
      // DEPARTS: a virtual pool (flags 0x200) gets no address range of its own yet (nxnative reserves one; sparse mapping is not ported)
      if (!load<u64>(p, O.POOL_mem)) { if (flags & O.POOLF_VIRTUAL) L.redLine("MemoryPoolInitialize: virtual pools are not mapped yet (no storage)"); else L.redLine("MemoryPoolInitialize: non-virtual pool has no storage"); }
      return 1;
    }
    case F.nvnMemoryPoolFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnMemoryPoolSetDebugLabel: return 0;
    case F.nvnMemoryPoolMap: { const p = P(a, 0); return load<u32>(p, O.POOL_flags) & O.POOLF_CPU_NO_ACCESS ? 0 : load<u64>(p, O.POOL_mem); }
    case F.nvnMemoryPoolFlushMappedRange: return 0;        // guest memory is the GPU's memory here: the replayer reads it at submit
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
      memory.fill(buf, 0, O.BUF_SIZE);
      store<u32>(buf, O.MAGIC_BUF); store<u64>(buf, pool, O.BUF_pool); store<u64>(buf, load<u64>(b, O.BB_off), O.BUF_off); store<u64>(buf, load<u64>(b, O.BB_size), O.BUF_size);
      return 1;
    }
    case F.nvnBufferFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnBufferSetDebugLabel: return 0;
    case F.nvnBufferMap: { const b = P(a, 0), pool = <usize>load<u64>(b, O.BUF_pool); return load<u32>(pool, O.POOL_flags) & O.POOLF_CPU_NO_ACCESS ? 0 : load<u64>(pool, O.POOL_mem) + load<u64>(b, O.BUF_off); }
    case F.nvnBufferGetAddress: { const b = P(a, 0); return load<u64>(<usize>load<u64>(b, O.BUF_pool), O.POOL_mem) + load<u64>(b, O.BUF_off); }
    case F.nvnBufferFlushMappedRange: case F.nvnBufferInvalidateMappedRange: return 0;
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
    case F.nvnTextureFinalize: texRelease(P(a, 0)); store<u32>(P(a, 0), 0); return 0;
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
    case F.nvnTextureViewSetDefaults: memory.fill(P(a, 0), 0, O.VIEW_SIZE); return 0;
    case F.nvnTextureViewSetLevels: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 1); store<u8>(v, <u8>I(a, 1), O.VIEW_base_level); store<u8>(v, <u8>I(a, 2), O.VIEW_nlevels); return 0; }
    case F.nvnTextureViewSetLayers: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 2); store<u16>(v, <u16>I(a, 1), O.VIEW_min_layer); store<u16>(v, <u16>I(a, 2), O.VIEW_nlayers); return 0; }
    case F.nvnTextureViewSetFormat: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 4); store<u16>(v, <u16>I(a, 1), O.VIEW_format); return 0; }
    case F.nvnTextureViewSetTarget: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 8); store<u8>(v, <u8>I(a, 1), O.VIEW_target); return 0; }
    case F.nvnTextureViewSetSwizzle: { const v = P(a, 0); store<u8>(v, load<u8>(v) | 16); for (let i: usize = 0; i < 4; i++) store<u8>(v + O.VIEW_swz + i, <u8>I(a, 1 + i)); return 0; }
    case F.nvnTextureViewSetDepthStencilMode: { const v = P(a, 0); store<u8>(v, (load<u8>(v) & 0x3f) | 32 | (<u8>(I(a, 1) & 3) << 6)); return 0; }
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
    case F.nvnSamplerSetDebugLabel: return 0;

    // ---------- Programs ----------
    case F.nvnProgramInitialize: memory.fill(P(a, 0), 0, O.PROG_SIZE); store<u32>(P(a, 0), O.MAGIC_PROG); return 1;
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

    // ---------- Sync, queue ----------
    case F.nvnSyncInitialize: syncInitialize(P(a, 0)); return 1;
    case F.nvnSyncFinalize: syncFinalize(P(a, 0)); return 0;
    case F.nvnSyncSetDebugLabel: return 0;
    case F.nvnSyncWait: return syncWait(P(a, 0));
    case F.nvnQueueBuilderSetDefaults: {
      const b = P(a, 0), d = load<u64>(b);
      memory.fill(b, 0, O.QB_SIZE); store<u64>(b, d);
      store<u64>(b, 65536, O.QB_cmd_sz); store<u64>(b, 262144, O.QB_comp_sz); store<u64>(b, 16384, O.QB_ctl_sz); store<u64>(b, 4096, O.QB_flush);
      return 0;
    }
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
    case F.nvnQueueSubmitCommands: { const q = P(a, 0); store<u64>(q, load<u64>(q, O.QUEUE_submits) + 1, O.QUEUE_submits); submit(I(a, 1), P(a, 2)); return 0; }
    case F.nvnQueueFlush: hostFlush(); return 0;           // everything submitted so far is with the replayer
    // DEPARTS: nxnative's Finish blocks until the GPU is done. A browser turn cannot block: the work is flushed, and the
    // kernel waits on the fence word when it must
    case F.nvnQueueFinish: hostRec(H_FLUSH, 8); hostFlush(); return 0;
    case F.nvnQueueFenceSync: passBreak(); emitFence(P(a, 1)); hostFlush(); return 0;
    case F.nvnQueuePresentTexture: windowPresent(P(a, 1), I(a, 2)); return 0;
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
    case F.nvnWindowBuilderGetPresentInterval: return <u64><u32>load<i32>(P(a, 0), O.WB_interval);
    case F.nvnWindowBuilderGetNativeWindow: return load<u64>(P(a, 0), O.WB_native);
    case F.nvnWindowInitialize: return windowInitialize(P(a, 0), P(a, 1));
    case F.nvnWindowFinalize: store<u32>(P(a, 0), 0); return 0;
    case F.nvnWindowSetDebugLabel: return 0;
    case F.nvnWindowAcquireTexture: return windowAcquire(P(a, 0), P(a, 1), P(a, 2));
    case F.nvnWindowGetNativeWindow: return load<u64>(P(a, 0), O.WIN_native);
    case F.nvnWindowGetPresentInterval: return <u64><u32>load<i32>(P(a, 0), O.WIN_interval);
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
    case F.nvnCommandBufferBarrier: C.barrier(P(a, 0), I(a, 1)); return 0;
    case F.nvnCommandBufferSetTexturePool: C.setPool(P(a, 0), X(a, 1), true); return 0;
    case F.nvnCommandBufferSetSamplerPool: C.setPool(P(a, 0), X(a, 1), false); return 0;
    case F.nvnCommandBufferCopyBufferToTexture: C.copyBufferTexture(P(a, 0), X(a, 1), P(a, 2), P(a, 3), P(a, 4), I(a, 5), false); return 0;
    case F.nvnCommandBufferCopyTextureToBuffer: C.copyBufferTexture(P(a, 0), X(a, 4), P(a, 1), P(a, 2), P(a, 3), I(a, 5), true); return 0;
    case F.nvnCommandBufferCopyTextureToTexture: C.copyTextureToTexture(P(a, 0), P(a, 1), P(a, 2), P(a, 3), P(a, 4), P(a, 5), P(a, 6), I(a, 7)); return 0;
    case F.nvnCommandBufferCopyBufferToBuffer: C.copyBufferToBuffer(P(a, 0), X(a, 1), X(a, 2), X(a, 3)); return 0;
    case F.nvnCommandBufferUpdateUniformBuffer: C.updateUniformBuffer(P(a, 0), X(a, 1), <i64>X(a, 3), X(a, 4), P(a, 5)); return 0;
    case F.nvnCommandBufferSetCopyRowStride: store<u64>(P(a, 0), X(a, 1), O.CMD_copy_row); return 0;
    case F.nvnCommandBufferSetCopyImageStride: store<u64>(P(a, 0), X(a, 1), O.CMD_copy_image); return 0;
    case F.nvnCommandBufferGetCopyRowStride: return load<u64>(P(a, 0), O.CMD_copy_row);
    case F.nvnCommandBufferGetCopyImageStride: return load<u64>(P(a, 0), O.CMD_copy_image);
    case F.nvnCommandBufferFenceSync: C.fenceSync(P(a, 0), X(a, 1)); return 0;
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
