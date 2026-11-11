// The page of test/hle/browser.mts: the hle module (build/hle/hle.wasm) in Chromium with a bare outside (no SDK:
// host-only events), nn::codec's AV1 decoder taken over and WebCodecs' VideoDecoder behind it (video_webcodecs.ts),
// fed the libaom stream of av1_clip.mts as NintendoSDK_movie feeds it. Results go to window.nxResult.
import { HleHost, type HleEnv } from "../../../src/glue/hle_host.ts";
import { WebCodecsVideo } from "../../../src/glue/video_webcodecs.ts";
import { av1Packets, AV1_YUV, AV1_W, AV1_H } from "../av1_clip.mts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = globalThis as any;
const NAMES: Record<string, string> = G.NXNAMES;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function run(): Promise<{ checks: [boolean, string][]; logs: string[] }> {
  const checks: [boolean, string][] = [];
  const check = (ok: boolean, what: string) => { checks.push([ok, what]); };
  const mod = await WebAssembly.compile(await (await fetch("/hle.wasm")).arrayBuffer());
  const logs: string[] = [];
  let stack: bigint[] = [], top = 0, next = 0x2000;
  const events = new Map<number, { signaled: boolean }>();
  let host!: HleHost;
  const alloc = (n: number, fill = 0) => {
    const p = top; top += (n + 15) & ~15;
    const mem = host.memory; if (top > mem.buffer.byteLength) mem.grow(Math.ceil((top - mem.buffer.byteLength) / 65536));
    new Uint8Array(mem.buffer).fill(fill, p, p + n); return p;
  };
  const env: HleEnv = {
    log: l => { logs.push(l); }, guestNs: () => 0n, monoNs: () => BigInt(Math.round(performance.now() * 1e6)), realNs: () => 0n,
    timeZone: () => ({ offset: 0, dst: false, name: "UTC" }), entropy: o => { o.fill(1); },
    eventNew: () => { const e = { signaled: false }, r = next++, w = next++; events.set(r, e); events.set(w, e); return { r, w }; },
    eventSignal: h => { const e = events.get(h); if (!e) return false; e.signaled = true; return true; },
    eventClear: h => { const e = events.get(h); if (!e) return false; e.signaled = false; return true; },
    eventDupReadable: h => h, guestSym: () => 0n, guestCall: () => 0n, moduleOf: () => -1, stubAddr: id => BigInt(0x07FC0000 + 4 * id),
    hostAlloc: n => BigInt(alloc(Number(n))), clockFreeze: () => {}, textRequest: () => {}, webOpen: () => 2, webShow: () => {}, webSend: () => {}, webClose: () => {},
    inputHold: () => {}, vsyncEvent: () => {}, nativeImageBlank: () => 0, nativeImageBlankFree: () => {}, exitRequest: () => {},
    stackArg: i => stack[i] ?? 0n,
  };
  host = new HleHost(mod, env);
  top = Math.ceil(host.x.hle_static_end() / 0x10000) * 0x10000 + 0x10000;
  check(WebCodecsVideo.available(), "WebCodecs VideoDecoder is there");
  env.video = new WebCodecsVideo({ picture: (d, g, s, p) => host.videoPicture(d, g, s, p), log: l => { logs.push(l); } });
  const id = (c: string) => host.lookup(NAMES[c]);
  const call = (c: string, ...x: (number | bigint)[]) => host.call(id(c), { x }).x0;
  const dv = () => new DataView(host.memory.buffer), u8 = () => new Uint8Array(host.memory.buffer);
  const W = AV1_W, H = AV1_H, tus = av1Packets(), N = tus.length;
  const t = alloc(0x400, 0xEE), out = alloc(64), pref = alloc(24);
  host.call(id("h_cv_pref22"), { x: [W, H, 3, 0], x8: pref });
  call("h_cv_poolsize", out, out + 8, pref, 1);
  const psize = Number(dv().getBigUint64(out, true));
  const pools = tus.map(() => { const pt = alloc(16); call("h_cv_pool22", pt, alloc(psize), psize, pref, 1); return pt; });
  stack = [3n, 0n];
  check(call("h_cv_av1tm", t, 0, 0x1000, 0x10000, W, H, 4, 0) === 0n, "InitializeAv1DecoderByTransferMemory");
  stack = [];
  pools.forEach((pt, i) => call("h_cv_av1reg", t, i, pt, 0));
  for (let i = 0; i < N; i++) call("h_cv_av1acq", out, out + 8, t);
  call("h_cv_av1start", t);
  for (let i = 0; i < N; i++) call("h_cv_av1rel", t, i, 0, 0);
  const pkt = alloc(4096);
  const submit = (k: number, eos = false) => { u8().set(tus[k], pkt); return call("h_cv_av1submit", out + 32, t, pkt, tus[k].length, (k + 1) * 33_333_333, eos ? 1 : 0); };
  const props = (i: number) => {
    const p = alloc(32);
    const r = call("h_cv_av1props", p, p + 2, p + 4, p + 6, p + 8, p + 16, t, i);
    return { r, w: dv().getUint16(p, true), h: dv().getUint16(p + 2, true), ts: dv().getBigInt64(p + 8, true), eos: u8()[p + 16] };
  };
  const t0 = performance.now();
  for (let k = 0; k < N; k++) check(submit(k) === 0n, `packet ${k} taken`);
  call("h_cv_av1submit", out + 32, t, 0, 0, 0, 1);   // end of stream
  const filled = async (idx: number[]) => { for (let n = 0; n < 500; n++) { if (idx.every(i => props(i).r === 0n)) return true; await sleep(10); } return false; };
  check(await filled([...Array(N).keys()]), `all ${N} buffers filled`);
  const ms = performance.now() - t0;
  const nv12 = (i: number) => {
    const y = alloc(W * H), uv = alloc(W * H / 2); stack = [BigInt(W * H), BigInt(uv), BigInt(W), BigInt(W * H / 2)];
    call("h_cv_nv12", pools[i], 0, 0, 0, W, H, y, W); stack = [];
    const b = u8(), avg = (p: number, n: number, step: number, off: number) => { let s = 0, c = 0; for (let k = off; k < n; k += step) { s += b[p + k]; c++; } return s / c; };
    return [avg(y, W * H, 1, 0), avg(uv, W * H / 2, 2, 0), avg(uv, W * H / 2, 2, 1)];
  };
  for (let i = 0; i < N; i++) {
    const p = props(i), got = nv12(i), want = AV1_YUV[i];
    check(p.w === W && p.h === H, `picture ${i}: ${p.w}x${p.h}`);
    check(p.ts === BigInt((i + 1) * 33_333_333), `picture ${i}: its packet's time (${p.ts})`);
    check(got.every((v, k) => Math.abs(v - want[k]) <= 3), `picture ${i}: Y U V ${got.map(v => v.toFixed(1))}, the stream's ${want}`);
    check((p.eos === 1) === (i === N - 1), `picture ${i}: end of stream ${p.eos}`);
  }
  // RGBA by the stream's BT.709 matrix: picture 0 is red
  const rgba = alloc(W * H * 4); stack = [BigInt(W * H * 4)]; call("h_cv_rgba", pools[0], 0, 0, 0, W, H, rgba, W * 4); stack = [];
  const px = [...u8().subarray(rgba, rgba + 4)];
  check(px[0] >= 240 && px[1] <= 40 && px[2] <= 10 && px[3] === 255, `picture 0 as RGBA (BT.709): ${px}`);
  // Flush, then the stream again from its second key frame (3): a new generation, pictures again
  call("h_cv_av1flush", t);
  for (let i = 0; i < 3; i++) { call("h_cv_av1acq", out, out + 8, t); }
  const again = [0, 1, 2].map(() => { call("h_cv_av1acq", out, out + 8, t); return dv().getUint32(out, true); });
  for (const i of again) call("h_cv_av1rel", t, i, 0, 0);
  for (let k = 3; k < N; k++) submit(k);
  check(await filled(again), "after Flush: pictures from the next key frame");
  again.forEach((i, k) => { const got = nv12(i), want = AV1_YUV[3 + k]; check(got.every((v, j) => Math.abs(v - want[j]) <= 3), `after Flush, picture ${3 + k}: ${got.map(v => v.toFixed(1))}`); });
  call("h_cv_av1fin", t);
  check(logs.some(l => l === "[codec] AV1 decoder 1: WebCodecs av01.0.00M.08"), "the decoder's line names its codec string");
  check(logs.some(l => l.startsWith("[codec] AV1 decoder 1: 64x64, input format 0, output format 3 (WebCodecs VideoDecoder on the host)")), "the decoder's first line");
  check(!logs.some(l => l.startsWith("[RED] nn::codec")), "no red nn::codec line");
  logs.push(`decode of ${N} packets: ${ms.toFixed(1)} ms`);
  return { checks, logs };
}
run().then(r => { G.nxResult = r; }, e => { G.nxResult = { checks: [[false, `the page threw: ${e?.stack ?? e}`]], logs: [] }; });
