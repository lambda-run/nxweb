// Counter reports and render enable without a GPU (src/gfx/report.ts): the records, the timestamp's units, which time
// a report takes in each gpu_timestamps mode, the counter field with and without render_cond. The times are given to
// the recorder as the replayer would give them (gfx_report_land), so every expected value is exact.
import assert from "node:assert/strict";
import { test, guest } from "./harness.mts";
import { Game } from "./nvn.mts";

const P = { RENDER_COND: 1, TS_SEGMENT: 8 }, TOP = 0x10, TIMESTAMP = 0, INPUT_VERTICES = 2;
const ticks = (ns: bigint) => ns * 384n / 625n;
async function game(profile = 0) {
  const g = await guest(), G = new Game(g).init();
  g.x.gfx_set_profile(profile);
  const rec = (n: number) => G.put(new Uint8Array(16 * n).fill(0xEE)), at = (a: number) => [g.dv.getBigUint64(a, true), g.dv.getBigUint64(a + 8, true)];
  // one submission of the given reports: [type, address]
  const submit = (reports: [number, number][]) => { G.c("CommandBufferAddCommandMemory", [G.cmd, G.cmdPool.obj, 0, G.cmdPool.size]); G.begin(); for (const [t, a] of reports) G.c("CommandBufferReportCounter", [G.cmd, t, a]); G.submit([G.end()]); };
  return { g, G, x: g.x, rec, at, submit };
}

test("counter reports: record sizes; SetRenderEnable(Conditional) is recorded only with render_cond, and says so once without", async () => {
  for (const profile of [0, P.RENDER_COND]) {
    const { g, G } = await game(profile), sizes: number[] = [];
    const used = (f: () => void) => { const b = G.used(); f(); sizes.push(G.used() - b); };
    G.begin();
    used(() => G.c("CommandBufferReportCounter", [G.cmd, TOP, 0x1000]));
    used(() => G.c("CommandBufferResetCounter", [G.cmd, 1]));
    used(() => G.c("CommandBufferSetRenderEnable", [G.cmd, 0]));
    used(() => G.c("CommandBufferSetRenderEnable", [G.cmd, 1]));
    used(() => G.c("CommandBufferSetRenderEnableConditional", [G.cmd, 1, 0x1000]));
    used(() => G.c("CommandBufferSetRenderEnableConditional", [G.cmd, 0, 0x1000]));
    G.end();
    // nxnative: OP_REPORT_COUNTER 24 bytes, OP_RESET_COUNTER 16, OP_RENDER_COND 8 + sizeof(p_render_cond) = 24
    assert.deepEqual(sizes, profile ? [24, 16, 24, 24, 24, 24] : [24, 16, 0, 0, 0, 0]);
    assert.deepEqual(g.red(), profile ? [] : ["[RED] SetRenderEnable(false): the host draws anyway (the game profile's render_cond is off)", "[RED] SetRenderEnableConditional: the host draws anyway (the game profile's render_cond is off)"]);
  }
});

test("counter reports: a timestamp is 614.4 MHz ticks of the guest clock (384 ticks per 625 ns), exact over long uptimes; nvnDeviceGetTimestampInNanoseconds", async () => {
  const { G, x, rec, at, submit } = await game();
  const r = rec(1);
  let id = 0;
  for (const ns of [0n, 1n, 625n, 16_666_667n, 1_000_000_000n, 86_400_000_000_000n * 400n, (1n << 62n) + 12345n]) {
    submit([[TIMESTAMP, r]]); id++;
    assert.deepEqual(at(r).slice(0, 2).length, 2);
    x.gfx_report_land(id, ns, ns, ns);
    assert.deepEqual(at(r), [ticks(ns), ticks(ns)], `${ns} ns`);
    // back to nanoseconds: within one tick (1.63 ns)
    const back = BigInt.asUintN(64, x.nvn_call(G.g.id("nvnDeviceGetTimestampInNanoseconds"), argsOf(G, [G.dev, r])));
    assert.ok(ns - back >= 0n && ns - back <= 2n, `${ns} ns came back as ${back}`);
  }
  assert.equal(ticks(16_666_667n), 10_240_000n);       // a 60 Hz frame
  assert.deepEqual([x.gfx_report_stat(0), x.gfx_report_stat(1), x.gfx_reports_pending()], [7, 7, 0]);
});
// an argument block for a raw nvn_call (a 64-bit result does not fit Guest.call's number)
function argsOf(G: Game, ints: number[]): number { const a = G.g.alloc(128); ints.forEach((v, i) => G.g.dv.setBigUint64(a + i * 8, BigInt(v), true)); return a; }

test("counter reports: gpu_timestamps submission gives every report of a submission its end; segment gives TIMESTAMP_TOP the GPU start of its segment and the others its end", async () => {
  for (const segment of [false, true]) for (const cond of [false, true]) {
    const { x, rec, at, submit } = await game((segment ? P.TS_SEGMENT : 0) | (cond ? P.RENDER_COND : 0));
    const a = rec(3);
    submit([[TOP, a], [TIMESTAMP, a + 16], [INPUT_VERTICES, a + 32]]);
    assert.deepEqual(at(a), [0xEEEEEEEEEEEEEEEEn, 0xEEEEEEEEEEEEEEEEn], "nothing is written before the GPU is done");
    assert.equal(x.gfx_reports_pending(), 3);
    // the frame's first segment ran on the GPU from 100 to 104 ms, its last from 104 to 116 ms; the submission was done at 116.5 ms
    const ms = (v: number) => BigInt(Math.round(v * 1e6));
    x.gfx_report_land(1, ms(100), ms(104), ms(116.5)); x.gfx_report_land(2, ms(104), ms(116), ms(116.5)); x.gfx_report_land(3, ms(104), ms(116), ms(116.5));
    const top = ticks(segment ? ms(100) : ms(116.5)), end = ticks(segment ? ms(116) : ms(116.5));
    // the counter field: the time for a timestamp report, 0 with render_cond (as the GPU writes it); 0 for a counter that is not counted
    assert.deepEqual([at(a), at(a + 16), at(a + 32)], [[cond ? 0n : top, top], [cond ? 0n : end, end], [0n, end]], `segment ${segment}, render_cond ${cond}`);
    // what a game computes from the two: its GPU time
    const gpuMs = Number(at(a + 16)[1] - at(a)[1]) * 625 / 384 / 1e6;
    assert.ok(segment ? Math.abs(gpuMs - 16) < 1e-5 : gpuMs === 0, `GPU time read by the game: ${gpuMs} ms`);
    assert.equal(x.gfx_reports_pending(), 0);
    x.gfx_report_land(2, 1n, 1n, 1n);                    // a second landing of the same report changes nothing
    assert.deepEqual(at(a + 16), [cond ? 0n : end, end]);
  }
});

test("counter reports: an embedder with no GPU lands them itself; more than 4096 on their way: the oldest lands with the latest time known", async () => {
  const { g, x, rec, at, submit } = await game();
  const a = rec(2);
  submit([[TIMESTAMP, a], [TOP, a + 16]]);
  x.gfx_reports_flush(5_000_000n);
  assert.deepEqual([at(a), at(a + 16), x.gfx_reports_pending()], [[ticks(5_000_000n), ticks(5_000_000n)], [ticks(5_000_000n), ticks(5_000_000n)], 0]);
  g.dv.setBigUint64(a, 9n, true); g.dv.setBigUint64(a + 8, 9n, true);
  for (let k = 0; k < 41; k++) submit(Array.from({ length: 100 }, (): [number, number] => [TIMESTAMP, a]));      // 4100 with nobody landing them
  assert.equal(x.gfx_reports_pending(), 4096);
  assert.deepEqual(at(a), [ticks(5_000_000n), ticks(5_000_000n)], "the oldest landed with the latest time");
  assert.deepEqual(g.red(), ["[RED] more than 4096 counter reports are on their way: the oldest lands now with the latest time known"]);
  x.gfx_reports_flush(7_000_000n);
  assert.deepEqual([at(a), x.gfx_reports_pending(), x.gfx_report_stat(0), x.gfx_report_stat(1)], [[ticks(7_000_000n), ticks(7_000_000n)], 0, 4102, 4102]);
  // a record outside guest memory, and an occlusion query
  submit([[TIMESTAMP, 0xFFFF_FFF0], [1, a + 16]]);
  assert.equal(x.gfx_reports_pending(), 0);
  assert.equal(g.red().length, 3);
});
