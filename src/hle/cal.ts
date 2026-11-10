// Calendar arithmetic and the C library's struct tm (9 ints, long tm_gmtoff at +40, char *tm_zone at +48; the same
// layout on the Switch and on the Mac, nxnative hle_time.c). The time zone is the embedder's (import hle_tz).
import { hostTz } from "./base";

// Days since 1970-01-01 of a proleptic Gregorian date (month 1..12)
export function daysFromCivil(y: i64, m: i64, d: i64): i64 {
  y -= m <= 2 ? 1 : 0;
  const era = (y >= 0 ? y : y - 399) / 400;
  const yoe = y - era * 400;
  const doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}
export let cY: i64 = 0, cM: i32 = 0, cD: i32 = 0;
export function civilFromDays(z: i64): void {
  z += 719468;
  const era = (z >= 0 ? z : z - 146096) / 146097;
  const doe = z - era * 146097;
  const yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const mp = (5 * doy + 2) / 153;
  cD = <i32>(doy - (153 * mp + 2) / 5 + 1);
  cM = <i32>(mp < 10 ? mp + 3 : mp - 9);
  cY = y + (cM <= 2 ? 1 : 0);
}
function floorDiv(a: i64, b: i64): i64 { const q = a / b; return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q; }
function isLeap(y: i64): bool { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }

// Broken-down time, the fields of struct tm
export let tSec: i32 = 0, tMin: i32 = 0, tHour: i32 = 0, tMday: i32 = 0, tMon: i32 = 0, tYear: i32 = 0, tWday: i32 = 0, tYday: i32 = 0, tIsdst: i32 = 0;
export let tGmtoff: i64 = 0;
// UTC seconds -> the fields, shifted by off seconds
export function breakDown(t: i64, off: i64): void {
  const local = t + off;
  const days = floorDiv(local, 86400), rem = local - days * 86400;
  civilFromDays(days);
  tSec = <i32>(rem % 60); tMin = <i32>((rem / 60) % 60); tHour = <i32>(rem / 3600);
  tMday = cD; tMon = cM - 1; tYear = <i32>(cY - 1900);
  tWday = <i32>(((days % 7) + 11) % 7);   // 1970-01-01 was a Thursday
  tYday = <i32>(days - daysFromCivil(cY, 1, 1));
  tGmtoff = off;
}
// The fields (out of range values are carried, as timegm does) -> seconds, read as UTC
export function fieldsToUtc(year: i64, mon: i64, mday: i64, hour: i64, min: i64, sec: i64): i64 {
  year += floorDiv(mon, 12); mon -= floorDiv(mon, 12) * 12;
  return (daysFromCivil(year + 1900, mon + 1, 1) + mday - 1) * 86400 + hour * 3600 + min * 60 + sec;
}

// The host's zone at a moment
const TZ: usize = memory.data(16);
export const ZONE: usize = memory.data(16);   // the zone name tm_zone points at
export let zOff: i32 = 0, zDst: i32 = 0;
export function zoneAt(t: i64): void {
  store<u64>(TZ, 0); store<u64>(TZ, 0, 8);
  hostTz(t, TZ);
  zOff = load<i32>(TZ); zDst = load<i32>(TZ, 4) != 0 ? 1 : 0;
  memory.copy(ZONE, TZ + 8, 8); store<u8>(ZONE, 0, 8);
  if (!load<u8>(ZONE)) { store<u8>(ZONE, 0x55); store<u8>(ZONE, 0x54, 1); store<u8>(ZONE, 0x43, 2); store<u8>(ZONE, 0, 3); }   // "UTC"
}
export function localBreakDown(t: i64): void { zoneAt(t); breakDown(t, zOff); tIsdst = zDst; }
// Local fields -> seconds (mktime with tm_isdst = -1). Around a daylight-saving switch one local time maps to none
// or two moments; this gives the one the offset at the first guess leads to
export function localToUtc(year: i64, mon: i64, mday: i64, hour: i64, min: i64, sec: i64): i64 {
  const g = fieldsToUtc(year, mon, mday, hour, min, sec);
  zoneAt(g); const o1 = zOff;
  zoneAt(g - o1);
  return g - zOff;
}
export function writeTm(p: usize): void {
  store<i32>(p, tSec); store<i32>(p, tMin, 4); store<i32>(p, tHour, 8); store<i32>(p, tMday, 12); store<i32>(p, tMon, 16);
  store<i32>(p, tYear, 20); store<i32>(p, tWday, 24); store<i32>(p, tYday, 28); store<i32>(p, tIsdst, 32); store<i32>(p, 0, 36);
  store<i64>(p, tGmtoff, 40);
}
export function writeTmZone(p: usize, zone: usize): void { writeTm(p); store<u64>(p, <u64>zone, 48); }
export { isLeap };
