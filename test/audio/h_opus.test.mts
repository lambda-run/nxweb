// nn::codec's hardware Opus decoders: the decoder manager's request machine and queues with three decoders behind it
// (a stand-in for the SDK's software decoder, a synchronous embedder decoder, an asynchronous one), and the
// synchronous interfaces' forwards to the SDK.
import assert from "node:assert/strict";
import { test, Au, R, OPUS_PENDING, type AuOptions } from "./harness.mts";
import type { OpusBackend } from "../../src/glue/audio_host.ts";

const N = {
  workSize: "_ZN2nn5codec28GetOpusDecoderWorkBufferSizeEii", init: "_ZN2nn5codec21InitializeOpusDecoderEPNS0_15OpusDecoderTypeEiiPvm",
  fini: "_ZN2nn5codec19FinalizeOpusDecoderEPNS0_15OpusDecoderTypeE", reset: "_ZN2nn5codec16ResetOpusDecoderEPNS0_15OpusDecoderTypeE",
  decode: "_ZN2nn5codec21DecodeOpusInterleavedEPNS0_15OpusDecoderTypeEPmPiPsmPKvm", rate: "_ZN2nn5codec24GetOpusDecoderSampleRateEPKNS0_15OpusDecoderTypeE",
  ch: "_ZN2nn5codec26GetOpusDecoderChannelCountEPKNS0_15OpusDecoderTypeE", ctor: "_ZN2nn5codec11OpusDecoderC1Ev",
};
// A packet as the game enqueues it: Nintendo's header (big-endian size and final range), then the "Opus" bytes.
// The stand-in codec: byte 0 of the payload is the value of every sample (x 100), byte 1 the frame's length in 2.5 ms
function packet(a: Au, value: number, len = 40, units = 8): { p: number; n: number } {
  const p = a.alloc(8 + len);
  a.dv.setUint32(p, len, false); a.dv.setUint32(p + 4, 0xDEADBEEF, false);
  a.u8[p + 8] = value; a.u8[p + 9] = units;
  return { p, n: 8 + len };
}
// The SDK's software OpusDecoder, as far as the host uses it. Its state block gets a mark so that the test sees
// that the host passes its own state and not the game's object.
function sdk(log: string[]): NonNullable<AuOptions["sdk"]> {
  return {
    [N.workSize]: x => 0x1000n + x[0] / 1000n + x[1],
    [N.init]: (x, a) => { a.dv.setUint32(Number(x[0]), 0x4F505553, true); a.dv.setInt32(Number(x[0]) + 4, Number(x[1]), true); a.dv.setInt32(Number(x[0]) + 8, Number(x[2]), true); log.push(`init ${x[1]} ${x[2]} work ${x[4].toString(16)}`); return 0; },
    [N.fini]: (x, a) => { assert.equal(a.dv.getUint32(Number(x[0]), true), 0x4F505553); log.push("fini"); return 0; },
    [N.reset]: (x, a) => { assert.equal(a.dv.getUint32(Number(x[0]), true), 0x4F505553); log.push("reset"); return 0; },
    [N.rate]: (x, a) => a.dv.getInt32(Number(x[0]) + 4, true), [N.ch]: (x, a) => a.dv.getInt32(Number(x[0]) + 8, true),
    [N.ctor]: x => { log.push(`ctor ${x[0].toString(16)}`); return 0; },
    [N.decode]: (x, a) => {
      const [soft, used, samples, out, cap, inp, size] = [...x].map(Number);
      assert.equal(a.dv.getUint32(soft, true), 0x4F505553);
      const ch = a.dv.getInt32(soft + 8, true), value = a.u8[inp + 8], n = a.u8[inp + 9] * 120;
      assert.equal(a.dv.getUint32(inp, false) + 8, size);
      if (value === 0xEE) return 0x1234;                 // a packet the decoder refuses
      assert.ok(n * ch * 2 <= cap);
      for (let i = 0; i < n * ch; i++) a.dv.setInt16(out + 2 * i, value * 100 + (i % ch), true);
      a.dv.setBigUint64(used, BigInt(size), true); a.dv.setInt32(samples, n, true);
      return 0;
    },
  };
}
interface Mgr { gm: number; ev: number }
function manager(a: Au, decoders = 72, io = 160): Mgr {
  const gm = a.alloc(0x18), ev = a.alloc(64);
  assert.equal(a.c("codec_HwOpusMgrWorkSize", 48000, 2, 20_000_000, decoders, io), 0x1000n);
  assert.equal(a.c("codec_HwOpusMgrInit", gm, ev, 48000, 2, 20_000_000, decoders, io, 0, 0x1000), 0n);
  assert.notEqual(a.dv.getBigUint64(gm, true), 0n);     // the game tells an initialized manager by its first word
  return { gm, ev };
}
const decoder = (a: Au, m: Mgr, ch = 2): number => { const gd = a.alloc(0x30); a.u8.fill(0x5A, gd, gd + 0x30); assert.equal(a.c("codec_HwOpusMgrDecInit", gd, 48000, ch, 20_000_000, m.gm), 0n); return gd; };
const counts = (a: Au, gd: number) => [a.c("codec_HwOpusWaiting", gd), a.c("codec_HwOpusExecuting", gd), a.c("codec_HwOpusCompleted", gd)].map(Number);
function dequeue(a: Au, gd: number, cap = 11520): { r: bigint; samples: number; pcm: Int16Array } {
  const out = a.alloc(cap || 16), s = a.alloc(8);
  a.dv.setInt32(s, -7, true);
  const r = a.c("codec_HwOpusDequeue", gd, s, out, cap), samples = a.dv.getInt32(s, true);
  return { r, samples, pcm: new Int16Array(a.x.memory.buffer.slice(out, out + Math.max(samples, 0) * 4)) };
}
function enqueue(a: Au, gd: number, value: number, len = 40, units = 8): bigint {
  const k = packet(a, value, len, units), used = a.alloc(8);
  a.dv.setBigUint64(used, 77n, true);
  const r = a.c("codec_HwOpusEnqueue", gd, used, k.p, k.n);
  assert.equal(a.dv.getBigUint64(used, true), r === 0n ? BigInt(k.n) : 0n);   // all of it consumed, or nothing
  return r;
}

test("opus manager (the SDK's software decoder behind it, as nxnative): enqueue takes an I/O buffer, Execute decodes every waiting packet and signals the event once, frames come out per decoder in order, the buffer returns on dequeue", () => {
  const log: string[] = [];
  const a = new Au({ sdk: sdk(log) });
  const m = manager(a, 3, 6);
  const ev = a.events.at(-1)!;
  assert.deepEqual([ev.ptr, ev.autoClear], [m.ev, true]);
  const d1 = decoder(a, m), d2 = decoder(a, m, 1);
  assert.deepEqual(log, ["init 48000 2 work 1032", "init 48000 1 work 1031"]);
  assert.ok(a.u8.subarray(d1, d1 + 0x30).every(v => v === 0x5A));   // the game's decoder object is not written
  assert.deepEqual([a.c("codec_HwOpusRate", d1), a.c("codec_HwOpusCh", d1), a.c("codec_HwOpusCh", d2)], [48000n, 2n, 1n]);
  assert.equal(a.c("codec_HwOpusMgrFreeIo", m.gm), 6n);
  for (const v of [1, 2, 3]) assert.equal(enqueue(a, d1, v), 0n);
  assert.equal(enqueue(a, d2, 9, 100, 24), 0n);         // a 60 ms frame
  assert.equal(a.c("codec_HwOpusMgrFreeIo", m.gm), 2n);
  assert.deepEqual([counts(a, d1), counts(a, d2)], [[3, 0, 0], [1, 0, 0]]);
  assert.equal(dequeue(a, d1).r, R.BUSY);               // nothing completed yet
  assert.equal(ev.signals, 0);
  assert.equal(a.c("codec_HwOpusExecute", m.gm), 0n);
  assert.equal(ev.signals, 1);
  assert.deepEqual([counts(a, d1), counts(a, d2)], [[0, 0, 3], [0, 0, 1]]);   // never "executing": Execute decodes on the caller's thread
  assert.equal(a.c("codec_HwOpusMgrFreeIo", m.gm), 2n); // a completed request still holds its buffer
  for (const v of [1, 2, 3]) {
    const f = dequeue(a, d1);
    assert.deepEqual([f.r, f.samples], [0n, 960]);
    assert.ok(f.pcm.every((s, i) => s === v * 100 + (i % 2)), `frame ${v}`);
  }
  const f9 = dequeue(a, d2, 2880 * 2);
  assert.deepEqual([f9.r, f9.samples], [0n, 2880]);
  assert.equal(dequeue(a, d1).r, R.BUSY); assert.equal(dequeue(a, d1).samples, 0);
  assert.equal(a.c("codec_HwOpusMgrFreeIo", m.gm), 6n);
  // an Execute with nothing waiting signals nothing
  a.c("codec_HwOpusExecute", m.gm); assert.equal(ev.signals, 1);
  assert.equal(a.red.length, 0); assert.equal(a.x.kit_refused_total(), 0);
});

test("opus manager: no free I/O buffer, a packet too short or too long, a buffer too small for the frame, a packet the decoder refuses (20 ms of silence, the stream stays in step)", () => {
  const a = new Au({ sdk: sdk([]) });
  const m = manager(a, 1, 2), d = decoder(a, m);
  assert.equal(enqueue(a, d, 1), 0n); assert.equal(enqueue(a, d, 0xEE), 0n);
  assert.equal(enqueue(a, d, 3), R.BUSY);               // both buffers are taken: the game checks the count first
  assert.equal(a.red.length, 0);
  const k = packet(a, 1);
  assert.equal(a.c("codec_HwOpusEnqueue", d, 0, k.p, 7), R.BUSY); assert.match(a.red.at(-1)!, /Opus packet of 7 bytes enqueued/);
  assert.equal(a.c("codec_HwOpusEnqueue", d, 0, k.p, 0x1801), R.BUSY); assert.match(a.red.at(-1)!, /Opus packet of 6145 bytes enqueued/);
  a.c("codec_HwOpusExecute", m.gm);
  assert.match(a.red.at(-1)!, /Opus decode of a 48-byte packet failed \(0x1234\), silence instead/);
  assert.deepEqual(counts(a, d), [0, 0, 2]);
  const small = dequeue(a, d, 100);
  assert.equal(small.r, R.BUSY); assert.match(a.red.at(-1)!, /a 3840-byte Opus frame for a 100-byte buffer/);
  assert.deepEqual(counts(a, d), [0, 0, 2]);            // it stays
  assert.equal(dequeue(a, d).samples, 960);
  const silent = dequeue(a, d);
  assert.deepEqual([silent.r, silent.samples], [0n, 960]); assert.ok(silent.pcm.every(s => s === 0));
  // only the first four refused packets are reported
  for (let i = 0; i < 6; i++) { enqueue(a, d, 0xEE); a.c("codec_HwOpusExecute", m.gm); dequeue(a, d); }
  assert.equal(a.red.filter(l => l.includes("silence instead")).length, 4);
});

test("opus manager: Reset and Finalize of a decoder drop its requests and return their buffers; a finalized manager leaves its decoders answering 'not now'; everything is freed", () => {
  const log: string[] = [];
  const a = new Au({ sdk: sdk(log) });
  const m = manager(a, 4, 8), d1 = decoder(a, m), d2 = decoder(a, m);
  const ev = a.events.at(-1)!;
  for (const v of [1, 2]) enqueue(a, d1, v);
  a.c("codec_HwOpusExecute", m.gm);                      // d1: two completed
  enqueue(a, d1, 3); enqueue(a, d2, 4);                  // d1: one waiting, d2: one waiting
  assert.equal(a.c("codec_HwOpusMgrFreeIo", m.gm), 4n);
  a.c("codec_HwOpusReset", d1);                          // Completed -Cancel-> Free, Waiting -Cancel-> Free
  assert.deepEqual(counts(a, d1), [0, 0, 0]); assert.equal(a.c("codec_HwOpusMgrFreeIo", m.gm), 7n);
  assert.equal(log.at(-1), "reset");
  assert.equal(dequeue(a, d1).r, R.BUSY);
  enqueue(a, d1, 5); a.c("codec_HwOpusExecute", m.gm);
  assert.equal(dequeue(a, d1).pcm[0], 500);              // the decoder works on after a reset
  a.c("codec_HwOpusFini", d2);
  assert.equal(log.at(-1), "fini"); assert.equal(a.c("codec_HwOpusMgrFreeIo", m.gm), 8n);
  const reds = a.red.length;
  assert.equal(enqueue(a, d2, 1), R.BUSY);               // not a decoder any more: a red line
  assert.equal(a.red.length, reds + 1);
  // the manager goes first (the game destroys its event afterwards), then the decoder
  enqueue(a, d1, 6);
  a.c("codec_HwOpusMgrFini", m.gm);
  assert.equal(a.dv.getBigUint64(m.gm, true), 0n); assert.equal(ev.released, true);
  assert.equal(enqueue(a, d1, 7), R.BUSY); assert.equal(dequeue(a, d1).r, R.BUSY); assert.deepEqual(counts(a, d1), [0, 0, 0]);
  a.c("codec_HwOpusMgrFini", m.gm);                      // twice: nothing
  a.c("codec_HwOpusFini", d1);
  assert.equal(a.x.audio_arena_used(), 0);
  assert.equal(a.x.kit_refused_total(), 0);
});

// An embedder decoder that answers later (WebCodecs' AudioDecoder does): it keeps what it was given
class Later implements OpusBackend {
  a!: Au; log: string[] = [];
  pending: { dec: number; req: number; value: number; frames: number; ch: number }[] = [];
  chans = new Map<number, number>();
  open(dec: number, rate: number, ch: number): number { this.log.push(`open ${dec} ${rate} ${ch}`); this.chans.set(dec, ch); return 0; }
  decode(dec: number, req: number, packet: Uint8Array): number { this.pending.push({ dec, req, value: packet[0], frames: packet[1] * 120, ch: this.chans.get(dec)! }); return OPUS_PENDING; }
  reset(dec: number): void { this.log.push(`reset ${dec}`); }
  close(dec: number): void { this.log.push(`close ${dec}`); }
  // The decoder is done with its oldest request
  answer(): number {
    const p = this.pending.shift()!, out = this.a.x.audio_opus_out(p.req);
    if (out) for (let i = 0; i < p.frames * p.ch; i++) this.a.dv.setInt16(out + 2 * i, p.value * 100, true);
    this.a.x.audio_opus_complete(p.req, p.value === 0xEE ? 0 : p.frames);
    return out;
  }
}

test("opus manager with an asynchronous decoder (the shape of WebCodecs): requests are Executing until the decoder answers; each answer completes one and signals the event; without an SDK decoder the embedder's is chosen", () => {
  const later = new Later();
  const a = new Au({ opus: later }); later.a = a;        // no SDK at all: backend 0 picks the embedder's decoder
  const m = manager(a, 2, 4), d = decoder(a, m);
  const ev = a.events.at(-1)!;
  assert.deepEqual(later.log, ["open 0 48000 2"]);
  assert.deepEqual([a.c("codec_HwOpusRate", d), a.c("codec_HwOpusCh", d)], [48000n, 2n]);
  for (const v of [1, 2, 3]) enqueue(a, d, v);
  a.c("codec_HwOpusExecute", m.gm);
  assert.deepEqual(counts(a, d), [0, 3, 0]); assert.equal(ev.signals, 0);
  assert.equal(later.pending.length, 3);
  assert.equal(dequeue(a, d).r, R.BUSY);
  assert.notEqual(later.answer(), 0);
  assert.deepEqual(counts(a, d), [0, 2, 1]); assert.equal(ev.signals, 1);
  enqueue(a, d, 4);                                      // a packet enqueued while others execute waits for the next Execute
  assert.deepEqual(counts(a, d), [1, 2, 1]);
  later.answer(); later.answer();
  assert.deepEqual(counts(a, d), [1, 0, 3]); assert.equal(ev.signals, 3);
  for (const v of [1, 2, 3]) { const f = dequeue(a, d); assert.deepEqual([f.r, f.samples, f.pcm[0], f.pcm[1919]], [0n, 960, v * 100, v * 100]); }
  assert.equal(dequeue(a, d).r, R.BUSY);                 // the fourth is still waiting
  a.c("codec_HwOpusExecute", m.gm); later.answer();
  assert.equal(dequeue(a, d).pcm[0], 400);
  assert.equal(a.c("codec_HwOpusMgrFreeIo", m.gm), 4n);
  assert.equal(a.red.length, 0); assert.equal(a.x.kit_refused_total(), 0);
});

test("opus manager with an asynchronous decoder: a reset while requests execute abandons them: their I/O buffers are free at once, their slots only when the decoder answers, and the late answers complete nothing; answers for a finalized manager are dropped", () => {
  const later = new Later();
  const a = new Au({ opus: later }); later.a = a;
  a.x.audio_opus_backend(2);
  const m = manager(a, 2, 4), d = decoder(a, m);
  const ev = a.events.at(-1)!;
  const slots = () => a.x.audio_opus_stat(0, 2), abandoned = () => a.x.audio_opus_stat(0, 1);
  const total = slots();
  assert.equal(total, 4 + 16);
  for (const v of [1, 2, 3]) enqueue(a, d, v);
  a.c("codec_HwOpusExecute", m.gm);
  later.answer();                                        // one completed, two executing
  enqueue(a, d, 4);                                      // and one waiting
  a.c("codec_HwOpusReset", d);
  assert.deepEqual(later.log.at(-1), "reset 0");
  assert.deepEqual(counts(a, d), [0, 0, 0]);
  assert.equal(a.c("codec_HwOpusMgrFreeIo", m.gm), 4n);
  assert.deepEqual([abandoned(), slots()], [2, total - 2]);
  // the game goes on at once with new packets while the decoder still holds the old ones
  enqueue(a, d, 7); a.c("codec_HwOpusExecute", m.gm);
  const sig = ev.signals;
  assert.notEqual(later.answer(), 0); later.answer();    // the two abandoned ones: slots back, nothing completed, no signal
  assert.deepEqual([abandoned(), slots(), counts(a, d), ev.signals], [0, total - 1, [0, 1, 0], sig]);
  later.answer();
  assert.deepEqual(counts(a, d), [0, 0, 1]); assert.equal(ev.signals, sig + 1);
  assert.equal(dequeue(a, d).pcm[0], 700);
  // a decoder finalized, then its manager, with a request still in the decoder: the answer finds nothing to write to
  enqueue(a, d, 8); a.c("codec_HwOpusExecute", m.gm);
  a.c("codec_HwOpusFini", d);
  assert.equal(later.log.at(-1), "close 0");
  a.c("codec_HwOpusMgrFini", m.gm);
  assert.equal(later.answer(), 0);
  assert.equal(a.x.audio_opus_out(0xFFFFFFFF), 0); a.x.audio_opus_complete(0x12345678, 960);
  // a new manager in the same slot is another generation: a stale handle of the old one does not reach it
  const m2 = manager(a, 1, 1), d2 = decoder(a, m2);
  enqueue(a, d2, 1); a.c("codec_HwOpusExecute", m2.gm);
  const stale = { ...later.pending[0], req: (later.pending[0].req & 0x00FFFFFF) | ((((later.pending[0].req >>> 24) - 1) & 0xFF) << 24) };
  assert.equal(a.x.audio_opus_out(stale.req), 0);
  later.answer();
  assert.deepEqual(counts(a, d2), [0, 0, 1]);
  assert.equal(a.x.kit_refused_total(), 0);
});

test("opus manager with a synchronous embedder decoder (backend 2 with an SDK present): frames complete inside Execute", () => {
  const sync: OpusBackend & { a?: Au } = {
    open: () => 0, reset: () => {}, close: () => {},
    decode(dec, req, packet, out, cap) { const dv = sync.a!.dv; assert.ok(cap >= 3840); for (let i = 0; i < 1920; i++) dv.setInt16(out + 2 * i, packet[0], true); return packet[0] === 0xEE ? -5 : 960; },
  };
  const a = new Au({ opus: sync, sdk: sdk([]) }); sync.a = a;
  a.x.audio_opus_backend(2);
  const m = manager(a), d = decoder(a, m);
  enqueue(a, d, 42); enqueue(a, d, 0xEE);
  a.c("codec_HwOpusExecute", m.gm);
  assert.deepEqual(counts(a, d), [0, 0, 2]);
  assert.equal(dequeue(a, d).pcm[5], 42);
  assert.ok(dequeue(a, d).pcm.every(s => s === 0));
  assert.equal(a.sdkCalls.length, 0);
  // a decoder the embedder cannot open: the Result comes back
  sync.open = () => 0x777;
  const gd = a.alloc(0x30);
  assert.equal(a.c("codec_HwOpusMgrDecInit", gd, 48000, 2, 0, m.gm), 0x777n);
});

test("opus, the synchronous interfaces: each hardware call is the SDK's software decoder with a host-held state per game object (single-stream and multi-stream, classes and C interface); without the SDK's function, a red line once and a failure", () => {
  const calls: string[] = [];
  const names: Record<string, string> = {
    ...N,
    msCtor: "_ZN2nn5codec22OpusMultiStreamDecoderC1Ev", msWorkSize: "_ZN2nn5codec39GetOpusMultiStreamDecoderWorkBufferSizeEiiii",
    msInit: "_ZN2nn5codec32InitializeOpusMultiStreamDecoderEPNS0_26OpusMultiStreamDecoderTypeEiiiiPKhPvm", msFini: "_ZN2nn5codec30FinalizeOpusMultiStreamDecoderEPNS0_26OpusMultiStreamDecoderTypeE",
    msRate: "_ZN2nn5codec35GetOpusMultiStreamDecoderSampleRateEPKNS0_26OpusMultiStreamDecoderTypeE", msCh: "_ZN2nn5codec37GetOpusMultiStreamDecoderChannelCountEPKNS0_26OpusMultiStreamDecoderTypeE",
    msTotal: "_ZN2nn5codec41GetOpusMultiStreamDecoderTotalStreamCountEPKNS0_26OpusMultiStreamDecoderTypeE", msStereo: "_ZN2nn5codec42GetOpusMultiStreamDecoderStereoStreamCountEPKNS0_26OpusMultiStreamDecoderTypeE",
    msReset: "_ZN2nn5codec27ResetOpusMultiStreamDecoderEPNS0_26OpusMultiStreamDecoderTypeE", msDecode: "_ZN2nn5codec32DecodeOpusMultiStreamInterleavedEPNS0_26OpusMultiStreamDecoderTypeEPmPiPsmPKvm",
  };
  const fake: NonNullable<AuOptions["sdk"]> = {};
  for (const [k, n] of Object.entries(names)) fake[n] = x => { calls.push(`${k}(${[...x].map(v => v.toString(16)).join(",")})`); return k.endsWith("orkSize") ? 0x2000 : k.endsWith("ate") ? 48000 : k.toLowerCase().endsWith("ch") ? 6 : k === "msTotal" ? 4 : k === "msStereo" ? 2 : 0; };
  const a = new Au({ sdk: fake });
  const last = () => calls.at(-1)!;
  const hw = a.alloc(0x40), work = a.alloc(0x2000), out = a.alloc(64), inp = a.alloc(64), u = a.alloc(8), sm = a.alloc(8);
  const H = (n: number) => n.toString(16);
  // the classes: the software decoder is constructed in place
  a.c("codec_HwOpusCtor", hw, 1); assert.equal(last(), `ctor(${H(hw)},0,0,0,0,0,0,0)`);
  a.c("codec_HwOpusMsCtor", hw, 1); assert.equal(last(), `msCtor(${H(hw)},0,0,0,0,0,0,0)`);
  // the C interface, single stream
  assert.equal(a.c("codec_HwOpusWorkSize", 48000, 2, 1), 0x2000n); assert.equal(last(), "workSize(bb80,2,0,0,0,0,0,0)");
  assert.equal(a.c("codec_HwOpusWorkSize2", 24000, 1), 0x2000n); assert.equal(last(), "workSize(5dc0,1,0,0,0,0,0,0)");
  assert.equal(a.c("codec_HwOpusInit", hw, 48000, 2, work, 0x2000, 1), 0n);
  const soft = BigInt("0x" + last().match(/^init\((\w+),/)![1]);
  assert.notEqual(soft, BigInt(hw)); assert.equal(last(), `init(${soft.toString(16)},bb80,2,${H(work)},2000,0,0,0)`);
  assert.equal(a.c("codec_HwOpusRate", hw), 48000n); assert.equal(last(), `rate(${soft.toString(16)},0,0,0,0,0,0,0)`);
  assert.equal(a.c("codec_HwOpusCh", hw), 6n);
  a.c("codec_HwOpusReset", hw); assert.equal(last(), `reset(${soft.toString(16)},0,0,0,0,0,0,0)`);
  assert.equal(a.c("codec_HwOpusDecode", hw, u, sm, out, 64, inp, 48), 0n);
  assert.equal(last(), `decode(${soft.toString(16)},${H(u)},${H(sm)},${H(out)},40,${H(inp)},30,0)`);
  a.c("codec_HwOpusFini", hw); assert.equal(last(), `fini(${soft.toString(16)},0,0,0,0,0,0,0)`);
  assert.equal(a.x.audio_arena_used(), 0);
  a.c("codec_HwOpusFini", hw); assert.equal(calls.filter(c => c.startsWith("fini")).length, 1);   // twice: nothing
  // multi-stream
  const map = a.alloc(8);
  assert.equal(a.c("codec_HwOpusMsWorkSize", 48000, 6, 4, 2), 0x2000n); assert.equal(last(), "msWorkSize(bb80,6,4,2,0,0,0,0)");
  assert.equal(a.c("codec_HwOpusMsWorkSize5", 48000, 6, 4, 2, 9), 0x2000n); assert.equal(last(), "msWorkSize(bb80,6,4,2,0,0,0,0)");
  assert.equal(a.c("codec_HwOpusMsInit", hw, 48000, 6, 4, 2, map, work, 0x2000), 0n);
  const ms = last().match(/^msInit\((\w+),/)![1];
  assert.equal(last(), `msInit(${ms},bb80,6,4,2,${H(map)},${H(work)},2000)`);
  assert.deepEqual(["codec_HwOpusMsRate", "codec_HwOpusMsCh", "codec_HwOpusMsTotal", "codec_HwOpusMsStereo"].map(f => a.c(f, hw)), [48000n, 6n, 4n, 2n]);
  a.c("codec_HwOpusMsReset", hw); assert.equal(last(), `msReset(${ms},0,0,0,0,0,0,0)`);
  a.c("codec_HwOpusMsDecode", hw, u, sm, out, 64, inp, 48); assert.equal(last(), `msDecode(${ms},${H(u)},${H(sm)},${H(out)},40,${H(inp)},30,0)`);
  assert.equal(a.c("codec_HwOpusMsTime", hw), 0n);      // no hardware decode time
  a.c("codec_HwOpusMsFini", hw); assert.equal(last(), `msFini(${ms},0,0,0,0,0,0,0)`);
  assert.equal(a.x.audio_arena_used(), 0); assert.equal(a.red.length, 0);
  // a decoder object the host never initialized: a red line, a harmless answer
  assert.equal(a.c("codec_HwOpusDecode", a.alloc(64), u, sm, out, 64, inp, 48), R.FAIL);
  assert.match(a.red.at(-1)!, /Opus decoder 0x[0-9a-f]+ was not initialized by the host/);
  // an SDK without the software decoder
  const b = new Au();
  const hw2 = b.alloc(0x40);
  assert.equal(b.c("codec_HwOpusWorkSize", 48000, 2, 0), 0n); assert.equal(b.c("codec_HwOpusWorkSize2", 48000, 2), 0n);
  assert.equal(b.c("codec_HwOpusInit", hw2, 48000, 2, 0, 0, 0), R.FAIL); assert.equal(b.c("codec_HwOpusMsInit", hw2, 48000, 2, 1, 1, 0, 0, 0), R.FAIL);
  b.c("codec_HwOpusCtor", hw2, 0);
  assert.deepEqual(b.red.map(l => l.replace(/^.*lacks (\S+):.*$/, "$1")), [N.workSize, N.init, names.msInit, N.ctor]);
});
