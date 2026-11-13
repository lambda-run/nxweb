// The keys a frame's draws were skipped for while their stages are on their way (src/gfx/shader.ts waited): every one of a loading frame is handed
// to the embedder, the frame's last draw's among them (area2.gfxcap: 153 stages pending in one frame, the composite pass's the last; with a table of
// 32 the same first 32 came back at every present). And a failed pipeline is said once, however its draws alternate with another's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test, WASM } from "./harness.mts";
import { Game, PRIM, STAGE_BITS } from "./nvn.mts";
import { Guest } from "./guest.mts";

function stage(G: Game, name: string) {
  const control = new Uint8Array(0x880), code = new Uint8Array(96 + name.length);
  for (let i = 0; i < control.length; i++) control[i] = (i * 31 + name.charCodeAt(i % name.length)) & 0xff;
  for (let i = 0; i < code.length; i++) code[i] = (i * 7 + name.charCodeAt(i % name.length) * 3) & 0xff;
  new DataView(control.buffer).setUint32(0x20, 0, true); new DataView(control.buffer).setUint32(0x704, code.length, true);
  const key = createHash("sha256").update(control).update(code).digest().subarray(0, 8);
  return { control: G.g.bytes(control), code: G.put(code), key: key.toString("hex"), lo: key.readUInt32LE(0), hi: key.readUInt32LE(4) };
}

test("pending stages: every key a frame skipped a draw for is handed over, 64 a call, in the order of the draws; none twice", async () => {
  const g = await Guest.create(readFileSync(WASM), { gfx_exec: () => {} }), G = new Game(g).init(), x = g.x, cmd = G.cmd;
  const { win, tex } = G.window(64, 64);
  const N = 90, progs: number[] = [], keys: string[] = [];
  for (let i = 0; i < N; i++) {
    const vs = stage(G, `vs_wait_${i}`), fs = stage(G, `fs_wait_${i}`);
    x.gfx_shader_pending(vs.lo, vs.hi, 1); x.gfx_shader_pending(fs.lo, fs.hi, 1);
    progs.push(G.program([vs, fs])); keys.push(vs.key, fs.key);
  }
  const take = () => {
    const out: string[] = [], sizes: number[] = [];
    for (;;) {
      const n = x.gfx_shader_waited(), u8 = new Uint8Array(g.memory.buffer, Number(x.gfx_scratch()), n * 8);
      if (!n) break;
      sizes.push(n);
      for (let i = 0; i < n; i++) out.push(Array.from(u8.subarray(i * 8, i * 8 + 8), b => b.toString(16).padStart(2, "0")).join(""));
    }
    return { out, sizes };
  };
  const frame = (draws: number) => {
    const i = G.acquire(win);
    G.begin(); G.targets(cmd, [tex[i]]); G.defaultStates(cmd); G.clear(cmd, [0, 0, 0, 1]);
    for (let k = 0; k < draws; k++) for (let twice = 0; twice < 2; twice++) { G.c("CommandBufferBindProgram", [cmd, progs[k], STAGE_BITS.VERTEX | STAGE_BITS.FRAGMENT]); G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]); }
    G.submit([G.end()]); G.present(win, i);
  };
  frame(N);
  const a = take();
  assert.equal(a.out.length, new Set(a.out).size, "no key twice");
  assert.deepEqual([...a.out].sort(), [...keys].sort(), "every pending key of the frame");
  assert.ok(a.sizes.every(n => n <= 64) && a.sizes.length >= 3, `calls of at most 64: ${a.sizes}`);
  assert.ok(a.out.indexOf(keys[0]) < a.out.indexOf(keys[2 * N - 2]) && a.out.indexOf(keys[2 * N - 1]) >= 2 * N - 2, "in the order of the draws: the last draw's stages last");
  assert.deepEqual(take().out, [], "forgotten once handed over");
  // a stage that arrived is not waited for; the others still are
  x.gfx_shader_pending(parseInt(keys[0].match(/../g)!.slice(0, 4).reverse().join(""), 16), parseInt(keys[0].match(/../g)!.slice(4, 8).reverse().join(""), 16), 2);
  frame(2);
  const b = take().out;
  assert.ok(!b.includes(keys[0]) && b.includes(keys[1]) && b.includes(keys[2]) && b.includes(keys[3]) && b.length === 3, `the failed key is not waited for: ${b}`);
});
