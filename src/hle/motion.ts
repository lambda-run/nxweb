// Controller motion (gyro + accelerometer) for the six-axis sensor: port of nxnative dm/host/motion_fusion.h.
// Pure single-precision arithmetic in the C code's order of operations, so the results follow the C code bit for bit
// except through sinf / cosf (AssemblyScript's are musl's; test/hle/k_motion.test.mts compares against the header
// compiled with cc).
//
// Input: acceleration in G (gravity direction: (0, 0, -1) lying face up) and rotation rate in rad/s in the source's
// frame. Output: the SixAxisSensorState fields: acceleration in G, angular velocity in revolutions/s, angle in
// revolutions, direction = the controller's three axes in the world (rows). Switch frame: x right, y forward, z up.
// The frame map is a signed permutation applied to acceleration and rotation alike (rotation times its determinant).
// Orientation: the gyro is integrated (R = R exp(w dt)) and tilt drift is pulled toward the measured gravity (Mahony,
// gain k) while |acc| is near 1 G; yaw is free to drift.
//
// motion_map (32 bytes):   +0 i32 src[3], +12 f32 sign[3], +24 f32 acc_sign, +28 f32 det
// motion_state (76 bytes): +0 f32 R[3][3] (controller -> world), +36 f32 angle[3], +48 f32 acc[3], +60 f32 gyro[3], +72 i32 primed

export const MAP_SIZE: usize = 32, STATE_SIZE: usize = 76;
const PI_F: f32 = 3.14159274101257324;   // (float)M_PI

// @ts-ignore: decorator
@inline function R(s: usize, i: i32, j: i32): f32 { return load<f32>(s + (<usize>(3 * i + j) << 2)); }
// @ts-ignore: decorator
@inline function setR(s: usize, i: i32, j: i32, v: f32): void { store<f32>(s + (<usize>(3 * i + j) << 2), v); }
// @ts-ignore: decorator
@inline function fin(x: f32): bool { return isFinite<f32>(x); }

export function mapIdentity(m: usize): void {
  for (let i = 0; i < 3; i++) { store<i32>(m + (<usize>i << 2), i); store<f32>(m + 12 + (<usize>i << 2), 1); }
  store<f32>(m, 1, 24); store<f32>(m, 1, 28);
}
// "x,y,z" with an optional '-' or '+' per entry, e.g. "x,-z,y" (a C string; 0 or empty: the identity). Returns
// false and the identity on a malformed string
export function mapParse(m: usize, s: usize): bool {
  mapIdentity(m);
  if (!s || !load<u8>(s)) return true;
  const T: usize = memory.data(32);
  mapIdentity(T);
  let used = 0;
  for (let i = 0; i < 3; i++) {
    while (load<u8>(s) == 32) s++;
    let sg: f32 = 1;
    if (load<u8>(s) == 45) { sg = -1; s++; } else if (load<u8>(s) == 43) s++;
    const c = load<u8>(s);
    const a = c == 120 || c == 88 ? 0 : c == 121 || c == 89 ? 1 : c == 122 || c == 90 ? 2 : -1;
    if (a < 0 || ((used >> a) & 1)) return false;
    used |= 1 << a; store<i32>(T + (<usize>i << 2), a); store<f32>(T + 12 + (<usize>i << 2), sg); s++;
    while (load<u8>(s) == 32) s++;
    if (i < 2) { if (load<u8>(s) != 44) return false; s++; }
  }
  if (load<u8>(s)) return false;
  const s0 = load<i32>(T), s1 = load<i32>(T, 4), s2 = load<i32>(T, 8);
  const inv = <i32>(s0 > s1) + <i32>(s0 > s2) + <i32>(s1 > s2);
  store<f32>(T, load<f32>(T, 12) * load<f32>(T, 16) * load<f32>(T, 20) * ((inv & 1) ? <f32>-1 : <f32>1), 28);
  memory.copy(m, T, 32);
  return true;
}
// out[i] = sign[i] * in[src[i]] * scale
export function mapApply(m: usize, inp: usize, out: usize, scale: f32): void {
  for (let i = 0; i < 3; i++)
    store<f32>(out + (<usize>i << 2), load<f32>(m + 12 + (<usize>i << 2)) * load<f32>(inp + (<usize>load<i32>(m + (<usize>i << 2)) << 2)) * scale);
}
export function motionReset(s: usize): void {
  memory.fill(s, 0, STATE_SIZE);
  for (let i = 0; i < 3; i++) setR(s, i, i, 1);
  store<f32>(s, -1, 56);   // acc[2]
}

const TM: usize = memory.data(36), CM: usize = memory.data(36), EM: usize = memory.data(36);
const A3: usize = memory.data(12), W3: usize = memory.data(12), WR: usize = memory.data(12);

function m3mul(o: usize, a: usize, b: usize): void {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    store<f32>(TM + (<usize>(3 * i + j) << 2), R(a, i, 0) * R(b, 0, j) + R(a, i, 1) * R(b, 1, j) + R(a, i, 2) * R(b, 2, j));
  memory.copy(o, TM, 36);
}
function m3orthonormalize(r: usize): void {   // Gram-Schmidt on the columns
  const c = CM;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) setR(c, j, i, R(r, i, j));
  for (let k = 0; k < 3; k++) {
    for (let p = 0; p < k; p++) {
      const d: f32 = R(c, k, 0) * R(c, p, 0) + R(c, k, 1) * R(c, p, 1) + R(c, k, 2) * R(c, p, 2);
      for (let i = 0; i < 3; i++) setR(c, k, i, R(c, k, i) - d * R(c, p, i));
    }
    let n: f32 = Mathf.sqrt(R(c, k, 0) * R(c, k, 0) + R(c, k, 1) * R(c, k, 1) + R(c, k, 2) * R(c, k, 2));
    if (n < <f32>1e-6) n = 1;
    for (let i = 0; i < 3; i++) setR(c, k, i, R(c, k, i) / n);
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) setR(r, i, j, R(c, j, i));
}

// One sample: acceleration (G) and rotation rate (rad/s) at acc and rot (3 f32 each), dt seconds since the previous
// one (0 for the first), k the tilt correction gain (rad/s per unit error)
export function motionUpdate(s: usize, m: usize, acc: usize, rot: usize, dt: f32, k: f32): void {
  // a bad sensor sample must not prime or poison the persistent fusion state
  for (let i = 0; i < 3; i++) if (!fin(load<f32>(acc + (<usize>i << 2))) || !fin(load<f32>(rot + (<usize>i << 2)))) return;
  if (!fin(dt) || dt < 0) dt = 0;
  if (!fin(k) || k < 0) k = 0;
  mapApply(m, acc, A3, load<f32>(m, 24));
  mapApply(m, rot, W3, load<f32>(m, 28));           // rad/s in the Switch frame
  const a0 = load<f32>(A3), a1 = load<f32>(A3, 4), a2 = load<f32>(A3, 8);
  let w0 = load<f32>(W3), w1 = load<f32>(W3, 4), w2 = load<f32>(W3, 8);
  const primed = load<i32>(s, 72);
  if (!primed || dt <= 0 || dt > <f32>0.25) {       // first sample or a gap: no integration step
    if (!primed) {                                  // start level with the measured gravity, facing forward
      const n: f32 = Mathf.sqrt(a0 * a0 + a1 * a1 + a2 * a2);
      if (n > <f32>0.5 && n < <f32>1.5) {
        // world down (0,0,-1) = R g_body  ->  R's third row = -g_body / |g|
        const z0: f32 = -a0 / n, z1: f32 = -a1 / n, z2: f32 = -a2 / n;
        let y00: f32 = 0, y01: f32 = 1; const y02: f32 = 0;
        // gravity along y (an upright phone): another heading reference before projecting it onto the level plane
        if (Mathf.abs(z1) > <f32>0.99) { y00 = 1; y01 = 0; }
        const d: f32 = y00 * z0 + y01 * z1 + y02 * z2;
        let y0: f32 = y00 - d * z0, y1: f32 = y01 - d * z1, y2: f32 = y02 - d * z2;
        const yn: f32 = Mathf.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
        if (yn > <f32>1e-3) {
          y0 /= yn; y1 /= yn; y2 /= yn;
          const x0: f32 = y1 * z2 - y2 * z1, x1: f32 = y2 * z0 - y0 * z2, x2: f32 = y0 * z1 - y1 * z0;
          setR(s, 0, 0, x0); setR(s, 0, 1, x1); setR(s, 0, 2, x2);
          setR(s, 1, 0, y0); setR(s, 1, 1, y1); setR(s, 1, 2, y2);
          setR(s, 2, 0, z0); setR(s, 2, 1, z1); setR(s, 2, 2, z2);
        }
      }
      store<i32>(s, 1, 72);
    }
  } else {
    // tilt correction: predicted gravity in the body = R^T (0,0,-1) = -(third row of R)
    const n: f32 = Mathf.sqrt(a0 * a0 + a1 * a1 + a2 * a2);
    if (k > 0 && n > <f32>0.8 && n < <f32>1.2) {
      const g0: f32 = a0 / n, g1: f32 = a1 / n, g2: f32 = a2 / n, p0: f32 = -R(s, 2, 0), p1: f32 = -R(s, 2, 1), p2: f32 = -R(s, 2, 2);
      const e0: f32 = g1 * p2 - g2 * p1, e1: f32 = g2 * p0 - g0 * p2, e2: f32 = g0 * p1 - g1 * p0;
      w0 += k * e0; w1 += k * e1; w2 += k * e2;
    }
    const th: f32 = Mathf.sqrt(w0 * w0 + w1 * w1 + w2 * w2) * dt;
    if (fin(th) && th > <f32>1e-9) {
      const u0: f32 = w0 * dt / th, u1: f32 = w1 * dt / th, u2: f32 = w2 * dt / th, c: f32 = Mathf.cos(th), sn: f32 = Mathf.sin(th), v: f32 = 1 - c;
      const E = EM;
      setR(E, 0, 0, c + u0 * u0 * v);       setR(E, 0, 1, u0 * u1 * v - u2 * sn); setR(E, 0, 2, u0 * u2 * v + u1 * sn);
      setR(E, 1, 0, u1 * u0 * v + u2 * sn); setR(E, 1, 1, c + u1 * u1 * v);       setR(E, 1, 2, u1 * u2 * v - u0 * sn);
      setR(E, 2, 0, u2 * u0 * v - u1 * sn); setR(E, 2, 1, u2 * u1 * v + u0 * sn); setR(E, 2, 2, c + u2 * u2 * v);
      m3mul(s, s, E);
      m3orthonormalize(s);
    }
  }
  // reported angular velocity: the gyro itself (revolutions / s), without the tilt correction term
  mapApply(m, rot, WR, load<f32>(m, 28) / (2 * PI_F));
  for (let i = 0; i < 3; i++) {
    const o = <usize>i << 2, wr = load<f32>(WR + o);
    store<f32>(s + 60 + o, wr); store<f32>(s + 48 + o, load<f32>(A3 + o));
    if (dt > 0 && dt <= <f32>0.25) { const angle: f32 = load<f32>(s + 36 + o) + wr * dt; if (fin(angle)) store<f32>(s + 36 + o, angle); }
  }
}
// The SixAxisSensorState fields from the state: acc[3], gyro[3], angle[3], dir[9] (rows = the controller's x, y, z
// axes in the world) as 18 consecutive floats at out
export function motionFill(s: usize, out: usize): void {
  for (let i = 0; i < 3; i++) {
    const o = <usize>i << 2;
    store<f32>(out + o, load<f32>(s + 48 + o)); store<f32>(out + 12 + o, load<f32>(s + 60 + o)); store<f32>(out + 24 + o, load<f32>(s + 36 + o));
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) store<f32>(out + 36 + (<usize>(3 * i + j) << 2), R(s, j, i));
}
// A phone's own sensors (x to the right of the screen in portrait, y to its top, z out of the screen) in the Switch
// frame for how the screen is turned: 1 portrait, 2 upside down, 3 landscape right, 4 landscape left
export function motionPhoneToSwitch(orient: i32, inp: usize, out: usize): void {
  const x = load<f32>(inp), y = load<f32>(inp, 4), z = load<f32>(inp, 8);
  switch (orient) {
    case 3: store<f32>(out, -y); store<f32>(out, x, 4); break;
    case 4: store<f32>(out, y); store<f32>(out, -x, 4); break;
    case 2: store<f32>(out, -x); store<f32>(out, -y, 4); break;
    default: store<f32>(out, x); store<f32>(out, y, 4); break;
  }
  store<f32>(out, z, 8);
}
