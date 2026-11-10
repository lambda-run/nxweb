// nn::vi (src/hle/vi.ts, port of nxnative dm/gfx/hle_vi.c; with dm/host/tests/t_vi_history.c ported), nn::ro and
// nn::jit (ro.ts, jit.ts; ports of hle_ro.c and hle_jit.c) against a fake loader and a fake plugin (the nn::ro half of
// dm/host/tests/t_nro.c: load order, lookups, lifecycle, refusal; its relocation half tests loader.c), and the cut
// movie and video codec names (movie.ts, codec_video.ts).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, Hle, status, RES_FAIL } from "./harness.mts";

const vi = (n: string) => `_ZN2nn2vi${n}`;
const RO_FAIL = 22 | 1 << 9, RO_NOT_NRO = 0x816;

test("vi: display, layer and native window are the module's static objects; a named display; a sized layer reaches the present", () => {
  const h = new Hle(), out = h.alloc(16, 0xEE);
  assert.equal(h.w0(vi("10InitializeEv")), 0);
  assert.equal(h.w0(vi("18OpenDefaultDisplayEPPNS0_7DisplayE"), out), 0);
  const disp = Number(h.u64(out)); assert.equal(h.u32(disp), 0x50534944, "'DISP'"); assert.equal(h.u8[out + 8], 0xEE, "one pointer written");
  h.u8.fill(0xEE, out, out + 8);
  assert.equal(h.w0(vi("11OpenDisplayEPPNS0_7DisplayEPKc"), out, h.str("Default")), 0); assert.equal(Number(h.u64(out)), disp, "the named Default display is the default display's object");
  h.u8.fill(0xEE, out, out + 8);
  assert.equal(BigInt(h.w0(vi("11OpenDisplayEPPNS0_7DisplayEPKc"), out, h.str("Internal"))), RES_FAIL); assert.equal(BigInt(h.w0(vi("11OpenDisplayEPPNS0_7DisplayEPKc"), out, 0)), RES_FAIL);
  assert.equal(h.u8[out], 0xEE, "another name: failure, nothing written");
  assert.equal(h.w0(vi("11CreateLayerEPPNS0_5LayerEPNS0_7DisplayE"), out, disp), 0);
  const layer = Number(h.u64(out)); assert.equal(h.u32(layer), 0x5259414c, "'LAYR'");
  assert.equal(h.host.viLayer, null); assert.deepEqual(h.vi.layers, []);
  assert.equal(h.w0(vi("15GetNativeWindowEPPvPNS0_5LayerE"), out, layer), 0);
  const win = Number(h.u64(out)); assert.deepEqual([h.u32(win), h.u64(win + 8)], [0x4e49574e, 0n], "'NWIN', no front end layer behind it"); assert.equal(win, h.x.hle_vi_native_window());
  // the overload with the layer's size, and SDK 22's with creation settings { w, h, 2 }
  assert.equal(h.w0(vi("11CreateLayerEPPNS0_5LayerEPNS0_7DisplayEii"), out, disp, 1920, 0x1_0000_0438n), 0);
  assert.equal(Number(h.u64(out)), layer); assert.deepEqual(h.vi.layers, [[1920, 1080]]); assert.deepEqual(h.host.viLayer, { w: 1920, h: 1080 }); assert.ok(h.logs.includes("vi::CreateLayer 1920x1080"));
  for (const [w, hh] of [[0, 720], [1280, -1 >>> 0], [0x10000, 720]]) h.call(vi("11CreateLayerEPPNS0_5LayerEPNS0_7DisplayEii"), out, disp, w, hh);
  assert.equal(h.vi.layers.length, 1, "a size that is no size creates the layer and tells nobody");
  assert.equal(h.w0(vi("11CreateLayerEPPNS0_5LayerEPNS0_7DisplayEPKNS0_21LayerCreationSettingsE"), out, disp, h.u32s([1280, 720, 2])), 0);
  assert.deepEqual(h.vi.layers.at(-1), [1280, 720]);
  assert.equal(h.w0(vi("11CreateLayerEPPNS0_5LayerEPNS0_7DisplayEPKNS0_21LayerCreationSettingsE"), out, disp, 0), 0); assert.equal(h.vi.layers.length, 2);
  // the crop: kept for the present, told when it changes
  const crop = (...v: number[]) => h.w0(vi("12SetLayerCropEPNS0_5LayerEiiii"), layer, ...v);
  assert.equal(crop(0, 0, 1280, 720), 0); assert.equal(crop(0, 0, 1280, 720), 0);
  assert.deepEqual(h.vi.crops, [[0, 0, 1280, 720]]); assert.deepEqual(h.host.viCrop, { x: 0, y: 0, w: 1280, h: 720 });
  assert.equal(h.logs.filter(l => l === "vi::SetLayerCrop 0,0 1280x720").length, 1, "logged only when it changes");
  crop(16, 8, 640, 360); assert.deepEqual(h.host.viCrop, { x: 16, y: 8, w: 640, h: 360 });
  crop(-1 >>> 0, 0, 640, 360); assert.equal(h.host.viCrop, null, "a crop that is none clears it"); assert.deepEqual(h.vi.crops.at(-1), [0, 0, 0, 0]);
  crop(0, 0, 0x10000, 1); assert.equal(h.vi.crops.length, 3);
  // the rest: constants compiled from the C text
  for (const n of ["19SetLayerScalingModeEPNS0_5LayerENS0_11ScalingModeE", "12DestroyLayerEPNS0_5LayerE", "12CloseDisplayEPNS0_7DisplayE", "8FinalizeEv", "23SetDisplayVrrCapabilityEPNS0_7DisplayEb",
    "30ClearLayerExtendedSwapIntervalEPNS0_5LayerE", "35SetLayerNextHdrContentGamutMetadataEPNS0_5LayerENS0_15HdrContentGamutE", "39SetLayerNextHdrAdjustableBezierMetadataEPNS0_5LayerEfff"]) assert.equal(h.w0(vi(n), layer, 1), 0, n);
  const q = h.alloc(0x40, 0xEE);
  assert.equal(h.w0(vi("21QueryDisplayHdrStatusEPbPNS0_15HdrOutputFormatEPtPKNS0_7DisplayE"), q, q + 4, q + 8, disp), 0);
  assert.deepEqual([...h.read(q, 12)], [0, 0xEE, 0xEE, 0xEE, 0, 0, 0, 0, 0, 0, 0xEE, 0xEE], "HDR off (a bool), format 0 (4 bytes), peak 0 (2 bytes)");
  assert.equal(h.w0(vi("25QueryDisplayHdrPaperWhiteEPtPKNS0_7DisplayE"), q + 16, disp), 0); assert.deepEqual([...h.read(q + 16, 3)], [203, 0, 0xEE], "paper white 203 nits");
  assert.equal(h.w0(vi("24QueryDisplayVrrSupportedEPbPKNS0_7DisplayE"), q + 20, disp), 0); assert.deepEqual([...h.read(q + 20, 2)], [0, 0xEE]);
  h.u8.fill(0xEE, q, q + 0x40); assert.equal(h.w0(vi("32GetDefaultDisplayPanelIdentifierEPNS0_15PanelIdentifierE"), q), 0); assert.ok(h.read(q, 0x18).every(b => b === 0) && h.u8[q + 0x18] === 0xEE, "no panel: 0x18 zero bytes");
  h.call(vi("28SetLayerExtendedSwapIntervalEPNS0_5LayerEii"), layer, 1, 2); h.call(vi("28SetLayerExtendedSwapIntervalEPNS0_5LayerEii"), layer, 3, 4);
  assert.deepEqual(h.logs.filter(l => l.startsWith("vi::SetLayerExtendedSwapInterval")), ["vi::SetLayerExtendedSwapInterval 1 2: no VRR on the host, the NVN swap interval stays"]);
  assert.deepEqual(h.red, []);
});

test("vi: ListDisplays' DisplayInfo and the largest display buffer by mode and display", () => {
  const h = new Hle(), p = h.alloc(0x60 * 2 + 32, 0xEE) + 16, LIST = vi("12ListDisplaysEPNS0_11DisplayInfoEi");
  assert.equal(h.w0(LIST, p, 10), 1);
  const exp = Buffer.alloc(0x60); exp.write("Default"); exp[0x40] = 1; exp.writeBigUInt64LE(1n, 0x48); exp.writeBigUInt64LE(1920n, 0x50); exp.writeBigUInt64LE(1080n, 0x58);
  assert.deepEqual(h.read(p, 0x60), exp, "one display, Default, one layer of at most 1920x1080");
  assert.ok(h.read(p - 16, 16).every(b => b === 0xEE) && h.read(p + 0x60, 16).every(b => b === 0xEE));
  assert.equal(h.w0(LIST, p, 0), 0); assert.equal(h.w0(LIST, 0, 4), 0);
  const MAX = vi("31QueryDisplayBufferMaxResolutionEPNS0_19BufferMaxResolutionEPKNS0_7DisplayE");
  const res = (cfg: Parameters<Hle["host"]["config"]>[0]) => { const g = new Hle(); g.host.config(cfg); const o = g.alloc(8, 0xEE); assert.equal(g.w0(MAX, o, 0), 0); assert.equal(g.w0(MAX, 0, 0), 0); assert.equal(g.u32(o + 4), 0xEEEEEEEE); return [g.u32(o), g.logs.find(l => l.startsWith("vi::Query"))]; };
  assert.deepEqual(res({ opmode: 0, display: { w: 3840, h: 2160 } }), [1, "vi::QueryDisplayBufferMaxResolution: 1920x1080 (handheld, display 0x0)"], "handheld: the Switch 2's own screen");
  assert.deepEqual(res({ opmode: 1 }), [1, "vi::QueryDisplayBufferMaxResolution: 1920x1080 (docked, display 0x0)"], "docked, display not known");
  assert.deepEqual(res({ opmode: 1, display: { w: 3840, h: 2160 } }), [3, "vi::QueryDisplayBufferMaxResolution: 3840x2160 (docked, display 3840x2160)"]);
  assert.equal(res({ opmode: 1, display: { w: 2560, h: 1440 } })[0], 2); assert.equal(res({ opmode: 1, display: { w: 3000, h: 2000 } })[0], 2, "the largest of the four the display holds");
  assert.equal(res({ opmode: 1, display: { w: 1080, h: 1920 } })[0], 1, "a display turned on its side"); assert.equal(res({ opmode: 1, display: { w: 1366, h: 768 } })[0], 0); assert.equal(res({ opmode: 1, display: { w: 800, h: 600 } })[0], 0);
});

test("vi (t_vi_history.c): the frame number and ListFrameHistory as the SDK fills FrameInfo", () => {
  const h = new Hle(), HIST = vi("16ListFrameHistoryEPNS0_9FrameInfoEiPKNS0_5LayerE"), fi = h.alloc(10 * 40, 0xA5);
  h.guestNs = 5000000000n; h.monoNs = 9000000000n;
  const hist = (p: number, n: number) => h.w0(HIST, p, n, 0), F = (k: number, i: number) => h.u64(fi + 40 * k + 8 * i), ticks = (ns: bigint) => ns * 12n / 625n;
  assert.ok(hist(0, 0) === 8 && hist(fi, 0) === 8, "the SDK's count query");
  assert.equal(hist(fi, 10), 0, "nothing presented yet");
  const present = () => { h.vi.queued++; h.vi.frames++; h.host.viFrameQueued(h.vi.frames); };
  for (let i = 0; i < 10; i++) { present(); h.guestNs += 16666667n; h.monoNs += 16666667n; }   // frames 1-10, tickets 1-10
  const no = h.alloc(8); assert.equal(h.w0(vi("20GetLatestFrameNumberEPmPKNS0_5LayerE"), no, 0), 0); assert.equal(h.u64(no), 10n, "the latest frame number: the frames presented so far");
  h.vi.done = 7n;                                          // 1-7 handed on, 8-10 still queued
  h.vi.presented.set(7n, h.monoNs - 100000000n);           // 7 shown 0.1 s before host now
  h.vi.presented.set(6n, -1n);                             // 6 dropped by the system
  h.u8.fill(0xA5, fi, fi + 400);
  let n = hist(fi, 10);
  assert.equal(n, 8, "the last 8: frames 10 down to 3");
  for (let k = 0; k < n; k++) assert.equal(F(k, 1), BigInt(10 - k));
  for (let k = 0; k < 3; k++) assert.ok(F(k, 0) === 1n && F(k, 3) === 0n && F(k, 4) === 0n, "10, 9, 8: queued");
  assert.ok(F(3, 0) === 2n && F(3, 3) === F(3, 4) && F(3, 3) === ticks(h.guestNs - 100000000n), "7: its presented time on the guest clock");
  assert.ok(F(4, 0) === 1n && F(4, 3) === 0n, "6: dropped");
  assert.ok(F(5, 0) === 2n && F(5, 3) === ticks(h.guestNs), "5: handed on, no presented time (headless): the time it was first seen");
  assert.equal(F(0, 2), ticks(5000000000n + 9n * 16666667n), "queue tick of frame 10");
  assert.equal(F(8, 0), 0xa5a5a5a5a5a5a5a5n, "nothing written past the entries returned");
  h.guestNs += 1000000000n;
  n = hist(fi, 10);
  assert.equal(F(5, 3), ticks(h.guestNs - 1000000000n), "the first-seen time stays");
  assert.ok(hist(fi, 2) === 2 && F(0, 1) === 10n && F(1, 1) === 9n, "a smaller buffer gets the newest");
  assert.equal(h.logs.filter(l => l.startsWith("vi::ListFrameHistory")).length, 1);
  // a Switch 2 SDK counts ticks at 31.25 MHz
  const o = new Hle(); o.host.config({ sdkOunce: true }); o.guestNs = 6400n; o.vi.frames = 1n; o.vi.queued = 1n; o.host.viFrameQueued(1n);
  const g = o.alloc(40); assert.equal(o.w0(HIST, g, 1, 0), 1); assert.equal(o.u64(g + 16), 200n);
});

// ---------- nn::ro ----------
const ro = (n: string) => `_ZN2nn2ro${n}`;
const LOAD = ro("10LoadModuleEPNS0_6ModuleEPKvPvmi"), UNLOAD = ro("12UnloadModuleEPNS0_6ModuleE"), MODSYM = ro("18LookupModuleSymbolEPmPKNS0_6ModuleEPKc");
function nro(h: Hle, tag: number, size = 128, bss = 32): { p: number; sha: string; bytes: Buffer } {
  const b = Buffer.alloc(size); b.write("NRO0", 0x10); b.writeUInt32LE(size, 0x18); b.writeUInt32LE(bss, 0x38); b[0x40] = tag;
  return { p: h.bytes(b), sha: createHash("sha256").update(b).digest("hex"), bytes: b };
}
const mod = (h: Hle, p: number) => ({ module: h.u64(p), state: h.u32(p + 8), pad: h.u32(p + 12), image: h.u64(p + 16), buffer: h.u64(p + 24) });

test("SHA-256 of guest memory is SHA-256", () => {
  const h = new Hle(), out = h.alloc(32 + 16, 0xEE);
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70001]) {
    const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 131 + n) & 255)), p = h.bytes(b.length ? b : [0]);
    h.x.hle_sha256(p, n, out);
    assert.equal(h.read(out, 32).toString("hex"), createHash("sha256").update(b).digest("hex"), `${n} bytes`); assert.equal(h.u8[out + 32], 0xEE);
  }
});

test("ro (t_nro.c's nn::ro half): load order, init and fini, lookups, unload and load again, an image loaded twice, a loader that cannot", () => {
  const h = new Hle();
  let inits = 0, finis = 0;
  const order: string[] = [];
  const A = nro(h, 1), B = nro(h, 2);
  const initA = h.fn(() => { inits++; order.push("initA"); }), finiA = h.fn(() => { finis++; order.push("finiA"); }), initB = h.fn(() => { inits++; order.push("initB"); }), finiB = h.fn(() => { finis++; order.push("finiB"); });
  h.nroPlan = (image, size, sha, alone): { syms?: Record<string, bigint>; init?: bigint[]; fini?: bigint[] } | null => {
    assert.equal(alone, false); assert.equal(size, 128);
    if (sha === A.sha) { assert.equal(Number(image), A.p); return { syms: { shared: 0x7200_1000n }, init: [initA], fini: [finiA] }; }
    if (sha === B.sha) return { syms: { shared: 0x7300_1000n, late: 0x7300_2000n }, init: [initB, initB], fini: [finiB] };
    return null;
  };
  const size = h.alloc(16, 0xEE), GBS = ro("13GetBufferSizeEPmPKv");
  assert.equal(h.w0(ro("10InitializeEv")), 0);
  assert.equal(h.w0(GBS, size, A.p), 0); assert.deepEqual([h.u64(size), h.u8[size + 8]], [32n, 0xEE], "the bss size from the NRO header, a size_t");
  assert.equal(h.w0(GBS, size, h.alloc(64)), RO_NOT_NRO); assert.equal(h.w0(GBS, size, 0), RO_NOT_NRO); assert.equal(h.w0(GBS, 0, A.p), 0);
  const mA = h.alloc(32, 0xEE), mB = h.alloc(32, 0xEE), buf = h.alloc(64);
  assert.equal(h.w0(LOAD, mB, B.p, buf, 32, 1), 0); assert.equal(h.w0(LOAD, mA, A.p, 0, 32, 0), 0);   // deliberately the second image first
  assert.deepEqual([inits, order], [3, ["initB", "initB", "initA"]], "each module's init functions ran once, in the loader's order, on the calling thread");
  assert.deepEqual(h.roLog, [`load ${B.sha.slice(0, 8)}`, `activate ${B.sha.slice(0, 8)}`, `load ${A.sha.slice(0, 8)}`, `activate ${A.sha.slice(0, 8)}`], "mapped, init, then activated");
  const tokB = [...h.nros.keys()][0], tokA = [...h.nros.keys()][1];
  assert.deepEqual(mod(h, mB), { module: tokB, state: 1, pad: 0, image: BigInt(B.p), buffer: BigInt(buf) }, "nn::ro::Module: the module, state 1, the image and the buffer the game passed");
  assert.deepEqual(mod(h, mA), { module: tokA, state: 1, pad: 0, image: BigInt(A.p), buffer: 0n });
  assert.equal(h.x.hle_ro_loaded(), 2);
  const p = h.alloc(16, 0xEE);
  assert.equal(h.w0(MODSYM, p, mA, h.str("shared")), 0); assert.equal(h.u64(p), 0x7200_1000n, "a definition in that one module");
  assert.equal(h.w0(MODSYM, p, mB, h.str("late")), 0); assert.equal(h.u64(p), 0x7300_2000n);
  assert.equal(h.w0(MODSYM, p, mA, h.str("late")), RO_FAIL, "a name that module does not define fails, as on Horizon"); assert.deepEqual(h.red, []);
  assert.equal(h.w0(MODSYM, 0, mA, h.str("shared")), 0, "no output wanted");
  // the same image again while it is loaded
  const mA2 = h.alloc(32, 0xEE);
  assert.equal(h.w0(LOAD, mA2, A.p, 0, 32, 1), RO_FAIL); assert.equal(h.u8[mA2], 0xEE); assert.equal(h.red.at(-1), `[RED] ro::LoadModule: ${A.sha.slice(0, 16)}... is loaded already`);
  // LookupSymbol is the lookup over every loaded module
  h.syms.set("shared", 0x7300_1000n);
  assert.equal(h.w0(ro("12LookupSymbolEPmPKc"), p, h.str("shared")), 0); assert.equal(h.u64(p), 0x7300_1000n);
  assert.equal(h.w0(ro("12LookupSymbolEPmPKc"), p, h.str("absent")), RO_FAIL); assert.equal(h.w0(ro("12LookupSymbolEPmPKc"), p, h.str("absent2")), RO_FAIL); assert.equal(h.w0(ro("12LookupSymbolEPmPKc"), p, 0), RO_FAIL);
  assert.equal(h.red.filter(l => l.startsWith("[RED] ro::LookupSymbol cannot find")).length, 1, "red for the first name not found");
  // unload: fini, out of the loader, the Module cleared
  h.call(UNLOAD, mB);
  assert.deepEqual([finis, order.at(-1), h.roLog.at(-1)], [1, "finiB", `unload ${B.sha.slice(0, 8)}`]); assert.deepEqual(mod(h, mB), { module: 0n, state: 0, pad: 0, image: BigInt(B.p), buffer: BigInt(buf) });
  assert.equal(h.w0(MODSYM, p, mB, h.str("shared")), RO_FAIL); assert.equal(h.red.at(-1), "[RED] ro::LookupModuleSymbol shared: not a loaded module");
  const reds = h.red.length; h.call(UNLOAD, mB); assert.equal(h.red.length, reds + 1, "unloading what is not loaded is red"); assert.match(h.red.at(-1)!, /^\[RED\] ro::UnloadModule: not a loaded module \(0x[0-9a-f]+\)$/); h.call(UNLOAD, 0);
  // and load it again: the same life once more (SDK 19's form with one more bool)
  assert.equal(h.w0(ro("10LoadModuleEPNS0_6ModuleEPKvPvmib"), mB, B.p, buf, 32, 1, 1), 0);
  assert.equal(inits, 5); assert.equal(mod(h, mB).state, 1); assert.notEqual(mod(h, mB).module, tokB, "a new mapping");
  h.call(UNLOAD, mA); h.call(UNLOAD, mB);
  assert.ok(inits === 5 && finis === 3); assert.equal(h.x.hle_ro_loaded(), 0); assert.equal(h.nros.size, 0);
  // an image the loader cannot map; an image that is no NRO
  const C = nro(h, 3), mC = h.alloc(32, 0xEE);
  assert.equal(h.w0(LOAD, mC, C.p, 0, 0, 0), RO_FAIL); assert.equal(h.red.at(-1), `[RED] ro::LoadModule: the loader could not map the NRO with SHA-256 ${C.sha.slice(0, 16)}... (128 bytes)`); assert.equal(h.u8[mC], 0xEE);
  assert.equal(h.w0(LOAD, mC, h.alloc(128), 0, 0, 0), RO_NOT_NRO); assert.equal(h.w0(LOAD, mC, 0, 0, 0, 0), RO_NOT_NRO);
  assert.equal(h.w0(ro("8FinalizeEv")), 0); h.call(ro("20UnregisterModuleInfoEPNS0_16RegistrationInfoE"), 0);
  assert.equal(h.x.kit_refused_total(), 0);
});

test("ro: online SDKs are never loaded: by hash, by export, and an NRR that registers only them", () => {
  const h = new Hle(), A = nro(h, 1), E = nro(h, 9), m = h.alloc(32, 0xEE);
  let ran = 0; const init = h.fn(() => { ran++; });
  h.nroPlan = (_i, _s, sha) => sha === E.sha ? { syms: { EOS_Platform_Create: 0x7400_0000n }, init: [init] } : { init: [init] };
  // by export: mapped, found out, unmapped again; nothing of it ran
  assert.equal(h.w0(LOAD, m, E.p, 0, 0, 0), RO_FAIL);
  assert.deepEqual(h.roLog, [`load ${E.sha.slice(0, 8)}`, `unload ${E.sha.slice(0, 8)}`]); assert.equal(ran, 0); assert.equal(h.u8[m], 0xEE); assert.equal(h.x.hle_ro_loaded(), 0);
  assert.ok(h.logs.at(-1)!.includes("an online SDK (Epic Online Services), not loaded; the game plays offline")); assert.deepEqual(h.red, [], "a refusal is not an error");
  // by hash: the loader is never asked
  h.host.roRefuse(Buffer.from(A.sha, "hex")); h.roLog.length = 0;
  assert.equal(h.w0(LOAD, m, A.p, 0, 0, 0), RO_FAIL); assert.deepEqual(h.roLog, []);
  // NRR: 'NRR0', the hash table's offset and count at +0x340 (version 1: +0x4c0)
  const REG = ro("18RegisterModuleInfoEPNS0_16RegistrationInfoEPKv");
  const nrr = (hashes: string[], v1 = false) => { const hdr = v1 ? 0x4c0 : 0x340, b = Buffer.alloc(hdr + 0x10 + 32 * hashes.length); b.write("NRR0"); b[5] = v1 ? 1 : 0; b.writeUInt32LE(hdr + 0x10, hdr); b.writeUInt32LE(hashes.length, hdr + 4); hashes.forEach((x, i) => Buffer.from(x, "hex").copy(b, hdr + 0x10 + 32 * i)); return h.bytes(b); };
  assert.equal(h.w0(REG, 0, nrr([A.sha])), RO_FAIL, "an NRR that registers only refused SDKs fails");
  assert.equal(h.w0(REG, 0, nrr([A.sha], true)), RO_FAIL, "the Switch 2's NRR version");
  assert.equal(h.w0(REG, 0, nrr([A.sha, E.sha])), 0, "one with another module too is registered"); assert.equal(h.w0(REG, 0, nrr([])), 0); assert.equal(h.w0(REG, 0, nrr([E.sha], true)), 0);
  assert.equal(h.w0(REG, 0, h.alloc(0x400)), RO_FAIL, "not an NRR"); assert.equal(h.w0(REG, 0, 0), RO_FAIL);
  assert.deepEqual(h.red, []);
});

// ---------- nn::jit ----------
const jit = (n: string) => `_ZN2nn3jit${n}`;
const CREATE = jit("20CreateJitEnvironmentEPNS0_9JitHandleERKNS0_27JitEnvironmentConfigurationERKNS0_13JitPluginInfoEPvm"), GEN = jit("12GenerateCodeEPNS0_9CodeRangeES2_NS0_9JitHandleEmPKvmRKS1_S7_S5_mPvm");
const MB2 = 0x200000;
// A fake plugin behind the fake loader: its entry points are JavaScript functions at made-up guest addresses
function plugin(h: Hle, o: { version?: number; drop?: string[] } = {}) {
  const P = nro(h, 0x77, 256), log: string[] = [];
  const seen = { resolver: 0n, diag: [] as bigint[], flagsAt: 0n, cfg: [] as bigint[], gen: [] as bigint[][], ctl: [] as bigint[][], d32: Buffer.alloc(0), helpers: {} as Record<string, bigint> };
  let genRet = 0, genCode: [bigint, bigint] = [0x40n, 0x80n], genWrap = 0n, ctlRet = 5;
  const u64s = (p: bigint, n: number) => Array.from({ length: n }, (_, i) => h.u64(Number(p) + 8 * i));
  const stub = (addr: bigint) => Number((addr - 0x07FC_0000n) / 4n);   // the harness's stub addresses
  const syms: Record<string, bigint> = {
    nnjitpluginGetVersion: h.fn(() => { log.push("GetVersion"); return o.version ?? 1; }),
    nnjitpluginResolveBasicSymbols: h.fn(r => {
      log.push("ResolveBasicSymbols"); seen.resolver = r;
      // the plugin calls the resolver (a host stub) for each helper it needs
      for (const n of ["memcpy", "memmove", "memset", "PanicForPlugin", "_ZN2nn4diag6detail9AbortImplEPKcS3_S3_i", "_ZN2nn6detail21UnexpectedDefaultImplEPKcS2_i", "malloc"]) seen.helpers[n] = h.host.call(stub(r), { x: [h.str(n)] }).x0;
    }),
    nnjitpluginSetupDiagnostics: h.fn((level, res) => { log.push("SetupDiagnostics"); seen.diag = [level, h.u64(Number(res))]; }),
    nnjitpluginConfigure: h.fn(flags => { log.push("Configure"); seen.flagsAt = flags; h.dv.setUint32(Number(flags), 0, true); }),
    nnjitpluginOnPrepared: h.fn(cfg => { log.push("OnPrepared"); seen.cfg = u64s(cfg, 10); }),
    nnjitpluginGenerateCode: h.fn((...a) => {
      seen.gen.push(a); seen.d32 = h.read(Number(a[9]), 32);
      h.dv.setInt32(Number(a[0]), genRet, true);
      h.dv.setBigUint64(Number(a[1]), genCode[0], true); h.dv.setBigUint64(Number(a[1]) + 8, genCode[1], true);
      h.dv.setBigUint64(Number(a[2]), 0x10n, true); h.dv.setBigUint64(Number(a[2]) + 8, 0x20n, true);
      if (a[11]) h.u8.fill(0xC0, Number(a[11]), Number(a[11]) + Number(a[12]));
      return genWrap;
    }),
    nnjitpluginControl: h.fn((...a) => { seen.ctl.push(a); h.dv.setInt32(Number(a[0]), ctlRet, true); return 0; }),
  };
  for (const d of o.drop ?? []) delete syms[d];
  const init = h.fn(() => { log.push("init"); }), fini = h.fn(() => { log.push("fini"); });
  h.nroPlan = (_i, _s, sha, alone) => { assert.equal(sha, P.sha); assert.ok(alone, "a JIT plugin is loaded on its own"); return { syms, init: [init], fini: [fini] }; };
  const nrr = h.alloc(0x100), work = (h.alloc(8 * MB2) + MB2 - 1) & ~(MB2 - 1);
  const cfg = h.alloc(16), plug = h.alloc(40), out = h.alloc(16, 0xEE);
  h.dv.setBigUint64(cfg, BigInt(2 * MB2), true); h.dv.setBigUint64(cfg + 8, BigInt(MB2), true);
  [nrr, 0x100, P.p, 256, MB2].forEach((v, i) => h.dv.setBigUint64(plug + 8 * i, BigInt(v), true));
  return { P, log, seen, cfg, plug, work, out, stub, create: (workSize = 4 * MB2) => h.w0(CREATE, out, cfg, plug, work, workSize),
    set gen(v: { ret?: number; code?: [bigint, bigint]; wrap?: bigint }) { genRet = v.ret ?? 0; genCode = v.code ?? [0x40n, 0x80n]; genWrap = v.wrap ?? 0n; }, set ctl(v: number) { ctlRet = v; } };
}

test("jit: the plugin is loaded on its own and prepared as the service prepares it; GenerateCode with its stack arguments; Control; Destroy", () => {
  const h = new Hle(), pl = plugin(h);
  assert.equal(h.w0(jit("10InitializeEv")), 0);
  assert.equal(pl.create(), 0);
  assert.deepEqual(pl.log, ["init", "GetVersion", "ResolveBasicSymbols", "SetupDiagnostics", "Configure", "OnPrepared"], "its _init, GetVersion, ResolveBasicSymbols, SetupDiagnostics, Configure, OnPrepared");
  const env = Number(h.u64(pl.out)), { rx, ro: rom } = h.jit.allocs[0];
  assert.deepEqual([h.u64(env + 8), h.u64(env + 16), h.u64(env + 24), h.u64(env + 32)], [rx, BigInt(2 * MB2), rom, BigInt(MB2)], "the handle is the SDK's environment layout: code memory, its size, data memory, its size");
  assert.deepEqual(h.jit.allocs[0], { rx, ro: rom, rxSize: BigInt(2 * MB2), roSize: BigInt(MB2) });
  const tmem = BigInt(pl.work + 3 * MB2);
  assert.deepEqual(pl.seen.cfg, [rx, BigInt(2 * MB2), rom, BigInt(MB2), tmem, BigInt(MB2), rx, BigInt(2 * MB2), rom, BigInt(MB2)], "the plugin's configuration: user rx, user ro, transfer memory (the work buffer's last part), the service's rx and ro (the same mappings)");
  assert.deepEqual(pl.seen.diag, [0n, pl.seen.resolver], "diagnostics off, with a pointer to the resolver");
  // the resolver and the helpers are host stubs of the table's internal entries
  const names = (a: bigint) => h.host.entries()[pl.stub(a)].name;
  assert.equal(names(pl.seen.resolver), "hle.jit_resolve");
  assert.deepEqual(["memcpy", "memmove", "memset", "PanicForPlugin", "_ZN2nn4diag6detail9AbortImplEPKcS3_S3_i", "_ZN2nn6detail21UnexpectedDefaultImplEPKcS2_i"].map(n => names(pl.seen.helpers[n])),
    ["hle.jit_memcpy", "hle.jit_memmove", "hle.jit_memset", "hle.jit_panic", "hle.jit_abort", "hle.jit_unexp"]);
  assert.equal(pl.seen.helpers.malloc, 0n); assert.deepEqual(h.red, ["[RED] JIT plugin asks for malloc, which the host does not provide"]);
  const a = h.bytes([1, 2, 3, 4, 5, 6, 7, 8]), b = h.alloc(8);
  assert.equal(h.host.call(pl.stub(pl.seen.helpers.memcpy), { x: [b, a, 8] }).x0, BigInt(b)); assert.deepEqual([...h.read(b, 8)], [1, 2, 3, 4, 5, 6, 7, 8]);
  h.host.call(pl.stub(pl.seen.helpers.memset), { x: [b, 0x1ff, 4] }); assert.deepEqual([...h.read(b, 8)], [255, 255, 255, 255, 5, 6, 7, 8]);
  // GetJitEnvironmentInfo: 32 bytes by value, through x8
  const info = h.alloc(32 + 16, 0xEE);
  h.callRegs(jit("21GetJitEnvironmentInfoENS0_9JitHandleE"), { x: [env], x8: info });
  assert.deepEqual([0, 8, 16, 24].map(o => h.u64(info + o)), [rx, BigInt(2 * MB2), rom, BigInt(MB2)]); assert.equal(h.u8[info + 32], 0xEE);
  // Control(handle, command, in, in_size, out, out_size)
  pl.ctl = -7;
  assert.equal(h.call(jit("7ControlENS0_9JitHandleEmPKvmPvm"), env, 3, 0x1000, 0x20, 0x2000, 0x40).x0, 0xFFFFFFF9n, "the plugin's return value, an int");
  assert.deepEqual(pl.seen.ctl[0].slice(1), [BigInt(env + 0x28), 3n, 0x1000n, 0x20n, 0x2000n, 0x40n], "the configuration, then the game's arguments");
  // GenerateCode(&code_out, &data_out, handle, command, in, in_size, code_in, data_in | data, data_size, out, out_size on the stack)
  const c0 = h.alloc(16, 0xEE), c1 = h.alloc(16, 0xEE), cin = h.bytes(Buffer.alloc(16, 0x11)), din = h.bytes(Buffer.alloc(16, 0x22)), data = h.bytes([0xA1, 0xA2, 0xA3, 0xA4, 0xA5]), gout = h.alloc(16, 0xEE);
  h.stack = [BigInt(data), 5n, BigInt(gout), 8n];
  assert.equal(h.w0(GEN, c0, c1, env, 4, 0x3000, 0x60, cin, din), 0);
  const g = pl.seen.gen[0];
  assert.deepEqual(g.slice(3, 9), [BigInt(env + 0x28), 4n, 0x3000n, 0x60n, BigInt(cin), BigInt(din)], "configuration, command, input, the game's ranges");
  assert.deepEqual(g.slice(10), [5n, BigInt(gout), 8n], "data size, output and its size: the stack arguments");
  assert.deepEqual([...pl.seen.d32], [0xA1, 0xA2, 0xA3, 0xA4, 0xA5, ...Array(27).fill(0)], "the data zero-padded to 32 bytes, as the SDK sends it");
  assert.deepEqual([h.u64(c0), h.u64(c0 + 8), h.u64(c1), h.u64(c1 + 8)], [0x40n, 0x80n, 0x10n, 0x20n], "the ranges the plugin returned");
  assert.deepEqual(h.jit.written, [[rx, 0x40n, 0x80n]], "the translator is told which code was written");
  assert.ok(h.read(gout, 8).every(x => x === 0xC0) && h.u8[gout + 8] === 0xEE);
  // a failing request, a range beyond the code memory, a failing wrapper: red, the plugin's value returned
  pl.gen = { ret: 3 }; assert.equal(h.w0(GEN, c0, c1, env, 4, 0, 0, cin, din), 3); assert.equal(h.jit.written.length, 1, "a failed request invalidates nothing");
  assert.equal(h.red.at(-1), "[RED] jit::GenerateCode command 4: the plugin returned 3 (the service fails the request)");
  pl.gen = { code: [BigInt(2 * MB2) - 4n, 8n] }; assert.equal(h.w0(GEN, 0, 0, env, 9, 0, 0, cin, din), 0); assert.equal(h.jit.written.length, 1); assert.match(h.red.at(-1)!, /beyond the code memory$/);
  pl.gen = { wrap: 1n }; h.w0(GEN, c0, c1, env, 1, 0, 0, cin, din); assert.match(h.red.at(-1)!, /the plugin's wrapper failed \(command 1;/);
  pl.gen = { code: [BigInt(2 * MB2) - 8n, 8n] }; assert.equal(h.w0(GEN, c0, c1, env, 2, 0, 0, cin, din), 0); assert.deepEqual(h.jit.written.at(-1), [rx, BigInt(2 * MB2) - 8n, 8n], "a range that ends with the memory is inside it");
  // calls on what is no environment
  const reds = h.red.length;
  assert.equal(h.w0(GEN, c0, c1, 0x1234, 4, 0, 0, cin, din), 0xFFFFFFFF); assert.equal(h.w0(jit("7ControlENS0_9JitHandleEmPKvmPvm"), 0), 0xFFFFFFFF); h.call(jit("21DestroyJitEnvironmentENS0_9JitHandleE"), 0);
  assert.equal(h.red.length, reds + 2, "a handle of no environment is red; destroying a null handle is nothing");
  // Destroy: the plugin's fini, unloaded, the memory given back
  assert.equal(h.x.hle_jit_envs(), 1);
  h.call(jit("21DestroyJitEnvironmentENS0_9JitHandleE"), env);
  assert.equal(pl.log.at(-1), "fini"); assert.deepEqual(h.jit.freed, [rx]); assert.equal(h.nros.size, 0); assert.equal(h.x.hle_jit_envs(), 0);
  assert.ok(h.logs.includes("jit::DestroyJitEnvironment: GenerateCode 1 / 1 / 0 / 2 calls (commands 1-4)"));
  assert.equal(h.w0(jit("8FinalizeEv")), 0);
  // and created again in the same slot
  assert.equal(pl.create(), 0); assert.equal(Number(h.u64(pl.out)), env); h.call(jit("21DestroyJitEnvironmentENS0_9JitHandleE"), env);
  assert.equal(h.x.kit_refused_total(), 0);
});

test("jit: what the SDK aborts on is a red line and a failing CreateJitEnvironment; the plugin's panic ends the process", () => {
  const fail = (what: string, f: (h: Hle, pl: ReturnType<typeof plugin>) => number, o: Parameters<typeof plugin>[1] = {}) => {
    const h = new Hle(), pl = plugin(h, o);
    assert.equal(BigInt(f(h, pl)), RES_FAIL, what); assert.equal(h.u8[pl.out], 0xEE, `${what}: no handle`);
    assert.ok(h.red.at(-1)!.startsWith("[RED] jit::CreateJitEnvironment: "), what); assert.equal(h.x.hle_jit_envs(), 0); assert.equal(h.nros.size, 0, `${what}: nothing stays loaded`);
    assert.equal(h.jit.allocs.length, h.jit.freed.length, `${what}: the memory is given back`);
    return h;
  };
  fail("sizes that are no 2 MB multiples", (h, pl) => { h.dv.setBigUint64(pl.cfg, 0x1000n, true); return pl.create(); });
  fail("a work buffer too small", (_h, pl) => pl.create(3 * MB2));
  fail("no NRO among the plugin buffers", (h, pl) => { h.dv.setBigUint64(pl.plug + 16, BigInt(h.alloc(256)), true); return pl.create(); });
  fail("a loader that cannot map it", (h, pl) => { h.nroPlan = () => null; return pl.create(); });
  fail("no code memory", (h, pl) => { h.jit.fail = true; return pl.create(); });
  fail("a plugin without GenerateCode", (_h, pl) => pl.create(), { drop: ["nnjitpluginGenerateCode"] });
  const v = fail("a plugin of another version", (_h, pl) => pl.create(), { version: 2 });
  assert.ok(v.red.includes("[RED] jit: the plugin is version 2, the service takes 1"));
  // a plugin without the optional entry points is fine; Control then fails
  const h = new Hle(), pl = plugin(h, { drop: ["nnjitpluginResolveBasicSymbols", "nnjitpluginSetupDiagnostics", "nnjitpluginControl"] });
  assert.equal(pl.create(), 0); assert.deepEqual(pl.log, ["init", "GetVersion", "Configure", "OnPrepared"]);
  assert.equal(h.w0(jit("7ControlENS0_9JitHandleEmPKvmPvm"), Number(h.u64(pl.out)), 1), 0xFFFFFFFF); assert.match(h.red.at(-1)!, /the plugin has no nnjitpluginControl/);
  // four environments at most
  const m = new Hle(), pm = plugin(m);
  for (let i = 0; i < 4; i++) { m.nros.clear(); assert.equal(pm.create(), 0); }
  assert.equal(BigInt(pm.create()), RES_FAIL); assert.match(m.red.at(-1)!, /more than 4 environments/);
  // PanicForPlugin, AbortImpl, UnexpectedDefaultImpl: a red line with the plugin's words, then the exit path as an abort
  const k = new Hle(), pk = plugin(k); assert.equal(pk.create(), 0);
  const r = k.host.call(pk.stub(pk.seen.helpers.PanicForPlugin), { x: [k.str("out of code memory")] });
  assert.ok(r.noReturn); assert.ok(k.red.includes("[RED] JIT plugin PanicForPlugin: out of code memory")); assert.equal(k.exits[0].reason, "abort");
  const k2 = new Hle(), p2 = plugin(k2); p2.create();
  assert.ok(k2.host.call(p2.stub(p2.seen.helpers["_ZN2nn4diag6detail9AbortImplEPKcS3_S3_i"]), { x: [k2.str("x > 0"), k2.str("Emit"), k2.str("jit.cpp"), 42] }).noReturn);
  assert.ok(k2.red.includes("[RED] JIT plugin abort: x > 0 in Emit (jit.cpp:42)"));
  const k3 = new Hle(), p3 = plugin(k3); p3.create();
  k3.host.call(p3.stub(p3.seen.helpers["_ZN2nn6detail21UnexpectedDefaultImplEPKcS2_i"]), { x: [k3.str("Decode"), k3.str("mips.cpp"), 7] });
  assert.ok(k3.red.includes("[RED] JIT plugin unexpected default: Decode (mips.cpp:7)"));
});

// ---------- cut: movies and video codecs ----------
test("cut: movie::Decoder fails as nxnative's decoder without an implementation; one red line per function", () => {
  const h = new Hle(), M = (n: string) => `_ZN5movie${n}`;
  const vt = 0x7500_0000n; h.syms.set("_ZTVN5movie7DecoderE", vt);
  let deleted: bigint[] = []; h.fn(p => { deleted.push(p); }, "_ZdlPv");
  const self = h.alloc(32, 0xEE);
  const ctors = ["7DecoderC1ENS_11DecoderTypeENS_19DecoderOutputFormatENS_11DecoderModeEi", "7DecoderC1ENS_11DecoderTypeENS_19DecoderOutputFormatENS_11DecoderModeE", "7DecoderC1ENS_11DecoderTypeENS_19DecoderOutputFormatE",
    "7DecoderC2ENS_11DecoderTypeENS_19DecoderOutputFormatENS_11DecoderModeEi", "7DecoderC2ENS_11DecoderTypeENS_19DecoderOutputFormatENS_11DecoderModeE", "7DecoderC2ENS_11DecoderTypeENS_19DecoderOutputFormatE"];
  for (const c of ctors) {
    h.u8.fill(0xEE, self, self + 32); h.call(M(c), self, 3, 4, 1, 0);
    assert.deepEqual([h.u64(self), h.u64(self + 8), h.u8[self + 16]], [vt + 0x10n, 0n, 0xEE], `${c}: the SDK's vtable and no implementation`);
  }
  const codes: [string, bigint][] = [["7Decoder9ConfigureEPNS_9MediaDataE", 0x1000n], ["7Decoder20RegisterClientEventsEPNS_13DecoderEventsE", 0x1000n], ["7Decoder5StartEv", 0x2002n], ["7Decoder4StopEv", 0x2003n],
    ["7Decoder5ResetEv", 0x1000n], ["7Decoder5FlushEv", 0x1000n], ["7Decoder23AcquireInputBufferIndexEPiS1_", 0x1000n], ["7Decoder14GetInputBufferEiPNS_6BufferE", 0x1000n],
    ["7Decoder24SendInputBufferForDecodeEiiilj", 0x1000n], ["7Decoder24AcquireOutputBufferIndexEPiPlPjS1_", 0x1000n], ["7Decoder15GetOutputFormatEPNS_9MediaDataE", 0x1000n],
    ["7Decoder21GetOutputBufferFormatEiPNS_9MediaDataE", 0x1000n], ["7Decoder19GetOutputBufferSizeEPiS1_", 0x1000n], ["7Decoder15GetOutputBufferEiPNS_6BufferE", 0x1000n],
    ["7Decoder15GetOutputBufferEiPNS_6BufferEPNS_9MediaDataE", 0x1000n], ["7Decoder24ReleaseOutputBufferIndexEi", 0x1000n], ["7Decoder12GetLastErrorEv", 0n], ["9Extractor13SetDataSourceEPKc", 0x1000n]];
  const scratch = h.alloc(64, 0xEE);
  for (const [n, want] of codes) { assert.equal(h.call(M(n), self, scratch, scratch + 8, scratch + 16, scratch + 24).x0, want, n); assert.equal(h.call(M(n), self, 0, 0).x0, want); }
  assert.ok(h.read(scratch, 64).every(b => b === 0xEE), "no output is written by a decoder that is not there");
  h.call(M("7DecoderD2Ev"), self); h.call(M("7DecoderD1Ev"), self); assert.deepEqual(deleted, []);
  h.call(M("7DecoderD0Ev"), self); assert.deepEqual(deleted, [BigInt(self)], "the deleting destructor gives the object back through the game's operator delete");
  const rows = status().filter(r => r.file === "hle_movie.c");
  assert.equal(rows.length, 27); assert.ok(rows.every(r => r.status === "stub (cut: movies)"));
  assert.equal(new Set([...ctors, ...codes.map(c => c[0]), "7DecoderD2Ev", "7DecoderD1Ev", "7DecoderD0Ev"]).size, 27, "every name of hle_movie.c was called");
  assert.equal(h.red.length, 27, "one red line per function"); assert.ok(h.red.every(l => l.endsWith(" is cut (movies and video codecs are not played): it fails as in nxnative without a decoder")));
  assert.ok(h.red.includes("[RED] movie::Decoder::Start() is cut (movies and video codecs are not played): it fails as in nxnative without a decoder"));
  // a game without the movie library's vtable, and without operator delete
  const g = new Hle(), s2 = g.alloc(16, 0xEE);
  g.call(M(ctors[0]), s2, 3, 4, 1, 0); assert.deepEqual([g.u64(s2), g.u64(s2 + 8)], [0n, 0n]); g.call(M("7DecoderD0Ev"), s2);
  assert.deepEqual(g.red.filter(l => !l.includes(" is cut ")), ["[RED] movie: the game has no vtable of movie::Decoder (nxnative ends the process here): the decoder object keeps none", "[RED] movie: no operator delete in the game; the decoder object is not freed"]);
});

test("cut: nn::codec video decoders answer as a type with no host decoder (module 111, description 2004); pictures read black; sync points are reached at once", () => {
  const h = new Hle().sdk(), NONE = BigInt(0x6f | 2004 << 9);
  const rows = status().filter(r => r.file === "hle_codec_video.c"), by = (c: string) => rows.find(r => r.cname === c)!.mangled;
  assert.equal(rows.length, 101); assert.ok(rows.every(r => r.status === "stub (cut: video codecs)"));
  const t = h.alloc(0x400, 0xEE), o = h.alloc(64, 0xEE);
  for (const c of ["vp9", "vp8", "h264", "av1"]) {
    h.u8.fill(0xEE, t, t + 16); h.u8.fill(0xEE, o, o + 64);
    assert.equal(h.call(by(`h_cv_${c}work`), o, o + 8, 0, 1920, 1080).x0, 0n); assert.deepEqual([h.u64(o), h.u64(o + 8)], [0x1000n, 0x1000n], "no work memory needed, as in nxnative");
    for (const k of ["init", "init2", "tm", "rm", "rm19"]) { h.u8.fill(0xEE, t, t + 16); assert.equal(h.call(by(`h_cv_${c}${k}`), t, 0, 0, 0, 1920, 1080).x0, NONE, `${c}${k}`); assert.deepEqual([h.u64(t), h.u8[t + 8]], [0n, 0xEE], "no host decoder behind the type"); }
    for (const k of ["reg", "unreg", "start", "submit", "enc", "acq", "props"]) assert.equal(h.call(by(`h_cv_${c}${k}`), t, t, t, 0).x0, NONE, `${c}${k}`);
    for (const k of ["fin", "stop", "flush", "rel"]) assert.equal(h.call(by(`h_cv_${c}${k}`), t, 0).x0, 0n, `${c}${k}`);
    h.u8.fill(0xEE, o, o + 16); assert.equal(h.call(by(`h_cv_${c}event`), o, t).x0, NONE); assert.deepEqual([h.u64(o), h.u8[o + 8]], [0n, 0xEE], "no submission event");
    assert.equal(h.call(by(`h_cv_${c}ev22`), t).x0, 0n);
    h.u8.fill(0xEE, o, o + 64); assert.equal(h.call(by(`h_cv_${c}props19`), o, o + 2, o + 4, o + 6, o + 8, o + 16, o + 24, t).x0, NONE); assert.deepEqual([h.u32(o + 8), h.u8[o + 12], h.u8[o]], [0, 0xEE, 0xEE], "colour space 0, nothing else");
  }
  assert.equal(h.call(by("h_cv_h264init3"), t, 0, 0, 0, 1920, 1080).x0, NONE);
  assert.equal(h.call(by("h_cv_init")).x0, 0n); assert.equal(h.call(by("h_cv_fin")).x0, 0n);
  // the preference is a value: { u16 w, h; u32 format, mode, 'DmCV'; 8 bytes of zero } through x8
  for (const c of ["h_cv_pref", "h_cv_pref22", "h_cv_pref19"]) {
    const p = h.alloc(24 + 16, 0xEE); h.callRegs(by(c), { x: [0x1_0780n, 1080, 5, 2], x8: p });
    const e = Buffer.alloc(24); e.writeUInt16LE(1920, 0); e.writeUInt16LE(1080, 2); e.writeUInt32LE(5, 4); e.writeUInt32LE(2, 8); e.writeUInt32LE(0x56436d44, 12);
    assert.deepEqual(h.read(p, 24), e, c); assert.equal(h.u8[p + 24], 0xEE);
  }
  h.u8.fill(0xEE, o, o + 16); assert.equal(h.call(by("h_cv_poolsize"), o, o + 8, t, 4).x0, NONE); assert.deepEqual([h.u64(o), h.u64(o + 8)], [0n, 0x4000n]);
  for (const c of ["h_cv_pool", "h_cv_pool22"]) { h.u8.fill(0xEE, t, t + 16); assert.equal(h.call(by(c), t, 0, 0, o, 4, 0).x0, NONE); assert.equal(h.u64(t), 0n); }
  h.call(by("h_cv_poolfin"), t); assert.equal(h.call(by("h_cv_native"), t, 0).x0, 0n, "no native image handle");
  // the readers: no picture is black (RGBA 0; NV12 Y 16, UV 128); their sizes are stack arguments
  const img = h.alloc(64, 0xEE);
  h.stack = [32n]; assert.equal(h.call(by("h_cv_rgba"), t, 0, 0, 0, 4, 2, img, 16).x0, 0n); assert.ok(h.read(img, 32).every(b => b === 0) && h.u8[img + 32] === 0xEE);
  h.u8.fill(0xEE, img, img + 64); h.stack = [16n]; assert.equal(h.call(by("h_cv_rgbahdr"), t, 0, 0, 0, 4, 2, img, 16).x0, 0n); assert.ok(h.read(img, 16).every(b => b === 0) && h.u8[img + 16] === 0xEE);
  h.u8.fill(0xEE, img, img + 64); h.stack = [8n, BigInt(img + 32), 4n, 4n]; assert.equal(h.call(by("h_cv_nv12"), t, 0, 0, 0, 4, 2, img, 4).x0, 0n);
  assert.ok(h.read(img, 8).every(b => b === 16) && h.u8[img + 8] === 0xEE && h.read(img + 32, 4).every(b => b === 128) && h.u8[img + 36] === 0xEE, "video black");
  h.u8.fill(0xEE, img, img + 64); h.stack = [8n, BigInt(img + 32), 8n, 4n]; h.call(by("h_cv_nv12"), t, 0, 0, 0, 4, 2, img, 4); assert.equal(h.u8[img], 0xEE, "only whole tight pictures, as in nxnative");
  h.stack = [];
  // sync points: a handle no decoder made is reached, so a requested event is signalled at once
  assert.equal(h.call(by("h_gs_trywait"), o).x0, 1n);
  const ev = h.alloc(0x58 + 16, 0xEE);
  assert.equal(h.call(by("h_spt_create"), ev).x0, 0n); assert.ok(h.read(ev, 0x58).every(b => b === 0) && h.u8[ev + 0x58] === 0xEE); assert.equal(h.created.length, 1, "the event type holds a SystemEvent of the SDK");
  assert.equal(h.call(by("h_spt_request"), ev, o).x0, 0n); assert.ok(h.ev(h.created[0].w).signaled);
  h.call(by("h_spt_cancel"), ev); assert.ok(!h.ev(h.created[0].w).signaled);
  const calls: string[] = [];
  h.fn(() => { calls.push("holder"); }, "_ZN2nn2os25InitializeMultiWaitHolderEPNS0_19MultiWaitHolderTypeEPNS0_15SystemEventTypeE"); h.fn(() => { calls.push("try"); return 0x101; }, "_ZN2nn2os18TryWaitSystemEventEPNS0_15SystemEventTypeE"); h.fn(() => { calls.push("destroy"); }, "_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE");
  h.call(by("h_spt_holder"), o, ev); assert.equal(h.call(by("h_spt_trywait"), ev).x0, 1n, "a bool: the low byte"); h.call(by("h_spt_destroy"), ev);
  assert.deepEqual(calls, ["holder", "try", "destroy"], "forwarded to the SDK's nn::os");
  const called = new Set(h.red.map(l => l.replace(/ is cut .*/, "")));
  assert.equal(called.size, 101, "every name of hle_codec_video.c was called, each with its one red line"); assert.equal(h.red.length, 101);
});
