// The C library pass-through names (src/hle/libc.ts, nxnative hle_table.c) and the bodies compiled from nxnative's C
// text (src/hle/ops.ts), each of those checked against an independent reading of the C source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, Hle, status, NXNATIVE } from "./harness.mts";

const f32 = (r: { d0?: bigint }) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(r.d0!); return b.readFloatLE(0); };
const f64 = (r: { d0?: bigint }) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(r.d0!); return b.readDoubleLE(0); };
const dbits = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.readBigUInt64LE(); };
const i32 = (x: bigint) => Number(BigInt.asIntN(32, x)), i64 = (x: bigint) => BigInt.asIntN(64, x);

test("libc: memory and string functions", () => {
  const h = new Hle();
  const a = h.alloc(64, 0xEE), s = h.str("Hello, World"), s2 = h.str("hello, world"), e = h.str("");
  assert.equal(h.call("memcpy", a, s, 5).x0, BigInt(a)); assert.deepEqual(h.read(a, 6), Buffer.from("Hello\xEE", "latin1"));
  assert.equal(h.call("memset", a, 0x141, 3).x0, BigInt(a)); assert.deepEqual(h.read(a, 4), Buffer.from("AAAl"), "the fill value is a byte");
  h.call("memcpy", a, s, 13); h.call("memmove", a + 2, a, 5); assert.equal(h.cstr(a), "HeHelloWorld", "memmove with overlap");
  assert.equal(i32(h.call("memcmp", s, s2, 12).x0), 0x48 - 0x68); assert.equal(h.call("memcmp", s, s, 12).x0, 0n); assert.equal(h.call("memcmp", s, s2, 0).x0, 0n);
  assert.equal(h.call("memchr", s, 0x157, 12).x0, BigInt(s + 7), "'W'"); assert.equal(h.call("memchr", s, 0x57, 7).x0, 0n);
  assert.equal(h.call("strlen", s).x0, 12n); assert.equal(h.call("strnlen", s, 5).x0, 5n); assert.equal(h.call("strnlen", s, 50).x0, 12n);
  assert.ok(i32(h.call("strcmp", s, s2).x0) < 0); assert.equal(h.call("strcmp", s, s).x0, 0n); assert.ok(i32(h.call("strcmp", s, e).x0) > 0);
  assert.equal(h.call("strncmp", s, h.str("Help"), 3).x0, 0n); assert.ok(i32(h.call("strncmp", s, h.str("Help"), 4).x0) < 0);
  assert.equal(h.call("strcasecmp", s, s2).x0, 0n); assert.equal(h.call("strncasecmp", s, h.str("HELLO!"), 5).x0, 0n); assert.ok(i32(h.call("strncasecmp", s, h.str("HELLO!"), 6).x0) !== 0);
  h.u8.fill(0xEE, a, a + 64);
  assert.equal(h.call("strcpy", a, s).x0, BigInt(a)); assert.deepEqual(h.read(a, 14), Buffer.from("Hello, World\0\xEE", "latin1"));
  h.u8.fill(0xEE, a, a + 64); h.call("strncpy", a, h.str("ab"), 5); assert.deepEqual([...h.read(a, 6)], [97, 98, 0, 0, 0, 0xEE], "strncpy pads with zeros");
  h.u8.fill(0xEE, a, a + 64); h.call("strncpy", a, s, 3); assert.deepEqual([...h.read(a, 4)], [72, 101, 108, 0xEE], "and does not terminate a full copy");
  h.call("strcpy", a, h.str("ab")); h.call("strcat", a, h.str("cd")); h.call("strncat", a, h.str("efgh"), 2); assert.equal(h.cstr(a), "abcdef");
  assert.equal(h.call("strchr", s, 0x6F).x0, BigInt(s + 4)); assert.equal(h.call("strrchr", s, 0x6F).x0, BigInt(s + 8)); assert.equal(h.call("strchr", s, 0x7A).x0, 0n);
  assert.equal(h.call("strchr", s, 0).x0, BigInt(s + 12), "the terminator is found"); assert.equal(h.call("strrchr", s, 0x7A).x0, 0n);
  assert.equal(h.call("strstr", s, h.str("World")).x0, BigInt(s + 7)); assert.equal(h.call("strstr", s, h.str("world")).x0, 0n); assert.equal(h.call("strstr", s, e).x0, BigInt(s));
  assert.equal(h.call("strspn", s, h.str("leH")).x0, 4n); assert.equal(h.call("strcspn", s, h.str(", ")).x0, 5n); assert.equal(h.call("strcspn", s, h.str("z")).x0, 12n);
  assert.equal(h.call("strpbrk", s, h.str("W,")).x0, BigInt(s + 5)); assert.equal(h.call("strpbrk", s, h.str("z")).x0, 0n);
});

test("libc: integer and floating point parsing", () => {
  const h = new Hle(), end = h.alloc(8);
  const tol = (name: string, text: string, base: number) => { const p = h.str(text); const v = h.call(name, p, end, base).x0; return [i64(v), Number(h.u64(end)) - p] as [bigint, number]; };
  assert.deepEqual(tol("strtol", "  -123abc", 10), [-123n, 6]); assert.deepEqual(tol("strtol", "0x1F", 0), [31n, 4]); assert.deepEqual(tol("strtol", "0777", 0), [511n, 4]);
  assert.deepEqual(tol("strtol", "zz", 36), [1295n, 2]); assert.deepEqual(tol("strtol", "+", 10), [0n, 0], "no digits: nothing read"); assert.deepEqual(tol("strtol", "0x", 16), [0n, 1], "0x with no digit: the 0");
  assert.deepEqual(tol("strtoll", "99999999999999999999", 10), [0x7FFFFFFFFFFFFFFFn, 20], "clamped"); assert.deepEqual(tol("strtoll", "-99999999999999999999", 10), [-0x8000000000000000n, 21]);
  assert.deepEqual(tol("strtoll", "-9223372036854775808", 10), [-0x8000000000000000n, 20]);
  assert.equal(h.call("strtoull", h.str("18446744073709551615"), 0, 10).x0, 0xFFFFFFFFFFFFFFFFn); assert.equal(h.call("strtoul", h.str("18446744073709551616"), 0, 10).x0, 0xFFFFFFFFFFFFFFFFn);
  assert.equal(h.call("strtoul", h.str("-1"), 0, 10).x0, 0xFFFFFFFFFFFFFFFFn, "a negated unsigned value");
  assert.equal(i32(h.call("atoi", h.str(" 42x")).x0), 42); assert.equal(i32(h.call("atoi", h.str("-7")).x0), -7);
  const tod = (text: string) => { const p = h.str(text); const r = h.call("strtod", p, end); return [f64(r), Number(h.u64(end)) - p] as [number, number]; };
  assert.deepEqual(tod("3.25rest"), [3.25, 4]); assert.deepEqual(tod("  -1e3"), [-1000, 6]); assert.deepEqual(tod("1.5e-2"), [0.015, 6]); assert.deepEqual(tod(".5"), [0.5, 2]);
  assert.deepEqual(tod("12e"), [12, 2], "an exponent with no digits is not read"); assert.deepEqual(tod("x"), [0, 0]); assert.deepEqual(tod("inf"), [Infinity, 3]); assert.deepEqual(tod("-Infinity"), [-Infinity, 9]);
  assert.ok(Number.isNaN(tod("nan")[0])); assert.deepEqual(tod("1e400"), [Infinity, 5]); assert.deepEqual(tod("1e-400"), [0, 6]); assert.deepEqual(tod("0.1"), [0.1, 3]); assert.deepEqual(tod("123456789012345678"), [123456789012345680, 18]);
  assert.equal(f64(h.call("atof", h.str("2.5"))), 2.5); assert.equal(f32(h.call("strtof", h.str("0.5"), 0)), 0.5);
});

test("libc: math, float results in d0", () => {
  const h = new Hle();
  const F = (name: string, ...x: number[]) => f32(h.callRegs(name, { f: Object.fromEntries(x.map((v, i) => [i, v])) }));
  const Dd = (name: string, ...x: number[]) => f64(h.callRegs(name, { d: x.map(dbits) }));
  const near = (got: number, want: number, eps: number) => assert.ok(Math.abs(got - want) <= eps * Math.max(1, Math.abs(want)), `${got} ~ ${want}`);
  assert.equal(F("sqrtf", 9), 3); near(F("cbrtf", 27), 3, 1e-6); near(F("expf", 1), Math.E, 1e-6); near(F("logf", Math.E), 1, 1e-6); near(F("log10f", 1000), 3, 1e-6); near(F("log2f", 8), 3, 1e-6);
  near(F("sinf", 0.5), Math.sin(0.5), 1e-6); near(F("cosf", 0.5), Math.cos(0.5), 1e-6); near(F("tanf", 0.5), Math.tan(0.5), 1e-6);
  near(F("asinf", 0.5), Math.asin(0.5), 1e-6); near(F("acosf", 0.5), Math.acos(0.5), 1e-6); near(F("atanf", 0.5), Math.atan(0.5), 1e-6); near(F("atan2f", 1, -1), Math.atan2(1, -1), 1e-6);
  assert.equal(F("powf", 2, 10), 1024); assert.equal(F("exp2f", 5), 32); assert.equal(F("fmodf", 7.5, 2), 1.5); assert.equal(F("fmodf", -7.5, 2), -1.5);
  assert.equal(f32(h.callRegs("ldexpf", { f: { 0: 0.75 }, x: [4] })), 12);
  const ip = h.alloc(8, 0xEE);
  assert.equal(f32(h.callRegs("modff", { f: { 0: -3.75 }, x: [ip] })), -0.75); assert.equal(h.dv.getFloat32(ip, true), -3); assert.equal(h.u32(ip + 4), 0xEEEEEEEE);
  assert.equal(i64(h.callRegs("lroundf", { f: { 0: 2.5 } }).x0), 3n); assert.equal(i64(h.callRegs("lroundf", { f: { 0: -2.5 } }).x0), -3n); assert.equal(i64(h.callRegs("lroundf", { f: { 0: 2.4 } }).x0), 2n);
  near(Dd("sin", 1), Math.sin(1), 1e-15); near(Dd("cos", 1), Math.cos(1), 1e-15); near(Dd("log", 10), Math.log(10), 1e-15); near(Dd("log10", 1e5), 5, 1e-15); near(Dd("log2", 1024), 10, 1e-15);
  assert.equal(Dd("pow", 2, 0.5), Math.SQRT2); near(Dd("atan2", 1, 1), Math.PI / 4, 1e-15); assert.equal(Dd("exp2", 10), 1024);
  assert.equal(f64(h.callRegs("ldexp", { d: [dbits(0.75)], x: [-2] })), 0.1875);
  const ep = h.alloc(8, 0xEE);
  assert.equal(f64(h.callRegs("frexp", { d: [dbits(48)], x: [ep] })), 0.75); assert.deepEqual([h.i32(ep), h.u32(ep + 4)], [6, 0xEEEEEEEE]);
  assert.equal(f64(h.callRegs("frexp", { d: [dbits(0)], x: [ep] })), 0); assert.equal(h.i32(ep), 0);
  assert.equal(f64(h.callRegs("frexp", { d: [dbits(5e-324)], x: [ep] })), 0.5); assert.equal(h.i32(ep), -1073, "a subnormal");
  // a float result is the low 32 bits of d0, the rest zero
  assert.equal(h.callRegs("sqrtf", { f: { 0: 4 } }).d0, 0x40000000n);
});

test("libc: timegm, gmtime_r, localtime_r, mktime (the pass-through one), strftime", () => {
  const h = new Hle();
  h.zone = () => ({ offset: -18000, dst: false, name: "EST" });
  const tm = h.alloc(64, 0xEE), t = h.alloc(8), ints = () => Array.from({ length: 9 }, (_, i) => h.i32(tm + 4 * i));
  h.dv.setBigInt64(t, 951782400n, true);   // 2000-02-29 00:00:00 UTC, a Tuesday
  assert.equal(h.call("gmtime_r", t, tm).x0, BigInt(tm)); assert.deepEqual(ints(), [0, 0, 0, 29, 1, 100, 2, 59, 0]); assert.equal(h.i64(tm + 40), 0n); assert.equal(h.cstr(Number(h.u64(tm + 48))), "UTC");
  assert.equal(h.call("timegm", tm).x0, 951782400n);
  [0, 0, 0, 31, 12, 99].forEach((v, i) => h.dv.setInt32(tm + 4 * i, v, true));   // month 12 of 1999, day 31: carried into 2000-01-31
  assert.equal(h.call("timegm", tm).x0, 949276800n); assert.deepEqual(ints().slice(3, 8), [31, 0, 100, 1, 30], "timegm normalizes");
  h.dv.setBigInt64(t, -1n, true); h.call("gmtime_r", t, tm); assert.deepEqual(ints(), [59, 59, 23, 31, 11, 69, 3, 364, 0], "before 1970");
  const lt = h.id("localtime_r"); assert.ok(h.host.entries()[lt].forced, "the name resolves to the forced entry of hle_time.c");
  const weak = h.host.entries().find(e => e.name === "localtime_r" && !e.forced)!.id, weakMk = h.host.entries().find(e => e.name === "mktime" && !e.forced)!.id;
  h.dv.setBigInt64(t, 951782400n, true);
  assert.equal(h.call(weak, t, tm).x0, BigInt(tm)); assert.deepEqual(ints(), [0, 0, 19, 28, 1, 100, 1, 58, 0]); assert.equal(h.i64(tm + 40), -18000n); assert.equal(h.cstr(Number(h.u64(tm + 48))), "EST");
  assert.equal(h.call(weakMk, tm).x0, 951782400n);
  const out = h.alloc(128, 0xEE), fmt = (f: string, cap = 128) => { h.u8.fill(0xEE, out, out + 128); const n = h.call("strftime", out, cap, h.str(f), tm).x0; return [Number(n), h.cstr(out, 128)] as [number, string]; };
  assert.deepEqual(fmt("%Y-%m-%d %H:%M:%S"), [19, "2000-02-28 19:00:00"]);
  assert.deepEqual(fmt("%a %A %b %B %e %j %p %I %y %C %u %w %Z %z %%"), [58, "Mon Monday Feb February 28 059 PM 07 00 20 1 1 EST -0500 %"]);
  assert.deepEqual(fmt("%F|%T|%R|%D|%c"), [59, "2000-02-28|19:00:00|19:00|02/28/00|Mon Feb 28 19:00:00 2000"]);
  assert.deepEqual(fmt("%s"), [9, "951782400"]);
  assert.equal(fmt("%Y-%m-%d", 10)[0], 0, "does not fit: 0"); assert.deepEqual(fmt("%Y-%m-%d", 11), [10, "2000-02-28"]); assert.equal(h.u8[out + 11], 0xEE);
  assert.deepEqual(fmt("%Q"), [2, "%Q"]); assert.equal(h.red.length, 1, "an unknown conversion is copied, red once");
});

// ---------- the compiled bodies ----------
// An independent, deliberately simple reading of nxnative's C: for a take-over whose body ends in `return <constant>;`
// and writes nothing through its arguments, that constant must be what the compiled body returns for zero arguments.
test("ops: every body compiled from the C text returns the constant its C source ends with", () => {
  const h = new Hle();
  const CONST: Record<string, bigint> = { RES_OK: 0n, RES_FAIL: 0x2A2n, NULL: 0n, NV_ERR: 3n, SK_EAI_FAIL: 4n, IRS_UNCONNECTED: 2n, MII_RES_NOT_FOUND: 0x87En, MII_RES_CANCELED: 0xE7En,
    MII_RES_TEST_MODE: 0x1987En, "sk_fail()": 0xFFFFFFFFn, RES_PALMA_INVALID_HANDLE: BigInt(202 | 3302 << 9), false: 0n, true: 1n };
  const files = new Map<string, string>();
  const src = (f: string) => { if (!files.has(f)) files.set(f, readFileSync(f.includes("/") ? join(NXNATIVE, "dm", f) : join(NXNATIVE, "dm", "host", f), "utf8")); return files.get(f)!; };
  let checked = 0, voids = 0;
  const rows = status().filter(r => r.status === "implemented (from the C body)");
  assert.ok(rows.length >= 590, `${rows.length} compiled bodies`);
  for (const r of rows) {
    const text = src(r.file), at = text.indexOf(`"${r.mangled}"`);
    assert.ok(at >= 0, r.mangled);
    // hle_hid.c's PALMA_FAIL(sym, what, fn, ...) has no body of its own: the macro's is `return RES_PALMA_INVALID_HANDLE;`
    if (text.slice(text.lastIndexOf("\n", at) + 1, at) === "PALMA_FAIL(") { assert.equal(h.callRegs(r.mangled, {}).x0, CONST.RES_PALMA_INVALID_HANDLE, r.cname); checked++; continue; }
    const open = text.indexOf("{", text.indexOf(r.cname, at));
    let close = open, depth = 0;
    for (; close < text.length; close++) { if (text[close] === "{") depth++; else if (text[close] === "}" && --depth === 0) break; }
    const line = text.slice(at, close + 1).replace(/\/\/.*$/gm, "");
    const isVoid = new RegExp(`,\\s*void,\\s*${r.cname}\\b`).test(line) || /^[^{]*\b(IKB_IGNORE|IKB_IGNORE_CB)\b/.test(text.slice(text.lastIndexOf("\n", at) + 1, at));
    const m = /return\s+([^;]+);\s*}\s*$/.exec(line.trim());
    const got = h.callRegs(r.mangled, {}).x0;
    if (isVoid || !m) { voids++; continue; }
    let want: bigint | undefined = CONST[m[1].trim()];
    if (want === undefined && /^-?(0x[0-9a-f]+|\d+)u?$/i.test(m[1].trim())) want = BigInt.asUintN(/\blong\b|size_t|uint64_t|\*/.test(line.split(r.cname)[0].split(",").at(-2) ?? "") ? 64 : 32, BigInt(m[1].trim().replace(/u$/i, "")));
    if (want === undefined && /^nfp_no_tag\(/.test(m[1])) want = BigInt(115 | 97 << 9);
    if (want === undefined && /^"/.test(m[1])) { assert.equal(h.cstr(Number(got)), JSON.parse(m[1].trim()), r.mangled); checked++; continue; }
    if (want === undefined) continue;
    if ((m[1].trim() === "-1" || m[1].trim() === "sk_fail()") && /\blong\b/.test(line.slice(0, line.indexOf(r.cname)))) want = 0xFFFFFFFFFFFFFFFFn;   // an int -1 returned as long
    assert.equal(got, want, `${r.file} ${r.cname}: ${m[1]}`);
    checked++;
  }
  if (process.env.HLE_TEST_LOG) console.log(`    | ops: ${checked} constants compared, ${voids} bodies with nothing to return`);
  assert.ok(checked >= 390 && checked + voids === rows.length, `${checked} constants compared, ${voids} bodies with nothing to return`);
});

test("ops: stores through pointer arguments have the C type's width and honour the null check", () => {
  const h = new Hle().sdk();
  const p = h.alloc(16, 0xEE);
  const reset = () => h.u8.fill(0xEE, p, p + 16);
  h.call("_ZN2nn7account12GetUserCountEPi", p); assert.deepEqual([h.u32(p), h.u32(p + 4)], [1, 0xEEEEEEEE], "int *: 4 bytes");
  reset(); h.call("_ZN2nn7account12AsyncContext7HasDoneEPb", 0, p); assert.deepEqual([...h.read(p, 2)], [1, 0xEE], "uint8_t *: 1 byte, the second argument");
  reset(); h.call("_ZN2nn2ec19ShopServiceAccessor13AsyncResponse7GetSizeEPm", 0, p); assert.deepEqual([h.u64(p), h.u64(p + 8)], [0n, 0xEEEEEEEEEEEEEEEEn], "size_t *: 8 bytes");
  reset(); h.call("_ZN2nn6socket11GetAddrInfoEPKcS2_PKNS0_8AddrInfoEPPS3_", 0, 0, 0, p); assert.equal(h.u64(p), 0n, "void **: 8 bytes, the fourth argument");
  reset(); h.call("_ZN2nn4time6detail56GetStandardUserSystemClockAutomaticCorrectionUpdatedTimeEPNS0_20SteadyClockTimePointE", p - 8); assert.equal(h.u64(p + 8), 0n, "memset of 0x18");
  h.call("_ZN2nn3ldn4ScanEPNS0_11NetworkInfoEPiiRKNS0_10ScanFilterEi", 0, 0, 0, 0, 0);   // `if (n) *n = 0`: a null pointer is skipped
  h.u8.fill(0xEE, 0, 8); h.call("_ZN2nn7account12GetUserCountEPi", 0); assert.equal(h.u32(0), 1, "an unconditional store goes where the pointer says, as in C");
  h.u8.fill(0, 0, 8);
  // event bodies: bind (not signalled) and signal
  const ev = h.alloc(64);
  h.call("_ZN2nn3ldn22AttachStateChangeEventEPNS_2os15SystemEventTypeE", ev); assert.deepEqual([h.created.length, h.created[0].autoclear], [1, 0n]); assert.ok(!h.ev(h.created[0].w).signaled);
  h.call("_ZN2nn2oe38GetDefaultDisplayResolutionChangeEventEPNS_2os11SystemEventE", ev); assert.equal(h.created.length, 1, "the same address is one binding");
  h.call("_ZN2nn3nfp19AttachActivateEventEPNS_2os15SystemEventTypeERKNS0_12DeviceHandleE", ev + 32, 0); assert.equal(h.created.length, 2);
  // a red body logs once
  h.call("_ZNK2nn3mii8Database6ExportEPvm", 0, 0, 0); h.call("_ZNK2nn3mii8Database6ExportEPvm", 0, 0, 0); assert.deepEqual(h.red, ["[RED] mii: Database::Export refused"]);
});
