// Scenes of `npm run gfx:test` (browser) for textures the CPU keeps writing (src/gfx/texwatch.ts): published by a pool
// flush (profile key tex_flush_upload), and rewritten in guest memory with no NVN call at all (tex_dirty_upload).
// A texture's host copy is read back and compared with its storage deswizzled, every byte.
import { Env } from "./env.mts";
import { FMT, FILTER, POOL_FLAGS, type Pool } from "./nvn.mts";
import { type Scene, T, RED, GREEN } from "./scenes.mts";
import { PROFILE, frame } from "./scenes4.mts";

const CPU = POOL_FLAGS.CPU_CACHED | POOL_FLAGS.GPU_CACHED;
// 0 taken back from the GPU by a flush, 1 KB scanned, 2 scans, 3 scans that found a rewrite, 4 published by a flush, 5 registered, 6 bytes scanned in the last submission
const wstat = (e: Env) => Array.from({ length: 7 }, (_, i) => e.g.x.gfx_tex_watch_stat(i) >>> 0);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, k) => v === b[k]);
// An RGBA8 texture in `pool` (the test game's own texture pool without one: the CPU cannot write that), and what its
// storage means as linear rows
function cpuTexture(e: Env, pool: Pool | undefined, w: number, h: number) {
  const G = e.G, tex = G.texture({ w, h, format: FMT.RGBA8, pool }), addr = G.c("TextureGetTextureAddress", [tex]), size = G.c("TextureGetStorageSize", [tex]);
  const desc = e.g.alloc(40);
  new Int32Array(e.g.memory.buffer, desc, 10).set([1, FMT.RGBA8, 0, 0, w, h, 1, 1, 0, 0]);
  let linear = 0;
  const expected = () => { linear ||= e.g.alloc(w * h * 4); e.g.x.gfx_deswizzle(desc, 0, 0, addr, linear, w * 4, 1); return e.g.u8.slice(linear, linear + w * h * 4); };
  const host = async () => (await e.read(e.serial(tex))).data;
  return { tex, id: G.texId(tex), addr, size, expected, host, flush: (off = 0, n = size) => G.c("MemoryPoolFlushMappedRange", [pool!.obj, addr - pool!.mem + off, n]) };
}
type Tex = ReturnType<typeof cpuTexture>;
// One submission that samples each of the textures (a draw each), and the picture
async function use(e: Env, prog: number, sampler: number, texs: Tex[]) {
  return frame(e, (cmd, target) => { e.frame(cmd, target, prog); e.G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); for (const x of texs) { e.bindTexture(cmd, x.id, sampler); e.drawQuad(cmd); } });
}
const pattern = (e: Env, x: Tex, mul: number) => { const u8 = e.g.u8; for (let k = 0; k < x.size; k++) u8[x.addr + k] = (k * mul) & 255; };

export const scenes5: Scene[] = [
  ...[true, false].map((on): Scene => ({ name: `tex_flush_upload ${on ? "on" : "off"}: a texture filled in place and published by a pool flush, rewritten where no probe looks and flushed again with a submission in between: ${on ? "the new texels are shown; a flush over a texture the GPU wrote gives it back to the CPU only when the CPU wrote" : "the flush is forgotten (the blind spot without the key)"}`, async run(e, t) {
    const G = e.G, x = e.g.x, prog = await e.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    if (on) x.gfx_set_profile(PROFILE.TEX_FLUSH);
    const pool = G.pool(4 << 20, CPU), a = cpuTexture(e, pool, 64, 64);
    t.eq(wstat(e)[5], on ? 1 : 0, "registered: the texture in the pool the CPU writes, not the window's");
    // fill, flush, sample
    pattern(e, a, 13); a.flush();
    let img = await use(e, prog, nearest, [a]), was = a.expected();
    t.ok(same(img.data, was) && same(await a.host(), was), "frame 1: the storage as the game filled it"); t.eq(e.stat(8), 1, "uploaded once");
    // rewrite a byte no probe of the sampled hash covers, flush, and submit something else before the texture is used again
    e.g.u8[a.addr + 501] ^= 0xff; a.flush(501, 1);
    let now = a.expected();
    t.ok(!same(now, was), "the rewrite changes a texel");
    await frame(e, (cmd, target) => { G.targets(cmd, [target]); G.clear(cmd, [0, 0, 0, 1]); });
    img = await use(e, prog, nearest, [a]);
    if (!on) {
      t.ok(same(img.data, was), "without the key the flush was forgotten at the submission in between: the old texel is shown"); t.eq([e.stat(8), wstat(e)[4]], [1, 0], "not uploaded again");
      t.noRed(e); return;
    }
    t.ok(same(img.data, now), "frame 2: rewritten and flushed (one byte of it), shown after an unrelated submission"); t.eq([e.stat(8), e.stat(12), wstat(e)[4]], [2, 1, 2], "published a second time, found by the full hash, uploaded again");
    // many flushes of other ranges in the same interval, and one that touches the texture: it is still found
    // (full hashes a frame: the replayer also asks for one of each vertex and index range it has cached)
    const fulls = async () => { const n = e.stat(11); img = await use(e, prog, nearest, [a]); return e.stat(11) - n; };
    const quiet = await fulls();
    e.g.u8[a.addr + 777] ^= 0xff; was = now; now = a.expected();
    for (let k = 0; k < 20; k++) G.c("MemoryPoolFlushMappedRange", [pool.obj, (2 << 20) + k * 4096, 64]);
    a.flush(700, 100);
    const found = await fulls();
    t.ok(same(img.data, now), "frame 3: 21 flushes, one over the texture"); t.eq([e.stat(8), found - quiet], [3, 2], "uploaded again: two full hashes of it, the check and the upload's");
    // flushes that do not touch it cost it nothing but the sampled hash, however many there are
    for (let k = 0; k < 20; k++) G.c("MemoryPoolFlushMappedRange", [pool.obj, (2 << 20) + k * 4096, 64]);
    t.eq([await fulls() - quiet, e.stat(8)], [0, 3], "20 flushes beside the texture: no full hash of it");
    // the GPU writes the texture: a flush over it with nothing written leaves it the GPU's
    await frame(e, (cmd, target) => { G.targets(cmd, [a.tex]); G.clear(cmd, [1, 0, 0, 1]); });
    t.eq(x.gfx_tex_state(a.tex), 2, "rendered into: GpuOwned");
    a.flush();
    img = await use(e, prog, nearest, [a]);
    t.rect(img, 0, 0, 64, 64, RED, "a flush with no CPU write: still what the GPU drew"); t.eq([x.gfx_tex_state(a.tex), wstat(e)[0]], [2, 0], "still GpuOwned");
    // the CPU fills it again and flushes: the CPU's content replaces the GPU's
    pattern(e, a, 29); a.flush(); now = a.expected();
    img = await use(e, prog, nearest, [a]);
    t.ok(same(img.data, now), "filled again and flushed: the CPU's texels"); t.eq([x.gfx_tex_state(a.tex), wstat(e)[0], e.stat(8)], [1, 1, 4], "taken back from the GPU: Uploaded");
    // published while it is the GPU's, and the next thing is a GPU write that keeps what it does not cover: the CPU's
    // texels go up first, then the write
    await frame(e, (cmd, target) => { G.targets(cmd, [a.tex]); G.clear(cmd, [1, 0, 0, 1]); });
    pattern(e, a, 7); a.flush(); now = a.expected();
    img = await frame(e, (cmd, target) => {
      G.targets(cmd, [a.tex]); G.c("CommandBufferSetScissor", [cmd, 0, 0, 32, 64]); G.clear(cmd, [0, 1, 0, 1]); G.c("CommandBufferSetScissor", [cmd, 0, 0, 64, 64]);
      e.frame(cmd, target, prog); G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]); e.bindTexture(cmd, a.id, nearest); e.drawQuad(cmd);
    });
    t.rect(img, 0, 0, 32, 64, GREEN, "the scissored clear");
    let right = true; for (let y = 0; y < 64 && right; y++) for (let k = 32 * 4; k < 64 * 4; k++) if (img.data[y * 256 + k] !== now[y * 256 + k]) { right = false; break; }
    t.ok(right, "beside it: the texels the CPU published before the clear"); t.eq([x.gfx_tex_state(a.tex), wstat(e)[0]], [2, 2], "the GPU's again");
    t.noRed(e);
  } })),

  { name: "tex_dirty_upload: a texture rewritten in place with no NVN call shows the new content at the next draw; one outside the registered set does not; two 8 MB textures share the scanner's 4 MB a submission; a texture that is no longer used gives the scanner up", async run(e, t) {
    const G = e.G, x = e.g.x, prog = await e.program("vs_quad", "fs_tex"), nearest = G.sampId(FILTER.NEAREST, FILTER.NEAREST);
    x.gfx_set_profile(PROFILE.TEX_FLUSH | PROFILE.TEX_DIRTY);
    const pool = G.pool(20 << 20, CPU), small = cpuTexture(e, pool, 64, 64), plain = cpuTexture(e, undefined, 64, 64);
    pattern(e, small, 13); pattern(e, plain, 17);
    await use(e, prog, nearest, [plain, small]);
    let wasS = small.expected(), wasP = plain.expected();
    t.ok(same(await small.host(), wasS) && same(await plain.host(), wasP), "frame 1: both uploaded"); t.eq([e.stat(8), wstat(e)[5]], [2, 1], "one of the two is registered (the other's pool is not the CPU's to write)");
    await use(e, prog, nearest, [plain, small]);
    t.eq([e.stat(8), wstat(e)[2], wstat(e)[3], wstat(e)[6]], [2, 1, 0, small.size], "frame 2, nothing written: the registered one was hashed in full (16 KB), nothing found");
    // the game writes both where no probe of the sampled hash looks, and tells nobody
    e.g.u8[small.addr + 501] ^= 0xff; e.g.u8[plain.addr + 501] ^= 0xff;
    const nowS = small.expected(), nowP = plain.expected();
    t.ok(!same(nowS, wasS) && !same(nowP, wasP), "both rewrites change a texel");
    const img = await use(e, prog, nearest, [plain, small]);
    t.ok(same(img.data, nowS), "the next draw shows the registered texture's new content"); t.ok(same(await small.host(), nowS), "its host copy too");
    t.ok(same(await plain.host(), wasP), "the other keeps its old texel (as without the key: found by a probe, a flush or the periodic full hash)");
    t.eq([e.stat(8), wstat(e)[2], wstat(e)[3]], [3, 2, 1], "one scan found it, one upload");
    // two 8 MB textures drawn every frame with the small one: 16 MB to scan, 4 MB a submission
    const big = [cpuTexture(e, pool, 2048, 1024), cpuTexture(e, pool, 2048, 1024)], all = [small, ...big];
    for (const b of big) { e.g.u8.fill(0x40, b.addr, b.addr + b.size); e.g.u8[b.addr + 4096] = 1; }
    t.eq(big[0].size, 8 << 20, "8 MB of storage each");
    await use(e, prog, nearest, all);
    t.eq(e.stat(8), 5, "the two uploaded");
    const scanned: number[] = [];
    for (let k = 0; k < 6; k++) { await use(e, prog, nearest, all); scanned.push(wstat(e)[6]); }
    t.ok(scanned.every(n => n <= 4 << 20) && scanned.filter(n => n === 4 << 20).length >= 4, `never more than 4 MB a submission: ${scanned.map(n => (n / 1048576).toFixed(2)).join(", ")} MB`);
    e.g.u8[big[1].addr + big[1].size - 1000] ^= 0xff;                 // near the end of the second one, between two probes
    const want = big[1].expected(), uploads = e.stat(8), top = e.g.top;
    let frames = 0, ms = 0, lastMs = 0;
    while (e.stat(8) === uploads && frames < 20) {
      e.g.top = top; G.c("CommandBufferAddCommandMemory", [G.cmd, G.cmdPool.obj, 0, G.cmdPool.size]);
      const i = G.acquire(e.win); G.begin(); e.frame(G.cmd, e.wtex[i], prog); for (const b of all) { e.bindTexture(G.cmd, b.id, nearest); e.drawQuad(G.cmd); }
      const h = G.end(), t0 = performance.now(); G.submit([h]); lastMs = performance.now() - t0; ms += lastMs; G.present(e.win, i); frames++;
      await e.settle();
    }
    // a round over 16 MB is 5 submissions; a write behind the scanner's position waits for the next round
    t.ok(frames >= 1 && frames <= 10, `the rewrite of the 8 MB texture was found after ${frames} submissions (two rounds of the scanner are 10)`);
    t.ok(same(await big[1].host(), want), "and uploaded");
    const t1 = performance.now(), reps = 20; for (let k = 0; k < reps; k++) x.gfx_hash(big[0].addr, 4 << 20);
    const hashMs = (performance.now() - t1) / reps;
    console.log(`tex_dirty_upload: 16 MB of registered textures in use, 4 MB hashed a submission (${hashMs.toFixed(2)} ms for 4 MB here, ${(4 / 1024 / hashMs * 1000).toFixed(1)} GB/s); the rewrite was found after ${frames} submissions; a submission of the three draws with 4 MB scanned took ${frames > 1 ? ((ms - lastMs) / (frames - 1)).toFixed(2) : "?"} ms (recorder + replayer); the one that found it, with 8 MB deswizzled and uploaded, ${lastMs.toFixed(1)} ms`);
    // the big ones are no longer drawn while one of them has the scanner: the small one gets it within three submissions
    await use(e, prog, nearest, all);
    e.g.u8[small.addr + 777] ^= 0xff;
    const nowS2 = small.expected(), up2 = e.stat(8);
    let n = 0; for (; n < 6 && e.stat(8) === up2; n++) await use(e, prog, nearest, [small]);
    t.ok(n <= 3, `a texture that is no longer used gives the scanner up: found after ${n} submissions`); t.ok(same(await small.host(), nowS2), "shown");
    t.noRed(e);
  } },
];
