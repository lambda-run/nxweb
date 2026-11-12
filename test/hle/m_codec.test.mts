// nn::codec's video decoders (src/hle/codec_video.ts, a port of nxnative hle_codec_video.c and its t_codec_video.c):
// the buffer protocol, its results and events as NintendoSDK_movie drives them, with no decoder on the host (video
// black), with an asynchronous decoder of the embedder (HleEnv.video, as WebCodecs is), native images, and the AV1
// bitstream reading the WebCodecs decoder needs (src/glue/video_host.ts) on a real libaom stream.
import assert from "node:assert/strict";
import { Hle, test, status } from "./harness.mts";
import type { VideoBackend, VideoPicture } from "../../src/glue/video_host.ts";
import { av1Inspect, av1Obus, vp8Key, vp9Key } from "../../src/glue/video_host.ts";
import { av1Packets, AV1_YUV } from "./av1_clip.mts";

const R = (d: number) => BigInt(0x6f | d << 9), BUSY = R(3603), NONE = R(3604), BAD = R(2004);
const rows = () => status().filter(r => r.file === "hle_codec_video.c");
const by = (c: string) => rows().find(r => r.cname === c)!.mangled;

// The SDK's side of a movie: the decoder type (0x400 bytes, its event at +0x100), one pool per picture
function movie(h: Hle, o: { w?: number; h?: number; bufs?: number; native?: boolean } = {}) {
  const W = o.w ?? 64, H = o.h ?? 32, N = o.bufs ?? 4;
  const destroyed: bigint[] = [];
  h.fn(e => { destroyed.push(e); }, "_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE");
  const t = h.alloc(0x400, 0xEE), out = h.alloc(64, 0xEE);
  const pref = h.alloc(24); h.callRegs(by("h_cv_pref22"), { x: [W, H, 3, 0], x8: pref });
  assert.equal(h.call(by("h_cv_poolsize"), out, out + 8, pref, 1).x0, 0n);
  const psize = Number(h.u64(out));
  const pools = Array.from({ length: N }, () => { const pt = h.alloc(16), mem = h.alloc(psize, 0x55); assert.equal(h.call(by("h_cv_pool22"), pt, mem, psize, pref, 1).x0, 0n); return { pt, mem }; });
  h.stack = [3n, 0n];   // output format, output mode: stack arguments of the SDK 22 form
  const init = h.call(by("h_cv_av1tm"), t, 0, 0x1000, 0x10000, W, H, 4, 0).x0;
  h.stack = [];
  const ev = t + 0x100, created = () => h.created.find(c => c.ev === BigInt(ev))!;
  const sig = () => h.ev(created().w).signaled;
  const acq = () => { const r = h.call(by("h_cv_av1acq"), out, out + 8, t).x0; return { r, i: h.u32(out), sync: h.read(out + 8, 16) }; };
  const props = (i: number) => { const p = h.alloc(32, 0xEE); const r = h.call(by("h_cv_av1props"), p, p + 2, p + 4, p + 6, p + 8, p + 16, t, i).x0;
    return { r, w: h.dv.getUint16(p, true), h: h.dv.getUint16(p + 2, true), cw: h.dv.getUint16(p + 4, true), ch: h.dv.getUint16(p + 6, true), ts: h.i64(p + 8), eos: h.u8[p + 16] }; };
  const pkt = h.alloc(256, 0xA5);
  const submit = (ts: number, eos = false, size = 16, data = pkt) => { const r = h.call(by("h_cv_av1submit"), out + 32, t, data, size, ts, eos ? 1 : 0).x0; return { r, n: h.u64(out + 32) }; };
  const rel = (i: number) => h.call(by("h_cv_av1rel"), t, i, 0, 0).x0;
  const nv12 = (pool: number) => { const y = h.alloc(W * H, 0xEE), uv = h.alloc(W * H / 2, 0xEE); h.stack = [BigInt(W * H), BigInt(uv), BigInt(W), BigInt(W * H / 2)];
    h.call(by("h_cv_nv12"), pools[pool].pt, 0, 0, 0, W, H, y, W); h.stack = []; return { y: h.read(y, W * H), uv: h.read(uv, W * H / 2) }; };
  const rgba = (pool: number) => { const d = h.alloc(W * H * 4, 0xEE); h.stack = [BigInt(W * H * 4)]; h.call(by("h_cv_rgba"), pools[pool].pt, 0, 0, 0, W, H, d, W * 4); h.stack = []; return h.read(d, W * H * 4); };
  return { W, H, t, ev, init, pools, psize, destroyed, sig, acq, props, submit, rel, nv12, rgba, pkt, out, pref };
}
const loaded = (h: Hle, m: ReturnType<typeof movie>) => { for (let i = 0; i < m.pools.length; i++) assert.equal(h.call(by("h_cv_av1reg"), m.t, i, m.pools[i].pt, 0).x0, 0n); };

test("nn::codec: every name of hle_codec_video.c is taken over (none cut), SDK 22, SDK 19 and the older forms", () => {
  const r = rows();
  assert.equal(r.length, 101);
  assert.ok(r.every(x => x.status === "implemented"), r.filter(x => x.status !== "implemented").map(x => `${x.cname}: ${x.status}`).join(", "));
});

test("nn::codec AV1 with no decoder on the host: NintendoSDK_movie's whole sequence; video black pictures, events, busy 3603, end of stream", () => {
  const h = new Hle().sdk(), m = movie(h);
  assert.equal(m.init, 0n, "SDK 22's InitializeAv1DecoderByTransferMemory succeeds: the movie module aborts on one that does not");
  assert.equal(h.u64(m.t) >> 32n, 0x56436d44n);
  assert.ok(h.red.includes("[RED] nn::codec AV1 decoder 1: 64x32, input format 0, output format 3: no decoder for it on the host (HleEnv.video), every packet gives a picture of video black"), h.red.join("\n"));
  assert.ok(m.sig(), "signalled at Initialize");
  assert.equal(h.call(by("h_cv_av1ev22"), m.t).x0, BigInt(m.ev), "SDK 22's GetAv1DecoderSubmissionReadyEvent returns the event");
  const eo = h.alloc(8); assert.equal(h.call(by("h_cv_av1event"), eo, m.t).x0, 0n); assert.equal(h.u64(eo), BigInt(m.ev));
  loaded(h, m);
  // registered buffers are acquirable at once, in order, with a reached sync handle
  for (let i = 0; i < 4; i++) { const a = m.acq(); assert.equal(a.r, 0n); assert.equal(a.i, i); assert.deepEqual([...a.sync], [...Buffer.from([0x44, 0x6d, 0x43, 0x53, 1, 0, 0, 0, i, 0, 0, 0, 0, 0, 0, 0])]); }
  assert.equal(m.acq().r, NONE, "3604 when no buffer is acquirable");
  assert.equal(m.props(0).r, NONE, "3604 until the buffer is filled");
  h.created.forEach(c => { h.ev(c.w).signaled = false; });
  assert.equal(h.call(by("h_cv_av1start"), m.t).x0, 0n); assert.ok(m.sig(), "Start signals (the player counts signals as packets)");
  for (let i = 0; i < 4; i++) assert.equal(m.rel(i), 0n);
  // a sync point event on buffer 0's new generation waits for its picture
  const spt = h.alloc(0x60, 0xEE); h.call(by("h_spt_create"), spt);
  const want = h.bytes([0x44, 0x6d, 0x43, 0x53, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(h.call(by("h_gs_trywait"), want).x0, 0n, "not reached before the picture");
  h.call(by("h_spt_request"), spt, want);
  const sptW = h.created.find(c => c.ev === BigInt(spt))!.w;
  assert.ok(!h.ev(sptW).signaled);
  const s1 = m.submit(1000);
  assert.deepEqual([s1.r, s1.n], [0n, 1n]);
  assert.ok(h.ev(sptW).signaled, "the sync point event of the filled buffer"); assert.equal(h.call(by("h_gs_trywait"), want).x0, 1n);
  assert.ok(h.logs.includes("[codec] AV1 decoder 1: first picture 64x32 into buffer 0 (video black: no decoder)"), h.logs.join("\n"));
  const a0 = m.acq(); assert.deepEqual([a0.r, a0.i, a0.sync[12]], [0n, 0, 1], "the oldest acquirable buffer, its new generation");
  assert.deepEqual(m.props(0), { r: 0n, w: 64, h: 32, cw: 64, ch: 32, ts: 1000n, eos: 0 });
  const nv = m.nv12(0); assert.ok(nv.y.every(b => b === 16) && nv.uv.every(b => b === 128), "video black");
  const px = m.rgba(0); for (let i = 0; i < px.length; i += 4) assert.deepEqual([...px.subarray(i, i + 4)], [0, 0, 0, 255]);
  // three more fill the released buffers; then pictures wait: the event goes down at 4 waiting, packets are refused at 12
  for (let k = 2; k <= 4; k++) assert.equal(m.submit(k * 1000).r, 0n);
  let n = 0; while (m.sig() && n < 20) { assert.equal(m.submit(10_000 + n).r, 0n); n++; }
  assert.equal(n, 4, "the event goes down with 4 pictures waiting");
  for (let k = 4; k < 12; k++) assert.equal(m.submit(20_000 + k).r, 0n, "packets are still taken: a signal in flight finds room");
  const busy = m.submit(99_000); assert.equal(busy.r, BUSY, "3603 at 12 waiting");
  assert.ok(h.logs.some(l => l.startsWith("nn::codec AV1: busy (result 3603), a packet refused with 12 pictures")), "a refusal is logged plainly");
  assert.ok(!h.red.some(l => l.includes("3603")), "a refusal is no red line");
  // releases drain the waiting pictures in release order; room comes back
  for (const i of [1, 2, 3]) { const a = m.acq(); assert.equal(a.i, i); assert.deepEqual(m.props(i).ts, BigInt(i + 1) * 1000n); m.rel(i); }
  m.rel(0);
  assert.equal(m.props(1).ts, 10_000n, "the oldest waiting picture went into the first released buffer");
  let cycles = 0;
  while (!m.sig() && cycles < 12) { const a = m.acq(); m.rel(a.i); cycles++; }
  assert.equal(cycles, 5, "room came back below 4 waiting: signalled (8 waiting after the first four releases)");
  // Flush drops the waiting pictures; end of stream with nothing waiting is a buffer of its own
  const b4 = m.acq().i; assert.equal(h.call(by("h_cv_av1flush"), m.t).x0, 0n); assert.ok(m.sig());
  m.rel(b4);
  assert.equal(m.submit(0, true, 0).r, 0n);
  const eosBuf = (() => { for (let k = 0; k < 8; k++) { const a = m.acq(); if (a.r) break; const p = m.props(a.i); if (p.r === 0n && p.eos) return p; m.rel(a.i); } return null; })();
  assert.deepEqual(eosBuf && [eosBuf.w, eosBuf.h, eosBuf.eos], [0, 0, 1], "an end of stream with no picture");
  assert.ok(h.logs.some(l => /^\[codec\] AV1 decoder 1: end of stream after \d+ pictures$/.test(l)));
  // Unregister takes a buffer out; Finalize gives the event back to the SDK and clears the type
  assert.equal(h.call(by("h_cv_av1unreg"), m.t, 0).x0, 0n);
  assert.equal(h.call(by("h_cv_av1fin"), m.t).x0, 0n);
  assert.deepEqual(m.destroyed, [BigInt(m.ev)]); assert.equal(h.u64(m.t), 0n);
  assert.ok(h.logs.some(l => /^\[codec\] AV1 decoder 1 finalized: \d+ packets, \d+ pictures, \d+ of them video black$/.test(l)));
  assert.equal(h.call(by("h_cv_av1submit"), m.out, m.t, m.pkt, 16, 0, 0).x0, BAD, "a finalized decoder is no decoder");
  for (const p of m.pools) h.call(by("h_cv_poolfin"), p.pt);
  assert.equal(h.u64(m.pools[0].pt), 0n);
  // a decoder made again in the same cleared memory
  const m2 = movie(h); assert.equal(m2.init, 0n); assert.equal(h.u64(m2.t) & 0xFFFF_FFFFn, 1n, "decoder 1 again");
});

// A decoder of the embedder: packets are kept and answered when the test says, as WebCodecs answers later
class Mock implements VideoBackend {
  opened: [number, number, number, number][] = []; packets: { dec: number; gen: number; seq: bigint; bytes: number[]; eos: boolean }[] = []; resets: [number, number][] = []; closed: number[] = [];
  answer = 1;
  open(dec: number, codec: number, w: number, h: number): string { this.opened.push([dec, codec, w, h]); return "test decoder"; }
  decode(dec: number, gen: number, seq: bigint, packet: Uint8Array | null, eos: boolean): number { this.packets.push({ dec, gen, seq, bytes: packet ? [...packet] : [], eos }); return packet ? this.answer : 2; }
  reset(dec: number, gen: number): void { this.resets.push([dec, gen]); }
  close(dec: number): void { this.closed.push(dec); }
}
const flat = (w: number, h: number, y: number, u: number, v: number, matrix = 2, fullRange = false): VideoPicture => {
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  return { w, h, y: new Uint8Array(w * h).fill(y), u: new Uint8Array(cw * ch).fill(u), v: new Uint8Array(cw * ch).fill(v), yStride: w, uvStride: cw, matrix, fullRange };
};

test("nn::codec with the embedder's decoder: completions come later and in order, in-flight packets count, colour by the stream's matrix, stale completions refused", () => {
  const h = new Hle().sdk(), mock = new Mock(); h.host.env.video = mock;
  const m = movie(h, { w: 4, h: 2 });
  assert.deepEqual(mock.opened, [[1, 3, 4, 2]]);
  assert.ok(h.logs.includes("[codec] AV1 decoder 1: 4x2, input format 0, output format 3 (test decoder on the host)"), h.logs.join("\n"));
  loaded(h, m); for (let i = 0; i < 4; i++) m.acq();
  h.call(by("h_cv_av1start"), m.t); for (let i = 0; i < 4; i++) m.rel(i);
  m.pkt; h.u8.set([1, 2, 3], m.pkt);
  assert.equal(m.submit(500, false, 3).r, 0n);
  assert.deepEqual(mock.packets.map(p => [p.seq, p.bytes]), [[1n, [1, 2, 3]]], "the packet's bytes");
  assert.equal(m.props(0).r, NONE, "not filled before its completion");
  const gen = mock.packets[0].gen;
  // BT.601 red, video range
  h.host.videoPicture(1, gen, 1n, flat(4, 2, 81, 90, 240, 6));
  assert.deepEqual(m.props(0), { r: 0n, w: 4, h: 2, cw: 4, ch: 2, ts: 500n, eos: 0 });
  const px = m.rgba(0); assert.ok(px[0] >= 253 && px[1] <= 2 && px[2] <= 2 && px[3] === 255, `red: ${[...px.subarray(0, 4)]}`);
  const nv = m.nv12(0); assert.deepEqual([nv.y[0], nv.uv[0], nv.uv[1]], [81, 90, 240]);
  // a picture that does not name its matrix is BT.601 below 720 lines; BT.709 named
  m.acq(); m.rel(0);   // buffer 0 again, last in the queue
  for (let k = 2; k <= 4; k++) m.submit(k * 100, false, 3);
  h.host.videoPicture(1, gen, 2n, flat(4, 2, 81, 90, 240, 2));
  h.host.videoPicture(1, gen, 3n, null);   // a packet with no picture
  h.host.videoPicture(1, gen, 4n, flat(4, 2, 63, 102, 240, 1));
  assert.deepEqual(m.rgba(1).subarray(0, 3), m.rgba(0).subarray(0, 3), "not given: BT.601 at 2 lines");
  const r709 = m.rgba(2); assert.ok(r709[0] >= 253 && r709[1] <= 3 && r709[2] <= 3, `BT.709 red: ${[...r709.subarray(0, 4)]}`);
  assert.equal(m.props(3).r, NONE, "the packet with no picture filled nothing");
  // in-flight packets count with waiting pictures: 12 unanswered packets, the next is refused
  for (let k = 0; k < 12; k++) assert.equal(m.submit(1000 + k, false, 3).r, 0n);
  assert.equal(m.submit(5000, false, 3).r, BUSY);
  assert.ok(!m.sig(), "down while 4 or more are in flight");
  // Flush: a new generation; completions of the old one are refused and their pictures freed
  h.call(by("h_cv_av1flush"), m.t);
  assert.equal(mock.resets.length, 1); assert.ok(mock.resets[0][1] !== gen);
  assert.equal(h.x.hle_cv_picture(1, gen, 5n, 0, 2, 0), 0, "stale");
  h.host.videoPicture(1, gen, 6n, flat(4, 2, 200, 128, 128));
  assert.equal(m.props(3).r, NONE);
  // end of stream on a packet in flight marks its picture
  const g2 = mock.resets[0][1];
  m.submit(9000, false, 3); const seq = mock.packets.at(-1)!.seq; m.submit(0, true, 0);
  assert.equal(mock.packets.at(-1)!.eos, true, "the decoder is told to drain");
  h.host.videoPicture(1, g2, seq, flat(4, 2, 16, 128, 128));
  assert.deepEqual([m.props(3).ts, m.props(3).eos], [9000n, 1], "the last picture carries the end of stream");
  // the decoder takes nothing (answer 0): video black for the packet, one red line
  mock.answer = 0; m.acq(); m.acq(); m.acq(); m.acq(); for (let i = 0; i < 4; i++) m.rel(i);
  m.submit(7000, false, 3);
  assert.ok(h.red.some(l => l === "[RED] nn::codec AV1 decoder 1: the host decoder took no packet: video black"));
  h.call(by("h_cv_av1fin"), m.t); assert.deepEqual(mock.closed, [1]);
});

test("nn::codec pacing line: whether pictures waited for the game's buffers or buffers for the decoder's pictures", () => {
  const h = new Hle().sdk(), mock = new Mock(); h.host.env.video = mock;
  const m = movie(h, { w: 4, h: 2 });
  loaded(h, m); for (let i = 0; i < 4; i++) m.acq();
  h.call(by("h_cv_av1start"), m.t);
  h.u8.set([1, 2, 3], m.pkt);
  // the buffer is there first: it is filled when its picture arrives
  m.rel(0); m.submit(100, false, 3);
  const gen = mock.packets[0].gen;
  h.host.videoPicture(1, gen, 1n, flat(4, 2, 81, 90, 240, 6));
  assert.equal(m.props(0).r, 0n);
  // the picture is there first: it waits, and goes into the buffer at its release
  m.submit(200, false, 3);
  h.host.videoPicture(1, gen, 2n, flat(4, 2, 81, 90, 240, 6));
  m.rel(1);
  assert.equal(m.props(1).ts, 200n);
  h.call(by("h_cv_av1fin"), m.t);
  assert.ok(h.logs.includes("[codec] AV1 decoder 1 pacing over 2 pictures: 2 packets taken, 0 refused busy, 2 buffers released; 1 pictures were waiting for their buffer, 1 buffers for their picture; at most 1 pictures waiting, 1 packets decoding"), h.logs.filter(l => l.includes("pacing")).join("\n"));
});

test("nn::codec native images: the pool's memory gets each picture as RGBA (16 KB aligned, 64-byte rows) for nvnTextureInitializeFromNativeImage", () => {
  const h = new Hle().sdk(), mock = new Mock(); h.host.env.video = mock;
  const m = movie(h, { w: 20, h: 4, bufs: 2 });
  assert.equal(m.psize, 0x4000, "CalculateDecoderImagePoolBuffer: RGBA room, 16 KB aligned");
  const handle = Number(h.call(by("h_cv_native"), m.pools[1].pt, 0).x0);
  assert.equal(handle >> 8, 2, "pool slot 2"); assert.equal(handle & 0xff, 0);
  assert.ok(h.logs.includes("[codec] native image handles for the 20x4 pool: its pictures go into its memory as RGBA (stride 128)"), h.logs.join("\n"));
  assert.deepEqual(h.host.nativeImage(handle), { mem: m.pools[1].mem, size: 0x4000, w: 20, h: 4, stride: 128 });
  assert.equal(h.host.nativeImage(0x7700), null);
  assert.equal(h.call(by("h_cv_native"), m.pools[1].pt, 1).x0, 0n, "past the pool's pictures: no handle");
  loaded(h, m); m.acq(); m.acq(); h.call(by("h_cv_av1start"), m.t); m.rel(0); m.rel(1);
  m.submit(1, false, 3); m.submit(2, false, 3);
  const gen = mock.packets[0].gen;
  h.host.videoPicture(1, gen, 1n, flat(20, 4, 235, 128, 128));
  h.host.videoPicture(1, gen, 2n, flat(20, 4, 235, 128, 128));
  const mem = h.read(m.pools[1].mem, 128 * 4);
  for (let y = 0; y < 4; y++) { for (let x = 0; x < 20; x++) assert.deepEqual([...mem.subarray(y * 128 + 4 * x, y * 128 + 4 * x + 4)], [255, 255, 255, 255], `white at ${x},${y}`); assert.equal(mem[y * 128 + 80], 0x55, "the row's padding is not written"); }
  assert.ok(h.read(m.pools[0].mem, 16).every(b => b === 0x55), "a pool without a handle keeps its memory");
  assert.equal(h.x.hle_cv_native_writes(), 1n);
  // the pool goes away: a later picture for its buffer is not written anywhere
  h.call(by("h_cv_poolfin"), m.pools[1].pt); assert.equal(h.host.nativeImage(handle), null);
});

test("nn::codec: SDK 19 and older forms, the readers' rules, encrypted packets, sync handles the host did not make", () => {
  const h = new Hle().sdk(), t = h.alloc(0x400), o = h.alloc(64, 0xEE);
  for (const c of ["vp9", "vp8", "h264", "av1"]) {
    assert.equal(h.call(by(`h_cv_${c}work`), o, o + 8, 0, 1920, 1080).x0, 0n); assert.deepEqual([h.u64(o), h.u64(o + 8)], [0x1000n, 0x1000n]);
    for (const [k, x] of [["rm19", [t, 0x1000, 0, 32, 16, 4, 0, 3]], ["init2", [t, 0x1000, 32, 16, 4, 0, 3]], ["rm", [t, 0x1000, 32, 16, 4, 0, 3, 0]], ["init", [t, 0, 0, 0x1000, 32, 16, 4, 0]], ["tm", [t, 0, 0, 0x1000, 32, 16, 4, 0]]] as [string, number[]][]) {
      h.stack = [3n, 0n];
      assert.equal(h.call(by(`h_cv_${c}${k}`), ...x).x0, 0n, `${c}${k}`);
      h.stack = [];
      assert.ok(h.logs.at(-1)!.includes(" 32x16, input format 0, output format 3"), `${c}${k}: ${h.logs.at(-1)}`);
      const p = h.alloc(32, 0xEE); h.stack = [0n];
      assert.equal(h.call(by(`h_cv_${c}props19`), p, p + 2, p + 4, p + 6, p + 8, p + 16, p + 24, t).x0, NONE, "buffer 0 is not filled"); assert.equal(h.u32(p + 8), 0, "colour space 0");
      h.stack = [];
      assert.equal(h.call(by(`h_cv_${c}fin`), t).x0, 0n);
    }
    assert.equal(h.call(by(`h_cv_${c}enc`)).x0, BAD);
  }
  h.stack = [3n, 0n, 0n, 0n]; assert.equal(h.call(by("h_cv_h264init3"), t, 0, 0, 0x1000, 32, 16, 4, 0).x0, 0n); h.stack = []; h.call(by("h_cv_h264fin"), t);
  assert.equal(h.red.filter(l => l.includes("encrypted")).length, 1, "one red line for protected streams");
  assert.equal(h.call(by("h_gs_trywait"), h.bytes(new Array(16).fill(0))).x0, 1n, "a zero handle is reached");
  assert.equal(h.call(by("h_gs_trywait"), h.bytes([1, 2, 3, 4, ...new Array(12).fill(0)])).x0, 1n);
  assert.ok(h.red.some(l => l.startsWith("[RED] nn::codec: a sync handle the host did not make (0x4030201)")));
  const calls: string[] = [];
  h.fn(() => { calls.push("holder"); }, "_ZN2nn2os25InitializeMultiWaitHolderEPNS0_19MultiWaitHolderTypeEPNS0_15SystemEventTypeE"); h.fn(() => { calls.push("try"); return 0x101; }, "_ZN2nn2os18TryWaitSystemEventEPNS0_15SystemEventTypeE"); h.fn(() => { calls.push("destroy"); }, "_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE");
  const ev = h.alloc(0x60, 0xEE); h.call(by("h_spt_create"), ev); assert.ok(h.read(ev, 0x40).every(b => b === 0));
  h.call(by("h_spt_request"), ev, o); const w = h.created.at(-1)!.w; assert.ok(h.ev(w).signaled, "a handle no decoder made: signalled at once");
  h.call(by("h_spt_cancel"), ev); assert.ok(!h.ev(w).signaled);
  h.call(by("h_spt_holder"), o, ev); assert.equal(h.call(by("h_spt_trywait"), ev).x0, 1n); h.call(by("h_spt_destroy"), ev);
  assert.deepEqual(calls, ["holder", "try", "destroy"]);
  // HDR is not served; parts of a picture are not served
  const img = h.alloc(64, 0xEE); h.stack = [16n]; h.call(by("h_cv_rgbahdr"), t, 0, 0, 0, 4, 1, img, 16); h.stack = [];
  assert.ok(h.read(img, 16).every(b => b === 0)); assert.ok(h.red.includes("[RED] nn::codec::ReadDecoderOutputImageRgbaHdr: HDR pictures are not served, black"));
});

test("AV1 for WebCodecs: OBUs, the sequence header's codec string and colour, key frames, on a libaom stream; VP9 and VP8 key frames", () => {
  const tus = av1Packets();
  const first = av1Inspect(tus[0], null);
  assert.deepEqual(first.seq, { profile: 0, level: 0, tier: 0, bitDepth: 8, mono: false, matrix: 1, fullRange: false, reduced: false, codec: "av01.0.00M.08" });
  assert.deepEqual(tus.map(t => av1Inspect(t, first.seq).key), [true, false, false, true, false, false], "key frames at 0 and 3 (-g 3)");
  assert.deepEqual(av1Obus(tus[0]).map(o => o.type), [2, 1, 6], "temporal delimiter, sequence header, frame");
  assert.equal(AV1_YUV.length, tus.length);
  assert.ok(vp9Key(new Uint8Array([0x82, 0x49, 0x83, 0x42])), "VP9 profile 0 key frame"); assert.ok(!vp9Key(new Uint8Array([0x86])), "VP9 inter frame");
  assert.ok(!vp9Key(new Uint8Array([0x88])), "VP9 show_existing_frame");
  assert.ok(vp8Key(new Uint8Array([0x50, 0x01])) && !vp8Key(new Uint8Array([0x51])));
});
