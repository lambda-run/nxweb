// hle_sdk16.c (src/hle/sdk16.ts): language codes, nfc / nfp, shared fonts and the font engine entries, the vsync
// event, diag and the exit path (lifecycle.ts), and the service SystemEvent bindings (sysevent.ts).
// Ported scenarios: nxnative dm/host/tests/t_language.c, t_nfc.c, t_shared_font.c.
import assert from "node:assert/strict";
import { test, Hle, RES_FAIL } from "./harness.mts";

const CODES = ["ja", "en-US", "fr", "de", "it", "es", "zh-CN", "ko", "nl", "pt", "ru", "zh-TW", "en-GB", "fr-CA", "es-419", "zh-Hans", "zh-Hant", "pt-BR"];
test("settings (t_language): the language / code matrix, both Chinese spellings of a script matching, in both directions", () => {
  const h = new Hle(), lang = h.alloc(4), code = h.alloc(8);
  const EQ = "_ZN2nn8settingseqERKNS0_8LanguageERKNS0_12LanguageCodeE", EQ2 = "_ZN2nn8settingseqERKNS0_12LanguageCodeERKNS0_8LanguageE", MAKE = "_ZN2nn8settings12LanguageCode4MakeENS0_8LanguageE";
  const setCode = (s: string) => { h.u8.fill(0, code, code + 8); h.u8.set(Buffer.from(s, "latin1").subarray(0, 8), code); };
  for (let l = 0; l < 18; l++) for (let i = 0; i < 18; i++) {
    h.dv.setInt32(lang, l, true); setCode(CODES[i]);
    const want = l === i || (l === 6 && i === 15) || (l === 15 && i === 6) || (l === 11 && i === 16) || (l === 16 && i === 11) ? 1 : 0;
    assert.equal(h.w0(EQ, lang, code), want, `Language ${l} == ${CODES[i]}`); assert.equal(h.w0(EQ2, code, lang), want);
  }
  for (const bad of [-1, -2147483648, 18, 2147483647]) {
    h.dv.setInt32(lang, bad, true); setCode("zh-Hans");
    assert.equal(h.w0(EQ, lang, code), 0); assert.equal(h.w0(EQ2, code, lang), 0); assert.equal(h.call(MAKE, bad).x0, 0n, "an invalid Make is an empty code");
  }
  // a LanguageCode is exactly eight bytes: no alias prefix, nothing read past it
  for (const m of ["", "zh", "zh-hans", "zh-HansX", "zh-HantX", "zh-CNxyz", "zh-TWxyz"]) for (const l of [6, 11, 15, 16]) {
    h.dv.setInt32(lang, l, true); setCode(m);
    assert.equal(h.w0(EQ, lang, code), 0, `${m} is no alias of ${l}`); assert.equal(h.w0(EQ2, code, lang), 0);
  }
  const avail = h.alloc(19 * 8, 0xA5);
  assert.equal(h.w0("_ZN2nn8settings29GetAvailableLanguageCodeCountEv"), 18);
  assert.equal(h.w0("_ZN2nn8settings25GetAvailableLanguageCodesEPNS0_12LanguageCodeEi", avail, 19), 18);
  for (let i = 0; i < 18; i++) {
    const want = Buffer.alloc(8); want.write(CODES[i], "latin1");
    const made = Buffer.alloc(8); made.writeBigUInt64LE(h.call(MAKE, i).x0);
    assert.deepEqual(made, want, "Make preserves each exact spelling"); assert.deepEqual(h.read(avail + 8 * i, 8), want, "the list preserves order and spelling");
  }
  assert.ok(h.read(avail + 18 * 8, 8).every(b => b === 0xA5), "the unused entry is left alone");
  h.u8.fill(0xA5, avail, avail + 19 * 8); assert.equal(h.w0("_ZN2nn8settings25GetAvailableLanguageCodesEPNS0_12LanguageCodeEi", avail, 2), 2); assert.equal(h.u8[avail + 16], 0xA5);
});

test("nfc / nfp (t_nfc): library states, one device that never finds a tag, output bounds", () => {
  const h = new Hle();
  const nfcState = () => h.w0("_ZN2nn3nfc8GetStateEv"), enabled = () => h.w0("_ZN2nn3nfc12IsNfcEnabledEv"), lib = () => h.w0("_ZN2nn3nfp8GetStateEv");
  const dev = h.alloc(24, 0xA5), handle = dev + 8, count = h.alloc(4);
  const devState = () => h.w0("_ZN2nn3nfp14GetDeviceStateERKNS0_12DeviceHandleE", handle);
  assert.equal(lib(), 0, "NFP begins uninitialized");
  h.call("_ZN2nn3nfp37InitializeWithExtendedApplicationAreaEv"); assert.equal(lib(), 1);
  h.call("_ZN2nn3nfp8FinalizeEv"); assert.equal(lib(), 0);
  assert.equal(nfcState(), 0); assert.equal(enabled(), 0);
  h.call("_ZN2nn3nfp10InitializeEv"); assert.equal(lib(), 1);
  h.dv.setInt32(count, -1, true);
  assert.equal(h.call("_ZN2nn3nfp11ListDevicesEPNS0_12DeviceHandleEPii", handle, count, 1).x0, 0n); assert.equal(h.i32(count), 1);
  assert.deepEqual(h.read(dev, 24), Buffer.concat([Buffer.alloc(8, 0xA5), Buffer.from("0PFN\0\0\0\0"), Buffer.alloc(8, 0xA5)]), "DeviceHandle { u32 'NFP0', 4 reserved zero bytes }, bounds respected");
  h.call("_ZN2nn3nfp11ListDevicesEPNS0_12DeviceHandleEPii", handle, count, 0); assert.equal(h.i32(count), 0);
  assert.equal(h.call("_ZN2nn3nfp14StartDetectionERKNS0_12DeviceHandleE", handle).x0, 0n); assert.equal(devState(), 1, "searching");
  for (let pass = 0; pass < 3; pass++) {
    assert.equal(nfcState(), 0); h.call("_ZN2nn3nfc10InitializeEv");
    assert.equal(nfcState(), 1); assert.equal(enabled(), 0, "initialization cannot fabricate a reader"); assert.equal(devState(), 1);
    const out = h.alloc(0x80, 0x5A);
    assert.equal(h.call("_ZN2nn3nfp10GetTagInfoEPNS0_7TagInfoERKNS0_12DeviceHandleE", out + 16, handle).x0, BigInt(115 | 97 << 9), "tag not found");
    assert.ok(h.read(out, 0x80).every(b => b === 0x5A), "no tag data fabricated");
    h.call("_ZN2nn3nfc8FinalizeEv"); assert.equal(nfcState(), 0); assert.equal(devState(), 1);
  }
  assert.equal(h.call("_ZN2nn3nfp13StopDetectionERKNS0_12DeviceHandleE", handle).x0, 0n); assert.equal(devState(), 0);
  h.call("_ZN2nn3nfp8FinalizeEv"); assert.equal(lib(), 0); h.call("_ZN2nn3nfp10InitializeEv"); assert.equal(lib(), 1);
  assert.equal(h.guestCalls.length, 0, "no SDK service path is called");
  h.npad = 0x20; const id = h.alloc(8, 0xEE);
  assert.equal(h.call("_ZN2nn3nfp9GetNpadIdEPjRKNS0_12DeviceHandleE", id, handle).x0, 0n); assert.deepEqual([h.u32(id), h.u32(id + 4)], [0x20, 0xEEEEEEEE], "the controller connected now");
  const n = h.alloc(8, 0xEE); assert.equal(h.call("_ZN2nn3nfp18GetApplicationAreaEPvPmRKNS0_12DeviceHandleEm", 0, n, handle, 16).x0, BigInt(115 | 97 << 9)); assert.equal(h.u64(n), 0n);
  const ch = h.alloc(2, 0xEE); h.call("_ZN2nn3nfp29StartNicknameAndOwnerSettingsEPNS0_12DeviceHandleEPbPNS0_12RegisterInfoERKNS0_24AmiiboSettingsStartParamERKNS0_7TagInfoE", handle, ch, 0, 0, 0); assert.deepEqual([...h.read(ch, 2)], [0, 0xEE]);
});

const LOADFONT = "_ZN2nn6fontll18ScalableFontEngine8LoadFontEPcPKvjj";
test("fonts (t_shared_font): LoadFont forwards to the SDK; only the host's exact BFTTF bases skip the header", () => {
  const h = new Hle();
  assert.equal(h.call(LOADFONT, 0, 0, 0, 0, 0).x0, 403n); assert.equal(h.red.length, 1, "no SDK implementation: fails loudly (nxnative stops)");
  const g = new Hle();
  let seen: bigint[] = [], status = 403n, lookups = 0;
  g.fn((...a) => { seen = a; return status; }, LOADFONT);
  const std = g.alloc(64), ext = g.alloc(64), other = g.alloc(64);
  // before any font is set: all data passes unchanged
  for (const d of [0, other, std, ext]) { assert.equal(g.call(LOADFONT, 0x51, 0x4E, d, 17, 50).x0, 403n); assert.deepEqual(seen, [0x51n, 0x4En, BigInt(d), 17n, 50n]); }
  g.host.fontSet("standard", std, 64); g.host.fontSet("extension", ext, 64);
  assert.equal(g.u32(std), 0x18029a7f, "the 'decoded' marker"); assert.equal(g.dv.getUint32(std + 4, false), (56 ^ 0x49621806) >>> 0, "the obfuscated length: bswap(length ^ key)");
  const input = [std, ext, std + 8, ext + 8, std + 1, ext + 9, other, 0], expect = [std + 8, ext + 8, std + 8, ext + 8, std + 1, ext + 9, other, 0];
  for (const st of [0n, 403n, 301n, 0x80000001n, 0xFFFFFFFFn]) for (let i = 0; i < input.length; i++) {
    status = st;
    assert.equal(g.call(LOADFONT, 0x51, 0x4E, input[i], 0xFFFFFFFF, 50).x0, st, "the SDK's status is returned");
    assert.deepEqual(seen, [0x51n, 0x4En, BigInt(expect[i]), 0xFFFFFFFFn, 50n], "only exact host bases skip the header, once; the other arguments pass");
  }
  g.call(LOADFONT, 1, 2, std, 0, 0); assert.deepEqual(seen.slice(3), [0n, 0n], "zero unsigned arguments preserved");
  // the unsigned arguments are 32 bits: upper register bits do not reach the SDK
  g.call(LOADFONT, 1, 2, std, 0x1_0000_0007n, 0xFFFF_FFFF_0000_0009n); assert.deepEqual(seen.slice(3), [7n, 9n]);
  lookups = g.guestCalls.length; assert.ok(lookups > 0);
});

test("fonts: pl shared font queries; SharedFontData and BuiltInFontData layouts; the header rule", () => {
  const none = new Hle();
  assert.equal(none.w0("_ZN2nn2pl22GetSharedFontLoadStateENS0_14SharedFontTypeE", 0), 0); assert.equal(none.call("_ZN2nn2pl20GetSharedFontAddressENS0_14SharedFontTypeE", 0).x0, 0n);
  assert.equal(none.call("_ZN2nn2pl17GetSharedFontSizeENS0_14SharedFontTypeE", 5).x0, 0n);
  assert.equal(none.red.length, 1, "no standard font: one red line");
  const cnt = none.alloc(4, 0xEE); assert.equal(none.w0("_ZN2nn2pl13GetSharedFontEPiPNS0_14SharedFontDataEiNS_8settings12LanguageCodeE", cnt, 0, 6, 0), 0); assert.equal(none.i32(cnt), 0);
  const mk = (cfg: Parameters<Hle["host"]["config"]>[0], withExt = true) => {
    const h = new Hle(); h.host.config(cfg);
    const std = h.alloc(0x108), ext = h.alloc(0x48);
    h.host.fontSet("standard", std, 0x108); if (withExt) h.host.fontSet("extension", ext, 0x48);
    return { h, std, ext };
  };
  const ADDR = "_ZN2nn2pl20GetSharedFontAddressENS0_14SharedFontTypeE", SIZE = "_ZN2nn2pl17GetSharedFontSizeENS0_14SharedFontTypeE";
  // SDK 11 or later whose main imports Decode: the address is the BFTTF header; otherwise the TTF itself
  let t = mk({ sdkMajor: 20, fontDecodeImported: true });
  assert.equal(t.h.call(ADDR, 0).x0, BigInt(t.std)); assert.equal(t.h.call(SIZE, 0).x0, 0x108n);
  assert.equal(t.h.call(ADDR, 5).x0, BigInt(t.ext)); assert.equal(t.h.call(SIZE, 5).x0, 0x48n);
  assert.equal(t.h.call(ADDR, 3).x0, BigInt(t.std), "types 0-4 are one stand-in");
  assert.equal(t.h.w0("_ZN2nn2pl22GetSharedFontLoadStateENS0_14SharedFontTypeE", 5), 1);
  for (const cfg of [{ sdkMajor: 10, fontDecodeImported: true }, { sdkMajor: 13, fontDecodeImported: false }, { sdkMajor: 20, fontDecodeImported: true, sharedFontTtf: true }]) {
    t = mk(cfg); assert.equal(t.h.call(ADDR, 0).x0, BigInt(t.std + 8)); assert.equal(t.h.call(SIZE, 0).x0, 0x100n);
  }
  t = mk({ sdkMajor: 7, sharedFontTtf: false }); assert.equal(t.h.call(ADDR, 0).x0, BigInt(t.std), "the profile's shared_font overrides");
  t = mk({ sdkMajor: 20, fontDecodeImported: true }, false);
  assert.equal(t.h.call(ADDR, 5).x0, BigInt(t.std), "no extension font: the standard one (button icons draw as '?')");
  // GetSharedFont: SharedFontData { u32 type, u32 pad, address, size } (0x18 bytes), always the TTF itself, types 0-5
  t = mk({ sdkMajor: 20, fontDecodeImported: true });
  const count = t.h.alloc(4), out = t.h.alloc(7 * 24, 0xEE);
  assert.equal(t.h.w0("_ZN2nn2pl13GetSharedFontEPiPNS0_14SharedFontDataEiNS_8settings12LanguageCodeE", count, out, 6, 0), 1); assert.equal(t.h.i32(count), 6);
  const want = Buffer.alloc(7 * 24, 0xEE);
  for (let k = 0; k < 6; k++) { want.writeUInt32LE(k, 24 * k); want.writeUInt32LE(0, 24 * k + 4); want.writeBigUInt64LE(BigInt((k === 5 ? t.ext : t.std) + 8), 24 * k + 8); want.writeBigUInt64LE(k === 5 ? 0x40n : 0x100n, 24 * k + 16); }
  assert.deepEqual(t.h.read(out, 7 * 24), want);
  t.h.u8.fill(0xEE, out, out + 7 * 24);
  t.h.call("_ZN2nn2pl13GetSharedFontEPiPNS0_14SharedFontDataEiNS_8settings12LanguageCodeE", count, out, 2, 0); assert.equal(t.h.i32(count), 6, "the count is all six, whatever fits"); assert.equal(t.h.u8[out + 48], 0xEE);
  // BuiltInFontData { u8 type, u8 flag, pad[6], address, u64 size }
  const b = t.h.alloc(32, 0xEE);
  for (const n of ["_ZN2nn2pl18GetBuiltInFontDataEPNS0_17BuiltInFontDataNxENS0_17BuiltInFontTypeNxEb", "_ZN2nn2pl18GetBuiltInFontDataEPNS0_20BuiltInFontDataOunceENS0_20BuiltInFontTypeOunceEb"]) {
    t.h.u8.fill(0xEE, b, b + 32);
    assert.equal(t.h.w0(n, b, 5, 1), 1);
    const wb = Buffer.alloc(32, 0xEE); wb.fill(0, 0, 8); wb[0] = 5; wb.writeBigUInt64LE(BigInt(t.ext), 8); wb.writeBigUInt64LE(0x48n, 16);
    assert.deepEqual(t.h.read(b, 32), wb, n);
  }
  assert.equal(none.w0("_ZN2nn2pl18GetBuiltInFontDataEPNS0_17BuiltInFontDataNxENS0_17BuiltInFontTypeNxEb", cnt, 0, 0), 0);
  assert.equal(t.h.w0("_ZN2nn2pl16IsRunningOnOunceEv"), 0); assert.equal(t.h.w0("_ZN2nn2pl8IsVrModeEv"), 0); assert.equal(t.h.call("_ZN2nn2pl11BeginVrModeEv").x0, 0xd08en);
});

test("fonts: an engine with a small work buffer runs on host memory; the game still gets its own buffer back", () => {
  const h = new Hle();
  const INIT = "_ZN2nn6fontll18ScalableFontEngine10InitializeEPvj", GETW = "_ZN2nn6fontll18ScalableFontEngine22GetPointerToWorkBufferEv";
  const inits: bigint[][] = [];
  h.fn((...a) => { inits.push(a); }, INIT); h.fn(self => self + 0x999n, GETW);
  h.call(INIT, 0x7000, 0x8000, 0x80000);   // big enough: passed as it is
  assert.deepEqual(inits[0], [0x7000n, 0x8000n, 0x80000n]);
  assert.equal(h.call(GETW, 0x7000).x0, 0x7999n, "the SDK's answer");
  h.call(INIT, 0x7100, 0x8100, 0xC350);    // 50 KB: host memory of 0x80000 instead
  assert.equal(inits[1][0], 0x7100n); assert.notEqual(inits[1][1], 0x8100n); assert.equal(inits[1][2], 0x80000n);
  assert.equal(h.call(GETW, 0x7100).x0, 0x8100n, "the game's own buffer");
  h.call(INIT, 0x7100, 0x8200, 0x100);     // the same engine again: the same host memory
  assert.equal(inits[2][1], inits[1][1]); assert.equal(h.call(GETW, 0x7100).x0, 0x8200n);
  h.call(INIT, 0x7200, 0x8300, 0x1_0008_0000n); assert.deepEqual(inits[3], [0x7200n, 0x8300n, 0x80000n], "the size is an unsigned int: w2");
  assert.equal(h.red.length, 0);
});

test("oe / vi of hle_sdk16.c: display version, volume balance, active time, indirect image memory", () => {
  const h = new Hle();
  const v = h.alloc(24, 0xEE);
  h.call("_ZN2nn2oe17GetDisplayVersionEPNS0_14DisplayVersionE", v); assert.deepEqual(h.read(v, 24), Buffer.concat([Buffer.from("1.0.0"), Buffer.alloc(11), Buffer.alloc(8, 0xEE)]), "char[16]");
  h.host.config({ displayVersion: "1.2.3-a-very-long-version" }); h.call("_ZN2nn2oe17GetDisplayVersionEPNS0_14DisplayVersionE", v);
  assert.deepEqual(h.read(v, 17), Buffer.concat([Buffer.from("1.2.3-a-very-lo"), Buffer.from([0, 0xEE])]), "cut to 15 characters and a terminator");
  const f = h.alloc(12, 0xEE); h.call("_ZN2nn2oe24GetExpectedVolumeBalanceEPfS1_", f, f + 4);
  assert.deepEqual([h.dv.getFloat32(f, true), h.dv.getFloat32(f + 4, true), h.u32(f + 8)], [1, 1, 0xEEEEEEEE]);
  h.monoNs += 123_456n; assert.equal(h.call("_ZN2nn2oe25GetProgramTotalActiveTimeEv").x0, 123_456n, "ns since the take-overs were set up");
  const s = h.alloc(24, 0xEE);
  assert.equal(h.call("_ZN2nn2vi33GetIndirectImageMemoryRequirementEPmS1_ii", s, s + 8, 1280, 720).x0, 0n); assert.deepEqual([h.u64(s), h.u64(s + 8), h.u64(s + 16)], [0x384000n, 0x1000n, 0xEEEEEEEEEEEEEEEEn]);
  h.call("_ZN2nn2vi33GetIndirectImageMemoryRequirementEPmS1_ii", s, s + 8, 3, 3); assert.equal(h.u64(s), 0x1000n, "4 KB aligned");
  h.call("_ZN2nn2vi33GetIndirectImageMemoryRequirementEPmS1_ii", s, s + 8, -5, 3); assert.equal(h.u64(s), 0n);
  const b = h.alloc(4, 0xEE); assert.equal(h.call("_ZN2nn4diag13GetSymbolNameEPcmm", b, 4, 0x1234).x0, 0n); assert.deepEqual([...h.read(b, 2)], [0, 0xEE]);
  h.call("_ZN2nn4diag6detail7PutImplERKNS0_11LogMetaDataEPKcm", 0, h.str("hello game\n\n"), 13); assert.ok(h.logs.includes("[game] hello game"), "the game's log line without its trailing newlines");
  h.call("_ZN2nn4diag6detail7PutImplERKNS0_11LogMetaDataEPKcm", 0, h.str("\n"), 1); assert.equal(h.logs.filter(l => l.startsWith("[game]")).length, 1);
  assert.equal(h.w0("_ZN2nn4diag12GetBacktraceEPmi", 0, 8), 0);
});

test("vi: the vsync event is auto-clear, has one producer per binding lifetime, and its ticks end when the game destroys it", () => {
  const h = new Hle().sdk(), ev = h.alloc(64);
  const VS = "_ZN2nn2vi20GetDisplayVsyncEventEPNS_2os15SystemEventTypeEPNS0_7DisplayE";
  assert.equal(h.call(VS, ev, 0).x0, 0n);
  assert.deepEqual([h.created.length, h.created[0].autoclear, h.created[0].interProcess], [1, 1n, 1n], "bound auto-clear");
  assert.equal(h.vsyncs.length, 1);
  h.call(VS, ev, 0); assert.equal(h.vsyncs.length, 1, "repeated requests must not double its rate");
  const e = h.ev(h.created[0].w);
  assert.ok(h.host.vsyncTick(h.vsyncs[0])); assert.ok(e.signaled); assert.equal(e.signals, 1);
  // the game destroys the event: its write handle closes; the tick reports it and the binding is gone
  e.open = false;
  assert.ok(!h.host.vsyncTick(h.vsyncs[0])); assert.equal(h.x.hle_event_handle(ev), 0);
  // a new event at the same address is a new binding with its own producer
  h.call(VS, ev, 0); assert.equal(h.vsyncs.length, 2); assert.notEqual(h.vsyncs[1], h.vsyncs[0]);
  assert.ok(!h.host.vsyncTick(h.vsyncs[0]), "the old binding stays dead"); assert.ok(h.host.vsyncTick(h.vsyncs[1]));
});

test("events: bind once per address, signal binds on the spot, a closed handle unbinds, clear on an unbound one is nothing", () => {
  const h = new Hle().sdk(), a = h.alloc(64), b = h.alloc(64);
  h.x.hle_event_bind(a, 0); h.x.hle_event_bind(a, 1);
  assert.equal(h.created.length, 1, "bound once"); assert.equal(h.created[0].autoclear, 0n);
  h.x.hle_event_clear(b); assert.equal(h.created.length, 1, "an unbound event has nothing to clear");
  h.x.hle_event_signal(b); assert.equal(h.created.length, 2); assert.deepEqual([h.created[1].ev, h.created[1].autoclear], [BigInt(b), 0n], "manual-clear when bound by a signal");
  assert.ok(h.ev(h.created[1].w).signaled);
  h.x.hle_event_clear(b); assert.ok(!h.ev(h.created[1].w).signaled);
  h.host.handleClosed(h.created[0].w); assert.equal(h.x.hle_event_handle(a), 0, "CloseHandle unbinds");
  h.x.hle_event_signal(a); assert.equal(h.created.length, 3, "bound again"); assert.ok(h.ev(h.created[2].w).signaled);
  // the embedder did not report the close: the signal finds the handle dead and binds again
  h.ev(h.created[2].w).open = false;
  h.x.hle_event_signal(a); assert.equal(h.created.length, 4); assert.ok(h.ev(h.created[3].w).signaled);
  assert.equal(h.red.length, 0);
  const g = new Hle(); g.fn(() => 0xE601, "_ZN2nn2os17CreateSystemEventEPNS0_15SystemEventTypeENS0_14EventClearModeEb"); g.fn(() => 0, "_ZN2nn2os30GetWritableHandleOfSystemEventEPKNS0_15SystemEventTypeE");
  g.x.hle_event_bind(a, 0); assert.equal(g.red.length, 1, "CreateSystemEvent failing is red (nxnative stops)"); assert.equal(g.x.hle_event_count(), 0);
});

test("lifecycle: one exit path, the first reason wins: an abort, ExecuteProgram, a host shutdown", () => {
  let h = new Hle();
  const r = h.callRegs("_ZN2nn4diag6detail9AbortImplEPKNS_6ResultE", { x: [(() => { const p = h.alloc(4); h.dv.setUint32(p, 0x1234, true); return p; })()], lr: 0x0800_1234 });
  assert.ok(r.noReturn, "an abort never returns to its caller");
  assert.deepEqual(h.exits.map(e => [e.reason, e.value]), [["abort", 0x1234n]]);
  assert.ok(h.red.some(l => l.includes("Result 0x1234") && l.includes("call site 0x8001234")));
  assert.deepEqual(h.host.exit, { state: "Exiting", reason: "abort" });
  assert.ok(!h.host.shutdown(), "a shutdown while exiting changes nothing"); assert.equal(h.exits.length, 1);
  h.call("_ZN2nn4diag6detail9AbortImplEv"); assert.equal(h.exits.length, 1);
  h.host.exitDone(); assert.deepEqual(h.host.exit, { state: "Exited", reason: "abort" });
  h.host.exitDone(); assert.ok(!h.host.shutdown()); assert.equal(h.red.filter(l => l.includes("kit:")).length, 0, "nothing is refused: the guards ask first");
  h = new Hle();
  const param = h.bytes([1, 2, 3, 4, 5]);
  assert.ok(h.call("_ZN2nn2oe14ExecuteProgramEiPKvm", 2, param, 5).noReturn);
  assert.deepEqual(h.exits.map(e => [e.reason, e.value, [...e.bytes]]), [["executeProgram", 2n, [1, 2, 3, 4, 5]]], "the program index and the parameter bytes go to the embedder");
  assert.ok(h.red.some(l => l.includes("oe::ExecuteProgram(2, 5 bytes of parameters: 01 02 03 04 05): the host has only this program; it ends")));
  const p2 = new Hle(); p2.host.config({ hasPrograms: true }); p2.call("_ZN2nn2oe14ExecuteProgramEiPKvm", 1, 0, 0); assert.equal(p2.red.length, 0);
  h = new Hle();
  assert.ok(h.host.shutdown()); assert.deepEqual(h.exits.map(e => e.reason), ["hostShutdown"]); assert.ok(!h.host.shutdown());
  h.host.exitDone(); assert.deepEqual(h.host.exit, { state: "Exited", reason: "hostShutdown" });
  // VAbortImpl: the message's format and the Result
  h = new Hle(); const res = h.alloc(4); h.dv.setUint32(res, 0xE15, true);
  assert.ok(h.call("_ZN2nn4diag6detail10VAbortImplEPKcS3_S3_iPKNS_6ResultEPKNS_2os17UserExceptionInfoES3_RSt9__va_list", h.str("nnMain"), h.str("x != 0"), h.str("main.cpp"), 42, res, 0, h.str("bad %s"), 0).noReturn);
  assert.ok(h.logs.includes("[diag] abort at nnMain: x != 0 (main.cpp:42) message format bad %s")); assert.equal(h.exits[0].value, 0xE15n);
});

test("time of hle_sdk16.c: the network clock task finishes at once with failure", () => {
  const h = new Hle().sdk();
  assert.equal(h.call("_ZN2nn4time39AsyncEnsureNetworkClockAvailabilityTask10InitializeENS_2os14EventClearModeE", 0, 0).x0, 0n);
  const ev = h.call("_ZN2nn4time39AsyncEnsureNetworkClockAvailabilityTask14GetFinishEventEv", 0).x0;
  assert.ok(h.ev(h.x.hle_event_handle(Number(ev))).signaled, "already signalled");
  assert.equal(h.call("_ZN2nn4time39AsyncEnsureNetworkClockAvailabilityTask9StartTaskEv", 0).x0, 0n);
  assert.equal(h.call("_ZN2nn4time39AsyncEnsureNetworkClockAvailabilityTask9GetResultEv", 0).x0, RES_FAIL);
  assert.equal(h.created.length, 1);
});
