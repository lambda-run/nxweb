// The scenes of `npm run gfx:test` (browser). Each drives the recorder the way a game does, through nvn_call with
// argument blocks in the fake guest's memory (Env / Game / Guest), lets the replayer render with WebGPU, reads the
// presented texture back with copyTextureToBuffer and compares with values computed here. No golden images.
import { Env, SHADERS, type Image } from "./env.mts";
import { FMT, PRIM, STAGE, SIZEOF, BLEND, DEPTH_FUNC, FILTER, TARGET } from "./nvn.mts";

export interface Scene { name: string; run(e: Env, t: T): Promise<void>; cmdBytes?: number }
export class T {
  checks = 0;
  ok(c: boolean, msg: string) { this.checks++; if (!c) throw new Error(msg); }
  eq(a: unknown, b: unknown, msg: string) { this.checks++; if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
  px(img: Image, x: number, y: number, want: number[], msg: string, tol = 1) {
    this.checks++;
    const got = img.px(x, y);
    if (got.length !== want.length || got.some((v, i) => Math.abs(v - want[i]) > tol)) throw new Error(`${msg}: pixel (${x},${y}) is ${got}, expected ${want} (tolerance ${tol})`);
  }
  // every pixel of a rectangle
  rect(img: Image, x0: number, y0: number, x1: number, y1: number, want: number[], msg: string, tol = 1) { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.px(img, x, y, want, msg, tol); }
  noRed(e: Env) { this.eq(e.g.red(), [], "red lines"); this.eq(e.host.stats.errors, 0, "WebGPU errors"); }
}
const b8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
const rgba8 = (c: number[]) => c.map(b8);
const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], YELLOW = [255, 255, 0, 255];
const REGION = (e: Env, x: number, y: number, z: number, w: number, h: number, d = 1) => e.g.u32([x, y, z, w, h, d]);

// A texture filled from memory with CopyBufferToTexture, registered in the texture pool: its texture ID
function upload(e: Env, cmd: number, w: number, h: number, format: number, bytes: ArrayLike<number>): { tex: number; id: number } {
  const tex = e.G.texture({ w, h, format }), src = e.G.put(Uint8Array.from(bytes));
  e.G.c("CommandBufferCopyBufferToTexture", [cmd, src, tex, 0, REGION(e, 0, 0, 0, w, h), 0]);
  return { tex, id: e.G.texId(tex) };
}
// A program whose fragment stage reads one colour from fragment uniform buffer 0 and whose quad is placed by vertex uniform buffer 0
async function uboProgram(e: Env) { return e.program("vs_quad_ubo", "fs_ubo"); }
function ubo(e: Env, values: number[]): number { return e.G.put(new Float32Array(values)); }
function bindUbos(e: Env, cmd: number, vsAddr: number, fsAddr: number) {
  e.G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.VERTEX, 0, vsAddr, 32]); e.G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, fsAddr, 16]);
}
const IDENT = [1, 1, 0, 0, 0, 0, 0, 0];

export const scenes: Scene[] = [
  { name: "clear only", async run(e, t) {
    const G = e.G, i = G.acquire(e.win);
    G.begin(); G.targets(G.cmd, [e.wtex[i]]); G.clear(G.cmd, [0.25, 0.5, 0.75, 1]); e.finish(i);
    const img = await e.read();
    t.eq([img.width, img.height], [64, 64], "size"); t.rect(img, 0, 0, 64, 64, rgba8([0.25, 0.5, 0.75, 1]), "clear colour");
    t.eq([e.stat(0), e.stat(1)], [1, 0], "one pass (for the clear), no draw"); t.eq(e.host.stats.passes, 1, "replayer passes");
    t.noRed(e);
  } },

  { name: "triangle with per-vertex colour", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await e.program("vs_color", "fs_color"), i = G.acquire(e.win);
    // one triangle over the whole target: A(-1,-1) red, B(3,-1) green, C(-1,3) blue; then a small one in flat white
    const big = [[-1, -1, 1, 0, 0], [3, -1, 0, 1, 0], [-1, 3, 0, 0, 1]], small = [[-0.5, -0.5, 1, 1, 1], [0.5, -0.5, 1, 1, 1], [0, 0.5, 1, 1, 1]];
    const vb = G.put(new Float32Array([...big, ...small].flat()));
    G.begin(); G.targets(cmd, [e.wtex[i]]); G.defaultStates(cmd); G.clear(cmd, [0, 0, 0, 1]);
    G.vertexLayout(cmd, [{ format: FMT.RG32F, offset: 0 }, { format: FMT.RGB32F, offset: 8 }], [{ stride: 20 }]);
    G.c("CommandBufferBindVertexBuffer", [cmd, 0, vb, 6 * 20]); G.c("CommandBufferBindProgram", [cmd, prog, 3]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]);
    G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]);
    e.finish(i);
    let img = await e.read();
    for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63], [10, 50], [32, 32], [45, 7]]) {
      const nx = (x + 0.5) / 64 * 2 - 1, ny = 1 - (y + 0.5) / 64 * 2, wb = (nx + 1) / 4, wc = (ny + 1) / 4, wa = 1 - wb - wc;
      t.px(img, x, y, [b8(wa), b8(wb), b8(wc), 255], "interpolated colour", 2);
    }
    const j = G.acquire(e.win);
    G.begin(); G.targets(cmd, [e.wtex[j]]); G.clear(cmd, [0, 0, 1, 1]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 3, 3]); e.finish(j);
    img = await e.read();
    t.px(img, 32, 32, [255, 255, 255, 255], "inside the small triangle"); t.px(img, 32, 40, [255, 255, 255, 255], "inside, lower");
    for (const [x, y] of [[2, 2], [61, 2], [2, 61], [61, 61], [32, 12], [14, 30], [50, 30]]) t.px(img, x, y, BLUE, "outside the small triangle");
    t.eq(e.stat(1), 2, "draws"); t.ok(e.host.stats.pipelinesSync === 1, "the first use built its pipeline synchronously"); t.noRed(e);
  } },

  { name: "indexed textured quad, nearest and linear sampling", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await e.program("vs_quad", "fs_tex");
    const texels = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];      // 2x2: red green / blue white
    const nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST), linear = G.sampId(FILTER.LINEAR, FILTER.LINEAR);
    let i = G.acquire(e.win);
    G.begin();
    const tx = upload(e, cmd, 2, 2, FMT.RGBA8, texels.flat());
    e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); e.bindTexture(cmd, tx.id, nearest); e.drawQuad(cmd); e.finish(i);
    let img = await e.read();
    t.rect(img, 0, 0, 32, 32, texels[0], "nearest, top left"); t.rect(img, 32, 0, 64, 32, texels[1], "nearest, top right");
    t.rect(img, 0, 32, 32, 64, texels[2], "nearest, bottom left"); t.rect(img, 32, 32, 64, 64, texels[3], "nearest, bottom right");
    i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); e.bindTexture(cmd, tx.id, linear); e.drawQuad(cmd); e.finish(i);
    img = await e.read();
    const tap = (v: number) => { const s = v * 2 - 0.5, i0 = Math.floor(s), f = s - i0, c = (k: number) => Math.min(1, Math.max(0, k)); return [c(i0), c(i0 + 1), f]; };
    for (let y = 1; y < 64; y += 6) for (let x = 2; x < 64; x += 5) {
      const [x0, x1, fx] = tap((x + 0.5) / 64), [y0, y1, fy] = tap((y + 0.5) / 64);
      const want = [0, 1, 2, 3].map(c => Math.round((texels[y0 * 2 + x0][c] * (1 - fx) + texels[y0 * 2 + x1][c] * fx) * (1 - fy) + (texels[y1 * 2 + x0][c] * (1 - fx) + texels[y1 * 2 + x1][c] * fx) * fy));
      t.px(img, x, y, want, "bilinear", 3);
    }
    t.eq(e.g.x.gfx_pipeline_count(), 1, "both frames use one pipeline"); t.noRed(e);
  } },

  { name: "uniform buffer animation over 3 frames, then UpdateUniformBuffer and CopyBufferToBuffer between draws", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await uboProgram(e), vsU = ubo(e, [0.5, 0.5, 0, 0, 0, 0, 0, 0]), fsU = ubo(e, [0, 0, 0, 1]);
    const frames = [{ ox: -0.5, c: [1, 0, 0, 1] }, { ox: 0, c: [0, 1, 0, 1] }, { ox: 0.5, c: [0.2, 0.4, 0.6, 1] }];
    const f32 = () => new Float32Array(e.g.memory.buffer);
    for (const f of frames) {
      f32()[vsU / 4 + 2] = f.ox; f32().set(f.c, fsU / 4);       // the game writes its uniform memory, then records and submits
      const i = G.acquire(e.win);
      G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); bindUbos(e, cmd, vsU, fsU); e.drawQuad(cmd); e.finish(i);
      const img = await e.read(), x0 = Math.round((f.ox - 0.5 + 1) * 32), x1 = Math.round((f.ox + 0.5 + 1) * 32);
      t.rect(img, x0, 16, x1, 48, rgba8(f.c), `quad at offset ${f.ox}`);
      if (x0 > 0) t.rect(img, 0, 0, x0, 64, [0, 0, 0, 255], "left of the quad"); if (x1 < 64) t.rect(img, x1, 0, 64, 64, [0, 0, 0, 255], "right of the quad");
      t.rect(img, 0, 0, 64, 16, [0, 0, 0, 255], "above"); t.rect(img, 0, 48, 64, 64, [0, 0, 0, 255], "below");
    }
    t.eq(e.g.x.gfx_pipeline_count(), 1, "one pipeline for the three frames");
    // frame 4: two draws from the same uniform memory, changed in between by commands (data captured at record time)
    f32()[vsU / 4 + 2] = -0.5; f32().set([1, 0, 0, 1], fsU / 4);
    const green = ubo(e, [0, 1, 0, 1]), i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); bindUbos(e, cmd, vsU, fsU); e.drawQuad(cmd);
    const upd = e.g.f32([0.5, 0.5, 0.5, 0]);
    G.c("CommandBufferUpdateUniformBuffer", [cmd, vsU, 32, 0, 16, upd]);
    new Float32Array(e.g.memory.buffer, upd, 4).fill(9);        // the caller may reuse its data once recorded
    G.c("CommandBufferCopyBufferToBuffer", [cmd, green, fsU, 16, 0]);
    e.drawQuad(cmd); e.finish(i);
    const img = await e.read();
    t.rect(img, 0, 16, 32, 48, RED, "first draw: the memory as it was"); t.rect(img, 32, 16, 64, 48, GREEN, "second draw: after UpdateUniformBuffer and CopyBufferToBuffer");
    t.eq(Array.from(new Float32Array(e.g.memory.buffer, fsU, 4)), [0, 1, 0, 1], "the copy landed in guest memory");
    t.eq(e.stat(0), 4, "the writes did not split the pass: one pass a frame"); t.noRed(e);
  } },

  ...[["DEPTH32F", FMT.DEPTH32F], ["DEPTH24_STENCIL8", FMT.DEPTH24_STENCIL8], ["DEPTH16", FMT.DEPTH16]].map(([fname, format]): Scene => ({ name: `depth test (${fname})`, async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await uboProgram(e), depth = G.texture({ w: 64, h: 64, format: format as number });
    const near = ubo(e, [1, 1, 0, 0, 0.3, 0, 0, 0]), far = ubo(e, [1, 1, 0, 0, 0.7, 0, 0, 0]), red = ubo(e, [1, 0, 0, 1]), green = ubo(e, [0, 1, 0, 1]), blue = ubo(e, [0, 0, 1, 1]);
    const i = G.acquire(e.win);
    G.begin();
    const st = e.frame(cmd, e.wtex[i], prog, depth);
    G.c("DepthStencilStateSetDepthTestEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthWriteEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthFunc", [st.ds, DEPTH_FUNC.LESS]);
    G.c("CommandBufferBindDepthStencilState", [cmd, st.ds]);
    G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0], [1.0]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 48, 64]); bindUbos(e, cmd, near, red); e.drawQuad(cmd);           // near, the left three quarters
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); bindUbos(e, cmd, far, green); e.drawQuad(cmd);          // far, everywhere: hidden behind the near one
    // a scissored depth clear inside the pass (drawn as a triangle), then far again in blue: it passes only there
    G.c("CommandBufferSetScissor", [cmd, 8, 8, 16, 16]); G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0], [1.0]); G.c("CommandBufferSetScissor", [cmd, 0, 0, 64, 64]);
    bindUbos(e, cmd, far, blue); G.c("DepthStencilStateSetDepthFunc", [st.ds, DEPTH_FUNC.LESS]); e.drawQuad(cmd);
    e.finish(i);
    const img = await e.read();
    t.rect(img, 8, 8, 24, 24, BLUE, "where depth was cleared again, the far quad passes");
    t.rect(img, 0, 24, 48, 64, RED, "near wins"); t.rect(img, 24, 0, 48, 8, RED, "near wins"); t.rect(img, 48, 0, 64, 64, GREEN, "far, where nothing is nearer");
    t.eq([e.stat(0), e.stat(4)], [1, 1], "one pass, one clear drawn as a triangle"); t.noRed(e);
  } })),

  { name: "alpha blending", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await uboProgram(e), i = G.acquire(e.win);
    G.begin();
    const st = e.frame(cmd, e.wtex[i], prog);
    G.c("BlendStateSetBlendFunc", [st.bl, BLEND.SRC_ALPHA, BLEND.ONE_MINUS_SRC_ALPHA, BLEND.SRC_ALPHA, BLEND.ONE_MINUS_SRC_ALPHA]); G.c("CommandBufferBindBlendState", [cmd, st.bl]);
    G.c("ColorStateSetBlendEnable", [st.co, 0, 1]); G.c("CommandBufferBindColorState", [cmd, st.co]);
    G.clear(cmd, [0, 0, 1, 1]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 64]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 0, 0, 0.5])); e.drawQuad(cmd);
    e.finish(i);
    const img = await e.read();
    t.rect(img, 0, 0, 32, 64, [128, 0, 128, 191], "src * 0.5 + dst * 0.5; alpha 0.5 * 0.5 + 1 * 0.5", 1); t.rect(img, 32, 0, 64, 64, BLUE, "not drawn");
    // the same draw with blending off in the colour state: another pipeline, the source replaces
    const j = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[j], prog); G.clear(cmd, [0, 0, 1, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 0, 0, 0.5])); e.drawQuad(cmd); e.finish(j);
    t.rect(await e.read(), 0, 0, 64, 64, [255, 0, 0, 128], "no blending");
    t.eq(e.g.x.gfx_pipeline_count(), 2, "blend state is part of the pipeline key"); t.noRed(e);
  } },

  { name: "scissored partial clear inside a pass, and a masked clear", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await uboProgram(e), i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0.5, 0.5, 0.5, 1]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 16]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 0, 0, 1])); e.drawQuad(cmd);         // opens the pass: a red band at the top
    G.c("CommandBufferSetScissor", [cmd, 8, 8, 16, 24]); G.clear(cmd, [0, 1, 0, 1]);                                                       // partial: inside the pass
    G.c("CommandBufferSetScissor", [cmd, 0, 0, 64, 64]); G.clear(cmd, [0, 0, 1, 0], 0, 0x4);                                               // blue channel only, everywhere
    G.c("CommandBufferSetViewport", [cmd, 0, 48, 64, 16]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 1, 1, 1])); e.drawQuad(cmd);         // state after the clears is the game's again
    e.finish(i);
    const img = await e.read();
    t.rect(img, 8, 8, 24, 32, [0, 255, 255, 255], "the scissored clear, then blue added"); t.rect(img, 0, 0, 8, 16, [255, 0, 255, 255], "the band"); t.rect(img, 24, 0, 64, 16, [255, 0, 255, 255], "the band");
    t.rect(img, 0, 32, 64, 48, [128, 128, 255, 255], "grey with blue set"); t.rect(img, 24, 16, 64, 32, [128, 128, 255, 255], "grey with blue set"); t.rect(img, 0, 48, 64, 64, [255, 255, 255, 255], "the last draw");
    t.eq([e.stat(0), e.stat(4), e.stat(1)], [1, 2, 2], "one pass, two clears drawn as triangles, two draws"); t.eq(e.host.stats.passes, 1, "replayer passes"); t.noRed(e);
  } },

  { name: "full clear mid-pass", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await uboProgram(e), i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [1, 0, 0, 1]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 64]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [0, 0, 1, 1])); e.drawQuad(cmd);      // left half blue
    G.clear(cmd, [0, 1, 0, 1]);                                                                                                         // ends the pass; load action of the next
    G.c("CommandBufferSetViewport", [cmd, 32, 0, 32, 64]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 1, 0, 1])); e.drawQuad(cmd);     // right half yellow
    e.finish(i);
    const img = await e.read();
    t.rect(img, 0, 0, 32, 64, GREEN, "the mid-pass clear replaced the first draw"); t.rect(img, 32, 0, 64, 64, YELLOW, "drawn after the clear");
    t.eq([e.stat(0), e.stat(4)], [2, 0], "two passes, no triangle clear"); t.noRed(e);
  } },

  { name: "render to texture, then sample it (and SetRenderTargets with the same targets continues the pass)", async run(e, t) {
    const G = e.G, cmd = G.cmd, uprog = await uboProgram(e), tprog = await e.program("vs_quad", "fs_tex"), i = G.acquire(e.win);
    const off = G.texture({ w: 32, h: 32, format: FMT.RGBA8 }), offId = G.texId(off), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    G.begin(); e.frame(cmd, off, uprog); G.clear(cmd, [0, 0, 1, 1]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 16, 32]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 0, 0, 1])); e.drawQuad(cmd);          // offscreen: left red, right blue
    G.targets(cmd, [off]);                                                                                                               // the same targets again
    G.c("CommandBufferSetViewport", [cmd, 16, 16, 16, 16]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [0, 1, 0, 1])); e.drawQuad(cmd);      // bottom right green
    e.frame(cmd, e.wtex[i], tprog); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); e.bindTexture(cmd, offId, nearest); e.drawQuad(cmd);
    e.finish(i);
    const img = await e.read();
    t.rect(img, 0, 0, 32, 64, RED, "left"); t.rect(img, 32, 0, 64, 32, BLUE, "top right"); t.rect(img, 32, 32, 64, 64, GREEN, "bottom right");
    const o = await e.read(e.serial(off));
    t.eq([o.width, o.px(0, 0), o.px(31, 0), o.px(31, 31)], [32, RED, BLUE, GREEN], "the offscreen texture itself");
    t.eq([e.stat(0), e.stat(3)], [2, 0], "two passes (the repeated SetRenderTargets did not end the first), no snapshot"); t.noRed(e);
  } },

  { name: "a draw that samples its own target (snapshot path)", async run(e, t) {
    const G = e.G, cmd = G.cmd, uprog = await uboProgram(e), iprog = await e.program("vs_quad", "fs_tex_invert"), i = G.acquire(e.win);
    const selfId = G.texId(e.wtex[i]), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    G.begin(); e.frame(cmd, e.wtex[i], uprog); G.clear(cmd, [0, 0, 1, 1]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 64]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 0, 0, 1])); e.drawQuad(cmd);          // left red, right blue
    // now invert the top half in place: the fragment shader samples the texture it is drawing into
    G.c("CommandBufferBindProgram", [cmd, iprog, 3]); e.bindTexture(cmd, selfId, nearest); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); G.c("CommandBufferSetScissor", [cmd, 0, 0, 64, 32]);
    e.drawQuad(cmd);
    G.c("CommandBufferSetScissor", [cmd, 0, 48, 64, 16]); e.drawQuad(cmd);            // again in the same pass: reads the same copy, no new one
    e.finish(i);
    const img = await e.read();
    t.rect(img, 0, 0, 32, 32, [0, 255, 255, 255], "top left: red inverted"); t.rect(img, 32, 0, 64, 32, [255, 255, 0, 255], "top right: blue inverted");
    t.rect(img, 0, 32, 32, 48, RED, "untouched"); t.rect(img, 32, 32, 64, 48, BLUE, "untouched");
    t.rect(img, 0, 48, 32, 64, [0, 255, 255, 255], "bottom band: inverted from the copy"); t.rect(img, 32, 48, 64, 64, [255, 255, 0, 255], "bottom band");
    t.eq([e.stat(3), e.stat(0), e.host.stats.snapshots], [1, 2, 1], "one snapshot, the pass ended and reopened once"); t.noRed(e);
  } },

  { name: "pass edges: a texture copy mid-pass, partial clears and self-sampling draws with no pass open, an empty submission", async run(e, t) {
    const G = e.G, cmd = G.cmd, tprog = await e.program("vs_quad", "fs_tex"), iprog = await e.program("vs_quad", "fs_tex_invert"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    G.begin(); G.submit([G.end()]);                                                    // nothing at all: no targets yet
    t.eq([e.stat(0), e.g.x.gfx_pass_state()], [0, 0], "no pass, still Unset");
    let i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], tprog); G.clear(cmd, [0, 0, 0, 1]);
    G.c("CommandBufferSetScissor", [cmd, 0, 0, 32, 32]); G.clear(cmd, [1, 0, 0, 1]);    // a partial clear while the full one is pending: opens the pass with it
    const tx = upload(e, cmd, 1, 1, FMT.RGBA8, [10, 200, 90, 255]);                    // a copy in the middle: the pass ends
    G.c("CommandBufferSetScissor", [cmd, 32, 32, 32, 32]); G.clear(cmd, [0, 1, 0, 1]);  // a partial clear with no pass open: opens one that loads
    G.c("CommandBufferSetScissor", [cmd, 0, 0, 64, 64]); G.c("CommandBufferSetViewport", [cmd, 32, 0, 32, 32]); e.bindTexture(cmd, tx.id, nearest); e.drawQuad(cmd);
    e.finish(i);
    let img = await e.read();
    t.rect(img, 0, 0, 32, 32, RED, "first partial clear"); t.rect(img, 32, 32, 64, 64, GREEN, "second partial clear, after the copy"); t.rect(img, 32, 0, 64, 32, [10, 200, 90, 255], "the texture uploaded mid-pass");
    t.rect(img, 0, 32, 32, 64, [0, 0, 0, 255], "the full clear"); t.eq([e.stat(0), e.stat(4)], [2, 2], "two passes around the copy, two clears as triangles");
    // a full clear pending, then a draw that samples the target it clears: the clear lands first, the draw reads it
    i = G.acquire(e.win);
    const selfId = G.texId(e.wtex[i]);
    G.begin(); e.frame(cmd, e.wtex[i], iprog); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); G.clear(cmd, [0, 0, 1, 1]); e.bindTexture(cmd, selfId, nearest); e.drawQuad(cmd);
    const h = G.end(); G.submit([h]);
    // and with neither pass nor clear: the next submission starts with such a draw (a barrier asked for a fresh copy)
    G.begin(); G.c("CommandBufferBarrier", [cmd, 0x10]); G.c("CommandBufferSetScissor", [cmd, 0, 0, 32, 64]); e.drawQuad(cmd); const h2 = G.end(); G.submit([h2]);
    G.present(e.win, i);
    img = await e.read();
    t.rect(img, 0, 0, 32, 64, BLUE, "inverted twice"); t.rect(img, 32, 0, 64, 64, YELLOW, "blue, inverted once");
    t.eq(e.stat(3), 2, "two snapshots"); t.noRed(e);
  } },

  { name: "two command buffers with a CALL", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await uboProgram(e), i = G.acquire(e.win);
    const sub = G.commandBuffer(G.cmdPool, 0x80000, 0x10000);
    G.begin(sub);            // a prerecorded list: draws the right half yellow with whatever targets and program the caller has
    G.c("CommandBufferSetViewport", [sub, 32, 0, 32, 64]); bindUbos(e, sub, ubo(e, IDENT), ubo(e, [1, 1, 0, 1])); e.drawQuad(sub);
    const hSub = G.end(sub);
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 32]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 0, 0, 1])); e.drawQuad(cmd);
    G.c("CommandBufferCallCommands", [cmd, 1, e.g.u64([hSub])]);
    G.c("CommandBufferSetViewport", [cmd, 0, 32, 32, 32]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [0, 1, 0, 1])); e.drawQuad(cmd);     // the walk came back after the CALL
    e.finish(i);                 // only the caller's handle is submitted
    const img = await e.read();
    t.rect(img, 0, 0, 32, 32, RED, "caller, before the CALL"); t.rect(img, 32, 0, 64, 64, YELLOW, "the called list"); t.rect(img, 0, 32, 32, 64, GREEN, "caller, after the CALL");
    t.eq([e.stat(0), e.stat(1)], [1, 3], "one pass, three draws"); t.noRed(e);
  } },

  { name: "copy buffer to texture and texture to texture; mip levels and array layers", async run(e, t) {
    const G = e.G, cmd = G.cmd;
    const pattern = Array.from({ length: 16 }, (_, k) => [k * 16, 255 - k * 16, (k * 37) & 255, 255]), i = G.acquire(e.win);
    G.begin();
    const a = upload(e, cmd, 4, 4, FMT.RGBA8, pattern.flat()), b = G.texture({ w: 4, h: 4, format: FMT.RGBA8 }), c = G.texture({ w: 8, h: 8, format: FMT.RGBA8 });
    G.targets(cmd, [b]); G.clear(cmd, [0, 0, 0, 0]); G.targets(cmd, [c]); G.clear(cmd, [0, 0, 0, 0]);
    G.c("CommandBufferCopyTextureToTexture", [cmd, a.tex, 0, REGION(e, 1, 1, 0, 2, 2), b, 0, REGION(e, 0, 2, 0, 2, 2), 0]);               // a 2x2 block, moved
    G.c("CommandBufferCopyTextureToTexture", [cmd, a.tex, 0, REGION(e, 0, 0, 0, 4, 4), c, 0, REGION(e, 0, 0, 0, 8, 8), 0]);               // scaled: 4x4 to 8x8, nearest
    // a 2-layer, 2-level array texture: layer 1 of level 0 and layer 0 of level 1 from memory (row stride 16: padded rows), level 1 of layer 1 by a clear through a view
    const arr = G.texture({ w: 4, h: 4, format: FMT.RG8, target: TARGET.T2D_ARRAY, depth: 2, levels: 2 });
    const l0 = Array.from({ length: 16 }, (_, k) => [k, 100 + k]), rows = new Uint8Array(4 * 16);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) rows.set(l0[y * 4 + x], y * 16 + x * 2);
    G.c("CommandBufferSetCopyRowStride", [cmd, 16]);
    G.c("CommandBufferCopyBufferToTexture", [cmd, G.put(rows), arr, 0, REGION(e, 0, 0, 1, 4, 4), 0]);
    G.c("CommandBufferSetCopyRowStride", [cmd, 0]);
    G.c("CommandBufferCopyBufferToTexture", [cmd, G.put([1, 2, 3, 4, 5, 6, 7, 8]), arr, G.view({ level: 1 }), REGION(e, 0, 0, 0, 2, 2), 0]);
    G.targets(cmd, [arr], 0, [G.view({ level: 1, layer: 1 })]); G.clear(cmd, [1, 0.5, 0, 0]);
    G.targets(cmd, [e.wtex[i]]); G.clear(cmd, [0, 0, 0, 1]);
    e.finish(i);
    const ra = await e.read(e.serial(a.tex)), rb = await e.read(e.serial(b)), rc = await e.read(e.serial(c));
    for (let k = 0; k < 16; k++) t.px(ra, k % 4, k >> 2, pattern[k], "uploaded", 0);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) t.px(rb, x, y, x < 2 && y >= 2 ? pattern[(y - 2 + 1) * 4 + x + 1] : [0, 0, 0, 0], "sub-rectangle copy", 0);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) t.px(rc, x, y, pattern[(y >> 1) * 4 + (x >> 1)], "scaled copy", 0);
    const s = e.serial(arr), a01 = await e.read(s, 0, 1), a10 = await e.read(s, 1, 0), a11 = await e.read(s, 1, 1);
    for (let k = 0; k < 16; k++) t.px(a01, k % 4, k >> 2, l0[k], "array layer 1, level 0, strided rows", 0);
    t.eq([a10.width, a10.px(0, 0), a10.px(1, 0), a10.px(0, 1), a10.px(1, 1)], [2, [1, 2], [3, 4], [5, 6], [7, 8]], "level 1 of layer 0");
    t.eq([a11.px(0, 0), a11.px(1, 1)], [[255, 128], [255, 128]], "level 1 of layer 1, cleared as a render target through a view");
    t.eq(G.c("TextureGetViewOffset", [arr, G.view({ level: 1 })]) > 0, true, "the level has an offset in the texture's storage"); t.noRed(e);
  } },

  { name: "BC1 texture sampling (and BC2, BC3, BC4, BC5, BC7 blocks)", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await e.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    const c565 = (r: number, g: number, b: number) => (r << 11) | (g << 5) | b, x5 = (v: number) => (v << 3) | (v >> 2), x6 = (v: number) => (v << 2) | (v >> 4);
    const solid = (c: number) => [c & 255, c >> 8, c & 255, c >> 8, 0, 0, 0, 0];           // both endpoints the colour, every index 0
    // BC1 8x8, four blocks: red, green / blue, and one with two colours (left two columns colour 0, right two colour 1)
    const two = [c565(31, 63, 31) & 255, c565(31, 63, 31) >> 8, 0, 0, 0x50, 0x50, 0x50, 0x50];   // white > black: 4-colour mode; index 0 0 1 1 a row
    const bc1 = [...solid(c565(31, 0, 0)), ...solid(c565(0, 63, 0)), ...solid(c565(0, 0, 31)), ...two];
    let i = G.acquire(e.win);
    G.begin();
    const tx = upload(e, cmd, 8, 8, FMT.BC1, bc1);
    e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); e.bindTexture(cmd, tx.id, nearest); e.drawQuad(cmd); e.finish(i);
    let img = await e.read();
    t.rect(img, 0, 0, 32, 32, RED, "BC1 red block"); t.rect(img, 32, 0, 64, 32, GREEN, "BC1 green block"); t.rect(img, 0, 32, 32, 64, BLUE, "BC1 blue block");
    t.rect(img, 32, 32, 48, 64, [255, 255, 255, 255], "BC1 two-colour block, colour 0"); t.rect(img, 48, 32, 64, 64, [0, 0, 0, 255], "BC1 two-colour block, colour 1");
    // one 4x4 block each of the other formats, a known colour
    const col = solid(c565(10, 40, 20)), rgb = [x5(10), x6(40), x5(20)];
    const bc7 = (() => {            // mode 6: 7-bit endpoints + a p bit, 4-bit indices all 0: the colour is endpoint 0
      const out = new Uint8Array(16); let bit = 0;
      const put = (v: number, n: number) => { for (let k = 0; k < n; k++, bit++) if ((v >> k) & 1) out[bit >> 3] |= 1 << (bit & 7); };
      put(0x40, 7); for (const v of [100, 50, 25, 127]) { put(v, 7); put(v, 7); } put(1, 1); put(1, 1);
      return Array.from(out);
    })();
    const cases: [string, number, number[], number[]][] = [
      ["BC2", 0x43, [0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, ...col], [...rgb, 0x77]],
      ["BC3", FMT.BC3, [200, 200, 0, 0, 0, 0, 0, 0, ...col], [...rgb, 200]],
      ["BC4", 0x49, [90, 90, 0, 0, 0, 0, 0, 0], [90, 0, 0, 255]],
      ["BC5", 0x4b, [90, 90, 0, 0, 0, 0, 0, 0, 180, 180, 0, 0, 0, 0, 0, 0], [90, 180, 0, 255]],
      ["BC7", FMT.BC7, bc7, [201, 101, 51, 255]],
    ];
    for (const [name, format, block, want] of cases) {
      i = G.acquire(e.win);
      G.begin();
      const u = upload(e, cmd, 4, 4, format, block);
      e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 0]); e.bindTexture(cmd, u.id, nearest); e.drawQuad(cmd); e.finish(i);
      img = await e.read();
      t.rect(img, 0, 0, 64, 64, want, `${name} block`, 1);
    }
    t.noRed(e);
  } },

  { name: "common colour formats as render targets", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await e.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    const srgb = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055, q = (v: number, bits: number) => Math.round(v * (2 ** bits - 1)) / (2 ** bits - 1);
    const c = [0.5, 0.25, 1, 1];
    // format, what a clear to c stores as raw bytes (first pixel), what sampling it gives back in an RGBA8 target
    const cases: [string, number, number[] | null, number[]][] = [
      ["RGBA8", FMT.RGBA8, [128, 64, 255, 255], [128, 64, 255, 255]], ["RGBA8_SRGB", FMT.RGBA8_SRGB, [b8(srgb(0.5)), b8(srgb(0.25)), 255, 255], [128, 64, 255, 255]],
      ["BGRA8", FMT.BGRA8, [255, 64, 128, 255], [128, 64, 255, 255]], ["R8", FMT.R8, [128], [128, 0, 0, 255]], ["RG8", FMT.RG8, [128, 64], [128, 64, 0, 255]],
      ["RGBA16F", FMT.RGBA16F, [0x00, 0x38, 0x00, 0x34, 0x00, 0x3c, 0x00, 0x3c], [128, 64, 255, 255]],
      ["RGB10A2", FMT.RGB10A2, null, [b8(q(0.5, 10)), b8(q(0.25, 10)), 255, 255]], ["R11G11B10F", FMT.R11G11B10F, null, [128, 64, 255, 255]],
    ];
    for (const [name, format, raw, want] of cases) {
      const tex = G.texture({ w: 8, h: 8, format }), id = G.texId(tex), i = G.acquire(e.win);
      G.begin(); G.targets(cmd, [tex]); G.clear(cmd, c);
      e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 0]); e.bindTexture(cmd, id, nearest); e.drawQuad(cmd); e.finish(i);
      t.rect(await e.read(), 0, 0, 64, 64, want, `${name} sampled`, 1);
      if (raw) t.px(await e.read(e.serial(tex)), 3, 3, raw, `${name} stored`, 1);
    }
    t.noRed(e);
  } },

  { name: "a missing shader key: the draw is skipped with a red line, nothing breaks", async run(e, t) {
    const G = e.G, cmd = G.cmd, good = await uboProgram(e), i = G.acquire(e.win);
    const vs = await e.blobs("vs_never_translated"), fs = await e.shader("fs_ubo");
    const prog = G.program([vs, fs]);
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0.25, 0.25, 0.25, 1]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [1, 0, 0, 1]));
    e.drawQuad(cmd); e.drawQuad(cmd);
    G.c("CommandBufferBindProgram", [cmd, good, 3]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 16, 16]); e.drawQuad(cmd);            // the frame goes on
    e.finish(i);
    const img = await e.read();
    t.rect(img, 16, 0, 64, 64, [64, 64, 64, 255], "only the clear"); t.rect(img, 0, 0, 16, 16, RED, "the draw with a translated program");
    t.eq(e.g.red(), [`[RED] shader ${vs.key} is not in the shader map`], "one red line for the key, however many draws");
    t.eq([e.stat(1), e.stat(2)], [1, 2], "one draw issued, two skipped"); t.eq(e.host.stats.errors, 0, "WebGPU errors");
    // the translation arrives (the library is filled in later): the same program draws
    e.host.registerShader(vs.key, { entry: "main", ...SHADERS.vs_quad_ubo });
    const j = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[j], prog); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [0, 1, 0, 1])); e.drawQuad(cmd); e.finish(j);
    t.rect(await e.read(), 0, 0, 64, 64, GREEN, "drawn once the key is in the library"); t.eq(e.g.red().length, 1, "no further red line");
  } },

  { name: "command memory exhaustion with a callback", cmdBytes: 1 << 20, async run(e, t) {
    const G = e.G, prog = await uboProgram(e), i = G.acquire(e.win), asked: number[] = [];
    // a command buffer with 1 KB of command memory; its callback hands out 2 KB blocks, as a game's does
    const cmd = G.commandBuffer(G.cmdPool, 0x40000, 1024);
    let next = 0x40000 + 1024;
    G.c("CommandBufferSetMemoryCallback", [cmd, e.g.fn((c, ev, size, data) => {
      t.eq([Number(c), Number(ev), Number(data)], [cmd, 0, 0xC0FFEE], "callback arguments: the command buffer, OUT_OF_COMMAND_MEMORY, the callback data");
      asked.push(Number(size)); G.c("CommandBufferAddCommandMemory", [cmd, G.cmdPool.obj, next, 2048]); next += 2048;
    })]);
    G.c("CommandBufferSetMemoryCallbackData", [cmd, 0xC0FFEE]);
    G.begin(cmd); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]);
    // 64 cells of 8x8, each its own viewport (a 400-byte record), uniform binds and draw
    const colour = (k: number) => [(k % 8) / 7, (k >> 3) / 7, 0.5, 1];
    for (let k = 0; k < 64; k++) { G.c("CommandBufferSetViewport", [cmd, (k % 8) * 8, (k >> 3) * 8, 8, 8]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, colour(k))); e.drawQuad(cmd); }
    e.finish(i, cmd);
    const img = await e.read();
    for (let k = 0; k < 64; k++) t.rect(img, (k % 8) * 8, (k >> 3) * 8, (k % 8) * 8 + 8, (k >> 3) * 8 + 8, rgba8(colour(k)), `cell ${k}`);
    t.ok(asked.length >= 14, `the callback was asked ${asked.length} times`); t.ok(asked.every(n => n >= 24 + 16 && n <= 400 + 16 + 8), `asked for ${[...new Set(asked)]} bytes`);
    t.eq([e.stat(1), e.stat(0), e.stat(7)], [64, 1, 0], "64 draws across the linked segments in one pass, no host-lent segment"); t.noRed(e);
  } },

  { name: "pipeline cache: built once, Ready after the asynchronous build; a pipeline that cannot be built fails and its draws are skipped", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await uboProgram(e);
    const frame = (p: number, c: number[]) => { const i = G.acquire(e.win); G.begin(); e.frame(cmd, e.wtex[i], p); G.clear(cmd, [0, 0, 0, 1]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, c)); e.drawQuad(cmd); e.finish(i); };
    frame(prog, [1, 0, 0, 1]);
    t.eq([e.g.x.gfx_pipeline_count(), e.host.stats.pipelinesSync, e.host.stats.pipelinesAsync], [1, 1, 0], "first use: requested, built synchronously for the draw");
    const id = [...Array(2048).keys()].find(k => e.g.x.gfx_pipeline_state(k) >= 0)!;
    t.eq(e.g.x.gfx_pipeline_state(id), 1, "Building until the asynchronous build reports");
    t.rect(await e.read(), 0, 0, 64, 64, RED, "frame 1"); await e.settle();
    t.eq([e.g.x.gfx_pipeline_state(id), e.host.stats.pipelinesAsync], [2, 1], "Ready");
    frame(prog, [0, 1, 0, 1]); t.rect(await e.read(), 0, 0, 64, 64, GREEN, "frame 2");
    t.eq([e.g.x.gfx_pipeline_count(), e.host.stats.pipelinesSync], [1, 1], "the same key: nothing new"); t.noRed(e);
    // a vertex shader whose inputs do not match the vertex layout: WebGPU refuses the pipeline
    const bad = await e.program("vs_bad", "fs_ubo");
    frame(bad, [0, 0, 1, 1]); await e.settle();
    const bid = [...Array(2048).keys()].find(k => k !== id && e.g.x.gfx_pipeline_state(k) >= 0)!;
    t.eq(e.g.x.gfx_pipeline_state(bid), 3, "Failed"); t.ok(e.g.red().some(l => l.includes(`pipeline ${bid} did not build`)), "the replayer reported why"); t.ok(e.host.stats.errors > 0, "WebGPU reported the frame that used it");
    const before = e.g.red().length, errors = e.host.stats.errors;
    frame(bad, [0, 0, 1, 1]); frame(bad, [0, 0, 1, 1]);
    t.rect(await e.read(), 0, 0, 64, 64, [0, 0, 0, 255], "only the clear: the draw was skipped"); await e.settle();
    t.eq(e.g.red().slice(before), [`[RED] pipeline ${bid} failed to build: its draws are skipped`], "one red line"); t.eq(e.host.stats.errors, errors, "no further WebGPU error");
  } },

  { name: "fences, sync objects and window images", async run(e, t) {
    const G = e.G, cmd = G.cmd, x = e.g.x, sync = e.g.alloc(SIZEOF.SYNC), sync2 = e.g.alloc(SIZEOF.SYNC), async = e.g.alloc(SIZEOF.SYNC);
    for (const s of [sync, sync2, async]) t.eq(G.c("SyncInitialize", [s, G.dev]), 1, "SyncInitialize");
    t.eq(G.c("SyncWait", [sync, 1_000_000_000]), 2, "a sync that was never fenced: TIMEOUT_EXPIRED");
    const i = G.acquire(e.win, async);
    t.eq([i, x.gfx_image_state(e.win, 0), x.gfx_image_state(e.win, 1)], [0, 1, 0], "image 0 Acquired, image 1 Free");
    t.eq(G.c("SyncWait", [async, 0]), 0, "nothing was committed before the acquire: its sync is signaled");
    G.begin(); G.targets(cmd, [e.wtex[i]]); G.clear(cmd, [1, 0, 0, 1]); G.c("CommandBufferFenceSync", [cmd, sync2, 0, 0]); const h = G.end();
    G.submit([h]); G.c("QueueFenceSync", [G.queue, sync, 0, 0]);
    const n2 = x.gfx_sync_fence(sync2), n = x.gfx_sync_fence(sync);
    t.eq([n2, n, x.gfx_fence_last()], [1, 2, 2], "fence numbers in stream order");
    t.eq([G.c("SyncWait", [sync, 0]), G.c("SyncWait", [sync2, 0]), x.gfx_fence_done(n), new DataView(e.g.memory.buffer).getUint32(x.gfx_fence_word(), true)], [2, 2, 0, 0], "not done within the turn: SyncWait returns at once");
    G.present(e.win, i);
    t.eq(x.gfx_image_state(e.win, 0), 3, "presented: Queued");
    await e.settle();
    t.eq([x.gfx_fence_done(n), x.gfx_fence_done(n2), new DataView(e.g.memory.buffer).getUint32(x.gfx_fence_word(), true)], [1, 1, 2], "the GPU finished: the fence word moved");
    t.eq([G.c("SyncWait", [sync, 0]), G.c("SyncWait", [sync2, 0]), G.c("SyncWait", [sync, 0])], [0, 0, 0], "ALREADY_SIGNALED");
    t.eq(x.gfx_image_state(e.win, 0), 4, "OnScreen");
    t.rect(await e.read(), 0, 0, 64, 64, RED, "the frame");
    const j = G.acquire(e.win, async);
    G.begin(); G.targets(cmd, [e.wtex[j]]); G.clear(cmd, [0, 1, 0, 1]); e.finish(j); await e.settle();
    t.eq([j, x.gfx_image_state(e.win, 0), x.gfx_image_state(e.win, 1)], [1, 0, 4], "image 1 OnScreen, image 0 Free again");
    // a game that does not wait: both images in one turn, then the first again while it is still Queued
    const a = G.acquire(e.win), b = (G.begin(), G.targets(cmd, [e.wtex[a]]), G.clear(cmd, [0, 0, 1, 1]), e.finish(a), G.acquire(e.win));
    G.begin(); G.targets(cmd, [e.wtex[b]]); G.clear(cmd, [1, 1, 0, 1]); e.finish(b);
    const c = G.acquire(e.win);
    t.eq([a, b, c, x.gfx_image_state(e.win, 0)], [0, 1, 0, 1], "taken again");
    G.begin(); G.targets(cmd, [e.wtex[c]]); G.clear(cmd, [1, 1, 1, 1]); e.finish(c); await e.settle();
    t.rect(await e.read(), 0, 0, 64, 64, [255, 255, 255, 255], "the last frame");
    G.present(e.win, 1);
    t.ok(e.g.red().at(-1)!.includes("gfx_image") && e.g.red().at(-1)!.includes("refused Present"), "presenting an image that was not acquired is refused, red"); t.eq(e.g.red().length, 1, "and nothing else was"); t.eq(e.host.stats.errors, 0, "WebGPU errors");
    t.eq(x.kit_refused_total(), 1, "the machines refused only that");
  } },
];
