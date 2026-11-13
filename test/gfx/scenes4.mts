// More scenes of `npm run gfx:test` (browser): what a game's profile switches on (src/gfx/profile.ts): conditional
// rendering and counter reports (render_cond), textures published by a pool flush (tex_flush_upload), textures
// rewritten in memory with no NVN call (tex_dirty_upload), timestamp reports by segment (gpu_timestamps).
import { Env } from "./env.mts";
import { FMT, STAGE, FILTER, POOL_FLAGS, SIZEOF } from "./nvn.mts";
import { type Scene, T, RED, GREEN, BLUE, YELLOW, uboProgram, ubo, bindUbos } from "./scenes.mts";

export const PROFILE = { RENDER_COND: 1, TEX_FLUSH: 2, TEX_DIRTY: 4, TS_SEGMENT: 8, PRESENT_DISPLAY: 16 };
const BLACK = [0, 0, 0, 255];
const COND = { EQUAL: 0, NOT_EQUAL: 1 }, COUNTER = { TIMESTAMP: 0, SAMPLES_PASSED: 1, TIMESTAMP_TOP: 0x10 };
// The guest clock the replayer is given: a scene sets it, so the times reports take are exact
let fake = 0n;
const clock = () => fake;
// a clock that moves by 1 ms every time it is read: the order of the replayer's readings is what a scene checks
let stepping = 0n;
const stepClock = () => (stepping += 1_000_000n);
export const ticks = (ns: bigint) => ns * 384n / 625n;         // 614.4 MHz
const u64 = (e: Env, a: number) => Number(e.g.dv.getBigUint64(a, true));
const nticks = (ns: bigint) => Number(ticks(ns));
const setU64 = (e: Env, a: number, v: bigint) => e.g.dv.setBigUint64(a, v, true);
const LEFT = [0.5, 1, -0.5, 0, 0, 0, 0, 0], FULL = [1, 1, 0, 0, 0, 0, 0, 0];
// One frame of the scene's commands into the next window image; the picture
export async function frame(e: Env, body: (cmd: number, target: number) => void): Promise<Awaited<ReturnType<Env["read"]>>> {
  const G = e.G;
  G.c("CommandBufferAddCommandMemory", [G.cmd, G.cmdPool.obj, 0, G.cmdPool.size]);
  const i = G.acquire(e.win);
  G.begin(); body(G.cmd, e.wtex[i]); e.finish(i);
  return e.read();
}
const stats = (e: Env) => Array.from({ length: 8 }, (_, i) => e.g.x.gfx_report_stat(i) >>> 0);

export const scenes4: Scene[] = [
  { name: "render_cond: SetRenderEnable and SetRenderEnableConditional evaluated at submit: clears and draws under a false condition are skipped; a report on its way counts as the 0 it will write; a write in the stream; a counter that is not counted", host: { now: clock, timestampQuery: false }, async run(e, t) {
    const G = e.G, x = e.g.x, prog = await uboProgram(e);
    x.gfx_set_profile(PROFILE.RENDER_COND);
    const red = ubo(e, [1, 0, 0, 1]), green = ubo(e, [0, 1, 0, 1]), left = ubo(e, LEFT), full = ubo(e, FULL);
    const rec = G.put(new Uint8Array(64)), rec2 = G.put(new Uint8Array(64));
    fake = 1_000_000_000n;
    // SetRenderEnable(false) ... SetRenderEnable(true): the draw and the clear between them are dropped
    let img = await frame(e, (cmd, target) => {
      e.frame(cmd, target, prog); G.clear(cmd, [0, 0, 0, 1]);
      G.c("CommandBufferSetRenderEnable", [cmd, 0]);
      bindUbos(e, cmd, full, red); e.drawQuad(cmd); G.clear(cmd, [1, 1, 0, 1]);
      G.c("CommandBufferSetRenderEnable", [cmd, 1]);
      bindUbos(e, cmd, left, green); e.drawQuad(cmd);
    });
    t.rect(img, 0, 0, 32, 64, GREEN, "the draw after SetRenderEnable(true)"); t.rect(img, 32, 0, 64, 64, BLACK, "the disabled draw and clear did nothing");
    t.eq(stats(e).slice(5, 7), [1, 1], "one draw and one clear skipped"); t.eq(e.stat(1), 1, "one draw lowered");
    // A game that clears a target only when it needs it: the CPU sets the record's counter to 1, the clear runs under
    // "render if the counters at rec and rec + 16 differ", and a timestamp report after it puts 0 there again
    const scene = (cmd: number, target: number, second?: number[]) => {
      e.frame(cmd, target, prog); G.clear(cmd, [1, 0, 0, 1]); bindUbos(e, cmd, left, green); e.drawQuad(cmd);
      G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.NOT_EQUAL, rec]); G.clear(cmd, [0, 0, 1, 1]);
      G.c("CommandBufferReportCounter", [cmd, COUNTER.TIMESTAMP_TOP, rec]);
      G.c("CommandBufferSetRenderEnable", [cmd, 1]);
      if (second) { G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.NOT_EQUAL, rec]); G.clear(cmd, second); G.c("CommandBufferSetRenderEnable", [cmd, 1]); }
    };
    setU64(e, rec, 1n); setU64(e, rec + 8, 77n);
    G.c("CommandBufferAddCommandMemory", [G.cmd, G.cmdPool.obj, 0, G.cmdPool.size]);
    let i = G.acquire(e.win); G.begin(); scene(G.cmd, e.wtex[i]); e.finish(i);
    t.eq([u64(e, rec), u64(e, rec + 8), x.gfx_reports_pending()], [1, 77, 1], "the report is on its way: memory is as the CPU left it");
    fake = 2_000_000_000n;
    img = await e.read(); await e.settle();
    t.rect(img, 0, 0, 64, 64, BLUE, "frame 1: 1 != 0, the conditional clear ran");
    t.eq([u64(e, rec), u64(e, rec + 8), x.gfx_reports_pending()], [0, nticks(2_000_000_000n), 0], "landed: counter 0 (as the GPU writes it), the time in 614.4 MHz ticks");
    t.eq(G.c("DeviceGetTimestampInNanoseconds", [G.dev, rec]), 2_000_000_000, "nvnDeviceGetTimestampInNanoseconds of the record");
    x.gfx_set_now(2_500_000_000n); t.eq(G.c("DeviceGetCurrentTimestampInNanoseconds", [G.dev]), 2_500_000_000, "nvnDeviceGetCurrentTimestampInNanoseconds: the guest clock");
    img = await frame(e, scene); await e.settle();
    t.rect(img, 0, 0, 32, 64, GREEN, "frame 2: 0 == 0, the clear is skipped and what was drawn stays"); t.rect(img, 32, 0, 64, 64, RED, "frame 2, right");
    // the report of this submission is still on its way when a second condition reads the record: it counts as 0
    // although memory still holds the CPU's 1
    setU64(e, rec, 1n);
    G.c("CommandBufferAddCommandMemory", [G.cmd, G.cmdPool.obj, 0, G.cmdPool.size]);
    i = G.acquire(e.win); G.begin(); scene(G.cmd, e.wtex[i], [1, 1, 0, 1]); e.finish(i);
    t.eq(u64(e, rec), 1, "memory still holds the CPU's 1");
    img = await e.read(); await e.settle();
    t.rect(img, 0, 0, 64, 64, BLUE, "frame 3: the first clear ran, the second (after the report) was skipped"); t.eq(u64(e, rec), 0, "landed");
    // the same two conditions with no report between them: both read the 1
    setU64(e, rec, 1n);
    img = await frame(e, (cmd, target) => {
      e.frame(cmd, target, prog);
      G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.NOT_EQUAL, rec]); G.clear(cmd, [0, 0, 1, 1]); G.c("CommandBufferSetRenderEnable", [cmd, 1]);
      G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.NOT_EQUAL, rec]); G.clear(cmd, [1, 1, 0, 1]); G.c("CommandBufferSetRenderEnable", [cmd, 1]);
    });
    t.rect(img, 0, 0, 64, 64, YELLOW, "frame 4: no report, both clears ran");
    // RENDER_IF_EQUAL, and the state lasting into the next submission
    img = await frame(e, (cmd, target) => {
      e.frame(cmd, target, prog); G.clear(cmd, [0, 0, 0, 1]);
      G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.EQUAL, rec]); bindUbos(e, cmd, full, red); e.drawQuad(cmd);     // 1 == 0: no
    });
    t.rect(img, 0, 0, 64, 64, BLACK, "frame 5: render if equal, 1 against 0"); t.eq(x.gfx_render_enable_state(), 1, "still skipping after the submission");
    img = await frame(e, (cmd, target) => {
      e.frame(cmd, target, prog); bindUbos(e, cmd, full, red); e.drawQuad(cmd);
      G.c("CommandBufferSetRenderEnable", [cmd, 1]); bindUbos(e, cmd, left, green); e.drawQuad(cmd);
    });
    t.rect(img, 0, 0, 32, 64, GREEN, "frame 6: drawn after SetRenderEnable(true)"); t.rect(img, 32, 0, 64, 64, YELLOW, "frame 6: the draw before it was still skipped (the image holds frame 4)");
    // UpdateUniformBuffer over a record whose report is on its way is the later writer of the counter: the condition
    // after it reads the 5, and the report lands only its timestamp
    setU64(e, rec, 1n); fake = 3_000_000_000n;
    img = await frame(e, (cmd, target) => {
      scene(cmd, target);
      G.c("CommandBufferUpdateUniformBuffer", [cmd, rec, 64, 0, 8, e.g.u64([5n])]);
      G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.NOT_EQUAL, rec]); G.clear(cmd, [1, 1, 0, 1]); G.c("CommandBufferSetRenderEnable", [cmd, 1]);
    });
    await e.settle();
    t.rect(img, 0, 0, 64, 64, YELLOW, "frame 7: 5 != 0"); t.eq([u64(e, rec), u64(e, rec + 8)], [5, nticks(3_000_000_000n)], "the write stays, the timestamp landed");
    t.noRed(e);
    // an occlusion query's record: not counted here, so a condition on it is not evaluated and draws
    setU64(e, rec2, 7n);
    img = await frame(e, (cmd, target) => {
      e.frame(cmd, target, prog); G.clear(cmd, [0, 0, 0, 1]);
      G.c("CommandBufferResetCounter", [cmd, COUNTER.SAMPLES_PASSED]); G.c("CommandBufferReportCounter", [cmd, COUNTER.SAMPLES_PASSED, rec2]);
      G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.EQUAL, rec2]); bindUbos(e, cmd, full, red); e.drawQuad(cmd);     // 7 == 0 would be false
      G.c("CommandBufferSetRenderEnable", [cmd, 1]);
    });
    t.rect(img, 0, 0, 64, 64, RED, "a condition on a counter that is not counted draws"); t.eq(u64(e, rec2), 7, "its record is not written");
    t.ok(e.g.red().length === 1 && e.g.red()[0].includes("SAMPLES_PASSED"), "one red line for the uncounted counter");
    const s = stats(e);
    t.eq([s[0], s[1], s[2], s[3], s[4]], [4, 4, 3, 6, 1], "reports issued and landed; conditions false, true, unknown");
    console.log(`render_cond: ${s[0]} reports, conditions ${s[3]} true / ${s[2]} false / ${s[4]} unknown, ${s[5]} draws and ${s[6]} clears skipped`);
  } },
  { name: "render_cond: 20000 occlusion query reports, each at a place of its own (more than the table of uncounted records keeps), then a depth clear under a false condition and a pass with an EQUAL depth test: the clear is still skipped, a condition on a late query still draws", async run(e, t) {
    const G = e.G, x = e.g.x, prog = await uboProgram(e), depth = G.texture({ w: 64, h: 64, format: FMT.DEPTH32F });
    x.gfx_set_profile(PROFILE.RENDER_COND);
    const grey = ubo(e, [0.25, 0.25, 0.25, 1]), green = ubo(e, [0, 1, 0, 1]), quad = ubo(e, [1, 1, 0, 0, 0.5, 0, 0, 0]), rec = G.put(new Uint8Array(64)), N = 20000, q = G.put(new Uint8Array(N * 16));
    const img = await frame(e, (cmd, target) => {
      const st = e.frame(cmd, target, prog, depth);
      for (let i = 0; i < N; i++) G.c("CommandBufferReportCounter", [cmd, COUNTER.SAMPLES_PASSED, q + i * 16]);
      G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0], [1.0]);
      G.c("DepthStencilStateSetDepthTestEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthWriteEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthFunc", [st.ds, 2 /* LESS */]); G.c("CommandBufferBindDepthStencilState", [cmd, st.ds]);
      bindUbos(e, cmd, quad, grey); e.drawQuad(cmd);
      G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.NOT_EQUAL, rec]); G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0], [1.0]); G.c("CommandBufferSetRenderEnable", [cmd, 1]);
      G.c("DepthStencilStateSetDepthWriteEnable", [st.ds, 0]); G.c("DepthStencilStateSetDepthFunc", [st.ds, 3 /* EQUAL */]); G.c("CommandBufferBindDepthStencilState", [cmd, st.ds]);
      // the last query's record holds two equal counters (0, 0) that nothing wrote: a condition on it is unknown and draws
      G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.NOT_EQUAL, q + (N - 1) * 16 - 16]); bindUbos(e, cmd, quad, green); e.drawQuad(cmd); G.c("CommandBufferSetRenderEnable", [cmd, 1]);
    });
    t.rect(img, 0, 0, 64, 64, GREEN, "the opaque pass drew everywhere");
    t.eq(stats(e).slice(2, 7), [1, 0, 1, 0, 1], "the clear's condition false and its clear skipped; the late query's unknown, drawn");
    t.eq(e.g.red().map((l: string) => l.includes("SAMPLES_PASSED") ? "queries" : l.includes("the oldest are forgotten") ? "forgotten" : l), ["queries", "forgotten"], "the two red lines: queries not counted, the oldest forgotten");
  } },
  ...[true, false].map((on): Scene => ({ name: `render_cond ${on ? "on" : "off"}: a depth clear under a condition the console skips, then a pass with an EQUAL depth test: ${on ? "the clear is skipped, the pass draws" : "run unconditionally, the test fails everywhere"}`, async run(e, t) {
    const G = e.G, x = e.g.x, prog = await uboProgram(e), depth = G.texture({ w: 64, h: 64, format: FMT.DEPTH32F });
    if (on) x.gfx_set_profile(PROFILE.RENDER_COND);
    const grey = ubo(e, [0.25, 0.25, 0.25, 1]), green = ubo(e, [0, 1, 0, 1]), quad = ubo(e, [1, 1, 0, 0, 0.5, 0, 0, 0]), rec = G.put(new Uint8Array(64));
    const img = await frame(e, (cmd, target) => {
      const st = e.frame(cmd, target, prog, depth);
      // the depth prepass
      G.clear(cmd, [0, 0, 0, 1]); G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0], [1.0]);
      G.c("DepthStencilStateSetDepthTestEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthWriteEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthFunc", [st.ds, 2 /* LESS */]); G.c("CommandBufferBindDepthStencilState", [cmd, st.ds]);
      bindUbos(e, cmd, quad, grey); e.drawQuad(cmd);
      // the engine clears the depth again, under a condition that is false (both counters 0, render if not equal)
      G.c("CommandBufferSetRenderEnableConditional", [cmd, COND.NOT_EQUAL, rec]); G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0], [1.0]); G.c("CommandBufferSetRenderEnable", [cmd, 1]);
      // the opaque pass: the same geometry, drawn where the depth is equal
      G.c("DepthStencilStateSetDepthWriteEnable", [st.ds, 0]); G.c("DepthStencilStateSetDepthFunc", [st.ds, 3 /* EQUAL */]); G.c("CommandBufferBindDepthStencilState", [cmd, st.ds]);
      bindUbos(e, cmd, quad, green); e.drawQuad(cmd);
    });
    if (on) { t.rect(img, 0, 0, 64, 64, GREEN, "the opaque pass drew everywhere"); t.eq(stats(e).slice(2, 7), [1, 0, 0, 0, 1], "one condition, false: one clear skipped"); t.noRed(e); }
    else {
      t.rect(img, 0, 0, 64, 64, [64, 64, 64, 255], "the opaque pass drew nothing: only the prepass colour");
      t.eq(e.g.red(), ["[RED] SetRenderEnableConditional: the host draws anyway (the game profile's render_cond is off)"], "the red line that says so"); t.eq(stats(e).slice(2, 7), [0, 0, 0, 0, 0], "nothing evaluated");
    }
  } })),

  // A frame as a game that times its GPU work records it: TIMESTAMP_TOP first, 70 draws into an offscreen target, a
  // TIMESTAMP, the window as target with 3 more draws, a TIMESTAMP at the end. The replayer's clock moves 1 ms at each
  // reading, and it reads it once when it hands a segment to the GPU and once when the GPU reports the segment done
  ...[true, false].map((segment): Scene => ({ name: `gpu_timestamps ${segment ? "segment: the submission is cut at the target change after 64 draws, TIMESTAMP_TOP takes the GPU start of its segment and the others the end of theirs" : "submission (the default): one time for every report of the submission, so a game reads a GPU time of 0"} (times estimated on the CPU, a clock the scene steps)`,
    host: { now: stepClock, timestampQuery: false }, async run(e, t) {
    const G = e.G, x = e.g.x, prog = await uboProgram(e), off = G.texture({ w: 64, h: 64, format: FMT.RGBA8 });
    if (segment) x.gfx_set_profile(PROFILE.TS_SEGMENT);
    const full = ubo(e, FULL), green = ubo(e, [0, 1, 0, 1]), rec = G.put(new Uint8Array(64)), T0 = 10_000_000_000n, ms = (n: number) => nticks(T0 + BigInt(n) * 1_000_000n);
    t.eq(e.host.timestampSource, "cpu", "this replayer was told not to use timestamp queries");
    stepping = T0;
    const img = await frame(e, (cmd, target) => {
      G.c("CommandBufferReportCounter", [cmd, COUNTER.TIMESTAMP_TOP, rec]);
      e.frame(cmd, off, prog); G.clear(cmd, [0, 0, 0, 1]); bindUbos(e, cmd, full, green);
      for (let k = 0; k < 70; k++) e.drawQuad(cmd);
      G.c("CommandBufferReportCounter", [cmd, COUNTER.TIMESTAMP, rec + 16]);
      e.frame(cmd, target, prog); G.clear(cmd, [0, 0, 0, 1]); bindUbos(e, cmd, full, green);
      for (let k = 0; k < 3; k++) e.drawQuad(cmd);
      G.c("CommandBufferReportCounter", [cmd, COUNTER.TIMESTAMP, rec + 32]);
    });
    await e.settle();
    t.rect(img, 0, 0, 64, 64, GREEN, "the frame");
    const got = [0, 16, 32].map(o => u64(e, rec + o + 8)), gpuMs = (got[2] - got[0]) * 625 / 384 / 1e6;
    if (segment) {
      // readings: 1 the first segment handed over, 2 the second (the present of a scene has no canvas and hands
      // nothing over); then done: 3, 4. The second segment starts when the first is done (3), not when it was handed over (2)
      t.eq(got, [ms(1), ms(3), ms(4)], "TIMESTAMP_TOP: the start of the first segment; the report after the 70 draws: its end; the last: the end of the second");
      t.eq([x.gfx_report_stat(7), Math.round(gpuMs * 1e6) / 1e6], [1, 3], "one cut; the game reads 3 ms of GPU time for its frame");
    } else {
      // readings: 1 the submission handed over; then done: 2
      t.eq(got, [ms(2), ms(2), ms(2)], "every report: when the submission was done");
      t.eq([x.gfx_report_stat(7), gpuMs], [0, 0], "no cut; the game reads 0");
    }
    t.eq([0, 16, 32].map(o => u64(e, rec + o)), got, "the counter field of a timestamp report is the time too (no render_cond)");
    t.eq([x.gfx_report_stat(0), x.gfx_report_stat(1), e.host.reportsGpuTimed], [3, 3, 0], "three reports, landed, none from GPU stamps"); t.noRed(e);
  } })),
  { name: "gpu_timestamps segment with WebGPU timestamp queries (where the device has them): the reports are in order, the last is the moment the GPU was done, and the first lies the frame's GPU time before it", host: { now: clock }, async run(e, t) {
    const G = e.G, x = e.g.x, prog = await uboProgram(e), off = G.texture({ w: 64, h: 64, format: FMT.RGBA8 });
    x.gfx_set_profile(PROFILE.TS_SEGMENT);
    const full = ubo(e, FULL), green = ubo(e, [0, 1, 0, 1]), rec = G.put(new Uint8Array(64));
    fake = 20_000_000_000n;
    const has = !!e.host.device.features?.has?.("timestamp-query");
    t.eq(e.host.timestampSource, has ? "gpu" : "cpu", "the source follows the device's features");
    for (let f = 0; f < 3; f++) {
      await frame(e, (cmd, target) => {
        G.c("CommandBufferReportCounter", [cmd, COUNTER.TIMESTAMP_TOP, rec]);
        e.frame(cmd, off, prog); G.clear(cmd, [0, 0, 0, 1]); bindUbos(e, cmd, full, green);
        for (let k = 0; k < 70; k++) e.drawQuad(cmd);
        G.c("CommandBufferReportCounter", [cmd, COUNTER.TIMESTAMP, rec + 16]);
        e.frame(cmd, target, prog); G.clear(cmd, [0, 0, 0, 1]); bindUbos(e, cmd, full, green); e.drawQuad(cmd);
        G.c("CommandBufferReportCounter", [cmd, COUNTER.TIMESTAMP, rec + 32]);
      });
      await e.settle();
      const got = [0, 16, 32].map(o => u64(e, rec + o + 8)), ns = (v: number) => v * 625 / 384;
      t.ok(got[0] <= got[1] && got[1] <= got[2], `frame ${f}: in order (${got})`);
      t.eq(got[2], nticks(fake), "the last report's segment ended when the GPU reported the work done: the guest clock then");
      const gpuMs = (ns(got[2]) - ns(got[0])) / 1e6, firstMs = (ns(got[1]) - ns(got[0])) / 1e6;
      t.ok(gpuMs >= 0 && gpuMs < 5000, `a GPU time of ${gpuMs} ms`);
      if (f === 2) console.log(has ? `timestamp-query: the frame's GPU time reads ${gpuMs.toFixed(2)} ms, its first segment (70 draws) ${firstMs.toFixed(2)} ms; ${e.host.reportsGpuTimed} of 9 reports took the GPU's stamps` : "SKIPPED: this device has no timestamp-query; the reports took the CPU's estimate");
      fake += 16_666_667n;
    }
    if (has) t.eq(e.host.reportsGpuTimed, 9, "every report took the GPU's stamps");
    t.eq(x.gfx_report_stat(7), 3, "one cut a frame"); t.noRed(e);
  } },
];
