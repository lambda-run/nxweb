// Random sequences of open / start / stop / append / take back / tick / device events / hide / show / close against
// the module, with the invariants checked after every operation.
import assert from "node:assert/strict";
import { test, Au, rng, DEV, OUT_S, MS } from "./harness.mts";

interface MOut { g: number; ev: boolean; ch: number; queue: number[]; free: number[]; sizes: Map<number, number>; signals: number; released: number; protocol: boolean }

function run(seed: number, ops: number): { ops: number; released: number; states: Set<string> } {
  const r = rng(seed), pick = (n: number) => Math.floor(r() * n);
  const a = new Au({ guest: 24 << 20 });
  const device = r() < 0.7;
  if (device) a.attach(r() < 0.5 ? 48000 : 44100, [0, 256, 1024][pick(3)]);
  const protocol = r() < 0.5;      // the game only takes buffers back when its event fired, and then all of them
  const outs: MOut[] = [];
  const seen = new Set<string>();
  let releasedTotal = 0;
  const slot = (o: MOut) => a.slotOf(o.g);
  const stat = (o: MOut, w: number) => Number(a.x.audio_out_stat(slot(o), w));
  const take = (o: MOut): boolean => {
    const b = a.released(o.g);
    if (!b) return false;
    assert.equal(b, o.queue[0], "buffers come back in the order they were appended");
    o.queue.shift(); o.free.push(b); o.released++; releasedTotal++;
    return true;
  };
  const check = (what: string) => {
    for (const o of outs) {
      const s = slot(o);
      assert.ok(s >= 0, what);
      const st = a.x.audio_out_state(s), name = OUT_S[st];
      seen.add(name);
      const pending = stat(o, 1), rel = stat(o, 2);
      // every buffer is in exactly one place
      assert.equal(stat(o, 3), pending + rel + stat(o, 5), `${what}: appended = pending + released + taken back`);
      assert.equal(stat(o, 4), rel + stat(o, 5), `${what}: released = waiting + taken back`);
      assert.equal(pending + rel, o.queue.length, `${what}: the model's in-flight count`);
      assert.equal(stat(o, 5), o.released);
      // the slots' machines agree with the queues
      const n = [0, 0, 0, 0]; for (let i = 0; i < 128; i++) n[a.x.audio_buf_state(s, i)]++;
      assert.equal(n[1] + n[2], pending, `${what}: Appended + Playing = pending`);
      assert.equal(n[3], rel, `${what}: Released = released queue`);
      assert.ok(n[2] <= 1, `${what}: at most one buffer is being played`);
      // the guest-visible state is derived from the machine
      assert.equal(a.host.call(10, [o.g]).x0, name === "Stopped" ? 1n : 0n);
      // the event: one signal for each entry into the module that released something, none otherwise
      if (o.ev) {
        const sig = a.ev(o.g).signals, relNow = stat(o, 4);
        assert.equal(sig, stat(o, 6), what);
        if (o.protocol && rel > 0) assert.ok(a.ev(o.g).flag, `${what}: released buffers are pending and the event is not signalled: the game would sleep for good`);
      } else assert.equal(a.evOf.has(o.g), false);
    }
    assert.equal(a.x.kit_refused_total(), 0, what);
  };
  // signals count entries with a release: checked op by op
  const guarded = (what: string, f: () => void) => {
    const before = outs.map(o => ({ o, rel: stat(o, 4), sig: stat(o, 6), consumed: stat(o, 9), state: OUT_S[a.x.audio_out_state(slot(o))] }));
    f();
    for (const b of before) {
      if (!outs.includes(b.o)) continue;
      const dRel = stat(b.o, 4) - b.rel, dSig = stat(b.o, 6) - b.sig;
      assert.ok(dSig <= dRel, `${what}: ${dSig} signals for ${dRel} releases`);
      assert.equal(dSig > 0, dRel > 0, `${what}: a release without a signal, or a signal without a release`);
      if (b.state === "Stopped" && !what.endsWith("start")) assert.equal(stat(b.o, 9), b.consumed, `${what}: a stopped output was consumed`);
    }
    check(what);
  };
  for (let i = 0; i < ops; i++) {
    const o = outs[pick(outs.length)], k = r();
    if (k < 0.04 && outs.length < 4) guarded("open", () => {
      const ev = r() < 0.7, ch = [1, 2, 2, 6][pick(4)];
      const g = a.open(ch, ev);
      const m: MOut = { g, ev, ch, queue: [], free: [], sizes: new Map(), signals: 0, released: 0, protocol: protocol && ev };
      for (let b = 0; b < 12; b++) { const frames = [0, 1, 48, 240, 240, 480, 777, 1024, 4096][pick(9)]; const p = a.buf(frames * 2 * ch); m.free.push(p); m.sizes.set(p, frames); }
      outs.push(m);
    });
    else if (!o) continue;
    else if (k < 0.07) guarded("close", () => { a.c("au_Close", o.g); a.evOf.delete(o.g); outs.splice(outs.indexOf(o), 1); });
    else if (k < 0.17) guarded("start", () => assert.equal(a.c("au_Start", o.g), 0n));
    else if (k < 0.22) guarded("stop", () => a.c("au_Stop", o.g));
    else if (k < 0.47) guarded("append", () => { const b = o.free.pop(); if (b && a.append(o.g, b)) o.queue.push(b); else if (b) o.free.push(b); });
    else if (k < 0.57) guarded("take back", () => {
      if (o.protocol) { const e = a.ev(o.g); if (e.flag) { e.flag = false; while (take(o)) { /* all of them */ } } }
      else if (r() < 0.5) take(o); else while (take(o)) { /* drain */ }
    });
    else if (k < 0.80) guarded("tick", () => {
      const dt = BigInt([0, 100_000, 1_000_000, 2_666_667, 5_000_000, 20_000_000, 250_000_000, 1_100_000_000][pick(8)]);
      const before = outs.map(x => ({ x, c: stat(x, 9), silent: ["SilentStarting", "SilentRetry", "Suspended"].includes(OUT_S[a.x.audio_out_state(slot(x))]) }));
      a.tick(dt);
      for (const b of before) if (b.silent) {
        // the silent sink never runs ahead of the guest clock: at most dt of frames (and the frame in progress)
        const frames = (stat(b.x, 9) - b.c) / (2 * b.x.ch);
        assert.ok(frames <= Number(dt) * 48000 / 1e9 + 1, `the silent sink consumed ${frames} frames in ${dt} ns`);
      }
    });
    else if (k < 0.84) guarded("deadline", () => { a.toDeadline(); });
    else if (k < 0.90 && device) guarded("device state", () => a.dev([DEV.NONE, DEV.STARTING, DEV.RUNNING, DEV.RUNNING, DEV.RUNNING, DEV.FAILED, DEV.LOST][pick(7)]));
    else if (k < 0.97 && device) guarded("callback", () => { for (let n = pick(6); n >= 0; n--) { a.callback([128, 128, 256, 1024][pick(4)]); a.tick(BigInt(pick(3000)) * 1000n); } });
    else guarded("hide/show", () => a.x.audio_suspend(r() < 0.5 ? 1 : 0));
  }
  // the end: stop everything; every buffer ever appended comes back exactly once, in order
  for (const o of outs) {
    guarded("final start", () => a.c("au_Start", o.g));   // what was appended to a stopped output waits for its Start
    guarded("final stop", () => a.c("au_Stop", o.g));
    if (o.ev) a.ev(o.g).flag = false;
    while (take(o)) { /* all */ }
    assert.equal(o.queue.length, 0, "a buffer never came back");
    assert.equal(stat(o, 3), stat(o, 5));
  }
  const allowed = /the silent sink stands in, retrying|released buffers and the game takes none back/;
  for (const l of a.red) assert.match(l, allowed);
  return { ops, released: releasedTotal, states: seen };
}

test("property: 400 random sequences of 600 operations (open, start, stop, append, take back, tick, deadline, device state, callbacks, hide, show, close): each buffer released exactly once and in order; a signal exactly when an entry released something; a game that sleeps on the event is never left with released buffers and no signal; queues, slot machines and the guest-visible state agree; no refused transition", () => {
  let released = 0;
  const states = new Set<string>();
  for (let seed = 1; seed <= 400; seed++) {
    try { const r = run(seed, 600); released += r.released; r.states.forEach(s => states.add(s)); }
    catch (e) { (e as Error).message = `seed ${seed}: ${(e as Error).message}`; throw e; }
  }
  assert.deepEqual([...states].sort(), ["Live", "SilentRetry", "SilentStarting", "Stopped", "Suspended"]);
  assert.ok(released > 20000, `${released} buffers went round`);
  console.log(`     ${released} buffers released and taken back over 240,000 operations`);
});
