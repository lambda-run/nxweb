// More scenes of `npm run gfx:test` (browser): WebGPU's per-stage binding limits against what an NVN program may
// bind (with the limits the adapter grants, and with limits clamped by the replayer's `limits` option), and
// bindless sampling (texture and sampler handles taken from uniform data at each draw).
import { Env, SHADERS, fsManyUbos, fsManyTextures, fsBindlessSamplerId } from "./env.mts";
import { FMT, STAGE, SIZEOF, FILTER, POOL_FLAGS } from "./nvn.mts";
import { type Scene, T, rgba8, RED, GREEN, BLUE, upload, ubo } from "./scenes.mts";

const BLACK = [0, 0, 0, 255];
const pipeStates = (e: Env) => Array.from({ length: 16384 }, (_, k) => e.g.x.gfx_pipeline_state(k) as number).filter(v => v >= 0).sort();
async function pipesBuilt(e: Env) { for (let k = 0; k < 1000 && pipeStates(e).includes(1); k++) await new Promise(r => setTimeout(r, 10)); await e.settle(); }
const lim = (e: Env, name: string) => e.host.device.limits[name] as number;
// The red line of a pipeline over a limit: what it needs, what the device allows, the WebGPU limit's name, by how much
const overLine = (stage: string, n: number, what: string, max: number, limit: string) => new RegExp(`^\\[RED\\] pipeline \\d+: the ${stage} shader [0-9a-f]{16} needs ${n} ${what}; this WebGPU device allows ${max} a stage \\(${limit}\\): ${n - max} over\\. `);
// colour k of n: one channel each in turn, small enough that n of them add up below 1
const part = (k: number) => [k % 3 === 0 ? 12 : 0, k % 3 === 1 ? 12 : 0, k % 3 === 2 ? 12 : 0, 255];
const partSum = (n: number) => [0, 1, 2].map(c => Array.from({ length: n }, (_, k) => part(k)[c]).reduce((a, b) => a + b, 0)).concat(255);

// One frame: the left half drawn by a fragment shader with nUbo uniform blocks, the right half by one with nTex textures
async function manyBindings(e: Env, t: T, nUbo: number, nTex: number, tag: string): Promise<{ img: any; red: string[] }> {
  const G = e.G, cmd = G.cmd, i = G.acquire(e.win);
  SHADERS[`fs_ubos_${tag}`] = fsManyUbos(nUbo); SHADERS[`fs_texs_${tag}`] = fsManyTextures(nTex);
  const pu = await e.program("vs_quad", `fs_ubos_${tag}`), pt = await e.program("vs_quad", `fs_texs_${tag}`), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
  const blocks = Array.from({ length: nUbo }, (_, k) => ubo(e, part(k).map(v => v / 255)));
  const before = e.g.red().length;
  G.begin();
  const texs = Array.from({ length: nTex }, (_, k) => upload(e, cmd, 1, 1, FMT.RGBA8, part(k)));
  e.frame(cmd, e.wtex[i], pu); G.clear(cmd, [0, 0, 0, 1]);
  for (let k = 0; k < nUbo; k++) G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, k, blocks[k], 16]);
  G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 64]); e.drawQuad(cmd);
  G.c("CommandBufferBindProgram", [cmd, pt, 3]);
  for (let k = 0; k < nTex; k++) e.bindTexture(cmd, texs[k].id, nearest, k);
  G.c("CommandBufferSetViewport", [cmd, 32, 0, 32, 64]); e.drawQuad(cmd);
  e.finish(i);
  const img = await e.read(); await pipesBuilt(e);
  return { img, red: e.g.red().slice(before) };
}

export const scenes3: Scene[] = [
  { name: "binding limits, clamped to 5 uniform buffers and 4 textures a stage: programs at the limits draw; programs over them fail with the limit's name and by how much",
    host: { limits: { maxUniformBuffersPerShaderStage: 5, maxSampledTexturesPerShaderStage: 4, maxSamplersPerShaderStage: 4 } }, async run(e, t) {
    let r = await manyBindings(e, t, 5, 4, "at");
    t.rect(r.img, 0, 0, 32, 64, partSum(5), "5 uniform blocks of 5 allowed, summed", 1); t.rect(r.img, 32, 0, 64, 64, partSum(4), "4 textures of 4 allowed, summed", 1);
    t.eq(r.red, [], "at the limits: no red line"); t.eq(pipeStates(e), [2, 2], "both pipelines Ready");
    r = await manyBindings(e, t, 7, 6, "over");
    t.rect(r.img, 0, 0, 64, 64, BLACK, "over the limits: both draws are skipped");
    t.eq(r.red.length, 3, `three red lines (uniform buffers; sampled textures and samplers): ${r.red.join(" | ")}`);
    t.ok(overLine("fragment", 7, "uniform buffers", 5, "maxUniformBuffersPerShaderStage").test(r.red[0]), `uniform buffers, 2 over: ${r.red[0]}`);
    t.ok(overLine("fragment", 6, "sampled textures", 4, "maxSampledTexturesPerShaderStage").test(r.red[1]), `sampled textures, 2 over: ${r.red[1]}`);
    t.ok(overLine("fragment", 6, "samplers", 4, "maxSamplersPerShaderStage").test(r.red[2]), `samplers, 2 over: ${r.red[2]}`);
    t.eq(pipeStates(e), [2, 2, 3, 3], "those two pipelines are Failed, the first two still Ready");
    t.eq(e.host.stats.errors, 0, "no WebGPU validation error: the replayer refused before WebGPU could");
  } },

  { name: "binding limits, clamped to 2 bind groups: a vertex shader with the position fix-up (a third group) fails by name; one without it draws",
    host: { limits: { maxBindGroups: 2 } }, async run(e, t) {
    const G = e.G, cmd = G.cmd, i = G.acquire(e.win), pf = await e.program("vs_quad_fix", "fs_ubo"), pp = await e.program("vs_quad_ubo", "fs_ubo");
    const vsU = ubo(e, [1, 1, 0, 0, 0, 0, 0, 0]), fsU = ubo(e, [0, 1, 0, 1]);
    G.begin(); e.frame(cmd, e.wtex[i], pf); G.clear(cmd, [0, 0, 0, 1]);
    G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.VERTEX, 0, vsU, 32]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, fsU, 16]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 64]); e.drawQuad(cmd);
    G.c("CommandBufferBindProgram", [cmd, pp, 3]); G.c("CommandBufferSetViewport", [cmd, 32, 0, 32, 64]); e.drawQuad(cmd);
    e.finish(i);
    const img = await e.read(); await pipesBuilt(e);
    t.rect(img, 0, 0, 32, 64, BLACK, "three bind groups of two allowed: skipped"); t.rect(img, 32, 0, 64, 64, GREEN, "two bind groups: drawn");
    const red = e.g.red();
    t.ok(red.length === 1 && /pipeline \d+: its layout needs 3 bind groups; this WebGPU device allows 2 \(maxBindGroups\): 1 over\. /.test(red[0]), `one red line naming maxBindGroups: ${red}`);
    t.eq(pipeStates(e), [2, 3], "one Ready, one Failed"); t.eq(e.host.stats.errors, 0, "no WebGPU validation error");
  } },

  { name: "binding limits of this device: a stage with 14 uniform buffers (more than 12) and one with 17 textures (more than 16) draw where the device allows them, else fail by name", async run(e, t) {
    const maxU = lim(e, "maxUniformBuffersPerShaderStage"), maxT = Math.min(lim(e, "maxSampledTexturesPerShaderStage"), lim(e, "maxSamplersPerShaderStage"));
    const r = await manyBindings(e, t, 14, 17, "dev"), want: RegExp[] = [];
    if (maxU >= 14) t.rect(r.img, 0, 0, 32, 64, partSum(14), "14 uniform blocks in one stage, summed", 1);
    else { t.rect(r.img, 0, 0, 32, 64, BLACK, "14 uniform blocks: skipped on this device"); want.push(overLine("fragment", 14, "uniform buffers", maxU, "maxUniformBuffersPerShaderStage")); }
    if (maxT >= 17) t.rect(r.img, 32, 0, 64, 64, partSum(17), "17 textures in one stage, summed", 1);
    else {
      t.rect(r.img, 32, 0, 64, 64, BLACK, "17 textures: skipped on this device");
      if (lim(e, "maxSampledTexturesPerShaderStage") < 17) want.push(overLine("fragment", 17, "sampled textures", lim(e, "maxSampledTexturesPerShaderStage"), "maxSampledTexturesPerShaderStage"));
      if (lim(e, "maxSamplersPerShaderStage") < 17) want.push(overLine("fragment", 17, "samplers", lim(e, "maxSamplersPerShaderStage"), "maxSamplersPerShaderStage"));
    }
    t.eq(r.red.length, want.length, `red lines: ${r.red.join(" | ")}`);
    want.forEach((re, k) => t.ok(re.test(r.red[k]), `red line ${k}: ${r.red[k]} against ${re}`));
    t.eq(pipeStates(e), [maxU >= 14 ? 2 : 3, maxT >= 17 ? 2 : 3].sort(), "each pipeline Ready or Failed as the device's limits say");
    t.eq(e.host.stats.errors, 0, "no WebGPU validation error either way");
    console.log(`this device grants ${maxU} uniform buffers, ${lim(e, "maxSampledTexturesPerShaderStage")} sampled textures and ${lim(e, "maxSamplersPerShaderStage")} samplers a stage: the 14-block stage ${maxU >= 14 ? "drew" : "was refused by name"}, the 17-texture stage ${maxT >= 17 ? "drew" : "was refused by name"}`);
  } },

  { name: "bindless sampling: texture and sampler handles from uniform data (one word, two words, a constant sampler ID), rewritten between frames and between draws, a second texture pool, a target sampled through a handle, an unreadable handle", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await e.program("vs_quad", "fs_bindless");
    const nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST), linear = G.sampId(FILTER.LINEAR, FILTER.LINEAR);
    const words = G.put(new Uint32Array(8)), sampWords = G.put(new Uint32Array(4)), u32 = () => new Uint32Array(e.g.memory.buffer);
    const setHandles = (tex0: number, samp0: number, tex5: number, samp5: number) => { u32()[(words + 8) / 4] = (tex0 | samp0 << 20) >>> 0; u32()[(words + 16) / 4] = tex5; u32()[(sampWords + 4) / 4] = (samp5 << 20) >>> 0; };
    const MIX = [191, 64, 0, 255];      // texture D (red, green) sampled linearly a quarter of the way from its first texel to its second
    let a = { tex: 0, id: 0 }, b = a, c = a, d = a;
    const start = (i: number, p = prog, pool = G.texPool) => {
      e.frame(cmd, e.wtex[i], p); G.clear(cmd, [0.2, 0.4, 0.6, 1]);
      G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); G.c("CommandBufferSetTexturePool", [cmd, pool]); G.c("CommandBufferSetSamplerPool", [cmd, G.sampPool]);
      G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 2, words, 32]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 3, sampWords, 16]);
    };
    const thirds = (img: any, l: number[], m: number[], r: number[], msg: string, y0 = 0, y1 = 64) => {
      t.rect(img, 0, y0, 20, y1, l, `${msg}: slot 0 (handle in uniform slot 2)`); t.rect(img, 23, y0, 41, y1, m, `${msg}: slot 1 (BindTexture)`); t.rect(img, 44, y0, 64, y1, r, `${msg}: slot 5 (texture word and sampler word)`, 2);
    };
    // 1: A through a one-word handle, B bound, D through a texture word and a sampler word (nearest)
    let i = G.acquire(e.win);
    G.begin();
    a = upload(e, cmd, 1, 1, FMT.RGBA8, RED); b = upload(e, cmd, 1, 1, FMT.RGBA8, GREEN); c = upload(e, cmd, 1, 1, FMT.RGBA8, BLUE); d = upload(e, cmd, 2, 1, FMT.RGBA8, [...RED, ...GREEN]);
    setHandles(a.id, nearest, d.id, nearest);
    start(i); e.bindTexture(cmd, b.id, nearest, 1); e.drawQuad(cmd); e.finish(i);
    thirds(await e.read(), RED, GREEN, RED, "frame 1");
    t.eq(e.stat(16), 2, "two handles were taken from uniform data");
    // 2: the game writes other handles into the same memory; nothing is bound anew except what a frame binds
    i = G.acquire(e.win);
    setHandles(c.id, nearest, d.id, linear);
    G.begin(); start(i); e.bindTexture(cmd, b.id, nearest, 1); e.drawQuad(cmd); e.finish(i);
    thirds(await e.read(), BLUE, GREEN, MIX, "frame 2, handles rewritten in memory");
    // 3: an inline update of the handle word between two draws of one pass: each draw samples what the memory held at its place in the stream
    i = G.acquire(e.win);
    const passes = e.stat(0), upd = e.g.u32([(a.id | nearest << 20) >>> 0]);
    G.begin(); start(i); e.bindTexture(cmd, b.id, nearest, 1);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 32]); e.drawQuad(cmd);
    G.c("CommandBufferUpdateUniformBuffer", [cmd, words, 32, 8, 4, upd]);
    G.c("CommandBufferSetViewport", [cmd, 0, 32, 64, 32]); e.drawQuad(cmd);
    e.finish(i);
    let img = await e.read();
    thirds(img, BLUE, GREEN, MIX, "frame 3, before the inline update", 0, 32); thirds(img, RED, GREEN, MIX, "frame 3, after the inline update", 32, 64);
    t.eq(e.stat(0) - passes, 1, "one pass");
    // 4: a second texture pool: the IDs in the uniform data are that pool's (its numbering base is added when the draw is lowered, as BindTexture's is when recorded)
    const store = G.pool(1 << 20, POOL_FLAGS.CPU_CACHED | POOL_FLAGS.GPU_CACHED), pool2 = e.g.alloc(SIZEOF.TEXTURE_POOL);
    G.c("TexturePoolInitialize", [pool2, store.obj, 0, 1024]);
    G.c("TexturePoolRegisterTexture", [pool2, 300, b.tex, 0]); G.c("TexturePoolRegisterTexture", [pool2, 301, c.tex, 0]); G.c("TexturePoolRegisterTexture", [pool2, 302, d.tex, 0]);
    i = G.acquire(e.win);
    setHandles(300, nearest, 302, nearest);
    G.begin(); start(i, prog, pool2); e.bindTexture(cmd, 301, nearest, 1); e.drawQuad(cmd); e.finish(i);
    thirds(await e.read(), GREEN, BLUE, RED, "frame 4, IDs of a second texture pool");
    // 5: the sampler as a constant ID of the shader (handle type 3), with a handle word whose sampler bits say otherwise
    SHADERS.fs_bindless_id = fsBindlessSamplerId(linear);
    const pid = await e.program("vs_quad", "fs_bindless_id");
    i = G.acquire(e.win);
    setHandles(d.id, nearest, 0, 0);
    G.begin(); start(i, pid); e.drawQuad(cmd); e.finish(i);
    t.rect(await e.read(), 0, 0, 64, 64, MIX, "frame 5, the shader's constant sampler ID (linear) wins over the word's (nearest)", 2);
    // 6: the handle names the render target: found through the uniform data, copied, and the copy sampled (no WebGPU usage conflict)
    i = G.acquire(e.win);
    const self = G.texId(e.wtex[i]), snaps = e.stat(3);
    setHandles(self, nearest, d.id, nearest);
    G.begin(); start(i); e.bindTexture(cmd, b.id, nearest, 1); e.drawQuad(cmd); e.finish(i);
    thirds(await e.read(), rgba8([0.2, 0.4, 0.6, 1]), GREEN, RED, "frame 6, the target's own cleared content through a handle");
    t.eq(e.stat(3) - snaps, 1, "one snapshot of the target");
    t.noRed(e);
    // 7: uniform slot 2 bound shorter than the handle's word: the handle reads 0, no texture (transparent black), said once
    i = G.acquire(e.win);
    setHandles(a.id, nearest, d.id, nearest);
    G.begin(); start(i); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 2, words, 8]); e.bindTexture(cmd, b.id, nearest, 1); e.drawQuad(cmd); e.finish(i);
    img = await e.read();
    t.rect(img, 0, 0, 20, 64, [0, 0, 0, 0], "frame 7: slot 0 reads as empty"); t.rect(img, 23, 0, 41, 64, GREEN, "frame 7: the bound slot is unaffected"); t.rect(img, 44, 0, 64, 64, [0, 0, 0, 0], "frame 7: slot 5 reads as empty");
    const red = e.g.red();
    t.ok(red.length === 1 && /a draw samples texture ID 0 \(stage 1 slot 0\), which names no live texture/.test(red[0]), `one red line: ${red}`);
    t.eq(e.host.stats.errors, 0, "no WebGPU validation error"); t.eq(e.g.x.gfx_pipeline_count(), 2, "two pipelines in all: handles are not part of the key");
  } },
];
