// The frame ledger (src/glue/gfx_ledger.ts) on the recorder's own stream, without a GPU: every skipped draw and
// dispatch is counted with its reason (shader unknown, pending, failed; no program; render condition), each key that
// skipped work is listed in the order it was first needed, and the presented image's first writer is named (or "none").
// Then synthetic records for what needs a replayer: a draw it drops, a copy into the presented image, the bounds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test, WASM } from "./harness.mts";
import { Game, FMT, PRIM, STAGE_BITS } from "./nvn.mts";
import { Guest } from "./guest.mts";
import { FrameLedger, FRAMES, KEYS } from "../../src/glue/gfx_ledger.ts";

const RENDER_COND = 1;
// a stage as the recorder keys it (test/gfx/env.mts blobs): control section 0x880 bytes, code length at +0x704
function stage(G: Game, name: string) {
  const control = new Uint8Array(0x880), code = new Uint8Array(96 + name.length);
  for (let i = 0; i < control.length; i++) control[i] = (i * 31 + name.charCodeAt(i % name.length)) & 0xff;
  for (let i = 0; i < code.length; i++) code[i] = (i * 7 + name.charCodeAt(i % name.length) * 3) & 0xff;
  new DataView(control.buffer).setUint32(0x20, 0, true); new DataView(control.buffer).setUint32(0x704, code.length, true);
  const key = createHash("sha256").update(control).update(code).digest().subarray(0, 8);
  return { control: G.g.bytes(control), code: G.put(code), key: key.toString("hex"), lo: key.readUInt32LE(0), hi: key.readUInt32LE(4) };
}
async function setup() {
  const led = new FrameLedger(() => 0);
  let g: Guest | undefined;
  g = await Guest.create(readFileSync(WASM), { gfx_exec: (p: number, n: number) => led.walk(new DataView(g!.memory.buffer), Number(p), Number(n)) });
  return { g, G: new Game(g).init(), led };
}

test("frame ledger: skipped draws and dispatches by reason, every key in first-use order, no writer of the presented image", async () => {
  const { g, G, led } = await setup(), x = g.x, cmd = G.cmd;
  x.gfx_set_profile(RENDER_COND);
  const { win, tex } = G.window(64, 64);
  const vs = stage(G, "vs_unknown"), fsP = stage(G, "fs_pending"), fsF = stage(G, "fs_failed"), cs = stage(G, "cs_unknown");
  x.gfx_shader_pending(fsP.lo, fsP.hi, 1); x.gfx_shader_pending(fsF.lo, fsF.hi, 2);
  const progP = G.program([vs, fsP]), progF = G.program([vs, fsF]), progC = G.program([cs]);
  const frame = (draw: boolean) => {
    const i = G.acquire(win);
    G.begin(); G.targets(cmd, [tex[i]]); G.defaultStates(cmd); G.clear(cmd, [0, 0, 0, 1]);
    if (draw) {
      G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]);                                  // no program bound
      G.c("CommandBufferBindProgram", [cmd, progP, STAGE_BITS.VERTEX | STAGE_BITS.FRAGMENT]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]);
      G.c("CommandBufferBindProgram", [cmd, progF, STAGE_BITS.VERTEX | STAGE_BITS.FRAGMENT]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]);
      G.c("CommandBufferSetRenderEnable", [cmd, 0]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]); G.c("CommandBufferSetRenderEnable", [cmd, 1]);
      G.c("CommandBufferBindProgram", [cmd, progC, STAGE_BITS.COMPUTE]); G.c("CommandBufferDispatchCompute", [cmd, 1, 1, 1]);
    }
    G.submit([G.end()]); G.present(win, i);
  };
  frame(true); frame(false);
  assert.equal(led.framesSeen, 2);
  assert.equal(led.frames[0].replace(/tex#\d+/, "tex#N"), "frame 1 (t 0.00 s): draws 0 issued, 5 skipped (shader failed 2, render condition false 1, shader pending 1, unsupported state 1); dispatches 0 issued, 1 skipped (shader unknown 1); presented tex#N, first non-clear write: none");
  assert.equal(led.frames[1].replace(/tex#\d+/, "tex#N"), "frame 2 (t 0.00 s): draws 0 issued, 0 skipped; dispatches 0 issued, 0 skipped; presented tex#N, first non-clear write: none");
  assert.equal(led.firstDrawn, "");
  assert.deepEqual(led.keyLines(), [
    `unknown (2): ${vs.key} (frame 1, t 0.00 s, draw #2; skipped 3 draws, 0 dispatches), ${cs.key} (frame 1, t 0.00 s, dispatch #1; skipped 0 draws, 1 dispatches)`,
    `pending (1): ${fsP.key} (frame 1, t 0.00 s, draw #2; skipped 1 draws, 0 dispatches)`,
    `failed (1): ${fsF.key} (frame 1, t 0.00 s, draw #3; skipped 2 draws, 0 dispatches)`]);
  assert.deepEqual(led.keyLines(k => k === fsF.key ? "naga: no entry point" : undefined, k => k === fsP.key ? "ready" : undefined).slice(1),
    [`pending then, ready now (1): ${fsP.key} (frame 1, t 0.00 s, draw #2; skipped 1 draws, 0 dispatches)`, `failed: naga: no entry point (1): ${fsF.key} (frame 1, t 0.00 s, draw #3; skipped 2 draws, 0 dispatches)`]);
  for (const l of g.red()) assert.ok(l.startsWith("[RED] "), l);
  assert.ok(g.red().some(l => l.includes(vs.key)), "the unknown key is reported red");
});

// host records by hand: [op, fields at +8 ...] as u32 words (u64 serials as two words)
function stream(recs: { op: number; size: number; set: (dv: DataView, p: number) => void }[]): DataView {
  const n = recs.reduce((a, r) => a + r.size, 0), dv = new DataView(new ArrayBuffer(n));
  let p = 0; for (const r of recs) { dv.setUint32(p, r.op, true); dv.setUint32(p + 4, r.size, true); r.set(dv, p); p += r.size; }
  return dv;
}
const pass = (serial: number) => ({ op: 3, size: 376, set: (dv: DataView, p: number) => { dv.setUint32(p + 8, 1, true); dv.setUint32(p + 32, serial, true); } });
const END = { op: 4, size: 8, set: () => {} }, DRAW = { op: 14, size: 32, set: () => {} };
const present = (serial: number) => ({ op: 20, size: 48, set: (dv: DataView, p: number) => dv.setUint32(p + 8, serial, true) });
const copy = (src: number, dst: number) => ({ op: 18, size: 96, set: (dv: DataView, p: number) => { dv.setUint32(p + 8, src, true); dv.setUint32(p + 16, dst, true); } });
const skip = (reason: number, kind: number, key = 0) => ({ op: 41, size: 40, set: (dv: DataView, p: number) => { dv.setUint32(p + 8, reason, true); dv.setUint8(p + 12, kind); if (key) { dv.setUint32(p + 16, key, true); dv.setUint8(p + 13, 1); } } });
const feed = (led: FrameLedger, recs: Parameters<typeof stream>[0]) => { const dv = stream(recs); led.walk(dv, 0, dv.byteLength); };

test("frame ledger: the presented image's chain through a copy, a draw the replayer drops, a failed pipeline; bounded", () => {
  let t = 0;
  const led = new FrameLedger(() => t);
  // frame 1: the first draw is dropped by the replayer (no pipeline yet), the second draws into tex#7, which is copied to tex#9 and presented
  const dv = stream([pass(7), DRAW]); led.walk(dv, 0, dv.byteLength); led.dropped("pipeline not built on the host");
  feed(led, [DRAW, skip(2, 0), END, copy(7, 9), present(9)]);
  t = 1500;
  feed(led, [pass(9), END, present(9)]);
  const idle = "draws 0 issued, 0 skipped; dispatches 0 issued, 0 skipped; presented tex#9, first non-clear write: none; last drawn in frame 1 by draw #2 (pass 1) -> tex#7";
  assert.deepEqual(led.frames, [
    "frame 1 (t 0.00 s): draws 1 issued, 2 skipped (pipeline failed 1, pipeline not built on the host 1); dispatches 0 issued, 0 skipped; presented tex#9, first non-clear write: draw #2 (pass 1) -> tex#7",
    `frame 2 (t 1.50 s): ${idle}`]);
  assert.equal(led.firstDrawn, "frame 1 (t 0.00 s): draw #2 (pass 1) -> tex#7");
  assert.equal(led.lastLine, led.frames[1]);
  feed(led, [present(9)]); feed(led, [present(9)]);
  assert.deepEqual(led.frames.slice(1), [`frames 2-4 (t 1.50-1.50 s): ${idle}`], "identical frames are folded");
  assert.equal(led.lastLine, `frame 4 (t 1.50 s): ${idle}`);
  // bounds: FRAMES frame lines, KEYS keys (the rest counted)
  for (let i = 0; i < FRAMES + 10; i++) feed(led, i & 1 ? [present(9)] : [pass(9), DRAW, END, present(9)]);
  assert.equal(led.frames.length, FRAMES);
  const many: Parameters<typeof stream>[0] = [];
  for (let k = 1; k <= KEYS + 5; k++) many.push(skip(0, 1, k));
  feed(led, [...many, present(9)]);
  assert.equal(led.keyUses().length, KEYS);
  assert.equal(led.keysDropped, 5);
  assert.match(led.keyLines().at(-1)!, /^\(5 more keys past the first 16384 are not listed\)$/);
  assert.match(led.lastLine, /dispatches 0 issued, 16389 skipped \(shader pending 16389\)/);
});
