// An Opus decoder for the hardware Opus decoder manager (src/audio/opus.ts) on WebCodecs' AudioDecoder. It is
// asynchronous: decode() only hands the packet over, and each frame the browser's decoder puts out completes the
// oldest request of its decoder (audio_opus_out, audio_opus_complete), which signals the manager's event.
// Works in a window and in a Worker; needs a secure context. See src/audio/README.md, "Opus", for when this is used
// and when the SDK's own software decoder is.
import { AudioHost, OPUS_PENDING, type OpusBackend } from "./audio_host.ts";
import { unshared } from "./wasm_shared.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Dec { d: any; rate: number; ch: number; pending: number[]; ts: number; gen: number }

export class WebCodecsOpus implements OpusBackend {
  private decs = new Map<number, Dec>();
  errors = 0;
  private host: AudioHost;
  constructor(host: AudioHost) { this.host = host; }
  static available(): boolean { return typeof (globalThis as any).AudioDecoder === "function"; }

  private make(dec: number, st: Dec): void {
    const gen = ++st.gen;
    st.d = new (globalThis as any).AudioDecoder({
      output: (frame: any) => { if (st.gen === gen) this.frame(st, frame); else frame.close(); },
      error: (e: unknown) => { if (st.gen !== gen) return; this.errors++; this.host.embedder.log(`[RED] codec: the browser's Opus decoder ${dec} failed (${e}): its frames are silence`); this.fail(st); },
    });
    st.d.configure({ codec: "opus", sampleRate: st.rate, numberOfChannels: st.ch });
  }
  open(dec: number, rate: number, channels: number): number {
    if (!WebCodecsOpus.available()) return 0x3a6f;
    const st: Dec = { d: null, rate, ch: channels, pending: [], ts: 0, gen: 0 };
    try { this.make(dec, st); } catch (e) { this.host.embedder.log(`[RED] codec: the browser has no Opus decoder for ${rate} Hz, ${channels} channels (${e})`); return 0x3a6f; }
    this.decs.set(dec, st);
    return 0;
  }
  decode(dec: number, req: number, packet: Uint8Array): number {
    const st = this.decs.get(dec);
    if (!st || st.d.state !== "configured") return -2;
    try {
      st.d.decode(new (globalThis as any).EncodedAudioChunk({ type: "key", timestamp: st.ts, data: unshared(packet) }));   // copies the packet (unshared: it lies in the module's memory, which may be a shared one)
    } catch { return -2; }
    st.ts += 20000;
    st.pending.push(req);
    return OPUS_PENDING;
  }
  private frame(st: Dec, frame: any): void {
    const req = st.pending.shift();
    const n: number = frame.numberOfFrames, ch: number = frame.numberOfChannels;
    if (req === undefined) { frame.close(); return; }
    const out = this.host.x.audio_opus_out(req);
    let ok = false;
    if (out && n * st.ch * 2 <= 11520 && ch === st.ch) {
      const pcm = new Int16Array(this.host.x.memory.buffer, out, n * ch);
      try {
        try { frame.copyTo(pcm, { planeIndex: 0, format: "s16" }); }
        catch {   // a browser that does not convert: planar float, by hand
          const plane = new Float32Array(n);
          for (let c = 0; c < ch; c++) { frame.copyTo(plane, { planeIndex: c, format: "f32-planar" }); for (let i = 0; i < n; i++) { const v = Math.round(plane[i] * 32767); pcm[i * ch + c] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; } }
        }
        ok = true;
      } catch { /* silence */ }
    }
    frame.close();
    this.host.x.audio_opus_complete(req, ok ? n : 0);
  }
  // Everything the decoder still holds is answered as a failure: abandoned requests free their slots, others play silence
  private fail(st: Dec): void { for (const req of st.pending.splice(0)) this.host.x.audio_opus_complete(req, 0); }
  reset(dec: number): void {
    const st = this.decs.get(dec);
    if (!st) return;
    try { st.d.close(); } catch { /* already closed */ }
    this.fail(st);
    st.ts = 0;
    try { this.make(dec, st); } catch { /* decode() will fail */ }
  }
  close(dec: number): void {
    const st = this.decs.get(dec);
    if (!st) return;
    st.gen++;
    try { st.d.close(); } catch { /* already closed */ }
    this.fail(st);
    this.decs.delete(dec);
  }
}
