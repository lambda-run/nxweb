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
];
