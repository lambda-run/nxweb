// The names: the table against nxnative's sources, the lookup, and that every id is answered.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, Au, FN, MANGLED, NXNATIVE, R } from "./harness.mts";
import { allNames } from "../../src/audio/host/gen_names.mts";

test("names: names.ts is nxnative's hle_audio.c, hle_audren.c and hle_codec.c, name for name", () => {
  const dir = join(NXNATIVE, "dm", "host");
  if (!existsSync(join(dir, "hle_audio.c"))) { console.log("     SKIPPED: no nxnative clone at " + NXNATIVE); return; }
  const ref = allNames(dir);
  assert.equal(ref.length, 118);
  assert.deepEqual(ref.map(n => n.mangled), MANGLED);
  assert.deepEqual(ref.map(n => n.ident), Object.keys(FN).filter(k => k !== "None"));
  assert.deepEqual(["hle_audio.c", "hle_audren.c", "hle_codec.c"].map(f => ref.filter(n => n.file === f).length), [64, 22, 32]);
});

test("names: every name resolves to its id, anything else to 0", () => {
  const a = new Au();
  assert.equal(a.x.audio_fn_count(), MANGLED.length);
  MANGLED.forEach((n, i) => { assert.equal(a.host.lookup(n), i + 1, n); assert.equal(a.host.fnName(i + 1), n); });
  assert.equal(new Set(MANGLED).size, MANGLED.length);
  for (const n of ["", "_ZN2nn5audio13StartAudioOutEPNS0_8AudioOutE_", "_ZN2nn5audio13StartAudioOutEPNS0_8AudioOut", "_ZN2nn2fs8OpenFileEPNS0_10FileHandleEPKci", "x".repeat(700)])
    assert.equal(a.host.lookup(n), 0, n);
});

test("names: every id is answered (called twice with harmless arguments); no name is a stub; the six audio renderer take-overs run SDK code, so without an SDK in the guest each fails with one red line naming the SDK function it lacks", () => {
  const a = new Au();
  const p = a.alloc(4096), q = a.alloc(4096), fmt = a.alloc(16);
  assert.deepEqual(Object.keys(FN).filter(k => FN[k] && a.x.audio_fn_is_stub(FN[k])), []);
  const ren = ["ar_Open", "ar_Open0", "ar_Close", "ar_ImplExec", "ars_Exec", "ars_Update"];
  for (let round = 0; round < 2; round++) for (const name of Object.keys(FN)) {
    if (name === "None") continue;
    const r = a.call(name, [p, q, q, q, q, fmt, 0, 0], { x8: q });
    assert.notEqual(r.kind, 16, name + " must not go on without an SDK");
    if (ren.includes(name) && name !== "ar_Close") assert.equal(r.x0, R.FAIL, name);
  }
  // one red line per SDK function that is not there, and none on the second round
  const lines = a.red.filter(l => l.startsWith("[RED] audren: "));
  assert.deepEqual(lines, ["[RED] audren: missing SDK symbol " + MANGLED[FN.ar_Open - 1], "[RED] audren: missing SDK symbol " + MANGLED[FN.ar_Open0 - 1], "[RED] audren: missing SDK symbol " + MANGLED[FN.ar_Close - 1],
    "[RED] audren: a render of a renderer the host did not open", "[RED] audren: missing SDK symbol " + MANGLED[FN.ars_Update - 1]]);
  assert.equal(a.x.audio_ren_frames(), 0);
  // an id nobody gave out
  a.x.audio_tick(0n, 0n);
  assert.equal(a.host.call(119).x0, 0n);
  assert.match(a.red.at(-1)!, /function id 119/);
  assert.equal(a.x.kit_refused_total(), 0);
});
