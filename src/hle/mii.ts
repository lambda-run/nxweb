// Mii service layer: port of nxnative dm/host/hle_mii.c. The host answers as a console with no Mii of its own: the
// six default Miis, an empty database, the editor cancelled. CharInfo is 0x58 bytes (packed), CharInfoElement adds a
// u32 source (1 = default). The MiiModel system data stand-in (dm_mii_standin) is offered to the file system as bytes
// (miiStandin) instead of being written to a host folder.
import { X, I, P, ls, ps, pu, le, zero, copy } from "./base";
import { entropy64 } from "./os";

const MII_RES_TEST_MODE: u64 = 0x1987E;
const SRC_DEFAULT: i32 = 2, DEFAULTS: i32 = 6, CHARINFO: usize = 0x58;
const NAME = "no name";
// index >= 0: default Mii <index> (a fixed create id); < 0: a random Mii (a fresh one)
export function miiDefault(c: usize, gender: i32, index: i32): void {
  zero(c, CHARINFO);
  const lo: u64 = index >= 0 ? 0x4d49494e44454641 + <u64>index : entropy64(), hi: u64 = index >= 0 ? 0x554c54444d484f53 : entropy64();
  store<u64>(c, lo); store<u64>(c, hi, 8);
  store<u8>(c, (load<u8>(c, 6) & 0x0f) | 0x40, 6); store<u8>(c, (load<u8>(c, 8) & 0x3f) | 0x80, 8);   // UUID version 4
  for (let i = 0; i < NAME.length; i++) store<u16>(c + 16 + (<usize>i << 1), <u16>NAME.charCodeAt(i));
  if (index >= 0) store<u8>(c, <u8>(index * 2), 39);            // favorite colour: red, yellow, green, sky blue, purple, white
  store<u8>(c, gender == 1 ? 1 : 0, 40); store<u8>(c, 64, 41); store<u8>(c, 64, 42);            // gender, height, build
  store<u8>(c, 33, 49); store<u8>(c, 1, 50);                                                    // hair type, colour
  store<u8>(c, 2, 52); store<u8>(c, 8, 53); store<u8>(c, 4, 54); store<u8>(c, 3, 55); store<u8>(c, 4, 56); store<u8>(c, 2, 57); store<u8>(c, 12, 58);   // eye
  store<u8>(c, 6, 59); store<u8>(c, 1, 60); store<u8>(c, 4, 61); store<u8>(c, 3, 62); store<u8>(c, 6, 63); store<u8>(c, 2, 64); store<u8>(c, 10, 65);   // eyebrow
  store<u8>(c, 1, 66); store<u8>(c, 4, 67); store<u8>(c, 9, 68);                                // nose
  store<u8>(c, 23, 69); store<u8>(c, 19, 70); store<u8>(c, 4, 71); store<u8>(c, 3, 72); store<u8>(c, 13, 73);   // mouth
  store<u8>(c, 8, 74); store<u8>(c, 4, 77); store<u8>(c, 10, 78);                               // beard colour, mustache scale, y
  store<u8>(c, 8, 80); store<u8>(c, 4, 81); store<u8>(c, 10, 82);                               // glasses colour, scale, y
  store<u8>(c, 4, 84); store<u8>(c, 2, 85); store<u8>(c, 20, 86);                               // mole scale, x, y
}
function miiGet(buf: usize, n: i32, src: i32, stride: usize): i32 {
  let k = 0;
  for (; (src & SRC_DEFAULT) && buf && k < n && k < DEFAULTS; k++) {
    const e = buf + <usize>k * stride;
    miiDefault(e, k >= 3 ? 1 : 0, k);
    if (stride > CHARINFO) store<u32>(e + CHARINFO, 1);
  }
  return k;
}
export function h_mii_Count(a: usize): u64 { return I(a, 1) & SRC_DEFAULT ? DEFAULTS : 0; }
export function h_mii_GetE(a: usize): u64 { store<i32>(P(a, 1), miiGet(P(a, 2), I(a, 3), I(a, 4), CHARINFO + 4)); return 0; }
export function h_mii_Get(a: usize): u64 { store<i32>(P(a, 1), miiGet(P(a, 2), I(a, 3), I(a, 4), CHARINFO)); return 0; }
// RandomDesc { age, gender, race }: the host's "random" Mii is the default one of that gender
export function h_mii_Random(a: usize): u64 { const desc = P(a, 2); miiDefault(P(a, 1), desc ? load<i32>(desc, 4) : 0, -1); return 0; }
export function h_mii_Default(a: usize): u64 { const index = I(a, 2); miiDefault(P(a, 1), index >= 3 ? 1 : 0, index < 0 || index >= DEFAULTS ? 0 : index); return 0; }
export function h_mii_Import(a: usize): u64 {
  ls(); ps("[RED] mii: Database::Import of "); pu(X(a, 2)); ps(" bytes refused (the host has no test mode)"); le();
  return MII_RES_TEST_MODE;
}

// ---------- the MiiModel system data stand-in (0100000000000802): files of the firmware's layout in which every part is absent ----------
export const MII_TEX_SIZE: usize = 0x64 + 0x1c * 327;                       // 0x2428
const MII_MESH_AT: usize = 0x14de0, MII_MESH: u32 = 0x20;
// zlib: one stored block of 32 zeros and its Adler-32
const MESH_Z: usize = memory.data<u8>([0x78, 0x01, 0x01, 0x20, 0, 0xDF, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x20, 0x00, 0x01]);
const MESH_Z_LEN: usize = 43;
export const MII_SHAPE_SIZE: usize = 0x14de0 + 43;
// kind 0: a texture file (NXTexture{Low,Mid}{Linear,SRGB}.dat), 1: a shape file (Shape{Mid,High}.dat). Writes the
// file at out when cap is enough; returns its size
export function miiStandin(kind: i32, out: usize, cap: usize): usize {
  const size = kind ? MII_SHAPE_SIZE : MII_TEX_SIZE, parts: usize = kind ? 12 : 11;
  if (!out || cap < size) return size;
  zero(out, size);
  for (let i: usize = 0; i < parts; i++) { store<u32>(out + 0xc + 4 * i, 0x1000); store<u32>(out + 0xc + 4 * parts + 4 * i, 0x1000); }
  if (kind) {
    for (let i: usize = 0; i < 857; i++) {
      const e = out + 0x6c + 0x58 * i;
      store<u32>(e, <u32>MII_MESH_AT); store<u32>(e, MII_MESH, 4); store<u32>(e, <u32>MESH_Z_LEN, 8);   // data offset, inflated size, stored size
      store<u32>(e, 8, 36);                                                                           // attribute 0 is one 8-byte vertex
      store<u32>(e, 0x10, 56); store<u32>(e, 6, 60);                                                  // index offset and size
    }
    copy(out + MII_MESH_AT, MESH_Z, MESH_Z_LEN);
  }
  return size;
}
