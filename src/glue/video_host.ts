// The video decoder nn::codec's take-overs use (src/hle/codec_video.ts, HleEnv.video), and what a decoder needs to
// know of a stream before it can take it: the AV1 / VP9 / VP8 key frames and AV1's sequence header (codec string,
// bit depth, colour). No browser API here: src/glue/video_webcodecs.ts is the browser's decoder, the tests bring
// their own.
export const VCODEC = { VP8: 0, VP9: 1, H264: 2, AV1: 3 } as const;
export const VCODEC_NAME = ["VP8", "VP9", "H.264", "AV1"];

// A decoded picture: 8-bit 4:2:0 planes (u and v are ceil(w / 2) x ceil(h / 2)); matrix: H.273 matrix coefficients
// (1 BT.709, 5 / 6 BT.601, 9 BT.2020, 2 not given)
export interface VideoPicture { w: number; h: number; y: Uint8Array; u: Uint8Array; v: Uint8Array; yStride: number; uvStride: number; matrix: number; fullRange: boolean }
// Where the decoder's completions go (HleHost.videoPicture): one per packet decode() answered 1 for, in submission
// order, pic null for a packet that gave no picture
export interface VideoSink { picture(dec: number, gen: number, seq: bigint, pic: VideoPicture | null): void; log(line: string): void }
export interface VideoBackend {
  // A decoder for decoder `dec` (1..16) of codec (VCODEC) at w x h: its name for the log, "" when it cannot
  open(dec: number, codec: number, w: number, h: number): string;
  // packet: a view of linear memory, copied before this returns; null with eos: drain what is in flight.
  // 1: a completion for seq follows (now or later), 2: taken, no picture to come, 0: cannot decode
  decode(dec: number, gen: number, seq: bigint, packet: Uint8Array | null, eos: boolean): number;
  reset(dec: number, gen: number): void;   // drop everything in flight; the stream goes on at its next key frame
  close(dec: number): void;
}

// ---- AV1 (low-overhead bitstream format: OBUs with size fields, as WebM and MP4 carry them) ----
export interface Av1Seq { profile: number; level: number; tier: number; bitDepth: number; mono: boolean; matrix: number; fullRange: boolean; reduced: boolean; codec: string }
class Bits {
  p: number; private b: Uint8Array; private end: number;
  constructor(b: Uint8Array, end: number, start: number) { this.b = b; this.end = end; this.p = start * 8; }
  f(n: number): number { let v = 0; for (let i = 0; i < n; i++) { const byte = (this.p >> 3); if (byte >= this.end) throw new Error("av1: short"); v = v * 2 + ((this.b[byte] >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
  uvlc(): number { let lz = 0; while (!this.f(1)) { lz++; if (lz >= 32) return 0xffffffff; } return lz ? this.f(lz) + (2 ** lz - 1) : 0; }
}
function leb128(b: Uint8Array, p: number, end: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 8 && p < end; i++) { const c = b[p++]; v += (c & 0x7f) * 2 ** (7 * i); if (!(c & 0x80)) return [v, p]; }
  return [-1, p];
}
// Each OBU of a temporal unit: type, payload start, payload end
export function av1Obus(b: Uint8Array): { type: number; start: number; end: number }[] {
  const out: { type: number; start: number; end: number }[] = [];
  let p = 0;
  while (p < b.length) {
    const h = b[p], type = (h >> 3) & 15, ext = (h >> 2) & 1, hasSize = (h >> 1) & 1;
    p += 1 + ext;
    let size = b.length - p;
    if (hasSize) { const [s, q] = leb128(b, p, b.length); if (s < 0) break; size = s; p = q; }
    if (p + size > b.length) break;
    out.push({ type, start: p, end: p + size });
    p += size;
  }
  return out;
}
// The sequence header OBU's payload (spec 5.5), as far as the colour config
export function av1ParseSeq(b: Uint8Array, start: number, end: number): Av1Seq {
  const r = new Bits(b, end, start);
  const profile = r.f(3); r.f(1); const reduced = r.f(1) === 1;
  let level = 0, tier = 0;
  if (reduced) level = r.f(5);
  else {
    let decoderModel = false, bufferDelayLen = 0;
    if (r.f(1)) {   // timing_info_present_flag
      r.f(32); r.f(32); if (r.f(1)) r.uvlc();
      decoderModel = r.f(1) === 1;
      if (decoderModel) { bufferDelayLen = r.f(5) + 1; r.f(32); r.f(5); r.f(5); }
    }
    const initialDisplayDelay = r.f(1) === 1;
    const ops = r.f(5) + 1;
    for (let i = 0; i < ops; i++) {
      r.f(12); const lv = r.f(5); const t = lv > 7 ? r.f(1) : 0;
      if (i === 0) { level = lv; tier = t; }
      if (decoderModel && r.f(1)) { r.f(bufferDelayLen); r.f(bufferDelayLen); r.f(1); }
      if (initialDisplayDelay && r.f(1)) r.f(4);
    }
  }
  const wBits = r.f(4) + 1, hBits = r.f(4) + 1; r.f(wBits); r.f(hBits);
  if (!reduced && r.f(1)) { r.f(4); r.f(3); }   // frame_id_numbers_present_flag
  r.f(1); r.f(1); r.f(1);                        // 128x128, filter intra, intra edge
  if (!reduced) {
    r.f(1); r.f(1); r.f(1); r.f(1);              // interintra, masked, warped, dual filter
    const orderHint = r.f(1) === 1;
    if (orderHint) { r.f(1); r.f(1); }           // jnt comp, ref frame mvs
    const screen = r.f(1) ? 2 : r.f(1);
    if (screen > 0 && !r.f(1)) r.f(1);           // seq_choose_integer_mv, seq_force_integer_mv
    if (orderHint) r.f(3);
  }
  r.f(1); r.f(1); r.f(1);                        // superres, cdef, restoration
  const high = r.f(1) === 1;
  const bitDepth = profile === 2 && high ? (r.f(1) ? 12 : 10) : high ? 10 : 8;
  const mono = profile === 1 ? false : r.f(1) === 1;
  let primaries = 2, transfer = 2, matrix = 2, fullRange = false;
  if (r.f(1)) { primaries = r.f(8); transfer = r.f(8); matrix = r.f(8); }
  if (!mono && primaries === 1 && transfer === 13 && matrix === 0) fullRange = true;   // sRGB: no color_range bit
  else fullRange = r.f(1) === 1;
  const codec = `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(bitDepth).padStart(2, "0")}`;
  return { profile, level, tier, bitDepth, mono, matrix, fullRange, reduced, codec };
}
// The temporal unit's sequence header (null: none) and whether it starts with a key frame
export function av1Inspect(b: Uint8Array, known: Av1Seq | null): { seq: Av1Seq | null; key: boolean } {
  let seq: Av1Seq | null = null, key = false;
  for (const o of av1Obus(b)) {
    if (o.type === 1) { try { seq = av1ParseSeq(b, o.start, o.end); } catch { /* a short header: not this one */ } }
    else if (o.type === 3 || o.type === 6) {     // OBU_FRAME_HEADER, OBU_FRAME: the first one decides
      const s = seq ?? known;
      if (s?.reduced) key = true;
      else if (o.end > o.start) { const h = b[o.start]; key = !(h & 0x80) && ((h >> 5) & 3) === 0; }   // !show_existing_frame, frame_type KEY_FRAME
      break;
    }
  }
  return { seq, key };
}
// VP9 (uncompressed header: frame marker, profile, show_existing_frame, frame_type 0 = key) and VP8 (bit 0 of the
// frame tag, 0 = key)
export function vp9Key(b: Uint8Array): boolean {
  if (!b.length || (b[0] >> 6) !== 2) return false;
  const profile = ((b[0] >> 5) & 1) | (((b[0] >> 4) & 1) << 1);
  let bit = profile === 3 ? 5 : 4;               // past the marker and the profile (and profile 3's reserved bit)
  const at = (i: number) => (b[i >> 3] >> (7 - (i & 7))) & 1;
  if (at(bit)) return false;                     // show_existing_frame
  bit++;
  return at(bit) === 0;
}
export function vp8Key(b: Uint8Array): boolean { return b.length > 0 && (b[0] & 1) === 0; }
