// The AudioWorklet processor of the audio device, as source text for audioWorklet.addModule (a Blob URL).
// It runs on the browser's audio thread and does one thing: take frames from a ring and count what it did.
//  - with a SharedArrayBuffer: the ring the audio module writes (src/audio/dev.ts), read in place; indices are atomics
//  - without: a ring of its own, fed by messages with frames, and it reports rd / callbacks / underruns back
// Header words (Int32): 0 wr, 1 rd, 2 cap, 3 underrun frames, 4 callbacks, 5 live outputs, 6 rate, 7 target.
// A recording of what it put out can be asked for (the browser test does; a page could draw a scope with it).

/* eslint-disable @typescript-eslint/no-explicit-any */
function body(): void {
  const g = globalThis as any;
  class NxAudio extends g.AudioWorkletProcessor {
    h: Int32Array; d: Float32Array; mask: number; shared: boolean;
    feed: any = null; rec: Float32Array | null = null; recN = 0; quanta = 0;
    constructor(o: any) {
      super();
      const p = o.processorOptions;
      this.mask = p.cap - 1;
      this.shared = !!p.sab;
      if (p.sab) { this.h = new Int32Array(p.sab, p.hdr, 8); this.d = new Float32Array(p.sab, p.data, p.cap * 2); }
      else { this.h = new Int32Array(8); this.h[2] = p.cap; this.d = new Float32Array(p.cap * 2); }
      (this as any).port.onmessage = (e: any) => this.msg(e.data, (this as any).port);
    }
    msg(m: any, port: any): void {
      if (m.port) { this.feed = m.port; m.port.onmessage = (e: any) => this.msg(e.data, m.port); }
      else if (m.pcm) {
        const pcm: Float32Array = m.pcm, n = pcm.length >> 1, wr = this.h[0], d = this.d, mask = this.mask;
        for (let i = 0; i < n; i++) { const k = ((wr + i) & mask) << 1; d[k] = pcm[2 * i]; d[k + 1] = pcm[2 * i + 1]; }
        this.h[0] = (wr + n) | 0; this.h[5] = m.live;
      } else if (m.live !== undefined) this.h[5] = m.live;
      else if (m.record) { this.rec = new Float32Array(m.record * 2); this.recN = 0; }
      else if (m.dump) {
        const pcm = this.rec ? this.rec.slice(0, this.recN * 2) : new Float32Array(0);
        port.postMessage({ dump: pcm, frames: this.recN, sampleRate: g.sampleRate, underrun: this.shared ? Atomics.load(this.h, 3) : this.h[3], callbacks: this.shared ? Atomics.load(this.h, 4) : this.h[4] }, [pcm.buffer]);
      }
    }
    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const out = outputs[0], L = out[0], R = out.length > 1 ? out[1] : null, n = L.length, h = this.h, d = this.d, mask = this.mask;
      const wr = this.shared ? Atomics.load(h, 0) : h[0], rd = this.shared ? Atomics.load(h, 1) : h[1];
      let avail = (wr - rd) >>> 0;
      if (avail > mask + 1) avail = 0;   // a header that makes no sense: play nothing
      const k = avail < n ? avail : n;
      for (let i = 0; i < k; i++) { const p = ((rd + i) & mask) << 1; L[i] = d[p]; if (R) R[i] = d[p + 1]; }
      // the rest of the quantum stays silence; it is an underrun only while an output plays
      if (this.shared) {
        if (k < n && Atomics.load(h, 5) > 0) Atomics.add(h, 3, n - k);
        Atomics.store(h, 1, (rd + k) | 0); Atomics.add(h, 4, 1);
      } else {
        if (k < n && h[5] > 0) h[3] += n - k;
        h[1] = (rd + k) | 0; h[4]++;
        if (this.feed && (++this.quanta & 1) === 0) this.feed.postMessage({ rd: h[1], cb: h[4], under: h[3] });
      }
      const rec = this.rec;
      if (rec && (this.recN + n) * 2 <= rec.length) {
        for (let i = 0, o = this.recN * 2; i < n; i++) { rec[o + 2 * i] = L[i]; rec[o + 2 * i + 1] = R ? R[i] : L[i]; }
        this.recN += n;
      }
      return true;
    }
  }
  g.registerProcessor("nx-audio", NxAudio);
}

export function workletSource(): string { return `(${body.toString()})();`; }
