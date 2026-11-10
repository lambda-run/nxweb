// The Home button's quit machine (src/kit/home_quit.ts, machines home_quit and button_latch).
// First the checks of nxnative's dm/host/tests/t_home_quit.c, in its order and with its words; then the events behind
// them; then a comparison, over random input, with home_quit.h itself.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, fresh, def, S, ROOT, type Kit } from "./harness.mts";
import { readTrace, formatRecord } from "../../src/kit/host/reader.mts";

const HQ = def("home_quit"), LATCH = def("button_latch");
const [IDLE, HOLDING, PROMPT, SETTLE, QUIT] = ["Idle", "Holding", "Prompt", "Settle", "Quit"].map(s => S(HQ, s));
const HOLD_S = 2.0, RING_S = 0.3;

function hq(k: Kit = fresh(), i = 0) {
  k.x.hq_init(i);
  return {
    k,
    step: (now: number, home: number, a: number, b: number) => k.x.hq_step(i, now, home, a, b),
    cancel: () => k.x.hq_cancel(i),
    ring: (now: number) => k.x.hq_ring(i, now),
    get phase() { return k.x.hq_phase(i); },
    get blocks() { return k.x.hq_blocks_input(k.x.hq_phase(i)) !== 0; },
    trace: () => readTrace(k.x).map(r => formatRecord(r, k.machines)),
  };
}

test("home_quit: the phases are nxnative's, in its order", () => {
  assert.deepEqual(HQ.states, ["Idle", "Holding", "Prompt", "Settle", "Quit"]);
  assert.deepEqual([IDLE, HOLDING, PROMPT, SETTLE, QUIT], [0, 1, 2, 3, 4]);
});

test("home_quit: t_home_quit.c, hold, prompt, A quits", () => {
  const q = hq();
  assert.equal(q.step(0, 0, 0, 0), IDLE, "nothing pressed: idle");
  assert.equal(q.step(1.0, 1, 0, 0), HOLDING, "Home pressed: the hold starts");
  assert.equal(q.ring(1.1), -1, "a short press shows no indicator");
  const half = q.ring(1.0 + RING_S + (HOLD_S - RING_S) / 2);
  assert.ok(half > 0.49 && half < 0.51, "half way the ring is half full");
  assert.equal(q.step(2.9, 1, 0, 0), HOLDING, "1.9 s: still holding");
  assert.ok(!q.blocks, "the game keeps its input while Home is held");
  assert.equal(q.step(3.0, 1, 0, 0), PROMPT, "2 s: the prompt opens");
  assert.equal(q.ring(3.0), -1, "the indicator goes when the prompt opens");
  assert.ok(q.blocks, "the prompt takes the controllers");
  assert.equal(q.step(3.5, 0, 0, 0), PROMPT, "letting go of Home keeps the prompt open");
  assert.equal(q.step(4.0, 0, 1, 0), QUIT, "A quits");
  assert.equal(q.step(4.1, 0, 0, 0), QUIT, "quit is final");
  q.cancel();
  assert.equal(q.phase, QUIT, "a focus loss after quit changes nothing");
  assert.ok(q.blocks);
  assert.deepEqual(q.k.logs, [], "nothing here is a refusal");
  assert.deepEqual(q.trace(), [
    "button_latch#0 Armed -Press-> Spent",
    "home_quit#0 Idle -HomePress-> Holding",
    "home_quit#0 Holding -HoldElapsed-> Prompt",
    "button_latch#0 Spent -Release-> Armed",
    "home_quit#0 Prompt -APress-> Quit",
  ]);
});

test("home_quit: t_home_quit.c, let go before 2 s", () => {
  const q = hq();
  q.step(0, 1, 0, 0);
  assert.equal(q.step(1.0, 0, 0, 0), IDLE, "let go before 2 s: nothing happens");
  assert.equal(q.step(5.0, 0, 0, 0), IDLE, "and nothing later either");
});

test("home_quit: t_home_quit.c, B closes the prompt, then the settle phase", () => {
  const q = hq();
  q.step(0, 1, 0, 0); q.step(2.0, 1, 0, 0);
  assert.equal(q.step(2.5, 1, 0, 1), SETTLE, "B closes the prompt");
  assert.ok(q.blocks, "the B that closed it does not reach the game");
  assert.equal(q.step(2.6, 1, 0, 0), SETTLE, "Home still down: still settling");
  assert.equal(q.step(2.7, 0, 0, 0), IDLE, "all up: the game has the controllers again");
  assert.equal(q.step(2.8, 1, 0, 0), HOLDING, "a new press starts a new hold");
});

test("home_quit: t_home_quit.c, A and B already held when the prompt opens", () => {
  const q = hq();
  q.step(0, 1, 1, 1);
  assert.equal(q.step(2.0, 1, 1, 1), PROMPT, "A and B held through the hold: the prompt opens");
  assert.equal(q.step(2.1, 1, 1, 1), PROMPT, "an A or B already held when it opens does not count");
  assert.equal(q.step(2.2, 1, 0, 1), PROMPT, "A released, B still held");
  assert.equal(q.step(2.3, 1, 1, 1), QUIT, "A pressed again quits");
  assert.deepEqual(q.trace(), [
    "button_latch#0 Armed -Press-> Spent",
    "home_quit#0 Idle -HomePress-> Holding",
    "home_quit#0 Holding -HoldElapsed-> Prompt",
    "button_latch#1 Armed -Suppress-> Spent",
    "button_latch#2 Armed -Suppress-> Spent",
    "button_latch#1 Spent -Release-> Armed",
    "home_quit#0 Prompt -APress-> Quit",
  ]);
});

test("home_quit: a B already held when the prompt opens closes it only after it was let go", () => {
  const q = hq();
  q.step(0, 1, 0, 1);
  assert.equal(q.step(2.0, 1, 0, 1), PROMPT);
  assert.equal(q.step(2.1, 1, 0, 1), PROMPT, "still the old B");
  assert.equal(q.step(2.2, 1, 0, 0), PROMPT, "let go");
  assert.equal(q.step(2.3, 1, 0, 1), SETTLE, "a new B closes it");
});

test("home_quit: t_home_quit.c, a new press of Home closes the prompt", () => {
  const q = hq();
  q.step(0, 1, 0, 0); q.step(2.0, 1, 0, 0);
  assert.equal(q.step(2.1, 1, 0, 0), PROMPT, "Home still held from the hold does not close it");
  q.step(2.2, 0, 0, 0);
  assert.equal(q.step(2.3, 1, 0, 0), SETTLE, "a new press of Home closes it");
  assert.equal(q.trace().at(-1), "home_quit#0 Prompt -HomePress-> Settle");
});

test("home_quit: t_home_quit.c, A and B at once", () => {
  const q = hq();
  q.step(0, 1, 0, 0); q.step(2.0, 1, 0, 0);
  assert.equal(q.step(2.1, 0, 1, 1), SETTLE, "A and B at once: the safe one wins");
  assert.equal(q.trace().at(-1), "home_quit#0 Prompt -BPress-> Settle");
});

test("home_quit: t_home_quit.c, losing the focus", () => {
  const q = hq();
  q.step(0, 1, 0, 0); q.step(2.0, 1, 0, 0);
  q.cancel();
  assert.ok(q.phase === IDLE && !q.blocks, "a focus loss closes the prompt");
  assert.equal(q.step(3.0, 1, 0, 0), IDLE, "a Home held through the focus change needs a new press");
  q.step(3.1, 0, 0, 0);
  assert.equal(q.step(3.2, 1, 0, 0), HOLDING, "then a press holds again");
});

test("home_quit: the focus lost in every phase", () => {
  // Idle, Home up: the phase stays, but a Home that is down at the next step was not pressed for us
  let q = hq();
  q.cancel();
  assert.equal(q.phase, IDLE);
  assert.equal(q.step(1, 1, 0, 0), IDLE);
  assert.deepEqual(q.trace(), ["home_quit#0 Idle -FocusLost-> Idle", "button_latch#0 Armed -Suppress-> Spent"]);
  q.step(2, 0, 0, 0);
  assert.equal(q.step(3, 1, 0, 0), HOLDING);
  // Holding
  q.cancel();
  assert.equal(q.phase, IDLE);
  assert.equal(q.ring(4), -1);
  assert.equal(q.step(10, 1, 0, 0), IDLE, "the hold does not go on after the focus came back");
  assert.equal(q.trace().at(-1), "home_quit#0 Holding -FocusLost-> Idle");
  // Prompt, Home let go meanwhile: still needs to be seen up once
  q = hq();
  q.step(0, 1, 0, 0); q.step(2, 1, 0, 0); q.step(2.1, 0, 0, 0);
  q.cancel();
  assert.equal(q.phase, IDLE);
  assert.equal(q.step(2.2, 1, 0, 0), IDLE);
  assert.deepEqual(q.trace().slice(-2), ["home_quit#0 Prompt -FocusLost-> Idle", "button_latch#0 Armed -Suppress-> Spent"]);
  // Settle
  q = hq();
  q.step(0, 1, 0, 0); q.step(2, 1, 0, 0); q.step(2.1, 1, 0, 1);
  assert.equal(q.phase, SETTLE);
  q.cancel();
  assert.ok(q.phase === IDLE && !q.blocks);
  assert.equal(q.trace().at(-1), "home_quit#0 Settle -FocusLost-> Idle");
  // Quit
  q = hq();
  q.step(0, 1, 0, 0); q.step(2, 1, 0, 0); q.step(2.1, 0, 1, 0);
  const n = q.k.x.kit_trace_total();
  q.cancel();
  assert.equal(q.phase, QUIT);
  assert.equal(q.k.x.kit_trace_total(), n, "nothing happened");
  assert.equal(q.k.x.kit_refused_total(), 0, "and nothing was refused");
});

test("home_quit: the 2 s hold is measured from the press, on the caller's clock", () => {
  const q = hq();
  assert.equal(q.step(1000.25, 1, 0, 0), HOLDING);
  assert.equal(q.step(1002.2499, 1, 0, 0), HOLDING, "just under 2 s");
  assert.equal(q.ring(1002.2499) < 1, true);
  assert.equal(q.step(1002.25, 1, 0, 0), PROMPT, "exactly 2 s is enough");
  // the time only counts on a step: no step, no prompt, however late
  const r = hq();
  r.step(0, 1, 0, 0);
  assert.equal(r.phase, HOLDING);
  assert.equal(r.ring(0.3), 0);
  assert.equal(r.ring(100), 1, "the ring is full, the prompt opens at the next step");
  assert.equal(r.phase, HOLDING);
  assert.equal(r.step(100, 0, 0, 0), IDLE, "and letting go wins over the time");
  // a clock that starts below zero
  const s = hq();
  s.step(-5, 1, 0, 0);
  assert.equal(s.step(-3.5, 1, 0, 0), HOLDING);
  assert.equal(s.step(-3, 1, 0, 0), PROMPT);
});

test("home_quit: Settle waits for Home, A and B, each of them", () => {
  for (const held of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const q = hq();
    q.step(0, 1, 0, 0); q.step(2, 1, 0, 0); q.step(2.1, 1, 0, 1);
    assert.equal(q.step(2.2, held[0], held[1], held[2]), SETTLE);
    assert.equal(q.step(2.3, 0, 0, 0), IDLE);
  }
});

test("home_quit: several at once keep apart", () => {
  const k = fresh(), q0 = hq(k, 0), q1 = hq(k, 1);
  q0.step(0, 1, 0, 0); q0.step(2, 1, 0, 0);
  assert.equal(q0.phase, PROMPT);
  assert.equal(q1.phase, IDLE);
  q1.step(5, 1, 0, 0);
  assert.equal(q0.phase, PROMPT);
  assert.equal(q1.phase, HOLDING);
  assert.equal(readTrace(k.x).at(-1)!.instance, 1);
});

// ---- against home_quit.h ----
interface Op { cancel: boolean; now: number; home: number; a: number; b: number }

function randomOps(n: number, seed: number): Op[] {
  let x = seed >>> 0;
  const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
  const dts = [0, 0.016, 0.1, 0.3, 0.5, 1.0, 1.5, 2.0, 2.5];
  const ops: Op[] = [];
  let now = 0, home = 0, a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.04) { ops.push({ cancel: true, now, home, a, b }); continue; }
    now += dts[Math.floor(rnd() * dts.length)];
    if (rnd() < 0.35) home ^= 1;
    if (rnd() < 0.25) a ^= 1;
    if (rnd() < 0.25) b ^= 1;
    ops.push({ cancel: false, now, home, a, b });
  }
  return ops;
}

// home_quit.h line by line, for when the C file or a compiler is not there
function reference(ops: Op[]): string[] {
  const q = { phase: 0, since: 0, home: 0, a_up: 0, b_up: 0 }, out: string[] = [];
  for (const o of ops) {
    if (o.cancel) { if (q.phase !== QUIT) { q.phase = IDLE; q.home = 1; } }
    else {
      const { now, home, a, b } = o, pressed = home && !q.home;
      q.home = home;
      switch (q.phase) {
        case IDLE: if (pressed) { q.phase = HOLDING; q.since = now; } break;
        case HOLDING:
          if (!home) q.phase = IDLE;
          else if (now - q.since >= HOLD_S) { q.phase = PROMPT; q.a_up = a ? 0 : 1; q.b_up = b ? 0 : 1; }
          break;
        case PROMPT:
          if (!a) q.a_up = 1;
          if (!b) q.b_up = 1;
          if ((b && q.b_up) || pressed) q.phase = SETTLE;
          else if (a && q.a_up) q.phase = QUIT;
          break;
        case SETTLE: if (!home && !a && !b) q.phase = IDLE; break;
      }
    }
    let ring = -1;
    if (q.phase === HOLDING) { const t = (o.now - q.since - RING_S) / (HOLD_S - RING_S); ring = t < 0 ? -1 : t > 1 ? 1 : t; }
    out.push(`${q.phase} ${q.home} ${ring} ${q.phase >= PROMPT ? 1 : 0}`);
  }
  return out;
}

// The same through the real header, or undefined when it cannot be built here
let refExe: string | null | undefined;   // null: cannot be built here
function nxnative(ops: Op[]): string[] | undefined {
  if (refExe === undefined) {
    const dir = process.env.NXNATIVE_HOST ?? "/home/user/nxnative/dm/host", exe = join(ROOT, "build", "kit", "hq_ref");
    refExe = null;
    if (existsSync(join(dir, "home_quit.h"))) {
      try { execFileSync("cc", ["-O1", "-Wall", "-I", dir, "-o", exe, join(ROOT, "test", "kit", "hq_ref.c")], { stdio: "pipe" }); refExe = exe; } catch { /* no compiler */ }
    }
  }
  if (!refExe) return undefined;
  const exe = refExe;
  const input = ops.map(o => o.cancel ? "c" : `s ${o.now} ${o.home} ${o.a} ${o.b}`).join("\n") + "\n";
  return execFileSync(exe, { input, encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n")
    .map(l => { const [p, h, r, bl] = l.split(" "); return `${p} ${h} ${Number(r)} ${bl}`; });
}

function ours(ops: Op[]): { lines: string[]; k: Kit } {
  const k = fresh(), lines: string[] = [];
  k.x.kit_trace_enable(0);
  k.x.hq_init(0);
  for (const o of ops) {
    if (o.cancel) k.x.hq_cancel(0); else k.x.hq_step(0, o.now, o.home, o.a, o.b);
    const p = k.x.hq_phase(0);
    // the Home latch is home_quit.h's `home` flag: Spent = 1
    lines.push(`${p} ${k.x.hq_latch(0, 0) === S(LATCH, "Spent") ? 1 : 0} ${k.x.hq_ring(0, o.now)} ${k.x.hq_blocks_input(p)}`);
  }
  return { lines, k };
}

test("home_quit: the same as home_quit.h over random input", () => {
  let steps = 0, viaC = 0;
  const seen = new Set<number>();
  for (let seed = 1; seed <= 40; seed++) {
    // Quit is final: short runs so every run has a life before it; a few runs never press A
    const ops = randomOps(400, seed).map(o => seed % 4 ? o : { ...o, a: 0 });
    const want = reference(ops), got = ours(ops);
    const c = nxnative(ops);
    if (c) { viaC++; assert.deepEqual(want, c, `seed ${seed}: the reference in this file is not home_quit.h`); }
    for (let i = 0; i < ops.length; i++) {
      assert.equal(got.lines[i], want[i], `seed ${seed}, operation ${i} (${JSON.stringify(ops[i])}): phase, Home flag, ring, blocks`);
      seen.add(Number(want[i][0]));
    }
    assert.deepEqual(got.k.logs, [], "the guards never offer an event the table refuses");
    assert.equal(got.k.x.kit_refused_total(), 0);
    steps += ops.length;
  }
  assert.equal(seen.size, 5, "the runs reached every phase");
  console.log(`     ${steps} operations in 40 runs; ${viaC ? `compared with nxnative's home_quit.h compiled with cc in ${viaC} runs` : "home_quit.h or cc not found: compared with the transliteration in this file only"}`);
});
