// Scenes of `npm run gfx:test` (browser) for ?ndve=bypass (src/glue/ndve.ts NdveBypass, GfxHost.ndveBypass): nn::ndve's movie network is 14 compute
// dispatches a frame, here 14 synthetic NVN2 shaders whose keys stand for the model's. None is ready (the page is still translating them, or nxweb cannot:
// HMMA), so the movie's output image would stay as it was. With the stand-in armed, the picture the first U-Net layer binds (texture slot 1) is resampled
// bilinearly into the image the resampler binds (image slot 1); without it nothing changes. Checked on texels against values computed here.
import { Env } from "./env.mts";
import { FMT, STAGE, FILTER } from "./nvn.mts";
import { type Scene, T, REGION, upload } from "./scenes.mts";
import type { ShaderInfo } from "../../src/glue/gfx_host.ts";

const SW = 6, SH = 3, DW = 8, DH = 4, BLUE = [0, 0, 255, 255], GREEN = [0, 255, 0, 255];
const PIC = Array.from({ length: SW * SH * 4 }, (_, i) => { const p = i >> 2, c = i & 3, x = p % SW, y = Math.floor(p / SW); return c === 3 ? 255 : c === 0 ? x * 50 : c === 1 ? y * 120 : (x * 37 + y * 91) & 255; });
// the stand-in's texel (x, y) of the DW x DH output: texel centres, edges clamped, alpha 1
function bilinear(x: number, y: number): number[] {
  const cx = (x + 0.5) * SW / DW - 0.5, cy = (y + 0.5) * SH / DH - 0.5, fx = Math.floor(cx), fy = Math.floor(cy), wx = cx - fx, wy = cy - fy;
  const at = (i: number, j: number, c: number) => PIC[(Math.min(SH - 1, Math.max(0, j)) * SW + Math.min(SW - 1, Math.max(0, i))) * 4 + c];
  return [0, 1, 2].map(c => Math.round(((at(fx, fy, c) * (1 - wx) + at(fx + 1, fy, c) * wx) * (1 - wy) + (at(fx, fy + 1, c) * (1 - wx) + at(fx + 1, fy + 1, c) * wx) * wy))).concat(255);
}
// the game's resampler, once it is ready: green into image slot 1 (group 1, binding 256 + 2 * 8 + 1)
const RESAMPLER: ShaderInfo = { stage: "compute", images: [{ slot: 1, format: "rgba8unorm" }], wgsl: `@group(1) @binding(273) var img: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(img, vec2i(id.xy), vec4f(0.0, 1.0, 0.0, 1.0)); }` };

// Three frames of the network into a blue output: (1) nothing ready, (2) the same with the resampler's push constants flipping rows (word 19 on, word 18 the row
// base), (3) the resampler ready but not the U-Net. The output's texels after each
async function frames(e: Env, bypass: boolean) {
  const G = e.G, cmd = G.cmd, sh = await Promise.all(Array.from({ length: 14 }, (_, i) => e.blobs2(`ndve${bypass ? "on" : "off"}${i}`))), keys = sh.map(s => s.key);
  if (bypass) e.host.ndveBypass(keys);
  for (const k of keys) e.host.shaderPending(k, "pending");
  const progs = sh.map(s => G.program([s])), out = G.texture({ w: DW, h: DH, format: FMT.RGBA8 }), img = G.c("DeviceGetImageHandle", [G.dev, G.texId(out)]);
  const samp = G.sampId(FILTER.NEAREST, FILTER.NEAREST), got: Awaited<ReturnType<Env["read"]>>[] = [];
  let pic = 0;
  for (let f = 0; f < 3; f++) {
    if (f === 2 && e.host.registerShader(keys[13], { entry: "main", ...RESAMPLER }) < 0) throw new Error("registerShader resampler");
    G.begin();
    if (!f) pic = upload(e, cmd, SW, SH, FMT.RGBA8, PIC).id;
    G.c("CommandBufferClearTexture", [cmd, out, 0, REGION(e, 0, 0, 0, DW, DH), G.put(new Float32Array([0, 0, 1, 1])), 0xf]);
    G.c("CommandBufferBindTexture", [cmd, STAGE.COMPUTE, 1, G.handle(pic, samp)]); G.c("CommandBufferBindImage", [cmd, STAGE.COMPUTE, 1, img]);
    G.c("CommandBufferPushComputeConstants", [cmd, 0, 18 * 4, 8, G.put(new Int32Array([DH - 1, f === 1 ? 1 : 0]))]);
    for (const p of progs) { G.c("CommandBufferBindProgram", [cmd, p, 0x20]); G.c("CommandBufferDispatchCompute", [cmd, 1, 1, 1]); }
    G.submit([G.end(cmd)]);
    got.push(await e.read(e.serial(out)));
  }
  return got;
}

// One scene (one guest memory): the flag off first, then on, each with keys of its own
export const scenes8: Scene[] = [
  { name: "ndve=bypass: off (the default), the movie network's frames leave its output as it was; on, a stand-in resamples the picture bilinearly into the resampler's image when the network cannot run (rows flipped by its push constants), also when only the resampler is ready", async run(e, t) {
    const [oa, ob, oc] = await frames(e, false);
    t.rect(oa, 0, 0, DW, DH, BLUE, "off, frame 1: untouched"); t.rect(ob, 0, 0, DW, DH, BLUE, "off, frame 2: untouched"); t.rect(oc, 0, 0, DW, DH, GREEN, "off, frame 3: the resampler's own output");
    t.eq([e.host.stats.ndveSkipped, e.host.stats.ndveStandIns], [0, 0], "off: the recorder tells the replayer of no skipped dispatch, no stand-in");
    t.noRed(e);
    const [a, b, c] = await frames(e, true);
    for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) {
      t.px(a, x, y, bilinear(x, y), `on, frame 1: the ${SW}x${SH} picture resampled bilinearly into the ${DW}x${DH} output`, 1);
      t.px(b, x, DH - 1 - y, bilinear(x, y), "on, frame 2: the same, rows flipped as the resampler's push constants say", 1);
      t.px(c, x, y, bilinear(x, y), "on, frame 3: the resampler is ready but the network did not run: the stand-in, not the resampler's output", 1);
    }
    t.eq([e.host.stats.ndveSkipped, e.host.stats.ndveStandIns], [14 + 14 + 13, 3], "on: dispatches the recorder could not run, told to the replayer; frames the stand-in wrote");
    const red = e.g.red();
    // the stand-in says once that it replaced the network, and (diagnostics of the same switch) which source it took and that no decoder planes were among the textures
    t.ok(red.length >= 1 && red.every(l => l.startsWith("[RED] ndve=bypass: ")), `on: only the stand-in's own red lines: ${JSON.stringify(red)}`);
    const said = red.filter(l => /\[RED\] ndve=bypass: nn::ndve's movie network did not run .*a stand-in replaced it, the 6x3 picture resampled bilinearly into the network's 8x4 rgba8unorm output/.test(l));
    t.eq(said.length, 1, `on: the replacement is said once: ${JSON.stringify(red)}`);
    t.eq(e.host.stats.errors, 0, "WebGPU errors");
  } },
];
