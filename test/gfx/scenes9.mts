// Scenes of `npm run gfx:test` (browser) for the stream capture (src/glue/gfx_stream_capture.ts, test/gfx/REPLAY.md): frames of a running scene are captured
// as `?gfxcapture=` captures a game's, and the capture is replayed on a second replayer that has no recorder and no guest memory, only the file.
import { Env } from "./env.mts";
import { FMT, FILTER, STAGE } from "./nvn.mts";
import { type Scene, T, REGION, upload, ubo, uboProgram, bindUbos, IDENT } from "./scenes.mts";
import { GfxHost, type ShaderInfo } from "../../src/glue/gfx_host.ts";
import { SHADERS } from "./env.mts";
import { indexCapture, replayCapture, parseCaptureSpec } from "../../src/glue/gfx_stream_capture.ts";

const checker = (w: number, h: number, a: number[], b: number[]) => Array.from({ length: w * h * 4 }, (_, i) => { const p = i >> 2; return (((p % w) >> 2) + (Math.floor(p / w) >> 2)) & 1 ? a[i & 3] : b[i & 3]; });
function b64(b: Uint8Array): string { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }

// a compute stage whose images name no format (the translator declares such an image float, ShaderInfo.images `bound`): it stores four floats into image 0;
// stores a float into image 1, loads it back and stores what it read, doubled, into image 2
const CS_NOFORMAT: ShaderInfo = { stage: "compute", images: [{ slot: 0, format: "rgba8unorm", access: "write-only", bound: true, type: "float" }, { slot: 1, format: "r32float", access: "read-write", bound: true, type: "float" },
  { slot: 2, format: "rgba16float", access: "write-only", bound: true, type: "float" }],
  wgsl: `@group(1) @binding(272) var img: texture_storage_2d<rgba8unorm, write>; @group(1) @binding(273) var rw: texture_storage_2d<r32float, read_write>;
@group(1) @binding(274) var back: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  textureStore(img, vec2i(id.xy), vec4f(1.0, 2.0, -1.0, f32(id.x) + 0.5));
  textureStore(rw, vec2i(id.xy), vec4f(1.5, 0.0, 0.0, 1.0));
  let v = textureLoad(rw, vec2i(id.xy));
  textureStore(back, vec2i(id.xy), vec4f(v.x * 2.0, 0.0, 0.0, 1.0)); }` };
SHADERS.cs_noformat = CS_NOFORMAT;

// writes one BC4 block as an RGBA16UI texel: both endpoints 200, every index 0
SHADERS.fs_bc4_block = { stage: "fragment", outputs: [0], wgsl: `@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4u { return vec4u(0xc8c8u, 0u, 0u, 0u); }` };

export const scenes9: Scene[] = [
  { name: "a texture finalized after the commands that draw into it and sample it were recorded, before they are submitted: the commands still find it", async run(e, t) {
    const G = e.G, cmd = G.cmd, flat = await uboProgram(e), show = await e.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    const rt = G.texture({ w: 16, h: 16, format: FMT.RGBA8 }), id = G.texId(rt), i = G.acquire(e.win);
    G.begin();
    e.frame(cmd, rt, flat); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 16, 16]); bindUbos(e, cmd, ubo(e, [1, 1, 0, 0, 0, 0, 0, 0]), ubo(e, [1, 0, 1, 1])); e.drawQuad(cmd);
    e.frame(cmd, e.wtex[i], show); G.clear(cmd, [0, 0, 1, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); e.bindTexture(cmd, id, nearest); e.drawQuad(cmd);
    const h = G.end();
    G.c("TextureFinalize", [rt]);                 // the game is done with it; the GPU is not
    G.submit([h]); G.present(e.win, i);
    t.rect(await e.read(), 0, 0, 64, 64, [255, 0, 255, 255], "the window shows what was drawn into the finalized texture");
    t.noRed(e);
    t.eq(e.g.dv.getUint32(rt, true), 0, "after the submission the object is finalized");
  } },
  { name: "a pipeline WebGPU refuses, built for a draw in the middle of a submission: what was drawn before it is kept, the pipeline is dropped and reported with the reason", async run(e, t) {
    const G = e.G, cmd = G.cmd, good = await uboProgram(e), bad = await e.program("vs_bad", "fs_ubo"), i = G.acquire(e.win);
    G.begin();
    e.frame(cmd, e.wtex[i], good); G.clear(cmd, [0, 0, 1, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); bindUbos(e, cmd, ubo(e, [1, 1, 0, 0, 0, 0, 0, 0]), ubo(e, [0, 1, 0, 1])); e.drawQuad(cmd);
    G.c("CommandBufferBindProgram", [cmd, bad, 3]); bindUbos(e, cmd, ubo(e, [0.5, 0.5, 0, 0, 0, 0, 0, 0]), ubo(e, [1, 0, 0, 1])); e.drawQuad(cmd);     // its vertex inputs do not match the layout
    e.finish(i);
    await e.settle();
    t.rect(await e.read(), 0, 0, 64, 64, [0, 255, 0, 255], "the quad drawn before the refused pipeline is there");
    t.eq(e.host.stats.pipelinesFailed, 1, "one pipeline failed");
    t.ok(e.g.red().some(l => /pipeline \d+ did not build: .*base type/.test(l)), `the reason is said: ${JSON.stringify(e.g.red())}`);
    // the next frame: the recorder knows, the draw is skipped and nothing is invalid
    const errors = e.host.stats.errors, j = G.acquire(e.win);
    G.begin();
    e.frame(cmd, e.wtex[j], good); G.clear(cmd, [0, 0, 1, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); bindUbos(e, cmd, ubo(e, [1, 1, 0, 0, 0, 0, 0, 0]), ubo(e, [1, 1, 0, 1])); e.drawQuad(cmd);
    G.c("CommandBufferBindProgram", [cmd, bad, 3]); e.drawQuad(cmd);
    e.finish(j);
    await e.settle();
    t.rect(await e.read(), 0, 0, 64, 64, [255, 255, 0, 255], "the next frame draws"); t.eq(e.host.stats.errors, errors, "no further WebGPU error");
  } },
  { name: "a storage image on an RGB9E5 texture (WebGPU neither stores to the format nor draws into it): the dispatch writes a stand-in that a compute pass packs into the texture; sampled afterwards", async run(e, t) {
    const G = e.G, cmd = G.cmd, cimage = await e.computeProgram("cs_image"), show = await e.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    const hdr = G.texture({ w: 16, h: 16, format: 0x40 /* RGB9E5 */ }), i = G.acquire(e.win);
    G.begin();
    G.c("CommandBufferBindProgram", [cmd, cimage, 0x20]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.COMPUTE, 0, ubo(e, [0, 0, 0.5, 0]), 16]);
    G.c("CommandBufferBindImage", [cmd, STAGE.COMPUTE, 0, G.c("DeviceGetImageHandle", [G.dev, G.texId(hdr)])]); G.c("CommandBufferDispatchCompute", [cmd, 2, 2, 1]);
    e.frame(cmd, e.wtex[i], show); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); e.bindTexture(cmd, G.texId(hdr), nearest); e.drawQuad(cmd);
    e.finish(i);
    const img = await e.read();
    // texel (x, y) of the image holds (x / 15, y / 15, 0.5): 9 bits a channel under one exponent, well inside a step of the 8-bit window
    for (const [x, y] of [[0, 0], [15, 15], [3, 12], [8, 5], [15, 0]]) { const px = img.px(x * 4 + 2, y * 4 + 2); t.ok(Math.abs(px[0] - x * 17) <= 2 && Math.abs(px[2] - 128) <= 2 && (Math.abs(px[1] - y * 17) <= 2 || Math.abs(px[1] - (15 - y) * 17) <= 2), `texel ${x},${y}: ${px}`); }
    t.noRed(e); t.eq([e.host.stats.dispatches, e.host.stats.imageStandIns], [1, 1], "the dispatch ran on a stand-in");
  } },
  { name: "a render target view of a BC4 texture as RGBA16UI (a block a texel: a GPU compressor): drawn into a texture of the view's format and copied over the level, then sampled as BC4", async run(e, t) {
    const G = e.G, cmd = G.cmd, comp = await e.program("vs_quad", "fs_bc4_block"), show = await e.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    const bc = G.texture({ w: 8, h: 8, format: 0x49 /* BC4 */ }), i = G.acquire(e.win);
    G.begin();
    e.frame(cmd, bc, comp); G.targets(cmd, [bc], 0, [G.view({ format: 0x2c /* RGBA16UI */ })]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 2, 2]); G.c("CommandBufferSetScissor", [cmd, 0, 0, 2, 2]); e.drawQuad(cmd);
    e.frame(cmd, e.wtex[i], show); G.clear(cmd, [0, 0, 1, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); G.c("CommandBufferSetScissor", [cmd, 0, 0, 64, 64]); e.bindTexture(cmd, G.texId(bc), nearest); e.drawQuad(cmd);
    e.finish(i);
    t.rect(await e.read(), 0, 0, 64, 64, [200, 0, 0, 255], "every texel of the BC4 texture decodes to 200");
    t.noRed(e); t.eq(e.host.stats.pipelinesFailed, 0, "no pipeline failed");
  } },
  { name: "a storage image the shader names no format for (declared float) with an unsigned integer texture bound: the dispatch runs on a variant whose stores and loads hand the bits over", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await e.computeProgram("cs_noformat"), flat = await uboProgram(e);
    const u = G.texture({ w: 8, h: 8, format: 0x2f /* RGBA32UI */ }), r = G.texture({ w: 8, h: 8, format: 0x0b /* R32UI */ }), f = G.texture({ w: 8, h: 8, format: FMT.RGBA16F }), i = G.acquire(e.win);
    G.begin();
    G.c("CommandBufferBindProgram", [cmd, prog, 0x20]);
    G.c("CommandBufferBindImages", [cmd, STAGE.COMPUTE, 0, 3, e.g.u64([u, r, f].map(x => G.c("DeviceGetImageHandle", [G.dev, G.texId(x)])))]);
    G.c("CommandBufferDispatchCompute", [cmd, 1, 1, 1]);
    e.frame(cmd, e.wtex[i], flat); G.clear(cmd, [0, 0, 0, 1]); e.finish(i);
    const bits = (v: number[]) => Array.from(new Uint8Array(new Float32Array(v).buffer)), iu = await e.read(e.serial(u)), ir = await e.read(e.serial(r)), ib = await e.read(e.serial(f));
    t.eq([iu.bytesPerPixel, iu.px(0, 0), iu.px(5, 3)], [16, bits([1, 2, -1, 0.5]), bits([1, 2, -1, 5.5])], "RGBA32UI: the bits of the four floats stored");
    t.eq([ir.px(2, 2), ib.px(2, 2).slice(0, 2)], [bits([1.5]), [0x00, 0x42]], "R32UI: the bits of 1.5; loaded back as the float 1.5, doubled into the float image (3.0 as a half)");
    t.noRed(e); t.eq(e.host.stats.dispatches, 1, "the dispatch ran");
  } },
  { name: "fragment outputs declared float drawn into an unsigned integer target: the pipeline takes a variant whose outputs hand their bits over (as the console's GPU writes them)", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await uboProgram(e), u = G.texture({ w: 8, h: 8, format: 0x2f /* RGBA32UI */ }), i = G.acquire(e.win);
    G.begin();
    e.frame(cmd, u, prog); G.c("CommandBufferSetViewport", [cmd, 0, 0, 8, 8]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 2, -1, 0.5])); e.drawQuad(cmd);
    e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [0, 1, 0, 1])); e.drawQuad(cmd);     // the same shader into a float target: as it is
    e.finish(i);
    const bits = Array.from(new Uint8Array(new Float32Array([1, 2, -1, 0.5]).buffer)), img = await e.read(e.serial(u));
    t.eq([img.bytesPerPixel, img.px(0, 0), img.px(7, 7), img.px(3, 4)], [16, bits, bits, bits], "the integer target holds the bits of the floats the shader wrote");
    t.rect(await e.read(), 0, 0, 64, 64, [0, 255, 0, 255], "the float target: the colour");
    t.noRed(e); t.eq(e.host.stats.pipelinesFailed, 0, "no pipeline failed");
    t.ok(e.g.logs.some(l => l.includes("hand their bits over")), "the variant is said once in the log");
  } },
  { name: "stream capture: three frames of a running scene (memory pages, textures and a depth buffer the GPU holds, shaders, pipelines made before and during) replay without the recorder to the same texels", async run(e, t) {
    const G = e.G, cmd = G.cmd, tex = await e.program("vs_quad_ubo", "fs_tex"), flat = await e.program("vs_quad_ubo", "fs_ubo"), inv = await e.program("vs_quad_ubo", "fs_tex_invert");
    const nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST), depth = G.texture({ w: 64, h: 64, format: FMT.DEPTH32F }), rt = G.texture({ w: 32, h: 32, format: FMT.RGBA8 }), rtId = G.texId(rt);
    let a: { tex: number; id: number } | null = null, late: { tex: number; id: number } | null = null;
    const top0 = () => e.g.top;
    let top = 0;
    const vsU = (v: number[]) => G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.VERTEX, 0, ubo(e, v), 32]), fsU = (v: number[]) => G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, ubo(e, v), 16]);
    const frame = (k: number) => {
      if (top) { e.g.top = top; G.c("CommandBufferAddCommandMemory", [cmd, G.cmdPool.obj, 0, G.cmdPool.size]); }     // the same addresses every frame, other bytes in them
      const i = G.acquire(e.win); G.begin();
      if (k === 0) {
        // before the capture: a texture from memory, and an offscreen target drawn once (inside the capture it is only sampled: its texels exist on the GPU alone)
        a = upload(e, cmd, 16, 16, FMT.RGBA8, checker(16, 16, [255, 0, 0, 255], [0, 0, 255, 255]));
        G.targets(cmd, [rt]); const st0 = G.defaultStates(cmd); void st0; e.frame(cmd, rt, flat); G.clear(cmd, [0, 0.5, 0, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 32]);
        vsU([0.5, 0.5, 0.25, -0.25, 0.5, 0, 0, 0]); fsU([1, 1, 0, 1]); e.drawQuad(cmd);
      }
      if (k === 4) late = upload(e, cmd, 8, 8, FMT.RGBA8, checker(8, 8, [255, 255, 255, 255], [0, 0, 0, 255]));       // a texture made inside the capture
      const st = e.frame(cmd, e.wtex[i], tex, depth);
      G.c("DepthStencilStateSetDepthTestEnable", [st.ds, 1]); G.c("CommandBufferBindDepthStencilState", [cmd, st.ds]);
      G.clear(cmd, [k / 8, 0, 0.25, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]);
      if (k !== 2) G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0], [1.0]);      // frame 2 (the first captured) keeps frame 1's depth: the far quad below is hidden where frame 1 drew near
      if (k === 1) { vsU([0.25, 0.25, -0.5, 0.5, 0.2, 0, 0, 0]); e.bindTexture(cmd, a!.id, nearest); e.drawQuad(cmd); }      // near, upper left
      vsU([0.6, 0.6, -0.3 + k * 0.05, 0.3, 0.7, 0, 0, 0]); e.bindTexture(cmd, a!.id, nearest); e.drawQuad(cmd);               // far, moves with k
      vsU([0.3, 0.3, 0.5, -0.5 + k * 0.1, 0.5, 0, 0, 0]); e.bindTexture(cmd, rtId, nearest); e.drawQuad(cmd);                  // the offscreen target
      G.c("CommandBufferBindProgram", [cmd, flat, 3]); vsU([0.1, 0.1, -0.8, -0.8, 0.4, 0, 0, 0]); fsU([0, k / 4, 1, 1]); e.drawQuad(cmd);
      if (k >= 3) { G.c("CommandBufferBindProgram", [cmd, inv, 3]); vsU([0.2, 0.2, 0.6, 0.6, 0.3, 0, 0, 0]); e.bindTexture(cmd, (late ?? a)!.id, nearest); e.drawQuad(cmd); }   // a pipeline first asked for inside the capture
      e.finish(i);
    };
    frame(0); await e.read(); top = top0();
    const parts: Uint8Array[] = [], written = e.host.streamCapture(parseCaptureSpec("3")!, { write: b => { parts.push(b.slice()); } });
    frame(1); await e.read();
    const want: Uint8Array[] = [];
    for (let k = 2; k <= 4; k++) { frame(k); want.push((await e.read()).data); }
    const sum = await written;
    t.noRed(e);
    t.eq([sum.frames, sum.texturesWithoutContent, sum.pipelines >= 3, sum.shaders], [3, [], true, 4], "the capture's summary");
    const file = new Uint8Array(parts.reduce((n, b) => n + b.length, 0)); parts.reduce((o, b) => { file.set(b, o); return o + b.length; }, 0);
    t.eq(sum.bytes, file.length, "bytes written");
    t.files.push({ name: "capture/proof.gfxcap", base64: b64(file) });      // for the standalone harness: node test/gfx/replay.mts build/gfx/capture/proof.gfxcap
    const index = await indexCapture((o, n) => file.subarray(o, o + n), file.length);
    t.ok(index.complete, "the file ends with its end chunk");
    const kinds = (k: string) => index.chunks.filter(c => c.h.type === k);
    t.ok(kinds("tex").some(c => c.h.serial === e.serial(rt) && c.h.content) && kinds("tex").some(c => c.h.serial === e.serial(depth) && c.h.content?.depth), "the offscreen target and the depth buffer came with their contents");
    t.ok(kinds("pipe").length >= 2 && kinds("batch").length >= 3 && kinds("frame").length === 3, "pipelines made before, batches, live frames");
    // the replay: a replayer of its own on the same device, a memory that holds only the captured pages
    const r = await replayCapture(index, i => file.subarray(index.chunks[i].off, index.chunks[i].off + index.chunks[i].len),
      (memory, log) => new GfxHost(e.host.device, memory as any, { log, capture: false }), { keepData: true });
    t.eq([r.errors, r.notes], [[], []], "replay: no red line, no note");
    t.eq(r.frames.map(f => [f.width, f.height, f.live, f.differing]), [[64, 64, "same", 0], [64, 64, "same", 0], [64, 64, "same", 0]], "each replayed frame against the live image in the capture");
    r.frames.forEach((f, k) => { let d = 0; for (let i = 0; i < want[k].length; i++) if (want[k][i] !== f.data![i]) d++; t.eq(d, 0, `frame ${k}: bytes that differ from what the scene read back live`); });
    // and the pictures are not trivially equal: the three frames differ from each other
    t.ok(want[0].some((v, i) => v !== want[1][i]) && want[1].some((v, i) => v !== want[2][i]), "the captured frames differ from each other");
    console.log(`stream capture: ${sum.frames} frames, ${sum.batches} batches, ${sum.pages} pages, ${sum.textures} textures (${sum.textureBytes} bytes of contents), ${sum.pipelines} pipelines, ${sum.shaders} shaders in ${file.length} bytes; replayed in ${r.ms} ms: ${r.stats.draws} draws, every frame identical to the live one`);
    r.host.dispose();
  } },
];
