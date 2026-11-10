// nxweb graphics glue, the replayer: executes the host stream of the recorder (src/gfx, AssemblyScript) on WebGPU.
// The recorder decides everything NVN (pass boundaries, load actions, bindings, pipeline keys, what is skipped); this
// file reads each record and the tables it points to from the shared linear memory and makes the WebGPU call for it.
// Record layouts: src/gfx/hostops.ts. Pipeline key: src/gfx/pipeline.ts. Texture description: nvn_texdesc (obj.ts).
// Browser code (WebGPU types are left loose: the tree has no @webgpu/types).
import { NVN_FORMATS, COMPARE, STENCIL_OP, BLEND_EQ, BLEND_FUNC, TOPOLOGY, WRAP } from "./gfx_formats.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type GPU = any;

export interface GfxExports {
  memory?: WebAssembly.Memory;
  gfx_init(arena: number, bytes: number): number;
  gfx_arena_bytes(): number;
  nvn_call(fn: number, args: number): bigint;
  nvn_lookup(name: number): number;
  nvn_status(fn: number): number;
  nvn_count(): number;
  gfx_shader_register(keyLo: number, keyHi: number, refl: number): number;
  gfx_pipeline_done(id: number, ok: number): void;
  gfx_fence_signal(n: number): void;
  gfx_fence_done(n: number): number;
  gfx_image_event(window: number, index: number, what: number): void;
  gfx_sampler_table(): number;
  gfx_scratch(): number;
  gfx_flush(): void;
  gfx_stat(i: number): number;
  [name: string]: any;
}

// A translated shader as the library holds it. The WGSL follows the binding convention of src/gfx/README.md:
//   @group(0) @binding(stage * 16 + i)        uniform buffer i of the stage (0 vertex, 1 fragment)
//   @group(1) @binding(stage * 64 + slot * 2) texture slot, and + 1 its sampler
//   vertex inputs @location(l) = NVN attribute l, fragment outputs @location(i) = colour target i
export interface ShaderInfo {
  stage: "vertex" | "fragment";
  wgsl: string;
  entry?: string;
  ubos?: number[];
  textures?: { slot: number; dim?: "2d" | "2d-array" | "cube" | "3d"; depth?: boolean }[];
  attributes?: number[];   // vertex: locations read
  fixup?: boolean;         // vertex: declares `@group(2) @binding(0) var<uniform>` of one vec4f, the position fix-up (README)
  outputs?: number[];      // fragment: colour outputs written
}

const H = { TEX_CREATE: 1, TEX_DESTROY: 2, BEGIN_PASS: 3, END_PASS: 4, VIEWPORT: 5, SCISSOR: 6, PIPELINE_CREATE: 7, PIPELINE: 8, VBUF: 9, UBO: 10, TEX: 11,
  BLEND_COLOR: 12, STENCIL_REF: 13, DRAW: 14, DRAW_IDX: 15, CLEAR_RECT: 16, COPY_B2T: 17, COPY_T2T: 18, SNAPSHOT: 19, PRESENT: 20, FENCE: 21, FLUSH: 22, MEM_DIRTY: 23, TEX_DATA: 24, COPY_T2B: 25, FIXUP: 26 };
// Pipeline key offsets (src/gfx/pipeline.ts)
const PK = { vs: 0, fs: 2, prim: 4, cull: 5, front: 6, polyMode: 7, offsetEn: 8, samples: 9, ncolor: 10, depthFmt: 11, colorFmt: 12, a2c: 20, blendEn: 22, stencilV: 23, stencilW: 24,
  itype: 25, chmask: 28, ds: 32, blend: 40, offset: 104, attrMask: 116, attr: 120, stream: 248 };

interface Tex { serial: number; target: number; format: number; flags: number; samples: number; width: number; height: number; depth: number; levels: number;
  gpu?: GPU; snap?: GPU; views: Map<string, GPU>; fmt: (typeof NVN_FORMATS)[number] }
interface Pipe { desc: any; gpu?: GPU; vs: number; fs: number; key: number }

const FULLSCREEN_VS = `
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}`;

export class GfxHost {
  device: GPU;
  memory: WebAssembly.Memory;
  x!: GfxExports;
  log: (line: string) => void;
  context: GPU = null;
  canvasFormat = "bgra8unorm";
  lastPresented = 0;
  stats = { passes: 0, draws: 0, pipelinesAsync: 0, pipelinesSync: 0, pipelinesFailed: 0, uploads: 0, uploadBytes: 0, submits: 0, presents: 0, snapshots: 0, clearRects: 0, errors: 0 };

  private shaders: { info: ShaderInfo; module?: GPU }[] = [];
  private textures = new Map<number, Tex>();
  private pipes = new Map<number, Pipe>();
  private layouts = new Map<string, GPU>();
  private samplers = new Map<string, GPU>();
  private enc: GPU = null;
  private pass: GPU = null;
  private passInfo: { colorFmt: (string | null)[]; depthFmt: string | null; samples: number; w: number; h: number } | null = null;
  private uploads = new Map<string, GPU>();       // address:size -> buffer, until memory changes or the submission ends
  private inUse: GPU[] = [];
  private pool = new Map<number, GPU[]>();
  private cur: Pipe | null = null;
  private ubo = new Map<number, { addr: number; size: number }>();
  private tex = new Map<number, { serial: number; snap: boolean; view: Uint8Array | null; samp: number }>();
  private bindDirty = true;
  private fix = [1, 1, 1, 0];
  private fixGroups = new Map<string, GPU>();
  presentFlips = 0;
  private dummy: GPU = null;
  private helpers = new Map<string, GPU>();
  private redOnce = new Set<string>();
  private readbacks: Promise<void>[] = [];   // texture-to-buffer copies that have not landed in guest memory yet
  private queued: { buf: GPU; dst: number; row: number; rows: number; wb: number; img: number; depth: number; srcRow: number }[] = [];

  constructor(device: GPU, memory: WebAssembly.Memory, opts: { canvas?: any; log?: (line: string) => void } = {}) {
    this.device = device; this.memory = memory;
    this.log = opts.log ?? (l => console.log(l));
    if (opts.canvas) {
      this.context = opts.canvas.getContext("webgpu");
      this.canvasFormat = (globalThis as any).navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({ device, format: this.canvasFormat, alphaMode: "opaque" });
    }
    device.onuncapturederror = (e: any) => { this.stats.errors++; this.log(`[RED] WebGPU: ${String(e.error?.message ?? e).split("\n")[0]}`); };
  }

  // The recorder's imports that belong to the replayer; the embedder adds env.log, env.gfx_guest_call, env.gfx_proc_address
  imports() { return { gfx_exec: (ptr: number, len: number) => this.exec(ptr >>> 0, len >>> 0) }; }
  attach(x: GfxExports) { this.x = x; }
  private red(key: string, line: string) { if (!this.redOnce.has(key)) { this.redOnce.add(key); this.log(`[RED] ${line}`); } }
  private get dv() { return new DataView(this.memory.buffer); }
  private get u8() { return new Uint8Array(this.memory.buffer); }

  // ---- the shader library ----
  // keyHex: the 16 hex digits of a stage's key, sha256(control section + code)[0..8] (src/gfx/shader.ts)
  registerShader(keyHex: string, info: ShaderInfo): number {
    const dv = this.dv, r = this.x.gfx_scratch() >>> 0, bit = (a?: number[]) => (a ?? []).reduce((m, i) => m | (1 << i), 0) >>> 0;
    let dim = 0n, depth = 0;
    for (const t of info.textures ?? []) { dim |= BigInt(["2d", "2d-array", "cube", "3d"].indexOf(t.dim ?? "2d")) << BigInt(t.slot * 2); if (t.depth) depth |= 1 << t.slot; }
    dv.setUint32(r, info.stage === "vertex" ? 0 : 1, true); dv.setUint32(r + 4, bit(info.ubos), true); dv.setUint32(r + 8, bit((info.textures ?? []).map(t => t.slot)), true);
    dv.setUint32(r + 12, bit(info.stage === "vertex" ? info.attributes : info.outputs), true); dv.setBigUint64(r + 16, dim, true); dv.setUint32(r + 24, depth >>> 0, true); dv.setUint32(r + 28, 0, true);
    const b = keyHex.match(/../g)!.map(h => parseInt(h, 16));
    const lo = (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0, hi = (b[4] | b[5] << 8 | b[6] << 16 | b[7] << 24) >>> 0;
    const id = this.x.gfx_shader_register(lo, hi, r);
    if (id >= 0) this.shaders[id] = { info };
    return id;
  }
  private module(id: number): GPU { const s = this.shaders[id]; return (s.module ??= this.device.createShaderModule({ code: s.info.wgsl })); }

  // ---- textures ----
  private texture(serial: number): Tex | undefined {
    const t = this.textures.get(serial);
    if (!t || t.gpu) return t;
    if (!t.fmt?.tex) { this.red(`fmt${t.format}`, `texture format 0x${t.format.toString(16)} has no WebGPU format: the texture is not created`); return undefined; }
    const cube = t.target === 8 || t.target === 9, layers = t.target === 4 || t.target === 6 || t.target === 9 || t.target === 3 ? Math.max(1, t.target === 3 ? t.height : t.depth) : cube ? 6 : 1;
    const is3d = t.target === 2, h = t.target === 0 || t.target === 3 ? 1 : t.height;
    const up = (v: number, b: number) => Math.ceil(v / b) * b;
    const compressed = t.fmt.bw > 1, ms = t.samples > 1;
    let usage = 0x04 /* TEXTURE_BINDING */ | (ms ? 0 : 0x01 | 0x02 /* COPY_SRC | COPY_DST */);
    if (!compressed && !is3d && t.fmt.tex !== "rgb9e5ufloat") usage |= 0x10; /* RENDER_ATTACHMENT */
    t.gpu = this.device.createTexture({ size: { width: up(t.width, t.fmt.bw), height: up(h, t.fmt.bh), depthOrArrayLayers: is3d ? Math.max(1, t.depth) : layers }, format: t.fmt.tex,
      dimension: is3d ? "3d" : "2d", mipLevelCount: ms ? 1 : Math.max(1, t.levels), sampleCount: ms ? t.samples : 1, usage });
    return t;
  }
  private layerCount(t: Tex) { return t.gpu.depthOrArrayLayers; }
  // view: a view_t (16 bytes) or null; attach: one level and layer, for a render target or a copy
  private view(t: Tex, src: GPU, view: Uint8Array | null, dim?: string): GPU {
    const key = (src === t.snap ? "s" : "t") + (dim ?? "") + (view ? Array.from(view).join(",") : "");
    let v = t.views.get(key);
    if (v) return v;
    const d: any = {};
    const cube = t.target === 8, arr = t.target === 4 || t.target === 3 || t.target === 6;
    d.dimension = dim ?? (t.target === 2 ? "3d" : cube ? "cube" : t.target === 9 ? "cube-array" : arr ? "2d-array" : "2d");
    if (view) {
      const bits = view[0], vt = view[1];
      if (bits & 1) { d.baseMipLevel = view[2]; d.mipLevelCount = Math.max(1, Math.min(view[3] || 1, t.gpu.mipLevelCount - view[2])); }
      if (bits & 2) { d.baseArrayLayer = view[6] | view[7] << 8; d.arrayLayerCount = Math.max(1, view[8] | view[9] << 8); }
      if ((bits & 8) && !dim) d.dimension = vt === 2 ? "3d" : vt === 8 ? "cube" : vt === 9 ? "cube-array" : vt === 4 || vt === 3 ? "2d-array" : "2d";
      if (d.dimension === "2d") d.arrayLayerCount = 1;
    } else if (d.dimension === "2d" && this.layerCount(t) > 1) d.arrayLayerCount = 1;
    if (t.fmt.kind === "depth" && t.fmt.stencil) d.aspect = view && (view[0] & 0x20) && (view[0] >> 6) === 1 ? "stencil-only" : "depth-only";
    v = src.createView(d);
    t.views.set(key, v);
    return v;
  }
  private attachView(t: Tex, level: number, layer: number): GPU {
    const key = `a${level}/${layer}`;
    let v = t.views.get(key);
    if (!v) { v = t.gpu.createView({ dimension: t.gpu.dimension === "3d" ? "3d" : "2d", baseMipLevel: level, mipLevelCount: 1, ...(t.gpu.dimension === "3d" ? {} : { baseArrayLayer: layer, arrayLayerCount: 1 }) }); t.views.set(key, v); }
    return v;
  }
  private dummyView(dim: string): GPU {
    this.dummy ??= this.device.createTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 6 }, format: "rgba8unorm", usage: 0x04 | 0x02 });
    return this.dummy.createView({ dimension: dim, ...(dim === "2d" ? { arrayLayerCount: 1 } : {}) });
  }

  // ---- guest memory to GPU buffers ----
  private upload(addr: number, size: number, kind: number): GPU | null {
    const key = `${addr}:${size}:${kind}`;
    let b = this.uploads.get(key);
    if (b) return b;
    if (!addr || !size || addr + size > this.memory.buffer.byteLength) { this.red(`up${addr}`, `a draw binds memory outside the guest's (address 0x${addr.toString(16)} size ${size}): not bound`); return null; }
    const cap = Math.max(256, 2 ** Math.ceil(Math.log2(size))) * (kind === 1 ? 2 : 1);
    b = this.pool.get(cap)?.pop() ?? this.device.createBuffer({ size: cap, usage: 0x08 | 0x10 | 0x20 | 0x40 /* COPY_DST INDEX VERTEX UNIFORM */ });
    const n = Math.min(cap, (size + 3) & ~3, this.memory.buffer.byteLength - addr) & ~3;
    if (kind === 1) {   // 8-bit indices: WebGPU has none, widened to 16
      const src = this.u8.subarray(addr, addr + size), wide = new Uint16Array((size + 1) & ~1);
      for (let i = 0; i < size; i++) wide[i] = src[i];
      this.device.queue.writeBuffer(b, 0, wide);
    } else this.device.queue.writeBuffer(b, 0, this.u8, addr, n);
    this.stats.uploads++; this.stats.uploadBytes += n;
    this.uploads.set(key, b); this.inUse.push(b);
    return b;
  }
  private dropUploads() { this.uploads.clear(); this.bindDirty = true; }

  // ---- encoder and passes ----
  private encoder(): GPU { return (this.enc ??= this.device.createCommandEncoder()); }
  private endPass() { if (this.pass) { this.pass.end(); this.pass = null; } }
  private flush() {
    this.endPass();
    if (this.enc) { this.device.queue.submit([this.enc.finish()]); this.enc = null; this.stats.submits++; }
    for (const q of this.queued.splice(0)) this.readbacks.push(q.buf.mapAsync(1).then(() => {
      const src = new Uint8Array(q.buf.getMappedRange()), mem = this.u8;
      for (let z = 0; z < q.depth; z++) for (let y = 0; y < q.rows; y++) mem.set(src.subarray((z * q.rows + y) * q.srcRow, (z * q.rows + y) * q.srcRow + q.wb), q.dst + z * q.img + y * q.row);
      q.buf.unmap(); q.buf.destroy(); this.uploads.clear(); this.bindDirty = true;
    }, (e: any) => this.log(`[RED] CopyTextureToBuffer readback failed: ${e?.message ?? e}`)));
    for (const b of this.inUse) { let l = this.pool.get(b.size); if (!l) this.pool.set(b.size, l = []); l.push(b); }
    this.inUse = []; this.uploads.clear(); this.bindDirty = true;
  }
  private u64(dv: DataView, p: number) { return dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296; }

  private beginPass(dv: DataView, p: number) {
    const n = dv.getUint32(p + 8, true), flags = dv.getUint32(p + 12, true);
    const colorAttachments: any[] = [], colorFmt: (string | null)[] = [];
    let samples = 1;
    for (let i = 0; i < n; i++) {
      const o = p + 32 + i * 40, t = this.texture(this.u64(dv, o));
      if (!t) { colorAttachments.push(null); colorFmt.push(null); continue; }
      samples = t.gpu.sampleCount;
      const clear = dv.getUint32(o + 20, true) !== 0;
      colorAttachments.push({ view: this.attachView(t, dv.getUint32(o + 8, true), dv.getUint32(o + 12, true)), loadOp: clear ? "clear" : "load", storeOp: "store",
        clearValue: { r: dv.getFloat32(o + 24, true), g: dv.getFloat32(o + 28, true), b: dv.getFloat32(o + 32, true), a: dv.getFloat32(o + 36, true) } });
      colorFmt.push(t.fmt.tex!);
    }
    const desc: any = { colorAttachments };
    let depthFmt: string | null = null;
    if (flags & 1) {
      const t = this.texture(this.u64(dv, p + 352));
      if (t) {
        samples = t.gpu.sampleCount; depthFmt = t.fmt.tex!;
        const a: any = { view: this.attachView(t, dv.getUint32(p + 360, true), dv.getUint32(p + 364, true)) };
        if (t.fmt.kind === "depth") { a.depthLoadOp = flags & 2 ? "clear" : "load"; a.depthStoreOp = "store"; a.depthClearValue = Math.min(1, Math.max(0, dv.getFloat32(p + 16, true))); }
        if (t.fmt.stencil) { a.stencilLoadOp = flags & 4 ? "clear" : "load"; a.stencilStoreOp = "store"; a.stencilClearValue = dv.getUint32(p + 20, true); }
        desc.depthStencilAttachment = a;
      }
    }
    this.endPass();
    this.pass = this.encoder().beginRenderPass(desc);
    this.passInfo = { colorFmt, depthFmt, samples, w: dv.getUint32(p + 24, true), h: dv.getUint32(p + 28, true) };
    this.cur = null; this.bindDirty = true; this.ubo.clear(); this.tex.clear();
    this.stats.passes++;
  }

  // ---- pipelines ----
  private groupLayouts(vs: ShaderInfo, fs: ShaderInfo): GPU[] {
    const g0: any[] = [], g1: any[] = [];
    [vs, fs].forEach((s, st) => {
      const visibility = st ? 2 : 1;
      for (const i of s.ubos ?? []) g0.push({ binding: st * 16 + i, visibility, buffer: { type: "uniform" } });
      for (const t of s.textures ?? []) {
        g1.push({ binding: st * 64 + t.slot * 2, visibility, texture: { sampleType: t.depth ? "depth" : "float", viewDimension: t.dim ?? "2d" } });
        g1.push({ binding: st * 64 + t.slot * 2 + 1, visibility, sampler: { type: t.depth ? "comparison" : "filtering" } });
      }
    });
    const groups = [g0, g1];
    if (vs.fixup) groups.push([{ binding: 0, visibility: 1, buffer: { type: "uniform" } }]);
    return groups.map(entries => {
      const key = JSON.stringify(entries);
      let l = this.layouts.get(key);
      if (!l) { l = this.device.createBindGroupLayout({ entries }); this.layouts.set(key, l); }
      return l;
    });
  }
  private createPipeline(id: number, k: number) {
    const dv = this.dv, vsId = dv.getUint16(k + PK.vs, true), fsId = dv.getUint16(k + PK.fs, true), vs = this.shaders[vsId].info, fs = this.shaders[fsId].info;
    const buffers: any[] = [];
    for (let loc = 0, m = dv.getUint32(k + PK.attrMask, true); m; loc++, m >>>= 1) {
      if (!(m & 1)) continue;
      const a = dv.getUint32(k + PK.attr + loc * 4, true), fmt = a & 0xff, stream = a >>> 27, vf = NVN_FORMATS[fmt]?.vtx;
      if (!vf) { this.red(`vf${fmt}`, `vertex attribute format 0x${fmt.toString(16)} has no WebGPU vertex format: pipeline ${id} will fail`); }
      const divisor = dv.getUint32(k + PK.stream + stream * 8 + 4, true);
      buffers[stream] ??= { arrayStride: dv.getUint32(k + PK.stream + stream * 8, true), stepMode: divisor ? "instance" : "vertex", attributes: [] };
      buffers[stream].attributes.push({ shaderLocation: loc, offset: (a >>> 8) & 0x7ffff, format: vf ?? "float32" });
    }
    for (let i = 0; i < buffers.length; i++) buffers[i] ??= null;
    const prim = dv.getUint8(k + PK.prim), itype = dv.getUint8(k + PK.itype), cull = dv.getUint8(k + PK.cull);
    const primitive: any = { topology: TOPOLOGY[prim], cullMode: cull === 1 ? "front" : cull === 2 ? "back" : "none", frontFace: dv.getUint8(k + PK.front) ? "ccw" : "cw" };
    if (itype) primitive.stripIndexFormat = itype === 3 ? "uint32" : "uint16";
    const ncolor = dv.getUint8(k + PK.ncolor), chmask = dv.getUint32(k + PK.chmask, true), blendEn = dv.getUint8(k + PK.blendEn), written = new Set(fs.outputs ?? []);
    const targets: any[] = [];
    for (let i = 0; i < ncolor; i++) {
      const f = NVN_FORMATS[dv.getUint8(k + PK.colorFmt + i)];
      if (!f?.tex) { targets.push(null); continue; }
      const nib = (chmask >>> (4 * i)) & 15, t: any = { format: f.tex, writeMask: written.has(i) ? nib : 0 };
      if ((blendEn >> i) & 1) {
        const b = dv.getBigUint64(k + PK.blend + i * 8, true), fld = (s: number, w: number) => Number((b >> BigInt(s)) & ((1n << BigInt(w)) - 1n));
        const comp = (eq: number, src: number, dst: number) => eq >= 4 ? { operation: BLEND_EQ[eq], srcFactor: "one", dstFactor: "one" } : { operation: BLEND_EQ[eq] ?? "add", srcFactor: BLEND_FUNC[src] ?? "one", dstFactor: BLEND_FUNC[dst] ?? "zero" };
        t.blend = { color: comp(fld(31, 3), fld(3, 7), fld(10, 7)), alpha: comp(fld(34, 3), fld(17, 7), fld(24, 7)) };
      }
      targets.push(t);
    }
    const desc: any = {
      layout: this.device.createPipelineLayout({ bindGroupLayouts: this.groupLayouts(vs, fs) }),
      vertex: { module: this.module(vsId), entryPoint: vs.entry, buffers }, primitive,
      multisample: { count: dv.getUint8(k + PK.samples) || 1, alphaToCoverageEnabled: dv.getUint8(k + PK.a2c) !== 0 && (dv.getUint8(k + PK.samples) || 1) > 1 },
      fragment: { module: this.module(fsId), entryPoint: fs.entry, targets },
    };
    const df = NVN_FORMATS[dv.getUint8(k + PK.depthFmt)];
    if (df?.tex) {
      const ds = dv.getBigUint64(k + PK.ds, true), fld = (s: number, w: number) => Number((ds >> BigInt(s)) & ((1n << BigInt(w)) - 1n));
      const dt = fld(0, 1), d: any = { format: df.tex };
      if (df.kind === "depth") { d.depthWriteEnabled = !!(dt && fld(1, 1)); d.depthCompare = dt ? COMPARE[fld(2, 4)] ?? "always" : "always"; }
      if (df.stencil && fld(6, 1)) {
        d.stencilFront = { compare: COMPARE[fld(7, 4)], failOp: STENCIL_OP[fld(15, 4)], depthFailOp: STENCIL_OP[fld(19, 4)], passOp: STENCIL_OP[fld(23, 4)] };
        d.stencilBack = { compare: COMPARE[fld(11, 4)], failOp: STENCIL_OP[fld(27, 4)], depthFailOp: STENCIL_OP[fld(31, 4)], passOp: STENCIL_OP[fld(35, 4)] };
        d.stencilReadMask = dv.getUint8(k + PK.stencilV); d.stencilWriteMask = dv.getUint8(k + PK.stencilW);
      }
      if ((dv.getUint8(k + PK.offsetEn) & 4) && df.kind === "depth" && prim >= 4) {
        d.depthBias = Math.round(dv.getFloat32(k + PK.offset + 4, true)); d.depthBiasSlopeScale = dv.getFloat32(k + PK.offset, true); d.depthBiasClamp = dv.getFloat32(k + PK.offset + 8, true);
      }
      desc.depthStencil = d;
    }
    const pipe: Pipe = { desc, vs: vsId, fs: fsId, key: k };
    this.pipes.set(id, pipe);
    // Asynchronously, so a pipeline first needed later is ready by then; the draw that needs it now builds it itself (usePipeline)
    this.device.createRenderPipelineAsync(desc).then((p: GPU) => { pipe.gpu ??= p; this.stats.pipelinesAsync++; this.x.gfx_pipeline_done(id, 1); },
      (e: any) => { this.stats.pipelinesFailed++; this.log(`[RED] pipeline ${id} did not build: ${e?.message ?? e}`); this.x.gfx_pipeline_done(id, 0); });
  }
  private usePipeline(id: number) {
    const pipe = this.pipes.get(id);
    if (!pipe) { this.red(`nopipe${id}`, `host stream binds pipeline ${id}, which was never created`); this.cur = null; return; }
    if (!pipe.gpu) { pipe.gpu = this.device.createRenderPipeline(pipe.desc); this.stats.pipelinesSync++; }
    this.cur = pipe; this.pass.setPipeline(pipe.gpu); this.bindDirty = true;
  }
  private sampler(index: number, compare: boolean): GPU {
    const p = (this.x.gfx_sampler_table() >>> 0) + index * 48, dv = this.dv, registered = index > 0 && dv.getUint8(p + 40) !== 0;
    const key = (registered ? Array.from(this.u8.subarray(p, p + 40)).join(",") : "default") + (compare ? "c" : "");
    let s = this.samplers.get(key);
    if (s) return s;
    const d: any = { magFilter: "linear", minFilter: "linear", mipmapFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" };
    if (registered) {
      const minf = dv.getUint8(p), mip = minf >= 2;
      d.minFilter = minf === 1 || minf === 3 || minf === 5 ? "linear" : "nearest"; d.magFilter = dv.getUint8(p + 1) ? "linear" : "nearest"; d.mipmapFilter = minf >= 4 ? "linear" : "nearest";
      d.addressModeU = WRAP[dv.getUint8(p + 2)] ?? "clamp-to-edge"; d.addressModeV = WRAP[dv.getUint8(p + 3)] ?? "clamp-to-edge"; d.addressModeW = WRAP[dv.getUint8(p + 4)] ?? "clamp-to-edge";
      d.lodMinClamp = mip ? Math.max(0, dv.getFloat32(p + 8, true)) : 0; d.lodMaxClamp = mip ? Math.max(d.lodMinClamp, Math.min(32, dv.getFloat32(p + 12, true))) : 0;
      const aniso = dv.getFloat32(p + 20, true);
      if (aniso > 1 && d.minFilter === "linear" && d.magFilter === "linear" && d.mipmapFilter === "linear") d.maxAnisotropy = Math.min(16, Math.floor(aniso));
      if (dv.getUint8(p + 5)) d.compare = COMPARE[dv.getUint8(p + 6)];
    }
    if (compare) d.compare ??= "less-equal"; else delete d.compare;
    s = this.device.createSampler(d);
    this.samplers.set(key, s);
    return s;
  }
  private bind() {
    const c = this.cur!, layouts = this.groupLayouts(this.shaders[c.vs].info, this.shaders[c.fs].info), g0: any[] = [], g1: any[] = [];
    [this.shaders[c.vs].info, this.shaders[c.fs].info].forEach((s, st) => {
      for (const i of s.ubos ?? []) {
        const b = this.ubo.get(st * 16 + i), buf = b && this.upload(b.addr, b.size, 0);
        g0.push({ binding: st * 16 + i, resource: buf ? { buffer: buf, offset: 0, size: Math.min(buf.size, (b!.size + 15) & ~15) } : { buffer: this.zeroBuffer() } });
      }
      for (const t of s.textures ?? []) {
        const b = this.tex.get(st * 64 + t.slot), tx = b && b.serial ? this.texture(b.serial) : undefined;
        const src = tx && (b!.snap && tx.snap ? tx.snap : tx.gpu);
        g1.push({ binding: st * 64 + t.slot * 2, resource: tx ? this.view(tx, src, b!.view, t.dim) : this.dummyView(t.dim ?? "2d") });
        g1.push({ binding: st * 64 + t.slot * 2 + 1, resource: this.sampler(b ? b.samp : 0, !!t.depth) });
      }
    });
    this.pass.setBindGroup(0, this.device.createBindGroup({ layout: layouts[0], entries: g0 }));
    this.pass.setBindGroup(1, this.device.createBindGroup({ layout: layouts[1], entries: g1 }));
    if (layouts[2]) {
      const key = this.fix.join(",");
      let g = this.fixGroups.get(key);
      if (!g) { const b = this.device.createBuffer({ size: 16, usage: 0x40 | 0x08 }); this.device.queue.writeBuffer(b, 0, new Float32Array(this.fix)); g = this.device.createBindGroup({ layout: layouts[2], entries: [{ binding: 0, resource: { buffer: b } }] }); this.fixGroups.set(key, g); }
      this.pass.setBindGroup(2, g);
    }
    this.bindDirty = false;
  }
  private zero: GPU = null;
  private zeroBuffer(): GPU { return (this.zero ??= this.device.createBuffer({ size: 65536, usage: 0x40 | 0x08 })); }

  // ---- helper pipelines: clears drawn as a triangle, blits ----
  private clearRect(dv: DataView, p: number) {
    const pi = this.passInfo!, kind = dv.getUint32(p + 8, true), index = dv.getUint32(p + 12, true), mask = dv.getUint32(p + 16, true);
    const w = dv.getUint32(p + 44, true), h = dv.getUint32(p + 48, true);
    this.stats.clearRects++;
    if (!w || !h) return;
    const key = `clear|${pi.colorFmt}|${pi.depthFmt}|${pi.samples}|${kind}|${index}|${mask}`;
    let pl = this.helpers.get(key);
    if (!pl) {
      const fmtKind = Object.values(NVN_FORMATS).find(f => f.tex === pi.colorFmt[index])?.kind ?? "float", ty = fmtKind === "uint" ? "vec4u" : fmtKind === "sint" ? "vec4i" : "vec4f";
      const code = `struct U { c: vec4f, d: f32 } @group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, u.d, 1.0); }
@fragment fn fs() -> @location(${kind ? 0 : index}) ${kind ? "vec4f" : ty} { return ${kind ? "vec4f(0.0)" : `${ty}(u.c)`}; }`;
      const m = this.device.createShaderModule({ code });
      const desc: any = { layout: "auto", vertex: { module: m, entryPoint: "vs" }, primitive: { topology: "triangle-list" }, multisample: { count: pi.samples },
        fragment: { module: m, entryPoint: "fs", targets: pi.colorFmt.map((f, i) => f ? { format: f, writeMask: !kind && i === index ? mask : 0 } : null) } };
      if (pi.depthFmt) {
        const f = Object.values(NVN_FORMATS).find(x => x.tex === pi.depthFmt)!, d: any = { format: pi.depthFmt };
        if (f.kind === "depth") { d.depthCompare = "always"; d.depthWriteEnabled = !!(kind && (mask & 1)); }
        if (kind && f.stencil && (mask >> 8)) { const op = { compare: "always", passOp: "replace", failOp: "replace", depthFailOp: "replace" }; d.stencilFront = op; d.stencilBack = op; d.stencilWriteMask = mask >> 8; }
        desc.depthStencil = d;
      }
      pl = this.device.createRenderPipeline(desc);
      this.helpers.set(key, pl);
    }
    const data = new Float32Array(8);
    for (let i = 0; i < 4; i++) data[i] = dv.getFloat32(p + 20 + i * 4, true);
    if (kind) data[4] = Math.min(1, Math.max(0, dv.getFloat32(p + 20, true)));
    const ub = this.pool.get(256)?.pop() ?? this.device.createBuffer({ size: 256, usage: 0x08 | 0x10 | 0x20 | 0x40 });
    this.device.queue.writeBuffer(ub, 0, data); this.inUse.push(ub);
    this.pass.setPipeline(pl);
    this.pass.setBindGroup(0, this.device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub, size: 32 } }] }));
    this.pass.setViewport(0, 0, pi.w, pi.h, 0, 1);
    this.pass.setScissorRect(dv.getUint32(p + 36, true), dv.getUint32(p + 40, true), w, h);
    if (kind) this.pass.setStencilReference(dv.getUint32(p + 24, true) & 0xff);
    this.pass.draw(3);
    this.cur = null; this.bindDirty = true;
  }
  // Draws src (a view) over the viewport rectangle of dst, sampling the uv rectangle: present and scaled copies
  private blit(srcView: GPU, uv: number[], dstView: GPU, dstFmt: string, vp: number[] | null, linear: boolean) {
    const key = `blit|${dstFmt}`;
    let pl = this.helpers.get(key);
    if (!pl) {
      const m = this.device.createShaderModule({ code: `${FULLSCREEN_VS}
struct U { r: vec4f } @group(0) @binding(0) var<uniform> u: U; @group(0) @binding(1) var t: texture_2d<f32>; @group(0) @binding(2) var s: sampler;
@fragment fn fs(v: V) -> @location(0) vec4f { return textureSampleLevel(t, s, u.r.xy + v.uv * u.r.zw, 0.0); }` });
      pl = this.device.createRenderPipeline({ layout: "auto", vertex: { module: m, entryPoint: "vs" }, fragment: { module: m, entryPoint: "fs", targets: [{ format: dstFmt }] } });
      this.helpers.set(key, pl);
    }
    const ub = this.pool.get(256)?.pop() ?? this.device.createBuffer({ size: 256, usage: 0x08 | 0x10 | 0x20 | 0x40 });
    this.device.queue.writeBuffer(ub, 0, new Float32Array(uv)); this.inUse.push(ub);
    const f = linear ? "linear" : "nearest", skey = `blit${f}`;
    let s = this.samplers.get(skey);
    if (!s) { s = this.device.createSampler({ magFilter: f, minFilter: f }); this.samplers.set(skey, s); }
    this.endPass();
    const pass = this.encoder().beginRenderPass({ colorAttachments: [{ view: dstView, loadOp: vp ? "load" : "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(pl);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub, size: 16 } }, { binding: 1, resource: srcView }, { binding: 2, resource: s }] }));
    if (vp) { pass.setViewport(vp[0], vp[1], vp[2], vp[3], 0, 1); pass.setScissorRect(vp[0], vp[1], vp[2], vp[3]); }
    pass.draw(3); pass.end();
  }

  private copyB2T(dv: DataView, p: number) {
    const src = this.u64(dv, p + 8), t = this.texture(this.u64(dv, p + 16));
    if (!t) return;
    const level = dv.getUint32(p + 24, true), layer = dv.getUint32(p + 28, true), r = [0, 1, 2, 3, 4, 5].map(i => dv.getInt32(p + 32 + i * 4, true));
    const f = t.fmt, bx = Math.ceil(r[3] / f.bw), by = Math.ceil(r[4] / f.bh), depth = Math.max(1, r[5]);
    const row = dv.getUint32(p + 56, true) || bx * f.bpb, rows = dv.getUint32(p + 60, true) ? Math.floor(dv.getUint32(p + 60, true) / row) : by;
    const bytes = row * rows * (depth - 1) + row * (by - 1) + bx * f.bpb;
    if (f.kind === "depth" || f.stencil) { this.red("b2tdepth", "CopyBufferToTexture into a depth or stencil texture: WebGPU cannot write one from memory, the copy is dropped"); return; }
    if (!src || src + bytes > this.memory.buffer.byteLength) { this.red("b2trange", `CopyBufferToTexture reads outside guest memory (0x${src.toString(16)} + ${bytes}): dropped`); return; }
    // writeTexture takes effect at once, encoder commands at submit: what was encoded so far must go first
    this.flush();
    this.device.queue.writeTexture({ texture: t.gpu, mipLevel: level, origin: { x: r[0], y: r[1], z: r[2] + layer } }, this.u8.subarray(src, src + bytes), { bytesPerRow: row, rowsPerImage: rows },
      { width: bx * f.bw, height: by * f.bh, depthOrArrayLayers: depth });
  }
  private copyT2T(dv: DataView, p: number) {
    const s = this.texture(this.u64(dv, p + 8)), d = this.texture(this.u64(dv, p + 16));
    if (!s || !d) return;
    const [sl, sy, dl, dy] = [24, 28, 32, 36].map(o => dv.getUint32(p + o, true)), sr = [0, 1, 2, 3, 4, 5].map(i => dv.getInt32(p + 40 + i * 4, true)), dr = [0, 1, 2, 3, 4, 5].map(i => dv.getInt32(p + 64 + i * 4, true));
    this.endPass();
    if (sr[3] === dr[3] && sr[4] === dr[4] && s.gpu.format === d.gpu.format && s.gpu.sampleCount === d.gpu.sampleCount) {
      const up = (v: number, b: number) => Math.ceil(v / b) * b;
      this.encoder().copyTextureToTexture({ texture: s.gpu, mipLevel: sl, origin: { x: sr[0], y: sr[1], z: sr[2] + sy } }, { texture: d.gpu, mipLevel: dl, origin: { x: dr[0], y: dr[1], z: dr[2] + dy } },
        { width: up(sr[3], s.fmt.bw), height: up(sr[4], s.fmt.bh), depthOrArrayLayers: Math.max(1, sr[5]) });
      return;
    }
    if (s.fmt.kind !== "float" || d.fmt.kind !== "float" || s.fmt.bw > 1 || d.fmt.bw > 1 || s.gpu.sampleCount > 1) { this.red("t2tscale", "CopyTextureToTexture between different sizes or formats is only done for uncompressed colour textures: dropped"); return; }
    const sw = Math.max(1, s.width >> sl), sh = Math.max(1, s.height >> sl);
    const sv = s.gpu.createView({ dimension: "2d", baseMipLevel: sl, mipLevelCount: 1, baseArrayLayer: sy + sr[2], arrayLayerCount: 1 });
    this.blit(sv, [sr[0] / sw, sr[1] / sh, sr[3] / sw, sr[4] / sh], this.attachView(d, dl, dy + dr[2]), d.fmt.tex!, [dr[0], dr[1], dr[3], dr[4]], (dv.getUint32(p + 88, true) & 1) !== 0);
  }
  // Texels from the recorder (texcontent.ts): linear rows in memory. Takes effect at once; the recorder only sends
  // them before the submission's first use of the texture, so nothing encoded and not yet submitted reads it
  private texData(dv: DataView, p: number) {
    const t = this.texture(this.u64(dv, p + 8));
    if (!t) return;
    if (t.fmt.kind === "depth" || t.fmt.stencil) { this.red("datadepth", "texels for a depth or stencil texture from guest memory: WebGPU cannot write one, not uploaded"); return; }
    const level = dv.getUint32(p + 16, true), z = dv.getUint32(p + 20, true), y = dv.getUint32(p + 24, true), slices = dv.getUint32(p + 36, true), ptr = dv.getUint32(p + 40, true), pitch = dv.getUint32(p + 44, true), x = dv.getUint32(p + 48, true);
    const f = t.fmt, up = (v: number, b: number) => Math.ceil(v / b) * b, lw = up(Math.max(1, t.gpu.width >> level), f.bw), lh = up(Math.max(1, t.gpu.height >> level), f.bh);
    const w = Math.min(dv.getUint32(p + 28, true), lw - x), h = Math.min(dv.getUint32(p + 32, true), lh - y), rows = h / f.bh;
    if (w <= 0 || h <= 0 || level >= t.gpu.mipLevelCount) return;
    const bytes = pitch * rows * (slices - 1) + pitch * (rows - 1) + w / f.bw * f.bpb;
    this.device.queue.writeTexture({ texture: t.gpu, mipLevel: level, origin: { x, y, z } }, this.u8.subarray(ptr, ptr + bytes), { bytesPerRow: pitch, rowsPerImage: rows }, { width: w, height: h, depthOrArrayLayers: slices });
    this.stats.uploads++; this.stats.uploadBytes += bytes;
  }
  private copyT2B(dv: DataView, p: number) {
    const dst = this.u64(dv, p + 8), t = this.texture(this.u64(dv, p + 16));
    if (!t) return;
    const level = dv.getUint32(p + 24, true), layer = dv.getUint32(p + 28, true), r = [0, 1, 2, 3, 4, 5].map(i => dv.getInt32(p + 32 + i * 4, true)), f = t.fmt;
    if (t.gpu.sampleCount > 1 || f.tex === "depth24plus" || f.tex === "depth24plus-stencil8") { this.red("t2bfmt", "CopyTextureToBuffer from a multisampled or 24-bit depth texture: WebGPU cannot copy it out, dropped"); return; }
    const bx = Math.ceil(r[3] / f.bw), by = Math.ceil(r[4] / f.bh), depth = Math.max(1, r[5]), wb = bx * f.bpb, row = dv.getUint32(p + 56, true) || wb, img = dv.getUint32(p + 60, true) || row * by, srcRow = Math.ceil(wb / 256) * 256;
    const buf = this.device.createBuffer({ size: srcRow * by * depth, usage: 0x01 | 0x08 });
    this.endPass();
    this.encoder().copyTextureToBuffer({ texture: t.gpu, mipLevel: level, origin: { x: r[0], y: r[1], z: r[2] + (t.gpu.dimension === "3d" ? 0 : layer) }, ...(f.kind === "depth" ? { aspect: "depth-only" } : {}) },
      { buffer: buf, bytesPerRow: srcRow, rowsPerImage: by }, { width: bx * f.bw, height: by * f.bh, depthOrArrayLayers: depth });
    this.queued.push({ buf, dst, row, rows: by, wb, img, depth, srcRow });
  }
  // Resolves when every texture-to-buffer copy issued so far has landed in guest memory
  async landed() { while (this.readbacks.length) await Promise.all(this.readbacks.splice(0)); }
  private snapshot(serial: number) {
    const t = this.texture(serial);
    if (!t) return;
    this.endPass();
    const g = t.gpu;
    if (g.sampleCount > 1) { this.red("snapms", "a draw samples a multisampled target of its own pass: no copy is made, it reads the texture itself"); return; }
    t.snap ??= this.device.createTexture({ size: { width: g.width, height: g.height, depthOrArrayLayers: g.depthOrArrayLayers }, format: g.format, dimension: g.dimension, mipLevelCount: g.mipLevelCount, usage: 0x04 | 0x02 | 0x10 });
    for (let l = 0; l < g.mipLevelCount; l++)
      this.encoder().copyTextureToTexture({ texture: g, mipLevel: l }, { texture: t.snap, mipLevel: l }, { width: Math.max(1, g.width >> l), height: Math.max(1, g.height >> l), depthOrArrayLayers: g.depthOrArrayLayers });
    this.stats.snapshots++;
  }
  private present(dv: DataView, p: number) {
    const serial = this.u64(dv, p + 8), t = this.texture(serial), win = dv.getUint32(p + 32, true), index = dv.getUint32(p + 36, true);
    this.lastPresented = serial; this.stats.presents++;
    if (t && this.context) {
      const c = [0, 1, 2, 3].map(i => dv.getInt32(p + 16 + i * 4, true)), uv = c[2] > 0 && c[3] > 0 ? [c[0] / t.width, c[1] / t.height, c[2] / t.width, c[3] / t.height] : [0, 0, 1, 1];
      if (dv.getUint32(p + 40, true) & 1) { uv[1] += uv[3]; uv[3] = -uv[3]; }
      this.blit(this.view(t, t.gpu, null, "2d"), uv, this.context.getCurrentTexture().createView(), this.canvasFormat, null, true);
    }
    if (dv.getUint32(p + 40, true) & 1) this.presentFlips++;
    this.flush();
    this.x.gfx_image_event(win, index, 0);
    this.device.queue.onSubmittedWorkDone().then(() => this.x.gfx_image_event(win, index, 1));
  }

  // ---- the stream ----
  exec(ptr: number, len: number) {
    let dv = this.dv;
    for (let p = ptr, end = ptr + len; p < end;) {
      const op = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
      switch (op) {
        case H.TEX_CREATE: {
          const serial = this.u64(dv, p + 8), d = p + 16, format = dv.getInt32(d + 4, true);
          this.textures.set(serial, { serial, target: dv.getInt32(d, true), format, flags: dv.getInt32(d + 8, true), samples: dv.getInt32(d + 12, true), width: dv.getUint32(d + 16, true), height: dv.getUint32(d + 20, true),
            depth: dv.getUint32(d + 24, true), levels: dv.getUint32(d + 28, true), views: new Map(), fmt: NVN_FORMATS[format] });
          break;
        }
        case H.TEX_DESTROY: { const s = this.u64(dv, p + 8), t = this.textures.get(s); if (t) { this.flush(); t.gpu?.destroy(); t.snap?.destroy(); this.textures.delete(s); } break; }
        case H.BEGIN_PASS: this.beginPass(dv, p); break;
        case H.END_PASS: this.endPass(); break;
        case H.VIEWPORT: this.pass.setViewport(dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true), Math.max(dv.getFloat32(p + 24, true), dv.getFloat32(p + 28, true))); break;
        case H.SCISSOR: this.pass.setScissorRect(dv.getUint32(p + 8, true), dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 20, true)); break;
        case H.PIPELINE_CREATE: this.createPipeline(dv.getUint32(p + 8, true), dv.getUint32(p + 12, true)); break;
        case H.PIPELINE: this.usePipeline(dv.getUint32(p + 8, true)); break;
        case H.VBUF: { const b = this.upload(this.u64(dv, p + 16), dv.getUint32(p + 12, true), 0); if (b) this.pass.setVertexBuffer(dv.getUint32(p + 8, true), b); break; }
        case H.UBO: this.ubo.set(dv.getUint32(p + 8, true) * 16 + dv.getUint32(p + 12, true), { addr: this.u64(dv, p + 16), size: dv.getUint32(p + 24, true) }); this.bindDirty = true; break;
        case H.TEX: {
          const flags = dv.getUint32(p + 24, true);
          this.tex.set(dv.getUint32(p + 8, true) * 64 + dv.getUint32(p + 12, true), { serial: this.u64(dv, p + 16), snap: (flags & 1) !== 0, view: flags & 2 ? this.u8.slice(p + 32, p + 48) : null, samp: dv.getUint32(p + 28, true) });
          this.bindDirty = true; break;
        }
        case H.BLEND_COLOR: this.pass.setBlendConstant([0, 1, 2, 3].map(i => dv.getFloat32(p + 8 + i * 4, true))); break;
        case H.STENCIL_REF: this.pass.setStencilReference(dv.getUint32(p + 8, true)); break;
        case H.DRAW: case H.DRAW_IDX: {
          if (!this.cur) break;
          if (this.bindDirty) this.bind();
          if (op === H.DRAW) this.pass.draw(dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 8, true), dv.getUint32(p + 20, true));
          else {
            const itype = dv.getUint32(p + 8, true), count = dv.getUint32(p + 12, true), isz = itype === 2 ? 4 : itype === 1 ? 2 : 1;
            const ib = this.upload(this.u64(dv, p + 32), count * isz, itype === 0 ? 1 : 2);
            if (!ib) break;
            this.pass.setIndexBuffer(ib, itype === 2 ? "uint32" : "uint16");
            this.pass.drawIndexed(count, dv.getUint32(p + 16, true), 0, dv.getInt32(p + 24, true), dv.getUint32(p + 20, true));
          }
          this.stats.draws++; break;
        }
        case H.CLEAR_RECT: this.clearRect(dv, p); break;
        case H.COPY_B2T: this.copyB2T(dv, p); break;
        case H.COPY_T2T: this.copyT2T(dv, p); break;
        case H.SNAPSHOT: this.snapshot(this.u64(dv, p + 8)); break;
        case H.PRESENT: this.present(dv, p); break;
        case H.FENCE: { const n = this.u64(dv, p + 8); this.flush(); const rb = this.readbacks.slice(); this.device.queue.onSubmittedWorkDone().then(() => Promise.all(rb)).then(() => this.x.gfx_fence_signal(n)); break; }
        case H.TEX_DATA: this.texData(dv, p); break;
        case H.FIXUP: { const f = [0, 1, 2, 3].map(i => dv.getFloat32(p + 8 + i * 4, true)); if (f.some((v, i) => v !== this.fix[i])) { this.fix = f; this.bindDirty = true; } break; }
        case H.COPY_T2B: this.copyT2B(dv, p); break;
        case H.FLUSH: this.flush(); break;
        case H.MEM_DIRTY: this.dropUploads(); break;
        default: this.log(`[RED] host stream: unknown op ${op} at 0x${p.toString(16)}`); return;
      }
      if (dv.buffer !== this.memory.buffer) dv = this.dv;
      p += size;
    }
  }

  // ---- reading back (tests, screenshots): the texels of one level and layer of a colour texture, tightly packed ----
  async readTexture(serial: number, level = 0, layer = 0): Promise<{ width: number; height: number; bytesPerPixel: number; data: Uint8Array }> {
    this.x.gfx_flush(); this.flush();
    const t = this.texture(serial);
    if (!t) throw new Error(`no texture ${serial}`);
    // width and height are in blocks, bytesPerPixel the bytes of one block (a texel for uncompressed formats)
    const pw = Math.max(1, t.width >> level), ph = t.target === 0 || t.target === 3 ? 1 : Math.max(1, t.height >> level), w = Math.ceil(pw / t.fmt.bw), h = Math.ceil(ph / t.fmt.bh), bpp = t.fmt.bpb, row = Math.ceil(w * bpp / 256) * 256;
    const buf = this.device.createBuffer({ size: row * h, usage: 0x01 | 0x08 /* MAP_READ | COPY_DST */ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: t.gpu, mipLevel: level, origin: { x: 0, y: 0, z: layer } }, { buffer: buf, bytesPerRow: row, rowsPerImage: h }, { width: w * t.fmt.bw, height: h * t.fmt.bh, depthOrArrayLayers: 1 });
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(1);
    const src = new Uint8Array(buf.getMappedRange()), data = new Uint8Array(w * h * bpp);
    for (let y = 0; y < h; y++) data.set(src.subarray(y * row, y * row + w * bpp), y * w * bpp);
    buf.unmap(); buf.destroy();
    return { width: w, height: h, bytesPerPixel: bpp, data };
  }
}
