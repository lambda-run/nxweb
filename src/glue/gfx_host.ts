// nxweb graphics glue, the replayer: executes the host stream of the recorder (src/gfx, AssemblyScript) on WebGPU.
// The recorder decides everything NVN (pass boundaries, load actions, bindings, pipeline keys, what is skipped); this
// file reads each record and the tables it points to from the shared linear memory and makes the WebGPU call for it.
// Record layouts: src/gfx/hostops.ts. Pipeline key: src/gfx/pipeline.ts. Texture description: nvn_texdesc (obj.ts).
// Browser code (WebGPU types are left loose: the tree has no @webgpu/types).
import { NVN_FORMATS, COMPARE, STENCIL_OP, BLEND_EQ, BLEND_FUNC, TOPOLOGY, WRAP, STORAGE_FORMATS, hostFormat, type NvnFormat } from "./gfx_formats.ts";
import { describeRecord, png, toRgba8, type Capture, type CaptureImage } from "./gfx_capture.ts";
export type { Capture, CaptureImage } from "./gfx_capture.ts";

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

export type VinClass = "float" | "sint" | "uint";
// A translated shader as the library holds it: the shader chain's reflection record (tools/shaders, src/shaders
// library.ts Reflection) plus the WGSL. Binding convention (src/gfx/README.md), stage = 0 vertex, 1 fragment, 2 compute:
//   @group(0) @binding(stage * 16 + i)          uniform buffer i of the stage; i = 14 is the translator's support buffer
//   @group(0) @binding(128 + stage * 16 + i)    storage buffer i
//   @group(1) @binding(stage * 64 + slot * 2)   texture slot, and + 1 its sampler
//   @group(1) @binding(256 + stage * 8 + i)     storage image i
//   @group(2) @binding(0)                       the position fix-up (vertex, `fixup`)
//   vertex inputs @location(l) = NVN attribute l, fragment outputs @location(i) = colour target i
export interface ShaderInfo {
  stage: "vertex" | "fragment" | "compute";
  wgsl: string;
  entry?: string;
  ubos?: number[];
  uboSize?: Record<string, number>;   // slot -> bytes the WGSL type covers: at least that is bound, zero past what the game bound
  // `handle`: a bindless slot. The shader samples the binding of `slot`; which texture and sampler that is stands in the game's uniform data, read at each draw:
  // the u32 at byte `offset` of this stage's uniform slot `ubo` (texture ID in the low 20 bits, sampler ID in the high 12). `sampler`: another word ORed into
  // it (the texture in one, the sampler in the other), or the sampler ID as a constant of the shader. A slot with a handle ignores nvnCommandBufferBindTexture
  textures?: { slot: number; dim?: "2d" | "2d-array" | "cube" | "3d" | "cube-array"; depth?: boolean; sampleType?: "float" | "unfilterable-float" | "sint" | "uint"; handle?: TextureHandle }[];
  attributes?: number[];   // vertex: locations read
  attributeTypes?: Record<string, VinClass>;   // vertex: the class each input is declared with
  // vertex: the module to use when the bound attribute formats have other classes than declared. Either texts by
  // signature ("0:float,1:uint": every location read, ascending) or a function (the chain translating on demand)
  variants?: Record<string, string>;
  variant?: (classes: Record<number, VinClass>) => string | undefined;
  fixup?: boolean;         // vertex: declares `@group(2) @binding(0) var<uniform>` of one vec4f, the position fix-up (README)
  outputs?: number[];      // fragment: colour outputs written
  support?: boolean;       // reads the support buffer; also taken from `extra` (kind "support")
  storage?: { slot: number; write?: boolean }[];
  images?: { slot: number; format: string; access?: "write-only" | "read-only" | "read-write"; dim?: "2d" | "2d-array" | "3d" }[];
  extra?: { kind: string; group: number; binding: number; size?: number }[];   // the chain's other bindings: only "support" is provided
}
export interface TextureHandle { ubo: number; offset: number; sampler?: { ubo: number; offset: number } | { id: number } }
export interface GfxHostOptions {
  canvas?: any;
  log?: (line: string) => void;
  // Decode ASTC on the CPU even when the adapter has it (tests); without the feature it is always decoded
  forceAstcDecode?: boolean;
  // false: a GPU buffer per bound uniform range, hashed at each use (the path before the uniform arena: measurements)
  uniformArena?: boolean;
  // Device loss: called for a new GPUDevice after GPUDevice.lost; without it restore() must be called by the embedder
  requestDevice?: () => Promise<GPU>;
  // Upper bounds on the device's limits as the replayer sees them (name -> value, e.g. maxSampledTexturesPerShaderStage: 16): a pipeline that needs more
  // fails with the replayer's own red line, as on a device that has no more. For tests, and to see what a smaller device would refuse
  limits?: Record<string, number>;
  // The guest clock in nanoseconds, for counter reports (the times their timestamps are made of). Omitted: performance.now()
  now?: () => bigint;
  // false: do not use WebGPU timestamp queries even when the device has them (counter reports then take times estimated
  // on the CPU from when a segment was handed to the GPU and when the GPU reported it done)
  timestampQuery?: boolean;
}

const H = { TEX_CREATE: 1, TEX_DESTROY: 2, BEGIN_PASS: 3, END_PASS: 4, VIEWPORT: 5, SCISSOR: 6, PIPELINE_CREATE: 7, PIPELINE: 8, VBUF: 9, UBO: 10, TEX: 11,
  BLEND_COLOR: 12, STENCIL_REF: 13, DRAW: 14, DRAW_IDX: 15, CLEAR_RECT: 16, COPY_B2T: 17, COPY_T2T: 18, SNAPSHOT: 19, PRESENT: 20, FENCE: 21, FLUSH: 22, MEM_DIRTY: 23, TEX_DATA: 24, COPY_T2B: 25, FIXUP: 26,
  UBO_DATA: 27, SSBO: 28, IMG: 29, BEGIN_COMPUTE: 30, DISPATCH: 31, BUF_READBACK: 32 };
// Pipeline key offsets (src/gfx/pipeline.ts)
const PK = { vs: 0, fs: 2, prim: 4, cull: 5, front: 6, polyMode: 7, offsetEn: 8, samples: 9, ncolor: 10, depthFmt: 11, colorFmt: 12, a2c: 20, flags: 21, blendEn: 22, stencilV: 23, stencilW: 24,
  itype: 25, chmask: 28, ds: 32, blend: 40, offset: 104, attrMask: 116, attr: 120, stream: 248, vin: 376 };
const DIMS = ["2d", "2d-array", "cube", "3d", "cube-array"], CLASSES: VinClass[] = ["float", "sint", "uint"];

interface Tex { serial: number; target: number; format: number; flags: number; samples: number; width: number; height: number; depth: number; levels: number;
  gpu?: GPU; snap?: GPU; views: Map<string, GPU>; fmt: NvnFormat & { conv?: boolean } }
interface Slot { binding: number; st: number; i: number; kind: "ubo" | "ssbo"; dyn: boolean; write: boolean }
interface Pipe { id: number; compute: boolean; desc: any; gpu?: GPU; stages: number[]; key: number; layouts: GPU[]; g0: Slot[]; gen: number;
  dynOnly?: boolean; last0?: { bufs: GPU[]; sizes: number[]; group: GPU }; empty1?: GPU }
interface Chunk { buf: GPU; staging: Uint8Array; used: number }
interface UaSlot { c: Chunk; off: number; size: number }
interface GpuRange { addr: number; size: number; buf: GPU; hash: number; pending: number }

// The one reinterpretation WebGPU allows a view: the sRGB twin of the texture's format
const SRGB_TWIN: Record<string, string> = {};
for (const b of ["rgba8unorm", "bgra8unorm", "bc1-rgba-unorm", "bc2-rgba-unorm", "bc3-rgba-unorm", "bc7-rgba-unorm", ...[[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]].map(([w, h]) => `astc-${w}x${h}-unorm`)]) { SRGB_TWIN[b] = b + "-srgb"; SRGB_TWIN[b + "-srgb"] = b; }
// Features asked of the adapter when it has them, and the limits raised to what it offers (GfxHost.deviceDescriptor)
const FEATURES = ["texture-compression-bc", "texture-compression-astc", "rg11b10ufloat-renderable", "depth32float-stencil8", "depth-clip-control", "texture-formats-tier1", "bgra8unorm-storage",
  "dual-source-blending", "float32-filterable", "clip-distances"];
const LIMITS = ["maxUniformBuffersPerShaderStage", "maxSampledTexturesPerShaderStage", "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage", "maxStorageTexturesPerShaderStage",
  "maxDynamicUniformBuffersPerPipelineLayout", "maxVertexAttributes", "maxVertexBuffers", "maxColorAttachmentBytesPerSample", "maxBindingsPerBindGroup", "maxInterStageShaderVariables", "maxBufferSize",
  "maxStorageBufferBindingSize", "maxUniformBufferBindingSize", "maxTextureDimension2D", "maxTextureArrayLayers", "maxBindGroups", "maxBindGroupsPlusVertexBuffers"];
const UA_CHUNK = 1 << 20, UA_ALIGN = 256;
FEATURES.push("timestamp-query");
const H_REPORT = 33, H_REPORT_COMMIT = 34;       // hostops.ts
const TS_QUERIES = 512;                          // two a render pass: its start and its end
// One piece of work handed to the GPU (a queue.submit), as counter reports need it timed. Times are guest nanoseconds
interface Seg { submitAt: bigint; startAt: bigint; doneAt: bigint; prev: Seg | null; q0: number; q1: number; gpu0: bigint; gpu1: bigint; done: Promise<void> | null }

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
  stats = { passes: 0, computePasses: 0, draws: 0, dispatches: 0, pipelinesAsync: 0, pipelinesSync: 0, pipelinesFailed: 0, uploads: 0, uploadBytes: 0, hashes: 0, bindGroups: 0, submits: 0, presents: 0, snapshots: 0,
    clearRects: 0, errors: 0, uniformSlots: 0, uniformBytes: 0, uniformWrites: 0, resolves: 0, bufferReadbacks: 0, deviceLosses: 0 };
  // What the device takes as it is, told to the recorder at attach (gfx_host_caps): 1 ASTC, 2 16-bit normalized formats
  caps = 0;
  // Hooks for the embedder (the kernel's waits): a fence completed (everything submitted before it is done on the GPU
  // and every read-back issued before it has landed in guest memory); a window image was queued (what 0) or shown (1);
  // the device was lost, and replaced
  onFence: ((fence: number) => void) | null = null;
  onImage: ((window: number, index: number, what: number) => void) | null = null;
  onDeviceLost: ((info: { reason?: string; message?: string }) => void) | null = null;
  onDeviceRestored: ((texturesGone: number) => void) | null = null;
  // Called when a vertex shader is bound with attribute formats of another class than it declares and has no variant:
  // the shader chain's hook to translate one (return its WGSL, or undefined: the pipeline fails with a red line)
  onShaderVariant: ((keyHex: string, classes: Record<number, VinClass>) => string | undefined) | null = null;

  private opts: GfxHostOptions;
  private gen = 1;            // the device's generation: completions of an earlier device are dropped
  private lost = false;
  private shaders: { info: ShaderInfo; key: string; module?: GPU; variants?: Map<string, GPU | null> }[] = [];
  private textures = new Map<number, Tex>();
  private pipes = new Map<number, Pipe>();
  private layouts = new Map<string, GPU>();
  private samplers = new Map<string, GPU>();
  private enc: GPU = null;
  private pass: GPU = null;
  private computePass = false;
  private passInfo: { colorFmt: (string | null)[]; depthFmt: string | null; samples: number; w: number; h: number; targets: { name: string; serial: number; level: number; layer: number }[] } | null = null;
  private inUse: GPU[] = [];
  private pool = new Map<number, GPU[]>();
  private cur: Pipe | null = null;
  private ubo = new Map<number, { addr: number; size: number; need: number; data?: Uint8Array }>();
  private tex = new Map<number, { serial: number; snap: boolean; view: Uint8Array | null; samp: number }>();
  private ssbo = new Map<number, { addr: number; size: number; write: boolean }>();
  private img = new Map<number, { serial: number; view: Uint8Array | null }>();
  private bindDirty = true;
  private fix = [1, 1, 1, 0];
  private fixGroups = new Map<string, GPU>();
  presentFlips = 0;
  private dummy: GPU = null;
  private helpers = new Map<string, GPU>();
  private redOnce = new Set<string>();
  private readbacks: Promise<void>[] = [];   // read-backs (texture or storage buffer) that have not landed in guest memory yet
  private queued: { buf: GPU; dst: number; row: number; rows: number; wb: number; img: number; depth: number; srcRow: number }[] = [];
  private queuedBufs: { buf: GPU; range: GpuRange }[] = [];
  private fenceWaiters: { n: number; go: () => void }[] = [];
  private fencesPending = new Set<number>();

  constructor(device: GPU, memory: WebAssembly.Memory, opts: GfxHostOptions = {}) {
    this.device = device; this.memory = memory; this.opts = opts;
    this.log = opts.log ?? (l => console.log(l));
    this.uniformArena = opts.uniformArena ?? true;
    this.adopt(device);
  }
  // What to ask an adapter for: every feature the replayer can use that it has, and the per-stage limits raised to
  // what it offers (WebGPU's defaults are 12 uniform buffers, 16 sampled textures and 16 samplers a stage; a game's
  // shader stage can declare 14 uniform blocks plus the support buffer and 32 textures)
  static deviceDescriptor(adapter: GPU): { requiredFeatures: string[]; requiredLimits: Record<string, number> } {
    const requiredLimits: Record<string, number> = {};
    for (const l of LIMITS) if (typeof adapter.limits?.[l] === "number") requiredLimits[l] = adapter.limits[l];
    return { requiredFeatures: FEATURES.filter(f => adapter.features.has(f)), requiredLimits };
  }
  private adopt(device: GPU) {
    this.device = device;
    const has = (f: string) => !!device.features?.has?.(f);
    this.uaAlign = Math.max(16, this.limit("minUniformBufferOffsetAlignment", UA_ALIGN));
    this.caps = (has("texture-compression-astc") && !this.opts.forceAstcDecode ? 1 : 0) | (has("texture-formats-tier1") ? 2 : 0);
    this.timestampSource = has("timestamp-query") && this.opts.timestampQuery !== false ? "gpu" : "cpu";
    if (this.opts.canvas) {
      this.context = this.opts.canvas.getContext("webgpu");
      this.canvasFormat = (globalThis as any).navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({ device, format: this.canvasFormat, alphaMode: "opaque" });
    }
    device.onuncapturederror = (e: any) => { this.stats.errors++; this.log(`[RED] WebGPU: ${String(e.error?.message ?? e).split("\n")[0]}`); };
    const gen = this.gen;
    device.lost?.then?.((info: any) => { if (gen === this.gen) void this.deviceLost(info); });
  }
  // Every texture and buffer the replayer makes, until it destroys it: what dispose() releases
  private live = new Set<GPU>();
  private newBuffer(desc: any): GPU { const o = this.device.createBuffer(desc); this.live.add(o); return o; }
  private newTexture(desc: any): GPU { const o = this.device.createTexture(desc); this.live.add(o); return o; }
  private kill(o: GPU): void { if (o) { this.live.delete(o); o.destroy(); } }
  get liveObjects(): number { return this.live.size; }
  disposed = false;
  // The process that used this replayer is gone: every texture and buffer it made is destroyed (pipelines, bind
  // groups, samplers and shader modules have no destroy and go with their last reference, which is dropped here),
  // completions still under way are ignored, and the canvas is left configured for the next replayer on the device.
  // Returns how many objects were destroyed. Nothing may be executed afterwards.
  dispose(): number {
    if (this.disposed) return 0;
    this.disposed = true; this.gen++;
    try { if (this.pass) this.pass.end(); } catch { /* the device may be gone */ }
    let n = 0;
    for (const o of this.live) { try { o.destroy(); n++; } catch { /* gone already */ } }
    this.live.clear();
    for (const t of this.textures.values()) { t.gpu = undefined; t.snap = undefined; t.views.clear(); }
    this.textures.clear(); this.shaders = [];
    this.pipes.clear(); this.layouts.clear(); this.samplers.clear(); this.helpers.clear(); this.dummies.clear(); this.fixGroups.clear(); this.groups.clear(); this.ranges.clear(); this.pool.clear();
    this.converted.clear(); this.gpuRanges.clear(); this.uaPool = []; this.uaDone = []; this.uaCur = null; this.uaSeen.clear();
    this.inUse = []; this.queued = []; this.queuedBufs = []; this.dummy = null; this.zero = null; this.scratchSt = null; this.enc = null; this.pass = null; this.cur = null; this.passInfo = null;
    this.readbacks = [];
    // nobody waits on a replayer that is gone
    const waiters = this.fenceWaiters; this.fenceWaiters = []; this.fencesPending.clear();
    for (const w of waiters) w.go();
    this.onFence = this.onImage = this.onDeviceLost = this.onDeviceRestored = null;
    if (this.device.onuncapturederror) this.device.onuncapturederror = null;
    return n;
  }
  private limit(name: string, fallback: number): number {
    const v = this.device.limits?.[name], n = typeof v === "number" ? v : fallback, clamp = this.opts.limits?.[name];
    return typeof clamp === "number" ? Math.min(n, clamp) : n;
  }

  // The recorder's imports that belong to the replayer; the embedder adds env.log, env.gfx_guest_call, env.gfx_proc_address
  imports() { return { gfx_exec: (ptr: number, len: number) => this.exec(ptr >>> 0, len >>> 0) }; }
  attach(x: GfxExports) { this.x = x; x.gfx_host_caps?.(this.caps); }
  private red(key: string, line: string) { if (!this.redOnce.has(key)) { this.redOnce.add(key); this.log(`[RED] ${line}`); } }
  private get dv() { return new DataView(this.memory.buffer); }
  private memView: Uint8Array | null = null;
  private get u8() { let v = this.memView; if (!v || v.buffer !== this.memory.buffer) v = this.memView = new Uint8Array(this.memory.buffer); return v; }

  // ---- fences and window images: what the embedder waits on ----
  // A promise for fence n (null when it is already done). Fences are numbered in submission order; n is done when the
  // GPU has finished everything submitted before it and every read-back issued before it has landed in guest memory.
  fence(n: number): Promise<void> | null {
    if (!n || this.x.gfx_fence_done(n)) return null;
    return new Promise<void>(go => this.fenceWaiters.push({ n, go }));
  }
  // The replayer calls these; an embedder that runs the recorder without a device (a null replayer) calls them itself
  signalFence(n: number) {
    this.fencesPending.delete(n);
    this.x.gfx_fence_signal(n);
    if (this.fenceWaiters.length) { const due = this.fenceWaiters.filter(w => w.n <= n); this.fenceWaiters = this.fenceWaiters.filter(w => w.n > n); for (const w of due) w.go(); }
    this.onFence?.(n);
  }
  imageEvent(window: number, index: number, what: number) { this.x.gfx_image_event(window, index, what); this.onImage?.(window, index, what); }

  // ---- device loss ----
  private async deviceLost(info: any) {
    this.lost = true; this.stats.deviceLosses++;
    this.log(`[RED] WebGPU device lost (${info?.reason ?? "unknown"}): ${String(info?.message ?? "").split("\n")[0]}`);
    this.x?.gfx_device_lost?.();
    // What was submitted to the dead device will never finish: its fences complete now, so no guest thread waits forever
    for (const n of [...this.fencesPending].sort((a, b) => a - b)) this.signalFence(n);
    this.reportsLost();
    this.onDeviceLost?.(info ?? {});
    if (this.opts.requestDevice) {
      try { const d = await this.opts.requestDevice(); if (d) this.restore(d); else this.log("[RED] no new WebGPU device after the loss: nothing is drawn"); }
      catch (e: any) { this.log(`[RED] no new WebGPU device after the loss: ${e?.message ?? e}`); }
    }
  }
  // A new device after a loss: every GPU object is dropped and made again from guest state. Textures whose content is
  // in guest memory are uploaded again at their next use; pipelines are requested again; what only the GPU held
  // (render targets, copies) is empty until the game writes it again (the count is returned and logged red)
  restore(device: GPU): number {
    this.gen++;
    this.live.clear();   // they belonged to the device that is gone
    for (const t of this.textures.values()) { t.gpu = undefined; t.snap = undefined; t.views.clear(); }
    for (const s of this.shaders) if (s) { s.module = undefined; s.variants = undefined; }
    this.pipes.clear(); this.layouts.clear(); this.samplers.clear(); this.helpers.clear(); this.dummies.clear(); this.fixGroups.clear(); this.groups.clear(); this.ranges.clear(); this.pool.clear();
    this.converted.clear(); this.gpuRanges.clear(); this.uaPool = []; this.uaDone = []; this.uaCur = null; this.uaSeen.clear();
    this.inUse = []; this.queued = []; this.queuedBufs = []; this.dummy = null; this.zero = null; this.scratchSt = null; this.enc = null; this.pass = null; this.cur = null; this.passInfo = null;
    this.adopt(device);
    this.lost = false;
    this.x.gfx_host_caps?.(this.caps);
    const gone = this.x.gfx_device_restored() >>> 0;
    this.onDeviceRestored?.(gone);
    return gone;
  }

  // ---- the shader library ----
  // keyHex: the 16 hex digits of a stage's key, sha256(control section + code)[0..8] (src/gfx/shader.ts). info: the
  // shader chain's reflection record with the WGSL. -1 (with a red line) when it needs a binding the replayer lacks
  registerShader(keyHex: string, info: ShaderInfo): number {
    const dv = this.dv, r = this.x.gfx_scratch() >>> 0, bit = (a?: number[]) => (a ?? []).reduce((m, i) => m | (1 << i), 0) >>> 0;
    const unknown = (info.extra ?? []).filter(e => e.kind !== "support");
    if (unknown.length) { this.log(`[RED] shader ${keyHex} needs bindings the replayer does not provide (${unknown.map(e => e.kind).join(", ")}): not registered`); return -1; }
    const support = info.support || (info.extra ?? []).some(e => e.kind === "support"), st = info.stage === "vertex" ? 0 : info.stage === "fragment" ? 1 : 2;
    new Uint8Array(this.memory.buffer, r, 400).fill(0);
    let depth = 0, bindless = 0;
    for (const t of info.textures ?? []) {
      const h = t.handle;
      if (!h) continue;
      // the record's entry of the slot (src/gfx/shader.ts RF_blh): kind, uniform slot, byte offset; the sampler's uniform slot and offset, or its ID
      const word = (w: { ubo: number; offset: number }) => Number.isInteger(w.ubo) && w.ubo >= 0 && w.ubo < 14 && Number.isInteger(w.offset) && w.offset >= 0 && w.offset < 65536 && w.offset % 4 === 0;
      const sm: any = h.sampler, id = sm && "id" in sm;
      if (!(t.slot >= 0 && t.slot < 32) || !word(h) || (sm && (id ? !(Number.isInteger(sm.id) && sm.id >= 0 && sm.id < 4096) : !word(sm)))) {
        this.log(`[RED] shader ${keyHex}: texture slot ${t.slot} has a handle the replayer cannot read (${JSON.stringify(h)}; uniform slots 0..13, byte offsets in words below 65536, sampler IDs below 4096): not registered`); return -1;
      }
      const e = r + 144 + t.slot * 8;
      dv.setUint8(e, !sm ? 0 : id ? 3 : 1); dv.setUint8(e + 1, h.ubo); dv.setUint16(e + 2, h.offset, true);
      dv.setUint8(e + 4, sm && !id ? sm.ubo : 0); dv.setUint16(e + 6, sm ? (id ? sm.id : sm.offset) : 0, true);
      bindless |= 1 << t.slot;
    }
    dv.setUint32(r + 140, bindless >>> 0, true);
    for (const t of info.textures ?? []) { dv.setUint8(r + 32 + t.slot, Math.max(0, DIMS.indexOf(t.dim ?? "2d"))); if (t.depth) depth |= 1 << t.slot; }
    dv.setUint32(r, st, true); dv.setUint32(r + 4, (bit(info.ubos) | (support ? 1 << 14 : 0)) >>> 0, true); dv.setUint32(r + 8, bit((info.textures ?? []).map(t => t.slot)), true);
    dv.setUint32(r + 12, bit(st === 0 ? info.attributes : info.outputs), true); dv.setUint32(r + 16, depth >>> 0, true);
    dv.setUint32(r + 20, bit((info.storage ?? []).map(b => b.slot)), true); dv.setUint32(r + 24, bit((info.storage ?? []).filter(b => b.write).map(b => b.slot)), true);
    dv.setUint32(r + 28, (bit((info.images ?? []).map(b => b.slot)) | bit((info.images ?? []).filter(b => (b.access ?? "write-only") !== "read-only").map(b => b.slot)) << 8) >>> 0, true);
    for (const [slot, size] of Object.entries(info.uboSize ?? {})) if (+slot < 14) dv.setUint32(r + 64 + +slot * 4, size, true);
    if (st === 0 && info.attributeTypes) {
      let vin = 0n;
      for (const l of info.attributes ?? []) vin |= BigInt(Math.max(0, CLASSES.indexOf(info.attributeTypes[l] ?? "float"))) << BigInt(l * 2);
      dv.setBigUint64(r + 128, vin, true); dv.setUint32(r + 136, 1, true);
    }
    const b = keyHex.match(/../g)!.map(h => parseInt(h, 16));
    const lo = (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0, hi = (b[4] | b[5] << 8 | b[6] << 16 | b[7] << 24) >>> 0;
    const id = this.x.gfx_shader_register(lo, hi, r);
    if (id >= 0) this.shaders[id] = { info: { ...info, support }, key: keyHex };
    return id;
  }
  // What the embedder does about a key that is not registered: "pending" it is being fetched or translated (the
  // recorder skips its draws without its red line), "failed" it could not be had and the embedder has said so
  // itself, "forget" nothing any more (the recorder reports it missing again). false: the key is registered.
  shaderPending(keyHex: string, what: "pending" | "failed" | "forget"): boolean {
    const b = keyHex.match(/../g)!.map(h => parseInt(h, 16));
    const lo = (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0, hi = (b[4] | b[5] << 8 | b[6] << 16 | b[7] << 24) >>> 0;
    return this.x.gfx_shader_pending(lo, hi, what === "pending" ? 1 : what === "failed" ? 2 : 0) !== 0;
  }
  private module(id: number): GPU { const s = this.shaders[id]; return (s.module ??= this.device.createShaderModule({ code: s.info.wgsl })); }
  // The module of a vertex shader for attribute classes other than it declares; null when there is none (red: the request)
  private variantModule(id: number, classes: Record<number, VinClass>): GPU | null {
    const s = this.shaders[id], sig = Object.keys(classes).map(Number).sort((a, b) => a - b).map(l => `${l}:${classes[l]}`).join(",");
    s.variants ??= new Map();
    let m = s.variants.get(sig);
    if (m === undefined) {
      const wgsl = s.info.variants?.[sig] ?? s.info.variant?.(classes) ?? this.onShaderVariant?.(s.key, classes);
      m = wgsl ? this.device.createShaderModule({ code: wgsl }) : null;
      s.variants.set(sig, m);
      if (!m) this.log(`[RED] vertex shader ${s.key} is bound with attribute classes ${sig}, but declares ${(s.info.attributes ?? []).map(l => `${l}:${s.info.attributeTypes?.[l] ?? "float"}`).join(",")}: WebGPU needs a variant of its text from the shader chain (ShaderInfo.variants / onShaderVariant); its draws are skipped`);
    }
    return m;
  }

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
    if (!ms && (STORAGE_FORMATS.has(t.fmt.tex) || (t.fmt.tex === "bgra8unorm" && this.device.features?.has?.("bgra8unorm-storage")))) usage |= 0x08; /* STORAGE_BINDING */
    const twin = SRGB_TWIN[t.fmt.tex];
    // WebGPU has 1 and 4 samples: a multisampled NVN texture of any count has 4
    t.gpu = this.newTexture({ ...(twin ? { viewFormats: [twin] } : {}), size: { width: up(t.width, t.fmt.bw), height: up(h, t.fmt.bh), depthOrArrayLayers: is3d ? Math.max(1, t.depth) : layers }, format: t.fmt.tex,
      dimension: is3d ? "3d" : "2d", mipLevelCount: ms ? 1 : Math.max(1, t.levels), sampleCount: ms ? 4 : 1, usage });
    return t;
  }
  private layerCount(t: Tex) { return t.gpu.depthOrArrayLayers; }
  // view: a view_t (16 bytes) or null; attach: one level and layer, for a render target or a copy
  private view(t: Tex, src: GPU, view: Uint8Array | null, dim?: string, oneLevel = false): GPU {
    const key = (src === t.snap ? "s" : "t") + (dim ?? "") + (oneLevel ? "1" : "") + (view ? Array.from(view).join(",") : "");
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
      if (bits & 4) {
        const want = hostFormat(view[4] | view[5] << 8, this.caps)?.tex;
        if (want && want !== t.fmt.tex) { if (want === SRGB_TWIN[t.fmt.tex!]) { d.format = want; d.usage = t.gpu.usage & ~0x08; } else this.red(`viewfmt${want}${t.fmt.tex}`, `a texture view reads ${t.fmt.tex} as ${want}: WebGPU views can only switch sRGB, the texture's own format is used`); }
      }
      if ((bits & 16) && (view[10] !== 2 || view[11] !== 3 || view[12] !== 4 || view[13] !== 5)) this.red("swizzle", "a texture view with a channel swizzle: WebGPU views have none (the shader chain would have to apply it), ignored");
    } else if (d.dimension === "2d" && this.layerCount(t) > 1) d.arrayLayerCount = 1;
    if (d.dimension === "cube" && d.arrayLayerCount === undefined && this.layerCount(t) > 6) d.arrayLayerCount = 6;
    if (oneLevel) d.mipLevelCount = 1;
    if (t.fmt.kind === "depth" && t.fmt.stencil) d.aspect = view && (view[0] & 0x20) && (view[0] >> 6) === 1 ? "stencil-only" : "depth-only";
    v = src.createView(d);
    t.views.set(key, v);
    return v;
  }
  private attachView(t: Tex, level: number, layer: number, format?: string): GPU {
    if (format === t.fmt.tex || format !== SRGB_TWIN[t.fmt.tex!]) format = undefined;
    const key = `a${level}/${layer}/${format ?? ""}`;
    let v = t.views.get(key);
    if (!v) { v = t.gpu.createView({ ...(format ? { format, usage: t.gpu.usage & ~0x08 } : {}), dimension: t.gpu.dimension === "3d" ? "3d" : "2d", baseMipLevel: level, mipLevelCount: 1, ...(t.gpu.dimension === "3d" ? {} : { baseArrayLayer: layer, arrayLayerCount: 1 }) }); t.views.set(key, v); }
    return v;
  }
  private dummies = new Map<string, GPU>();
  private dummyView(dim: string): GPU {
    this.dummy ??= this.newTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 6 }, format: "rgba8unorm", usage: 0x04 | 0x02 });
    let v = this.dummies.get(dim);
    if (!v) {
      if (dim === "3d") v = this.newTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 1 }, dimension: "3d", format: "rgba8unorm", usage: 0x04 | 0x02 }).createView();
      else v = this.dummy.createView({ dimension: dim, ...(dim === "2d" ? { arrayLayerCount: 1 } : {}) });
      this.dummies.set(dim, v);
    }
    return v;
  }

  // ---- guest memory to GPU buffers ----
  // A bound range (vertex or index data at an address with a size; uniform data too without the uniform arena) keeps
  // its GPU buffer across submissions. At its first use after guest memory may have changed (a new submission,
  // H_MEM_DIRTY, a read-back landing) its bytes are hashed by the recorder (gfx_hash); the buffer is written only when
  // the hash differs. A range that changed while its buffer is still referenced by commands not yet submitted gets
  // another buffer. Ranges unused for 240 submissions give their buffer back. cacheUploads = false: every range is
  // written every submission.
  cacheUploads = true;
  private ranges = new Map<string, { buf: GPU; hash: number; checked: number; used: number }>();
  private epoch = 1;          // changes whenever guest memory may have
  private flushNo = 1;
  private upOff = 0;          // the offset of the last upload() inside the buffer it returned (a GPU-written range holds it at an offset)
  private alloc(cap: number): GPU { return this.pool.get(cap)?.pop() ?? this.newBuffer({ size: cap, usage: 0x04 | 0x08 | 0x10 | 0x20 | 0x40 | 0x80 /* COPY_SRC COPY_DST INDEX VERTEX UNIFORM STORAGE */ }); }
  private upload(addr: number, size: number, kind: number): GPU | null {
    this.upOff = 0;
    if (this.gpuRanges.size && kind !== 1) { const r = this.gpuRangeOver(addr, size); if (r) { this.upOff = addr - r.addr; return r.buf; } }
    const key = `${addr}:${size}:${kind}`;
    let e = this.ranges.get(key);
    if (e && e.checked === this.epoch) { e.used = this.flushNo; return e.buf; }
    if (!addr || !size || addr + size > this.memory.buffer.byteLength) { this.red(`up${addr}`, `a draw binds memory outside the guest's (address 0x${addr.toString(16)} size ${size}): not bound`); return null; }
    const hash = this.cacheUploads ? this.x.gfx_hash(addr, size) : NaN;
    this.stats.hashes++;
    if (e && e.hash === hash) { e.checked = this.epoch; e.used = this.flushNo; return e.buf; }
    const cap = Math.max(256, 2 ** Math.ceil(Math.log2(size))) * (kind === 1 ? 2 : 1);
    if (e && e.used === this.flushNo) { this.inUse.push(e.buf); e = undefined; }       // still referenced by the open encoder: leave it, take another
    const b = e?.buf ?? this.alloc(cap);
    const n = Math.min(cap, (size + 3) & ~3, this.memory.buffer.byteLength - addr) & ~3;
    if (kind === 1) {   // 8-bit indices: WebGPU has none, widened to 16
      const src = this.u8.subarray(addr, addr + size), wide = new Uint16Array((size + 1) & ~1);
      for (let i = 0; i < size; i++) wide[i] = src[i];
      this.device.queue.writeBuffer(b, 0, wide);
    } else this.device.queue.writeBuffer(b, 0, this.u8, addr, n);
    this.stats.uploads++; this.stats.uploadBytes += n;
    this.ranges.set(key, { buf: b, hash, checked: this.epoch, used: this.flushNo });
    return b;
  }
  private dropUploads() { this.epoch++; this.bindDirty = true; this.uaSeen.clear(); }

  // Storage ranges a compute pass wrote, until their read-back has landed in guest memory: the GPU's copy is the newer
  // one, so binds inside such a range (storage, vertex, index, uniform) use it instead of uploading guest memory
  private gpuRanges = new Map<string, GpuRange>();
  private gpuRangeOver(addr: number, size: number): GpuRange | null {
    for (const r of this.gpuRanges.values()) if (addr >= r.addr && addr + size <= r.addr + r.size) return r;
    return null;
  }
  private storageBuffer(addr: number, size: number, write: boolean): { buf: GPU; off: number; size: number } | null {
    if (!addr || !size || addr + size > this.memory.buffer.byteLength) { this.red(`sb${addr}`, `a dispatch binds storage outside the guest's memory (address 0x${addr.toString(16)} size ${size}): not bound`); return null; }
    const bsize = (size + 3) & ~3;
    if (!write) { const b = this.upload(addr, size, 3); return b && { buf: b, off: this.upOff, size: bsize }; }
    const key = `${addr}:${size}`, hash = this.x.gfx_hash(addr, size);
    let r = this.gpuRanges.get(key);
    // Guest memory changed since the GPU's copy was made (the game wrote new input): it is uploaded again
    if (r && r.hash === hash) return { buf: r.buf, off: 0, size: bsize };
    const over = !r && this.gpuRangeOver(addr, size);
    if (over) return { buf: over.buf, off: addr - over.addr, size: bsize };
    for (const o of this.gpuRanges.values()) if (o !== r && addr < o.addr + o.size && o.addr < addr + size) this.red("sboverlap", "storage ranges written by compute passes overlap without one containing the other: each keeps its own GPU copy until read back");
    const buf = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(bsize))));
    this.device.queue.writeBuffer(buf, 0, this.u8, addr, Math.min(bsize, this.memory.buffer.byteLength - addr) & ~3);
    this.stats.uploads++; this.stats.uploadBytes += bsize;
    if (r) { this.inUse.push(r.buf); r.buf = buf; r.hash = hash; } else this.gpuRanges.set(key, r = { addr, size, buf, hash, pending: 0 });
    return { buf, off: 0, size: bsize };
  }
  private bufReadback(addr: number, size: number) {
    const r = this.gpuRanges.get(`${addr}:${size}`);
    if (!r) return;
    this.endPass();
    const n = (size + 3) & ~3, buf = this.newBuffer({ size: n, usage: 0x01 | 0x08 });
    this.encoder().copyBufferToBuffer(r.buf, 0, buf, 0, n);
    r.pending++;
    this.queuedBufs.push({ buf, range: r });
  }

  // ---- uniform data: one large buffer with dynamic offsets ----
  // Every uniform range a draw or dispatch binds is copied into a staging array at a 256-byte-aligned slot (only the
  // bytes the shader's block covers, zero past what the game bound), written to its GPU buffer once at the flush, and
  // bound through a dynamic offset: one bind group serves every draw of a pipeline, no buffer and no hash per range.
  // A range bound again while guest memory cannot have changed reuses its slot.
  uniformArena = true;
  private uaCur: Chunk | null = null;
  private uaDone: Chunk[] = [];
  private uaPool: Chunk[] = [];
  private uaSeen = new Map<number, UaSlot>();     // by address * 2^17 + bound size: the slot a range has in this epoch
  private uaAlign = UA_ALIGN;
  private uaAlloc(size: number): UaSlot {
    let c = this.uaCur;
    if (!c || c.used + size > UA_CHUNK) {
      if (c) this.uaDone.push(c);
      c = this.uaCur = this.uaPool.pop() ?? { buf: this.newBuffer({ size: UA_CHUNK, usage: 0x08 | 0x40 }), staging: new Uint8Array(UA_CHUNK), used: 0 };
    }
    const off = c.used;
    c.used = (off + size + this.uaAlign - 1) & ~(this.uaAlign - 1);
    c.staging.fill(0, off, off + size);
    this.stats.uniformSlots++;
    return { c, off, size };
  }
  private uaWrite() {
    if (this.uaCur) { this.uaDone.push(this.uaCur); this.uaCur = null; }
    for (const c of this.uaDone) {
      if (c.used) { this.device.queue.writeBuffer(c.buf, 0, c.staging, 0, c.used); this.stats.uniformBytes += c.used; this.stats.uniformWrites++; }
      c.used = 0; this.uaPool.push(c);
    }
    this.uaDone = []; this.uaSeen.clear();
  }
  // The buffer, offset and size uniform binding i of stage st is bound with
  private uboSlot(st: number, i: number): { buf: GPU; off: number; size: number } {
    const u = this.ubo.get(st * 16 + i), max = this.limit("maxUniformBufferBindingSize", 65536);
    if (!this.uniformArena) {
      if (u?.data) { const b = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(u.data.length)))); this.device.queue.writeBuffer(b, 0, u.data); this.inUse.push(b); return { buf: b, off: 0, size: Math.min(b.size, (u.data.length + 15) & ~15) }; }
      const buf = u && this.upload(u.addr, u.size, 0);
      return buf ? { buf, off: this.upOff, size: Math.min(buf.size - this.upOff, (u!.size + 15) & ~15) } : { buf: this.zeroBuffer(), off: 0, size: 65536 };
    }
    const have = u ? (u.data ? u.data.length : u.size) : 0, size = Math.min(max, Math.max(16, ((u?.need || have) + 15) & ~15));
    if (u && !u.data && this.gpuRanges.size) {
      const r = this.gpuRangeOver(u.addr, Math.min(u.size, size));
      if (r) {
        const off = u.addr - r.addr;
        if (off % this.uaAlign === 0 && off + size <= r.buf.size) return { buf: r.buf, off, size };
        this.red("ubogpu", "a uniform range lies in memory a compute pass wrote and is not aligned to 256 bytes: it is bound from guest memory, which has the old content until the read-back lands");
      }
    }
    const key = u ? (u.data ? -1 : u.addr * 131072 + Math.min(u.size, 131071)) : 0;
    let s = key >= 0 ? this.uaSeen.get(key) : undefined;
    if (!s || s.size < size) {
      s = this.uaAlloc(size);
      if (u?.data) s.c.staging.set(u.data.subarray(0, Math.min(size, u.data.length)), s.off);
      else if (u && u.addr && u.size) {
        const n = Math.min(size, u.size, Math.max(0, this.memory.buffer.byteLength - u.addr));
        if (n < Math.min(size, u.size)) this.red(`up${u.addr}`, `a draw binds memory outside the guest's (address 0x${u.addr.toString(16)} size ${u.size}): zeros are bound`);
        if (n <= 64) { const m = this.u8, d = s.c.staging; for (let k = 0, a = u.addr, o = s.off; k < n; k++) d[o + k] = m[a + k]; }
        else s.c.staging.set(this.u8.subarray(u.addr, u.addr + n), s.off);
      }
      if (key >= 0) this.uaSeen.set(key, s);
    }
    return { buf: s.c.buf, off: s.off, size };
  }

  // ---- encoder and passes ----
  private encoder(): GPU { return (this.enc ??= this.device.createCommandEncoder()); }
  private endPass() { if (this.pass) { this.pass.end(); this.pass = null; this.computePass = false; } }
  private flush() {
    this.endPass();
    if (this.uniformArena) this.uaWrite();
    const stamps = this.segBeforeSubmit();
    if (this.enc) { this.device.queue.submit([this.enc.finish()]); this.enc = null; this.stats.submits++; }
    this.segAfterSubmit(stamps);
    const gen = this.gen;
    for (const q of this.queued.splice(0)) this.readbacks.push(q.buf.mapAsync(1).then(() => {
      if (gen !== this.gen) return;
      const src = new Uint8Array(q.buf.getMappedRange()), mem = this.u8;
      for (let z = 0; z < q.depth; z++) for (let y = 0; y < q.rows; y++) mem.set(src.subarray((z * q.rows + y) * q.srcRow, (z * q.rows + y) * q.srcRow + q.wb), q.dst + z * q.img + y * q.row);
      q.buf.unmap(); this.kill(q.buf); this.dropUploads();
    }, (e: any) => { if (!this.lost && gen === this.gen) this.log(`[RED] CopyTextureToBuffer readback failed: ${e?.message ?? e}`); }));
    for (const q of this.queuedBufs.splice(0)) this.readbacks.push(q.buf.mapAsync(1).then(() => {
      if (gen !== this.gen) return;
      const r = q.range;
      this.u8.set(new Uint8Array(q.buf.getMappedRange()).subarray(0, r.size), r.addr);
      q.buf.unmap(); this.kill(q.buf); this.stats.bufferReadbacks++;
      // Guest memory now holds what the GPU wrote: later binds upload from it again
      if (--r.pending === 0 && this.gpuRanges.get(`${r.addr}:${r.size}`) === r) { this.gpuRanges.delete(`${r.addr}:${r.size}`); this.inUse.push(r.buf); }
      this.dropUploads();
    }, (e: any) => { if (!this.lost && gen === this.gen) this.log(`[RED] storage buffer readback failed: ${e?.message ?? e}`); }));
    for (const b of this.inUse) { let l = this.pool.get(b.size); if (!l) this.pool.set(b.size, l = []); l.push(b); }
    this.inUse = []; this.epoch++; this.flushNo++; this.bindDirty = true;
    if (!this.cacheUploads) { for (const e of this.ranges.values()) this.release(e.buf); this.ranges.clear(); this.groups.clear(); }
    else if (this.flushNo % 64 === 0) {
      for (const [k, e] of this.ranges) if (e.used < this.flushNo - 240) { this.release(e.buf); this.ranges.delete(k); this.groups.clear(); }
      if (this.groups.size > 8192) this.groups.clear();
    }
  }
  // ---- counter reports (src/gfx/report.ts): the times of the segments they lie in ----
  // A report (H_REPORT) belongs to the segment being encoded when it is reached. When the recorder commits a
  // submission's reports (H_REPORT_COMMIT) they land together once the segment of that record is done on the GPU:
  // gfx_report_land(id, GPU start of its segment, GPU end of its segment, end of the last segment). Fences issued
  // later wait for that, as for read-backs.
  // Where the times come from. With the WebGPU feature `timestamp-query`: every render pass of a segment writes the
  // GPU's clock at its start and end; the first start and the last end are the segment's, and the GPU's clock is tied
  // to the guest clock by taking the last segment's end as the moment the GPU reported the work done (WebGPU has no
  // paired CPU / GPU sample; browsers quantise the stamps, 100 us in Chromium). Without the feature, or for a segment
  // with no render pass: start = when the segment was handed over, or when the segment before it was done if that
  // was later; end = when the GPU reported it done (onSubmittedWorkDone), which is at the mercy of the event loop.
  timestampSource: "gpu" | "cpu" = "cpu";
  private reportsSeen = false;
  private reportsCommit = false;
  private reportsOpen: { id: number; seg: Seg }[] = [];
  private segCur: Seg | null = null;
  private segLast: Seg | null = null;
  private tsSet: GPU = null;
  private tsResolve: GPU = null;
  private tsNext = 0;
  private now(): bigint { return this.opts.now ? this.opts.now() : BigInt(Math.round(performance.now() * 1e6)); }
  private segOf(): Seg { return (this.segCur ??= { submitAt: 0n, startAt: 0n, doneAt: 0n, prev: this.segLast, q0: -1, q1: -1, gpu0: 0n, gpu1: 0n, done: null }); }
  // A render pass is about to begin: its start and end are stamped when reports are in use and the device can
  private stamp(desc: any): any {
    if (!this.reportsSeen || this.timestampSource !== "gpu" || this.tsNext + 2 > TS_QUERIES) return desc;
    this.tsSet ??= this.device.createQuerySet({ type: "timestamp", count: TS_QUERIES });
    const s = this.segOf();
    if (s.q0 < 0) s.q0 = this.tsNext;
    s.q1 = this.tsNext + 1;
    desc.timestampWrites = { querySet: this.tsSet, beginningOfPassWriteIndex: this.tsNext, endOfPassWriteIndex: this.tsNext + 1 };
    this.tsNext += 2;
    return desc;
  }
  // Before the encoder is finished: the segment's stamps are resolved into a buffer that is read once it is submitted
  private segBeforeSubmit(): GPU {
    if (!this.reportsSeen) return null;
    const s = this.enc || this.reportsOpen.length ? this.segOf() : null;
    if (!s || s.q0 < 0 || !this.enc) return null;
    const n = s.q1 - s.q0 + 1;
    this.tsResolve ??= this.newBuffer({ size: TS_QUERIES * 8, usage: 0x200 | 0x04 /* QUERY_RESOLVE | COPY_SRC */ });
    const read = this.newBuffer({ size: n * 8, usage: 0x01 | 0x08 /* MAP_READ | COPY_DST */ });
    this.enc.resolveQuerySet(this.tsSet, s.q0, n, this.tsResolve, 0);
    this.enc.copyBufferToBuffer(this.tsResolve, 0, read, 0, n * 8);
    return read;
  }
  private segAfterSubmit(read: GPU): void {
    const s = this.segCur;
    if (!s) return;
    this.segCur = null; this.segLast = s; this.tsNext = 0;
    const gen = this.gen;
    s.submitAt = this.now();
    const stamps: Promise<void> = read ? read.mapAsync(1).then(() => {
      if (gen !== this.gen) return;
      const v = new BigUint64Array(read.getMappedRange());
      s.gpu0 = v[0]; s.gpu1 = v[v.length - 1];
      read.unmap(); this.kill(read);
    }, () => {}) : Promise.resolve();
    s.done = (this.lost ? Promise.resolve() : this.device.queue.onSubmittedWorkDone().catch(() => {})).then(() => {
      s.doneAt = this.now();
      s.startAt = s.prev && s.prev.doneAt > s.submitAt ? s.prev.doneAt : s.submitAt;
      s.prev = null;
    }).then(() => stamps);
    if (!this.reportsCommit) return;
    this.reportsCommit = false;
    const group = this.reportsOpen.splice(0);
    if (group.length) this.readbacks.push(Promise.all([...new Set(group.map(r => r.seg.done)), s.done]).then(() => { if (gen === this.gen && !this.disposed) this.reportsLand(group, s); }));
  }
  reportsGpuTimed = 0;        // reports that took the GPU's own stamps (the others: the CPU's estimate)
  private reportsLand(group: { id: number; seg: Seg }[], last: Seg): void {
    // The GPU's own times, placed on the guest clock by the last segment's end: only when every segment of the
    // group has them (one report by the GPU's clock and the next by the CPU's estimate would not compare)
    const gpu = last.gpu1 > 0n && group.every(r => r.seg.gpu0 > 0n && r.seg.gpu1 >= r.seg.gpu0 && last.gpu1 >= r.seg.gpu1);
    for (const r of group) {
      const g = r.seg;
      let start = g.startAt || last.startAt, end = g.doneAt || last.doneAt;
      if (gpu) { start = last.doneAt - (last.gpu1 - g.gpu0); end = last.doneAt - (last.gpu1 - g.gpu1); this.reportsGpuTimed++; }
      this.x.gfx_report_land(r.id, BigInt.asUintN(64, start), BigInt.asUintN(64, end), last.doneAt);
    }
    this.dropUploads();       // guest memory changed
  }
  // The device is gone: what was on its way lands now, with the time it is
  private reportsLost(): void {
    this.reportsOpen = []; this.reportsCommit = false; this.segCur = null; this.segLast = null; this.tsSet = null; this.tsResolve = null; this.tsNext = 0;
    this.x?.gfx_reports_flush?.(this.now());
  }
  private release(b: GPU) { let l = this.pool.get(b.size); if (!l) this.pool.set(b.size, l = []); l.push(b); }
  // Bind groups by what they bind: buffers, views and samplers are stable objects, numbered on first sight
  private groups = new Map<string, GPU>();
  private ids = new WeakMap<object, number>(); private nextId = 1;
  private idOf(o: object): number { let i = this.ids.get(o); if (!i) this.ids.set(o, i = this.nextId++); return i; }
  private group(layout: GPU, entries: any[]): GPU {
    let key = `${this.idOf(layout)}`;
    for (const e of entries) key += e.resource.buffer ? `|b${this.idOf(e.resource.buffer)}:${e.resource.offset ?? 0}:${e.resource.size ?? 0}` : `|${this.idOf(e.resource)}`;
    let g = this.groups.get(key);
    if (!g) { g = this.device.createBindGroup({ layout, entries }); this.groups.set(key, g); this.stats.bindGroups++; }
    return g;
  }
  private u64(dv: DataView, p: number) { return dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296; }

  private beginPass(dv: DataView, p: number) {
    const n = dv.getUint32(p + 8, true), flags = dv.getUint32(p + 12, true);
    const colorAttachments: any[] = [], colorFmt: (string | null)[] = [], targets: { name: string; serial: number; level: number; layer: number }[] = [];
    let samples = 1;
    for (let i = 0; i < n; i++) {
      const o = p + 32 + i * 40, t = this.texture(this.u64(dv, o));
      if (!t) { colorAttachments.push(null); colorFmt.push(null); continue; }
      samples = t.gpu.sampleCount;
      const clear = dv.getUint32(o + 20, true) !== 0;
      // The recorder sends the texture's format, or its sRGB twin when a view asks for that (lower.ts rtFill)
      const vf = hostFormat(dv.getUint32(o + 16, true), this.caps)?.tex, af = vf && vf === SRGB_TWIN[t.fmt.tex!] ? vf : t.fmt.tex!;
      colorAttachments.push({ view: this.attachView(t, dv.getUint32(o + 8, true), dv.getUint32(o + 12, true), af), loadOp: clear ? "clear" : "load", storeOp: "store",
        clearValue: { r: dv.getFloat32(o + 24, true), g: dv.getFloat32(o + 28, true), b: dv.getFloat32(o + 32, true), a: dv.getFloat32(o + 36, true) } });
      colorFmt.push(af);
      targets.push({ name: `color${i}`, serial: t.serial, level: dv.getUint32(o + 8, true), layer: dv.getUint32(o + 12, true) });
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
        targets.push({ name: "depth", serial: t.serial, level: dv.getUint32(p + 360, true), layer: dv.getUint32(p + 364, true) });
      }
    }
    this.endPass();
    this.stamp(desc);
    this.pass = this.encoder().beginRenderPass(desc);
    this.passInfo = { colorFmt, depthFmt, samples, w: dv.getUint32(p + 24, true), h: dv.getUint32(p + 28, true), targets };
    this.cur = null; this.bindDirty = true; this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear();
    this.stats.passes++;
  }

  // ---- pipelines ----
  // The bind group layouts of a pipeline from its shaders' reflection, and the order of group 0's buffers. Uniform
  // buffers take dynamic offsets (the uniform arena) up to the device's limit; the ones beyond it are bound at fixed offsets
  private groupLayouts(stages: { info: ShaderInfo; st: number }[], fixup: boolean): { layouts: GPU[]; g0: Slot[] } {
    const e0: any[] = [], g1: any[] = [], g0: Slot[] = [];
    let dynLeft = this.uniformArena ? this.limit("maxDynamicUniformBuffersPerPipelineLayout", 8) : 0;
    for (const { info: s, st } of stages) {
      const visibility = st === 0 ? 1 : st === 1 ? 2 : 4;
      for (const i of [...(s.ubos ?? []), ...(s.support ? [14] : [])].sort((a, b) => a - b)) {
        const dyn = dynLeft > 0; if (dyn) dynLeft--;
        e0.push({ binding: st * 16 + i, visibility, buffer: { type: "uniform", hasDynamicOffset: dyn } });
        g0.push({ binding: st * 16 + i, st, i, kind: "ubo", dyn, write: false });
      }
      for (const b of s.storage ?? []) {
        e0.push({ binding: 128 + st * 16 + b.slot, visibility, buffer: { type: b.write ? "storage" : "read-only-storage" } });
        g0.push({ binding: 128 + st * 16 + b.slot, st, i: b.slot, kind: "ssbo", dyn: false, write: !!b.write });
      }
      for (const t of s.textures ?? []) {
        const sampleType = t.depth ? "depth" : t.sampleType ?? "float";
        g1.push({ binding: st * 64 + t.slot * 2, visibility, texture: { sampleType, viewDimension: t.dim ?? "2d" } });
        g1.push({ binding: st * 64 + t.slot * 2 + 1, visibility, sampler: { type: t.depth ? "comparison" : sampleType === "float" ? "filtering" : "non-filtering" } });
      }
      for (const m of s.images ?? []) g1.push({ binding: 256 + st * 8 + m.slot, visibility, storageTexture: { access: m.access ?? "write-only", format: m.format, viewDimension: m.dim ?? "2d" } });
    }
    g0.sort((a, b) => a.binding - b.binding);
    const groups = [e0, g1];
    if (fixup) groups.push([{ binding: 0, visibility: 1, buffer: { type: "uniform" } }]);
    return { g0, layouts: groups.map(entries => {
      const key = JSON.stringify(entries);
      let l = this.layouts.get(key);
      if (!l) { l = this.device.createBindGroupLayout({ entries }); this.layouts.set(key, l); }
      return l;
    }) };
  }
  // WebGPU's per-stage limits against what the shaders declare. A pipeline over a limit cannot exist on this device:
  // it fails here with the numbers (its draws are then skipped) instead of as a validation error with none
  private overLimits(id: number, stages: { info: ShaderInfo; st: number }[], fixup: boolean): boolean {
    let over = false;
    const red = (who: string, n: number, what: string, max: number, limit: string, per: string) => {
      over = true;
      this.log(`[RED] pipeline ${id}: ${who} needs ${n} ${what}; this WebGPU device allows ${max}${per} (${limit}): ${n - max} over. The pipeline cannot be built, its draws are skipped`);
    };
    for (const { info: s, st } of stages) {
      const counts: [string, number, string, number][] = [
        ["uniform buffers", (s.ubos?.length ?? 0) + (s.support ? 1 : 0) + (st === 0 && fixup ? 1 : 0), "maxUniformBuffersPerShaderStage", 12],
        ["sampled textures", s.textures?.length ?? 0, "maxSampledTexturesPerShaderStage", 16], ["samplers", s.textures?.length ?? 0, "maxSamplersPerShaderStage", 16],
        ["storage buffers", s.storage?.length ?? 0, "maxStorageBuffersPerShaderStage", 8], ["storage textures", s.images?.length ?? 0, "maxStorageTexturesPerShaderStage", 4]];
      if (st === 0) counts.push(["vertex attributes", s.attributes?.length ?? 0, "maxVertexAttributes", 16]);
      const who = `the ${["vertex", "fragment", "compute"][st]} shader ${this.shaders.find(x => x?.info === s)?.key ?? ""}`;
      for (const [what, n, limit, fallback] of counts) { const max = this.limit(limit, fallback); if (n > max) red(who, n, what, max, limit, " a stage"); }
    }
    // bind groups: 0 buffers, 1 textures and images, 2 the position fix-up
    const groups = fixup ? 3 : 2, maxGroups = this.limit("maxBindGroups", 4);
    if (groups > maxGroups) red("its layout", groups, "bind groups", maxGroups, "maxBindGroups", "");
    return over;
  }
  private pipeFailed(id: number) { this.stats.pipelinesFailed++; this.x.gfx_pipeline_done(id, 0); }
  private createPipeline(id: number, k: number) {
    const dv = this.dv, gen = this.gen;
    if (dv.getUint8(k + PK.prim) === 0xff) {      // a compute pipeline: its shader alone
      const csId = dv.getUint16(k + PK.fs, true), cs = this.shaders[csId].info, stages = [{ info: cs, st: 2 }];
      const pipe: Pipe = { id, compute: true, desc: null, stages: [csId], key: k, layouts: [], g0: [], gen };
      this.pipes.set(id, pipe);
      if (this.overLimits(id, stages, false)) { this.pipeFailed(id); return; }
      const { layouts, g0 } = this.groupLayouts(stages, false);
      pipe.layouts = layouts; pipe.g0 = g0;
      pipe.desc = { layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module: this.module(csId), entryPoint: cs.entry } };
      this.device.createComputePipelineAsync(pipe.desc).then((p: GPU) => { if (gen !== this.gen || this.pipes.get(id) !== pipe) return; pipe.gpu ??= p; this.stats.pipelinesAsync++; this.x.gfx_pipeline_done(id, 1); },
        (e: any) => { if (gen !== this.gen || this.pipes.get(id) !== pipe) return; pipe.desc = null; this.stats.pipelinesFailed++; if (!this.lost) this.log(`[RED] compute pipeline ${id} did not build: ${e?.message ?? e}`); this.x.gfx_pipeline_done(id, 0); });
      return;
    }
    const vsId = dv.getUint16(k + PK.vs, true), fsId = dv.getUint16(k + PK.fs, true), vs = this.shaders[vsId].info, fs = this.shaders[fsId].info, flags = dv.getUint8(k + PK.flags);
    const buffers: any[] = [], classes: Record<number, VinClass> = {};
    for (let loc = 0, m = dv.getUint32(k + PK.attrMask, true); m; loc++, m >>>= 1) {
      if (!(m & 1)) continue;
      const a = dv.getUint32(k + PK.attr + loc * 4, true), fmt = a & 0xff, stream = a >>> 27, vf = NVN_FORMATS[fmt]?.vtx;
      if (!vf) { this.red(`vf${fmt}`, `vertex attribute format 0x${fmt.toString(16)} has no WebGPU vertex format: pipeline ${id} will fail`); }
      const divisor = dv.getUint32(k + PK.stream + stream * 8 + 4, true);
      buffers[stream] ??= { arrayStride: dv.getUint32(k + PK.stream + stream * 8, true), stepMode: divisor ? "instance" : "vertex", attributes: [] };
      buffers[stream].attributes.push({ shaderLocation: loc, offset: (a >>> 8) & 0x7ffff, format: vf ?? "float32" });
      classes[loc] = CLASSES[Number((dv.getBigUint64(k + PK.vin, true) >> BigInt(loc * 2)) & 3n)] ?? "float";
    }
    for (let i = 0; i < buffers.length; i++) buffers[i] ??= null;
    const prim = dv.getUint8(k + PK.prim), itype = dv.getUint8(k + PK.itype), cull = dv.getUint8(k + PK.cull);
    const primitive: any = { topology: TOPOLOGY[prim], cullMode: cull === 1 ? "front" : cull === 2 ? "back" : "none", frontFace: dv.getUint8(k + PK.front) ? "ccw" : "cw" };
    if (itype) primitive.stripIndexFormat = itype === 3 ? "uint32" : "uint16";
    if (flags & 1) { if (this.device.features?.has?.("depth-clip-control")) primitive.unclippedDepth = true; else this.red("clamp", "depth clamp needs the WebGPU feature depth-clip-control, which this device lacks: depth is clipped"); }
    const ncolor = dv.getUint8(k + PK.ncolor), chmask = dv.getUint32(k + PK.chmask, true), blendEn = dv.getUint8(k + PK.blendEn), written = new Set(fs.outputs ?? []);
    const targets: any[] = [];
    for (let i = 0; i < ncolor; i++) {
      const f = hostFormat(dv.getUint8(k + PK.colorFmt + i), this.caps);
      if (!f?.tex) { targets.push(null); continue; }
      const nib = (chmask >>> (4 * i)) & 15, t: any = { format: f.tex, writeMask: written.has(i) ? nib : 0 };
      if ((blendEn >> i) & 1) {
        const b = dv.getBigUint64(k + PK.blend + i * 8, true), fld = (s: number, w: number) => Number((b >> BigInt(s)) & ((1n << BigInt(w)) - 1n));
        const comp = (eq: number, src: number, dst: number) => eq >= 4 ? { operation: BLEND_EQ[eq], srcFactor: "one", dstFactor: "one" } : { operation: BLEND_EQ[eq] ?? "add", srcFactor: BLEND_FUNC[src] ?? "one", dstFactor: BLEND_FUNC[dst] ?? "zero" };
        t.blend = { color: comp(fld(31, 3), fld(3, 7), fld(10, 7)), alpha: comp(fld(34, 3), fld(17, 7), fld(24, 7)) };
      }
      targets.push(t);
    }
    const stages = [{ info: vs, st: 0 }, { info: fs, st: 1 }];
    const pipe: Pipe = { id, compute: false, desc: null, stages: [vsId, fsId], key: k, layouts: [], g0: [], gen };
    this.pipes.set(id, pipe);
    if (this.overLimits(id, stages, !!vs.fixup)) { this.pipeFailed(id); return; }
    const { layouts, g0 } = this.groupLayouts(stages, !!vs.fixup);
    pipe.layouts = layouts; pipe.g0 = g0; pipe.dynOnly = g0.length > 0 && g0.every(s => s.dyn);
    // Vertex inputs of another class than the shader declares (flag 2, decided by the recorder): the module must be a variant
    const vmod = flags & 2 ? this.variantModule(vsId, classes) : this.module(vsId);
    if (!vmod) { this.pipeFailed(id); return; }
    const desc: any = {
      layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: { module: vmod, entryPoint: vs.entry, buffers }, primitive,
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
    pipe.desc = desc;
    // Asynchronously, so a pipeline first needed later is ready by then; the draw that needs it now builds it itself (usePipeline)
    this.device.createRenderPipelineAsync(desc).then((p: GPU) => { if (gen !== this.gen || this.pipes.get(id) !== pipe) return; pipe.gpu ??= p; this.stats.pipelinesAsync++; this.x.gfx_pipeline_done(id, 1); },
      (e: any) => { if (gen !== this.gen || this.pipes.get(id) !== pipe) return; pipe.desc = null; this.stats.pipelinesFailed++; if (!this.lost) this.log(`[RED] pipeline ${id} did not build: ${e?.message ?? e}`); this.x.gfx_pipeline_done(id, 0); });
  }
  private usePipeline(id: number): boolean {
    const pipe = this.pipes.get(id);
    if (!pipe) { this.red(`nopipe${id}`, `host stream binds pipeline ${id}, which was never created`); this.cur = null; return false; }
    if (!pipe.gpu) {
      if (!pipe.desc) { this.cur = null; return false; }      // it cannot be built (over a limit, no shader variant): its draws are skipped
      pipe.gpu = pipe.compute ? this.device.createComputePipeline(pipe.desc) : this.device.createRenderPipeline(pipe.desc); this.stats.pipelinesSync++;
    }
    this.cur = pipe; this.pass.setPipeline(pipe.gpu); this.bindDirty = true;
    return true;
  }
  // Loops, fans, quads, quad strips and polygons through a 32-bit index buffer built here and kept by what it was built from
  private converted = new Map<string, { buf: GPU; n: number }>();
  private drawConverted(dv: DataView, p: number, indexed: boolean, prim: number) {
    const count = dv.getUint32(p + 12, true), inst = dv.getUint32(p + 16, true), baseInst = dv.getUint32(p + 20, true);
    let src: ArrayLike<number>, key: string, baseVertex = 0;
    if (indexed) {
      const itype = dv.getUint32(p + 8, true), addr = this.u64(dv, p + 32), isz = itype === 2 ? 4 : itype === 1 ? 2 : 1;
      if (!addr || addr + count * isz > this.memory.buffer.byteLength) return;
      baseVertex = dv.getInt32(p + 24, true);
      src = itype === 2 ? new Uint32Array(this.memory.buffer, addr, count) : itype === 1 ? new Uint16Array(this.memory.buffer, addr, count) : new Uint8Array(this.memory.buffer, addr, count);
      key = `${prim}:${itype}:${count}:${this.x.gfx_hash(addr, count * isz)}`;
    } else { const first = dv.getUint32(p + 8, true); src = Array.from({ length: count }, (_, i) => first + i); key = `${prim}:a${first}:${count}`; }
    let c = this.converted.get(key);
    if (!c) {
      const out: number[] = [], n = src.length;
      if (prim === 2) { for (let i = 0; i < n; i++) out.push(src[i]); if (n > 1) out.push(src[0]); }                              // line loop: the strip, closed
      else if (prim === 6 || prim === 9) for (let i = 1; i + 1 < n; i++) out.push(src[0], src[i], src[i + 1]);                    // fan, polygon
      else if (prim === 7) for (let i = 0; i + 3 < n; i += 4) out.push(src[i], src[i + 1], src[i + 2], src[i], src[i + 2], src[i + 3]);   // quads
      else for (let i = 0; i + 3 < n; i += 2) out.push(src[i], src[i + 1], src[i + 3], src[i], src[i + 3], src[i + 2]);           // quad strip
      const buf = this.newBuffer({ size: Math.max(4, out.length * 4), usage: 0x10 | 0x08 });
      this.device.queue.writeBuffer(buf, 0, new Uint32Array(out));
      if (this.converted.size >= 1024) { for (const v of this.converted.values()) this.inUse.push(v.buf); this.converted.clear(); }
      this.converted.set(key, c = { buf, n: out.length });
    }
    if (!c.n) return;
    this.pass.setIndexBuffer(c.buf, "uint32");
    this.pass.drawIndexed(c.n, inst, 0, baseVertex, baseInst);
  }
  private sampler(index: number, compare: boolean, filtering = true): GPU {
    const p = (this.x.gfx_sampler_table() >>> 0) + index * 48, dv = this.dv, registered = index > 0 && dv.getUint8(p + 40) !== 0;
    const key = (registered ? Array.from(this.u8.subarray(p, p + 40)).join(",") : "default") + (compare ? "c" : "") + (filtering ? "" : "n");
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
    if (!filtering) { d.minFilter = "nearest"; d.magFilter = "nearest"; d.mipmapFilter = "nearest"; delete d.maxAnisotropy; }
    if (compare) d.compare ??= "less-equal"; else delete d.compare;
    s = this.device.createSampler(d);
    this.samplers.set(key, s);
    return s;
  }
  // The bind groups of the current pipeline (render or compute) from what the stream bound
  private bind() {
    const c = this.cur!, layouts = c.layouts, e0: any[] = [], offs: number[] = [], g1: any[] = [];
    for (const b of c.g0) {
      if (b.kind === "ubo") {
        const r = this.uboSlot(b.st, b.i);
        if (b.dyn) { e0.push({ binding: b.binding, resource: { buffer: r.buf, offset: 0, size: r.size } }); offs.push(r.off); }
        else e0.push({ binding: b.binding, resource: { buffer: r.buf, offset: r.off, size: r.size } });
      } else {
        const s = this.ssbo.get(b.st * 16 + b.i), r = s && this.storageBuffer(s.addr, s.size, b.write);
        if (!r) { this.red("nossbo", "a draw or dispatch uses a storage buffer slot with nothing (or nothing valid) bound: a zeroed buffer is bound"); e0.push({ binding: b.binding, resource: { buffer: this.scratchStorage(), offset: 0, size: 65536 } }); continue; }
        if (r.off % 256) this.red("ssboalign", "a storage range inside memory a compute pass wrote is not aligned to 256 bytes: WebGPU cannot bind it at that offset");
        e0.push({ binding: b.binding, resource: { buffer: r.buf, offset: r.off, size: r.size } });
      }
    }
    for (const sid of c.stages) {
      const s = this.shaders[sid].info, st = s.stage === "vertex" ? 0 : s.stage === "fragment" ? 1 : 2;
      for (const t of s.textures ?? []) {
        const b = this.tex.get(st * 64 + t.slot), tx = b && b.serial ? this.texture(b.serial) : undefined;
        const src = tx && (b!.snap && tx.snap ? tx.snap : tx.gpu), filtering = !!t.depth || (t.sampleType ?? "float") === "float";
        g1.push({ binding: st * 64 + t.slot * 2, resource: tx ? this.view(tx, src, b!.view, t.dim) : this.dummyView(t.dim ?? "2d") });
        g1.push({ binding: st * 64 + t.slot * 2 + 1, resource: this.sampler(b ? b.samp : 0, !!t.depth, filtering) });
      }
      for (const m of s.images ?? []) {
        const b = this.img.get(st * 8 + m.slot), tx = b && b.serial ? this.texture(b.serial) : undefined;
        if (!tx || !(tx.gpu.usage & 0x08)) { this.red(`noimg${m.slot}`, `a dispatch stores to image slot ${m.slot}, where ${tx ? `a ${tx.fmt.tex} texture is bound, which WebGPU cannot bind as a storage image` : "no live texture is bound"}: the dispatch is skipped`); return false; }
        g1.push({ binding: 256 + st * 8 + m.slot, resource: this.view(tx, tx.gpu, b!.view, m.dim ?? (tx.gpu.dimension === "3d" ? "3d" : "2d"), true) });
      }
    }
    // With every buffer of group 0 at a dynamic offset the group changes only when the arena moves to another chunk:
    // the last one is kept with the pipeline and compared, no key is built
    let g0: GPU | undefined;
    if (c.dynOnly) {
      const l = c.last0;
      if (l && l.bufs.length === e0.length) { g0 = l.group; for (let k = 0; k < e0.length; k++) if (l.bufs[k] !== e0[k].resource.buffer || l.sizes[k] !== e0[k].resource.size) { g0 = undefined; break; } }
      if (!g0) { g0 = this.group(layouts[0], e0); c.last0 = { bufs: e0.map(x => x.resource.buffer), sizes: e0.map(x => x.resource.size), group: g0 }; }
    } else g0 = this.group(layouts[0], e0);
    this.pass.setBindGroup(0, g0, offs);
    this.pass.setBindGroup(1, g1.length ? this.group(layouts[1], g1) : (c.empty1 ??= this.group(layouts[1], g1)));
    if (layouts[2]) {
      const key = this.fix.join(",");
      let g = this.fixGroups.get(key);
      if (!g) { const b = this.newBuffer({ size: 16, usage: 0x40 | 0x08 }); this.device.queue.writeBuffer(b, 0, new Float32Array(this.fix)); g = this.device.createBindGroup({ layout: layouts[2], entries: [{ binding: 0, resource: { buffer: b } }] }); this.fixGroups.set(key, g); }
      this.pass.setBindGroup(2, g);
    }
    this.bindDirty = false;
    return true;
  }
  private zero: GPU = null;
  private zeroBuffer(): GPU { return (this.zero ??= this.newBuffer({ size: 65536, usage: 0x40 | 0x08 })); }
  private scratchSt: GPU = null;
  private scratchStorage(): GPU { return (this.scratchSt ??= this.newBuffer({ size: 65536, usage: 0x80 | 0x08 })); }
  private dispatch(dv: DataView, p: number) {
    if (!this.pass || !this.computePass) return;
    this.stats.dispatches++;
    if (!this.usePipeline(dv.getUint32(p + 8, true))) return;
    if (!this.bind()) return;
    this.pass.dispatchWorkgroups(dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 20, true));
    this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear();
  }


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
    const ub = this.alloc(256);
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
    const ub = this.alloc(256);
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
    // Only for a texture the GPU wrote (otherwise the recorder made the copy in the texture's storage, lower.ts copyB2T)
    if (f.kind === "depth" || f.stencil || f.conv) { this.red("b2tdepth", `CopyBufferToTexture into a ${f.conv ? "texture whose format the host converts" : "depth or stencil texture"} that the GPU has written: the copy is dropped`); return; }
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
    if ((dv.getUint32(p + 88, true) & 0x40000000) && s.gpu.sampleCount > 1 && d.gpu.sampleCount === 1) { this.resolve(s, sl, sy, d, dl, dy); return; }
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
  // nvnCommandBufferDownsample: a multisampled texture into a single-sampled one. Colour through a pass's resolve
  // target (WebGPU's only resolve); depth by a draw that writes sample 0's depth (WebGPU resolves no depth)
  private resolve(s: Tex, sl: number, sy: number, d: Tex, dl: number, dy: number) {
    this.stats.resolves++;
    if (s.gpu.format !== d.gpu.format || s.gpu.width !== Math.max(1, d.gpu.width >> dl) || s.gpu.height !== Math.max(1, d.gpu.height >> dl)) { this.red("resolvefmt", `Downsample from ${s.gpu.format} ${s.gpu.width}x${s.gpu.height} to ${d.gpu.format} ${d.gpu.width}x${d.gpu.height}: WebGPU resolves only between equal formats and sizes, dropped`); return; }
    if (s.fmt.kind !== "depth" && !s.fmt.stencil) {
      this.encoder().beginRenderPass({ colorAttachments: [{ view: this.attachView(s, sl, sy), resolveTarget: this.attachView(d, dl, dy), loadOp: "load", storeOp: "store" }] }).end();
      return;
    }
    if (s.fmt.kind !== "depth") { this.red("resolvestencil", "Downsample of a stencil texture: not done"); return; }
    if (s.fmt.stencil) this.red("resolveds", "Downsample of a depth-stencil texture: the depth is resolved (sample 0), the stencil is not");
    const key = `resolvedepth|${d.gpu.format}`;
    let pl = this.helpers.get(key);
    if (!pl) {
      const m = this.device.createShaderModule({ code: `${FULLSCREEN_VS}
@group(0) @binding(0) var t: texture_depth_multisampled_2d;
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 { return textureLoad(t, vec2i(p.xy), 0); }` });
      pl = this.device.createRenderPipeline({ layout: "auto", vertex: { module: m, entryPoint: "vs" }, fragment: { module: m, entryPoint: "fs", targets: [] }, depthStencil: { format: d.gpu.format, depthCompare: "always", depthWriteEnabled: true } });
      this.helpers.set(key, pl);
    }
    const a: any = { view: this.attachView(d, dl, dy), depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "store" };
    if (d.fmt.stencil) { a.stencilLoadOp = "load"; a.stencilStoreOp = "store"; }
    const pass = this.encoder().beginRenderPass({ colorAttachments: [], depthStencilAttachment: a });
    pass.setPipeline(pl);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: s.gpu.createView({ dimension: "2d", baseArrayLayer: sy, arrayLayerCount: 1, aspect: "depth-only" }) }] }));
    pass.draw(3); pass.end();
  }
  // Depth texels (f32 rows) into a depth texture: WebGPU writes depth32float and depth24plus only by drawing. Encoded
  // and submitted on its own, so it takes effect at once like writeTexture
  private depthData(t: Tex, level: number, z: number, x: number, y: number, w: number, h: number, ptr: number, pitch: number) {
    const src = this.newTexture({ size: { width: w, height: h }, format: "r32float", usage: 0x04 | 0x02 });
    this.device.queue.writeTexture({ texture: src }, this.u8.subarray(ptr, ptr + pitch * (h - 1) + w * 4), { bytesPerRow: pitch, rowsPerImage: h }, { width: w, height: h });
    const key = `depthup|${t.gpu.format}`;
    let pl = this.helpers.get(key);
    if (!pl) {
      const m = this.device.createShaderModule({ code: `struct U { o: vec4f } @group(0) @binding(0) var<uniform> u: U; @group(0) @binding(1) var t: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0); }
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 { return textureLoad(t, vec2i(p.xy - u.o.xy), 0).r; }` });
      pl = this.device.createRenderPipeline({ layout: "auto", vertex: { module: m, entryPoint: "vs" }, fragment: { module: m, entryPoint: "fs", targets: [] }, depthStencil: { format: t.gpu.format, depthCompare: "always", depthWriteEnabled: true } });
      this.helpers.set(key, pl);
    }
    const ub = this.newBuffer({ size: 16, usage: 0x40 | 0x08 });
    this.device.queue.writeBuffer(ub, 0, new Float32Array([x, y, 0, 0]));
    const a: any = { view: this.attachView(t, level, z), depthLoadOp: "load", depthStoreOp: "store" };
    if (t.fmt.stencil) { a.stencilLoadOp = "load"; a.stencilStoreOp = "store"; }
    const enc = this.device.createCommandEncoder(), pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: a });
    pass.setPipeline(pl);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 1, resource: src.createView() }] }));
    pass.setViewport(x, y, w, h, 0, 1); pass.setScissorRect(x, y, w, h);
    pass.draw(3); pass.end();
    this.device.queue.submit([enc.finish()]);
    this.kill(src); this.kill(ub);
  }
  // Texels from the recorder (texcontent.ts): linear rows in memory. Takes effect at once; the recorder only sends
  // them before the submission's first use of the texture, so nothing encoded and not yet submitted reads it
  private texData(dv: DataView, p: number) {
    const t = this.texture(this.u64(dv, p + 8));
    if (!t) return;
    const what = dv.getUint32(p + 52, true);
    const level = dv.getUint32(p + 16, true), z = dv.getUint32(p + 20, true), y = dv.getUint32(p + 24, true), slices = dv.getUint32(p + 36, true), ptr = dv.getUint32(p + 40, true), pitch = dv.getUint32(p + 44, true), x = dv.getUint32(p + 48, true);
    const f = t.fmt, up = (v: number, b: number) => Math.ceil(v / b) * b, lw = up(Math.max(1, t.gpu.width >> level), f.bw), lh = up(Math.max(1, t.gpu.height >> level), f.bh);
    const w = Math.min(dv.getUint32(p + 28, true), lw - x), h = Math.min(dv.getUint32(p + 32, true), lh - y), rows = h / f.bh;
    if (w <= 0 || h <= 0 || level >= t.gpu.mipLevelCount) return;
    if (t.gpu.sampleCount > 1) return;
    if (what === 1) {       // depth as f32, one draw a layer
      for (let s = 0; s < slices; s++) this.depthData(t, level, z + s, x, y, w, h, ptr + s * pitch * h, pitch);
      this.stats.uploads++; this.stats.uploadBytes += pitch * h * slices; return;
    }
    const bpb = what === 2 ? 1 : f.bpb, bytes = pitch * rows * (slices - 1) + pitch * (rows - 1) + w / f.bw * bpb;
    this.device.queue.writeTexture({ texture: t.gpu, mipLevel: level, origin: { x, y, z }, ...(what === 2 && f.kind === "depth" ? { aspect: "stencil-only" } : {}) }, this.u8.subarray(ptr, ptr + bytes), { bytesPerRow: pitch, rowsPerImage: rows }, { width: w, height: h, depthOrArrayLayers: slices });
    this.stats.uploads++; this.stats.uploadBytes += bytes;
  }
  private copyT2B(dv: DataView, p: number) {
    const dst = this.u64(dv, p + 8), t = this.texture(this.u64(dv, p + 16));
    if (!t) return;
    const level = dv.getUint32(p + 24, true), layer = dv.getUint32(p + 28, true), r = [0, 1, 2, 3, 4, 5].map(i => dv.getInt32(p + 32 + i * 4, true)), f = t.fmt;
    if (t.gpu.sampleCount > 1 || f.tex === "depth24plus" || f.tex === "depth24plus-stencil8" || f.conv) { this.red("t2bfmt", "CopyTextureToBuffer from a multisampled or 24-bit depth texture, or one whose format the host converts: WebGPU cannot copy the guest's bytes out, dropped"); return; }
    const bx = Math.ceil(r[3] / f.bw), by = Math.ceil(r[4] / f.bh), depth = Math.max(1, r[5]), wb = bx * f.bpb, row = dv.getUint32(p + 56, true) || wb, img = dv.getUint32(p + 60, true) || row * by, srcRow = Math.ceil(wb / 256) * 256;
    const buf = this.newBuffer({ size: srcRow * by * depth, usage: 0x01 | 0x08 });
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
    t.snap ??= this.newTexture({ size: { width: g.width, height: g.height, depthOrArrayLayers: g.depthOrArrayLayers }, format: g.format, dimension: g.dimension, mipLevelCount: g.mipLevelCount, usage: 0x04 | 0x02 | 0x10 });
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
    this.imageEvent(win, index, 0);
    const gen = this.gen;
    this.device.queue.onSubmittedWorkDone().then(() => { if (gen === this.gen) this.imageEvent(win, index, 1); }, () => {});
    if (this.cap) this.captureEnd();
  }

  // ---- the stream ----
  exec(ptr: number, len: number) {
    if (this.disposed) return;
    let dv = this.dv;
    for (let p = ptr, end = ptr + len; p < end;) {
      const op = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
      if (this.cap) this.captureRecord(op, dv, p);
      switch (op) {
        case H.TEX_CREATE: {
          const serial = this.u64(dv, p + 8), d = p + 16, format = dv.getInt32(d + 4, true);
          this.textures.set(serial, { serial, target: dv.getInt32(d, true), format, flags: dv.getInt32(d + 8, true), samples: dv.getInt32(d + 12, true), width: dv.getUint32(d + 16, true), height: dv.getUint32(d + 20, true),
            depth: dv.getUint32(d + 24, true), levels: dv.getUint32(d + 28, true), views: new Map(), fmt: hostFormat(format, this.caps)! });
          break;
        }
        case H.TEX_DESTROY: { const s = this.u64(dv, p + 8), t = this.textures.get(s); if (t) { this.flush(); this.groups.clear(); this.kill(t.gpu); this.kill(t.snap); this.textures.delete(s); } break; }
        case H.BEGIN_PASS: this.beginPass(dv, p); break;
        case H.END_PASS: { const targets = !this.computePass && this.pass ? this.passInfo?.targets : undefined; this.endPass(); if (this.cap && targets) this.captureTargets(targets); break; }
        case H.BEGIN_COMPUTE: this.endPass(); this.pass = this.encoder().beginComputePass(); this.computePass = true; this.cur = null; this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear(); this.stats.computePasses++; break;
        case H.DISPATCH: this.dispatch(dv, p); break;
        case H.SSBO: this.ssbo.set(dv.getUint32(p + 8, true) * 16 + dv.getUint32(p + 12, true), { addr: this.u64(dv, p + 16), size: dv.getUint32(p + 24, true), write: (dv.getUint32(p + 28, true) & 1) !== 0 }); this.bindDirty = true; break;
        case H.IMG: { const flags = dv.getUint32(p + 24, true); this.img.set(dv.getUint32(p + 8, true) * 8 + dv.getUint32(p + 12, true), { serial: this.u64(dv, p + 16), view: flags & 2 ? this.u8.slice(p + 32, p + 48) : null }); this.bindDirty = true; break; }
        case H.BUF_READBACK: this.bufReadback(this.u64(dv, p + 8), dv.getUint32(p + 16, true)); break;
        case H.UBO_DATA: this.ubo.set(dv.getUint32(p + 8, true) * 16 + dv.getUint32(p + 12, true), { addr: 0, size: 0, need: 0, data: this.u8.slice(p + 24, p + 24 + dv.getUint32(p + 16, true)) }); this.bindDirty = true; break;
        case H.VIEWPORT: this.pass.setViewport(dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true), Math.max(dv.getFloat32(p + 24, true), dv.getFloat32(p + 28, true))); break;
        case H.SCISSOR: this.pass.setScissorRect(dv.getUint32(p + 8, true), dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 20, true)); break;
        case H.PIPELINE_CREATE: this.createPipeline(dv.getUint32(p + 8, true), dv.getUint32(p + 12, true)); break;
        case H.PIPELINE: if (this.pass && !this.computePass) this.usePipeline(dv.getUint32(p + 8, true)); break;
        case H.VBUF: { const b = this.upload(this.u64(dv, p + 16), dv.getUint32(p + 12, true), 0); if (b) this.pass.setVertexBuffer(dv.getUint32(p + 8, true), b, this.upOff); break; }
        case H.UBO: this.ubo.set(dv.getUint32(p + 8, true) * 16 + dv.getUint32(p + 12, true), { addr: this.u64(dv, p + 16), size: dv.getUint32(p + 24, true), need: dv.getUint32(p + 28, true) }); this.bindDirty = true; break;
        case H.TEX: {
          const flags = dv.getUint32(p + 24, true);
          this.tex.set(dv.getUint32(p + 8, true) * 64 + dv.getUint32(p + 12, true), { serial: this.u64(dv, p + 16), snap: (flags & 1) !== 0, view: flags & 2 ? this.u8.slice(p + 32, p + 48) : null, samp: dv.getUint32(p + 28, true) });
          this.bindDirty = true; break;
        }
        case H.BLEND_COLOR: this.pass.setBlendConstant([0, 1, 2, 3].map(i => dv.getFloat32(p + 8 + i * 4, true))); break;
        case H.STENCIL_REF: this.pass.setStencilReference(dv.getUint32(p + 8, true)); break;
        case H.DRAW: case H.DRAW_IDX: {
          if (!this.cur || this.computePass) break;
          if (this.bindDirty && !this.bind()) break;
          const conv = dv.getUint32(p + (op === H.DRAW ? 24 : 28), true);
          if (conv) { this.drawConverted(dv, p, op === H.DRAW_IDX, conv); this.stats.draws++; break; }
          if (op === H.DRAW) this.pass.draw(dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 8, true), dv.getUint32(p + 20, true));
          else {
            const itype = dv.getUint32(p + 8, true), count = dv.getUint32(p + 12, true), isz = itype === 2 ? 4 : itype === 1 ? 2 : 1;
            const ib = this.upload(this.u64(dv, p + 32), count * isz, itype === 0 ? 1 : 2);
            if (!ib) break;
            this.pass.setIndexBuffer(ib, itype === 2 ? "uint32" : "uint16", this.upOff);
            this.pass.drawIndexed(count, dv.getUint32(p + 16, true), 0, dv.getInt32(p + 24, true), dv.getUint32(p + 20, true));
          }
          this.stats.draws++; break;
        }
        case H.CLEAR_RECT: this.clearRect(dv, p); break;
        case H.COPY_B2T: this.copyB2T(dv, p); break;
        case H.COPY_T2T: this.copyT2T(dv, p); break;
        case H.SNAPSHOT: this.snapshot(this.u64(dv, p + 8)); break;
        case H.PRESENT: this.present(dv, p); break;
        case H.FENCE: {
          // Done when the GPU has finished what was submitted before it and the read-backs issued before it have landed
          const n = this.u64(dv, p + 8); this.flush(); this.fencesPending.add(n);
          const rb = this.readbacks.slice(), done = () => { if (this.fencesPending.has(n)) this.signalFence(n); };
          if (this.lost) { done(); break; }
          this.device.queue.onSubmittedWorkDone().then(() => Promise.all(rb)).then(done, done); break;
        }
        case H.TEX_DATA: this.texData(dv, p); break;
        case H.FIXUP: { const f = [0, 1, 2, 3].map(i => dv.getFloat32(p + 8 + i * 4, true)); if (f.some((v, i) => v !== this.fix[i])) { this.fix = f; this.bindDirty = true; } break; }
        case H.COPY_T2B: this.copyT2B(dv, p); break;
        case H.FLUSH: this.flush(); break;
        case H.MEM_DIRTY: this.dropUploads(); break;
        case H_REPORT: this.reportsSeen = true; this.reportsOpen.push({ id: dv.getUint32(p + 8, true), seg: this.segOf() }); break;
        case H_REPORT_COMMIT: this.reportsCommit = true; break;
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
    const buf = this.newBuffer({ size: row * h, usage: 0x01 | 0x08 /* MAP_READ | COPY_DST */ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: t.gpu, mipLevel: level, origin: { x: 0, y: 0, z: layer }, ...(t.fmt.kind === "depth" ? { aspect: "depth-only" } : {}) }, { buffer: buf, bytesPerRow: row, rowsPerImage: h }, { width: w * t.fmt.bw, height: h * t.fmt.bh, depthOrArrayLayers: 1 });
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(1);
    const src = new Uint8Array(buf.getMappedRange()), data = new Uint8Array(w * h * bpp);
    for (let y = 0; y < h; y++) data.set(src.subarray(y * row, y * row + w * bpp), y * w * bpp);
    buf.unmap(); this.kill(buf);
    return { width: w, height: h, bytesPerPixel: bpp, data };
  }

  // ---- frame capture (debugging aid; nxnative: DM_NVN_PASSDUMP and the capture modes of nvn_capture.inc) ----
  // The host stream from now to the next present as text:
  // one line a pass, pipeline request, binding, draw, copy; and with png (the default) each render target of each
  // pass as a PNG, read back when the pass ends. Reading back submits what was encoded so far, which changes nothing
  // the game sees but costs time: a capture frame is slow. Resolves when the frame has been presented and read.
  private cap: { lines: string[]; images: Promise<CaptureImage | null>[]; state: { pass: number; draws: number; inPass: number }; png: boolean; records: number; dispatches: number; done: (c: Capture) => void } | null = null;
  captureFrame(opts: { png?: boolean } = {}): Promise<Capture> {
    if (this.cap) return Promise.reject(new Error("a capture is already running"));
    return new Promise<Capture>(done => {
      this.cap = { lines: [`nxweb frame capture: canvas ${this.canvasFormat}, uniform arena ${this.uniformArena ? "on" : "off"}, host caps ${this.caps}, ${this.textures.size} live textures, ${this.pipes.size} pipelines`],
        images: [], state: { pass: 0, draws: 0, inPass: 0 }, png: opts.png ?? true, records: 0, dispatches: 0, done };
    });
  }
  private capCtx = {
    shaderKey: (id: number) => this.shaders[id]?.key ?? `#${id}`,
    texture: (serial: number) => { const t = this.textures.get(serial); return t ? `tex#${serial} ${t.fmt?.tex ?? `format 0x${t.format.toString(16)}`} ${t.width}x${t.height}${t.depth > 1 ? `x${t.depth}` : ""}${t.levels > 1 ? ` ${t.levels} levels` : ""}${t.samples > 1 ? ` ${t.samples} samples` : ""}` : `tex#${serial} (not live)`; },
  };
  private captureRecord(op: number, dv: DataView, p: number) {
    const c = this.cap!;
    c.records++; if (op === H.DISPATCH) c.dispatches++;
    c.lines.push(describeRecord(op, dv, p, this.capCtx, c.state));
  }
  private captureTargets(targets: { name: string; serial: number; level: number; layer: number }[]) {
    const c = this.cap!;
    if (!c.png) return;
    const pass = c.state.pass;
    for (const tg of targets) {
      const t = this.textures.get(tg.serial);
      if (!t?.gpu || t.gpu.sampleCount > 1 || t.fmt.tex === "depth24plus" || t.fmt.tex === "depth24plus-stencil8" || t.fmt.tex === "depth32float-stencil8") { c.lines.push(`    (${tg.name} tex#${tg.serial}: not dumped, WebGPU cannot copy it out)`); continue; }
      const name = `pass${String(pass).padStart(3, "0")}_${tg.name}_tex${tg.serial}.png`;
      c.lines.push(`    -> ${name}`);
      c.images.push(this.readTexture(tg.serial, tg.level, tg.layer).then(r => {
        const rgba = toRgba8(t.fmt.tex!, r.data, r.width * r.height);
        return rgba ? { name, pass, target: tg.name, serial: tg.serial, width: r.width, height: r.height, format: t.fmt.tex!, png: png(r.width, r.height, rgba) } : null;
      }, () => null));
    }
  }
  private captureEnd() {
    const c = this.cap!;
    this.cap = null;
    void Promise.all(c.images).then(images => c.done({ text: c.lines.join("\n") + "\n", images: images.filter((i): i is CaptureImage => !!i), passes: c.state.pass, draws: c.state.draws, dispatches: c.dispatches, records: c.records }));
  }
}
