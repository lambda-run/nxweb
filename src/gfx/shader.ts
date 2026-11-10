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

// Reflection record (144 bytes), as the embedder passes it (GfxHost.registerShader fills it from the shader chain's record)
export const RF_stage: usize = 0;       // u32: 0 vertex, 1 fragment, 2 compute
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
export const RF_SIZE: usize = 144;
const LIB_N: u32 = 4096;
const LE_SIZE: usize = 152;              // u64 key, reflection record
let LIB: usize = 0;
export function shaderInit(): void { LIB = arenaAlloc(<usize>LIB_N * LE_SIZE); }
let libCount: u32 = 0;
let libVersion: u32 = 1;

const CTL: usize = memory.data(0x880);

export function libRegister(key: u64, refl: usize): i32 {
  for (let i: u32 = 0; i < libCount; i++) if (load<u64>(LIB + <usize>i * LE_SIZE) == key) { memory.copy(LIB + <usize>i * LE_SIZE + 8, refl, RF_SIZE); libVersion++; return <i32>i; }
  if (libCount == LIB_N) { L.redLine("shader library full (4096 shaders)"); return -1; }
  const e = LIB + <usize>libCount * LE_SIZE;
  store<u64>(e, key); memory.copy(e + 8, refl, RF_SIZE);
  libVersion++;
  libCount++;
  return <i32>(libCount - 1);
}
export function libRefl(id: i32): usize { return LIB + <usize>id * LE_SIZE + 8; }
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

// Keys already reported missing (one red line a key)
const MISSING: usize = memory.data(512);
let nMissing: u32 = 0;
function reportMissing(key: u64): void {
  for (let i: u32 = 0; i < min<u32>(nMissing, 64); i++) if (load<u64>(MISSING + (<usize>i << 3)) == key) return;
  store<u64>(MISSING + (<usize>(nMissing & 63) << 3), key); nMissing++;
  L.red("shader ");
  for (let b = 0; b < 8; b++) L.hex((key >> (<u64>b * 8)) & 0xff, 2);
  L.str(" is not in the shader map");
  L.end();
}

// The library id of the stage with shader stage number `want` (0 vertex, 1 fragment, 2 compute) of the program object at `prog`,
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
    if (id < 0) { reportMissing(load<u64>(e + PE_key + (<usize>i << 3))); found = -2; continue; }
    if (load<u32>(libRefl(id), RF_stage) == want && found == -1) found = id;
  }
  store<u32>(e, libVersion, PE_shader + 12);
  return found < 0 ? -1 : found;
}
