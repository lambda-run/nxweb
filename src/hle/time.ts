// nn::time: port of nxnative dm/host/hle_time.c. A console gets the network-calibrated user clock from the time
// service; the host reads its own clocks (imports hle_real_ns, hle_mono_ns, hle_tz). Layouts are the public Horizon
// ABI: PosixTime = s64 seconds; CalendarTime = { s16 year, s8 month, day, hour, minute, second, pad } (8 bytes);
// CalendarAdditionalInfo = { u32 day of week, u32 day of year, char zone[8], u32 DST, s32 UTC offset } (0x18 bytes);
// SteadyClockTimePoint = { s64 seconds, 16-byte source id } (0x18); SystemClockContext = { s64 offset, time point } (0x20);
// ClockSnapshot 0xD0 bytes.
import { X, I, P, monoNs, realNs, guestNs, cfg, CFG_FIXED_TIME, guestSym, guestCall5, ls, ps, pi, pu, pz, le, red, zero, copy, zcopy, sput } from "./base";
import { localBreakDown, localToUtc, fieldsToUtc, writeTmZone, ZONE, zoneAt, tSec, tMin, tHour, tMday, tMon, tYear, tWday, tYday, tIsdst, tGmtoff } from "./cal";
import { mktimeAt, localtimeInto } from "./libc";

const CTX: usize = memory.data(32);
const TP: usize = memory.data(24);
const STP: usize = memory.data(24);
const TM: usize = memory.data(56);     // localtime's static result
let ctxMade: bool = false, ctxDrift: i64 = 0, calLogged: bool = false, benefitFn: u64 = 0, benefitLooked: bool = false;
export function timeInit(): void { ctxMade = false; ctxDrift = 0; calLogged = false; benefitFn = 0; benefitLooked = false; }

function fixedTime(): i64 { return cfg(CFG_FIXED_TIME); }
function floorDiv(a: i64, b: i64): i64 { const q = a / b; return (a % b != 0 && a < 0) ? q - 1 : q; }
export function userNow(): i64 { const ft = fixedTime(); return ft >= 0 ? ft : floorDiv(realNs(), 1000000000); }
export function steadyNow(out: usize): void {
  store<i64>(out, <i64>(monoNs() / 1000000000));
  sput(out + 8, "dmhost-steady-01");
}
function zoneName(dst: usize, cap: usize): void { zoneAt(userNow()); zcopy(dst, ZONE, cap); }

export function h_time_SteadyNow(a: usize): u64 { steadyNow(P(a, 0)); return 0; }
export function h_time_SteadyNowFn(a: usize): u64 { steadyNow(P(a, 0)); return 0; }
export function h_time_GetCurrentTime(a: usize): u64 { store<i64>(P(a, 0), userNow()); return 0; }
export function h_time_AdjGetCurrentTime(a: usize): u64 { store<i64>(P(a, 0), userNow()); return 0; }
function timespec(ts: usize): u64 {
  const ft = fixedTime();
  if (ft >= 0) { store<i64>(ts, ft); store<i64>(ts, 0, 8); return 0; }
  const ns = realNs(), s = floorDiv(ns, 1000000000);
  store<i64>(ts, s); store<i64>(ts, ns - s * 1000000000, 8);
  return 0;
}
export function h_time_StdTimespec(a: usize): u64 { return timespec(P(a, 0)); }
export function h_time_AdjTimespec(a: usize): u64 { return timespec(P(a, 0)); }
export function h_time_MonoTimespec(a: usize): u64 {
  const ns = monoNs(), ts = P(a, 0);
  store<i64>(ts, <i64>(ns / 1000000000)); store<i64>(ts, <i64>(ns % 1000000000), 8);
  return 0;
}
// The user clock context: the host's user clock over its steady clock, the same until the host clock moves against
// the guest ticks by more than a second (with a fixed time it is made once)
export function getContext(out: usize): void {
  steadyNow(TP);
  const now = userNow();
  const d = now - <i64>(guestNs() / 1000000000);
  const moved = d - ctxDrift;
  if (!ctxMade || (fixedTime() < 0 && (moved > 1 || moved < -1))) {
    store<i64>(CTX, now - load<i64>(TP)); copy(CTX + 8, TP, 0x18);
    if (ctxMade) { ls(); ps("time: host clock moved "); pi(moved); ps(" s against the guest ticks, new user clock context"); le(); }
    ctxDrift = d; ctxMade = true;
  }
  copy(out, CTX, 0x20);
}
export function h_time_GetContext(a: usize): u64 { getContext(P(a, 0)); return 0; }
export function h_time_now(a: usize): u64 { return <u64>userNow(); }
export function h_time_to_time_t(a: usize): u64 { return load<u64>(P(a, 0)); }
export function toCalendar(ct: usize, ai: usize, t: i64): void {
  localBreakDown(t);
  if (!calLogged) { calLogged = true; ls(); ps("ToCalendarTime: first conversion "); pi(t); ps(" -> "); pi(<i64>tYear + 1900); ps("-"); pi(tMon + 1); ps("-"); pi(tMday); ps(" "); pi(tHour); ps(":"); pi(tMin); ps(" (time zone "); pz(ZONE); ps(", offset "); pi(tGmtoff); ps(" s)"); le(); }
  if (ct) { store<i16>(ct, <i16>(tYear + 1900)); store<i8>(ct, <i8>(tMon + 1), 2); store<i8>(ct, <i8>tMday, 3); store<i8>(ct, <i8>tHour, 4); store<i8>(ct, <i8>tMin, 5); store<i8>(ct, <i8>tSec, 6); store<i8>(ct, 0, 7); }
  if (ai) { zero(ai, 0x18); store<u32>(ai, tWday); store<u32>(ai, tYday, 4); zcopy(ai + 8, ZONE, 8); store<u32>(ai, tIsdst > 0 ? 1 : 0, 16); store<i32>(ai, <i32>tGmtoff, 20); }
}
export function h_time_ToCalendarTime(a: usize): u64 { toCalendar(P(a, 0), P(a, 1), load<i64>(P(a, 2))); return 0; }
export function h_time_ToCalendarTimeRule(a: usize): u64 { toCalendar(P(a, 0), P(a, 1), load<i64>(P(a, 2))); return 0; }
function snapshot(s: usize): void {
  zero(s, 0xd0);
  steadyNow(STP);
  const now = userNow();
  getContext(s);   // +0x00: the same in every snapshot until the host clock is set
  store<i64>(s, now, 0x40);
  toCalendar(s + 0x50, s + 0x60, now);
  copy(s + 0x90, STP, 0x18);
  zoneName(s + 0xa8, 0x24);
  store<u8>(s, 1, 0xcd);   // type 1 standard, 2 adjustable; 0 is uninitialized
}
export function h_time_Snapshot(a: usize): u64 { snapshot(P(a, 0)); return 0; }
export function h_time_AdjSnapshot(a: usize): u64 { const s = P(a, 0); snapshot(s); store<u8>(s, 2, 0xcd); return 0; }
function sameSource(x: usize, y: usize, tp: usize): bool { return load<u64>(x + tp + 8) == load<u64>(y + tp + 8) && load<u64>(x + tp + 16) == load<u64>(y + tp + 16); }
// Returns bool, not a Result: true when the span was stored
export function h_time_SpanBetween(a: usize): u64 {
  const out = P(a, 0), x = P(a, 1), y = P(a, 2);
  let s: i64;
  if (sameSource(x, y, 0x90)) s = load<i64>(y, 0x90) - load<i64>(x, 0x90);
  else if (load<i64>(x, 0x48) && load<i64>(y, 0x48)) s = load<i64>(y, 0x48) - load<i64>(x, 0x48);
  else return 0;   // no common clock: *out untouched
  store<i64>(out, s * 1000000000);
  return 1;
}
export function h_time_UserDiff(a: usize): u64 {
  const x = P(a, 0), y = P(a, 1);
  if (!sameSource(x, y, 0x08) || (load<u8>(x, 0xcc) && load<u8>(y, 0xcc))) return 0;
  return <u64>((load<i64>(y) - load<i64>(x)) * 1000000000);
}
// The public entry only checks the time service session and tail-calls the SDK's detail:: implementation, which
// compares the snapshots: forwarded into the guest
export function h_time_ClaimBenefit(a: usize): u64 {
  if (!benefitLooked) {
    benefitLooked = true;
    benefitFn = guestSym("_ZN2nn4time6detail39ClaimPeriodicBenefitWithUserSystemClockEPNS0_27PeriodicBenefitClaimContextERKNS0_13ClockSnapshotERKNS_8TimeSpanES9_PKNS0_25CheckCalendarTimeCallbackE");
  }
  if (!benefitFn) { red("time: the sdk has ClaimPeriodicBenefitWithUserSystemClock but not its detail:: implementation: answered 0"); return 0; }
  const r = guestCall5(benefitFn, X(a, 0), X(a, 1), X(a, 2), X(a, 3), X(a, 4));
  ls(); ps("time: periodic benefit claim -> "); pu(<u32>r); le();
  return r;
}
export function h_time_LocUpdated(a: usize): u64 {
  const name = P(a, 0);
  zero(name, 0x24); zoneName(name, 0x24);
  zero(P(a, 1), 0x18);
  return 0;
}
function ctSeconds(ct: usize, local: bool): i64 {
  const y = <i64>load<i16>(ct) - 1900, mo = <i64>load<i8>(ct, 2) - 1, d = <i64>load<i8>(ct, 3), h = <i64>load<i8>(ct, 4), mi = <i64>load<i8>(ct, 5), s = <i64>load<i8>(ct, 6);
  return local ? localToUtc(y, mo, d, h, mi, s) : fieldsToUtc(y, mo, d, h, mi, s);
}
function toPosix(a: usize): u64 {
  const count = P(a, 0), out = P(a, 1), n = I(a, 2);
  const t = ctSeconds(P(a, 3), true);
  if (count) store<i32>(count, n > 0 ? 1 : 0);
  if (n > 0 && out) store<i64>(out, t);
  return 0;
}
export function h_time_ToPosixTime(a: usize): u64 { return toPosix(a); }
export function h_time_ToPosixTimeRule(a: usize): u64 { return toPosix(a); }
export function h_time_ToPosixUtc(a: usize): u64 { return <u64>ctSeconds(P(a, 0), false); }
// The SDK's own localtime / mktime have no time zone data and always use UTC: forced onto the host's zone
export function h_localtime(a: usize): u64 { localtimeInto(load<i64>(P(a, 0)), TM); return <u64>TM; }
export function h_localtime_r(a: usize): u64 { localtimeInto(load<i64>(P(a, 0)), P(a, 1)); return X(a, 1); }
export function h_mktime(a: usize): u64 { return <u64>mktimeAt(P(a, 0)); }
