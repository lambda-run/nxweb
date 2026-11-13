// More scenes of `npm run gfx:test` (browser): the embedder interface (waits, hooks), the shader chain's reflection
// record, vertex input classes, WebGPU limits, compute, multisampling, depth and converted texture formats, ASTC,
// the uniform arena, device loss and the frame capture. As in scenes.mts everything is driven through nvn_call and
// checked on pixels (or guest memory) with values computed here.
import { Env, SHADERS, QUAD, fsManyUbos, type Image } from "./env.mts";
import { FMT, PRIM, STAGE, SIZEOF, DEPTH_FUNC, FILTER, TARGET } from "./nvn.mts";
import { type Scene, T, b8, rgba8, RED, GREEN, BLUE, REGION, upload, uboProgram, ubo, bindUbos, IDENT } from "./scenes.mts";
import { GfxHost } from "../../src/glue/gfx_host.ts";

const BLACK = [0, 0, 0, 255];
const ALL = 0xFFFF_FFFF_FFFF_FFFFn;
const newDevice = async () => { const a = await (navigator as any).gpu.requestAdapter(); return a.requestDevice(GfxHost.deviceDescriptor(a)); };
// Texels into one level and layer (or slice) of a texture with CopyBufferToTexture
function fill(e: Env, cmd: number, tex: number, w: number, h: number, bytes: ArrayBufferView | ArrayLike<number>, o: { level?: number; layer?: number; z?: number } = {}) {
  const src = e.G.put(ArrayBuffer.isView(bytes) ? bytes : Uint8Array.from(bytes as ArrayLike<number>));
  e.G.c("CommandBufferCopyBufferToTexture", [cmd, src, tex, o.level !== undefined || o.layer !== undefined ? e.G.view({ level: o.level ?? 0, layer: o.layer ?? 0 }) : 0, REGION(e, 0, 0, o.z ?? 0, w, h), 0]);
}
const solid = (w: number, h: number, c: number[]) => Uint8Array.from({ length: w * h * 4 }, (_, i) => c[i & 3]);
// The states of the pipelines the recorder has (ids are slots of its hash table): 1 Building, 2 Ready, 3 Failed
const pipeStates = (e: Env) => Array.from({ length: 16384 }, (_, k) => e.g.x.gfx_pipeline_state(k) as number).filter(v => v >= 0).sort();
// Waits until no pipeline is still being built (createRenderPipelineAsync takes as long as it takes)
async function pipesBuilt(e: Env) { for (let k = 0; k < 1000 && pipeStates(e).includes(1); k++) await new Promise(r => setTimeout(r, 10)); await e.settle(); }
const halfToFloat = (h: number) => { const ex = (h >> 10) & 31, m = h & 1023; return (h & 0x8000 ? -1 : 1) * (ex === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (ex - 15)); };

export const scenes2: Scene[] = [
  { name: "embedder interface: nvnSyncWait with timeout 0, finite and infinite; QueueFinish waits for read-backs; fence and window image hooks", async run(e, t) {
    const G = e.G, cmd = G.cmd, x = e.g.x, sync = e.g.alloc(SIZEOF.SYNC), fences: number[] = [], images: number[][] = [];
    e.host.onFence = n => fences.push(n); e.host.onImage = (w, i, what) => images.push([w === e.win ? 1 : 0, i, what]);
    G.c("SyncInitialize", [sync, G.dev]);
    t.eq([G.c("SyncWait", [sync, ALL]), x.gfx_wait_fence()], [2, 0], "not fenced: TIMEOUT_EXPIRED and nothing to park on");
    const i = G.acquire(e.win), dst = G.put(new Uint8Array(64 * 64 * 4)), px = (p: number) => Array.from(e.g.u8.subarray(p, p + 4));
    G.begin(); G.targets(cmd, [e.wtex[i]]); G.clear(cmd, [0.2, 0.4, 0.6, 1]);
    G.c("CommandBufferCopyTextureToBuffer", [cmd, e.wtex[i], 0, REGION(e, 0, 0, 0, 64, 64), dst, 0]);
    G.submit([G.end()]);
    G.c("QueueFenceSync", [G.queue, sync, 0, 0]);
    t.eq([G.c("SyncWait", [sync, 0]), x.gfx_wait_fence()], [2, 0], "timeout 0, fence not done: TIMEOUT_EXPIRED, the thread is not parked");
    t.eq(G.c("SyncWait", [sync, 5_000_000]), 2, "a finite timeout: TIMEOUT_EXPIRED for now");
    const f = x.gfx_wait_fence();
    t.ok(f > 0 && f === x.gfx_sync_fence(sync), "the fence to park on"); t.eq(e.g.x.kit_refused_total(), 0, "no refused transition");
    t.eq([G.c("SyncWait", [sync, 0]), x.gfx_wait_fence()], [2, 0], "the embedder's timer ran out first: the same wait with timeout 0 ends it");
    t.eq([G.c("SyncWait", [sync, ALL]), x.gfx_wait_fence()], [2, f], "an infinite timeout: park on the same fence, no timer");
    const p = e.host.fence(f);
    t.ok(p !== null, "GfxHost.fence gives a promise while the fence is pending"); t.eq(px(dst), [0, 0, 0, 0], "the read-back has not landed in this turn");
    await p;
    t.eq(px(dst + 4 * (64 * 20 + 7)), rgba8([0.2, 0.4, 0.6, 1]), "the fence completed after the read-back landed in guest memory");
    t.eq(G.c("SyncWait", [sync, ALL]), 1, "the wait made again after the park: CONDITION_SATISFIED"); t.eq(G.c("SyncWait", [sync, 0]), 0, "later: ALREADY_SIGNALED");
    t.ok(fences.includes(f), "onFence was called"); t.eq(e.host.fence(f), null, "a done fence needs no promise");
    // QueueFinish: everything submitted, and the read-backs, are done when its fence is
    const dst2 = G.put(new Uint8Array(64 * 64 * 4));
    G.begin(); G.targets(cmd, [e.wtex[i]]); G.clear(cmd, [1, 0, 0, 1]);
    G.c("CommandBufferCopyTextureToBuffer", [cmd, e.wtex[i], 0, REGION(e, 0, 0, 0, 64, 64), dst2, 0]);
    G.submit([G.end()]);
    G.c("QueueFinish", [G.queue]);
    const ff = x.gfx_finish_fence();
    t.ok(ff > f, "QueueFinish issued a fence"); t.eq(px(dst2), [0, 0, 0, 0], "not landed in the turn of the call");
    await e.host.fence(ff);
    t.eq(px(dst2 + 4 * 999), RED, "QueueFinish's fence completed after the read-back landed");
    G.present(e.win, i); await e.settle();
    t.eq(images, [[1, i, 0], [1, i, 1]], "onImage: queued, then shown"); t.noRed(e);
  } },

  { name: "shader reflection: a uniform block larger than the bound range reads zero past it; the translator's support buffer", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await e.program("vs_quad", "fs_ubo_big"), sprog = await e.program("vs_quad", "fs_support");
    // 16 bytes are bound; what follows them in memory is other data, which the 80-byte block must not see
    const mem = G.put(new Float32Array([0.2, 0.4, 0.6, 1, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
    let i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, mem, 16]); e.drawQuad(cmd); e.finish(i);
    let img = await e.read();
    t.rect(img, 0, 0, 64, 64, rgba8([0.2, 0.4, 0.6, 1]), "bound 16 of 80 bytes: the rest of the block is zero");
    const full = G.put(new Float32Array([0.2, 0.4, 0.1, 1, 0, 0, 0, 0, 0.1, 0.1, 0.1, 0, 0, 0, 0, 0, 0.2, 0.1, 0.3, 0]));
    i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, full, 80]); e.drawQuad(cmd); e.finish(i);
    img = await e.read();
    t.rect(img, 0, 0, 64, 64, rgba8([0.5, 0.6, 0.5, 1]), "bound in full: every member is read", 1);
    // the support buffer follows the viewport; no game uniform is involved
    i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], sprog); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 48, 64]); e.drawQuad(cmd);
    G.c("CommandBufferSetViewport", [cmd, 48, 0, 16, 32]); e.drawQuad(cmd); e.finish(i);
    img = await e.read();
    for (const [px, py] of [[0, 0], [10, 50], [47, 63], [30, 7]]) t.px(img, px, py, [b8((px + 0.5) / 48), 64, 128, 255], "viewport 48x64: x / width, height / 256, render scale 1", 1);
    for (const [px, py] of [[48, 0], [60, 20], [63, 31]]) t.px(img, px, py, [255, 32, 128, 255], "viewport 16x32: the support buffer changed with it (x / 16 is beyond 1)", 1);
    t.px(img, 60, 40, BLACK, "outside both viewports");
    t.ok(e.host.stats.uniformSlots > 0, "uniform data went through the arena"); t.noRed(e);
  } },

  { name: "vertex input classes: a shader bound with an integer attribute format uses its variant; without one the draw is skipped with a request; the embedder's hook", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await e.program("vs_color4", "fs_color"), i = G.acquire(e.win);
    const tri = [[-1, -1], [3, -1], [-1, 3]], fl = G.put(new Float32Array(tri.flatMap(p => [...p, 0.2, 0.4, 0.6, 1])));
    const ib = new ArrayBuffer(36), dv = new DataView(ib);
    tri.forEach((p, k) => { dv.setFloat32(k * 12, p[0], true); dv.setFloat32(k * 12 + 4, p[1], true); [204, 153, 51, 255].forEach((c, j) => dv.setUint8(k * 12 + 8 + j, c)); });
    const iv = G.put(new Uint8Array(ib));
    const intLayout = () => { G.vertexLayout(cmd, [{ format: FMT.RG32F, offset: 0 }, { format: FMT.RGBA8UI, offset: 8 }], [{ stride: 12 }]); G.c("CommandBufferBindVertexBuffer", [cmd, 0, iv, 36]); };
    G.begin(); G.targets(cmd, [e.wtex[i]]); G.defaultStates(cmd); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferBindProgram", [cmd, prog, 3]);
    G.vertexLayout(cmd, [{ format: FMT.RG32F, offset: 0 }, { format: FMT.RGBA32F, offset: 8 }], [{ stride: 24 }]); G.c("CommandBufferBindVertexBuffer", [cmd, 0, fl, 72]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 32]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]);        // as declared: floats
    intLayout(); G.c("CommandBufferSetViewport", [cmd, 32, 0, 32, 32]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]);   // RGBA8UI: the variant
    const noVar = G.program([await e.shader("vs_color4_novariant"), await e.shader("fs_color")]);
    G.c("CommandBufferBindProgram", [cmd, noVar, 3]); G.c("CommandBufferSetViewport", [cmd, 0, 32, 32, 32]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]);   // no variant: skipped
    const h1 = G.end(); G.submit([h1]);
    // from here on the embedder has a hook that translates a variant on demand
    const asked: string[] = [];
    e.host.onShaderVariant = (key, classes) => { asked.push(`${key.length}:${JSON.stringify(classes)}`); return SHADERS.vs_color4.variants!["0:float,1:uint"]; };
    const hooked = G.program([await e.shader("vs_color4_novariant", "vs_hooked"), await e.shader("fs_color")]);
    G.begin(); G.c("CommandBufferBindProgram", [cmd, hooked, 3]); G.c("CommandBufferSetViewport", [cmd, 32, 32, 32, 32]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]);
    e.finish(i);
    const img = await e.read();
    t.rect(img, 0, 0, 32, 32, rgba8([0.2, 0.4, 0.6, 1]), "float attributes, the shader as it is"); t.rect(img, 32, 0, 64, 32, [204, 153, 51, 255], "RGBA8UI attributes through the uint variant");
    t.rect(img, 0, 32, 32, 64, BLACK, "no variant: the draw is skipped"); t.rect(img, 32, 32, 64, 64, [204, 153, 51, 255], "the variant the embedder's hook supplied");
    t.eq(asked, ['16:{"0":"float","1":"uint"}'], "the hook was asked once, with the key and the classes");
    const red = e.g.red();
    t.ok(red.length === 1 && /is bound with attribute classes 0:float,1:uint, but declares 0:float,1:float: WebGPU needs a variant/.test(red[0]), `one red line, the request to the shader chain: ${red}`);
    t.eq(e.host.stats.errors, 0, "no WebGPU validation error"); await pipesBuilt(e);
    t.eq(pipeStates(e), [2, 2, 2, 3], "four pipelines (the key carries the classes): three Ready, the one without a variant Failed");
  } },

  { name: "WebGPU per-stage limits: a stage at the device's uniform buffer limit draws (dynamic and fixed offsets); one over it fails with the numbers", async run(e, t) {
    const G = e.G, cmd = G.cmd, max = e.host.device.limits.maxUniformBuffersPerShaderStage as number, dyn = e.host.device.limits.maxDynamicUniformBuffersPerPipelineLayout as number, n = Math.min(max, 14);
    SHADERS.fs_many = fsManyUbos(n);
    const prog = await e.program("vs_quad", "fs_many"), i = G.acquire(e.win);
    const cols = Array.from({ length: 14 }, (_, k) => [(k % 3 === 0 ? 1 : 0) / 8, (k % 3 === 1 ? 1 : 0) / 8, (k % 3 === 2 ? 1 : 0) / 8, 0]), blocks = cols.map(c => ubo(e, c));
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]);
    for (let k = 0; k < n; k++) G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, k, blocks[k], 16]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 64]); e.drawQuad(cmd);
    let over = false;
    if (max < 14) {
      over = true; SHADERS.fs_toomany = fsManyUbos(max + 1);
      const p2 = await e.program("vs_quad", "fs_toomany");
      G.c("CommandBufferBindProgram", [cmd, p2, 3]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, max, blocks[max], 16]);
      G.c("CommandBufferSetViewport", [cmd, 32, 0, 32, 64]); e.drawQuad(cmd);
    }
    e.finish(i);
    const img = await e.read(), sum = [0, 1, 2].map(c => cols.slice(0, n).reduce((a, k) => a + k[c], 0));
    t.rect(img, 0, 0, 32, 64, rgba8([...sum, 1]), `${n} uniform blocks in one stage, summed`, 1);
    console.log(`this device: ${max} uniform buffers a stage, ${dyn} dynamic offsets a pipeline layout: the ${n}-block shader binds ${Math.min(n, dyn)} through dynamic offsets and ${Math.max(0, n - dyn)} at fixed offsets`);
    if (over) {
      t.rect(img, 32, 0, 64, 64, BLACK, "one block over the limit: the draw is skipped");
      const red = e.g.red();
      t.ok(red.length === 1 && new RegExp(`needs ${max + 1} uniform buffers; this WebGPU device allows ${max} a stage \\(maxUniformBuffersPerShaderStage\\): 1 over`).test(red[0]), `one red line with the numbers: ${red}`);
      await pipesBuilt(e); t.eq(pipeStates(e), [2, 3], "that pipeline is Failed, the other Ready");
    } else console.log("this device allows 14 or more uniform buffers a stage: nothing a game binds can exceed it");
    t.eq(e.host.stats.errors, 0, "no WebGPU validation error");
  } },

  { name: "compute: a dispatch writes a storage buffer that the next draw uses as its vertex buffer and that lands in guest memory; storage images; dispatches between draws; a storage buffer read by a fragment shader", async run(e, t) {
    const G = e.G, cmd = G.cmd, x = e.g.x, cquad = await e.computeProgram("cs_quad"), cimage = await e.computeProgram("cs_image"), cinv = await e.computeProgram("cs_invert");
    const flat = await e.program("vs_quad", "fs_ubo"), tprog = await e.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST), sync = e.g.alloc(SIZEOF.SYNC);
    G.c("SyncInitialize", [sync, G.dev]);
    // frame 1: the quad's vertices come out of a compute shader
    const verts = G.put(new Float32Array(16)), scale = G.put(new Float32Array([0.5, 0.5, 0, 0])), xf = ubo(e, [1, 1, 0.5, 0]), red = ubo(e, [1, 0, 0, 1]);
    let i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], flat); G.clear(cmd, [0, 0, 0, 1]);
    G.c("CommandBufferBindProgram", [cmd, cquad, 0x20]);
    G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.COMPUTE, 0, xf, 16]);
    G.c("CommandBufferBindStorageBuffer", [cmd, STAGE.COMPUTE, 0, verts, 64]); G.c("CommandBufferBindStorageBuffers", [cmd, STAGE.COMPUTE, 1, 1, e.g.u64([scale, 16])]);
    G.c("CommandBufferDispatchCompute", [cmd, 1, 1, 1]);                                   // the clear is pending: it lands, then the compute pass
    G.c("CommandBufferBindVertexBuffer", [cmd, 0, verts, 64]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, red, 16]);
    G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLE_STRIP, 0, 4]);
    G.c("CommandBufferFenceSync", [cmd, sync, 0, 0]);
    e.finish(i);
    t.eq(Array.from(new Float32Array(e.g.memory.buffer, verts, 4)), [0, 0, 0, 0], "guest memory still has the old content right after the submit");
    t.eq(G.c("SyncWait", [sync, ALL]), 2, "the fence waits for the read-back (still pending in the turn of the submit)");
    const landed = e.host.fence(x.gfx_wait_fence());
    let img = await e.read();
    t.rect(img, 32, 16, 64, 48, RED, "the quad the compute shader placed (x 0..1, y -0.5..0.5)"); t.rect(img, 0, 0, 32, 64, BLACK, "left of it"); t.rect(img, 32, 0, 64, 16, BLACK, "above"); t.rect(img, 32, 48, 64, 64, BLACK, "below");
    await landed; t.eq(G.c("SyncWait", [sync, ALL]), 1, "the parked wait ends");
    t.eq(Array.from(new Float32Array(e.g.memory.buffer, verts, 16)), [0, -0.5, 0, 1, 1, -0.5, 1, 1, 0, 0.5, 0, 0, 1, 0.5, 1, 0], "the vertices landed in guest memory");
    t.eq([e.stat(13), e.stat(14), e.stat(0), e.host.stats.bufferReadbacks], [1, 1, 2, 1], "one dispatch in one compute pass between the clear's pass and the draw's; one buffer read back");
    // frame 2: a storage image written before any pass; then, between two draws, a dispatch that reads it and writes another
    const a = G.texture({ w: 16, h: 16, format: FMT.RGBA8 }), b = G.texture({ w: 16, h: 16, format: FMT.RGBA8 }), ida = G.texId(a), idb = G.texId(b), half = ubo(e, [0, 0, 0.5, 0]);
    i = G.acquire(e.win);
    G.begin();
    G.c("CommandBufferBindProgram", [cmd, cimage, 0x20]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.COMPUTE, 0, half, 16]);
    G.c("CommandBufferBindImage", [cmd, STAGE.COMPUTE, 0, G.c("DeviceGetImageHandle", [G.dev, ida])]); G.c("CommandBufferDispatchCompute", [cmd, 2, 2, 1]);
    e.frame(cmd, e.wtex[i], tprog); G.clear(cmd, [0, 0, 0, 1]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 64]); e.bindTexture(cmd, ida, nearest); e.drawQuad(cmd);
    G.c("CommandBufferBindProgram", [cmd, cinv, 0x20]); G.c("CommandBufferBindTexture", [cmd, STAGE.COMPUTE, 0, G.handle(ida, nearest)]);
    G.c("CommandBufferBindImages", [cmd, STAGE.COMPUTE, 0, 1, e.g.u64([G.c("DeviceGetImageHandle", [G.dev, idb])])]);
    const ind = G.put(new Uint32Array([2, 2, 1])); G.c("CommandBufferDispatchComputeIndirect", [cmd, ind]);                    // ends the render pass
    G.c("CommandBufferSetViewport", [cmd, 32, 0, 32, 64]); e.bindTexture(cmd, idb, nearest); e.drawQuad(cmd);                 // reopens it
    e.finish(i);
    img = await e.read();
    for (const [px, py] of [[0, 0], [9, 30], [31, 63], [16, 16]]) { const tx = Math.floor(px / 2), ty = Math.floor(py / 4); t.px(img, px, py, [b8(tx / 15), b8(ty / 15), 128, 255], "the image the first dispatch stored", 1); }
    for (const [px, py] of [[32, 0], [41, 30], [63, 63]]) { const tx = Math.floor((px - 32) / 2), ty = Math.floor(py / 4); t.px(img, px, py, [255 - b8(tx / 15), 255 - b8(ty / 15), 127, 255], "its inverse, stored by the dispatch between the draws", 1); }
    t.eq([e.stat(13), e.stat(14), e.stat(0)], [3, 3, 4], "three dispatches, each a compute pass; the render pass was split around the second");
    t.eq([x.gfx_tex_state(a), x.gfx_tex_state(b)], [2, 2], "images written by compute are GPU-owned");
    // frame 3: a storage buffer read by a fragment shader
    const table = G.put(new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1])), fprog = await e.program("vs_quad", "fs_table");
    i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], fprog); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferBindStorageBuffer", [cmd, STAGE.FRAGMENT, 0, table, 64]);
    [2, 3].forEach((k, n) => { G.c("CommandBufferSetViewport", [cmd, n * 32, 0, 32, 64]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, ubo(e, [k, 0, 0, 0]), 16]); e.drawQuad(cmd); });
    e.finish(i);
    img = await e.read();
    t.rect(img, 0, 0, 32, 64, BLUE, "table entry 2 from the storage buffer"); t.rect(img, 32, 0, 64, 64, [255, 255, 0, 255], "table entry 3");
    t.noRed(e);
  } },

  { name: "multisample targets resolved by Downsample (colour and depth), 8 samples rendered with 4; depth clamp", async run(e, t) {
    const G = e.G, cmd = G.cmd, prog = await uboProgram(e);
    const ms = G.texture({ w: 64, h: 64, format: FMT.RGBA8, target: TARGET.T2D_MS, samples: 4 }), msd = G.texture({ w: 64, h: 64, format: FMT.DEPTH32F, target: TARGET.T2D_MS, samples: 4 });
    const depth = G.texture({ w: 64, h: 64, format: FMT.DEPTH32F });
    const tri = G.put(new Float32Array([-1, -1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 0])), white = ubo(e, [1, 1, 1, 1]), near = ubo(e, [1, 1, 0, 0, 0.25, 0, 0, 0]);
    let i = G.acquire(e.win);
    G.begin();
    const st = e.frame(cmd, ms, prog, msd);
    G.c("MultisampleStateSetSamples", [st.ms, 4]); G.c("CommandBufferBindMultisampleState", [cmd, st.ms]);
    G.c("DepthStencilStateSetDepthTestEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthWriteEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthFunc", [st.ds, DEPTH_FUNC.LESS]); G.c("CommandBufferBindDepthStencilState", [cmd, st.ds]);
    G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0], [1.0]);
    G.c("CommandBufferBindVertexBuffer", [cmd, 0, tri, 48]); bindUbos(e, cmd, near, white);
    G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]);                              // the lower-left half: its edge is the diagonal
    G.c("CommandBufferDownsample", [cmd, ms, e.wtex[i]]); G.c("CommandBufferDownsample", [cmd, msd, depth]);
    e.finish(i);
    let img = await e.read();
    t.px(img, 10, 50, [255, 255, 255, 255], "inside the triangle"); t.px(img, 50, 10, BLACK, "outside");
    let partial = 0;
    for (let k = 0; k < 64; k++) { const v = img.px(k, k)[0]; if (v > 0 && v < 255) partial++; t.ok([0, 64, 128, 191, 255].some(q => Math.abs(v - q) <= 1), `pixel (${k},${k}) on the edge is ${v}: a multiple of a quarter coverage`); }
    t.ok(partial >= 48, `the resolve averaged the samples along the edge (${partial} of 64 diagonal pixels are partly covered)`);
    const d = await e.read(e.serial(depth)), df = (px: number, py: number) => new Float32Array(d.data.buffer, (py * 64 + px) * 4, 1)[0];
    t.ok(Math.abs(df(10, 50) - 0.25) < 1e-6 && df(50, 10) === 1, `the depth resolve: ${df(10, 50)} inside, ${df(50, 10)} outside`);
    t.eq([e.host.stats.resolves, e.stat(0)], [2, 1], "two resolves, one pass"); t.noRed(e);
    // 8 samples: WebGPU has 1 and 4
    const ms8 = G.texture({ w: 64, h: 64, format: FMT.RGBA8, target: TARGET.T2D_MS, samples: 8 });
    i = G.acquire(e.win);
    G.begin(); const s2 = e.frame(cmd, ms8, prog); G.c("MultisampleStateSetSamples", [s2.ms, 8]); G.c("CommandBufferBindMultisampleState", [cmd, s2.ms]);
    G.clear(cmd, [0, 0, 1, 1]); bindUbos(e, cmd, ubo(e, [0.5, 0.5, 0, 0, 0, 0, 0, 0]), white); e.drawQuad(cmd); G.c("CommandBufferDownsample", [cmd, ms8, e.wtex[i]]); e.finish(i);
    img = await e.read();
    t.rect(img, 16, 16, 48, 48, [255, 255, 255, 255], "drawn into the 8-sample target"); t.px(img, 4, 4, BLUE, "its clear");
    t.eq(e.g.red(), ["[RED] a render target has 8 samples: WebGPU has 1 and 4, it is rendered with 4"], "the one red line"); t.eq(e.host.stats.errors, 0, "no WebGPU error");
    // depth clamp: a quad beyond the far plane is clipped, unless the game turned the clamp on
    e.g.logs.length = 0;
    i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]);
    const far = (ox: number) => ubo(e, [0.5, 1, ox, 0, 1.5, 0, 0, 0]);
    bindUbos(e, cmd, far(-0.5), white); e.drawQuad(cmd);
    G.c("CommandBufferSetDepthClamp", [cmd, 1]); bindUbos(e, cmd, far(0.5), white); e.drawQuad(cmd); G.c("CommandBufferSetDepthClamp", [cmd, 0]);
    e.finish(i);
    img = await e.read();
    if (e.host.device.features.has("depth-clip-control")) { t.rect(img, 0, 0, 32, 64, BLACK, "z = 1.5 without the clamp: clipped"); t.rect(img, 32, 0, 64, 64, [255, 255, 255, 255], "with the clamp: drawn"); t.noRed(e); }
    else { t.rect(img, 0, 0, 64, 64, BLACK, "no depth-clip-control: clipped either way"); t.ok(e.g.red().some(l => /depth clamp needs the WebGPU feature/.test(l)), "and said so"); }
  } },

  { name: "CopyBufferToTexture is made in the texture's storage while the storage owns the content; depth textures, packed 16-bit and 16-bit normalized formats from memory", async run(e, t) {
    const G = e.G, cmd = G.cmd, x = e.g.x, tprog = await e.program("vs_quad", "fs_tex"), sprog = await e.program("vs_quad", "fs_shadow"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    const cmp = G.sampId(FILTER.NEAREST, FILTER.NEAREST, undefined, { compare: 4 /* LEQUAL */ });
    // the mirror: copies land in block-linear storage, ReadTexels sees them at once, the first use uploads once
    const tex = G.texture({ w: 8, h: 8, format: FMT.RGBA8, levels: 2 }), id = G.texId(tex), texels = Uint8Array.from({ length: 256 }, (_, k) => (k * 37 + 11) & 255);
    let i = G.acquire(e.win);
    G.begin(); fill(e, cmd, tex, 8, 8, texels); fill(e, cmd, tex, 4, 4, solid(4, 4, [9, 8, 7, 255]), { level: 1 });
    e.frame(cmd, e.wtex[i], tprog); G.clear(cmd, [0, 0, 0, 1]); e.bindTexture(cmd, id, nearest); e.drawQuad(cmd);
    // the same texture again, after it was sampled: the draws before the copy must keep the old texels
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 64]);
    fill(e, cmd, tex, 8, 8, solid(8, 8, [0, 255, 0, 255])); e.drawQuad(cmd);
    e.finish(i);
    t.eq([e.stat(15), x.gfx_tex_state(tex), e.host.stats.errors], [3, 1, 0], "three copies made in the storage; the texture is Uploaded (not GPU-owned)");
    const back = e.g.alloc(256);
    G.c("TextureReadTexels", [tex, 0, REGION(e, 0, 0, 0, 8, 8), back]);
    t.eq(Array.from(e.g.u8.subarray(back, back + 8)), [0, 255, 0, 255, 0, 255, 0, 255], "ReadTexels reads what the last copy wrote");
    let img = await e.read();
    t.rect(img, 0, 0, 32, 64, GREEN, "the draw after the second copy");
    for (const [px, py] of [[33, 1], [47, 20], [63, 63]]) { const o = (Math.floor(py / 8) * 8 + Math.floor(px / 8)) * 4; t.px(img, px, py, Array.from(texels.subarray(o, o + 4)), "the draw before it kept the first copy's texels"); }
    t.eq((await e.read(e.serial(tex), 1)).px(2, 2), [9, 8, 7, 255], "the level-1 copy");
    t.eq(e.stat(0), 2, "the copy into a texture in use split the pass; the others did not");
    // depth formats: a 64x64 depth texture from memory, left half 0.25, right half 0.75, sampled through a comparison sampler
    const D = (px: number) => (px < 32 ? 0.25 : 0.75), ST = (py: number) => (py < 32 ? 7 : 3);
    const data: Record<string, () => ArrayBufferView> = {
      DEPTH16: () => Uint16Array.from({ length: 4096 }, (_, k) => Math.round(D(k % 64) * 65535)), DEPTH24: () => Uint32Array.from({ length: 4096 }, (_, k) => Math.round(D(k % 64) * 16777215) << 8 >>> 0),
      DEPTH32F: () => Float32Array.from({ length: 4096 }, (_, k) => D(k % 64)), DEPTH24_STENCIL8: () => Uint32Array.from({ length: 4096 }, (_, k) => ((Math.round(D(k % 64) * 16777215) << 8) | ST(k >> 6)) >>> 0),
      DEPTH32F_STENCIL8: () => { const b = new ArrayBuffer(32768), dv = new DataView(b); for (let k = 0; k < 4096; k++) { dv.setFloat32(k * 8, D(k % 64), true); dv.setUint32(k * 8 + 4, ST(k >> 6), true); } return new Uint8Array(b); },
    };
    const uprog = await uboProgram(e);
    for (const [name, make] of Object.entries(data)) {
      const dt = G.texture({ w: 64, h: 64, format: (FMT as any)[name] }), did = G.texId(dt), stencil = name.endsWith("STENCIL8");
      i = G.acquire(e.win);
      G.begin(); fill(e, cmd, dt, 64, 64, make());
      e.frame(cmd, e.wtex[i], sprog); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); G.clear(cmd, [0, 0, 0, 1]); e.bindTexture(cmd, did, cmp); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, ubo(e, [0.5, 0, 0, 0]), 16]); e.drawQuad(cmd);
      e.finish(i);
      img = await e.read();
      t.rect(img, 0, 0, 32, 64, GREEN, `${name}: 0.5 <= 0.25 fails on the left half`); t.rect(img, 32, 0, 64, 64, RED, `${name}: 0.5 <= 0.75 passes on the right half`);
      if (name === "DEPTH32F") { const r = await e.read(e.serial(dt)); t.eq([new Float32Array(r.data.buffer, 0, 1)[0], new Float32Array(r.data.buffer, 63 * 4, 1)[0]], [0.25, 0.75], "DEPTH32F read back: the floats as uploaded"); }
      if (name === "DEPTH16") { const r = await e.read(e.serial(dt)); t.eq([new Uint16Array(r.data.buffer, 0, 1)[0], new Uint16Array(r.data.buffer, 63 * 2, 1)[0]], [16384, 49151], "DEPTH16 read back"); }
      if (!stencil) continue;
      // the stencil from memory, kept when the texture becomes a target: a quad drawn where stencil == 7 and depth passes LESS 0.5
      i = G.acquire(e.win);
      G.begin(); const st = e.frame(cmd, e.wtex[i], uprog, dt); G.clear(cmd, [0, 0, 0, 1]);
      G.c("DepthStencilStateSetStencilTestEnable", [st.ds, 1]); G.c("DepthStencilStateSetStencilFunc", [st.ds, 3, 3 /* EQUAL */]);
      G.c("DepthStencilStateSetDepthTestEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthWriteEnable", [st.ds, 0]); G.c("DepthStencilStateSetDepthFunc", [st.ds, DEPTH_FUNC.LESS]);
      G.c("CommandBufferBindDepthStencilState", [cmd, st.ds]); G.c("CommandBufferSetStencilRef", [cmd, 3, 7]);
      bindUbos(e, cmd, ubo(e, [1, 1, 0, 0, 0.5, 0, 0, 0]), ubo(e, [0, 0, 1, 1])); e.drawQuad(cmd); e.finish(i);
      img = await e.read();
      t.rect(img, 32, 0, 64, 32, BLUE, `${name} as a target: stencil 7 and depth 0.75 let the quad through`); t.rect(img, 0, 0, 32, 32, BLACK, "depth 0.25 hides it"); t.rect(img, 0, 32, 64, 64, BLACK, "stencil 3 rejects it");
    }
    // packed 16-bit formats (red at bit 0 in guest memory) and 16-bit normalized
    const want = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 0]];
    const packed: [string, number[]][] = [
      ["RGBA4", [0xF00F, 0xF0F0, 0xFF00, 0x0FFF]], ["RGB5A1", [0x801F, 0x83E0, 0xFC00, 0x7FFF]], ["RGB565", [0x001F, 0x07E0, 0xF800, 0xFFFF]],
      ["BGR565", [0xF800, 0x07E0, 0x001F, 0xFFFF]], ["BGR5A1", [0xFC00, 0x83E0, 0x801F, 0x7FFF]], ["A1BGR5", [0xF801, 0x07C1, 0x003F, 0xFFFE]], ["RGB5", [0x001F, 0x03E0, 0x7C00, 0x7FFF]]];
    i = G.acquire(e.win); G.begin(); e.frame(cmd, e.wtex[i], tprog); G.clear(cmd, [0, 0, 0, 1]);
    const made: [string, number][] = [];
    for (const [name, v] of packed) { const pt = G.texture({ w: 2, h: 2, format: (FMT as any)[name] }); fill(e, cmd, pt, 2, 2, new Uint16Array(v)); e.bindTexture(cmd, G.texId(pt), nearest); e.drawQuad(cmd); made.push([name, pt]); }
    const r16 = G.texture({ w: 4, h: 1, format: FMT.R16 }); fill(e, cmd, r16, 4, 1, new Uint16Array([0, 0x4000, 0xC000, 0xFFFF])); e.bindTexture(cmd, G.texId(r16), nearest); e.drawQuad(cmd);
    e.finish(i);
    for (const [name, pt] of made) {
      const r = await e.read(e.serial(pt)), opaque = name === "RGB565" || name === "BGR565" || name === "RGB5";
      t.eq([0, 1, 2, 3].map(k => r.px(k % 2, k >> 1)), want.map((c, k) => (k === 3 && opaque ? [255, 255, 255, 255] : c)), `${name} unpacked to RGBA8`);
    }
    const r = await e.read(e.serial(r16));
    if (r.bytesPerPixel === 2 && !e.host.device.features.has("texture-formats-tier1")) {
      const got = [0, 1, 2, 3].map(k => halfToFloat(r.data[k * 2] | r.data[k * 2 + 1] << 8));
      [0, 0x4000 / 65535, 0xC000 / 65535, 1].forEach((w, k) => t.ok(Math.abs(got[k] - w) < 1 / 2048, `R16 texel ${k} as a half float: ${got[k]} for ${w}`));
    } else t.eq(Array.from(new Uint16Array(r.data.buffer, 0, 4)), [0, 0x4000, 0xC000, 0xFFFF], "R16 as it is (the device has 16-bit normalized formats)");
    t.noRed(e);
  } },

  { name: "cube, 2D array, 3D and cube array textures sampled; a render target view of a foreign format renders in the texture's own", async run(e, t) {
    const G = e.G, cmd = G.cmd, nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    const pal = (k: number) => [(k * 67 + 40) & 255, (k * 131 + 90) & 255, (k * 29 + 10) & 255, 255];
    const cube = G.texture({ w: 4, h: 4, format: FMT.RGBA8, target: TARGET.CUBE }), arr = G.texture({ w: 4, h: 4, format: FMT.RGBA8, target: TARGET.T2D_ARRAY, depth: 5 });
    const vol = G.texture({ w: 4, h: 4, format: FMT.RGBA8, target: TARGET.T3D, depth: 4 }), cubes = G.texture({ w: 4, h: 4, format: FMT.RGBA8, target: TARGET.CUBE_ARRAY, depth: 12 });
    const pc = await e.program("vs_quad", "fs_cube"), pa = await e.program("vs_quad", "fs_array"), p3 = await e.program("vs_quad", "fs_3d"), pca = await e.program("vs_quad", "fs_cube_array");
    const i = G.acquire(e.win);
    G.begin();
    for (let f = 0; f < 6; f++) fill(e, cmd, cube, 4, 4, solid(4, 4, pal(f)), { layer: f });
    for (let l = 0; l < 5; l++) fill(e, cmd, arr, 4, 4, solid(4, 4, pal(10 + l)), { layer: l });
    for (let z = 0; z < 4; z++) fill(e, cmd, vol, 4, 4, solid(4, 4, pal(20 + z)), { z });
    for (let l = 0; l < 12; l++) fill(e, cmd, cubes, 4, 4, solid(4, 4, pal(30 + l)), { layer: l });
    e.frame(cmd, e.wtex[i], pc); G.clear(cmd, [0, 0, 0, 1]);
    const cell = (k: number) => [(k % 8) * 8, Math.floor(k / 8) * 8], dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const draw = (k: number, prog: number, id: number, c: number[]) => {
      const [x, y] = cell(k);
      G.c("CommandBufferBindProgram", [cmd, prog, 3]); G.c("CommandBufferSetViewport", [cmd, x, y, 8, 8]); e.bindTexture(cmd, id, nearest);
      G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, ubo(e, c), 16]); e.drawQuad(cmd);
    };
    const ic = G.texId(cube), ia = G.texId(arr), i3 = G.texId(vol), ica = G.texId(cubes), expect: [number, number[], string][] = [];
    dirs.forEach((d, f) => { draw(f, pc, ic, [...d, 0]); expect.push([f, pal(f), `cube face ${f}`]); });
    for (let l = 0; l < 5; l++) { draw(8 + l, pa, ia, [0, 0, 0, l]); expect.push([8 + l, pal(10 + l), `array layer ${l}`]); }
    for (let z = 0; z < 4; z++) { draw(16 + z, p3, i3, [0, 0, (z + 0.5) / 4, 0]); expect.push([16 + z, pal(20 + z), `3D slice ${z}`]); }
    dirs.forEach((d, f) => { draw(24 + f, pca, ica, [...d, 1]); expect.push([24 + f, pal(36 + f), `cube array: cube 1 face ${f}`]); });
    draw(30, pca, ica, [0, 1, 0, 0]); expect.push([30, pal(32), "cube array: cube 0 face 2"]);
    e.finish(i);
    const img = await e.read();
    for (const [k, c, what] of expect) { const [x, y] = cell(k); t.rect(img, x, y, x + 8, y + 8, c, what); }
    t.eq(e.stat(15), 27, "27 layer copies, all made in the textures' storage"); t.noRed(e);
    // SetRenderTargets with a view whose format is not the texture's sRGB twin: pipeline and attachment agree on the texture's format
    const rt = G.texture({ w: 64, h: 64, format: FMT.RGBA8 }), prog = await uboProgram(e), j = G.acquire(e.win);
    G.begin(); G.targets(cmd, [rt], 0, [G.view({ format: FMT.R8 })]); G.defaultStates(cmd);
    G.vertexLayout(cmd, [{ format: FMT.RG32F, offset: 0 }, { format: FMT.RG32F, offset: 8 }], [{ stride: 16 }]); G.c("CommandBufferBindVertexBuffer", [cmd, 0, e.quad, QUAD.byteLength]); G.c("CommandBufferBindProgram", [cmd, prog, 3]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); G.clear(cmd, [0, 0, 0, 1]); bindUbos(e, cmd, ubo(e, IDENT), ubo(e, [0.25, 0.5, 0.75, 1])); e.drawQuad(cmd);
    // and one that is the twin: rendered through the sRGB view, the values are encoded
    G.targets(cmd, [e.wtex[j]], 0, [G.view({ format: FMT.RGBA8_SRGB })]); G.clear(cmd, [0, 0, 0, 1]); e.drawQuad(cmd);
    e.finish(j);
    t.rect(await e.read(e.serial(rt)), 0, 0, 64, 64, rgba8([0.25, 0.5, 0.75, 1]), "an R8 view of an RGBA8 target: all four channels of the texture are written", 1);
    const enc = (v: number) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
    t.rect(await e.read(), 0, 0, 64, 64, [enc(0.25), enc(0.5), enc(0.75), 255], "an sRGB view of an RGBA8 target: encoded on write", 1);
    t.eq(e.g.red(), ["[RED] a render target view reads format 0x25 as 0x1: WebGPU views can only switch sRGB, the texture's own format is rendered"], "one red line for the foreign view"); t.eq(e.host.stats.errors, 0, "no WebGPU validation error");
  } },

  { name: "ASTC decoded on the CPU: the texture equals astcenc's decode texel for texel; drawn, it equals the same texture given to a device that has ASTC", host: { forceAstcDecode: true }, async run(e, t) {
    const all: { name: string; bw: number; bh: number; w: number; h: number; srgb: boolean; random?: boolean; astc: string; rgba: string }[] = (await (await fetch("/build/gfx/astc.json")).json()).cases;
    if (!all.length) { console.log("SKIPPED: no ASTC vectors (pip install astc-encoder-py)"); return; }
    // textures of whole blocks (drawn from both devices) and three whose last blocks are cut (decoded only)
    const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0)), pick = ["alpha 4x4", "noise 8x5", "edges 12x12"];
    const cases = [...all.filter((c: any) => c.aligned), ...pick.map(p => all.find(c => c.name.startsWith(p))!).filter(Boolean)];
    t.ok(cases.length >= 8, "vectors found"); t.eq(e.host.caps & 1, 0, "the replayer told the recorder it has no ASTC");
    const native = e.host.device.features.has("texture-compression-astc") ? await e.sibling({}) : null;
    const render = async (env: Env, c: (typeof cases)[number]) => {
      const G = env.G, cmd = G.cmd, format = 0x79 + [[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]].findIndex(b => b[0] === c.bw && b[1] === c.bh) + (c.srgb ? 14 : 0);
      const tex = G.texture({ w: c.w, h: c.h, format }), prog = await env.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST), i = G.acquire(env.win);
      G.begin(); fill(env, cmd, tex, c.w, c.h, b64(c.astc));
      env.frame(cmd, env.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, c.w, c.h]); env.bindTexture(cmd, G.texId(tex), nearest); env.drawQuad(cmd); env.finish(i);
      return { tex, img: await env.read() };
    };
    let texels = 0, worst = 0;
    for (const c of cases) {
      const d = await render(e, c), want = b64(c.rgba), got = await e.read(e.serial(d.tex));
      t.eq([got.width, got.height, got.bytesPerPixel], [c.w, c.h, 4], `${c.name}: the host texture is RGBA8 of the texture's size`);
      for (let k = 0; k < c.w * c.h * 4; k++) if (got.data[k] !== want[k]) throw new Error(`${c.name}: byte ${k} of the decoded texture is ${got.data[k]}, astcenc has ${want[k]}`);
      t.checks += c.w * c.h; texels += c.w * c.h;
      if (!native || !(c as any).aligned) continue;
      const n = await render(native, c);
      t.eq((await native.read(native.serial(n.tex))).bytesPerPixel, 16, "the other device holds the blocks themselves");
      for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { const a = d.img.px(x, y), b = n.img.px(x, y); for (let k = 0; k < 4; k++) { const df = Math.abs(a[k] - b[k]); if (df > worst) worst = df; if (df > (c.srgb ? 4 : 2)) throw new Error(`${c.name}: pixel (${x},${y}) drawn from the CPU decode is ${a}, from the GPU's ASTC ${b}`); } }
      t.checks += c.w * c.h;
      t.eq(native.g.red(), [], "no red line on the device with ASTC");
    }
    console.log(`${cases.length} ASTC textures (${cases.map(c => c.name).join(", ")}): ${texels} texels equal astcenc's; ${native ? `the ${cases.filter((c: any) => c.aligned).length} of whole blocks drawn against the adapter's own ASTC decoder: the largest difference is ${worst} of 255 (allowed: 2, and 4 after sRGB decoding)` : "this adapter has no ASTC to compare with"}`);
    t.noRed(e);
  } },

  { name: "uniform data: one buffer with dynamic offsets against a buffer per bound range, 1000 draws", async run(e, t) {
    const N = 1000, cell = (k: number) => [(k % 40) * 1.6, Math.floor(k / 40) * 2.56], colour = (k: number, f = 0) => [((k * 7 + f * 50) % 256) / 255, ((k * 3) % 256) / 255, 0.5, 1];
    SHADERS.vs_quad_ubo_sz = { ...SHADERS.vs_quad_ubo, uboSize: { "0": 32 } }; SHADERS.fs_ubo_sz = { ...SHADERS.fs_ubo, uboSize: { "0": 16 } };
    // one block of per-object uniforms, as an engine lays them out: 256 bytes apart (NVN's uniform buffer alignment).
    // bound: the size the game binds each range with (engines often bind far more than the shader's block)
    const measure = async (env: Env, label: string, bound: number) => {
      const G = env.G, cmd = G.cmd, prog = await env.program(bound ? "vs_quad_ubo_sz" : "vs_quad_ubo", bound ? "fs_ubo_sz" : "fs_ubo"), block = G.put(new Uint8Array(N * 512 + 8192)), f32 = () => new Float32Array(env.g.memory.buffer);
      for (let k = 0; k < N; k++) { const [x, y] = cell(k); f32().set([1 / 40, 1 / 25, (x + 0.8) / 32 - 1, 1 - (y + 1.28) / 32, 0, 0, 0, 0], (block + k * 512) / 4); f32().set(colour(k), (block + k * 512 + 256) / 4); }
      const top = env.g.top;
      const frame = () => {
        env.g.top = top; G.c("CommandBufferAddCommandMemory", [cmd, G.cmdPool.obj, 0, G.cmdPool.size]);
        const i = G.acquire(env.win); G.begin(); env.frame(cmd, env.wtex[i], prog); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]);
        for (let k = 0; k < N; k++) {
          G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.VERTEX, 0, block + k * 512, bound || 32]); G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.FRAGMENT, 0, block + k * 512 + 256, bound || 16]); env.drawQuad(cmd);
        }
        const h = G.end(), t0 = performance.now(); G.submit([h]); const ms = performance.now() - t0; G.present(env.win, i); return ms;
      };
      let fno = 0;
      const run = async (frames: number, change: number, stride: number) => {
        const s0 = { ...env.host.stats }, times: number[] = [];
        for (let f = 0; f < frames; f++) { fno++; for (let k = 0; k < change; k++) f32().set(colour(k * stride, fno), (block + k * stride * 512 + 256) / 4); times.push(frame()); await env.settle(); }
        times.sort((a, b) => a - b);
        const d = (k: keyof typeof s0) => (env.host.stats[k] - s0[k]) / frames;
        return { ms: times[frames >> 1], writes: d("uploads") + d("uniformWrites"), hashes: d("hashes"), groups: d("bindGroups"), slots: d("uniformSlots"), kb: (d("uploadBytes") + d("uniformBytes")) / 1024 };
      };
      frame(); frame(); await env.settle();
      const same = await run(15, 0, 1), partly = await run(15, 100, 10), all = await run(15, N, 1);
      const img = await env.read();
      for (const k of [0, 10, 555, 990, 999]) { const [x, y] = cell(k); t.px(img, Math.floor(x + 0.8), Math.floor(y + 1.28), rgba8(colour(k, fno)), `${label}: cell ${k}`, 1); }
      t.eq(env.g.red(), [], `${label}: red lines`); t.eq(env.host.stats.errors, 0, `${label}: WebGPU errors`);
      return { same, partly, all };
    };
    const none = await e.sibling({ uniformArena: false }); none.host.cacheUploads = false;
    const a = await measure(none, "a buffer a range, written every submission", 0), b = await measure(await e.sibling({ uniformArena: false }), "a buffer a range, hashed", 0), c = await measure(e, "uniform arena", 0);
    const b4 = await measure(await e.sibling({ uniformArena: false }), "a buffer a range, hashed, 4 KB bound", 4096), c4 = await measure(await e.sibling({}), "uniform arena, 4 KB bound", 4096);
    t.eq([b.same.writes, b.same.hashes, b.same.groups, b.partly.writes, b.all.writes], [0, 2002, 0, 100, 1000], "per range: nothing written when nothing changed but 2002 ranges hashed; the ranges that changed written one by one");
    t.eq([c.same.writes, c.same.hashes, c.same.slots, c.same.groups, c.partly.writes, c.all.writes], [1, 2, 2000, 0, 1, 1], "arena: one buffer write a submission whatever changed, 2 hashes (vertex and index data), 2000 slots, no bind group made");
    t.ok(c4.same.kb < 600 && b4.same.hashes === 2002, `with 4 KB bound a range the arena still copies only the shaders' blocks (${c4.same.kb.toFixed(0)} KB written); the per-range path hashes all 8 MB`);
    const f = (v: number) => v.toFixed(1), row = (r: Awaited<ReturnType<typeof measure>>) => `${f(r.same.ms).padStart(5)} / ${f(r.partly.ms).padStart(5)} / ${f(r.all.ms).padStart(5)} ms`;
    console.log(`1000 draws, 2000 uniform ranges (blocks of 32 and 16 bytes); median ms a submission, recorder + replayer: nothing changed / 100 ranges changed / 1000 ranges changed
     a buffer a range, all written every submission (the first implementation)  ${row(a)}   ${a.same.writes} buffer writes, ${a.same.groups} bind groups a submission
     a buffer a range, hashed (the path before)                                ${row(b)}   ${b.same.hashes} hashes; ${b.partly.writes} / ${b.all.writes} buffer writes
     one buffer, dynamic offsets (now)                                         ${row(c)}   ${c.same.hashes} hashes; 1 write of ${f(c.same.kb)} KB
     the same with every range bound 4096 bytes long: hashed                   ${row(b4)}   ${f(b4.same.hashes * 4096 / 1048576)} MB hashed a submission
     the same with every range bound 4096 bytes long: one buffer               ${row(c4)}   1 write of ${f(c4.same.kb)} KB`);
  } },

  { name: "device loss: GPUDevice.destroy() mid-run; submissions against the dead device do no harm; a new device, textures and pipelines made again from guest state", ownDevice: true, host: { requestDevice: newDevice }, async run(e, t) {
    const G = e.G, cmd = G.cmd, x = e.g.x, prog = await e.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST), sync = e.g.alloc(SIZEOF.SYNC);
    G.c("SyncInitialize", [sync, G.dev]);
    const texels = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];
    const first = e.host.device;
    let i = G.acquire(e.win);
    G.begin(); const tx = upload(e, cmd, 2, 2, FMT.RGBA8, texels.flat());
    const frame = (k: number) => { e.frame(cmd, e.wtex[k], prog); G.clear(cmd, [0, 0, 0, 1]); e.bindTexture(cmd, tx.id, nearest); e.drawQuad(cmd); };
    frame(i); e.finish(i);
    const check = async (what: string) => { const img = await e.read(); t.rect(img, 0, 0, 32, 32, texels[0], `${what}: top left`); t.rect(img, 32, 0, 64, 32, texels[1], `${what}: top right`); t.rect(img, 0, 32, 32, 64, texels[2], `${what}: bottom left`); t.rect(img, 32, 32, 64, 64, texels[3], `${what}: bottom right`); };
    await check("before the loss"); await pipesBuilt(e);
    t.eq([x.gfx_device_state(), x.gfx_tex_state(tx.tex), pipeStates(e)], [0, 1, [2]], "Live; the texture Uploaded; the pipeline Ready");
    // the loss, with a fence pending and a frame submitted before anyone knows
    const restored = new Promise<number>(res => { e.host.onDeviceRestored = n => res(n); }), lostInfo: string[] = [];
    e.host.onDeviceLost = info => lostInfo.push(String(info.reason));
    first.destroy();
    i = G.acquire(e.win);
    G.begin(); frame(i); G.c("CommandBufferFenceSync", [cmd, sync, 0, 0]); e.finish(i);
    t.eq(G.c("SyncWait", [sync, ALL]), 2, "the fence of the frame given to the dead device is pending");
    const fence = e.host.fence(x.gfx_wait_fence());
    const gone = await restored; await fence;
    t.eq(G.c("SyncWait", [sync, ALL]), 1, "the fence completed: no thread waits on a dead device");
    t.ok(e.host.device !== first, "the replayer has the new device");
    t.eq([x.gfx_device_state(), x.gfx_device_losses(), lostInfo, x.gfx_tex_state(tx.tex)], [0, 1, ["destroyed"], 0], "Live again after one loss; the texture's content is to be uploaded again (Unknown)");
    t.ok(gone >= 1, `${gone} GPU-written textures (the window images) are empty until drawn again`);
    // the same frame again, from the same guest objects
    const up0 = e.stat(8);
    i = G.acquire(e.win);
    G.begin(); frame(i); e.finish(i);
    await check("after the loss, on the new device"); await pipesBuilt(e);
    t.eq([e.stat(8) - up0, x.gfx_tex_state(tx.tex), pipeStates(e), e.host.stats.pipelinesAsync], [1, 1, [2], 2], "the texture was uploaded again from guest memory; the same pipeline entry was built again on the new device");
    const red = e.g.red();
    t.ok(red.length === 2 && /^\[RED\] WebGPU device lost \(destroyed\)/.test(red[0]) && /the GPU device was lost: \d+ textures the GPU had written/.test(red[1]), `two red lines, the loss and what could not be brought back: ${JSON.stringify(red)}`);
    t.eq([e.host.stats.errors, x.kit_refused_total()], [0, 0], "no WebGPU error, no refused transition");
  } },

  { name: "frame capture: one frame's host stream as text and a PNG of each render target after each pass", async run(e, t) {
    const G = e.G, cmd = G.cmd, tprog = await e.program("vs_quad", "fs_tex"), prog = await uboProgram(e), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    const pending = e.host.captureFrame();
    const rt = G.texture({ w: 32, h: 32, format: FMT.RGBA8 }), id = G.texId(rt);
    let i = G.acquire(e.win);
    const frame = () => {
      G.begin(); e.frame(cmd, rt, prog); G.c("CommandBufferSetViewport", [cmd, 0, 0, 32, 32]); G.clear(cmd, [0, 0, 1, 1]); bindUbos(e, cmd, ubo(e, [0.5, 0.5, 0, 0, 0, 0, 0, 0]), ubo(e, [1, 0.5, 0, 1])); e.drawQuad(cmd);
      e.frame(cmd, e.wtex[i], tprog); G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 32]); e.bindTexture(cmd, id, nearest); e.drawQuad(cmd);
      G.submit([G.end()]);
    };
    frame(); G.present(e.win, i);
    const cap = await pending, win = await e.read();
    t.eq([cap.passes, cap.draws, cap.images.map(m => `${m.target} ${m.width}x${m.height} ${m.format}`)], [2, 2, ["color0 32x32 rgba8unorm", "color0 64x64 rgba8unorm"]], "two passes, two draws, a PNG of each pass's target");
    for (const need of [/^T create tex#\d+ rgba8unorm 32x32 target 1 levels 1$/m, /^P 1 begin 32x32\n {4}color0 tex#\d+ rgba8unorm 32x32 as rgba8unorm level 0 layer 0 clear\(0, 0, 1, 1\)$/m, /^K pipeline \d+ requested\n {6}vs [0-9a-f]{16} fs [0-9a-f]{16}\n {6}triangle-list, cull none, front c?cw, samples 1\n {6}color0 rgba8unorm mask 0xf\n {6}attributes loc0 float32x2@0 stream 0 \(stride 16\); loc1 float32x2@8 stream 0 \(stride 16\)$/m,
      /^ {4}ubo fs\[0\] 0x[0-9a-f]+\+16$/m, /^ {2}D draw indexed u16 @0x[0-9a-f]+ count 6 instances 1 base vertex 0 base instance 0$/m, /^P 1 end \(1 draws or dispatches\)\n {4}-> pass001_color0_tex\d+\.png$/m,
      /^P 2 begin 64x64$/m, /^ {4}tex fs\[0\] tex#\d+ rgba8unorm 32x32 sampler \d+$/m, /^ {4}viewport 0, 0, 32, 32 depth 0, 1$/m, /^ {4}viewport 0, 0, 64, 32 depth 0, 1$/m, /^S present tex#\d+ rgba8unorm 64x64 window 0x[0-9a-f]+ image \d crop 0, 0, 0, 0$/m]) t.ok(need.test(cap.text), `the text has ${need}:\n${cap.text}`);
    // the PNGs, decoded by the browser, are the targets as they were after their pass
    const decode = async (png: Uint8Array) => { const bm = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" }); const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext("2d", { willReadFrequently: true })!; g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height); };
    const p1 = await decode(cap.images[0].png), p2 = await decode(cap.images[1].png), at = (im: ImageData, x: number, y: number) => Array.from(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4));
    t.eq([p1.width, p1.height, at(p1, 0, 0), at(p1, 16, 16)], [32, 32, BLUE, [255, 128, 0, 255]], "pass 1's PNG: the clear and the quad");
    for (const [x, y] of [[0, 0], [20, 10], [40, 20], [63, 31], [10, 50], [63, 63]]) t.eq(at(p2, x, y), win.px(x, y), `pass 2's PNG equals the presented texture at (${x},${y})`);
    t.eq(at(p2, 32, 16), [255, 128, 0, 255], "the render target's quad, sampled"); t.eq(at(p2, 32, 40), BLACK, "below the viewport");
    t.files.push({ name: "capture/frame.txt", text: cap.text }, ...cap.images.map(m => ({ name: `capture/${m.name}`, base64: btoa(String.fromCharCode(...m.png)) })));
    // a capture changes nothing: the next frame is not captured and renders the same
    await e.settle(); i = G.acquire(e.win);
    const s0 = e.host.stats.submits; frame(); G.present(e.win, i);
    t.eq((await e.read()).px(32, 16), [255, 128, 0, 255], "the frame after the capture"); t.ok(e.host.stats.submits - s0 <= 2, "and is submitted as usual");
    // a capture that sees no present stops after its record limit, says so, and leaves the next capture free
    const short = e.host.captureFrame({ maxRecords: 3 });
    t.ok(e.host.capturing, "capturing while it waits for a present");
    await e.settle(); i = G.acquire(e.win); frame();
    const sc = await short;
    t.eq([sc.records, e.host.capturing], [3, false], "the record limit ends the capture"); t.ok(/^\(the capture stops here: no present in 3 host records\)$/m.test(sc.text), `the text says why:\n${sc.text}`);
    G.present(e.win, i); await e.read();
    console.log(`capture: ${cap.records} records, ${cap.text.split("\n").length} lines of text, ${cap.images.length} PNGs (${cap.images.map(m => m.png.length).join(" and ")} bytes); saved under build/gfx/capture/`);
    t.noRed(e);
  } },
];
