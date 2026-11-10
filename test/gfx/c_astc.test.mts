// The ASTC decoder (src/gfx/astc.ts, written from the specification) against astcenc, an independent implementation
// (test/gfx/astc_ref.py: 119 images over the 14 block sizes, linear and sRGB, three encoder qualities, and 1536 blocks
// of random bytes). Exact equality, every texel. Also the float half of the nvn_call ABI and nvn_name.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, guest, ROOT, OUT, NXNATIVE } from "./harness.mts";

export interface AstcCase { name: string; bw: number; bh: number; w: number; h: number; srgb: boolean; random?: boolean; astc: string; rgba: string }
export function astcFixtures(): AstcCase[] | null {
  const r = spawnSync("python3", [join(ROOT, "test/gfx/astc_ref.py"), join(OUT, "astc.json")], { stdio: "ignore" });
  if (r.status !== 0) return null;
  return JSON.parse(readFileSync(join(OUT, "astc.json"), "utf8")).cases;
}

test("ASTC: the decoder equals astcenc on every texel of 119 images (14 block sizes, linear and sRGB) and of 1536 random blocks", async () => {
  const cases = astcFixtures();
  if (!cases) { console.log("     SKIPPED: astc-encoder-py is not installed (pip install astc-encoder-py)"); return; }
  const g = await guest();
  let texels = 0, blocks = 0, errorTexels = 0, randomBlocks = 0;
  const modes = new Set<string>();
  for (const c of cases) {
    const astc = Buffer.from(c.astc, "base64"), want = Buffer.from(c.rgba, "base64"), nbx = Math.ceil(c.w / c.bw), nby = Math.ceil(c.h / c.bh);
    assert.equal(astc.length, nbx * nby * 16, `${c.name}: compressed size`);
    const src = g.alloc(astc.length), pitch = nbx * c.bw * 4, out = g.alloc(pitch * nby * c.bh);
    g.u8.set(astc, src);
    g.x.gfx_astc_decode(src, nbx * 16, nbx, nby, c.bw, c.bh, out, pitch, c.srgb ? 1 : 0);
    blocks += nbx * nby; if (c.random) randomBlocks += nbx * nby;
    for (let b = 0; b < nbx * nby; b++) {
      const m = astc.readUInt16LE(b * 16) & 0x7ff, parts = ((astc.readUInt32LE(b * 16) >> 11) & 3) + 1;
      modes.add((m & 0x1ff) === 0x1fc ? "void" : `p${parts}${m & 0x400 && ((m & 3) || ((m >> 7) & 3) !== 2) ? "d" : ""}`);
    }
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const o = out + y * pitch + x * 4, w = (y * c.w + x) * 4;
      // An illegal or HDR block: the specification's LDR error colour is opaque magenta, which is what the decoder writes;
      // astcenc writes NaN, which its 8-bit output turns into 255 in every channel
      const mine = Array.from(g.u8.subarray(o, o + 4)), ref = Array.from(want.subarray(w, w + 4));
      if (mine.join() === "255,0,255,255" && ref.join() === "255,255,255,255") { errorTexels++; texels++; continue; }
      for (let k = 0; k < 4; k++) if (mine[k] !== ref[k]) assert.fail(`${c.name}: texel (${x},${y}) channel ${k} is ${mine[k]}, astcenc has ${ref[k]} (block ${Buffer.from(astc.subarray((Math.floor(y / c.bh) * nbx + Math.floor(x / c.bw)) * 16, (Math.floor(y / c.bh) * nbx + Math.floor(x / c.bw)) * 16 + 16)).toString("hex")})`);
      texels++;
    }
    if (!c.random) assert.equal(errorTexels, 0, `${c.name}: an encoder's block decoded as an error`);
  }
  console.log(`     ${cases.length} cases, ${blocks} blocks, ${texels} texels equal; block kinds met: ${[...modes].sort().join(" ")}; of the ${randomBlocks} random blocks' texels ${errorTexels} are the error colour in both decoders, the others equal`);
  assert.equal(g.red().length, 0);
});

test("nvn_call ABI: nvn_abi's float argument counts agree with the prototypes in nxnative's nvn_protos.h; float results arrive at args + 64; nvn_name", async () => {
  const g = await guest(), n = g.x.nvn_count();
  // nvn_name round-trips through nvn_lookup for every id
  const dec = new TextDecoder(), nameBuf = g.alloc(128);
  const names: string[] = [];
  for (let id = 0; id < n; id++) {
    const p = g.x.nvn_name(id) >>> 0; assert.ok(p, `nvn_name(${id})`);
    let e = p; while (g.u8[e]) e++;
    const name = dec.decode(g.u8.subarray(p, e)); names.push(name);
    g.u8.set(new TextEncoder().encode(name + "\0"), nameBuf);
    assert.equal(g.x.nvn_lookup(nameBuf), id, name);
  }
  assert.equal(g.x.nvn_name(-1), 0); assert.equal(g.x.nvn_name(n), 0);
  // the prototypes: `typedef type (*NVNT_nvnName)(args);` in nxnative's nvn_protos.h, counted independently of dispatch.ts
  const header = readFileSync(join(NXNATIVE, "dm/gfx/nvn/nvn_protos.h"), "utf8");
  const protos = new Map<string, { floats: number; ret: boolean }>();
  for (const m of header.matchAll(/typedef\s+([^()]+?)\s*\(\*NVNT_(nvn\w+)\)\(([^;]*)\);/g))
    protos.set(m[2], { floats: m[3].split(",").filter(a => /^\s*(const\s+)?(float|double)(\s+\w+)?\s*$/.test(a)).length, ret: /^(float|double)$/.test(m[1].trim()) });
  const table = new Uint8Array(g.memory.buffer, g.x.nvn_abi_table() >>> 0, n);
  let checked = 0, withFloats = 0, floatResults = 0; const ignored: string[] = [];
  for (let id = 0; id < n; id++) {
    assert.equal(g.x.nvn_abi(id), table[id]);
    if (g.x.nvn_status(id) !== 1) { assert.equal(table[id], 0, `${names[id]} is not implemented: no float ABI`); continue; }
    const p = protos.get(names[id]);
    if (!p) continue;
    assert.ok((table[id] & 15) <= p.floats, `${names[id]}: reads ${table[id] & 15} float arguments, its prototype has ${p.floats}`);
    if ((table[id] & 15) < p.floats) ignored.push(names[id]); assert.equal((table[id] & 16) !== 0, p.ret, `${names[id]}: float result`);
    checked++; if (table[id] & 15) withFloats++; if (p.ret) floatResults++;
  }
  assert.ok(checked > 300, `only ${checked} implemented functions have a prototype in nvn_protos.h`);
  // a float result: set, then read back through d0
  const sb = g.alloc(0x60);
  g.call("nvnSamplerBuilderSetDefaults", [sb]); g.call("nvnSamplerBuilderSetLodBias", [sb], [-1.25]); g.call("nvnSamplerBuilderSetMaxAnisotropy", [sb], [8]);
  const args = (g as any).args as number;
  g.call("nvnSamplerBuilderGetLodBias", [sb]); assert.equal(g.dv.getFloat32(args + 64, true), -1.25); assert.equal(g.dv.getUint32(args + 68, true), 0);
  g.call("nvnSamplerBuilderGetMaxAnisotropy", [sb]); assert.equal(g.dv.getFloat32(args + 64, true), 8);
  console.log(`     ${checked} implemented functions checked against nvn_protos.h: ${withFloats} read float arguments, ${floatResults} return a float; float arguments the implementation ignores: ${ignored.join(", ") || "none"}`);
});
