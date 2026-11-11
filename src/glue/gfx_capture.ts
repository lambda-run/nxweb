// nxweb graphics glue: the frame-capture aid of the replayer (GfxHost.captureFrame). One frame's host stream as readable
// text (pass boundaries, pipeline keys, bindings, draws, copies), and a PNG encoder for the render targets read back
// after each pass. After nxnative's DM_NVN_PASSDUMP: one line a pass or event with a letter in front, details indented.
// Browser or Node code; no decisions about rendering are made here.
import { NVN_FORMATS, COMPARE, BLEND_EQ, BLEND_FUNC, TOPOLOGY } from "./gfx_formats.ts";

export interface CaptureImage { name: string; pass: number; target: string; serial: number; width: number; height: number; format: string; png: Uint8Array }
export interface Capture { text: string; images: CaptureImage[]; passes: number; draws: number; dispatches: number; records: number }
export interface CaptureCtx { shaderKey(id: number): string; texture(serial: number): string }

const OPS: Record<number, string> = { 1: "TEX_CREATE", 2: "TEX_DESTROY", 3: "BEGIN_PASS", 4: "END_PASS", 5: "VIEWPORT", 6: "SCISSOR", 7: "PIPELINE_CREATE", 8: "PIPELINE", 9: "VBUF", 10: "UBO", 11: "TEX",
  12: "BLEND_COLOR", 13: "STENCIL_REF", 14: "DRAW", 15: "DRAW_IDX", 16: "CLEAR_RECT", 17: "COPY_B2T", 18: "COPY_T2T", 19: "SNAPSHOT", 20: "PRESENT", 21: "FENCE", 22: "FLUSH", 23: "MEM_DIRTY", 24: "TEX_DATA",
  25: "COPY_T2B", 26: "FIXUP", 27: "UBO_DATA", 28: "SSBO", 29: "IMG", 30: "BEGIN_COMPUTE", 31: "DISPATCH", 32: "BUF_READBACK",
  35: "MESH_BEGIN", 36: "MESH_TASK", 37: "MESH_RUN", 38: "MESH_DRAW", 39: "CLEAR_TEX", 40: "DISPATCH_SKIPPED", 41: "SKIP" };
const STAGE = ["vs", "fs", "cs"], PRIMS = ["points", "lines", "line loop", "line strip", "triangles", "triangle strip", "triangle fan", "quads", "quad strip", "polygon"];
const hex = (v: number) => "0x" + v.toString(16);
const u64 = (dv: DataView, p: number) => dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
const f32s = (dv: DataView, p: number, n: number) => Array.from({ length: n }, (_, i) => +dv.getFloat32(p + i * 4, true).toFixed(4)).join(", ");
const i32s = (dv: DataView, p: number, n: number) => Array.from({ length: n }, (_, i) => dv.getInt32(p + i * 4, true)).join(", ");
const fmtName = (f: number) => NVN_FORMATS[f]?.tex ?? `format ${hex(f)}`;

// The pipeline key record (src/gfx/pipeline.ts) as text
export function describeKey(dv: DataView, k: number, ctx: CaptureCtx): string {
  const prim = dv.getUint8(k + 4);
  if (prim === 0xff) return `compute cs ${ctx.shaderKey(dv.getUint16(k + 2, true))}`;
  const ncolor = dv.getUint8(k + 10), flags = dv.getUint8(k + 21), cull = dv.getUint8(k + 5), blendEn = dv.getUint8(k + 22), chmask = dv.getUint32(k + 28, true);
  const out: string[] = [`vs ${ctx.shaderKey(dv.getUint16(k, true))} fs ${ctx.shaderKey(dv.getUint16(k + 2, true))}`,
    `${TOPOLOGY[prim] ?? `prim ${prim}`}${dv.getUint8(k + 25) ? ` strip index u${dv.getUint8(k + 25) === 3 ? 32 : 16}` : ""}, cull ${["none", "front", "back", "both"][cull]}, front ${dv.getUint8(k + 6) ? "ccw" : "cw"}, samples ${dv.getUint8(k + 9)}${flags & 1 ? ", depth clamp" : ""}${flags & 2 ? ", vertex input variant" : ""}${dv.getUint8(k + 20) ? ", alpha to coverage" : ""}`];
  for (let i = 0; i < ncolor; i++) {
    const f = dv.getUint8(k + 12 + i);
    if (!f) { out.push(`color${i} none`); continue; }
    let s = `color${i} ${fmtName(f)} mask ${hex((chmask >>> (4 * i)) & 15)}`;
    if ((blendEn >> i) & 1) {
      const b = dv.getBigUint64(k + 40 + i * 8, true), fld = (sh: number, w: number) => Number((b >> BigInt(sh)) & ((1n << BigInt(w)) - 1n));
      s += ` blend rgb ${BLEND_EQ[fld(31, 3)]}(${BLEND_FUNC[fld(3, 7)]}, ${BLEND_FUNC[fld(10, 7)]}) alpha ${BLEND_EQ[fld(34, 3)]}(${BLEND_FUNC[fld(17, 7)]}, ${BLEND_FUNC[fld(24, 7)]})`;
    }
    out.push(s);
  }
  const df = dv.getUint8(k + 11);
  if (df) {
    const ds = dv.getBigUint64(k + 32, true), fld = (sh: number, w: number) => Number((ds >> BigInt(sh)) & ((1n << BigInt(w)) - 1n));
    out.push(`depth ${fmtName(df)} ${fld(0, 1) ? `test ${COMPARE[fld(2, 4)]}${fld(1, 1) ? " write" : ""}` : "no test"}${fld(6, 1) ? `, stencil front ${COMPARE[fld(7, 4)]} back ${COMPARE[fld(11, 4)]} masks ${hex(dv.getUint8(k + 23))}/${hex(dv.getUint8(k + 24))}` : ""}${dv.getUint8(k + 8) ? `, offset ${f32s(dv, k + 104, 3)}` : ""}`);
  }
  const attrs: string[] = [];
  for (let loc = 0, m = dv.getUint32(k + 116, true); m; loc++, m >>>= 1) {
    if (!(m & 1)) continue;
    const a = dv.getUint32(k + 120 + loc * 4, true), st = a >>> 27;
    attrs.push(`loc${loc} ${NVN_FORMATS[a & 0xff]?.vtx ?? `format ${hex(a & 0xff)}`}@${(a >>> 8) & 0x7ffff} stream ${st} (stride ${dv.getUint32(k + 248 + st * 8, true)}${dv.getUint32(k + 252 + st * 8, true) ? `, divisor ${dv.getUint32(k + 252 + st * 8, true)}` : ""})`);
  }
  if (attrs.length) out.push(`attributes ${attrs.join("; ")}`);
  return out.join("\n      ");
}
function view(dv: DataView, p: number): string {
  const b = dv.getUint8(p), s: string[] = [];
  if (b & 1) s.push(`levels ${dv.getUint8(p + 2)}+${dv.getUint8(p + 3)}`);
  if (b & 2) s.push(`layers ${dv.getUint16(p + 6, true)}+${dv.getUint16(p + 8, true)}`);
  if (b & 4) s.push(`format ${fmtName(dv.getUint16(p + 4, true))}`);
  if (b & 8) s.push(`target ${dv.getUint8(p + 1)}`);
  if (b & 16) s.push("swizzle");
  return s.length ? ` view(${s.join(", ")})` : " view()";
}
// One host record (src/gfx/hostops.ts) as a line; `state` counts passes and draws across the frame
export function describeRecord(op: number, dv: DataView, p: number, ctx: CaptureCtx, state: { pass: number; draws: number; inPass: number }): string {
  const tex = (o: number) => ctx.texture(u64(dv, p + o));
  switch (op) {
    case 1: return `T create tex#${u64(dv, p + 8)} ${fmtName(dv.getInt32(p + 20, true))} ${dv.getUint32(p + 32, true)}x${dv.getUint32(p + 36, true)}${dv.getUint32(p + 40, true) > 1 ? `x${dv.getUint32(p + 40, true)}` : ""} target ${dv.getInt32(p + 16, true)} levels ${dv.getUint32(p + 44, true)}${dv.getInt32(p + 28, true) > 1 ? ` samples ${dv.getInt32(p + 28, true)}` : ""}`;
    case 2: return `T destroy tex#${u64(dv, p + 8)}`;
    case 3: {
      const n = dv.getUint32(p + 8, true), flags = dv.getUint32(p + 12, true), parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const o = p + 32 + i * 40;
        if (!u64(dv, o)) { parts.push(`color${i} none`); continue; }
        parts.push(`color${i} ${ctx.texture(u64(dv, o))} as ${fmtName(dv.getUint32(o + 16, true))} level ${dv.getUint32(o + 8, true)} layer ${dv.getUint32(o + 12, true)} ${dv.getUint32(o + 20, true) ? `clear(${f32s(dv, o + 24, 4)})` : "load"}`);
      }
      if (flags & 1) parts.push(`depth ${ctx.texture(u64(dv, p + 352))} level ${dv.getUint32(p + 360, true)} layer ${dv.getUint32(p + 364, true)} ${flags & 2 ? `clear ${+dv.getFloat32(p + 16, true).toFixed(5)}` : "load"}${flags & 4 ? ` stencil clear ${dv.getUint32(p + 20, true)}` : ""}`);
      state.inPass = 0;
      return `P ${++state.pass} begin ${dv.getUint32(p + 24, true)}x${dv.getUint32(p + 28, true)}\n    ${parts.join("\n    ")}`;
    }
    case 4: return `P ${state.pass} end (${state.inPass} draws or dispatches)`;
    case 5: return `    viewport ${f32s(dv, p + 8, 4)} depth ${f32s(dv, p + 24, 2)}`;
    case 6: return `    scissor ${i32s(dv, p + 8, 4)}`;
    case 7: return `K pipeline ${dv.getUint32(p + 8, true)} requested\n      ${describeKey(dv, dv.getUint32(p + 12, true), ctx)}`;
    case 8: return `    pipeline ${dv.getUint32(p + 8, true)}`;
    case 9: return `    vbuf stream ${dv.getUint32(p + 8, true)} ${hex(u64(dv, p + 16))}+${dv.getUint32(p + 12, true)}`;
    case 10: return `    ubo ${STAGE[dv.getUint32(p + 8, true)]}[${dv.getUint32(p + 12, true)}] ${hex(u64(dv, p + 16))}+${dv.getUint32(p + 24, true)}${dv.getUint32(p + 28, true) ? ` (the shader's block is ${dv.getUint32(p + 28, true)} bytes)` : ""}`;
    case 11: { const f = dv.getUint32(p + 24, true); return `    tex ${STAGE[dv.getUint32(p + 8, true)]}[${dv.getUint32(p + 12, true)}] ${u64(dv, p + 16) ? tex(16) : "none"} sampler ${dv.getUint32(p + 28, true)}${f & 1 ? " (snapshot)" : ""}${f & 2 ? view(dv, p + 32) : ""}`; }
    case 12: return `    blend colour ${f32s(dv, p + 8, 4)}`;
    case 13: return `    stencil reference ${dv.getUint32(p + 8, true)}`;
    case 14: { state.draws++; state.inPass++; const conv = dv.getUint32(p + 24, true); return `  D draw first ${dv.getUint32(p + 8, true)} count ${dv.getUint32(p + 12, true)} instances ${dv.getUint32(p + 16, true)} base instance ${dv.getUint32(p + 20, true)}${conv ? ` (NVN ${PRIMS[conv]}, converted)` : ""}`; }
    case 15: { state.draws++; state.inPass++; const conv = dv.getUint32(p + 28, true); return `  D draw indexed u${[8, 16, 32][dv.getUint32(p + 8, true)]} @${hex(u64(dv, p + 32))} count ${dv.getUint32(p + 12, true)} instances ${dv.getUint32(p + 16, true)} base vertex ${dv.getInt32(p + 24, true)} base instance ${dv.getUint32(p + 20, true)}${conv ? ` (NVN ${PRIMS[conv]}, converted)` : ""}`; }
    case 16: return `  C clear rect ${dv.getUint32(p + 8, true) ? `depth-stencil mask ${hex(dv.getUint32(p + 16, true))} depth ${+dv.getFloat32(p + 20, true).toFixed(5)} stencil ${dv.getUint32(p + 24, true)}` : `color${dv.getUint32(p + 12, true)} mask ${hex(dv.getUint32(p + 16, true))} (${f32s(dv, p + 20, 4)})`} rect ${i32s(dv, p + 36, 4)}`;
    case 17: return `B copy buffer ${hex(u64(dv, p + 8))} -> ${tex(16)} level ${dv.getUint32(p + 24, true)} layer ${dv.getUint32(p + 28, true)} region ${i32s(dv, p + 32, 6)}`;
    case 18: return `B ${dv.getUint32(p + 88, true) & 0x40000000 ? "resolve" : "copy"} ${tex(8)} level ${dv.getUint32(p + 24, true)} layer ${dv.getUint32(p + 28, true)} region ${i32s(dv, p + 40, 6)} -> ${tex(16)} level ${dv.getUint32(p + 32, true)} layer ${dv.getUint32(p + 36, true)} region ${i32s(dv, p + 64, 6)}`;
    case 19: return `B snapshot ${tex(8)} (a draw samples its own target)`;
    case 20: return `S present ${tex(8)} window ${hex(dv.getUint32(p + 32, true))} image ${dv.getUint32(p + 36, true)} crop ${i32s(dv, p + 16, 4)}${dv.getUint32(p + 40, true) & 1 ? " flipped" : ""}`;
    case 21: return `F fence ${u64(dv, p + 8)}`;
    case 22: return "F flush (submit)";
    case 23: return "M guest memory changed under the stream (uploads dropped)";
    case 24: return `U texels ${tex(8)} level ${dv.getUint32(p + 16, true)} z ${dv.getUint32(p + 20, true)} at ${dv.getUint32(p + 48, true)},${dv.getUint32(p + 24, true)} ${dv.getUint32(p + 28, true)}x${dv.getUint32(p + 32, true)}x${dv.getUint32(p + 36, true)}${["", " (depth as f32)", " (stencil)"][dv.getUint32(p + 52, true)] ?? ""}`;
    case 25: return `B copy ${tex(16)} level ${dv.getUint32(p + 24, true)} layer ${dv.getUint32(p + 28, true)} region ${i32s(dv, p + 32, 6)} -> buffer ${hex(u64(dv, p + 8))} (read back)`;
    case 26: return `    fix-up (1, ysign, zscale, zoffset) = ${f32s(dv, p + 8, 4)}`;
    case 27: return `    ubo ${STAGE[dv.getUint32(p + 8, true)]}[${dv.getUint32(p + 12, true)}] ${dv.getUint32(p + 16, true)} bytes from the recorder${dv.getUint32(p + 12, true) === 14 ? " (support buffer)" : ""}`;
    case 28: return `    storage ${STAGE[dv.getUint32(p + 8, true)]}[${dv.getUint32(p + 12, true)}] ${hex(u64(dv, p + 16))}+${dv.getUint32(p + 24, true)}${dv.getUint32(p + 28, true) & 1 ? " written" : ""}`;
    case 29: { const f = dv.getUint32(p + 24, true); return `    image ${STAGE[dv.getUint32(p + 8, true)]}[${dv.getUint32(p + 12, true)}] ${u64(dv, p + 16) ? tex(16) : "none"}${f & 1 ? " written" : ""}${f & 2 ? view(dv, p + 32) : ""}`; }
    case 30: state.inPass = 0; return `P ${++state.pass} begin compute`;
    case 31: state.inPass++; return `  D dispatch pipeline ${dv.getUint32(p + 8, true)} groups ${i32s(dv, p + 12, 3)}`;
    case 41: {
      const kind = ["draw", "dispatch", "mesh draw"][dv.getUint8(p + 12)] ?? "draw", reason = ["shader", "program lacks the stage", "pipeline failed", "unsupported state", "render condition false"][dv.getUint32(p + 8, true)] ?? "?";
      const keys: string[] = [];
      for (let i = 0; i < 3; i++) if (dv.getUint32(p + 16 + i * 8, true) || dv.getUint32(p + 20 + i * 8, true)) { let k = ""; for (let b = 0; b < 8; b++) k += dv.getUint8(p + 16 + i * 8 + b).toString(16).padStart(2, "0"); keys.push(`${k} ${["unknown", "pending", "failed"][dv.getUint8(p + 13 + i)] ?? "?"}`); }
      return `  X ${kind} skipped: ${reason}${keys.length ? ` (${keys.join(", ")})` : ""}`;
    }
    case 32: return `B read back storage ${hex(u64(dv, p + 8))}+${dv.getUint32(p + 16, true)} into guest memory`;
  }
  if (op === 35) { const f = dv.getUint32(p + 8, true); state.inPass = 0; return `P ${++state.pass} begin compute: mesh draw, mesh shader #${dv.getUint32(p + 32, true)}${f & 2 ? ` after task shader #${dv.getInt32(p + 36, true)}` : ""}, ${f & 1 ? `indirect {count, first} at ${hex(u64(dv, p + 24))}` : `${dv.getUint32(p + 16, true)} workgroups from ${dv.getUint32(p + 12, true)}`}`; }
  if (op === 36) { state.inPass++; return `  D task shader: pipeline ${dv.getUint32(p + 8, true)}, grid from the counts (on the GPU)`; }
  if (op === 37) { state.inPass++; return `  D mesh shader: pipeline ${dv.getUint32(p + 8, true)}, grid from the counts (on the GPU), into the output slots\nP ${state.pass} end (${state.inPass} draws or dispatches)`; }
  if (op === 38) { state.draws++; state.inPass++; return `  D draw the mesh output slots (indirect, vertex count from the GPU) pipeline ${dv.getUint32(p + 8, true)}`; }
  if (op === 33) return `Q report #${dv.getUint32(p + 8, true)}`;
  if (op === 34) return "Q the reports so far land when this segment is done";
  return `? ${OPS[op] ?? `op ${op}`}`;
}

// ---- PNG (8-bit RGBA, stored deflate blocks: no compression library needed) ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array, from: number, to: number): number { let c = 0xffffffff; for (let i = from; i < to; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function png(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const blocks = Math.max(1, Math.ceil(raw.length / 65535)), z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0, a = 1, b = 0;
  z[o++] = 0x78; z[o++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const from = i * 65535, n = Math.min(65535, raw.length - from);
    z[o++] = i === blocks - 1 ? 1 : 0; z[o++] = n & 0xff; z[o++] = n >> 8; z[o++] = ~n & 0xff; z[o++] = (~n >> 8) & 0xff;
    z.set(raw.subarray(from, from + n), o); o += n;
  }
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  z[o++] = b >> 8; z[o++] = b & 0xff; z[o++] = a >> 8; z[o++] = a & 0xff;
  const out = new Uint8Array(8 + 25 + 12 + z.length + 12), dv = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let p = 8;
  const chunk = (type: string, data: Uint8Array) => {
    dv.setUint32(p, data.length); for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8); dv.setUint32(p + 8 + data.length, crc32(out, p + 4, p + 8 + data.length)); p += 12 + data.length;
  };
  const ihdr = new Uint8Array(13), hd = new DataView(ihdr.buffer);
  hd.setUint32(0, width); hd.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 6;
  chunk("IHDR", ihdr); chunk("IDAT", z); chunk("IEND", new Uint8Array(0));
  return out;
}
// Texels as read back from a texture of a WebGPU format to RGBA8 for the PNG (values as stored: no sRGB conversion,
// floats clamped to 0..1, depth as grey). null for a format that is not handled
export function toRgba8(format: string, data: Uint8Array, n: number): Uint8Array | null {
  const out = new Uint8Array(n * 4), dv = new DataView(data.buffer, data.byteOffset, data.byteLength), c8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const half = (h: number) => { const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1; return s * (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15)); };
  switch (format.replace("-srgb", "")) {
    case "rgba8unorm": out.set(data.subarray(0, n * 4)); return out;
    case "bgra8unorm": for (let i = 0; i < n; i++) { out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1]; out[i * 4 + 2] = data[i * 4]; out[i * 4 + 3] = data[i * 4 + 3]; } return out;
    case "r8unorm": for (let i = 0; i < n; i++) { out[i * 4] = data[i]; out[i * 4 + 3] = 255; } return out;
    case "rg8unorm": for (let i = 0; i < n; i++) { out[i * 4] = data[i * 2]; out[i * 4 + 1] = data[i * 2 + 1]; out[i * 4 + 3] = 255; } return out;
    case "rgba16float": for (let i = 0; i < n * 4; i++) out[i] = c8(half(dv.getUint16(i * 2, true))); return out;
    case "rgba32float": for (let i = 0; i < n * 4; i++) out[i] = c8(dv.getFloat32(i * 4, true)); return out;
    case "rgb10a2unorm": for (let i = 0; i < n; i++) { const v = dv.getUint32(i * 4, true); out[i * 4] = (v & 1023) >> 2; out[i * 4 + 1] = ((v >> 10) & 1023) >> 2; out[i * 4 + 2] = ((v >> 20) & 1023) >> 2; out[i * 4 + 3] = (v >>> 30) * 85; } return out;
    case "depth32float": case "r32float": for (let i = 0; i < n; i++) { const v = c8(dv.getFloat32(i * 4, true)); out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255; } return out;
    case "depth16unorm": for (let i = 0; i < n; i++) { const v = dv.getUint16(i * 2, true) >> 8; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255; } return out;
  }
  return null;
}
