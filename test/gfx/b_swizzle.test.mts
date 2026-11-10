// The deswizzler against block-linear storage produced by an independent Python implementation (test/gfx/swizzle_ref.py),
// and the CPU paths over texture storage: WriteTexels, ReadTexels.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, guest, ROOT, OUT } from "./harness.mts";
import { Game, FMT } from "./nvn.mts";

export interface SwizzleCase { name: string; desc: number[]; size: number; layerSize: number; storage: string; levels: { level: number; layer: number; rowBytes: number; rows: number; slices: number; tileH: number; tileD: number; linear: string }[] }
export function fixtures(): SwizzleCase[] {
  execFileSync("python3", [join(ROOT, "test/gfx/swizzle_ref.py"), join(OUT, "swizzle.json")], { stdio: "ignore" });
  return JSON.parse(readFileSync(join(OUT, "swizzle.json"), "utf8"));
}

test("deswizzle: 18 textures laid out by the Python reference (2D, mips, arrays, cubes, 3D, BC, packaged layouts) come out as its linear rows; swizzling them back gives its storage", async () => {
  const g = await guest(), cases = fixtures(), d = g.alloc(40), o = g.alloc(40);
  let levels = 0, bytes = 0;
  for (const c of cases) {
    const storage = Buffer.from(c.storage, "base64"), s = g.alloc(c.size, 512), back = g.alloc(c.size, 512);
    c.desc.forEach((v, k) => g.dv.setInt32(d + k * 4, v, true));
    g.x.gfx_tex_layout(d, o);
    assert.equal(Number(g.dv.getBigUint64(o, true)), c.size, `${c.name}: storage size`); assert.equal(Number(g.dv.getBigUint64(o + 8, true)), c.layerSize, `${c.name}: layer size`);
    g.u8.set(storage, s); g.u8.fill(0, back, back + c.size);
    for (const l of c.levels) {
      const want = Buffer.from(l.linear, "base64"), pitch = l.rowBytes + 12, lin = g.alloc(pitch * l.rows * l.slices + 16);
      g.u8.fill(0xA5, lin, lin + pitch * l.rows * l.slices);
      assert.equal(g.x.gfx_deswizzle(d, l.level, l.layer, s, lin, pitch, 1), 0, `${c.name} level ${l.level} layer ${l.layer}`);
      for (let r = 0; r < l.rows * l.slices; r++) {
        assert.ok(Buffer.from(g.u8.subarray(lin + r * pitch, lin + r * pitch + l.rowBytes)).equals(want.subarray(r * l.rowBytes, (r + 1) * l.rowBytes)), `${c.name} level ${l.level} layer ${l.layer} row ${r}`);
        assert.ok(g.u8.subarray(lin + r * pitch + l.rowBytes, lin + (r + 1) * pitch).every(v => v === 0xA5), "nothing written past the row");
      }
      assert.equal(g.x.gfx_deswizzle(d, l.level, l.layer, back, lin, pitch, 0), 0);
      levels++; bytes += want.length;
    }
    assert.ok(Buffer.from(g.u8.subarray(back, back + c.size)).equals(storage), `${c.name}: swizzled back`);
    assert.equal(g.x.gfx_deswizzle(d, c.desc[7], 0, s, back, 1 << 20, 1), -1, "a level the texture does not have");
    g.top = d + 80;      // reuse the fake guest's memory
  }
  console.log(`     ${cases.length} textures, ${levels} levels and layers, ${bytes} bytes compared`);
});

test("WriteTexels and ReadTexels go through the texture's block-linear storage: regions, levels, layers, strides, a BC region", async () => {
  const g = await guest(), G = new Game(g).init(), cases = fixtures();
  const put = (c: SwizzleCase) => {
    const t = G.texture({ w: c.desc[4], h: c.desc[5], format: c.desc[1], levels: c.desc[7], target: c.desc[0], depth: c.desc[6] });
    g.u8.set(Buffer.from(c.storage, "base64"), G.c("TextureGetTextureAddress", [t]));
    return t;
  };
  // read a region of level 1 of the 100x60 texture, with a row stride
  const c = cases.find(x => x.name.startsWith("RGBA8 100x60"))!, t = put(c), l1 = c.levels[1], lin = Buffer.from(l1.linear, "base64");
  const dst = g.alloc(4096), region = g.u32([7, 5, 0, 20, 9, 1]);
  G.c("TextureReadTexelsStrided", [t, G.view({ level: 1 }), region, dst, 96, 0]);
  for (let y = 0; y < 9; y++) assert.ok(Buffer.from(g.u8.subarray(dst + y * 96, dst + y * 96 + 80)).equals(lin.subarray((5 + y) * l1.rowBytes + 28, (5 + y) * l1.rowBytes + 108)), `row ${y}`);
  // write a region, read the whole level back: the region changed, nothing else did
  const src = g.bytes(Uint8Array.from({ length: 13 * 6 * 4 }, (_, i) => (i * 5 + 1) & 255)), all = g.alloc(l1.rowBytes * l1.rows);
  G.c("TextureWriteTexels", [t, G.view({ level: 1 }), g.u32([30, 20, 0, 13, 6, 1]), src]);
  G.c("TextureReadTexels", [t, G.view({ level: 1 }), g.u32([0, 0, 0, 50, 30, 1]), all]);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 50; x++) {
    const inside = x >= 30 && x < 43 && y >= 20 && y < 26, want = inside ? ((((y - 20) * 13 + x - 30) * 4) * 5 + 1) & 255 : lin[y * l1.rowBytes + x * 4];
    assert.equal(g.u8[all + (y * 50 + x) * 4], want, `texel ${x},${y}`);
  }
  // an array layer, and a block-compressed region (4x4 blocks: 8 bytes each)
  const a = cases.find(x => x.name.startsWith("RGBA8 array"))!, ta = put(a), al = a.levels.find(l => l.layer === 2 && l.level === 0)!;
  G.c("TextureReadTexels", [ta, G.view({ layer: 2 }), g.u32([0, 0, 0, 32, 32, 1]), dst]);
  assert.ok(Buffer.from(g.u8.subarray(dst, dst + 4096)).equals(Buffer.from(al.linear, "base64")), "array layer 2");
  const b = cases.find(x => x.name.startsWith("BC1 64x64"))!, tb = put(b), bl = Buffer.from(b.levels[0].linear, "base64");
  G.c("TextureReadTexels", [tb, 0, g.u32([8, 12, 0, 16, 8, 1]), dst]);
  for (let y = 0; y < 2; y++) assert.ok(Buffer.from(g.u8.subarray(dst + y * 32, dst + y * 32 + 32)).equals(bl.subarray((3 + y) * 128 + 16, (3 + y) * 128 + 48)), `BC block row ${y}`);
  assert.equal(g.x.gfx_tex_state(t), 0, "no GPU involved: the storage is the content"); assert.deepEqual(g.red(), []);
});
