// Shader keys and the shader library.
// Games ship precompiled GPU binaries. As in nxnative (hle_nvn.c keys_hash), a stage is named by the first 8 bytes of
// sha256(control section + code area), computed at nvnProgramSetShaders: the control section's first 0x880 bytes (its
// own length at +0x20 when that is 0x760..0x87f), then the code area, whose length is the u32 at control + 0x704.
// An NVN2 control section (magic 0x98761234, version 0xc9) contributes its first 0x48 bytes with +0x30..0x33 zeroed
// and has its code length at +0x44.
// The library maps a key to a translated shader. The WGSL text stays with the replayer; here is its reflection record,
// which the lowering needs to know what a draw uses. Entries are registered by the embedder (gfx_shader_register).
// DEPARTS from nxnative: the key is always computed at SetShaders (nxnative waits when the code area is not yet in a
// memory pool and keeps a copy of the control section for later).
import * as L from "./log";
import { shaInit, shaUpdate, shaFinal, DIGEST } from "./sha256";
import { PROG_nstage, PROG_sd, PROG_serial } from "./obj";
import { progEntry, PE_ok, PE_key, PE_shader } from "./tables";
import { arenaAlloc } from "./arena";
import { Inst } from "../kit/machine";
import { GFX_SHADER, GfxShaderE, GfxShaderS } from "../kit/gen/tables";
import { pipelineResetShader } from "./pipeline";

// Reflection record (424 bytes), as the embedder passes it (GfxHost.registerShader fills it from the shader chain's record)
export const RF_stage: usize = 0;       // u32: 0 vertex, 1 fragment, 2 compute, 3 task, 4 mesh (NVN2: compute after the translator, src/shaders/meshstage.ts)
export const RF_ubo: usize = 4;         // u32: bit i = uniform buffer binding i of this stage is read (0..13 the game's slots, 14 the translator's support buffer)
export const RF_tex: usize = 8;         // u32: bit s = texture slot s of this stage is sampled
export const RF_io: usize = 12;         // u32: vertex: attribute locations read; fragment: colour outputs written
export const RF_depth: usize = 16;      // u32: bit s = slot s is a depth (comparison) texture
export const RF_ssbo: usize = 20;       // u32: bit i = storage buffer i of this stage is used
export const RF_ssbo_w: usize = 24;     // u32: bit i = and written
export const RF_img: usize = 28;        // u32: bits 0..7 image slot i is used, bits 8..15 and written
export const RF_dim: usize = 32;        // u8[32] per texture slot: 0 2D, 1 2D array, 2 cube, 3 3D, 4 cube array, 5 multisampled 2D
export const RF_ubo_size: usize = 64;   // u32[16]: bytes the WGSL type of uniform binding i covers (0: not known, the bound size is used)
export const RF_vin: usize = 128;       // u64, vertex: 2 bits a location: the class the input is declared with (0 float, 1 sint, 2 uint)
export const RF_flags: usize = 136;     // u32: 1 = RF_vin is known (a shader without it is taken to match whatever is bound)
// Bindless textures (nxnative NVN_RB_TEXU / SAMPU, dmsh_abi.h tex_ubo / samp_ubo): the shader samples slot s, but which
// texture and sampler that is stands in the game's own uniform data, read at each draw (lower.ts slotHandle)
export const RF_bl: usize = 140;        // u32: bit s = texture slot s is bindless: its entry in RF_blh says where the handle is
export const RF_blh: usize = 144;       // [32] { u8 kind; u8 reg; u16 off; u8 sreg; u8 pad; u16 soff }, one a texture slot:
                                        //   the handle is the u32 at byte `off` of this stage's uniform slot `reg` (texture ID in the low 20 bits, sampler ID in the high 12);
                                        //   kind BL_WORD: that word alone; BL_OR: ORed with the u32 at byte `soff` of uniform slot `sreg` (the texture in one word, the
                                        //   sampler in the other, either order); BL_SAMPLER_ID: the sampler is ID `soff`, a constant of the shader (no pool base)
export const BL_WORD: u8 = 0, BL_OR: u8 = 1, BL_SAMPLER_ID: u8 = 3;
// kind BL_POOL (src/shaders/pool.ts, lower.ts poolHandle): a slot of a pool texture. `reg` is a storage buffer slot of the stage, and the slot takes the
// (sreg & 15)-th distinct live handle among the u32 at byte off + soff * i of the range bound there (soff 0: that one word); the handle it took (0xffffffff: none)
// is word sreg >> 4 of the table the recorder writes into driver segment c2 at C2_POOL, where the shader looks its handle up
export const BL_POOL: u8 = 4;
// kind BL_POOL_AT, in the low 3 bits of the kind byte: as BL_POOL, but only record i of the table is read, and `pad` has bit k set when the word 4 (k + 1) bytes
// after `off` in the record holds a handle too (BL_POOL has it as well). i is uniform data, said by a helper entry { u8 flags; u8 ubo0 | ubo1 << 4; u16 off0; u16 off1 }
// at RF_blh index (kind >> 3), a texture slot the shader does not use: i = word(ubo0, off0) [& 0xfffff: flags 1] + (flags 8: word(ubo1, off1) [& 0xfffff: flags 2]);
// flags 4: i = 0 unless the first word's top two bits are 0b10
export const BL_POOL_AT: u8 = 5;
export const C2_POOL: usize = 0x980;
// Memory read through addresses the shader loads (src/shaders/spv.ts globalMemory; lower.ts emitGmem)
export const RF_gmem: usize = 400;      // u32: bits 0..7 how many addresses (0: none), bits 8..15 how many ranges the module declares for them (storage slots 32 + j)
export const RF_gmem_ptr: usize = 404;  // [8] { u8 slot; u8 word }: the 64-bit address is at 32-bit word `word` of the range bound at storage slot `slot` (16 + r: uniform slot r)
export const RF_SIZE: usize = 424;
const LIB_N: u32 = 4096;
const LE_SIZE: usize = 432;              // u64 key, reflection record
let LIB: usize = 0;
// What is known about a key (machine gfx_shader), for keys the embedder has spoken of: { u64 key, Inst }
const KEYS_N: u32 = 4096 + 256, KE_SIZE: usize = 24;
let KEYS: usize = 0, nKeys: u32 = 0, keysFullRed = false;
export function shaderInit(): void { LIB = arenaAlloc(<usize>LIB_N * LE_SIZE); KEYS = arenaAlloc(<usize>KEYS_N * KE_SIZE); }
function keyInst(key: u64, make: bool): usize {
  for (let i: u32 = 0; i < nKeys; i++) if (load<u64>(KEYS + <usize>i * KE_SIZE) == key) return KEYS + <usize>i * KE_SIZE + 8;
  if (!make) return 0;
  if (nKeys == KEYS_N) { if (!keysFullRed) { keysFullRed = true; L.redLine("shader key table full: further keys are neither pending nor failed"); } return 0; }
  const e = KEYS + <usize>nKeys * KE_SIZE;
  store<u64>(e, key); Inst.at(e + 8).init(GFX_SHADER, nKeys); nKeys++;
  return e + 8;
}
// The embedder says what it does about a key: 1 it is on its way (fetched, translated), 2 it could not be had (the
// embedder reports that itself), 0 nothing any more. False when the key's state does not allow it (it is registered)
export function shaderPending(key: u64, what: i32): bool {
  const p = keyInst(key, what != 0);
  if (!p) return what == 0;
  const m = Inst.at(p), ev: u8 = what == 1 ? GfxShaderE.Await : what == 2 ? GfxShaderE.Fail : GfxShaderE.Forget;
  if (!m.can(ev)) return false;
  return m.step(ev);
}
// 0 Unknown, 1 Pending, 2 Failed, 3 Ready
export function shaderKeyState(key: u64): i32 { const p = keyInst(key, false); return p ? <i32>Inst.at(p).state : 0; }
let libCount: u32 = 0;
let libVersion: u32 = 1;

const CTL: usize = memory.data(0x880);

export function libRegister(key: u64, refl: usize): i32 {
  for (let i: u32 = 0; i < libCount; i++) if (load<u64>(LIB + <usize>i * LE_SIZE) == key) {
    // registered again (another translation, a variant): every pipeline built from the old record is requested again
    memory.copy(LIB + <usize>i * LE_SIZE + 8, refl, RF_SIZE); libVersion++;
    const k = keyInst(key, true); if (k) Inst.at(k).step(GfxShaderE.Register);
    pipelineResetShader(i);
    return <i32>i;
  }
  if (libCount == LIB_N) { L.redLine("shader library full (4096 shaders)"); return -1; }
  const e = LIB + <usize>libCount * LE_SIZE;
  store<u64>(e, key); memory.copy(e + 8, refl, RF_SIZE);
  libVersion++;
  libCount++;
  const k = keyInst(key, true); if (k) Inst.at(k).step(GfxShaderE.Register);
  return <i32>(libCount - 1);
}
export function libRefl(id: i32): usize { return LIB + <usize>id * LE_SIZE + 8; }
export function libKey(id: i32): u64 { return load<u64>(LIB + <usize>id * LE_SIZE); }
function libFind(key: u64): i32 {
  for (let i: u32 = 0; i < libCount; i++) if (load<u64>(LIB + <usize>i * LE_SIZE) == key) return <i32>i;
  return -1;
}

function nvn2(c: usize): bool { return load<u32>(c) == 0x98761234 && load<u32>(c, 4) == 0xc9; }
// The key of one NVNshaderData { u64 data; u64 control }: false when it has no control section
export function shaderKey(sd: usize, out: usize): bool {
  const data = <usize>load<u64>(sd), c = <usize>load<u64>(sd, 8);
  if (!c) return false;
  let nctl: u32, ncode: u32;
  shaInit();
  if (nvn2(c)) {
    ncode = load<u32>(c, 0x44); nctl = 0x48;
    memory.copy(CTL, c, nctl); store<u32>(CTL, 0, 0x30);
    shaUpdate(CTL, nctl);
  } else {
    ncode = load<u32>(c, 0x704);
    const own = load<u32>(c, 0x20);
    nctl = own >= 0x760 && own < 0x880 ? own : 0x880;
    shaUpdate(c, nctl);
  }
  if (data && ncode && ncode < (1 << 24)) shaUpdate(data, ncode);
  shaFinal();
  store<u64>(out, load<u64>(DIGEST));
  return true;
}

// nvnProgramSetShaders: the keys of the program's stages into its table entry
export function progSetKeys(entry: usize, n: i32, sd: usize): void {
  let ok: u32 = 0;
  for (let i = 0; i < n; i++) if (shaderKey(sd + (<usize>i << 4), entry + PE_key + (<usize>i << 3))) ok |= 1 << i;
  store<u8>(entry, <u8>ok, PE_ok);
  memory.fill(entry + PE_shader, 0, 16);
}

// Keys a draw or dispatch was skipped for while the embedder has them on their way (pending), since the embedder last
// asked (gfx_shader_waited): it can hand those to its translator first
const WAITED: usize = memory.data(256);
let nWaited: u32 = 0;
function waited(key: u64): void {
  if (shaderKeyState(key) != GfxShaderS.Pending) return;
  for (let i: u32 = 0; i < nWaited; i++) if (load<u64>(WAITED + (<usize>i << 3)) == key) return;
  if (nWaited < 32) { store<u64>(WAITED + (<usize>nWaited << 3), key); nWaited++; }
}
// Copies the waited-on keys to `out` (8 bytes each, at most 32) and forgets them; their number
export function shaderWaited(out: usize): u32 { const n = nWaited; memory.copy(out, WAITED, <usize>n << 3); nWaited = 0; return n; }

// Keys already reported missing (one red line a key)
const MISSING: usize = memory.data(512);
let nMissing: u32 = 0;
function reportMissing(key: u64): void {
  // a key the embedder is fetching, or has reported as failed itself, is not reported again here
  const st = shaderKeyState(key);
  if (st == GfxShaderS.Pending || st == GfxShaderS.Failed) return;
  for (let i: u32 = 0; i < min<u32>(nMissing, 64); i++) if (load<u64>(MISSING + (<usize>i << 3)) == key) return;
  store<u64>(MISSING + (<usize>(nMissing & 63) << 3), key); nMissing++;
  L.red("shader ");
  for (let b = 0; b < 8; b++) L.hex((key >> (<u64>b * 8)) & 0xff, 2);
  L.str(" is not in the shader map");
  L.end();
}

// The key of a program's first stage that is not in the library, 0 when all are (a dispatch the recorder cannot run)
export function progMissingKey(prog: usize): u64 {
  const e = progEntry(load<u64>(prog, PROG_serial));
  if (!e) return 0;
  const n = min<u32>(load<u32>(prog, PROG_nstage), 6), ok = <u32>load<u8>(e, PE_ok);
  for (let i: u32 = 0; i < n; i++) {
    if (!((ok >> i) & 1)) continue;
    const k = load<u64>(e + PE_key + (<usize>i << 3));
    if (libFind(k) < 0) return k;
  }
  return 0;
}
// The keys of up to 3 of a program's stages that are not in the library into out (u64 each) and their states into
// states (u8 each: 0 unknown, 1 pending, 2 failed); how many there are (a skipped draw's H_SKIP record)
export function progMissingKeys(prog: usize, out: usize, states: usize): u32 {
  const e = progEntry(load<u64>(prog, PROG_serial));
  if (!e) return 0;
  const n = min<u32>(load<u32>(prog, PROG_nstage), 6), ok = <u32>load<u8>(e, PE_ok);
  let got: u32 = 0;
  for (let i: u32 = 0; i < n && got < 3; i++) {
    if (!((ok >> i) & 1)) continue;
    const k = load<u64>(e + PE_key + (<usize>i << 3));
    if (libFind(k) >= 0) continue;
    const st = shaderKeyState(k);
    store<u64>(out + (<usize>got << 3), k); store<u8>(states + <usize>got, <u8>(st == GfxShaderS.Pending ? 1 : st == GfxShaderS.Failed ? 2 : 0)); got++;
  }
  return got;
}
// Keys whose dispatches the embedder is told of when they cannot run (gfx_watch_key; GfxHost's NDVE stand-in)
const WATCH_N: u32 = 16, WATCH: usize = memory.data(16 * 8);
let nWatch: u32 = 0;
export function watched(key: u64): bool {
  for (let i: u32 = 0; i < nWatch; i++) if (load<u64>(WATCH + (<usize>i << 3)) == key) return true;
  return false;
}
export function watchKey(key: u64): bool {
  if (!key || watched(key)) return key != 0;
  if (nWatch == WATCH_N) return false;
  store<u64>(WATCH + (<usize>nWatch << 3), key); nWatch++;
  return true;
}

// The library id of the stage with shader stage number `want` (0 vertex, 1 fragment, 2 compute, 3 task, 4 mesh) of the program object at `prog`,
// -1 when the program has no such stage or its shader is not in the library (reported red once a key).
// A program's stages are in the order the game passed them: the stage of each is the library's to say, so every stage
// whose key is known is tried.
export function progShader(prog: usize, want: u32): i32 {
  const e = progEntry(load<u64>(prog, PROG_serial));
  if (!e) return -1;
  const n = min<u32>(load<u32>(prog, PROG_nstage), 6), ok = <u32>load<u8>(e, PE_ok);
  let found: i32 = -1;
  for (let i: u32 = 0; i < n; i++) {
    if (!((ok >> i) & 1)) continue;
    const slot = e + PE_shader + (<usize>i << 1);
    let id = <i32>load<i16>(slot) - 1;
    if (id < 0 || load<u32>(e, PE_shader + 12) != libVersion) {
      id = libFind(load<u64>(e + PE_key + (<usize>i << 3)));
      store<i16>(slot, <i16>(id + 1));
    }
    if (id < 0) { const k = load<u64>(e + PE_key + (<usize>i << 3)); waited(k); reportMissing(k); found = -2; continue; }
    if (load<u32>(libRefl(id), RF_stage) == want && found == -1) found = id;
  }
  store<u32>(e, libVersion, PE_shader + 12);
  return found < 0 ? -1 : found;
}
