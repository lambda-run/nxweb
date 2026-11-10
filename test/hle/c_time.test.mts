// nn::time and the C library's local time (src/hle/time.ts, cal.ts; nxnative hle_time.c and the time entries of
// hle_sdk16.c). The scenarios of nxnative's dm/host/tests/t_time.c, then the layouts byte for byte.
import assert from "node:assert/strict";
import { test, Hle, RES_FAIL } from "./harness.mts";

const SNAP = "_ZN2nn4time13ClockSnapshot29CreateWithStandardSystemClockEPS1_", ADJ = "_ZN2nn4time13ClockSnapshot31CreateWithAdjustableSystemClockEPS1_";
const SPAN = "_ZN2nn4time20CalculateSpanBetweenEPNS_8TimeSpanERKNS0_13ClockSnapshotES5_";
const UDIFF = "_ZN2nn4time48CalculateStandardUserSystemClockDifferenceByUserERKNS0_13ClockSnapshotES3_";
const NS = 1_000_000_000n;

test("time (t_time): snapshots stay in their 0xD0 bytes and carry the fixed time's UTC calendar", () => {
  const h = new Hle(); h.host.config({ fixedTime: 1700000000 });
  const a = h.alloc(0xd0, 0x5A), g = h.alloc(0xf0, 0xA5), adj = g + 0x10;
  assert.equal(h.call(SNAP, a).x0, 0n);
  assert.equal(h.u8[a + 0xcd], 1, "standard snapshot type is 1");
  const guards = () => h.read(g, 0x10).every(b => b === 0xA5) && h.read(g + 0xe0, 0x10).every(b => b === 0xA5);
  h.call(SNAP, adj); assert.ok(guards(), "the standard snapshot writes only its 0xd0 bytes");
  h.u8.fill(0xA5, g, g + 0xf0);
  assert.equal(h.call(ADJ, adj).x0, 0n); assert.ok(guards(), "the adjustable snapshot writes only its 0xd0 bytes");
  assert.equal(h.u8[adj + 0xcd], 2, "adjustable snapshot type is 2");
  assert.equal(h.i64(adj + 0x40), 1700000000n, "the user time follows the host clock");
  assert.deepEqual([h.dv.getInt16(adj + 0x50, true), ...h.read(adj + 0x52, 5)], [2023, 11, 14, 22, 13, 20], "the UTC calendar of the fixed time");
  assert.ok(h.read(adj + 0x20, 0x20).every(b => b === 0) && h.i64(adj + 0x48) === 0n, "offline: no network clock context or time");
  assert.deepEqual(h.read(a + 0x98, 16), h.read(adj + 0x98, 16), "both snapshots use the same steady clock source");
  assert.equal(h.call(UDIFF, a, adj).x0, 0n, "changing the snapshot type is no user clock change");
  assert.equal(h.cstr(adj + 0xa8), "UTC", "the host time zone");
  // the whole layout
  const s = h.read(adj, 0xd0), want = Buffer.alloc(0xd0);
  want.writeBigInt64LE(1700000000n - 5n, 0); want.writeBigInt64LE(5n, 8); want.write("dmhost-steady-01", 0x10, "latin1");   // user clock context: offset, then the steady time point it was made at
  want.writeBigInt64LE(1700000000n, 0x40);
  want.writeInt16LE(2023, 0x50); want.set([11, 14, 22, 13, 20, 0], 0x52);
  want.writeUInt32LE(2, 0x60); want.writeUInt32LE(317, 0x64); want.write("UTC", 0x68, "latin1"); want.writeUInt32LE(0, 0x70); want.writeInt32LE(0, 0x74);   // Tuesday, day 317
  want.writeBigInt64LE(5n, 0x90); want.write("dmhost-steady-01", 0x98, "latin1");
  want.write("UTC", 0xa8, "latin1"); want[0xcd] = 2;
  assert.deepEqual(s, want);
});

test("time (t_time): span and user clock difference between snapshots", () => {
  const h = new Hle(); h.host.config({ fixedTime: 1700000000 });
  const a = h.alloc(0xd0), b = h.alloc(0xd0), c = h.alloc(0xd0), ts = h.alloc(8);
  const cp = (dst: number, src: number) => h.u8.copyWithin(dst, src, src + 0xd0);
  const span = (x: number, y: number) => { const r = h.w0(SPAN, ts, x, y); return [r, h.i64(ts)] as [number, bigint]; };
  const udiff = (x: number, y: number) => BigInt.asIntN(64, h.call(UDIFF, x, y).x0);
  h.call(SNAP, a);
  cp(b, a); h.u8[b + 0xcd] = 2;
  h.dv.setBigInt64(ts, -1n, true);
  assert.deepEqual(span(a, b), [1, 0n], "changing only the type leaves the span at zero");
  h.host.config({ fixedTime: -1 });
  assert.deepEqual(span(a, a), [1, 0n], "a snapshot with itself");
  cp(b, a); h.dv.setBigInt64(b + 0x90, h.i64(a + 0x90) + 90n, true);
  assert.deepEqual(span(a, b), [1, 90n * NS], "from the steady time points, in nanoseconds");
  assert.deepEqual(span(b, a), [1, -90n * NS], "backwards is negative");
  cp(c, b); h.u8[c + 0x98] ^= 1; h.dv.setBigInt64(ts, 1234n, true);
  assert.deepEqual(span(a, c), [0, 1234n], "different sources and no network time: false, the output untouched");
  h.dv.setBigInt64(a + 0x48, 1000n, true); h.dv.setBigInt64(c + 0x48, 1600n, true);
  assert.deepEqual(span(a, c), [1, 600n * NS], "different sources: from the network times");
  h.call(SNAP, a); h.call(SNAP, b);
  assert.equal(udiff(a, b), 0n, "two host snapshots in a row: the user did not move the clock");
  cp(b, a); h.dv.setBigInt64(b, h.i64(a) + 3600n, true);
  assert.equal(udiff(a, b), 3600n * NS, "the user clock moved an hour");
  h.u8[b + 0x10] ^= 1; assert.equal(udiff(a, b), 0n, "contexts of different steady sources: 0");
  h.u8[b + 0x10] ^= 1; h.u8[a + 0xcc] = h.u8[b + 0xcc] = 1; assert.equal(udiff(a, b), 0n, "automatic correction on in both: 0");
  h.u8[a + 0xcc] = 0; assert.equal(udiff(a, b), 3600n * NS, "automatic correction in one only: the difference");
});

test("time (t_time): the periodic benefit claim goes to the SDK's detail:: implementation; its two service questions", () => {
  const h = new Hle(); h.host.config({ fixedTime: 1700000000 });
  const CLAIM = "_ZN2nn4time39ClaimPeriodicBenefitWithUserSystemClockEPNS0_27PeriodicBenefitClaimContextERKNS0_13ClockSnapshotERKNS_8TimeSpanES8_PKNS0_25CheckCalendarTimeCallbackE";
  let got: bigint[] = [];
  const g = new Hle();
  assert.equal(g.call(CLAIM, 1, 2, 3, 4, 5).x0, 0n); assert.equal(g.red.length, 1, "no detail:: implementation in the guest: red (nxnative stops)");
  h.fn((...args) => { got = args; return 7; }, "_ZN2nn4time6detail39ClaimPeriodicBenefitWithUserSystemClockEPNS0_27PeriodicBenefitClaimContextERKNS0_13ClockSnapshotERKNS_8TimeSpanES9_PKNS0_25CheckCalendarTimeCallbackE");
  assert.equal(h.call(CLAIM, 0x1111, 0x2222, 0x3333, 0x4444, 0x5555).x0, 7n, "the SDK implementation's answer");
  assert.deepEqual(got, [0x1111n, 0x2222n, 0x3333n, 0x4444n, 0x5555n], "every argument passed on");
  const a = h.alloc(0xd0), tp = h.alloc(0x20, 0xAA), loc = h.alloc(0x28, 0xAA);
  h.call(SNAP, a);
  assert.equal(h.call("_ZN2nn4time6detail56GetStandardUserSystemClockAutomaticCorrectionUpdatedTimeEPNS0_20SteadyClockTimePointE", tp).x0, 0n);
  assert.ok(h.read(tp, 0x18).every(b => b === 0) && h.read(tp + 0x18, 8).every(b => b === 0xAA), "a cleared time point, 0x18 bytes");
  h.u8.fill(0xAA, tp, tp + 0x20);
  assert.equal(h.call("_ZN2nn4time6detail35GetDeviceLocationNameAndUpdatedTimeEPNS0_12LocationNameEPNS0_20SteadyClockTimePointE", loc, tp).x0, 0n);
  assert.deepEqual(h.read(loc, 0x24), h.read(a + 0xa8, 0x24), "the snapshot's location name");
  assert.ok(h.read(loc + 0x24, 4).every(b => b === 0xAA) && h.read(tp, 0x18).every(b => b === 0));
  assert.notDeepEqual(h.read(tp + 8, 16), h.read(a + 0x98, 16), "the cleared time point's source is not the snapshots' steady clock");
});

test("time: the clocks: steady, user, timespecs, and the user clock context renewed only when the host clock is set", () => {
  const h = new Hle();
  const tp = h.alloc(0x20, 0xEE);
  assert.equal(h.call("_ZN2nn4time19StandardSteadyClock19GetCurrentTimePointEPNS0_20SteadyClockTimePointE", tp).x0, 0n);
  assert.deepEqual(h.read(tp, 0x20), Buffer.concat([Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]), Buffer.from("dmhost-steady-01"), Buffer.alloc(8, 0xEE)]));
  h.monoNs = 7_999_999_999n;
  h.call("_ZN2nn4time38GetStandardSteadyClockCurrentTimePointEPNS0_20SteadyClockTimePointE", tp); assert.equal(h.i64(tp), 7n);
  const t = h.alloc(16, 0xEE);
  h.call("_ZN2nn4time23StandardUserSystemClock14GetCurrentTimeEPNS0_9PosixTimeE", t); assert.equal(h.i64(t), 1_700_000_000n);
  h.call("_ZN2nn4time25AdjustableUserSystemClock14GetCurrentTimeEPNS0_9PosixTimeE", t); assert.equal(h.i64(t), 1_700_000_000n);
  assert.equal(h.call("_ZN2nn4time23StandardUserSystemClock3nowEv").x0, 1_700_000_000n);
  h.dv.setBigInt64(t, -5n, true); assert.equal(BigInt.asIntN(64, h.call("h_time_to_time_t", t).x0), -5n);
  for (const n of ["_ZN2nn4time41GetStandardUserSystemClockCurrentTimespecEP8timespec", "_ZN2nn4time43GetAdjustableUserSystemClockCurrentTimespecEP8timespec"]) {
    assert.equal(h.w0(n, t), 0); assert.deepEqual([h.i64(t), h.i64(t + 8)], [1_700_000_000n, 123_456_789n]);
  }
  assert.equal(h.w0("_ZN2nn4time37GetStandardSteadyClockCurrentTimespecEP8timespec", t), 0); assert.deepEqual([h.i64(t), h.i64(t + 8)], [7n, 999_999_999n]);
  h.host.config({ fixedTime: 42 });
  h.call("_ZN2nn4time41GetStandardUserSystemClockCurrentTimespecEP8timespec", t); assert.deepEqual([h.i64(t), h.i64(t + 8)], [42n, 0n], "a fixed time has no nanoseconds");
  h.host.config({ fixedTime: -1 });
  assert.equal(h.w0("_ZN2nn4time13IsInitializedEv"), 1); assert.equal(h.w0("_ZN2nn4time26StandardNetworkSystemClock20IsAccuracySufficientEv"), 0);
  assert.equal(h.call("_ZN2nn4time26StandardNetworkSystemClock14GetCurrentTimeEPNS0_9PosixTimeE", t).x0, RES_FAIL);
  // the context: 0x20 bytes { offset, steady time point }; the same until the host clock moves against the guest ticks by more than a second
  const CTX = "_ZN2nn4time23StandardUserSystemClock21GetSystemClockContextEPNS0_18SystemClockContextE";
  const c1 = h.alloc(0x28, 0xEE), c2 = h.alloc(0x28, 0xEE);
  h.monoNs = 10n * NS; h.guestNs = 3n * NS; h.realNs = 1000n * NS;
  h.call(CTX, c1);
  assert.deepEqual(h.read(c1, 0x28), Buffer.concat([Buffer.from([990 & 255, 990 >> 8, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0]), Buffer.from("dmhost-steady-01"), Buffer.alloc(8, 0xEE)]));
  h.monoNs = 70n * NS; h.guestNs = 63n * NS; h.realNs = 1061n * NS;   // a minute later, the clocks one second apart: the same context
  h.call(CTX, c2); assert.deepEqual(h.read(c2, 0x20), h.read(c1, 0x20));
  h.realNs = 5000n * NS;   // the host clock was set
  h.call(CTX, c2); assert.equal(h.i64(c2), 4930n); assert.equal(h.i64(c2 + 8), 70n);
  assert.ok(h.logs.some(l => l.includes("host clock moved")));
});

test("time: calendar conversions in the host's zone, with the layouts of CalendarTime and CalendarAdditionalInfo", () => {
  const h = new Hle();
  // a zone with daylight saving: UTC+1, UTC+2 between the last Sundays of March and October 2024
  const dst = (t: bigint) => t >= 1711846800n && t < 1730077200n;
  h.zone = t => dst(t) ? { offset: 7200, dst: true, name: "CEST" } : { offset: 3600, dst: false, name: "CET" };
  const TOCAL = "_ZN2nn4time14ToCalendarTimeEPNS0_12CalendarTimeEPNS0_22CalendarAdditionalInfoERKNS0_9PosixTimeE";
  const ct = h.alloc(16, 0xEE), ai = h.alloc(0x20, 0xEE), pt = h.alloc(8);
  const conv = (t: bigint, name = TOCAL) => { h.dv.setBigInt64(pt, t, true); assert.equal(h.call(name, ct, ai, pt, 0).x0, 0n); return { ct: h.read(ct, 16), ai: h.read(ai, 0x20) }; };
  let r = conv(1720000000n);   // 2024-07-03 09:46:40 UTC, a Wednesday, day 184 (0-based)
  const wantCt = Buffer.alloc(16, 0xEE); wantCt.writeInt16LE(2024, 0); wantCt.set([7, 3, 11, 46, 40, 0], 2);
  assert.deepEqual(r.ct, wantCt, "CalendarTime: s16 year, s8 month day hour minute second, one pad byte: 8 bytes");
  const wantAi = Buffer.alloc(0x20, 0xEE); wantAi.fill(0, 0, 0x18); wantAi.writeUInt32LE(3, 0); wantAi.writeUInt32LE(184, 4); wantAi.write("CEST", 8, "latin1"); wantAi.writeUInt32LE(1, 16); wantAi.writeInt32LE(7200, 20);
  assert.deepEqual(r.ai, wantAi, "CalendarAdditionalInfo: 0x18 bytes");
  r = conv(1704067199n, "_ZN2nn4time14ToCalendarTimeEPNS0_12CalendarTimeEPNS0_22CalendarAdditionalInfoERKNS0_9PosixTimeERKNS0_12TimeZoneRuleE");   // 2023-12-31 23:59:59 UTC
  assert.deepEqual([r.ct.readInt16LE(0), ...r.ct.subarray(2, 7)], [2024, 1, 1, 0, 59, 59], "the explicit-rule form converts in the device zone too");
  assert.deepEqual([r.ai.readUInt32LE(0), r.ai.readUInt32LE(4), r.ai.readUInt32LE(16), r.ai.readInt32LE(20)], [1, 0, 0, 3600]);
  h.dv.setBigInt64(pt, 0n, true); h.call(TOCAL, 0, 0, pt);   // null outputs
  h.zone = () => ({ offset: -12600, dst: false, name: "LONGZONENAME" });
  r = conv(86400n);
  assert.deepEqual(r.ai.subarray(8, 16), Buffer.from("LONGZON\0"), "the zone name is cut to 7 bytes");
  assert.deepEqual([r.ct.readInt16LE(0), ...r.ct.subarray(2, 7)], [1970, 1, 1, 20, 30, 0]);
  // UTC calendar by value in x0, and back
  h.dv.setBigInt64(pt, 1720000000n, true);
  const v = h.call("_ZN2nn4time19ToCalendarTimeInUtcERKNS0_9PosixTimeE", pt).x0;
  assert.equal(v, 2024n | 7n << 16n | 3n << 24n | 9n << 32n | 46n << 40n | 40n << 48n);
  h.dv.setBigInt64(pt, -1n, true);
  assert.equal(h.call("_ZN2nn4time19ToCalendarTimeInUtcERKNS0_9PosixTimeE", pt).x0, 1969n | 12n << 16n | 31n << 24n | 23n << 32n | 59n << 40n | 59n << 48n, "before 1970");
  const put = (y: number, mo: number, d: number, hh: number, mi: number, s: number) => { h.dv.setInt16(ct, y, true); h.u8.set([mo, d, hh, mi, s, 0], ct + 2); };
  put(2024, 7, 3, 9, 46, 40);
  assert.equal(h.call("_ZN2nn4time18ToPosixTimeFromUtcERKNS0_12CalendarTimeE", ct).x0, 1720000000n);
  put(2000, 2, 29, 0, 0, 0); assert.equal(h.call("_ZN2nn4time18ToPosixTimeFromUtcERKNS0_12CalendarTimeE", ct).x0, 951782400n, "a leap day");
  // local calendar -> seconds: count and the first result
  h.zone = t => dst(t) ? { offset: 7200, dst: true, name: "CEST" } : { offset: 3600, dst: false, name: "CET" };
  const count = h.alloc(4, 0xEE), out = h.alloc(16, 0xEE);
  put(2024, 7, 3, 11, 46, 40);
  assert.equal(h.call("_ZN2nn4time11ToPosixTimeEPiPNS0_9PosixTimeEiRKNS0_12CalendarTimeE", count, out, 2, ct).x0, 0n);
  assert.deepEqual([h.i32(count), h.i64(out), h.i64(out + 8)], [1, 1720000000n, BigInt.asIntN(64, 0xEEEEEEEEEEEEEEEEn)]);
  put(2024, 1, 1, 0, 59, 59);
  h.call("_ZN2nn4time11ToPosixTimeEPiPNS0_9PosixTimeEiRKNS0_12CalendarTimeERKNS0_12TimeZoneRuleE", count, out, 1, ct, 0); assert.equal(h.i64(out), 1704067199n);
  h.dv.setBigInt64(out, 5n, true);
  h.call("_ZN2nn4time11ToPosixTimeEPiPNS0_9PosixTimeEiRKNS0_12CalendarTimeE", count, out, 0, ct); assert.deepEqual([h.i32(count), h.i64(out)], [0, 5n], "no room: count 0, nothing written");
  const loc = h.alloc(0x28, 0xEE);
  assert.equal(h.call("_ZN2nn4time21GetDeviceLocationNameEPNS0_12LocationNameE", loc).x0, 0n);
  assert.deepEqual(h.read(loc, 0x28), Buffer.concat([Buffer.from("CET"), Buffer.alloc(0x21), Buffer.alloc(4, 0xEE)]), "LocationName: 0x24 bytes, the zone at the user clock's now (November 2023)");
});

test("time: localtime, localtime_r and mktime follow the host's zone; struct tm layout", () => {
  const h = new Hle();
  h.zone = t => t >= 1711846800n && t < 1730077200n ? { offset: 7200, dst: true, name: "CEST" } : { offset: 3600, dst: false, name: "CET" };
  const t = h.alloc(8), tm = h.alloc(64, 0xEE);
  h.dv.setBigInt64(t, 1720000000n, true);
  assert.equal(h.call("localtime_r", t, tm).x0, BigInt(tm), "returns its second argument");
  const ints = (p: number) => Array.from({ length: 9 }, (_, i) => h.i32(p + 4 * i));
  assert.deepEqual(ints(tm), [40, 46, 11, 3, 6, 124, 3, 184, 1], "sec min hour mday mon year wday yday isdst");
  assert.equal(h.i64(tm + 40), 7200n, "tm_gmtoff at +40");
  assert.equal(h.cstr(Number(h.u64(tm + 48))), "CEST", "tm_zone at +48");
  assert.ok(h.read(tm + 56, 8).every(b => b === 0xEE), "56 bytes");
  const p = Number(h.call("localtime", t).x0);
  assert.deepEqual(ints(p), ints(tm)); assert.notEqual(p, tm, "localtime answers in the host's static struct");
  // mktime: tm_isdst is not consulted; the fields are normalized
  for (let i = 0; i < 9; i++) h.dv.setInt32(tm + 4 * i, [100, 45, 11, 3, 6, 124, 0, 0, -1][i], true);   // 11:45:100 = 11:46:40
  assert.equal(h.call("mktime", tm).x0, 1720000000n);
  assert.deepEqual(ints(tm), [40, 46, 11, 3, 6, 124, 3, 184, 1]);
  assert.equal(h.host.entries()[h.id("mktime")].forced, true, "the forced entry of hle_time.c, not the pass-through");
});
