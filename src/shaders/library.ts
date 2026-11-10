// The nxweb shader library: one file that maps a stage's key to its WGSL and its reflection record.
// Plain TypeScript, no Node or browser API beyond TextEncoder / TextDecoder: the offline build writes it (tools/shaders/build_lib.mts), the page reads it.
//
// File (little endian):
//   +0   "NXSL"            magic
//   +4   u32 version       1
//   +8   u32 count         entries
//   +12  u32 metaLength    bytes of a UTF-8 JSON object after the index: { chain: "<what built it>", ... }, free-form, for people and for cache invalidation
//   +16  count x 24 bytes  the index, sorted by key as an unsigned 64-bit little-endian number:
//          +0  8 bytes  key: sha256(control section + code area)[0..8], the bytes in digest order (src/gfx/shader.ts shaderKey; hex of these 8 bytes = keyHex)
//          +8  u32      stage: 0 vertex, 1 fragment, 2 compute
//          +12 u32      offset of the entry's payload from the start of the file
//          +16 u32      wgslLength: bytes of UTF-8 WGSL at the offset
//          +20 u32      reflLength: bytes of UTF-8 JSON (a Reflection) right after the WGSL
//   then the meta JSON, then the payloads.
// Nothing is compressed: a library is served with HTTP compression, and an entry can be fetched alone with a Range request once the index is known.

export interface Reflection {
  // the record src/gfx asks for (src/gfx/README.md, "what the shader chain must emit", item 5): GfxHost.registerShader(key, { wgsl, ...reflection })
  stage: "vertex" | "fragment" | "compute";
  entry: string;
  ubos: number[];                                                        // game uniform slots read
  // `handle`: a bindless texture. `slot` is then only where its binding is; the host reads the handle (texture ID | sampler ID << 20) from the word at byte
  // `offset` of game uniform slot `ubo` at each draw; `sampler`: a second word ORed in, or a constant sampler ID (src/gfx/README.md "Bindless textures")
  textures: { slot: number; dim: "2d" | "2d-array" | "cube" | "3d" | "cube-array"; depth: boolean; handle?: { ubo: number; offset: number; sampler?: { ubo: number; offset: number } | { id: number } } }[];
  attributes?: number[];                                                 // vertex: locations read
  outputs?: number[];                                                    // fragment: colour targets written
  fixup: boolean;                                                        // vertex: reads the position fix-up at @group(2) @binding(0)
  // more than src/gfx reads today (tools/shaders/README.md, "What src/gfx must change"):
  uboSize: Record<string, number>;                                       // slot -> bytes the WGSL type covers: the host binds at least this, zero-filled past what the game bound
  attributeTypes?: Record<string, "float" | "sint" | "uint">;            // vertex: the class each input is declared with
  outputTypes?: Record<string, "float" | "sint" | "uint">;
  extra: { kind: string; group: number; binding: number; size?: number; bank?: number }[];   // bindings that are not a game uniform slot, a texture slot or the fix-up
  notes: string[];                                                       // what the translation lost or assumed
}
export interface Entry { key: string; stage: number; wgsl: string; reflection: Reflection }

const MAGIC = 0x4c53584e, HEAD = 16, ROW = 24;
const hexKey = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
const keyBytes = (hex: string) => { if (!/^[0-9a-f]{16}$/.test(hex)) throw new Error(`shader key "${hex}" is not 16 lowercase hex digits`); return Uint8Array.from(hex.match(/../g)!, h => parseInt(h, 16)); };
const order = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
export const STAGES = ["vertex", "fragment", "compute"] as const;

export function writeLibrary(entries: { key: string; wgsl: string; reflection: Reflection }[], meta: Record<string, unknown> = {}): Uint8Array {
  const enc = new TextEncoder();
  const rows = entries.map(e => ({ key: keyBytes(e.key), stage: STAGES.indexOf(e.reflection.stage), wgsl: enc.encode(e.wgsl), refl: enc.encode(JSON.stringify(e.reflection)), hex: e.key }));
  rows.sort((a, b) => (order(a.key) < order(b.key) ? -1 : order(a.key) > order(b.key) ? 1 : 0));
  for (let i = 1; i < rows.length; i++) if (rows[i].hex === rows[i - 1].hex) throw new Error(`shader key ${rows[i].hex} twice in one library`);
  const metaBytes = enc.encode(JSON.stringify(meta));
  let size = HEAD + rows.length * ROW + metaBytes.length;
  const offsets = rows.map(r => { const o = size; size += r.wgsl.length + r.refl.length; return o; });
  if (size > 0xffffffff) throw new Error("a library past 4 GB: split it");
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, 1, true); dv.setUint32(8, rows.length, true); dv.setUint32(12, metaBytes.length, true);
  rows.forEach((r, i) => {
    const p = HEAD + i * ROW;
    out.set(r.key, p); dv.setUint32(p + 8, r.stage, true); dv.setUint32(p + 12, offsets[i], true); dv.setUint32(p + 16, r.wgsl.length, true); dv.setUint32(p + 20, r.refl.length, true);
    out.set(r.wgsl, offsets[i]); out.set(r.refl, offsets[i] + r.wgsl.length);
  });
  out.set(metaBytes, HEAD + rows.length * ROW);
  return out;
}

export class ShaderLibrary {
  readonly count: number;
  readonly meta: Record<string, unknown>;
  private dv: DataView;
  private dec = new TextDecoder("utf-8", { fatal: true });
  private bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    const dv = this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < HEAD || dv.getUint32(0, true) !== MAGIC) throw new Error("not a shader library (no NXSL magic)");
    if (dv.getUint32(4, true) !== 1) throw new Error(`shader library version ${dv.getUint32(4, true)}: this reader knows version 1`);
    this.count = dv.getUint32(8, true);
    const metaLen = dv.getUint32(12, true), metaAt = HEAD + this.count * ROW;
    if (metaAt + metaLen > bytes.length) throw new Error("shader library cut short (index or meta past the end)");
    for (let i = 0; i < this.count; i++) {
      const p = HEAD + i * ROW, o = dv.getUint32(p + 12, true), n = dv.getUint32(p + 16, true) + dv.getUint32(p + 20, true);
      if (o < metaAt + metaLen || o + n > bytes.length) throw new Error(`shader library entry ${i} lies outside the file`);
      if (dv.getUint32(p + 8, true) > 2) throw new Error(`shader library entry ${i} has stage ${dv.getUint32(p + 8, true)}`);
      if (i && dv.getBigUint64(p, true) <= dv.getBigUint64(p - ROW, true)) throw new Error("shader library index is not sorted by key");
    }
    this.meta = JSON.parse(this.dec.decode(bytes.subarray(metaAt, metaAt + metaLen)));
  }
  private row(keyHex: string): number {
    const want = order(keyBytes(keyHex));
    let lo = 0, hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, k = this.dv.getBigUint64(HEAD + mid * ROW, true);
      if (k === want) return mid;
      if (k < want) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }
  private at(i: number): Entry {
    const p = HEAD + i * ROW, o = this.dv.getUint32(p + 12, true), nw = this.dv.getUint32(p + 16, true), nr = this.dv.getUint32(p + 20, true);
    return { key: hexKey(this.bytes.subarray(p, p + 8)), stage: this.dv.getUint32(p + 8, true), wgsl: this.dec.decode(this.bytes.subarray(o, o + nw)),
      reflection: JSON.parse(this.dec.decode(this.bytes.subarray(o + nw, o + nw + nr))) };
  }
  has(keyHex: string): boolean { return this.row(keyHex) >= 0; }
  get(keyHex: string): Entry | undefined { const i = this.row(keyHex); return i < 0 ? undefined : this.at(i); }
  keys(): string[] { return Array.from({ length: this.count }, (_, i) => hexKey(this.bytes.subarray(HEAD + i * ROW, HEAD + i * ROW + 8))); }
  *entries(): Generator<Entry> { for (let i = 0; i < this.count; i++) yield this.at(i); }
  // Every entry into a GfxHost-shaped registry: host.registerShader(key, { stage, wgsl, entry, ubos, textures, attributes | outputs, fixup }). Compute entries and
  // entries with bindings the host does not know (`extra`) are returned, not registered
  registerAll(host: { registerShader(key: string, info: any): number }): { registered: number; skipped: { key: string; why: string }[] } {
    let registered = 0; const skipped: { key: string; why: string }[] = [];
    for (const e of this.entries()) {
      const r = e.reflection;
      if (r.stage === "compute") { skipped.push({ key: e.key, why: "compute stage" }); continue; }
      if (r.extra.length) { skipped.push({ key: e.key, why: `bindings src/gfx does not provide: ${r.extra.map(x => x.kind).join(", ")}` }); continue; }
      if (host.registerShader(e.key, { ...r, wgsl: e.wgsl }) < 0) skipped.push({ key: e.key, why: "registerShader refused it" }); else registered++;
    }
    return { registered, skipped };
  }
}
