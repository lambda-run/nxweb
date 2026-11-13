// Scenes of `npm run gfx:test` (browser) for the stream capture (src/glue/gfx_stream_capture.ts, test/gfx/REPLAY.md): frames of a running scene are captured
// as `?gfxcapture=` captures a game's, and the capture is replayed on a second replayer that has no recorder and no guest memory, only the file.
import { Env } from "./env.mts";
import { FMT, FILTER, STAGE } from "./nvn.mts";
import { type Scene, T, REGION, upload, ubo } from "./scenes.mts";
import { GfxHost } from "../../src/glue/gfx_host.ts";
import { indexCapture, replayCapture, parseCaptureSpec } from "../../src/glue/gfx_stream_capture.ts";

const checker = (w: number, h: number, a: number[], b: number[]) => Array.from({ length: w * h * 4 }, (_, i) => { const p = i >> 2; return (((p % w) >> 2) + (Math.floor(p / w) >> 2)) & 1 ? a[i & 3] : b[i & 3]; });
function b64(b: Uint8Array): string { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }

export const scenes9: Scene[] = [
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
