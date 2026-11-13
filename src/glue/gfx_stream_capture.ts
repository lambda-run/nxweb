// nxweb graphics glue: the stream capture of the replayer and its replay (docs: test/gfx/REPLAY.md).
//
// `?gfxcapture=<frames>[@<present>|@draws<n>]` (GfxHost reads it; GfxHost.streamCapture arms it by hand) writes
// everything the replayer needs to execute N consecutive frames again WITHOUT the game and without the recorder:
//   - the host-stream batches (src/gfx/hostops.ts) in order, byte for byte;
//   - the guest memory the batches name (vertex, index, uniform and storage ranges, texel sources, pipeline key
//     records, the recorder's sampler table) as 4 KB pages, each page written when a batch first names it and again
//     whenever its bytes changed by the time a later batch names it;
//   - the textures that were live before the capture began and that the frames use: their description and, read back
//     from the GPU at their first use, the bytes of every level and layer;
//   - the pipelines made before the capture began (their key record) and every shader a pipeline of the frames uses
//     (key, reflection record, WGSL, the vertex-input variants made so far);
//   - the texels of each presented image as the live replayer produced them (the reference a replay is compared to).
// The file is a sequence of chunks in the order a replay needs them, so a replay reads it front to back.
//
// A replay (replayCapture) runs the same GfxHost on a small memory: the captured pages laid out one after the other
// in ascending address order (ranges stay contiguous, containment and order are kept), the addresses in each batch
// rewritten to that layout. What the recorder decided when the frames were captured (which draws it skipped, which
// pipeline keys it asked for) is part of the capture: a replay tests the replayer (gfx_host.ts and the WGSL it is
// given), not the recorder.
import { hostFormat, type NvnFormat } from "./gfx_formats.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type GPU = any;

export const CAP_MAGIC = "NXGFXCAPTURE 1\n\0";      // 16 bytes
export const CAP_PAGE = 4096;
const PK_SIZE = 384;                                 // a pipeline key record (src/gfx/pipeline.ts)
const SAMPLER_TABLE_BYTES = 8192 * 48;               // src/gfx/tables.ts SAMPDESC_N * SDE_SIZE
const H = { TEX_CREATE: 1, TEX_DESTROY: 2, BEGIN_PASS: 3, PIPELINE_CREATE: 7, PIPELINE: 8, VBUF: 9, UBO: 10, TEX: 11, DRAW_IDX: 15, COPY_B2T: 17, COPY_T2T: 18, SNAPSHOT: 19, PRESENT: 20,
  TEX_DATA: 24, COPY_T2B: 25, SSBO: 28, IMG: 29, DISPATCH: 31, BUF_READBACK: 32, MESH_BEGIN: 35, MESH_TASK: 36, MESH_RUN: 37, CLEAR_TEX: 39, DISPATCH_SKIPPED: 40 };

export interface CaptureSpec { frames: number; present?: number; draws?: number; to: string; name: string; maxTexMB: number }
export interface CaptureSink { write(bytes: Uint8Array): Promise<void> | void; close?(): Promise<void> | void }
export interface CaptureSummary { name: string; frames: number; batches: number; bytes: number; pages: number; textures: number; textureBytes: number; texturesWithoutContent: string[]; shaders: number; pipelines: number }

// "?a=1&gfxcapture=3@draws500&gfxcapto=http://host:8082" (a page's or a worker's location.search) or the bare value "3@draws500". null: no capture asked for.
//   <frames>             that many frames from the next present on
//   <frames>@<n>         from the n-th present of this replayer on (the frames after it)
//   <frames>@draws<n>    from the first present on whose frame issued at least n draws on the replayer
//   gfxcapto=<url>       the receiver (vm/ctl/recv.mjs); default: ?logto=, else http://localhost:8082
//   gfxcapname=<name>    the file's name there (default area.gfxcap); gfxcaptex=<MB> the budget for texture contents (default 2048)
export function parseCaptureSpec(s: string | null | undefined): CaptureSpec | null {
  if (!s) return null;
  let v: string | null = s, to = "", name = "", tex = 0;
  if (s.includes("=")) {
    const q = new URLSearchParams(s.startsWith("?") ? s.slice(1) : s);
    v = q.get("gfxcapture"); to = q.get("gfxcapto") ?? q.get("logto") ?? ""; name = q.get("gfxcapname") ?? ""; tex = Number(q.get("gfxcaptex") ?? 0);
  }
  const m = v ? /^(\d+)(?:@(draws)?(\d+))?$/.exec(v.trim()) : null;
  if (!m || !+m[1]) return null;
  return { frames: +m[1], ...(m[3] === undefined ? {} : m[2] ? { draws: +m[3] } : { present: +m[3] }), to: (to || "http://localhost:8082").replace(/\/+$/, ""),
    name: (name || "area.gfxcap").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80) || "area.gfxcap", maxTexMB: tex > 0 ? tex : 2048 };
}
// The log receiver (vm/ctl/recv.mjs): POST /<name> starts the file, POST /append/<name> adds to it; bodies of at most 8 MB, one after the other
export function httpSink(to: string, name: string, log: (l: string) => void = () => {}): CaptureSink {
  let first = true, failed = false;
  const post = async (part: Uint8Array) => {
    const url = `${to}/${first ? "" : "append/"}${name}`; first = false;
    for (let attempt = 0; ; attempt++) {
      try { const r = await fetch(url, { method: "POST", body: part as any }); if (r.ok) return; throw new Error(`HTTP ${r.status}`); }
      catch (e: any) { if (attempt >= 2) { if (!failed) { failed = true; log(`[RED] gfxcapture: ${url} cannot be written (${e?.message ?? e}): the capture file is incomplete`); } return; } await new Promise(r => setTimeout(r, 300)); }
    }
  };
  return { async write(b) { if (failed) return; for (let o = 0; o < b.length; o += 8 << 20) await post(b.subarray(o, Math.min(b.length, o + (8 << 20)))); } };
}

const u64 = (dv: DataView, p: number) => dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
// The guest addresses a record names: [offset of the field in the record, bytes named there, the field is 32 bits wide]. `fmt`: the format of a texture
// (two copies' sizes depend on it; unknown: the address is still listed, with no bytes)
function addressFields(op: number, dv: DataView, p: number, fmt: (serial: number) => NvnFormat | undefined): [number, number, boolean?][] {
  switch (op) {
    case H.VBUF: return [[16, dv.getUint32(p + 12, true)]];
    case H.UBO: case H.SSBO: return [[16, dv.getUint32(p + 24, true)]];
    case H.DRAW_IDX: { const it = dv.getUint32(p + 8, true); return [[32, dv.getUint32(p + 12, true) * (it === 2 ? 4 : it === 1 ? 2 : 1)]]; }
    case H.BUF_READBACK: return [[8, dv.getUint32(p + 16, true)]];
    case 23 /* MEM_DIRTY with its range */: return dv.getUint32(p + 4, true) >= 24 ? [[8, dv.getUint32(p + 16, true)]] : [];
    case H.MESH_BEGIN: return dv.getUint32(p + 8, true) & 1 ? [[24, 8]] : [];
    case H.PIPELINE_CREATE: return [[12, PK_SIZE, true]];
    case H.COPY_B2T: case H.COPY_T2B: {
      const f = fmt(u64(dv, p + 16));
      if (!f) return [[8, 0]];
      const bx = Math.ceil(dv.getInt32(p + 44, true) / f.bw), by = Math.ceil(dv.getInt32(p + 48, true) / f.bh), depth = Math.max(1, dv.getInt32(p + 52, true));
      const row = dv.getUint32(p + 56, true) || bx * f.bpb, img = dv.getUint32(p + 60, true) || row * by;
      return [[8, Math.max(0, img * depth)]];
    }
    case H.TEX_DATA: {
      const f = fmt(u64(dv, p + 8)), what = dv.getUint32(p + 56, true), rows = what === 1 || !f ? dv.getUint32(p + 32, true) : Math.ceil(dv.getUint32(p + 32, true) / f.bh);
      return [[40, dv.getUint32(p + 48, true) * rows * Math.max(1, dv.getUint32(p + 36, true))]];
    }
  }
  return [];
}
// The texture serials a record names (0: none)
function textureFields(op: number, dv: DataView, p: number): number[] {
  switch (op) {
    case H.BEGIN_PASS: { const out: number[] = [], n = dv.getUint32(p + 8, true); for (let i = 0; i < n; i++) out.push(u64(dv, p + 32 + i * 40)); if (dv.getUint32(p + 12, true) & 1) out.push(u64(dv, p + 352)); return out; }
    case H.TEX: case H.IMG: case H.COPY_B2T: case H.COPY_T2B: return [u64(dv, p + 16)];
    case H.COPY_T2T: return [u64(dv, p + 8), u64(dv, p + 16)];
    case H.SNAPSHOT: case H.PRESENT: case H.CLEAR_TEX: case H.TEX_DATA: return [u64(dv, p + 8)];
    case H.DISPATCH_SKIPPED: { const out: number[] = []; for (let i = 0; i < 40; i++) out.push(u64(dv, p + 32 + i * 8)); return out; }
  }
  return [];
}
function pageHash(w: Uint32Array, at: number): number {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = at, e = at + CAP_PAGE / 4; i < e; i++) { const v = w[i]; a = Math.imul(a ^ v, 0x01000193); a ^= a >>> 15; b = (Math.imul(b, 31) + v) | 0; }
  return (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff);
}
const enc = new TextEncoder(), dec = new TextDecoder();
function chunk(header: any, ...payload: Uint8Array[]): Uint8Array[] {
  const h = enc.encode(JSON.stringify(header)), head = new Uint8Array(8 + h.length), dv = new DataView(head.buffer);
  dv.setUint32(0, h.length, true); dv.setUint32(4, payload.reduce((n, b) => n + b.length, 0), true); head.set(h, 8);
  return [head, ...payload];
}
// What the copy of a texture out of (and back into) the GPU looks like: the bytes of a block as copied, or why it cannot be copied
function copyLayout(g: GPU, f: NvnFormat): { bpb: number; depth: boolean } | string {
  if (g.sampleCount > 1) return "multisampled";
  if (!(g.usage & 0x01)) return "no COPY_SRC usage";
  if (g.format === "depth16unorm") return { bpb: 2, depth: true };
  if (g.format === "depth32float" || g.format === "depth32float-stencil8") return { bpb: 4, depth: true };
  if (f.kind === "depth" || f.stencil) return `${g.format} cannot be copied out`;
  return { bpb: f.bpb, depth: false };
}
interface Level { w: number; h: number; d: number; row: number; off: number }
function levelsOf(g: GPU, f: NvnFormat, bpb: number, count = g.mipLevelCount): { levels: Level[]; bytes: number } {
  const levels: Level[] = []; let off = 0;
  for (let l = 0; l < count; l++) {
    const w = Math.ceil(Math.max(1, g.width >> l) / f.bw), h = Math.ceil(Math.max(1, g.height >> l) / f.bh), d = g.dimension === "3d" ? Math.max(1, g.depthOrArrayLayers >> l) : g.depthOrArrayLayers;
    const row = Math.ceil(w * bpb / 256) * 256;
    levels.push({ w, h, d, row, off }); off += row * h * d;
  }
  return { levels, bytes: off };
}

// ---- the capture ----
// `h` is the GfxHost (its private state is read here: the module is the replayer's own)
export class StreamCapture {
  private saved = new Map<number, number>();           // page number -> the hash of the bytes written to the file last
  private texSeen = new Set<number>(); private pipeSeen = new Set<number>(); private shaderSeen = new Set<number>();
  private jobs: (() => Promise<Uint8Array[]> | Uint8Array[])[] = []; private pumping = false;
  private presents = 0; private batches = 0; private bytes = 0; private texBytes = 0; private noContent: string[] = []; private closing = false;
  private copies: GPU = null;
  private finish!: (s: CaptureSummary) => void;
  readonly done: Promise<CaptureSummary>;
  private readonly spec: CaptureSpec; private readonly sink: CaptureSink; private readonly h: any;
  constructor(h: any, spec: CaptureSpec, sink: CaptureSink) {
    this.h = h; this.spec = spec; this.sink = sink;
    this.done = new Promise(r => { this.finish = r; });
    const d = h.device;
    this.push(() => [enc.encode(CAP_MAGIC), ...chunk({ type: "meta", v: 1, page: CAP_PAGE, frames: spec.frames, startPresent: h.stats.presents, caps: h.caps, canvasFormat: h.canvasFormat, uniformArena: h.uniformArena,
      fix: h.fix, features: [...(d.features ?? [])].sort(), samplerTable: Number(h.x.gfx_sampler_table()), memoryBytes: h.memory.buffer.byteLength, liveTextures: h.textures.size, pipelines: h.pipes.size })]);
  }
  get active(): boolean { return !this.closing; }
  private push(job: () => Promise<Uint8Array[]> | Uint8Array[]) { this.jobs.push(job); if (!this.pumping) { this.pumping = true; void this.pump(); } }
  // One job after the other, never inside the exec() that queued it (a shader's record is taken after the batch that first uses it ran: the variants made for it are in)
  private async pump() {
    await null;
    while (this.jobs.length) {
      try { for (const part of await this.jobs.shift()!()) { this.bytes += part.length; await this.sink.write(part); } }
      catch (e: any) { this.h.log(`[RED] gfxcapture: a part of the capture was not written: ${e?.message ?? e}`); }
    }
    this.pumping = false;
  }
  private fmt = (serial: number): NvnFormat | undefined => this.h.textures.get(serial)?.fmt;

  // Before a batch (or the rest of one) is executed: what it names is put into the file, then the batch itself up to the capture's last present
  batch(ptr: number, len: number): void {
    if (this.closing || len <= 0) return;
    const h = this.h, mem: ArrayBuffer = h.memory.buffer, dv = new DataView(mem), ranges: [number, number][] = [], created = new Set<number>();
    let end = ptr + len, presents = this.presents, samplers = false;
    for (let p = ptr; p < end;) {
      const op = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
      if (!size) break;
      for (const [o, n, narrow] of addressFields(op, dv, p, this.fmt)) { const a = narrow ? dv.getUint32(p + o, true) : u64(dv, p + o); if (a && n) ranges.push([a, n]); }
      if (op === H.TEX_CREATE) this.texSeen.add(u64(dv, p + 8));       // made inside the capture: nothing to bring along
      else for (const s of textureFields(op, dv, p)) if (s && !this.texSeen.has(s)) { this.texSeen.add(s); this.texture(s); }
      switch (op) {
        case H.TEX: samplers = true; break;
        case H.PIPELINE_CREATE: created.add(dv.getUint32(p + 8, true)); this.pipeSeen.add(dv.getUint32(p + 8, true)); this.keyShaders(dv, dv.getUint32(p + 12, true)); break;
        case H.PIPELINE: case H.DISPATCH: case H.MESH_TASK: case H.MESH_RUN: this.pipeline(dv.getUint32(p + 8, true), dv, ranges); break;
        case H.MESH_BEGIN: this.shader(dv.getUint32(p + 32, true)); if (dv.getInt32(p + 36, true) >= 0) this.shader(dv.getInt32(p + 36, true)); break;
        case H.PRESENT: if (++presents >= this.spec.frames) end = p + size; break;
      }
      p += size;
    }
    if (samplers) ranges.push([Number(h.x.gfx_sampler_table()), SAMPLER_TABLE_BYTES]);
    if (this.copies) { h.device.queue.submit([this.copies.finish()]); this.copies = null; }
    // the pages of the ranges whose bytes are not in the file as they are now
    const words = new Uint32Array(mem, 0, Math.floor(mem.byteLength / 4)), u8 = new Uint8Array(mem), seen = new Set<number>(), pages: number[] = [], last = Math.floor(mem.byteLength / CAP_PAGE);
    for (const [a, n] of ranges) for (let pg = Math.floor(a / CAP_PAGE), e = Math.min(last, Math.ceil((a + n) / CAP_PAGE)); pg < e; pg++) {
      if (seen.has(pg)) continue;
      seen.add(pg);
      const hash = pageHash(words, pg * (CAP_PAGE / 4));
      if (this.saved.get(pg) !== hash) { this.saved.set(pg, hash); pages.push(pg); }
    }
    pages.sort((a, b) => a - b);
    const runs: [number, number][] = [], data = new Uint8Array(pages.length * CAP_PAGE);
    pages.forEach((pg, i) => { data.set(u8.subarray(pg * CAP_PAGE, (pg + 1) * CAP_PAGE), i * CAP_PAGE); const r = runs[runs.length - 1]; if (r && r[0] + r[1] === pg) r[1]++; else runs.push([pg, 1]); });
    const n = end - ptr, body = new Uint8Array((n + 7) & ~7); body.set(u8.subarray(ptr, end));
    const parts = chunk({ type: "batch", i: this.batches++, len: n, frame: this.presents, runs }, body, data);
    this.push(() => parts);
  }
  // A texture that was live before the capture: its description now, its bytes as the GPU holds them (everything submitted so far; what the capture's own
  // batches draw comes after: every batch that writes it names it, and it is copied out here at its first naming)
  private texture(serial: number): void {
    const h = this.h, t = h.textures.get(serial);
    if (!t) return;
    const g = t.gpu, head: any = { type: "tex", serial, target: t.target, format: t.format, flags: t.flags, samples: t.samples, width: t.width, height: t.height, depth: t.depth, levels: t.levels, swz: t.swz, gpuFormat: t.fmt?.tex ?? null };
    const none = (why: string) => { head.content = null; head.why = why; if (g) this.noContent.push(`tex#${serial} ${t.fmt?.tex} ${t.width}x${t.height}: ${why}`); this.push(() => chunk(head)); };
    if (!g) return none("never used: no GPU texture yet");
    const lay = copyLayout(g, t.fmt);
    if (typeof lay === "string") return none(lay);
    const { levels, bytes } = levelsOf(g, t.fmt, lay.bpb);
    if (bytes > (h.device.limits?.maxBufferSize ?? 268435456)) return none(`${bytes} bytes: larger than a buffer of this device`);
    if (this.texBytes + bytes > this.spec.maxTexMB * 1048576) return none(`over the capture's budget for texture contents (${this.spec.maxTexMB} MB, gfxcaptex=)`);
    this.texBytes += bytes;
    const buf = h.device.createBuffer({ size: Math.max(4, bytes), usage: 0x01 | 0x08 }), e = (this.copies ??= h.device.createCommandEncoder());
    levels.forEach((L, l) => e.copyTextureToBuffer({ texture: g, mipLevel: l, ...(lay.depth ? { aspect: "depth-only" } : {}) }, { buffer: buf, offset: L.off, bytesPerRow: L.row, rowsPerImage: L.h }, { width: L.w * t.fmt.bw, height: L.h * t.fmt.bh, depthOrArrayLayers: L.d }));
    head.content = { bpb: lay.bpb, depth: lay.depth, levels };
    this.push(async () => {
      try { await buf.mapAsync(1); const data = new Uint8Array(buf.getMappedRange()).slice(); buf.unmap(); buf.destroy(); return chunk(head, data); }
      catch (err: any) { head.content = null; head.why = `the read-back failed: ${err?.message ?? err}`; this.noContent.push(`tex#${serial}: ${head.why}`); return chunk(head); }
    });
  }
  private shader(id: number): void {
    if (this.shaderSeen.has(id)) return;
    this.shaderSeen.add(id);
    this.push(() => { const s = this.h.shaders[id]; return s ? chunk({ type: "shader", id, key: s.key, info: JSON.parse(JSON.stringify(s.info, (_k, v) => v instanceof Uint8Array ? { __u8: Array.from(v) } : v)) }) : []; });
  }
  private keyShaders(dv: DataView, k: number): void {
    if (!k || k + PK_SIZE > dv.byteLength) return;
    if (dv.getUint8(k + 4) !== 0xff) this.shader(dv.getUint16(k, true));
    this.shader(dv.getUint16(k + 2, true));
  }
  // A pipeline made before the capture: its key record goes along (as memory), and the shaders it names
  private pipeline(id: number, dv: DataView, ranges: [number, number][]): void {
    if (this.pipeSeen.has(id)) return;
    this.pipeSeen.add(id);
    const p = this.h.pipes.get(id);
    if (!p) return;
    ranges.push([p.key, PK_SIZE]); this.keyShaders(dv, p.key);
    this.push(() => chunk({ type: "pipe", id, key: p.key }));
  }
  // A present was executed (the replayer has submitted everything): the image as it is now is the reference of this frame
  presented(serial: number, flags: number): void {
    if (this.closing) return;
    const h = this.h, t = h.textures.get(serial), n = this.presents++, head: any = { type: "frame", n, serial, flip: flags & 1, line: h.ledger.lastLine ?? "" };
    const lay = t?.gpu ? copyLayout(t.gpu, t.fmt) : "no texture";
    if (typeof lay === "string") { head.why = lay; this.push(() => chunk(head)); }
    else {
      const g = t.gpu, L = levelsOf(g, t.fmt, lay.bpb, 1).levels[0], buf = h.device.createBuffer({ size: L.row * L.h, usage: 0x01 | 0x08 }), e = h.device.createCommandEncoder();
      e.copyTextureToBuffer({ texture: g, ...(lay.depth ? { aspect: "depth-only" } : {}) }, { buffer: buf, bytesPerRow: L.row, rowsPerImage: L.h }, { width: g.width, height: g.height, depthOrArrayLayers: 1 });
      h.device.queue.submit([e.finish()]);
      Object.assign(head, { width: L.w, height: L.h, bpp: lay.bpb, format: g.format });
      this.push(async () => {
        try {
          await buf.mapAsync(1);
          const src = new Uint8Array(buf.getMappedRange()), data = new Uint8Array(L.w * L.h * lay.bpb);
          for (let y = 0; y < L.h; y++) data.set(src.subarray(y * L.row, y * L.row + L.w * lay.bpb), y * L.w * lay.bpb);
          buf.unmap(); buf.destroy(); return chunk(head, data);
        } catch (err: any) { head.why = `the read-back failed: ${err?.message ?? err}`; delete head.width; return chunk(head); }
      });
    }
    if (this.presents >= this.spec.frames) this.end();
  }
  private end(): void {
    this.closing = true;
    this.push(async () => {
      const s: CaptureSummary = { name: this.spec.name, frames: this.presents, batches: this.batches, bytes: 0, pages: this.saved.size, textures: this.texSeen.size, textureBytes: this.texBytes, texturesWithoutContent: this.noContent,
        shaders: this.shaderSeen.size, pipelines: this.pipeSeen.size };
      return chunk({ type: "end", ...s });
    });
    this.push(async () => {
      try { await this.sink.close?.(); } catch { /* the sink's own business */ }
      const s: CaptureSummary = { name: this.spec.name, frames: this.presents, batches: this.batches, bytes: this.bytes, pages: this.saved.size, textures: this.texSeen.size, textureBytes: this.texBytes, texturesWithoutContent: this.noContent,
        shaders: this.shaderSeen.size, pipelines: this.pipeSeen.size };
      this.h.log(`gfxcapture: ${s.frames} frame${s.frames === 1 ? "" : "s"} written to ${s.name}: ${s.batches} batches, ${s.pages} pages of memory, ${s.textures} textures (${(s.textureBytes / 1048576).toFixed(1)} MB of contents${s.texturesWithoutContent.length ? `, ${s.texturesWithoutContent.length} without` : ""}), ${s.shaders} shaders, ${s.pipelines} pipelines, ${(s.bytes / 1048576).toFixed(1)} MB`);
      this.finish(s);
      return [];
    });
  }
}

// ---- reading a capture ----
export interface CapChunk { h: any; off: number; len: number }       // the header, where the payload is in the file, its length
export interface CaptureIndex { chunks: CapChunk[]; complete: boolean; size: number }
export async function indexCapture(read: (off: number, len: number) => Promise<Uint8Array> | Uint8Array, size: number): Promise<CaptureIndex> {
  const magic = await read(0, 16);
  if (dec.decode(magic) !== CAP_MAGIC) throw new Error("not a gfx stream capture (no NXGFXCAPTURE header)");
  const chunks: CapChunk[] = [];
  let off = 16, complete = false;
  while (off + 8 <= size) {
    const hd = await read(off, 8), dv = new DataView(hd.buffer, hd.byteOffset, 8), hl = dv.getUint32(0, true), pl = dv.getUint32(4, true);
    if (off + 8 + hl + pl > size) break;
    const h = JSON.parse(dec.decode(await read(off + 8, hl)));
    chunks.push({ h, off: off + 8 + hl, len: pl });
    off += 8 + hl + pl;
    if (h.type === "end") { complete = true; break; }
  }
  return { chunks, complete, size };
}

export interface ReplayFrame { n: number; serial: number; width: number; height: number; bytesPerPixel: number; format: string; flip: boolean; data: Uint8Array | null; line: string; reds: [string, number][];
  live: "same" | "differs" | "none"; differing: number; note: string }
export interface ReplayResult { host: any; frames: ReplayFrame[]; log: string[]; errors: [string, number][]; notes: string[]; stats: any; ms: number }
// shader: a shader of the capture is about to be taken: what it returns (when anything) replaces its record (a stage translated again by a newer chain)
export interface ReplayOptions { onFrame?: (f: ReplayFrame) => Promise<void> | void; onLive?: (n: number, head: any, data: Uint8Array) => Promise<void> | void; keepData?: boolean; shader?: (key: string, info: any) => any;
  // textures that come with contents and have more than one level are made without their top levels until no side is longer than this (a software
  // device decodes compressed textures in memory: a gigabyte of ASTC and BC is several there). Their finest detail is lost, nothing else
  texMax?: number;
  // textures to read back (level 0, layer 0) after each present: the intermediate targets of the frame, as it left them
  dump?: number[]; onDump?: (d: ReplayDump) => Promise<void> | void;
  noReadback?: boolean;      // presented images are not read back (and not compared): a profile wants the replayer's work alone
  repeat?: ReplayRepeat }
// Profiling (web/gfxprof.ts): frame `frame` of the capture, once it has been replayed, is handed to `run`, which may execute it again as often as it likes.
//   once(hook)   memory and the set of textures as they were when the frame began (textures the frame destroyed come back blank), then the frame's records
//                again, up to and including its present (which submits). Pipeline creations are left out: they are made. Returns the ms spent inside
//                GfxHost.exec. With `hook` the records are executed one by one and each one's op and ms are handed to it.
//   settle()     the read-backs have landed and the GPU has finished what was submitted
export interface ReplayRepeat { frame: number; run(r: { host: any; batches: number; records: number; once(hook?: (op: number, ms: number) => void): number; settle(): Promise<void> }): Promise<void> }
export interface ReplayDump { frame: number; serial: number; width: number; height: number; format: string; data: Uint8Array; nonZero: number; note: string }

// Replays a capture on a GfxHost made by `makeHost(memory, log)` (the caller owns the device and the options; the host must not be attached to a recorder).
// `payload(i)`: the payload bytes of chunk i. Every presented image is read back (level 0) and compared with the live one in the capture.
export async function replayCapture(index: CaptureIndex, payload: (i: number) => Promise<Uint8Array> | Uint8Array, makeHost: (memory: { buffer: ArrayBuffer }, log: (l: string) => void) => any, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const t0 = performance.now(), notes: string[] = [], log: string[] = [], frames: ReplayFrame[] = [];
  const meta = index.chunks.find(c => c.h.type === "meta")?.h;
  if (!meta) throw new Error("the capture has no meta chunk");
  if (!index.complete) notes.push("the capture file is incomplete (no end chunk): it is replayed as far as it goes");
  // the layout: every captured page, ascending, one after the other from 64 KB up; then the batch area, the depth scratch, the recorder's scratch
  const iv: [number, number][] = [];
  let maxBatch = 0, maxDepth = 0;
  for (const c of index.chunks) {
    if (c.h.type === "batch") { for (const r of c.h.runs) iv.push([r[0], r[0] + r[1]]); maxBatch = Math.max(maxBatch, (c.h.len + 7) & ~7); }
    if (c.h.type === "tex" && c.h.content?.depth) for (const L of c.h.content.levels) maxDepth = Math.max(maxDepth, L.w * L.h * 4);
  }
  iv.sort((a, b) => a[0] - b[0]);
  const starts: number[] = [], ends: number[] = [], ranks: number[] = [];
  let npages = 0;
  for (const [a, b] of iv) {
    const k = starts.length - 1;
    if (k >= 0 && a <= ends[k]) { if (b > ends[k]) { npages += b - ends[k]; ends[k] = b; } }
    else { starts.push(a); ends.push(b); ranks.push(npages); npages += b - a; }
  }
  const BASE = 65536, batchAt = BASE + npages * CAP_PAGE, depthAt = batchAt + maxBatch + 4096, scratchAt = depthAt + ((maxDepth + 4095) & ~4095), total = scratchAt + 65536;
  const memory = { buffer: new ArrayBuffer(total) }, u8 = new Uint8Array(memory.buffer), words = new Uint32Array(memory.buffer, 0, total >> 2), dv = new DataView(memory.buffer);
  const pageAt = (pg: number): number => {
    let lo = 0, hi = starts.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (pg < starts[m]) hi = m - 1; else if (pg >= ends[m]) lo = m + 1; else return BASE + (ranks[m] + pg - starts[m]) * CAP_PAGE; }
    return 0;
  };
  const xlate = (a: number): number => { const at = a ? pageAt(Math.floor(a / CAP_PAGE)) : 0; return at ? at + a % CAP_PAGE : 0; };
  const h = makeHost(memory, l => log.push(l));
  const x = {
    gfx_hash: (a: number, n: number) => { let v = 0x811c9dc5; const e = a + n; let i = a; for (; i < e && (i & 3); i++) v = Math.imul(v ^ u8[i], 0x01000193); for (; i + 4 <= e; i += 4) { v = Math.imul(v ^ words[i >> 2], 0x01000193); v ^= v >>> 13; } for (; i < e; i++) v = Math.imul(v ^ u8[i], 0x01000193); return v >>> 0; },
    gfx_sampler_table: () => xlate(meta.samplerTable) || scratchAt, gfx_scratch: () => scratchAt, gfx_flush: () => {}, gfx_host_caps: () => {}, gfx_pipeline_done: () => {}, gfx_fence_signal: () => {}, gfx_fence_done: () => 1,
    gfx_image_event: () => {}, gfx_report_land: () => {}, gfx_reports_flush: () => {}, gfx_device_lost: () => {}, gfx_device_restored: () => 0, gfx_watch_key: () => {}, gfx_shader_pending: () => 0, gfx_shader_waited: () => 0,
    gfx_shader_register: () => -1, gfx_stat: () => 0,
  };
  h.attach(x);
  if (h.caps !== meta.caps) notes.push(`this device's host caps are ${h.caps}, the capture's ${meta.caps} (1 ASTC, 2 16-bit normalized formats): textures of formats the recorder converted for the capturing device may not match`);
  const missing = (meta.features as string[]).filter(f => !h.device.features?.has?.(f));
  if (missing.length) notes.push(`features the capturing device had and this one lacks: ${missing.join(", ")}`);
  h.fix = meta.fix.slice(); h.uniformArena = meta.uniformArena;
  let shrunk = 0;
  const pendingPipes: { id: number; key: number }[] = [], texFmt = (serial: number): NvnFormat | undefined => h.textures.get(serial)?.fmt, live = new Map<number, { head: any; data: Uint8Array }>();
  const compare = (f: ReplayFrame) => {
    const l = live.get(f.n);
    if (!l || !f.data) return;
    if (!l.head.width) { f.live = "none"; f.note = `no live image in the capture (${l.head.why})`; return; }
    if (l.head.width !== f.width || l.head.height !== f.height || l.head.bpp !== f.bytesPerPixel) { f.live = "differs"; f.differing = f.width * f.height; f.note = `the live image was ${l.head.width}x${l.head.height} ${l.head.format}`; return; }
    let d = 0; const a = f.data, b = l.data, bpp = f.bytesPerPixel;
    for (let i = 0, n = f.width * f.height; i < n; i++) for (let k = 0; k < bpp; k++) if (a[i * bpp + k] !== b[i * bpp + k]) { d++; break; }
    f.live = d ? "differs" : "same"; f.differing = d;
  };
  // ---- ReplayOptions.repeat ----
  interface RepBatch { pages: [number, Uint8Array][]; body: Uint8Array | null; segs: [number, number][] }
  const rp = opts.repeat, repBatches: RepBatch[] = [], repPre = new Map<number, Uint8Array>();
  let repTex: Map<number, any> | null = null;
  const repeatFrame = async () => {
    const settle = async () => { await h.landed(); try { await h.device.queue.onSubmittedWorkDone(); } catch { /* a lost device says so in the log */ } };
    const once = (hook?: (op: number, ms: number) => void): number => {
      // the textures as the frame found them: the ones it made are destroyed (by records, as the stream would), the ones it destroyed are known again
      const made = [...h.textures.keys()].filter((s: number) => !repTex!.has(s));
      for (let i = 0; i < made.length; i++) { const q = batchAt + i * 16; dv.setUint32(q, H.TEX_DESTROY, true); dv.setUint32(q + 4, 16, true); dv.setUint32(q + 8, made[i] >>> 0, true); dv.setUint32(q + 12, Math.floor(made[i] / 4294967296), true); h.exec(q, 16); }
      for (const [s, t] of repTex!) if (!h.textures.has(s)) h.textures.set(s, { ...t, views: new Map() });
      for (const [pg, bytes] of repPre) u8.set(bytes, pageAt(pg));
      // Memory went back to the frame's start: every upload is checked again. Between the batches it changes as it did under the live replayer, which
      // looks again only where the stream says so (a submission's end, H_MEM_DIRTY, a read-back landing): the same here, so the hashing is the game's
      h.dropUploads();
      let ms = 0;
      for (const b of repBatches) {
        for (const [at, bytes] of b.pages) u8.set(bytes, at);
        u8.set(b.body!, batchAt);
        for (const [off, len] of b.segs) {
          if (!hook) { const t = performance.now(); h.exec(batchAt + off, len); ms += performance.now() - t; continue; }
          for (let p = batchAt + off, end = p + len; p < end;) { const op = dv.getUint32(p, true), size = dv.getUint32(p + 4, true), t = performance.now(); h.exec(p, size); const d = performance.now() - t; ms += d; hook(op, d); p += size; }
        }
      }
      return ms;
    };
    let records = 0;
    for (const b of repBatches) { const bd = new DataView(b.body!.buffer); for (const [off, len] of b.segs) for (let p = off; p < off + len; p += bd.getUint32(p + 4, true)) records++; }
    await settle();
    await rp!.run({ host: h, batches: repBatches.length, records, once, settle });
    await settle();
  };
  for (let ci = 0; ci < index.chunks.length; ci++) {
    const c = index.chunks[ci], hd = c.h;
    if (h.lost) {      // nothing more can be drawn: say where it happened and stop
      const before = index.chunks.slice(Math.max(0, ci - 3), ci).map(x => x.h.type === "tex" ? `tex#${x.h.serial} ${x.h.gpuFormat} ${x.h.width}x${x.h.height}x${x.h.depth} target ${x.h.target} levels ${x.h.levels}${x.h.content ? "" : " (no contents)"}` : x.h.type === "batch" ? `batch ${x.h.i}` : x.h.type).join("; ");
      log.push(`[RED] replay: the device was lost by chunk ${ci} of ${index.chunks.length} (frame ${frames.length}); the chunks before it: ${before}. Stopped`);
      break;
    }
    if (hd.type === "shader") { const info = JSON.parse(JSON.stringify(hd.info), (_k, v) => v && typeof v === "object" && Array.isArray(v.__u8) ? Uint8Array.from(v.__u8) : v); h.shaders[hd.id] = { key: hd.key, info: opts.shader?.(hd.key, info) ?? info }; }
    else if (hd.type === "pipe") pendingPipes.push({ id: hd.id, key: hd.key });
    else if (hd.type === "tex") {
      const fmt = hostFormat(hd.format, h.caps);
      let cut = 0, tw = hd.width, th = hd.height;
      if (opts.texMax && hd.content && hd.levels > 1 && hd.target !== 2 && fmt) {
        while (cut < hd.levels - 1 && cut < hd.content.levels.length - 1 && Math.max(hd.width >> cut, hd.height >> cut) > opts.texMax) cut++;
        if (cut) { tw = hd.content.levels[cut].w * fmt.bw; th = hd.content.levels[cut].h * fmt.bh; shrunk++; }
      }
      h.textures.set(hd.serial, { serial: hd.serial, target: hd.target, format: hd.format, flags: hd.flags, samples: hd.samples, width: tw, height: th, depth: hd.depth, levels: hd.levels - cut, swz: hd.swz, views: new Map(), fmt });
      if (!hd.content) continue;
      if (fmt?.tex !== hd.gpuFormat) { log.push(`[RED] replay: tex#${hd.serial} was ${hd.gpuFormat} on the capturing device and is ${fmt?.tex} here: its contents are not restored`); continue; }
      const t = h.texture(hd.serial), data = await payload(ci);
      if (!t?.gpu) continue;
      const g = t.gpu;
      hd.content.levels.forEach((L: Level, cl: number) => {
        const l = cl - cut;
        if (l < 0 || l >= g.mipLevelCount) return;
        if (cut && (Math.ceil(Math.max(1, g.width >> l) / fmt!.bw) !== L.w || Math.ceil(Math.max(1, g.height >> l) / fmt!.bh) !== L.h)) return;      // a level whose size does not come out the same after the cut stays empty
        if (hd.content.depth) {
          // depth goes in as a draw a layer (GfxHost.depthData reads f32 rows from memory)
          for (let z = 0; z < L.d; z++) {
            const f = new Float32Array(memory.buffer, depthAt, L.w * L.h), src = new DataView(data.buffer, data.byteOffset + L.off + z * L.row * L.h, L.row * L.h);
            for (let y = 0; y < L.h; y++) for (let xx = 0; xx < L.w; xx++) f[y * L.w + xx] = hd.content.bpb === 2 ? src.getUint16(y * L.row + xx * 2, true) / 65535 : src.getFloat32(y * L.row + xx * 4, true);
            h.depthData(t, l, z, 0, 0, L.w, L.h, depthAt, L.w * 4);
          }
        } else h.device.queue.writeTexture({ texture: g, mipLevel: l }, data, { offset: L.off, bytesPerRow: L.row, rowsPerImage: L.h }, { width: L.w * fmt!.bw, height: L.h * fmt!.bh, depthOrArrayLayers: L.d });
      });
    } else if (hd.type === "frame") {
      live.set(hd.n, { head: hd, data: hd.width ? await payload(ci) : new Uint8Array(0) });
      if (hd.width) await opts.onLive?.(hd.n, hd, live.get(hd.n)!.data);
      const f = frames.find(fr => fr.n === hd.n);
      if (f) { compare(f); if (!opts.keepData) f.data = null; }
      if (!opts.keepData) live.delete(hd.n);
    } else if (hd.type === "batch") {
      const data = await payload(ci), n = hd.len, body = (n + 7) & ~7;
      let o = body;
      const cur: RepBatch = { pages: [], body: null, segs: [] };
      for (const [pg, count] of hd.runs as [number, number][]) {
        const at = pageAt(pg), bytes = data.subarray(o, o + count * CAP_PAGE);
        if (rp && frames.length === rp.frame) {      // the frame to repeat: what its pages held before it, and what each batch brings
          for (let i = 0; i < count; i++) if (!repPre.has(pg + i)) repPre.set(pg + i, u8.slice(at + i * CAP_PAGE, at + (i + 1) * CAP_PAGE));
          cur.pages.push([at, bytes]);
        }
        u8.set(bytes, at); o += count * CAP_PAGE;
      }
      u8.set(data.subarray(0, n), batchAt);
      for (const p of pendingPipes.splice(0)) {
        const k = xlate(p.key);
        try { if (k) h.createPipeline(p.id, k); else log.push(`[RED] replay: the key record of pipeline ${p.id} is not in the capture`); }
        catch (e: any) { log.push(`[RED] replay: pipeline ${p.id} could not be requested: ${e?.message ?? e}`); }
      }
      h.dropUploads();       // memory changed under the replayer
      // addresses to the replay's layout; executed up to each present, whose image is read then
      let from = batchAt;
      for (let p = batchAt, end = batchAt + n; p < end;) {
        const op = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
        if (!size) break;
        for (const [fo, , narrow] of addressFields(op, dv, p, texFmt)) {
          const a = narrow ? dv.getUint32(p + fo, true) : u64(dv, p + fo), b = xlate(a);
          if (narrow) dv.setUint32(p + fo, b, true); else { dv.setUint32(p + fo, b, true); dv.setUint32(p + fo + 4, 0, true); }
        }
        const flip = op === H.PRESENT && (dv.getUint32(p + 44, true) & 1) !== 0;
        p += size;
        if (op === H.PRESENT || p >= end) {
          const rep = !!rp && frames.length === rp.frame;
          if (rep) {      // (the pipeline creations of the frame are not repeated)
            if (!repTex) repTex = new Map([...h.textures].map(([s, t]: [number, any]) => [s, { ...t, gpu: undefined, snap: undefined, imgScratch: undefined, shapes: undefined }]));
            for (let q = from, a = from; q < p;) { const qs = dv.getUint32(q + 4, true), pc = dv.getUint32(q, true) === H.PIPELINE_CREATE; if (pc && q > a) cur.segs.push([a - batchAt, q - a]); q += qs; if (pc) a = q; else if (q >= p) cur.segs.push([a - batchAt, q - a]); }
          }
          h.exec(from, p - from); from = p;
          if (op !== H.PRESENT) continue;
          await h.landed();
          const fr: ReplayFrame = { n: frames.length, serial: h.lastPresented, width: 0, height: 0, bytesPerPixel: 0, format: "", flip, reds: h.frameReds?.() ?? [], data: null, line: h.ledger.lastLine ?? "", live: "none", differing: 0, note: "" };
          if (opts.noReadback) fr.note = "not read back";
          else try { const r = await h.readTexture(h.lastPresented); fr.width = r.width; fr.height = r.height; fr.bytesPerPixel = r.bytesPerPixel; fr.data = r.data; fr.format = h.textures.get(h.lastPresented)?.fmt?.tex ?? ""; }
          catch (e: any) { fr.note = `the presented image could not be read: ${e?.message ?? e}`; }
          frames.push(fr);
          await opts.onFrame?.(fr);
          for (const serial of opts.dump ?? []) {
            const t = h.textures.get(serial);
            if (!t?.gpu) continue;
            try { const r = await h.readTexture(serial); let nz = 0; for (let i = 0; i < r.data.length; i += r.bytesPerPixel) for (let k = 0; k < r.bytesPerPixel; k++) if (r.data[i + k]) { nz++; break; }
              await opts.onDump?.({ frame: fr.n, serial, width: r.width, height: r.height, format: t.fmt.tex, data: r.data, nonZero: nz, note: "" }); }
            catch (e: any) { await opts.onDump?.({ frame: fr.n, serial, width: 0, height: 0, format: t.fmt?.tex ?? "", data: new Uint8Array(0), nonZero: 0, note: String(e?.message ?? e) }); }
          }
          if (rep) {
            const whole = u8.slice(batchAt, batchAt + n);      // the batch as it stands (addresses rewritten up to here): put back after the repeats
            cur.body = whole; repBatches.push({ ...cur }); cur.segs = [];
            await repeatFrame();
            u8.set(whole, batchAt);
          }
        }
      }
      if (cur.segs.length) { cur.body = u8.slice(batchAt, batchAt + n); repBatches.push(cur); }
    }
  }
  await h.landed();
  try { await h.device.queue.onSubmittedWorkDone(); } catch { /* a lost device says so in the log */ }
  await new Promise(r => setTimeout(r, 50));       // pipelines that fail asynchronously say so
  if (shrunk) notes.push(`${shrunk} textures were made without their top levels (no side over ${opts.texMax})`);
  const counts = new Map<string, number>();
  for (const l of log) if (l.includes("[RED]")) counts.set(l, (counts.get(l) ?? 0) + 1);
  return { host: h, frames, log, errors: [...counts].sort((a, b) => b[1] - a[1]), notes, stats: { ...h.stats }, ms: Math.round(performance.now() - t0) };
}
