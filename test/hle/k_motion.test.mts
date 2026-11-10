// The orientation fusion of the six-axis sensors (src/hle/motion.ts, port of nxnative dm/host/motion_fusion.h).
// First the checks of nxnative's dm/host/tests/t_motion.c, in its order and with its words; then the same operations
// run through motion_fusion.h itself, compiled with cc (test/hle/ref/motion_ref.c): every field of the state and of
// motion_fill after every step.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, Hle, ROOT, NXNATIVE } from "./harness.mts";

const f32 = Math.fround, PI = f32(Math.PI);
const bits = (v: number) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.readUInt32LE(0); };
const hex = (v: number) => bits(v).toString(16).padStart(8, "0");
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

// One fusion state and map in the module's memory
class Fusion {
  h = new Hle(); st: number; map: number; a: number; w: number; out: number; spec: number;
  constructor() { const h = this.h; this.st = h.alloc(76); this.map = h.alloc(32); this.a = h.alloc(12); this.w = h.alloc(12); this.out = h.alloc(72); this.spec = h.alloc(64); this.parse(null); this.reset(); }
  parse(s: string | null): boolean { if (s !== null) { this.h.u8.fill(0, this.spec, this.spec + 64); this.h.u8.set(Buffer.from(s), this.spec); } return this.h.x.hle_motion_map(this.map, s === null ? 0 : this.spec) !== 0; }
  get src() { return [0, 1, 2].map(i => this.h.i32(this.map + 4 * i)); }
  get sign() { return [0, 1, 2].map(i => this.h.f32(this.map + 12 + 4 * i)); }
  get det() { return this.h.f32(this.map + 28); }
  set accSign(v: number) { this.h.dv.setFloat32(this.map + 24, v, true); }
  reset() { this.h.x.hle_motion_reset(this.st); }
  update(a: number[], w: number[], dt: number, k: number) {
    a.forEach((v, i) => this.h.dv.setFloat32(this.a + 4 * i, v, true)); w.forEach((v, i) => this.h.dv.setFloat32(this.w + 4 * i, v, true));
    this.h.x.hle_motion_update(this.st, this.map, this.a, this.w, dt, k);
  }
  run(ax: number, ay: number, az: number, wx: number, wy: number, wz: number, secs: number, k: number) {
    const n = Math.trunc(f32(f32(secs * 250) + 0.5));
    for (let i = 0; i < n; i++) this.update([ax, ay, az], [wx, wy, wz], f32(1 / 250), k);
  }
  R(i: number, j: number) { return this.h.f32(this.st + 4 * (3 * i + j)); }
  get angle() { return [0, 1, 2].map(i => this.h.f32(this.st + 36 + 4 * i)); }
  get acc() { return [0, 1, 2].map(i => this.h.f32(this.st + 48 + 4 * i)); }
  get gyro() { return [0, 1, 2].map(i => this.h.f32(this.st + 60 + 4 * i)); }
  get primed() { return this.h.i32(this.st + 72); }
  // the SixAxisSensorState fields: acc, gyro, angle, dir
  fill() { this.h.x.hle_motion_fill(this.st, this.out); const f = Array.from({ length: 18 }, (_, i) => this.h.f32(this.out + 4 * i)); return { acc: f.slice(0, 3), gyro: f.slice(3, 6), ang: f.slice(6, 9), dir: f.slice(9) }; }
  words(): string { return [...this.h.read(this.st, 76).toString("hex").match(/.{8}/g)!.map(w => w.match(/../g)!.reverse().join(""))].join(" "); }
  bytes(): Buffer { return this.h.read(this.st, 76); }
  set(b: Buffer) { this.h.u8.set(b, this.st); }
  finite() { return [...Array(18)].every((_, i) => Number.isFinite(this.h.f32(this.st + 4 * i))); }
}

test("motion (t_motion.c): axis maps", () => {
  const m = new Fusion();
  assert.ok(m.parse(null) && m.src[0] === 0 && m.det === 1, "default map is the identity");
  assert.ok(m.parse("x,-z,y") && m.src[1] === 2 && m.sign[1] === -1 && m.det === 1, "x,-z,y is a proper rotation");
  assert.ok(m.parse("y,x,z") && m.det === -1, "a swap is a mirror");
  assert.ok(m.parse("-x, y, z") && m.det === -1, "one sign flip is a mirror");
  assert.ok(!m.parse("x,x,z") && m.det === 1, "a repeated axis is refused (identity)");
  assert.ok(!m.parse("x,y"), "two entries are refused");
  assert.ok(m.parse(""), "an empty string is the identity");
});

test("motion (t_motion.c): units, integration, tilt correction, priming, frame maps, orthonormality, the phone's frame", () => {
  const s = new Fusion();
  // flat and still: identity orientation, acc (0,0,-1), no rotation
  s.run(0, 0, -1, 0, 0, 0, 1, 0.5);
  let f = s.fill();
  assert.ok(near(f.acc[2], -1, 1e-5) && near(f.dir[0], 1, 1e-4) && near(f.dir[4], 1, 1e-4) && near(f.dir[8], 1, 1e-4), "flat: identity direction");
  // a quarter turn of yaw over one second (pi/2 rad/s)
  s.reset(); s.run(0, 0, -1, 0, 0, f32(PI / 2), 1, 0.5); f = s.fill();
  assert.ok(near(f.gyro[2], 0.25, 1e-4), "gyro in revolutions / s");
  assert.ok(near(f.ang[2], 0.25, 0.01), "angle integrates to a quarter revolution");
  assert.ok(near(f.dir[0], 0, 0.02) && near(f.dir[1], 1, 0.02), "x axis turned to world y");
  // pitch: the top raised 30 degrees about x, with gravity measured to match
  s.reset(); const th = f32(30 * PI / 180);
  s.run(0, 0, -1, 0, 0, 0, 0.1, 0.5); s.run(0, 0, -1, th, 0, 0, 1, 0); s.run(0, -Math.sin(th), -Math.cos(th), 0, 0, 0, 2, 0.5); f = s.fill();
  assert.ok(near(f.dir[5], Math.sin(th), 0.02) && near(f.dir[4], Math.cos(th), 0.02), "y axis raised 30 degrees");
  // tilt drift: the gyro says nothing while gravity shows a 20-degree roll
  s.reset(); s.run(0, 0, -1, 0, 0, 0, 0.1, 0.5); const r = f32(20 * PI / 180);
  s.run(Math.sin(r), 0, -Math.cos(r), 0, 0, 0, 20, 0.5); f = s.fill();
  assert.ok(near(-f.dir[2], Math.sin(r), 0.03), "roll pulled toward gravity");
  s.reset(); s.run(Math.sin(r), 0, -Math.cos(r), 0, 0, 0, 0.01, 0.5); f = s.fill();
  assert.ok(near(-f.dir[2], Math.sin(r), 0.02), "primed from the first sample's gravity");
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const a = [0, 0, 0]; a[axis] = sign;
    s.reset(); s.update(a, [0, 0, 0], 0, 0.5);
    assert.ok(near(s.R(2, axis) * sign, -1, 1e-5), "first sample: gravity points down in every starting pose");
  }
  // a frame map: rotation about the source's y where the Switch has z
  assert.ok(s.parse("x,-z,y")); s.reset(); s.run(0, -1, 0, 0, f32(PI / 2), 0, 1, 0.5); f = s.fill();
  assert.ok(near(f.acc[2], -1, 1e-4) && near(f.gyro[2], 0.25, 1e-4), "mapped: gravity on -z, yaw on z");
  assert.ok(near(f.dir[1], 1, 0.02), "mapped yaw turns x to world y");
  // the specific-force convention
  s.parse(null); s.accSign = -1; s.reset(); s.run(0, 0, 1, 0, 0, 0, 0.2, 0.5); f = s.fill();
  assert.ok(near(f.acc[2], -1, 1e-5) && near(f.dir[8], 1, 1e-4), "acc sign flip");
  // orthonormal after a long noisy spin
  s.parse(null); s.reset();
  for (let i = 0; i < 25000; i++) s.update([0, 0, -1], [f32(0.7 * Math.sin(f32(i * 0.01))), 1.3, -0.4], f32(1 / 250), 0.5);
  const d01 = s.R(0, 0) * s.R(0, 1) + s.R(1, 0) * s.R(1, 1) + s.R(2, 0) * s.R(2, 1), n0 = s.R(0, 0) ** 2 + s.R(1, 0) ** 2 + s.R(2, 0) ** 2;
  assert.ok(near(d01, 0, 1e-4) && near(n0, 1, 1e-4), "orientation stays orthonormal");
  // the phone's own sensors
  const h = s.h, phone = (orient: number, v: number[]) => { v.forEach((x, i) => h.dv.setFloat32(s.a + 4 * i, x, true)); h.x.hle_motion_phone(orient, s.a, s.w); return [0, 1, 2].map(i => h.f32(s.w + 4 * i)); };
  let o = phone(3, [-1, 0, 0]); assert.ok(near(o[0], 0, 1e-6) && near(o[1], -1, 1e-6) && near(o[2], 0, 1e-6), "landscape right upright: gravity to the picture's bottom");
  o = phone(4, [1, 0, 0]); assert.ok(near(o[0], 0, 1e-6) && near(o[1], -1, 1e-6), "landscape left upright: gravity to the picture's bottom");
  o = phone(3, [0, 0, -1]); assert.ok(near(o[2], -1, 1e-6), "flat face up stays face up");
  o = phone(3, [0, -1, 0]); assert.ok(near(o[0], 1, 1e-6) && near(o[1], 0, 1e-6), "rotation axes follow the picture");
  assert.deepEqual(phone(2, [1, 2, 3]), [-1, -2, 3]); assert.deepEqual(phone(1, [1, 2, 3]), [1, 2, 3]);
});

test("motion (t_motion.c): non-finite samples, bad times and gains, overflow", () => {
  const s = new Fusion(), e = new Fusion();
  const bad = [NaN, Infinity, -Infinity];
  for (let primed = 0; primed < 2; primed++) for (let sensor = 0; sensor < 2; sensor++) for (let axis = 0; axis < 3; axis++) for (const b of bad) {
    const a = [0, 0, -1], w = [0.1, -0.2, 0.3];
    s.reset(); if (primed) s.update(a, w, 0, 0.5);
    const before = s.bytes(); e.set(before);
    (sensor ? w : a)[axis] = b;
    s.update(a, w, 0.004, 0.5);
    assert.ok(s.bytes().equals(before), "non-finite sample leaves every field unchanged");
    s.update([0, 0, -1], [0.1, -0.2, 0.3], 0.004, 0.5); e.update([0, 0, -1], [0.1, -0.2, 0.3], 0.004, 0.5);
    assert.ok(s.finite() && s.bytes().equals(e.bytes()), "valid sample recovers without resetting fusion");
  }
  const a = [0.2, 0, -0.98], w = [0.1, 0.2, 0.3];
  for (const t of [NaN, Infinity, -Infinity, -0.004, 0, 0.250001]) {
    s.reset(); s.update(a, w, 0, 0.5); e.set(s.bytes());
    s.update(a, w, t, 0.5); e.update(a, w, 0, 0.5);
    assert.ok(s.finite() && s.bytes().equals(e.bytes()), "invalid time or gap reports a sample without integration");
  }
  for (const g of [NaN, Infinity, -Infinity, -1]) {
    a[0] = 0.2; s.reset(); s.update(a, w, 0, 0); e.set(s.bytes());
    a[0] = -0.2; s.update(a, w, 0.004, g); e.update(a, w, 0.004, 0);
    assert.ok(s.finite() && s.bytes().equals(e.bytes()), "invalid gain disables tilt correction");
  }
  const FLT_MAX = 3.4028234663852886e38;
  s.reset(); s.update(a, w, 0, 0);
  const rot = s.bytes().subarray(0, 36);
  s.update(a, [FLT_MAX, FLT_MAX, FLT_MAX], 0.25, 0);
  assert.ok(s.finite() && s.bytes().subarray(0, 36).equals(rot), "overflowing rotation norm does not corrupt orientation");
  s.h.dv.setFloat32(s.st + 36, FLT_MAX, true);
  s.update(a, [FLT_MAX, FLT_MAX, FLT_MAX], 0.25, 0);
  assert.ok(s.finite() && s.angle[0] === FLT_MAX, "overflowing angle does not poison accumulated revolutions");
});

test("motion (t_motion.c): all 48 signed frame maps; small rotations keep their precision", () => {
  const s = new Fusion(), perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const p of perms) for (let b = 0; b < 8; b++) {
    const spec = [0, 1, 2].map(i => ((b >> i) & 1 ? "-" : "+") + "xyz"[p[i]]).join(",");
    assert.ok(s.parse(spec), "every signed permutation parses");
    const a = [0.2, -0.3, -0.9].map(f32), w = [0.1, 0.2, -0.3].map(f32);
    s.reset(); s.update(a, w, 0, 0);
    for (let i = 0; i < 3; i++) {
      assert.ok(near(s.acc[i], s.sign[i] * a[s.src[i]], 1e-6), spec);
      assert.ok(near(s.gyro[i], s.sign[i] * w[s.src[i]] * s.det / (2 * PI), 1e-6), spec);
    }
    assert.ok(s.finite(), "all 48 frame maps retain acceleration and axial gyro conventions");
  }
  s.parse(null); s.reset(); s.run(0, 0, -1, 0, 0, 0.0001, 300, 0);
  assert.ok(s.finite() && near(s.angle[2], 0.03 / (2 * PI), 5e-6), "small rotations retain precision over five minutes");
  assert.ok(near(s.R(0, 0), Math.cos(0.03), 1e-4) && near(s.R(1, 0), Math.sin(0.03), 1e-4), "small rotations accumulate in orientation");
});

// ---------- against motion_fusion.h compiled with cc ----------
function reference(): string | null {
  const dir = join(NXNATIVE, "dm", "host"), exe = join(ROOT, "build", "hle", "motion_ref");
  if (!existsSync(join(dir, "motion_fusion.h"))) return null;
  mkdirSync(join(ROOT, "build", "hle"), { recursive: true });
  // -ffp-contract=off: no fused multiply-add, as WebAssembly has none
  try { execFileSync("cc", ["-O1", "-ffp-contract=off", "-I", dir, "-o", exe, join(ROOT, "test", "hle", "ref", "motion_ref.c"), "-lm"], { stdio: "pipe" }); return exe; } catch { return null; }
}

test("motion: every field after every step equals nxnative's motion_fusion.h compiled with cc", () => {
  const exe = reference();
  if (!exe) { console.log("     motion_fusion.h or cc not found: the comparison with the C code was NOT made"); assert.ok(!process.env.HLE_REQUIRE_CC, "cc is required"); return; }
  let seed = 0x1234567;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const f = (lo: number, hi: number) => f32(lo + (hi - lo) * rnd());
  type Op = { line: string; run: (s: Fusion) => void; kind: "state" | "map" | "phone"; orient?: number; v?: number[]; spec?: string | null };
  const ops: Op[] = [];
  const upd = (a: number[], w: number[], dt: number, k: number) => ops.push({ kind: "state", line: `u ${[...a, ...w, dt, k].map(hex).join(" ")}`, run: s => s.update(a, w, dt, k) });
  const map = (spec: string | null, neg = false) => { ops.push({ kind: "map", spec, line: `m ${spec === null ? "-" : spec}`, run: s => { s.parse(spec); } }); if (neg) ops.push({ kind: "state", line: "n\nr", run: s => { s.accSign = -1; s.reset(); } }); };
  const reset = () => ops.push({ kind: "state", line: "r", run: s => s.reset() });
  // 1. sessions as a controller gives them: a start pose, then rotation and gravity with noise, 4 ms to 20 ms apart
  for (const spec of [null, "x,-z,y", "-y,x,z", "z,y,-x", "x,y", "y,-y,z", " -z , x , +y "]) {
    map(spec); reset();
    for (let session = 0; session < 6; session++) {
      reset();
      const g = [f(-1, 1), f(-1, 1), f(-1, 1)], n = Math.hypot(...g) || 1, tilt = session % 2 ? 1 : f(0.4, 1.6);
      const grav = g.map(v => f32(v / n * tilt)), k = f32([0, 0.5, 0.5, 2, 0.05, 0.5][session]);
      for (let i = 0; i < 400; i++) {
        const w = [f(-6, 6), f(-6, 6), f(-6, 6)].map(v => f32(v * (i % 50 < 10 ? 0 : 1)));
        const a = grav.map(v => f32(v + f(-0.05, 0.05)));
        const dt = i === 0 ? 0 : i % 97 === 0 ? f32(0.3) : f(0.004, 0.02);
        upd(a, w, dt, k);
      }
    }
  }
  // 2. the edges: non-finite and extreme samples, times and gains
  map(null, true);
  const odd = [NaN, Infinity, -Infinity, 0, -0, 3.4028234663852886e38, 1e-30, 1e30, 0.25, f32(0.250001), -1];
  for (let i = 0; i < 600; i++) {
    const pickv = () => rnd() < 0.15 ? odd[Math.trunc(rnd() * odd.length)] : f(-3, 3);
    upd([pickv(), pickv(), pickv()], [pickv(), pickv(), pickv()], rnd() < 0.3 ? odd[Math.trunc(rnd() * odd.length)] : f(0, 0.05), rnd() < 0.3 ? odd[Math.trunc(rnd() * odd.length)] : 0.5);
    if (i % 60 === 59) reset();
  }
  for (const o of [0, 1, 2, 3, 4, 7]) { const v = [f(-2, 2), f(-2, 2), f(-2, 2)]; ops.push({ kind: "phone", orient: o, v, line: `p ${o} ${v.map(hex).join(" ")}`, run: () => {} }); }

  const out = execFileSync(exe, { input: ops.map(o => o.line).join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n");
  const s = new Fusion();
  let line = 0, exact = 0, steps = 0, worst = 0;
  for (const op of ops) {
    op.run(s);
    if (op.kind === "map") {
      const w = out[line++].split(" "); assert.equal(w[0], "M");
      const got = [s.parse(op.spec!) ? 1 : 0, ...s.src].join(" ") + " " + [...s.sign, s.h.f32(s.map + 24), s.det].map(hex).join(" ");
      assert.equal(got, w.slice(1).join(" "), `map ${op.spec}`);
      continue;
    }
    if (op.kind === "phone") {
      const h = s.h; op.v!.forEach((x, i) => h.dv.setFloat32(s.a + 4 * i, x, true)); h.x.hle_motion_phone(op.orient!, s.a, s.w);
      assert.equal("P " + [0, 1, 2].map(i => hex(h.f32(s.w + 4 * i))).join(" "), out[line++], `phone ${op.orient}`);
      continue;
    }
    const want = out[line++].split(" "); assert.equal(want[0], "S");
    const ref = Buffer.alloc(76); for (let i = 0; i < 19; i++) ref.writeUInt32LE(parseInt(want[1 + i], 16), 4 * i);
    steps++;
    if (s.bytes().equals(ref)) exact++;
    else {
      // only sinf / cosf may differ (musl's here, the C library's there): a last place of the rotation, nothing else
      assert.equal(s.primed, ref.readInt32LE(72), `step ${steps}: primed`);
      for (let i = 0; i < 18; i++) {
        const a = s.h.f32(s.st + 4 * i), b = ref.readFloatLE(4 * i);
        if (Number.isNaN(a) && Number.isNaN(b)) continue;
        const d = Math.abs(a - b); worst = Math.max(worst, d);
        assert.ok(i < 9 ? d <= 4e-7 : a === b || Object.is(a, b), `step ${steps} (${op.line}): field ${i} is ${a}, C has ${b}`);
      }
      s.set(ref);   // go on from the C state, so that a last place does not add up
    }
    const fill = s.fill(), all = [...fill.acc, ...fill.gyro, ...fill.ang, ...fill.dir];
    assert.equal(all.map(hex).join(" "), [...Array(18)].map((_, i) => hex(s.h.f32(s.st + [48, 52, 56, 60, 64, 68, 36, 40, 44, 0, 12, 24, 4, 16, 28, 8, 20, 32][i]))).join(" "), "motion_fill reads the state");
    if (s.bytes().equals(ref)) assert.equal(all.map(hex).join(" "), want.slice(20).join(" "), `step ${steps}: motion_fill`);
  }
  assert.equal(line, out.length);
  console.log(`     ${steps} updates compared with motion_fusion.h compiled with cc: ${exact} bit for bit, ${steps - exact} within ${worst.toExponential(1)} in the rotation matrix (sinf / cosf)`);
  assert.ok(exact >= steps * 0.9, `${exact} of ${steps} steps bit for bit`);
});
