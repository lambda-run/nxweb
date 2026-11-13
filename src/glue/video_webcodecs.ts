// nn::codec's video decoder on WebCodecs' VideoDecoder (HleEnv.video; src/hle/codec_video.ts has the protocol).
// AV1, VP9 and VP8; H.264 is not taken (the take-overs then give video black). A decoder is configured at the
// stream's first key frame (AV1: the codec string from its sequence header) with software decoding preferred, so
// pictures are planar in memory; each packet is one chunk whose timestamp is its submission number, and each
// picture completes its packet. Packets before a key frame, and after a decoder error until the next one, give no
// picture. Completions keep submission order (a picture's planes are copied asynchronously). Works in a window and
// in a Worker.
import { VCODEC, VCODEC_NAME, av1Inspect, vp8Key, vp9Key, type Av1Seq, type VideoBackend, type VideoPicture, type VideoSink } from "./video_host.ts";
import { unshared } from "./wasm_shared.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Dec {
  id: number; codec: number; w: number; h: number; gen: number;
  d: any; configured: string; seq: Av1Seq | null;
  pending: bigint[];             // submission numbers given to the decoder, oldest first
  chain: Promise<void>;          // completions in order
  pictures: number; reds: number; logged: boolean;
}
const MATRIX: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, "bt2020-ncl": 9, rgb: 0 };

export class WebCodecsVideo implements VideoBackend {
  private decs = new Map<number, Dec>();
  errors = 0;
  private sink: VideoSink;
  constructor(sink: VideoSink) { this.sink = sink; }
  static available(): boolean { return typeof (globalThis as any).VideoDecoder === "function" && typeof (globalThis as any).EncodedVideoChunk === "function"; }

  open(dec: number, codec: number, w: number, h: number): string {
    if (!WebCodecsVideo.available() || (codec !== VCODEC.AV1 && codec !== VCODEC.VP9 && codec !== VCODEC.VP8)) return "";
    this.close(dec);
    this.decs.set(dec, { id: dec, codec, w, h, gen: 0, d: null, configured: "", seq: null, pending: [], chain: Promise.resolve(), pictures: 0, reds: 0, logged: false });
    return "WebCodecs VideoDecoder";
  }
  private red(st: Dec, line: string): void { this.errors++; if (st.reds++ < 4) this.sink.log(`[RED] nn::codec ${VCODEC_NAME[st.codec]} decoder ${st.id}: ${line}`); }
  // Every packet given to the decoder up to seq (not included) gave no picture
  private noneBefore(st: Dec, gen: number, seq: bigint | null): void {
    while (st.pending.length && (seq === null || st.pending[0] < seq)) {
      const s = st.pending.shift()!;
      st.chain = st.chain.then(() => { if (st.gen === gen) this.sink.picture(st.id, gen, s, null); });
    }
  }
  private make(st: Dec, codec: string): boolean {
    const gen = st.gen;
    try {
      if (st.d && st.d.state !== "closed") st.d.close();
      st.d = new (globalThis as any).VideoDecoder({
        output: (frame: any) => this.output(st, gen, frame),
        error: (e: unknown) => {
          if (st.gen !== gen) return;
          this.red(st, `the browser's decoder failed (${e}): no pictures until the next key frame`);
          st.configured = ""; st.d = null;
          this.noneBefore(st, gen, null);
        },
      });
      st.d.configure({ codec, codedWidth: st.w || undefined, codedHeight: st.h || undefined, hardwareAcceleration: (globalThis as any).NXVDEC ?? "prefer-software",   // (em/: ?vdec=hardware asks for the hardware decoder, to compare)
        optimizeForLatency: (globalThis as any).NXVLATENCY ?? true });   // (em/: ?vpipe=1 turns it off: its packets are queued ahead)
      st.configured = codec;
      if (!st.logged) { st.logged = true; this.sink.log(`[codec] ${VCODEC_NAME[st.codec]} decoder ${st.id}: WebCodecs ${codec}`); }
      return true;
    } catch (e) {
      this.red(st, `the browser cannot decode ${codec} (${e})`);
      st.configured = ""; st.d = null;
      return false;
    }
  }
  // timing, logged every 60 pictures: from the packet to the decoder's frame, the copy out of it, and the pictures a second over the window
  private sent = new Map<bigint, number>(); private tDec = 0; private tCopy = 0; private tN = 0; private tAt = 0;
  private output(st: Dec, gen: number, frame: any): void {
    if (st.gen !== gen) { frame.close(); return; }
    const seq = BigInt(Math.round(frame.timestamp));
    this.noneBefore(st, gen, seq);
    if (st.pending[0] === seq) st.pending.shift(); else { frame.close(); return; }
    const t0 = performance.now(), ts = this.sent.get(seq); this.sent.delete(seq); if (this.sent.size > 256) this.sent.clear();
    const copied = this.planes(frame).catch((e: unknown) => { this.red(st, `a picture could not be read (${e}): none`); return null; });
    st.chain = st.chain.then(async () => {
      const pic = await copied;
      frame.close();
      if (st.gen !== gen) return;
      if (pic) st.pictures++;
      const t1 = performance.now(); this.tDec += ts === undefined ? 0 : t0 - ts; this.tCopy += t1 - t0;
      if (++this.tN === 60) { this.sink.log(`[codec] ${VCODEC_NAME[st.codec]} timing over 60 pictures: ${(60000 / (t1 - this.tAt)).toFixed(1)} pictures/s, packet to frame ${(this.tDec / 60).toFixed(1)} ms, copy ${(this.tCopy / 60).toFixed(1)} ms, format ${frame.format ?? "closed"}`); this.tN = 0; this.tDec = 0; this.tCopy = 0; this.tAt = t1; }
      this.sink.picture(st.id, gen, seq, pic);
    });
  }
  // The frame's visible rectangle as 8-bit I420 (I420 / I420A / NV12 / 10- and 12-bit planar shifted down)
  private async planes(frame: any): Promise<VideoPicture | null> {
    const fmt: string | null = frame.format;
    const rect = frame.visibleRect, w: number = rect?.width ?? frame.displayWidth, h: number = rect?.height ?? frame.displayHeight;
    const cs = frame.colorSpace ?? {};
    const matrix = cs.matrix ? (MATRIX[cs.matrix] ?? 2) : 2, fullRange = cs.fullRange === true;
    const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
    if (!fmt) throw new Error("the frame has no CPU-readable format");
    const buf = new Uint8Array(frame.allocationSize());
    const layout: { offset: number; stride: number }[] = await frame.copyTo(buf);
    if (fmt === "I420" || fmt === "I420A") {
      return { w, h, y: buf.subarray(layout[0].offset), u: buf.subarray(layout[1].offset), v: buf.subarray(layout[2].offset), yStride: layout[0].stride, uvStride: layout[1].stride, matrix, fullRange };
    }
    if (fmt === "NV12") {
      const u = new Uint8Array(cw * ch), v = new Uint8Array(cw * ch), uv = buf.subarray(layout[1].offset), s = layout[1].stride;
      for (let yy = 0; yy < ch; yy++) for (let x = 0; x < cw; x++) { u[yy * cw + x] = uv[yy * s + 2 * x]; v[yy * cw + x] = uv[yy * s + 2 * x + 1]; }
      return { w, h, y: buf.subarray(layout[0].offset), u, v, yStride: layout[0].stride, uvStride: cw, matrix, fullRange };
    }
    const deep = /^I420A?P(10|12)$/.exec(fmt);
    if (deep) {
      const shift = deep[1] === "10" ? 2 : 4;
      const plane = (k: number, pw: number, ph: number) => {
        const o = new Uint8Array(pw * ph), dv = new DataView(buf.buffer, buf.byteOffset + layout[k].offset), s = layout[k].stride;
        for (let yy = 0; yy < ph; yy++) for (let x = 0; x < pw; x++) o[yy * pw + x] = Math.min(255, dv.getUint16(yy * s + 2 * x, true) >> shift);
        return o;
      };
      return { w, h, y: plane(0, w, h), u: plane(1, cw, ch), v: plane(2, cw, ch), yStride: w, uvStride: cw, matrix, fullRange };
    }
    throw new Error(`frame format ${fmt}`);
  }

  decode(dec: number, gen: number, seq: bigint, packet: Uint8Array | null, eos: boolean): number {
    const st = this.decs.get(dec);
    if (!st) return 0;
    if (st.gen !== gen) { st.gen = gen; st.pending = []; }
    if (!packet || !packet.length) {
      if (eos && st.d && st.configured) {
        const d = st.d;
        d.flush().then(() => { if (st.gen === gen && st.d === d) this.noneBefore(st, gen, null); }, () => { /* reset or closed */ });
      }
      return 2;
    }
    let key: boolean, codec = st.configured;
    if (st.codec === VCODEC.AV1) {
      const r = av1Inspect(packet, st.seq);
      if (r.seq) st.seq = r.seq;
      key = r.key;
      if (key && st.seq) codec = st.seq.codec;
    } else {
      key = st.codec === VCODEC.VP9 ? vp9Key(packet) : vp8Key(packet);
      if (key) codec = st.codec === VCODEC.VP9 ? "vp09.00.10.08" : "vp8";
    }
    if (!st.configured || (key && codec !== st.configured)) {
      if (!key || !codec) return 2;               // waiting for a key frame (with its sequence header)
      if (!this.make(st, codec)) return 2;
    }
    try {
      st.d.decode(new (globalThis as any).EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: Number(seq), data: unshared(packet) }));   // copies the packet (unshared: the packet lies in the guest's memory, which may be a shared one)
    } catch (e) {
      this.red(st, `a packet was refused (${e}): no picture until the next key frame`);
      st.configured = "";
      return 2;
    }
    st.pending.push(seq); this.sent.set(seq, performance.now());
    if (eos) {
      const d = st.d;
      d.flush().then(() => { if (st.gen === gen && st.d === d) this.noneBefore(st, gen, null); }, () => { /* reset or closed */ });
    }
    return 1;
  }
  reset(dec: number, gen: number): void {
    const st = this.decs.get(dec);
    if (!st) return;
    st.gen = gen; st.pending = [];
    if (st.d && st.d.state === "configured") { try { st.d.reset(); } catch { /* closed */ } }
    st.configured = "";
  }
  close(dec: number): void {
    const st = this.decs.get(dec);
    if (!st) return;
    st.gen = -1; st.pending = [];
    if (st.d && st.d.state !== "closed") { try { st.d.close(); } catch { /* closed */ } }
    this.decs.delete(dec);
  }
}
