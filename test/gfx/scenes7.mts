// Scenes of `npm run gfx:test` (browser) for the blocks the host supplies to translated shaders (src/shaders/spv.ts placeHostBank: group 0 binding 208 + stage * 4 + k,
// k 0 c1, 1 the driver's c0, 2 its c2, 3 NVN2's push constants c[24]) and for ClearTexture. The shaders are written here in the form the shader chain gives them,
// with the reflection record convertStage makes. Checked on pixels and texels.
import { Env } from "./env.mts";
import { FMT, STAGE } from "./nvn.mts";
import { type Scene, REGION, b8 } from "./scenes.mts";
import type { ShaderInfo } from "../../src/glue/gfx_host.ts";

const BLACK = [0, 0, 0, 255];
const hex = (b: ArrayBufferView) => Array.from(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), v => v.toString(16).padStart(2, "0")).join("");
async function register(e: Env, name: string, info: Omit<ShaderInfo, "entry">) {
  const s = await e.blobs(name);
  if (e.host.registerShader(s.key, { entry: "main", ...info } as ShaderInfo) < 0) throw new Error(`registerShader ${name}`);
  return s;
}
// fragment (stage 1): push constants at 215, c1 at 212
const FS_PUSH = `struct P { v: array<vec4f, 16> } @group(0) @binding(215) var<uniform> pc: P;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return pc.v[2]; }`;
const FS_C1 = `struct C { v: vec4f } @group(0) @binding(212) var<uniform> c1: C;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return c1.v; }`;
// compute (stage 2): push constants at 219, the driver's c0 at 217 (work group counts at 0x200); image 0
const CS_PUSH = `struct P { v: array<vec4f, 16> } @group(0) @binding(219) var<uniform> pc: P;
struct D { v: array<vec4u, 160> } @group(0) @binding(217) var<uniform> drv: D;
@group(1) @binding(272) var img: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = drv.v[0x200 / 16];
  textureStore(img, vec2i(id.xy), vec4f(pc.v[1].xy, f32(n.x * 4u + n.y) / 16.0, 1.0)); }`;
const PUSH_EXTRA = (binding: number) => ({ kind: "push", bank: 24, group: 0, binding, size: 256 });

export const scenes7: Scene[] = [
  { name: "host blocks: graphics and compute push constants (c[24]) as the stream pushed them, kept apart; c1 from the reflection; the driver's c0 work group counts", async run(e, t) {
    const G = e.G, cmd = G.cmd, vs = await e.shader("vs_quad");
    const fpush = G.program([vs, await register(e, "fs_push", { stage: "fragment", outputs: [0], extra: [PUSH_EXTRA(215)], wgsl: FS_PUSH })]);
    const fc1 = G.program([vs, await register(e, "fs_c1", { stage: "fragment", outputs: [0], extra: [{ kind: "c1", group: 0, binding: 212, size: 16, data: hex(new Float32Array([0, 1, 1, 1])) }], wgsl: FS_C1 })]);
    const cpush = G.program([await register(e, "cs_push", { stage: "compute", images: [{ slot: 0, format: "rgba8unorm" }], extra: [{ kind: "drvcb", bank: 0, group: 0, binding: 217, size: 0x210 }, PUSH_EXTRA(219)], wgsl: CS_PUSH })]);
    const push = (compute: boolean, off: number, v: number[]) => G.c(compute ? "CommandBufferPushComputeConstants" : "CommandBufferPushGraphicsConstants", [cmd, 0, off, v.length * 4, G.put(new Float32Array(v))]);
    const img = G.texture({ w: 16, h: 16, format: FMT.RGBA8 }), id = G.texId(img);
    let i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], fpush); G.clear(cmd, [0, 0, 0, 1]);
    push(false, 0x20, [1, 0, 0, 1]);
    push(true, 0x10, [0.25, 0.75]); push(true, 0x20, [0, 0, 1, 1]);                    // compute's block: the graphics one keeps its red
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 16, 64]); e.drawQuad(cmd);
    push(false, 0x24, [1]);                                                              // part of the block, between draws: yellow
    G.c("CommandBufferSetViewport", [cmd, 16, 0, 16, 64]); e.drawQuad(cmd);
    G.c("CommandBufferBindProgram", [cmd, fc1, 3]); G.c("CommandBufferSetViewport", [cmd, 32, 0, 16, 64]); e.drawQuad(cmd);
    G.c("CommandBufferBindProgram", [cmd, cpush, 0x20]); G.c("CommandBufferBindImage", [cmd, STAGE.COMPUTE, 0, G.c("DeviceGetImageHandle", [G.dev, id])]);
    G.c("CommandBufferDispatchCompute", [cmd, 2, 1, 1]);
    e.finish(i);
    const out = await e.read();
    t.rect(out, 0, 0, 16, 64, [255, 0, 0, 255], "graphics push constants at 0x20; compute's pushes went to its own block");
    t.rect(out, 16, 0, 32, 64, [255, 255, 0, 255], "a push of 4 bytes at 0x24 between draws: the next draw sees it, the rest stays");
    t.rect(out, 32, 0, 48, 64, [0, 255, 255, 255], "c1 from the reflection's data");
    t.rect(out, 48, 0, 64, 64, BLACK, "nothing drawn");
    const cs = await e.read(e.serial(img));
    for (const [x, y] of [[0, 0], [15, 7]]) t.px(cs, x, y, [b8(0.25), b8(0.75), b8(9 / 16), 255], "compute push constants at 0x10; c0 + 0x200 has the work group counts (2, 1, 1)", 1);
    t.noRed(e);
  } },

  { name: "ClearTexture, ClearTexturei and ClearTextureui: a whole level, a region with a component mask, a level and a layer of a view; integer formats take the integers", async run(e, t) {
    const G = e.G, cmd = G.cmd;
    const a = G.texture({ w: 16, h: 16, format: FMT.RGBA8, levels: 2 }), u = G.texture({ w: 8, h: 8, format: FMT.RGBA8UI }), s = G.texture({ w: 8, h: 8, format: 0x28 /* RGBA8I */ });
    const arr = G.texture({ w: 8, h: 8, format: FMT.RGBA8, target: 4 /* 2D array */, depth: 3 });
    G.begin();
    G.c("CommandBufferClearTexture", [cmd, a, 0, REGION(e, 0, 0, 0, 16, 16), G.put(new Float32Array([0, 0, 1, 1])), 0xf]);
    G.c("CommandBufferClearTexture", [cmd, a, 0, REGION(e, 4, 2, 0, 8, 6), G.put(new Float32Array([1, 0.5, 0, 0])), 0x3]);   // red and green only
    G.c("CommandBufferClearTexture", [cmd, a, G.view({ level: 1 }), REGION(e, 0, 0, 0, 8, 8), G.put(new Float32Array([0, 1, 0, 1])), 0xf]);
    G.c("CommandBufferClearTextureui", [cmd, u, 0, REGION(e, 0, 0, 0, 8, 8), G.put(new Uint32Array([1, 200, 3, 255])), 0xf]);
    G.c("CommandBufferClearTexturei", [cmd, s, 0, REGION(e, 0, 0, 0, 8, 8), G.put(new Int32Array([-5, 7, -128, 127])), 0xf]);
    G.c("CommandBufferClearTexturei", [cmd, s, 0, REGION(e, 2, 2, 0, 2, 2), G.put(new Int32Array([-1, -2, -3, -4])), 0x9]);
    G.c("CommandBufferClearTexture", [cmd, arr, 0, REGION(e, 0, 0, 0, 8, 8, 3), G.put(new Float32Array([0, 0, 0, 1])), 0xf]);
    G.c("CommandBufferClearTexture", [cmd, arr, G.view({ layer: 1 }), REGION(e, 0, 0, 1, 8, 8), G.put(new Float32Array([1, 1, 1, 1])), 0xf]);   // the view's layer 1 + z 1
    G.submit([G.end(cmd)]);
    const ra = await e.read(e.serial(a));
    t.rect(ra, 0, 0, 16, 2, [0, 0, 255, 255], "the whole level, cleared"); t.rect(ra, 0, 8, 16, 16, [0, 0, 255, 255], "below the region");
    t.rect(ra, 4, 2, 12, 8, [255, 128, 255, 255], "the region: red and green written, blue and alpha kept", 1); t.rect(ra, 0, 2, 4, 8, [0, 0, 255, 255], "left of it");
    t.rect(await e.read(e.serial(a), 1), 0, 0, 8, 8, [0, 255, 0, 255], "level 1 of a view");
    t.rect(await e.read(e.serial(u)), 0, 0, 8, 8, [1, 200, 3, 255], "unsigned integers into RGBA8UI", 0);
    const rs = await e.read(e.serial(s)), sb = (v: number[]) => v.map(x => x & 255);
    t.px(rs, 0, 0, sb([-5, 7, -128, 127]), "signed integers into RGBA8I"); t.px(rs, 2, 3, sb([-1, 7, -128, -4]), "a region with components 0 and 3"); t.px(rs, 4, 4, sb([-5, 7, -128, 127]), "past it");
    for (const [l, c] of [[0, 0], [1, 0], [2, 255]]) t.rect(await e.read(e.serial(arr), 0, l), 0, 0, 8, 8, [c, c, c, 255], `array layer ${l}`);
    t.eq(e.host.stats.errors, 0, "WebGPU errors"); t.eq(e.g.red(), [], "red lines");
  } },
];
