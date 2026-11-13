// nxweb graphics glue, the replayer: executes the host stream of the recorder (src/gfx, AssemblyScript) on WebGPU.
// The recorder decides everything NVN (pass boundaries, load actions, bindings, pipeline keys, what is skipped); this
// file reads each record and the tables it points to from the shared linear memory and makes the WebGPU call for it.
// Record layouts: src/gfx/hostops.ts. Pipeline key: src/gfx/pipeline.ts. Texture description: nvn_texdesc (obj.ts).
// Browser code (WebGPU types are left loose: the tree has no @webgpu/types).
import { slotWords, taskStride, pullVertexShader, fragmentInputs, TOPOLOGY_OF, CTL_WORDS, type MeshStage } from "../shaders/meshstage.ts";
import { imageVariant, formatClass, supportLayout } from "../shaders/images.ts";
import { fragmentInputVariant, fragmentOutputVariant, missingInputs } from "../shaders/variants.ts";
import { NVN_FORMATS, COMPARE, STENCIL_OP, BLEND_EQ, BLEND_FUNC, TOPOLOGY, WRAP, STORAGE_FORMATS, STORAGE_RW_FORMATS, MAYBE_UNFILTERABLE, VERTEX_CONV, convertVertices, hostFormat, type NvnFormat } from "./gfx_formats.ts";
import { describeRecord, png, toRgba8, type Capture, type CaptureImage } from "./gfx_capture.ts";
import { FrameLedger } from "./gfx_ledger.ts";
import { StreamCapture, parseCaptureSpec, httpSink, type CaptureSpec, type CaptureSink, type CaptureSummary } from "./gfx_stream_capture.ts";
import { NdveBypass, NDVE_KEYS, NDVE_OUTPUT_IMAGE, NDVE_FLIP_ON, NDVE_FLIP_BASE } from "./ndve.ts";
export type { Capture, CaptureImage } from "./gfx_capture.ts";
import { GmemMap, GM_ENTRIES, GM_LOG_BYTES, type GmRange } from "./gfx_gmem.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type GPU = any;

// a size down to a multiple of 4, without a 32-bit operator (a guest range may be 2 GB or more)
const down4 = (v: number) => Math.floor(v / 4) * 4;
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
  gfx_note_flush?(lo: bigint, n: bigint): void;
  gfx_stat(i: number): number;
  [name: string]: any;
}

export type VinClass = "float" | "sint" | "uint";
// A translated shader as the library holds it: the shader chain's reflection record (tools/shaders, src/shaders
// library.ts Reflection) plus the WGSL. Binding convention (src/gfx/README.md), stage = 0 vertex, 1 fragment, 2 compute:
//   @group(0) @binding(stage * 16 + i)          uniform buffer i of the stage; i = 14 is the translator's support buffer
//   @group(0) @binding(128 + stage * 16 + i)    storage buffer i
//   @group(0) @binding(208 + stage * 4 + k)     the blocks the host supplies (`extra`): k = 0 the shader's c1, 1 driver segment c0, 2 driver segment c2, 3 the NVN2 push constants
//   @group(1) @binding(stage * 64 + slot * 2)   texture slot, and + 1 its sampler
//   @group(1) @binding(256 + stage * 8 + i)     storage image i
//   @group(2) @binding(0)                       the position fix-up (vertex, `fixup`)
//   @group(2) @binding(2)                       the draw's base vertex, base instance, draw index: i32 each (vertex, `drawParams`)
//   vertex inputs @location(l) = NVN attribute l, fragment outputs @location(i) = colour target i
export interface ShaderInfo {
  stage: "vertex" | "fragment" | "compute" | "task" | "mesh";   // task, mesh: compute WGSL wrapped by src/shaders/meshstage.ts, drawn by "mesh draws" below
  mesh?: MeshStage;        // task, mesh: the stage's facts (output layout, payload, limits)
  wgsl: string;
  entry?: string;
  ubos?: number[];
  uboSize?: Record<string, number>;   // slot -> bytes the WGSL type covers: at least that is bound, zero past what the game bound
  // `handle`: a bindless slot. The shader samples the binding of `slot`; which texture and sampler that is stands in the game's uniform data, read at each draw:
  // the u32 at byte `offset` of this stage's uniform slot `ubo` (texture ID in the low 20 bits, sampler ID in the high 12). `sampler`: another word ORed into
  // it (the texture in one, the sampler in the other), or the sampler ID as a constant of the shader. A slot with a handle ignores nvnCommandBufferBindTexture
  textures?: { slot: number; dim?: "2d" | "2d-array" | "cube" | "3d" | "cube-array"; depth?: boolean; sampleType?: "float" | "unfilterable-float" | "sint" | "uint"; handle?: TextureHandle | PoolTextureHandle;
    sampler?: false | number }[];   // sampler: the slot has no sampler binding of its own (false: only fetched from; a number: it samples through that slot's, src/shaders/spv.ts shareSamplers)
  attributes?: number[];   // vertex: locations read
  attributeTypes?: Record<string, VinClass>;   // vertex: the class each input is declared with
  // vertex: the module to use when the bound attribute formats have other classes than declared. Either texts by
  // signature ("0:float,1:uint": every location read, ascending) or a function (the chain translating on demand)
  variants?: Record<string, string>;
  variant?: (classes: Record<number, VinClass>) => string | undefined;
  fixup?: boolean;         // vertex: declares `@group(2) @binding(0) var<uniform>` of one vec4f, the position fix-up (README)
  drawParams?: boolean;    // vertex: declares `@group(2) @binding(2) var<uniform>` of three i32, set per draw (setDrawParams)
  outputs?: number[];      // fragment: colour outputs written
  support?: boolean;       // reads the support buffer; also taken from `extra` (kind "support")
  storage?: { slot: number; write?: boolean }[];
  // global memory through addresses the shader loads (src/shaders/library.ts Reflection.gmem; "the mirror of global memory" below): `storage` then lists the
  // mirror (slot 32), its range table (33) and the write log (34) and nothing else; `slots` are the stage's own storage slots, which the module reads in the
  // mirror at bases the "gmem" block of `extra` holds; `pointers` are the address words the recorder follows (it sends the buffers they name as slots 32 + k)
  gmem?: { pointers: { slot: number; word: number; write?: boolean }[]; slots?: { slot: number; write: boolean }[]; write?: boolean; log?: boolean; untraced?: number };
  // storage images. `format`: the texel format the WGSL declares. A texture of another format of the same class (`type`; default: the format's) is bound through
  // a variant of the module and the pipeline made for that format (imagePipe); `bound`: the shader names no format, `format` is a stand-in (src/shaders/spv.ts placeImage)
  images?: { slot: number; format: string; access?: "write-only" | "read-only" | "read-write"; dim?: "2d" | "2d-array" | "3d"; type?: "float" | "sint" | "uint"; bound?: boolean }[];
  extra?: { kind: string; group: number; binding: number; size?: number; bank?: number; data?: string }[];   // the chain's other bindings: "support", "c1" (data: its bytes in hex), "drvcb" (bank 0 or 2), "push"
  hostBlocks?: { k: number; size: number }[];   // from `extra` at registration: the blocks at 208 + stage * 4 + k
  c1Data?: Uint8Array;
}
// The extra bindings the replayer supplies (src/shaders/library.ts HOST_EXTRA) and their k in 208 + stage * 4 + k
const HOST_BLOCK = (e: { kind: string; bank?: number }) => e.kind === "c1" ? 0 : e.kind === "drvcb" ? (e.bank === 0 ? 1 : e.bank === 2 ? 2 : -1) : e.kind === "push" ? 3 : e.kind === "gmem" ? 4 : -1;
// The binding of host block k of stage st: 208 + st * 4 + k, and for k = 4 (the ranges of memory read through loaded addresses, "gmem") 224 + st
const hostBinding = (st: number, k: number) => k < 4 ? 208 + st * 4 + k : 220 + k + st;
const uboKey = (st: number, i: number) => i < 16 ? st * 16 + i : 256 + st * 8 + i - 16;
export interface TextureHandle { ubo: number; offset: number; sampler?: { ubo: number; offset: number } | { id: number } }
// A slot of a pool texture (src/shaders/pool.ts): the recorder gives it the `index`-th distinct live handle among the words at byte `offset` + `stride` * i of the
// range bound at storage slot `sbuf` of the stage, and writes the handle it gave into word `entry` of the table in the c2 block (src/gfx/lower.ts poolHandle)
// `columns`: bit k = the word 4 (k + 1) bytes on in each record is a handle too. `at`: only record i is read, i = the sum of the terms (words of the stage's uniform
// slots, `mask`: the low 20 bits), 0 when `guard` and the first word's top two bits are not 0b10
export interface PoolTextureHandle { sbuf: number; offset: number; stride: number; index: number; entry: number; columns?: number; at?: { terms: { ubo: number; offset: number; mask: boolean }[]; guard: boolean } }
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
  // A stream capture to arm (gfx_stream_capture.ts parseCaptureSpec: a location.search with gfxcapture=, or its bare value). Omitted: globalThis.NX_GFXCAPTURE,
  // else the location.search of the page or worker the replayer runs in; false: none
  capture?: string | false;
}

const H = { TEX_CREATE: 1, TEX_DESTROY: 2, BEGIN_PASS: 3, END_PASS: 4, VIEWPORT: 5, SCISSOR: 6, PIPELINE_CREATE: 7, PIPELINE: 8, VBUF: 9, UBO: 10, TEX: 11,
  BLEND_COLOR: 12, STENCIL_REF: 13, DRAW: 14, DRAW_IDX: 15, CLEAR_RECT: 16, COPY_B2T: 17, COPY_T2T: 18, SNAPSHOT: 19, PRESENT: 20, FENCE: 21, FLUSH: 22, MEM_DIRTY: 23, TEX_DATA: 24, COPY_T2B: 25, FIXUP: 26,
  UBO_DATA: 27, SSBO: 28, IMG: 29, BEGIN_COMPUTE: 30, DISPATCH: 31, BUF_READBACK: 32,
  MESH_BEGIN: 35, MESH_TASK: 36, MESH_RUN: 37, MESH_DRAW: 38, CLEAR_TEX: 39, DISPATCH_SKIPPED: 40, SKIP: 41 };
// Pipeline key offsets (src/gfx/pipeline.ts)
const PK = { vs: 0, fs: 2, prim: 4, cull: 5, front: 6, polyMode: 7, offsetEn: 8, samples: 9, ncolor: 10, depthFmt: 11, colorFmt: 12, a2c: 20, flags: 21, blendEn: 22, stencilV: 23, stencilW: 24,
  itype: 25, chmask: 28, ds: 32, blend: 40, offset: 104, attrMask: 116, attr: 120, stream: 248, vin: 376 };
const DIMS = ["2d", "2d-array", "cube", "3d", "cube-array"], CLASSES: VinClass[] = ["float", "sint", "uint"];

interface Tex { serial: number; target: number; format: number; flags: number; samples: number; width: number; height: number; depth: number; levels: number; swz: number;
  gpu?: GPU; snap?: GPU; blank?: boolean; imgScratch?: Map<string, GPU>; blockScratch?: Map<string, GPU>; shapes?: Map<string, { tex: GPU; at: number; view: GPU }>; views: Map<string, GPU>; fmt: NvnFormat & { conv?: boolean } }
interface Slot { binding: number; st: number; i: number; kind: "ubo" | "ssbo" | "host"; dyn: boolean; write: boolean; size?: number; info?: ShaderInfo }
interface Pipe { id: number; compute: boolean; desc: any; gpu?: GPU; stages: number[]; key: number; layouts: GPU[]; g0: Slot[]; gen: number;
  mesh?: boolean; dynOnly?: boolean; last0?: { bufs: GPU[]; sizes: number[]; group: GPU }; empty1?: GPU;
  g1?: GPU; g1At?: number;      // group 1 as it was last made for a draw, and the state of the texture slots it was made from (GfxHost.texEpoch)
  drawParams?: boolean; vsFixup?: boolean; last2?: { fix: GPU | null; buf: GPU; group: GPU };
  img?: Map<string, { gpu: GPU; l1: GPU } | null>; imgOn?: boolean;
  // vertex inputs the replayer feeds itself: constSlot, the vertex buffer slot of the constant (0, 0, 0, 1) for attributes the game's state lacks;
  // vconv, attributes of a format WebGPU has no vertex format for, converted on the CPU into a buffer of their own at `slot` (vertexConverted)
  constSlot?: number; vconv?: { loc: number; stream: number; offset: number; stride: number; fmt: number; slot: number }[] }
interface TexVar { sid: number; st: number; slot: number }   // texture slot `slot` of shader `sid` has a texture bound that a `float` binding cannot take (depth, or a format the device does not filter)
interface StandIn { t: Tex; sc: GPU; lv: number; ly: number; cls: "float" | "sint" | "uint"; bits?: boolean }   // the pipeline for storage images of other formats than declared (imagePipe); imgOn: one is set on the pass
interface ImageFormatVar { sid: number; st: number; slot: number; format: string }   // image slot `slot` of shader `sid` (stage index st) has a texture of `format` bound
interface Chunk { buf: GPU; staging: Uint8Array; used: number }
interface UaSlot { c: Chunk; off: number; size: number; n?: number; ep?: number }      // n: the guest bytes it took; ep: the uaEpoch they were last known equal in
interface GpuRange { addr: number; size: number; buf: GPU; hash: number; pending: number }

// The one reinterpretation WebGPU allows a view: the sRGB twin of the texture's format
const SRGB_TWIN: Record<string, string> = {};
for (const b of ["rgba8unorm", "bgra8unorm", "bc1-rgba-unorm", "bc2-rgba-unorm", "bc3-rgba-unorm", "bc7-rgba-unorm", ...[[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]].map(([w, h]) => `astc-${w}x${h}-unorm`)]) { SRGB_TWIN[b] = b + "-srgb"; SRGB_TWIN[b + "-srgb"] = b; }
// Features asked of the adapter when it has them, and the limits raised to what it offers (GfxHost.deviceDescriptor)
const FEATURES = ["texture-compression-bc", "texture-compression-astc", "rg11b10ufloat-renderable", "depth32float-stencil8", "depth-clip-control", "texture-formats-tier1", "bgra8unorm-storage",
  "dual-source-blending", "float32-filterable", "clip-distances", "subgroups", "texture-component-swizzle", "texture-formats-tier2", "texture-compression-bc-sliced-3d", "texture-compression-astc-sliced-3d"];
const LIMITS = ["maxUniformBuffersPerShaderStage", "maxSampledTexturesPerShaderStage", "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage", "maxStorageTexturesPerShaderStage",
  "maxDynamicUniformBuffersPerPipelineLayout", "maxVertexAttributes", "maxVertexBuffers", "maxColorAttachmentBytesPerSample", "maxBindingsPerBindGroup", "maxInterStageShaderVariables", "maxBufferSize",
  "maxStorageBufferBindingSize", "maxUniformBufferBindingSize", "maxTextureDimension2D", "maxTextureArrayLayers", "maxBindGroups", "maxBindGroupsPlusVertexBuffers",
  "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupsPerDimension", "maxComputeWorkgroupStorageSize",
  "maxColorAttachments", "maxTextureDimension1D", "maxTextureDimension3D", "maxVertexBufferArrayStride", "maxDynamicStorageBuffersPerPipelineLayout"];
// The limits named when a device is adopted (the log line of what was granted)
const LIMITS_SHOWN = ["maxSampledTexturesPerShaderStage", "maxSamplersPerShaderStage", "maxUniformBuffersPerShaderStage", "maxStorageBuffersPerShaderStage", "maxStorageTexturesPerShaderStage",
  "maxDynamicUniformBuffersPerPipelineLayout", "maxVertexBuffers", "maxVertexAttributes", "maxColorAttachments", "maxColorAttachmentBytesPerSample", "maxInterStageShaderVariables",
  "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupsPerDimension", "maxTextureDimension2D", "maxTextureDimension3D",
  "maxTextureArrayLayers", "maxUniformBufferBindingSize", "maxStorageBufferBindingSize", "maxBufferSize"];
const UA_CHUNK = 1 << 20, UA_ALIGN = 256;
const HASH_PAGE = 4096;      // GfxHost.hashOf
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

const CAPTURE_RECORDS = 200_000, CAPTURE_IMAGES = 64;

// A Map that counts its changes
class GenMap<K, V> extends Map<K, V> {
  gen = 0;
  set(k: K, v: V): this { this.gen++; return super.set(k, v); }
  delete(k: K): boolean { this.gen++; return super.delete(k); }
  clear(): void { this.gen++; super.clear(); }
}
const NO_STAGES: number[] = [];
export class GfxHost {
  device: GPU;
  memory: WebAssembly.Memory;
  x!: GfxExports;
  log: (line: string) => void;
  context: GPU = null;
  canvasFormat = "bgra8unorm";
  lastPresented = 0;
  ledger = new FrameLedger();           // per frame: draws issued and skipped, the presented image's first writer; the keys that skipped work (gfx_ledger.ts)
  stats = { passes: 0, computePasses: 0, draws: 0, dispatches: 0, pipelinesAsync: 0, pipelinesSync: 0, pipelinesFailed: 0, uploads: 0, uploadBytes: 0, hashes: 0, hashedPages: 0, bindGroups: 0, submits: 0, presents: 0, snapshots: 0,
    clearRects: 0, errors: 0, uniformSlots: 0, uniformBytes: 0, uniformWrites: 0, resolves: 0, bufferReadbacks: 0, deviceLosses: 0, gmemRanges: 0, gmemBytes: 0, gmemUploads: 0, gmemUploadBytes: 0, gmemReadbacks: 0, gmemGrows: 0, gmemLogged: 0,
    meshDraws: 0, meshIndirect: 0, meshWithTask: 0, meshFailed: 0, ndveSkipped: 0, ndveStandIns: 0, ssboCopies: 0, imageStandIns: 0, passReopens: 0, zeroUploads: 0 };
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
  shaderStateOf: ((keyHex: string) => string | undefined) | null = null;   // the embedder's state of a key (rt_shaders.ts), for the capture's key lines
  onShaderVariant: ((keyHex: string, classes: Record<number, VinClass>) => string | undefined) | null = null;

  private opts: GfxHostOptions;
  private gen = 1;            // the device's generation: completions of an earlier device are dropped
  private lost = false;
  private shaders: { info: ShaderInfo; key: string; module?: GPU; variants?: Map<string, GPU | null>; interp?: Map<string, GPU | null> }[] = [];
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
  private tex = new GenMap<number, { serial: number; snap: boolean; view: Uint8Array | null; samp: number }>();
  private ssbo = new Map<number, { addr: number; size: number; write: boolean }>();
  private img = new GenMap<number, { serial: number; view: Uint8Array | null }>();
  // What group 1 (textures, samplers, images) of a pipeline was made from is the same while nothing was bound to a texture or image slot (the maps'
  // `gen`) and no texture, snapshot or sampler can have changed (texEpoch: every exec, submission, snapshot, texture made or destroyed): then a draw
  // that only moved its uniform or vertex ranges takes the group its pipeline had (Pipe.g1) without looking at a texture
  private texEpoch = 0;
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
    const g = globalThis as any, spec = opts.capture === false ? null : parseCaptureSpec(opts.capture ?? g.NX_GFXCAPTURE ?? g.location?.search);
    if (spec) void this.streamCapture(spec);
  }
  // ---- stream capture (gfx_stream_capture.ts; test/gfx/REPLAY.md): N frames of the host stream with everything a replay needs, written to `sink`
  // (default: the log receiver the spec names). Starts after the present the spec names; resolves with the summary when the file is written
  private sc: StreamCapture | null = null;
  private scArm: { spec: CaptureSpec; sink: CaptureSink; go: (s: CaptureSummary) => void; draws0: number } | null = null;
  streamCapture(spec: CaptureSpec | string, sink?: CaptureSink): Promise<CaptureSummary> {
    const s = typeof spec === "string" ? parseCaptureSpec(spec) : spec;
    if (!s) return Promise.reject(new Error(`not a capture spec: ${spec}`));
    if (this.sc || this.scArm) return Promise.reject(new Error("a stream capture is already armed or running"));
    this.log(`gfxcapture: armed for ${s.frames} frame${s.frames === 1 ? "" : "s"} ${s.present !== undefined ? `after present ${s.present}` : s.draws !== undefined ? `from the first frame of at least ${s.draws} draws` : "from the next present"}${sink ? "" : `, to ${s.to}/${s.name}`}`);
    return new Promise<CaptureSummary>(go => { this.scArm = { spec: s, sink: sink ?? httpSink(s.to, s.name, l => this.log(l)), go, draws0: this.stats.draws }; });
  }
  // After a present was executed (nothing is encoded and not submitted, no pass is open): the armed capture begins when its condition holds
  private scBegin(): StreamCapture | null {
    const a = this.scArm!, draws = this.stats.draws - a.draws0;
    a.draws0 = this.stats.draws;
    if (this.pass || this.enc || this.lost || (a.spec.present !== undefined ? this.stats.presents < a.spec.present : a.spec.draws !== undefined ? draws < a.spec.draws : false)) return null;
    this.scArm = null;
    this.log(`gfxcapture: begins after present ${this.stats.presents} (${draws} draws in its frame)`);
    const c = this.sc = new StreamCapture(this, a.spec, a.sink);
    void c.done.then(a.go);
    return c;
  }
  // What to ask an adapter for: every feature the replayer can use that it has, and the per-stage limits raised to
  // what it offers (WebGPU's defaults are 12 uniform buffers, 16 sampled textures and 16 samplers a stage; a game's
  // shader stage can declare 14 uniform blocks plus the support buffer and 32 textures)
  // Whether a device's shaders may use WGSL's subgroup builtins (asked for by deviceDescriptor when the adapter has them): the in-page translator's path
  // for warp operations (rt_shaders.ts workerTranslator subgroups, src/shaders/spv_subgroups.ts)
  static hasSubgroups(device: GPU | undefined): boolean { return !!device?.features?.has?.("subgroups"); }
  static deviceDescriptor(adapter: GPU): { requiredFeatures: string[]; requiredLimits: Record<string, number> } {
    const requiredLimits: Record<string, number> = {};
    for (const l of LIMITS) if (typeof adapter.limits?.[l] === "number") requiredLimits[l] = adapter.limits[l];
    // and every other limit the adapter reports (a limit a later browser adds is asked for at the adapter's value too; asking for the adapter's own value is always granted)
    for (const l in adapter.limits ?? {}) { const v = adapter.limits[l]; if (typeof v === "number" && Number.isFinite(v)) requiredLimits[l] = v; }
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
    try { this.log(`WebGPU device: features ${[...(device.features ?? [])].sort().join(" ") || "none"}; limits ${LIMITS_SHOWN.filter(l => typeof device.limits?.[l] === "number").map(l => `${l} ${device.limits[l]}`).join(", ")}`); } catch { /* a device without the lists */ }
    this.probe(device);
    device.onuncapturederror = (e: any) => { this.stats.errors++; this.log(`[RED] WebGPU: ${String(e.error?.message ?? e).split("\n")[0]}`); };
    // weakly: a device outlives the replayers made on it (one per process), and its lost promise would keep each one and its memory
    GfxHost.watchLost(device, new WeakRef(this), this.gen);
  }
  // What this device does with formats beyond core WebGPU, asked of the device itself (in error scopes; the answers come before a game's first texture, and until
  // then the core answer holds): unfilterable, the float formats a `float` binding and a filtering sampler may not take; storeW, the formats a texture may be
  // bound as a storage image with (texture-formats-tier1 adds many); storeRW, those one shader may read and write (tier2)
  private unfilterable = new Set<string>(MAYBE_UNFILTERABLE);
  private storeW = new Set<string>(STORAGE_FORMATS);
  private storeRW = new Set<string>(STORAGE_RW_FORMATS);
  private probe(device: GPU) {
    this.unfilterable = new Set(MAYBE_UNFILTERABLE); this.storeW = new Set(STORAGE_FORMATS); this.storeRW = new Set(STORAGE_RW_FORMATS);
    if (device.features?.has?.("bgra8unorm-storage")) this.storeW.add("bgra8unorm");
    if (typeof device.pushErrorScope !== "function" || typeof device.popErrorScope !== "function") return;
    const gen = this.gen;
    const ask = (make: () => void, yes: () => void) => {
      let threw = false;
      device.pushErrorScope("validation");
      try { make(); } catch { threw = true; }      // a name this browser does not know
      Promise.resolve(device.popErrorScope()).then((e: any) => { if (!e && !threw && gen === this.gen && device === this.device) yes(); }, () => {});
    };
    try {
      const formats = new Set<string>(["r16unorm", "r16snorm", "rg16unorm", "rg16snorm", "rgba16unorm", "rgba16snorm"]);
      for (const f of Object.values(NVN_FORMATS)) if (f.tex && f.bw === 1 && f.kind !== "depth" && !f.stencil && !f.tex.endsWith("-srgb") && f.tex !== "rgb9e5ufloat") formats.add(f.tex);
      const layout = (format: string, access: string) => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 4, storageTexture: { access, format, viewDimension: "2d" } }] });
      for (const f of formats) {
        if (!this.storeW.has(f)) ask(() => layout(f, "write-only"), () => this.storeW.add(f));
        if (!this.storeRW.has(f)) ask(() => layout(f, "read-write"), () => this.storeRW.add(f));
      }
      const fl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 2, texture: { sampleType: "float" } }] });
      for (const f of MAYBE_UNFILTERABLE) ask(() => { const t = device.createTexture({ size: { width: 1, height: 1 }, format: f, usage: 0x04 }); device.createBindGroup({ layout: fl, entries: [{ binding: 0, resource: t.createView() }] }); t.destroy(); }, () => this.unfilterable.delete(f));
    } catch { /* a device that cannot be asked: the core answers hold */ }
  }
  // Outside adopt(): a closure made there would share its context with the onuncapturederror handler, which holds `this`
  private static watchLost(device: GPU, self: WeakRef<GfxHost>, gen: number) {
    device.lost?.then?.((info: any) => { const h = self.deref(); if (h && gen === h.gen) void h.deviceLost(info); });
  }
  // Every texture and buffer the replayer makes, until it destroys it: what dispose() releases
  private live = new Set<GPU>();
  private newBuffer(desc: any): GPU { const o = this.device.createBuffer(desc); this.live.add(o); return o; }
  // No texture is asked of the device with an empty extent or no level (the device answers with an invalid texture, and every view, bind group and
  // command buffer that touches it is then invalid too): such a request is made 1 texel large and said once, with who asked
  private newTexture(desc: any, who = "a helper"): GPU {
    const z = desc.size, arr = Array.isArray(z), dims = arr ? [z[0], z[1] ?? 1, z[2] ?? 1] : [z.width, z.height ?? 1, z.depthOrArrayLayers ?? 1];
    if (dims.some(v => !(v >= 1)) || desc.mipLevelCount === 0) {
      this.red(`zerotex${who}`, `${who} asks for a ${desc.format} texture of ${dims.join("x")} with ${desc.mipLevelCount ?? 1} levels: made 1 texel large instead`);
      const [w, h, d] = dims.map(v => v >= 1 ? v : 1);
      desc = { ...desc, size: { width: w, height: h, depthOrArrayLayers: d }, mipLevelCount: Math.max(1, desc.mipLevelCount ?? 1) };
    }
    const o = this.device.createTexture(desc); this.live.add(o); return o;
  }
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
    for (const t of this.textures.values()) { t.gpu = undefined; t.snap = undefined; t.imgScratch = undefined; t.blockScratch = undefined; t.shapes = undefined; t.views.clear(); }
    this.textures.clear(); this.shaders = [];
    this.pipes.clear(); this.ndvePipes.clear(); this.ndveScratch.clear(); this.layouts.clear(); this.samplers.clear(); this.samplerAt.clear(); this.helpers.clear(); this.dummies.clear(); this.fixGroups.clear(); this.groups.clear(); this.ranges.clear(); this.pool.clear();
    this.converted.clear(); this.vconvBufs.clear(); this.constBuf = null; this.gpuRanges.clear(); this.gmReset(); this.uaPool = []; this.uaDone = []; this.uaCur = null; this.uaSeen.clear(); this.uaData.clear();
    this.inUse = []; this.queued = []; this.queuedBufs = []; this.dummy = null; this.zero = null; this.scratchSt = null; this.enc = null; this.pass = null; this.cur = null; this.passInfo = null; this.meshCtls = []; this.meshOut = null; this.meshTask = null; this.meshCur = null; this.meshHelp = null; this.meshSamples = []; this.meshOld = [];
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
  // (ptr is an address: a number from wasm_abi.ts instantiate(), in either build; a module instantiated without it
  // on a 32-bit memory hands an i32 over, which is negative from 2 GB on)
  imports() { return { gfx_exec: (ptr: number, len: number) => this.exec(ptr < 0 ? ptr + 4294967296 : ptr, len >>> 0) }; }
  attach(x: GfxExports) { this.x = x; x.gfx_host_caps?.(this.caps); }
  // ?ndve=bypass: the diagnostic stand-in for nn::ndve's movie network (src/glue/ndve.ts NdveBypass). The recorder is asked to report the model's dispatches
  // that cannot run; keys: the model's (tests give their own). Off until called: the stream and the replay are as before
  ndveBypass(keys: readonly string[] = NDVE_KEYS): void {
    this.ndve = new NdveBypass(keys);
    for (const k of new Set(keys)) { const b = k.match(/../g)!.map(h => parseInt(h, 16)); this.x.gfx_watch_key((b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0, (b[4] | b[5] << 8 | b[6] << 16 | b[7] << 24) >>> 0); }
    this.log("ndve=bypass: when nn::ndve's movie network cannot run, a bilinear stand-in writes its output (diagnostic; off by default)");
  }
  fitCanvas = false; onCanvasSize: ((width: number, height: number) => void) | null = null;
  private ndve: NdveBypass | null = null;
  private ndvePipes = new Map<string, { pipe: GPU; layout: GPU }>();
  private upR8 = 0; private upRg8 = 0;
  private ndveScratch = new Map<string, GPU>();      // the stand-in's own image for an output WebGPU cannot store to (an sRGB format), by format and size
  // A red line is logged once a key; how often its cause came up is counted, and frameReds() hands the counts since it was last called (a replay asks every frame)
  private redCount = new Map<string, number>(); private redText = new Map<string, string>();
  private red(key: string, line: string) {
    this.redCount.set(key, (this.redCount.get(key) ?? 0) + 1);
    if (!this.redOnce.has(key)) { this.redOnce.add(key); if (this.redText.size < 4096) this.redText.set(key, line); this.log(`[RED] ${line}`); }
  }
  frameReds(): [string, number][] {
    const out: [string, number][] = [...this.redCount].map(([k, n]) => [this.redText.get(k) ?? k, n]);
    this.redCount.clear();
    return out.sort((a, b) => b[1] - a[1]);
  }
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
      const gen = this.gen;
      try {
        const d = await this.opts.requestDevice();
        // disposed while the browser was asked: the new device has nobody to draw for
        if (gen !== this.gen || this.disposed) return;
        if (d) this.restore(d); else this.log("[RED] no new WebGPU device after the loss: nothing is drawn");
      } catch (e: any) { this.log(`[RED] no new WebGPU device after the loss: ${e?.message ?? e}`); }
    }
  }
  // A new device after a loss: every GPU object is dropped and made again from guest state. Textures whose content is
  // in guest memory are uploaded again at their next use; pipelines are requested again; what only the GPU held
  // (render targets, copies) is empty until the game writes it again (the count is returned and logged red)
  restore(device: GPU): number {
    this.gen++;
    this.live.clear();   // they belonged to the device that is gone
    for (const t of this.textures.values()) { t.gpu = undefined; t.snap = undefined; t.imgScratch = undefined; t.blockScratch = undefined; t.shapes = undefined; t.views.clear(); }
    for (const s of this.shaders) if (s) { s.module = undefined; s.variants = undefined; }
    this.pipes.clear(); this.ndvePipes.clear(); this.ndveScratch.clear(); this.layouts.clear(); this.samplers.clear(); this.samplerAt.clear(); this.helpers.clear(); this.dummies.clear(); this.fixGroups.clear(); this.groups.clear(); this.ranges.clear(); this.pool.clear();
    this.converted.clear(); this.vconvBufs.clear(); this.constBuf = null; this.gpuRanges.clear(); this.gmReset(); this.uaPool = []; this.uaDone = []; this.uaCur = null; this.uaSeen.clear(); this.uaData.clear();
    this.inUse = []; this.queued = []; this.queuedBufs = []; this.dummy = null; this.zero = null; this.scratchSt = null; this.enc = null; this.pass = null; this.cur = null; this.passInfo = null; this.meshCtls = []; this.meshOut = null; this.meshTask = null; this.meshCur = null; this.meshHelp = null; this.meshSamples = []; this.meshOld = [];
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
    if (info.wgsl) info = { ...info, wgsl: supportLayout(info.wgsl) };   // the support buffer as the recorder fills it (std140), whatever chain or store the text is from
    const dv = this.dv, r = Number(this.x.gfx_scratch()), bit = (a?: number[]) => (a ?? []).reduce((m, i) => m | (1 << i), 0) >>> 0;
    const unknown = (info.extra ?? []).filter(e => e.kind !== "support" && HOST_BLOCK(e) < 0);
    if (unknown.length) { this.log(`[RED] shader ${keyHex} needs bindings the replayer does not provide (${unknown.map(e => e.kind).join(", ")}): not registered`); return -1; }
    if ((info.stage === "task" || info.stage === "mesh") && info.mesh?.kind !== (info.stage === "task" ? "ts" : "ms")) { this.log(`[RED] ${info.stage} shader ${keyHex} has no stage facts (reflection "mesh"): not registered`); return -1; }
    const support = info.support || (info.extra ?? []).some(e => e.kind === "support"), st = info.stage === "vertex" ? 0 : info.stage === "fragment" ? 1 : info.stage === "task" ? 3 : info.stage === "mesh" ? 4 : 2;
    const hostBlocks = (info.extra ?? []).filter(e => HOST_BLOCK(e) >= 0).map(e => ({ k: HOST_BLOCK(e), size: e.size ?? 0 })).sort((a, b) => a.k - b.k);
    const c1 = info.extra?.find(e => e.kind === "c1")?.data, c1Data = c1 ? Uint8Array.from(c1.match(/../g) ?? [], h => parseInt(h, 16)) : undefined;
    new Uint8Array(this.memory.buffer, r, 472).fill(0);
    let depth = 0, bindless = 0;
    const poolAux = new Map<string, number>();   // a pool's record index (its `at`) -> the RF_blh entry that says it
    for (const t of info.textures ?? []) {
      const h = t.handle;
      if (!h) continue;
      if ("sbuf" in h) { if (!this.poolSlot(dv, r, t.slot, h, keyHex, poolAux, new Set((info.textures ?? []).map(x => x.slot)))) return -1; bindless |= 1 << t.slot; continue; }
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
    dv.setUint32(r, st, true); dv.setUint32(r + 4, (bit(info.ubos) | (support ? 1 << 14 : 0) | (bit(hostBlocks.map(b => b.k)) << 16)) >>> 0, true); dv.setUint32(r + 8, bit((info.textures ?? []).map(t => t.slot)), true);
    dv.setUint32(r + 12, bit(st === 0 ? info.attributes : info.outputs), true); dv.setUint32(r + 16, depth >>> 0, true);
    // slots 32 and up are not the game's (the mirror of global memory and its tables); a module that reads the mirror reads its own slots there too
    const bound = [...(info.storage ?? []).filter(b => b.slot < 32), ...(info.gmem?.slots ?? [])];
    dv.setUint32(r + 20, bit(bound.map(b => b.slot)), true); dv.setUint32(r + 24, bit(bound.filter(b => b.write).map(b => b.slot)), true);
    if (info.gmem) {
      if ((info.gmem as any).buffers !== undefined || !(info.storage ?? []).some(b => b.slot === 32)) { this.log(`[RED] shader ${keyHex} was translated for the per-range bindings of global memory, which the replayer no longer has (a stale shader cache): not registered`); return -1; }
      if (info.gmem.write && st < 2) { this.log(`[RED] ${info.stage} shader ${keyHex} stores into global memory: the mirror would be writable storage in a render pass whose other draws read it, which WebGPU refuses (the draw would have to run as compute or in a pass of its own): not registered`); return -1; }
      if (info.gmem.untraced) this.red(`gmuntraced${keyHex}`, `shader ${keyHex} reaches global memory through ${info.gmem.untraced} address${info.gmem.untraced === 1 ? "" : "es"} the translator could not follow to a bound word: it reads 0 there unless the mirror holds that memory for another shader`);
      const ptrs = info.gmem.pointers.slice(0, 16);
      dv.setUint32(r + 400, ptrs.length, true);
      ptrs.forEach((q, k) => { dv.setUint8(r + 404 + k * 4, q.slot | (q.write ? 0x80 : 0)); dv.setUint16(r + 406 + k * 4, q.word, true); });
    }
    dv.setUint32(r + 28, (bit((info.images ?? []).map(b => b.slot)) | bit((info.images ?? []).filter(b => (b.access ?? "write-only") !== "read-only").map(b => b.slot)) << 8) >>> 0, true);
    for (const [slot, size] of Object.entries(info.uboSize ?? {})) if (+slot < 14) dv.setUint32(r + 64 + +slot * 4, size, true);
    if (st === 0 && info.attributeTypes) {
      let vin = 0n;
      for (const l of info.attributes ?? []) vin |= BigInt(Math.max(0, CLASSES.indexOf(info.attributeTypes[l] ?? "float"))) << BigInt(l * 2);
      dv.setBigUint64(r + 128, vin, true); dv.setUint32(r + 136, 1, true);
    }
    if (info.mesh?.task) dv.setUint32(r + 136, dv.getUint32(r + 136, true) | 4, true);   // RF_flags 4: the mesh shader reads its task's payload
    const b = keyHex.match(/../g)!.map(h => parseInt(h, 16));
    const lo = (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0, hi = (b[4] | b[5] << 8 | b[6] << 16 | b[7] << 24) >>> 0;
    const id = this.x.gfx_shader_register(lo, hi, r);
    if (id >= 0) this.shaders[id] = { info: { ...info, support, hostBlocks, c1Data }, key: keyHex };
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
  // The pending keys a draw or dispatch was skipped for since the last call (the recorder's, src/gfx/shader.ts waited)
  shaderWaited(): string[] {
    const n = this.x.gfx_shader_waited(), at = this.x.gfx_scratch(), u8 = new Uint8Array(this.memory.buffer, at, n * 8), out: string[] = [];
    for (let i = 0; i < n; i++) out.push(Array.from(u8.subarray(i * 8, i * 8 + 8), b => b.toString(16).padStart(2, "0")).join(""));
    return out;
  }
  private module(id: number): GPU { const s = this.shaders[id]; return (s.module ??= this.device.createShaderModule({ code: s.info.wgsl })); }
  // The fragment module for this vertex shader: its own, or (src/shaders/variants.ts) one whose inputs the vertex stage does not write read a constant instead
  // (NVN leaves such a varying undefined; WebGPU refuses the pipeline)
  // and (`out`: colour target index -> the class of its format, for the targets the shader writes) one whose outputs have the classes of the targets: a float
  // output drawn into an integer target hands over its bits (fragmentOutputVariant). vsId < 0: a mesh draw, whose vertex stage is made from the fragment's inputs
  private foutShown = 0;
  private fragModule(vsId: number, fsId: number, out?: Record<number, VinClass>): GPU {
    const f = this.shaders[fsId], vw: string = vsId < 0 ? "" : this.shaders[vsId].info.wgsl ?? "", sig = vsId < 0 ? "" : missingInputs(f.info.wgsl ?? "", vw);
    const osig = out ? Object.keys(out).map(Number).sort((a, b) => a - b).map(l => `${l}:${out[l]}`).join(",") : "";
    if (!sig && !osig) return this.module(fsId);
    const key = "in:" + sig + (osig ? "|out:" + osig : "");
    let m = (f.variants ??= new Map()).get(key);
    if (m === undefined) {
      let w: string = f.info.wgsl, changed = false;
      if (sig) { const v = fragmentInputVariant(w, vw); if (v) { w = v; changed = true; } }
      if (osig) {
        const v = fragmentOutputVariant(w, out!);
        if (v) { w = v; changed = true; if (this.foutShown++ < 8) this.log(`fragment shader ${f.key} is drawn into colour targets of another class than its outputs declare (${osig}): its outputs hand their bits over (a variant of its text)`); }
      }
      m = changed ? this.device.createShaderModule({ code: w }) : null; f.variants.set(key, m);
    }
    return m ?? this.module(fsId);
  }
  // WebGPU wants a vertex output and the fragment input at the same location to name the same interpolation; the translator puts flat / linear on
  // the fragment input only (as the game's two stages have it). The vertex module for this fragment shader: its outputs take the fragment inputs'
  // interpolation. null when the shader's own module already agrees
  // The record's entry of a pool slot (src/gfx/shader.ts RF_blh, kind BL_POOL = 4): storage slot, byte offset, index | entry << 4, stride
  private poolSlot(dv: DataView, r: number, slot: number, h: PoolTextureHandle, keyHex: string, aux: Map<string, number>, used: Set<number>): boolean {
    const int = (v: number, below: number) => Number.isInteger(v) && v >= 0 && v < below, at = h.at, cols = h.columns ?? 0;
    const bad = (why: string) => { this.log(`[RED] shader ${keyHex}: texture slot ${slot} is a pool slot the replayer cannot read (${JSON.stringify(h)}; ${why}): not registered`); return false; };
    if (!int(slot, 32) || !int(h.sbuf, 16) || !int(h.offset, 65536) || h.offset % 4 || !int(h.stride, 65536) || h.stride % 4 || !int(h.index, 16) || !int(h.entry, 16) || !int(cols, 256))
      return bad("storage slots 0..15, offset and stride in words below 65536, 16 slots, 8 more columns");
    let kind = 4;
    if (at) {
      const t = at.terms ?? [];
      if (t.length < 1 || t.length > 2 || t.some(w => !int(w.ubo, 14) || !int(w.offset, 65536) || w.offset % 4)) return bad("a record index of one or two words of uniform slots 0..13 below 64 KB");
      // the helper entry: a texture slot's entry the shader's textures leave free (from the top), shared by the slots with the same index
      const key = JSON.stringify(at);
      let a = aux.get(key);
      if (a === undefined) {
        const taken = new Set(aux.values());
        for (a = 31; a >= 0 && (used.has(a) || taken.has(a)); a--);
        if (a < 0) return bad("no texture slot is free for its record index");
        aux.set(key, a);
        const e = r + 144 + a * 8;
        dv.setUint8(e, (t[0].mask ? 1 : 0) | (t[1]?.mask ? 2 : 0) | (at.guard ? 4 : 0) | (t[1] ? 8 : 0)); dv.setUint8(e + 1, t[0].ubo | (t[1]?.ubo ?? 0) << 4);
        dv.setUint16(e + 2, t[0].offset, true); dv.setUint16(e + 4, t[1]?.offset ?? 0, true);
      }
      kind = 5 | a << 3;
    }
    const e = r + 144 + slot * 8;
    dv.setUint8(e, kind); dv.setUint8(e + 1, h.sbuf); dv.setUint16(e + 2, h.offset, true); dv.setUint8(e + 4, h.index | h.entry << 4); dv.setUint8(e + 5, cols); dv.setUint16(e + 6, h.stride, true);
    return true;
  }
  private interpModule(vsId: number, fsId: number): GPU | null {
    const v = this.shaders[vsId], fw: string = this.shaders[fsId].info.wgsl ?? "", vw: string = v.info.wgsl ?? "";
    const params = /@fragment\s*fn\s+\w+\(((?:[^()]|\([^()]*\))*)\)/.exec(fw)?.[1];
    // the vertex stage's output is the struct its entry point returns (naga writes `-> VertexOutput`)
    const ret = /@vertex\s*fn\s+\w+\((?:[^()]|\([^()]*\))*\)\s*->\s*(\w+)/.exec(vw)?.[1];
    const out = ret ? new RegExp(`struct\\s+${ret}\\s*\\{[^}]*\\}`).exec(vw) : null;
    if (params === undefined || !out) return null;
    const want = new Map<number, string>();
    for (const m of params.matchAll(/@location\((\d+)\)(?:\s*@interpolate\(([^)]*)\))?/g)) want.set(+m[1], m[2] ?? "");
    const body = out[0].replace(/@location\((\d+)\)(\s*@interpolate\([^)]*\))?/g, (all, loc) => { const w = want.get(+loc); return w === undefined ? all : `@location(${loc})${w ? ` @interpolate(${w})` : ""}`; });
    if (body.replace(/\s+/g, "") === out[0].replace(/\s+/g, "")) return null;
    const sig = [...want].filter(([, w]) => w).map(([l, w]) => `${l}:${w}`).sort().join(";");
    v.interp ??= new Map();
    let mod = v.interp.get(sig);
    if (mod === undefined) { mod = this.device.createShaderModule({ code: vw.slice(0, out.index) + body + vw.slice(out.index + out[0].length) }); v.interp.set(sig, mod); }
    return mod;
  }
  // Storage images bound with a texture of another format than the shader declares (ShaderInfo.images; a translated shader that names no format declares a
  // stand-in): WebGPU wants the format in the WGSL, in the bind group layout and in the view to be one. The pipeline for the formats bound: each such shader's
  // text with those formats in its declarations (src/shaders/images.ts), group 1's layout with them, everything else the pipeline's own. Kept with the pipeline
  // by the formats; built at the first dispatch or draw that needs it, synchronously. null: it cannot be made (red), the dispatch or draw is skipped
  // The same for sampled textures (tvars): a slot declared `float` whose bound texture is depth, or of a format the device does not filter, takes
  // `unfilterable-float` and a non-filtering sampler in group 1's layout; the shaders' text is the same (a texture_2d<f32> may be either)
  private imagePipe(c: Pipe, vars: ImageFormatVar[], tvars: TexVar[] = []): { gpu: GPU; l1: GPU } | null {
    const sig = vars.map(v => `${v.st}.${v.slot}=${v.format}`).join(",") + (tvars.length ? "|" + tvars.map(v => `${v.st}.${v.slot}`).join(",") : "");
    const unfilt = (sid: number, info: ShaderInfo): ShaderInfo => { const mine = tvars.filter(v => v.sid === sid); return mine.length ? { ...info, textures: info.textures!.map(t => mine.some(v => v.slot === t.slot) ? { ...t, depth: false, sampleType: "unfilterable-float" as const } : t) } : info; };
    let p = (c.img ??= new Map()).get(sig);
    if (p !== undefined) return p;
    p = null;
    const desc: any = { ...c.desc }, stages: { info: ShaderInfo; st: number }[] = [];
    let ok = !!c.desc;
    for (const sid of c.stages) {
      const s = this.shaders[sid], info = unfilt(sid, s.info), st = info.stage === "vertex" ? 0 : info.stage === "fragment" ? 1 : 2, mine = vars.filter(v => v.sid === sid);
      if (!mine.length) { stages.push({ info, st }); continue; }
      stages.push({ st, info: { ...info, images: info.images!.map(m => ({ ...m, format: mine.find(v => v.slot === m.slot)?.format ?? m.format })) } });
      const msig = "img:" + mine.map(v => `${v.slot}=${v.format}`).join(",");
      let mod = (s.variants ??= new Map()).get(msig);
      if (mod === undefined) {
        let wgsl: string | undefined = c.compute || st === 1 ? info.wgsl : undefined;   // a vertex stage's module may be a variant already (attribute classes, interpolation): not combined
        for (const v of mine) wgsl = wgsl === undefined ? undefined : imageVariant(wgsl, 1, 256 + st * 8 + v.slot, v.format);
        mod = wgsl === undefined ? null : this.device.createShaderModule({ code: wgsl });
        s.variants.set(msig, mod);
        if (!mod) this.log(`[RED] shader ${s.key} has storage images bound with other formats than it declares (${msig.slice(4)}), and its text cannot be made over for them${c.compute || st === 1 ? " (no such texture_storage declaration in its WGSL)" : " (a vertex stage)"}: its dispatches or draws with these formats are skipped`);
      }
      if (!mod) { ok = false; continue; }
      const k = c.compute ? "compute" : st === 0 ? "vertex" : "fragment";
      desc[k] = { ...desc[k], module: mod };
    }
    if (ok) {
      const all = [...c.layouts]; all[1] = this.groupLayouts(stages, !!c.vsFixup, !!c.drawParams).layouts[1];
      desc.layout = this.device.createPipelineLayout({ bindGroupLayouts: all });
      p = { gpu: c.compute ? this.device.createComputePipeline(desc) : this.device.createRenderPipeline(desc), l1: all[1] }; this.stats.pipelinesSync++;
    }
    c.img!.set(sig, p);
    return p;
  }
  // The module of a vertex shader for attribute classes other than it declares; null when there is none (red: the request)
  private variantModule(id: number, classes: Record<number, VinClass>): GPU | null {
    const s = this.shaders[id], sig = Object.keys(classes).map(Number).sort((a, b) => a - b).map(l => `${l}:${classes[l]}`).join(",");
    s.variants ??= new Map();
    let m = s.variants.get(sig);
    if (m === undefined) {
      const made = s.info.variants?.[sig] ?? s.info.variant?.(classes) ?? this.onShaderVariant?.(s.key, classes), wgsl = made ? supportLayout(made) : made;   // (a variant is made from the chain's text: its support block too)
      m = wgsl ? this.device.createShaderModule({ code: wgsl }) : null;
      if (wgsl && !s.info.variants?.[sig]) s.info.variants = { ...s.info.variants, [sig]: wgsl };   // kept as text too: a stream capture carries it
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
    // a texture the game described with no size (a builder left at 0, or one whose size comes with data the recorder does not read): nothing to create,
    // a blank texture is sampled in its place and a pass has no such target
    if (!t.width || (!t.height && t.target !== 0 && t.target !== 3)) { this.red(`texsize${serial}`, `tex#${serial} (format 0x${t.format.toString(16)}, target ${t.target}) is ${t.width}x${t.height}x${t.depth} with ${t.levels} levels: not created (a blank texture is sampled in its place)`); return undefined; }
    const maxDim = this.limit(t.target === 2 ? "maxTextureDimension3D" : "maxTextureDimension2D", t.target === 2 ? 2048 : 8192);
    if (t.width > maxDim || t.height > maxDim) { this.red(`texbig${serial}`, `tex#${serial} (format 0x${t.format.toString(16)}, target ${t.target}) is ${t.width}x${t.height}x${t.depth}: larger than this device's textures (${maxDim}), not created (a blank texture is sampled in its place)`); return undefined; }
    const cube = t.target === 8 || t.target === 9, layers = t.target === 4 || t.target === 6 || t.target === 9 || t.target === 3 ? Math.max(1, t.target === 3 ? t.height : t.depth) : cube ? 6 : 1;
    const is3d = t.target === 2, h = t.target === 0 || t.target === 3 ? 1 : t.height;
    const up = (v: number, b: number) => Math.ceil(v / b) * b;
    const compressed = t.fmt.bw > 1, ms = t.samples > 1;
    let usage = 0x04 /* TEXTURE_BINDING */ | (ms ? 0 : 0x01 | 0x02 /* COPY_SRC | COPY_DST */);
    if (is3d && compressed && !this.device.features?.has?.(`texture-compression-${t.fmt.tex.startsWith("astc") ? "astc" : "bc"}-sliced-3d`)) {
      this.red(`fmt3d${t.fmt.tex}`, `a 3D texture of the compressed format ${t.fmt.tex}: this device has no texture-compression-${t.fmt.tex.startsWith("astc") ? "astc" : "bc"}-sliced-3d, the texture is not created (a blank one is sampled)`); return undefined;
    }
    if (!compressed && t.fmt.tex !== "rgb9e5ufloat" && (t.fmt.tex !== "rg11b10ufloat" || this.device.features?.has?.("rg11b10ufloat-renderable") || this.device.features?.has?.("texture-formats-tier1"))) usage |= 0x10; /* RENDER_ATTACHMENT */
    if (!ms && this.storeW.has(t.fmt.tex)) usage |= 0x08; /* STORAGE_BINDING */
    const twin = SRGB_TWIN[t.fmt.tex];
    // WebGPU has 1 and 4 samples: a multisampled NVN texture of any count has 4
    t.gpu = this.newTexture({ ...(twin ? { viewFormats: [twin] } : {}), size: { width: up(t.width, t.fmt.bw), height: up(h, t.fmt.bh), depthOrArrayLayers: is3d ? Math.max(1, t.depth) : layers }, format: t.fmt.tex,
      dimension: is3d ? "3d" : "2d", mipLevelCount: ms ? 1 : Math.max(1, t.levels), sampleCount: ms ? 4 : 1, usage }, `tex#${serial}`);
    return t;
  }
  private layerCount(t: Tex) { return t.gpu.depthOrArrayLayers; }
  // view: a view_t (16 bytes) or null; attach: one level and layer, for a render target or a copy
  // sampled: a shader samples through this view, so the channel swizzle applies (the view's own when it sets one, else the texture builder's: nxnative nvn_mtl.m)
  // null: the texture has no view of that dimension (a 2D view of a 3D texture, a cube of fewer than six layers); the layer and level ranges are cut to the texture's
  private view(t: Tex, src: GPU, view: Uint8Array | null, dim?: string, oneLevel = false, sampled = false): GPU | null {
    const key = (src === t.snap ? "s" : "t") + (dim ?? "") + (oneLevel ? "1" : "") + (sampled ? "z" : "") + (view ? String.fromCharCode.apply(null, view as any) : "");
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
    } else if (d.dimension === "2d" && this.layerCount(t) > 1) d.arrayLayerCount = 1;
    if (sampled && t.fmt.kind !== "depth") {
      const sw = view && (view[0] & 16) ? [view[10], view[11], view[12], view[13]] : [0, 3, 6, 9].map(s => t.swz >> s & 7);
      const s = sw.map((c, i) => "01rgba"[c > 5 ? 2 + i : c]).join("");
      if (s !== "rgba") {
        // WebGPU's texture-component-swizzle: such a view can only be sampled
        if (this.device.features?.has?.("texture-component-swizzle")) { d.swizzle = s; d.usage = 0x04; }
        else this.red("swizzle", `a texture is sampled with the channel swizzle ${s}: this device has no texture-component-swizzle, ignored`);
      }
    }
    const tex3d = t.gpu.dimension === "3d", layers = this.layerCount(t), cubeDim = d.dimension === "cube" || d.dimension === "cube-array";
    if (tex3d !== (d.dimension === "3d") || (t.gpu.sampleCount > 1 && d.dimension !== "2d") || (cubeDim && t.gpu.width !== t.gpu.height)) return null;
    if (tex3d) { delete d.baseArrayLayer; delete d.arrayLayerCount; }
    else {
      const base = Math.min(d.baseArrayLayer ?? 0, layers - 1), left = layers - base;
      let count = d.dimension === "2d" ? 1 : d.dimension === "cube" ? 6 : Math.min(d.arrayLayerCount ?? left, left);
      if (d.dimension === "cube-array") count -= count % 6;
      if (count < 1 || count > left) return null;
      if (base || count !== layers || d.baseArrayLayer !== undefined) { d.baseArrayLayer = base; d.arrayLayerCount = count; }
    }
    if (d.baseMipLevel !== undefined && d.baseMipLevel >= src.mipLevelCount) { d.baseMipLevel = src.mipLevelCount - 1; d.mipLevelCount = 1; }
    if (oneLevel) d.mipLevelCount = 1;
    if (t.fmt.kind === "depth" && t.fmt.stencil) d.aspect = view && (view[0] & 0x20) && (view[0] >> 6) === 1 ? "stencil-only" : "depth-only";
    v = src.createView(d);
    t.views.set(key, v);
    return v;
  }
  private attachView(t: Tex, level: number, layer: number, format?: string): GPU {
    if (format === t.fmt.tex || format !== SRGB_TWIN[t.fmt.tex!]) format = undefined;
    // a level or layer the texture does not have (a stale target): its last one, so the pass is valid
    if (level >= t.gpu.mipLevelCount) level = t.gpu.mipLevelCount - 1;
    if (t.gpu.dimension !== "3d" && layer >= t.gpu.depthOrArrayLayers) { this.red(`attlayer${t.serial}`, `a render target or copy names layer ${layer} of tex#${t.serial}, which has ${t.gpu.depthOrArrayLayers}: its last layer is used`); layer = t.gpu.depthOrArrayLayers - 1; }
    const key = `a${level}/${layer}/${format ?? ""}`;
    let v = t.views.get(key);
    if (!v) { v = t.gpu.createView({ ...(format ? { format, usage: t.gpu.usage & ~0x08 } : {}), dimension: t.gpu.dimension === "3d" ? "3d" : "2d", baseMipLevel: level, mipLevelCount: 1, ...(t.gpu.dimension === "3d" ? {} : { baseArrayLayer: layer, arrayLayerCount: 1 }) }); t.views.set(key, v); }
    return v;
  }
  // A 2D, single-layer colour texture as a 3D texture one slice deep, or as a cube (every face the texture): what a shader that declares that shape samples
  // when the game binds a plain 2D texture there. The copy is of level 0 and is made again every 60 submissions (the copy is submitted on its own, so it holds
  // what was drawn before the submission being encoded). null: no such copy (layers, compressed or depth formats, a cube of a texture that is not square)
  private reshaped(t: Tex, dim: string): GPU | null {
    const g = t.gpu, cube = dim === "cube" || dim === "cube-array";
    if (g.dimension !== "2d" || g.depthOrArrayLayers !== 1 || g.sampleCount > 1 || t.fmt.bw > 1 || t.fmt.kind === "depth" || t.fmt.stencil || !(g.usage & 0x01) || !(dim === "3d" || (cube && g.width === g.height))) return null;
    let e = (t.shapes ??= new Map()).get(dim);
    if (!e) t.shapes.set(dim, e = { tex: this.newTexture({ size: { width: g.width, height: g.height, depthOrArrayLayers: cube ? 6 : 1 }, dimension: dim === "3d" ? "3d" : "2d", format: g.format, usage: 0x04 | 0x02 }, "a reshaped copy"), at: -1000, view: null });
    if (this.flushNo - e.at >= 60) {
      const enc = this.device.createCommandEncoder();
      for (let z = 0; z < (cube ? 6 : 1); z++) enc.copyTextureToTexture({ texture: g }, { texture: e.tex, origin: { x: 0, y: 0, z } }, { width: g.width, height: g.height, depthOrArrayLayers: 1 });
      this.device.queue.submit([enc.finish()]);
      e.at = this.flushNo;
    }
    return (e.view ??= e.tex.createView({ dimension: dim }));
  }
  private dummies = new Map<string, GPU>();
  // The blank texture of a slot with nothing (or nothing that fits) bound: of the dimension and the sample type the shader declares
  private dummyView(dim: string, kind: "float" | "depth" | "uint" | "sint" = "float"): GPU {
    this.dummy ??= this.newTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 6 }, format: "rgba8unorm", usage: 0x04 | 0x02 });
    if (dim === "3d" && kind === "depth") kind = "float";   // no such texture exists
    let v = this.dummies.get(dim + kind);
    if (!v) {
      const format = kind === "depth" ? "depth16unorm" : kind === "uint" ? "rgba8uint" : kind === "sint" ? "rgba8sint" : "rgba8unorm";
      if (dim === "3d") v = this.newTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 1 }, dimension: "3d", format, usage: 0x04 | 0x02 }).createView();
      else v = (kind === "float" ? this.dummy : this.newTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 6 }, format, usage: 0x04 | 0x02 })).createView({ dimension: dim, ...(dim === "2d" ? { arrayLayerCount: 1 } : {}) });
      this.dummies.set(dim + kind, v);
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
  private ranges = new Map<string, { buf: GPU; hash: number; checked: number; used: number; addr: number; size: number }>();
  private epoch = 1;          // changes whenever guest memory may have
  private flushNo = 1;
  private upOff = 0;          // the offset of the last upload() inside the buffer it returned (a GPU-written range holds it at an offset)
  private alloc(cap: number): GPU { return this.pool.get(cap)?.pop() ?? this.newBuffer({ size: cap, usage: 0x04 | 0x08 | 0x10 | 0x20 | 0x40 | 0x80 /* COPY_SRC COPY_DST INDEX VERTEX UNIFORM STORAGE */ }); }
  private upload(addr: number, size: number, kind: number): GPU | null {
    this.upOff = 0;
    if ((this.gpuRanges.size || this.gm) && kind !== 1) { const r = this.gpuRangeOver(addr, size); if (r) { this.upOff = r.off; return r.buf; } }
    const key = `${addr}:${size}:${kind}`;
    let e = this.ranges.get(key);
    if (e && e.checked === this.epoch) { e.used = this.flushNo; return e.buf; }
    if (!addr || !size || addr + size > this.memory.buffer.byteLength) { this.red(`up${addr}`, `a draw binds memory outside the guest's (address 0x${addr.toString(16)} size ${size}): not bound`); return null; }
    const hash = this.cacheUploads ? this.hashOf(addr, size) : NaN;
    this.stats.hashes++;
    if (e && e.hash === hash) { e.checked = this.epoch; e.used = this.flushNo; return e.buf; }
    const cap = Math.max(256, 2 ** Math.ceil(Math.log2(size))) * (kind === 1 ? 2 : 1);
    if (e && e.used === this.flushNo) { this.inUse.push(e.buf); e = undefined; }       // still referenced by the open encoder: leave it, take another
    const b = e?.buf ?? this.alloc(cap);
    const n = down4(Math.min(cap, down4(size + 3), this.memory.buffer.byteLength - addr));
    if (kind === 1) {   // 8-bit indices: WebGPU has none, widened to 16
      const src = this.u8.subarray(addr, addr + size), wide = new Uint16Array((size + 1) & ~1);
      for (let i = 0; i < size; i++) wide[i] = src[i];
      this.device.queue.writeBuffer(b, 0, wide);
    } else this.device.queue.writeBuffer(b, 0, this.u8, addr, n);
    this.stats.uploads++; this.stats.uploadBytes += n;
    this.ranges.set(key, { buf: b, hash, checked: this.epoch, used: this.flushNo, addr, size });
    return b;
  }
  private dropUploads() { this.epoch++; this.bindDirty = true; this.uaEpoch++; }
  // The hash of guest [addr, addr + size), by which an upload is found unchanged. Ranges overlap (a vertex buffer bound at many offsets, each time up to
  // its end; a storage range inside a buffer the mirror of global memory holds whole) and every one is looked at again in every epoch, so a range's
  // hash is folded from the hashes of its 4 KiB pages, and a page's bytes are hashed (by the recorder, gfx_hash) once an epoch whichever range asks;
  // the two partial pages at a range's ends are hashed as they are. dropRange forgets the pages it names. (Profile of a 3D frame: 95% of the
  // replayer's CPU time was these hashes, most bytes several times over.)
  private pgHash = new Map<number, number>(); private pgEpoch = 0;
  private hashOf(addr: number, size: number): number {
    if (size < 2 * HASH_PAGE) return this.x.gfx_hash(addr, size);
    if (this.pgEpoch !== this.epoch) { this.pgHash.clear(); this.pgEpoch = this.epoch; }
    const m = this.pgHash, end = addr + size, p0 = Math.ceil(addr / HASH_PAGE), p1 = Math.floor(end / HASH_PAGE);
    let a = 0x811c9dc5 ^ size, b = 0x9e3779b9, h = 0;
    if (p0 * HASH_PAGE > addr) { h = this.x.gfx_hash(addr, p0 * HASH_PAGE - addr); a = Math.imul(a ^ (h >>> 0), 0x01000193); b = (Math.imul(b, 31) + Math.floor(h / 4294967296)) | 0; }
    for (let pg = p0; pg < p1; pg++) {
      const c = m.get(pg);
      if (c === undefined) { h = this.x.gfx_hash(pg * HASH_PAGE, HASH_PAGE); m.set(pg, h); this.stats.hashedPages++; } else h = c;
      a = Math.imul(a ^ (h >>> 0), 0x01000193); a ^= a >>> 15; b = (Math.imul(b, 31) + Math.floor(h / 4294967296)) | 0;
    }
    if (end > p1 * HASH_PAGE) { h = this.x.gfx_hash(p1 * HASH_PAGE, end - p1 * HASH_PAGE); a = Math.imul(a ^ (h >>> 0), 0x01000193); b = (Math.imul(b, 31) + Math.floor(h / 4294967296)) | 0; }
    return (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff);
  }
  // Guest memory changed in [addr, addr + size) and nowhere else (H_MEM_DIRTY with its range): only the uploads that overlap it are checked again at their next use
  private dropRange(addr: number, size: number) {
    const end = addr + size;
    for (const e of this.ranges.values()) if (e.addr < end && addr < e.addr + e.size) e.checked = -1;
    for (const e of this.vconvBufs.values()) if (e.addr < end && addr < e.addr + e.size) e.checked = -1;
    if (this.gm) for (const r of this.gm.ranges) if (r.start < end && addr < r.end) r.checked = -1;      // the mirror's ranges over it too
    if (size > 1024 * HASH_PAGE) this.pgHash.clear(); else for (let pg = Math.floor(addr / HASH_PAGE), last = Math.floor((end - 1) / HASH_PAGE); pg <= last; pg++) this.pgHash.delete(pg);
    this.vconvKey = ""; this.bindDirty = true; this.uaEpoch++;
  }

  // Storage ranges a compute pass wrote, until their read-back has landed in guest memory: the GPU's copy is the newer
  // one, so binds inside such a range (storage, vertex, index, uniform) use it instead of uploading guest memory
  private gpuRanges = new Map<string, GpuRange>();
  // (and ranges of the mirror of global memory a shader wrote: the mirror itself is bound, unless the draw or dispatch being bound writes it)
  private gpuRangeOver(addr: number, size: number, mirror = true): { buf: GPU; off: number } | null {
    for (const r of this.gpuRanges.values()) if (addr >= r.addr && addr + size <= r.addr + r.size) return { buf: r.buf, off: addr - r.addr };
    if (mirror && this.gm && !this.gmWriting) { const m = this.gm.find(addr, size); if (m && m.gpu) return { buf: this.gmBuf, off: m.off + addr - m.start }; }
    return null;
  }
  private storageBuffer(addr: number, size: number, write: boolean): { buf: GPU; off: number; size: number } | null {
    if (!addr || !size || addr + size > this.memory.buffer.byteLength) { this.red(`sb${addr}`, `a dispatch binds storage outside the guest's memory (address 0x${addr.toString(16)} size ${size}): not bound`); return null; }
    const bsize = down4(size + 3);
    if (!write) { const b = this.upload(addr, size, 3); return b && { buf: b, off: this.upOff, size: bsize }; }
    const key = `${addr}:${size}`, hash = this.hashOf(addr, size);
    let r = this.gpuRanges.get(key);
    // Guest memory changed since the GPU's copy was made (the game wrote new input): it is uploaded again
    if (r && r.hash === hash) return { buf: r.buf, off: 0, size: bsize };
    const over = !r && this.gpuRangeOver(addr, size, false);
    if (over) return { buf: over.buf, off: over.off, size: bsize };
    for (const o of this.gpuRanges.values()) if (o !== r && addr < o.addr + o.size && o.addr < addr + size) this.red("sboverlap", "storage ranges written by compute passes overlap without one containing the other: each keeps its own GPU copy until read back");
    const buf = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(bsize))));
    this.device.queue.writeBuffer(buf, 0, this.u8, addr, down4(Math.min(bsize, this.memory.buffer.byteLength - addr)));
    this.stats.uploads++; this.stats.uploadBytes += bsize;
    if (r) { this.inUse.push(r.buf); r.buf = buf; r.hash = hash; } else this.gpuRanges.set(key, r = { addr, size, buf, hash, pending: 0 });
    return { buf, off: 0, size: bsize };
  }
  private bufReadback(addr: number, size: number) {
    const r = this.gpuRanges.get(`${addr}:${size}`);
    if (!r) { this.gmReadback(addr, size); return; }
    this.endPass();
    const n = down4(size + 3), buf = this.newBuffer({ size: n, usage: 0x01 | 0x08 });
    this.encoder().copyBufferToBuffer(r.buf, 0, buf, 0, n);
    r.pending++;
    this.queuedBufs.push({ buf, range: r });
  }

  // ---- the mirror of global memory (docs/gmem-mirror.md; src/glue/gfx_gmem.ts; src/shaders/spv.ts globalMemory) ----
  // A shader that reaches memory through addresses it loads reads and writes ONE storage buffer here, the mirror, through a table of the guest ranges it holds
  // (GmemMap). What a draw or dispatch names is placed in the mirror and brought up to date before it is bound (gmPrepare): the ranges bound at the stage's own
  // storage slots (the module reads them in the mirror too, at bases sent in a uniform block) and the live buffers its followed addresses lie in (the recorder
  // sends them as slots 32 + k). A range is uploaded when its guest bytes changed since the mirror last took them (one hash a range an epoch, as upload());
  // a range a shader may have written is the GPU's until its read-back lands (H_BUF_READBACK at the end of the pass, as for any written storage range), and
  // binds of memory inside it by other shaders (vertex, index, uniform, storage, an indirect mesh draw's record) are served from the mirror meanwhile.
  // Order: an upload into a range no command of the open encoder has used is a queue write; into one that has been used it is a copy encoded in place (the
  // pass is closed for it and opened again), so earlier draws keep what they read. The mirror grows by doubling (a copy in the encoder, the old buffer dies
  // after the submission) up to gmemLimit or the device's maxStorageBufferBindingSize / maxBufferSize. Ranges unused for 240 submissions leave the mirror.
  // The write log (the translator's bitmap of table entries stored through) is copied out and cleared at each submission, and when the table changes under
  // it; an entry it names that no read-back covered in that submission is read back with the next one (a store through an address nobody followed).
  gmemInitial = 4 << 20;
  gmemLimit = 1 << 30;
  private gm: GmemMap | null = null; private gmBuf: GPU = null; private gmTable: GPU = null; private gmLog: GPU = null;
  private gmGen = 0; private gmGrown = 0; private gmWriting = false; private gmLogUsed = false; private gmOld: GPU[] = [];
  private gmQueued: { buf: GPU; r: GmRange; addr: number; size: number }[] = [];
  private gmLogs: { buf: GPU; ranges: GmRange[]; flush: number }[] = [];
  private gmLate: GmRange[] = [];
  private gmRead = new Map<GmRange, number>();   // the submission a range was last read back in
  private gmReset() { this.gm = null; this.gmBuf = this.gmTable = this.gmLog = null; this.gmOld = []; this.gmQueued = []; this.gmLogs = []; this.gmLate = []; this.gmRead.clear(); this.gmLogUsed = false; this.gmGen = 0; }
  private gmMap(): GmemMap {
    if (this.gm) return this.gm;
    const limit = Math.min(this.gmemLimit, this.limit("maxStorageBufferBindingSize", 134217728), this.limit("maxBufferSize", 268435456));
    this.gm = new GmemMap(limit - limit % 4096);
    this.gmTable = this.newBuffer({ size: GM_ENTRIES * 32, usage: 0x80 | 0x08 });
    this.gmLog = this.newBuffer({ size: GM_LOG_BYTES, usage: 0x80 | 0x08 | 0x04 });
    this.gmBuf = this.newBuffer({ size: Math.min(this.gm.limit, Math.max(65536, this.gmemInitial - this.gmemInitial % 4096)), usage: 0x04 | 0x08 | 0x10 | 0x20 | 0x40 | 0x80 });
    this.gmGen = 0;
    this.log(`mirror of global memory: ${this.gmBuf.size >> 10} KiB to begin with, up to ${this.gm.limit >> 20} MiB on this device, a table of ${GM_ENTRIES} ranges`);
    return this.gm;
  }
  // Commands that must run after everything encoded so far and before what follows: an open pass is closed for them and opened again
  private gmOrdered(fn: (enc: GPU) => void) {
    if (!this.pass) { fn(this.encoder()); return; }
    const render = !this.computePass;
    if (render && !this.passDesc) { this.red("gmorder", "the mirror of global memory needs a copy in the middle of a render pass that cannot be opened again: the copy is left out"); return; }
    this.pass.end(); fn(this.encoder());
    if (render) this.reopenRenderPass(); else { this.pass = this.encoder().beginComputePass(); this.computePass = true; }
    if (this.cur?.gpu) this.pass.setPipeline(this.cur.gpu);
  }
  private gmEnsure() {
    const g = this.gm!, old = this.gmBuf;
    if (old.size >= g.size) return;
    const size = Math.min(g.limit, Math.max(g.size, old.size * 2)), nb = this.newBuffer({ size: Math.ceil(size / 4) * 4, usage: old.usage });
    this.gmOrdered(enc => enc.copyBufferToBuffer(old, 0, nb, 0, old.size));
    this.gmBuf = nb; this.gmOld.push(old); this.gmGrown = this.flushNo; this.stats.gmemGrows++;
  }
  private gmLen(r: GmRange): number { return down4(Math.min(r.end, this.memory.buffer.byteLength) - r.start); }
  private gmSync(r: GmRange) {
    if (r.checked === this.epoch) return;
    r.checked = this.epoch;
    const n = this.gmLen(r);
    if (n <= 0) return;
    const h = this.hashOf(r.start, n);
    this.stats.hashes++;
    if (h === r.hash) return;
    r.hash = h; this.stats.gmemUploads++; this.stats.gmemUploadBytes += n;
    if (r.used === this.flushNo || this.gmGrown === this.flushNo) {
      const st = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(n))));
      this.device.queue.writeBuffer(st, 0, this.u8, r.start, n); this.inUse.push(st);
      this.gmOrdered(enc => enc.copyBufferToBuffer(st, 0, this.gmBuf, r.off, n));
    } else this.device.queue.writeBuffer(this.gmBuf, r.off, this.u8, r.start, n);
  }
  // The range of the mirror that holds guest [addr, addr + size), placed if it was not and up to date; `write`: a shader of what is being bound may store into it
  private gmRange(addr: number, size: number, write: boolean): GmRange | null {
    if (!addr || !size || addr + size > this.memory.buffer.byteLength) { this.red(`gm${addr}`, `a shader reaches memory outside the guest's (address 0x${addr.toString(16)} size ${size}): not in the mirror of global memory, it reads 0`); return null; }
    const g = this.gmMap(), p = g.place(addr, size);
    if (!p) { this.red("gmfull", `the mirror of global memory is full (${g.size >> 20} of ${g.limit >> 20} MiB, ${g.ranges.length} of ${GM_ENTRIES - 1} ranges): a range of ${size} bytes at 0x${addr.toString(16)} is not placed, it reads 0`); return null; }
    const r = p.r;
    this.gmEnsure(); this.gmSync(r);
    for (const o of p.merged) {
      if (!o.gpu) continue;
      // what only the mirror held of a range this one replaces moves over (through a buffer: a copy cannot stay within one)
      const n = o.end - o.start, tmp = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(n))));
      this.inUse.push(tmp); r.gpu = true;
      this.gmOrdered(enc => { enc.copyBufferToBuffer(this.gmBuf, o.off, tmp, 0, n); enc.copyBufferToBuffer(tmp, 0, this.gmBuf, r.off + o.start - r.start, n); });
    }
    if (write) r.gpu = true;
    r.used = this.flushNo;
    this.stats.gmemRanges = g.ranges.length; this.stats.gmemBytes = g.size;
    return r;
  }
  // A stage that reads the mirror is about to be bound: its slots' ranges and its followed addresses' buffers, the table, the bases
  private gmPrepare(info: ShaderInfo, st: number) {
    const g = this.gmMap(), gi = info.gmem!, base = new Uint32Array(32);
    if (gi.write) this.gmWriting = true;
    for (const s of gi.slots ?? []) {
      const b = this.ssbo.get(st * 64 + s.slot);
      if (!b || !b.addr || !b.size) continue;
      const r = this.gmRange(b.addr, b.size, s.write || b.write);
      if (!r) continue;
      if (b.addr % 4) this.red("gmalign", "a storage range read in the mirror of global memory does not start on 4 bytes: its words are read up to 3 bytes early");
      base[s.slot] = (r.off + b.addr - r.start) >>> 2;
    }
    for (let k = 0; k < Math.min(16, gi.pointers.length); k++) { const b = this.ssbo.get(st * 64 + 32 + k); if (b && b.addr && b.size) this.gmRange(b.addr, b.size, b.write); }
    if (g.gen !== this.gmGen) {
      if (this.gmLogUsed) this.gmOrdered(() => this.gmLogTake());    // the log's bits number the entries of the table that goes
      this.device.queue.writeBuffer(this.gmTable, 0, g.table()); this.gmGen = g.gen;
    }
    if (gi.log) this.gmLogUsed = true;
    this.ubo.set(uboKey(st, 20), { addr: 0, size: 0, need: 0, data: new Uint8Array(base.buffer) });
  }
  // Where the mirror holds guest [addr, addr + size), up to date, for a copy out of it (an indirect draw's record); null: it does not
  private gmSource(addr: number, size: number): { buf: GPU; off: number } | null {
    const r = this.gm?.find(addr, size);
    if (!r) return null;
    this.gmSync(r); r.used = this.flushNo;
    return { buf: this.gmBuf, off: r.off + addr - r.start };
  }
  private gmReadback(addr: number, size: number) {
    const r = this.gm?.find(addr, size);
    if (!r || !r.gpu) return;
    this.endPass();
    const a = addr - addr % 4, n = Math.ceil((addr + size - a) / 4) * 4, buf = this.newBuffer({ size: n, usage: 0x01 | 0x08 });
    this.encoder().copyBufferToBuffer(this.gmBuf, r.off + a - r.start, buf, 0, n);
    r.pending++; this.gmRead.set(r, this.flushNo);
    this.gmQueued.push({ buf, r, addr: a, size: n });
  }
  // The write log leaves for the CPU and starts again from zero (no pass is open)
  private gmLogTake() {
    this.gmLogUsed = false;
    const buf = this.newBuffer({ size: GM_LOG_BYTES, usage: 0x01 | 0x08 }), enc = this.encoder();
    enc.copyBufferToBuffer(this.gmLog, 0, buf, 0, GM_LOG_BYTES); enc.clearBuffer(this.gmLog);
    const ranges: GmRange[] = [];
    for (const r of this.gm!.ranges) ranges[r.index] = r;
    this.gmLogs.push({ buf, ranges, flush: this.flushNo });
  }
  private gmBeforeSubmit() {
    if (!this.gm) return;
    if (this.gmLogUsed) this.gmLogTake();
    for (const r of this.gmLate.splice(0)) if (this.gm.ranges.includes(r) && (this.gmRead.get(r) ?? 0) < this.flushNo) this.gmReadback(r.start, this.gmLen(r));
  }
  private gmFlush(gen: number) {
    const g = this.gm;
    if (!g) return;
    for (const q of this.gmQueued.splice(0)) this.readbacks.push(q.buf.mapAsync(1).then(() => {
      if (gen !== this.gen) return;
      const r = q.r, n = Math.min(q.size, this.memory.buffer.byteLength - q.addr), len = this.gmLen(r);
      // the guest wrote the range since the mirror last took it: its bytes win where the two differ, at the range's next use
      const same = this.hashOf(r.start, len) === r.hash;
      this.u8.set(new Uint8Array(q.buf.getMappedRange()).subarray(0, n), q.addr);
      q.buf.unmap(); this.kill(q.buf); this.stats.bufferReadbacks++; this.stats.gmemReadbacks++;
      if (--r.pending === 0) r.gpu = false;
      this.dropRange(q.addr, n);      // (only these bytes changed: the uploads elsewhere stay checked)
      r.hash = same ? this.hashOf(r.start, len) : NaN;
      // this runs between two execs, where the guest writes without telling: nothing hashed here may count as looked at in this epoch
      this.dropRange(r.start, len);
    }, (e: any) => { if (!this.lost && gen === this.gen) this.log(`[RED] read-back from the mirror of global memory failed: ${e?.message ?? e}`); }));
    for (const l of this.gmLogs.splice(0)) this.readbacks.push(l.buf.mapAsync(1).then(() => {
      if (gen !== this.gen) return;
      const w = new Uint32Array(l.buf.getMappedRange().slice(0)); l.buf.unmap(); this.kill(l.buf);
      for (let k = 0; k < w.length; k++) for (let m = w[k]; m; m &= m - 1) {
        const r = l.ranges[k * 32 + 31 - Math.clz32(m & -m)];
        if (!r || (this.gmRead.get(r) ?? 0) >= l.flush || this.gmLate.includes(r)) continue;
        r.gpu = true; this.gmLate.push(r); this.stats.gmemLogged++;
      }
    }, () => {}));
    for (const b of this.gmOld.splice(0)) this.kill(b);
    if (this.flushNo % 64 === 0) for (const r of [...g.ranges]) if (r.used < this.flushNo - 240 && !r.gpu && !r.pending) { g.drop(r); this.gmRead.delete(r); }
    g.settle();
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
  private uaSeen = new Map<number, UaSlot>();     // by address * 2^17 + bound size: the slot a range has in this submission
  // A slot outlives the moments guest memory may have changed (uaEpoch: H_MEM_DIRTY, a read-back landing): at its next use its bytes are compared with
  // the guest's and it is kept when they are the same. A block the host supplies (c1, the recorder's UBO_DATA) keeps its slot by the identity of its
  // bytes' array. Before, every such moment and every bind of a host block took a new slot: 28 MB of slots a frame for 3 MB of distinct blocks in a
  // 3D frame, written to the GPU, and a bind group for every pipeline in each of the 29 chunks they filled.
  private uaEpoch = 1;
  private uaData = new Map<Uint8Array, UaSlot>();
  private uaSame(s: UaSlot, addr: number, n: number): boolean {
    if (s.n !== n) return false;
    const m = this.u8, d = s.c.staging, o = s.off;
    let k = 0;
    if (addr % 4 === 0 && n >= 64) {
      const w = n >> 2, a = new Uint32Array(m.buffer, addr, w), b = new Uint32Array(d.buffer, d.byteOffset + o, w);
      for (let i = 0; i < w; i++) if (a[i] !== b[i]) return false;
      k = w << 2;
    }
    for (; k < n; k++) if (m[addr + k] !== d[o + k]) return false;
    return true;
  }
  private uaAlign = UA_ALIGN;
  private uaAlloc(size: number): UaSlot {
    let c = this.uaCur;
    if (!c || c.used + size > UA_CHUNK) {
      if (c) this.uaDone.push(c);
      c = this.uaCur = this.uaPool.pop() ?? { buf: this.newBuffer({ size: UA_CHUNK, usage: 0x08 | 0x40 }), staging: new Uint8Array(UA_CHUNK), used: 0 };
    }
    const off = c.used;
    c.used = (off + size + this.uaAlign - 1) & ~(this.uaAlign - 1);
    this.stats.uniformSlots++;      // (the caller fills it: its bytes, zero after them)
    return { c, off, size };
  }
  private uaWrite() {
    if (this.uaCur) { this.uaDone.push(this.uaCur); this.uaCur = null; }
    for (const c of this.uaDone) {
      if (c.used) { this.device.queue.writeBuffer(c.buf, 0, c.staging, 0, c.used); this.stats.uniformBytes += c.used; this.stats.uniformWrites++; }
      c.used = 0; this.uaPool.push(c);
    }
    this.uaDone = []; this.uaSeen.clear(); this.uaData.clear();
  }
  // The buffer, offset and size uniform binding i of stage st is bound with
  // A block the host supplies (Slot "host"): the shader's c1 from its reflection, the others as the recorder sent them (UBO_DATA). Each is at least the size the
  // shader declares, zero past what it was given
  private hostBlock(b: Slot) {
    const key = uboKey(b.st, b.i), want = Math.max(16, ((b.size ?? 0) + 15) & ~15);
    let u = this.ubo.get(key);
    if (b.i === 16) { const d = b.info?.c1Data ?? new Uint8Array(0); if (u?.data !== d) { u = { addr: 0, size: 0, need: 0, data: d }; this.ubo.set(key, u); } }   // c1 is the bound shader's own
    if (!u) { this.red("hostblock", "a shader reads a driver segment or push constants the recorder did not send: a zeroed block is bound"); u = { addr: 0, size: 0, need: 0, data: new Uint8Array(0) }; this.ubo.set(key, u); }
    if (u.data && u.data.length < want) { const d = new Uint8Array(want); d.set(u.data); u.data = d; if (b.i === 16 && b.info) b.info.c1Data = d; }
  }
  private uboSlot(st: number, i: number): { buf: GPU; off: number; size: number } {
    const u = this.ubo.get(uboKey(st, i)), max = this.limit("maxUniformBufferBindingSize", 65536);
    if (!this.uniformArena) {
      if (u?.data) { const b = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(u.data.length)))); this.device.queue.writeBuffer(b, 0, u.data); this.inUse.push(b); return { buf: b, off: 0, size: Math.min(b.size, (u.data.length + 15) & ~15) }; }
      const buf = u && this.upload(u.addr, u.size, 0);
      return buf ? { buf, off: this.upOff, size: Math.min(buf.size - this.upOff, (u!.size + 15) & ~15) } : { buf: this.zeroBuffer(), off: 0, size: 65536 };
    }
    const have = u ? (u.data ? u.data.length : u.size) : 0, size = Math.min(max, Math.max(16, ((u?.need || have) + 15) & ~15));
    if (u && !u.data && (this.gpuRanges.size || this.gm)) {
      const r = this.gpuRangeOver(u.addr, Math.min(u.size, size));
      if (r) {
        const off = r.off;
        if (off % this.uaAlign === 0 && off + size <= r.buf.size) return { buf: r.buf, off, size };
        this.red("ubogpu", "a uniform range lies in memory a compute pass wrote and is not aligned to 256 bytes: it is bound from guest memory, which has the old content until the read-back lands");
      }
    }
    const key = u ? (u.data ? -1 : u.addr * 131072 + Math.min(u.size, 131071)) : 0;
    let s = key >= 0 ? this.uaSeen.get(key) : this.uaData.get(u!.data!);
    const gn = key > 0 && u!.addr && u!.size ? Math.min(size, u!.size, Math.max(0, this.memory.buffer.byteLength - u!.addr)) : 0;      // the guest bytes a slot takes
    if (s && s.size >= size && key > 0 && s.ep !== this.uaEpoch) { if (this.uaSame(s, u!.addr, gn)) s.ep = this.uaEpoch; else s = undefined; }
    if (!s || s.size < size) {
      s = this.uaAlloc(size);
      let n = 0;
      if (u?.data) { n = Math.min(size, u.data.length); s.c.staging.set(n === u.data.length ? u.data : u.data.subarray(0, n), s.off); this.uaData.set(u.data, s); }
      else if (u && u.addr && u.size) {
        n = gn;
        if (n < Math.min(size, u.size)) this.red(`up${u.addr}`, `a draw binds memory outside the guest's (address 0x${u.addr.toString(16)} size ${u.size}): zeros are bound`);
        if (n <= 64) { const m = this.u8, d = s.c.staging; for (let k = 0, a = u.addr, o = s.off; k < n; k++) d[o + k] = m[a + k]; }
        else s.c.staging.set(this.u8.subarray(u.addr, u.addr + n), s.off);
      }
      if (n < size) s.c.staging.fill(0, s.off + n, s.off + size);
      s.n = n; s.ep = this.uaEpoch;
      if (key >= 0) this.uaSeen.set(key, s);
    }
    return { buf: s.c.buf, off: s.off, size };
  }

  // ---- encoder and passes ----
  private encoder(): GPU { return (this.enc ??= this.device.createCommandEncoder()); }
  private endPass() {
    if (this.pass) { this.pass.end(); this.pass = null; this.computePass = false; }
    this.drawSet = null; this.passDesc = null;
    if (this.passBlocks.length) { for (const b of this.passBlocks.splice(0)) this.blockCopy(b.t, b.level, b.layer, b.sc, true); }
  }
  // The block views of the open render pass (beginPass), and the copy between a compressed level and the texture that holds its blocks as texels
  private passBlocks: { t: Tex; sc: GPU; level: number; layer: number }[] = [];
  private blockCopy(t: Tex, level: number, layer: number, sc: GPU, toTexture: boolean) {
    const w = sc.width, h = sc.height, pitch = Math.ceil(w * t.fmt.bpb / 256) * 256, buf = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(pitch * h)))), enc = this.encoder();
    const lw = Math.ceil(Math.max(1, t.gpu.width >> level) / t.fmt.bw) * t.fmt.bw, lh = Math.ceil(Math.max(1, t.gpu.height >> level) / t.fmt.bh) * t.fmt.bh;
    const side = { texture: t.gpu, mipLevel: level, origin: { x: 0, y: 0, z: layer } }, lay = { buffer: buf, bytesPerRow: pitch, rowsPerImage: h };
    if (toTexture) { enc.copyTextureToBuffer({ texture: sc }, lay, { width: w, height: h }); enc.copyBufferToTexture(lay, side, { width: lw, height: lh }); }
    else { enc.copyTextureToBuffer(side, lay, { width: lw, height: lh }); enc.copyBufferToTexture(lay, { texture: sc }, { width: w, height: h }); }
    this.inUse.push(buf);
  }
  private doomed: GPU[] = [];      // textures of TEX_DESTROY, until the next submit
  private flush() {
    this.texEpoch++;
    this.endPass();
    this.gmBeforeSubmit();
    if (this.uniformArena) this.uaWrite();
    const stamps = this.segBeforeSubmit();
    if (this.enc) { this.device.queue.submit([this.enc.finish()]); this.enc = null; this.stats.submits++; }
    if (this.doomed.length) { for (const o of this.doomed.splice(0)) this.kill(o); if (this.groups.size > 2048) this.groups.clear(); }
    this.segAfterSubmit(stamps);
    const gen = this.gen;
    this.meshCtlAt = 0; for (const b of this.meshOld.splice(0)) this.kill(b);
    for (const q of this.meshSamples.splice(0)) this.readbacks.push(q.buf.mapAsync(1).then(() => {
      if (gen !== this.gen) return;
      const w = new Uint32Array(q.buf.getMappedRange().slice(0)); q.buf.unmap(); this.kill(q.buf);
      const line = `mesh draw ${q.n}: {count ${w[0]}, first ${w[1]}}${q.task ? `, tasks launched up to ${w[5]} mesh workgroups each` : ""}, ${w[9]} output slots drawn (${w[9] * w[20]} vertices)${q.indirect ? " (indirect: counts read on the GPU)" : ""}`;
      if (w[10]) this.log(`[RED] ${line}: cut to the ${w[16]} slots the output buffer holds, the rest are not drawn`); else this.log(line);
    }, () => {}));
    for (const q of this.queued.splice(0)) this.readbacks.push(q.buf.mapAsync(1).then(() => {
      if (gen !== this.gen) return;
      const src = new Uint8Array(q.buf.getMappedRange()), mem = this.u8;
      for (let z = 0; z < q.depth; z++) for (let y = 0; y < q.rows; y++) mem.set(src.subarray((z * q.rows + y) * q.srcRow, (z * q.rows + y) * q.srcRow + q.wb), q.dst + z * q.img + y * q.row);
      q.buf.unmap(); this.kill(q.buf); this.dropRange(q.dst, Math.max(0, q.depth - 1) * q.img + Math.max(0, q.rows - 1) * q.row + q.wb);
    }, (e: any) => { if (!this.lost && gen === this.gen) this.log(`[RED] CopyTextureToBuffer readback failed: ${e?.message ?? e}`); }));
    for (const q of this.queuedBufs.splice(0)) this.readbacks.push(q.buf.mapAsync(1).then(() => {
      if (gen !== this.gen) return;
      const r = q.range;
      this.u8.set(new Uint8Array(q.buf.getMappedRange()).subarray(0, r.size), r.addr);
      q.buf.unmap(); this.kill(q.buf); this.stats.bufferReadbacks++;
      // Guest memory now holds what the GPU wrote: later binds upload from it again
      if (--r.pending === 0 && this.gpuRanges.get(`${r.addr}:${r.size}`) === r) { this.gpuRanges.delete(`${r.addr}:${r.size}`); this.inUse.push(r.buf); }
      this.dropRange(r.addr, r.size);
    }, (e: any) => { if (!this.lost && gen === this.gen) this.log(`[RED] storage buffer readback failed: ${e?.message ?? e}`); }));
    this.gmFlush(gen);
    for (const b of this.inUse) { let l = this.pool.get(b.size); if (!l) this.pool.set(b.size, l = []); l.push(b); }
    this.inUse = []; this.epoch++; this.flushNo++; this.bindDirty = true; this.splitsLeft = 64;
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
  private u64(dv: DataView, p: number) { return dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296; }   // an address or a serial of the recorder: 8 bytes in every record, a number here

  private beginPass(dv: DataView, p: number) {
    const n = dv.getUint32(p + 8, true), flags = dv.getUint32(p + 12, true);
    const colorAttachments: any[] = [], colorFmt: (string | null)[] = [], targets: { name: string; serial: number; level: number; layer: number }[] = [];
    const blocks: { t: Tex; sc: GPU; level: number; layer: number }[] = [];
    let samples = 1;
    for (let i = 0; i < n; i++) {
      const o = p + 32 + i * 40, t = this.texture(this.u64(dv, o));
      if (!t) { colorAttachments.push(null); colorFmt.push(null); continue; }
      samples = t.gpu.sampleCount;
      const clear = dv.getUint32(o + 20, true) !== 0;
      // The recorder sends the texture's format, or its sRGB twin when a view asks for that (lower.ts rtFill)
      const vfmt = hostFormat(dv.getUint32(o + 16, true), this.caps), vf = vfmt?.tex, af = vf && vf === SRGB_TWIN[t.fmt.tex!] ? vf : t.fmt.tex!;
      // A view of a block-compressed texture as integer texels, one a block (lower.ts rtFill, fmt.ts fmtBlockView): WebGPU has no such view and cannot draw into a
      // compressed texture. The pass draws into a texture of the view's format kept with the level and layer (it takes the level's blocks first unless the pass
      // clears it), and the level takes its bytes when the pass ends: both through a buffer, the one way WebGPU copies between the two formats
      if (vf && t.fmt.bw > 1 && vfmt!.bw === 1 && vfmt!.bpb === t.fmt.bpb) {
        const level = Math.min(dv.getUint32(o + 8, true), t.gpu.mipLevelCount - 1), layer = dv.getUint32(o + 12, true), key = `${level}/${layer}/${vf}`;
        const w = Math.ceil(Math.max(1, t.gpu.width >> level) / t.fmt.bw), h = Math.ceil(Math.max(1, t.gpu.height >> level) / t.fmt.bh);
        let sc = (t.blockScratch ??= new Map()).get(key);
        const fresh = !sc;
        if (!sc) t.blockScratch.set(key, sc = this.newTexture({ size: { width: w, height: h }, format: vf, usage: 0x10 | 0x01 | 0x02 | 0x04 }, "a block view"));
        this.endPass();
        if (fresh && !clear) this.blockCopy(t, level, layer, sc, false);
        blocks.push({ t, sc, level, layer });
        colorAttachments.push({ view: sc.createView(), loadOp: clear ? "clear" : "load", storeOp: "store", clearValue: { r: dv.getFloat32(o + 24, true), g: dv.getFloat32(o + 28, true), b: dv.getFloat32(o + 32, true), a: dv.getFloat32(o + 36, true) } });
        colorFmt.push(vf); targets.push({ name: `color${i}`, serial: t.serial, level, layer });
        continue;
      }
      colorAttachments.push({ view: this.attachView(t, dv.getUint32(o + 8, true), dv.getUint32(o + 12, true), af), ...(t.gpu.dimension === "3d" ? { depthSlice: dv.getUint32(o + 12, true) } : {}), loadOp: clear ? "clear" : "load", storeOp: "store",
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
    this.pass = this.encoder().beginRenderPass(desc); this.passDesc = desc; this.passState = {}; this.passBlocks = blocks;
    this.passInfo = { colorFmt, depthFmt, samples, w: dv.getUint32(p + 24, true), h: dv.getUint32(p + 28, true), targets };
    this.cur = null; this.bindDirty = true; this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear();
    this.ownSlots = []; this.vconvKey = ""; this.vbSrc.clear();
    this.stats.passes++;
  }

  // ---- pipelines ----
  // The bind group layouts of a pipeline from its shaders' reflection, and the order of group 0's buffers. Uniform
  // buffers take dynamic offsets (the uniform arena) up to the device's limit; the ones beyond it are bound at fixed offsets
  private groupLayouts(stages: { info: ShaderInfo; st: number }[], fixup: boolean, drawParams = false): { layouts: GPU[]; g0: Slot[] } {
    const e0: any[] = [], g1: any[] = [], g0: Slot[] = [];
    let dynLeft = (this.uniformArena ? this.limit("maxDynamicUniformBuffersPerPipelineLayout", 8) : 0) - (drawParams ? 1 : 0);
    for (const { info: s, st } of stages) {
      const visibility = st === 0 ? 1 : st === 1 ? 2 : 4;
      for (const i of [...(s.ubos ?? []), ...(s.support ? [14] : [])].sort((a, b) => a - b)) {
        const dyn = dynLeft > 0; if (dyn) dynLeft--;
        e0.push({ binding: st * 16 + i, visibility, buffer: { type: "uniform", hasDynamicOffset: dyn } });
        g0.push({ binding: st * 16 + i, st, i, kind: "ubo", dyn, write: false });
      }
      for (const b of s.hostBlocks ?? []) {
        e0.push({ binding: hostBinding(st, b.k), visibility, buffer: { type: "uniform" } });
        g0.push({ binding: hostBinding(st, b.k), st, i: 16 + b.k, kind: "host", dyn: false, write: false, size: b.size, info: s });
      }
      for (const b of s.storage ?? []) {
        e0.push({ binding: 128 + st * 16 + b.slot, visibility, buffer: { type: b.write ? "storage" : "read-only-storage" } });
        g0.push({ binding: 128 + st * 16 + b.slot, st, i: b.slot, kind: "ssbo", dyn: false, write: !!b.write });
      }
      const nf = GfxHost.unfilteredSamplers(s);
      for (const t of s.textures ?? []) {
        const sampleType = t.depth ? "depth" : t.sampleType ?? "float";
        g1.push({ binding: st * 64 + t.slot * 2, visibility, texture: { sampleType, viewDimension: t.dim ?? "2d" } });
        if (t.sampler === undefined) g1.push({ binding: st * 64 + t.slot * 2 + 1, visibility, sampler: { type: t.depth ? "comparison" : sampleType === "float" && !nf.has(t.slot) ? "filtering" : "non-filtering" } });
      }
      for (const m of s.images ?? []) g1.push({ binding: 256 + st * 8 + m.slot, visibility, storageTexture: { access: m.access ?? "write-only", format: m.format, viewDimension: m.dim ?? "2d" } });
    }
    g0.sort((a, b) => a.binding - b.binding);
    const groups = [e0, g1];
    if (fixup || drawParams) groups.push([...(fixup ? [{ binding: 0, visibility: 1, buffer: { type: "uniform" } }] : []),
      ...(drawParams ? [{ binding: 2, visibility: 1, buffer: { type: "uniform", hasDynamicOffset: true } }] : [])]);
    return { g0, layouts: groups.map(entries => {
      const key = JSON.stringify(entries);
      let l = this.layouts.get(key);
      if (!l) { l = this.device.createBindGroupLayout({ entries }); this.layouts.set(key, l); }
      return l;
    }) };
  }
  // WebGPU's per-stage limits against what the shaders declare. A pipeline over a limit cannot exist on this device:
  // it fails here with the numbers (its draws are then skipped) instead of as a validation error with none
  private overLimits(id: number, stages: { info: ShaderInfo; st: number }[], fixup: boolean, drawParams = false): boolean {
    let over = false;
    const red = (who: string, n: number, what: string, max: number, limit: string, per: string) => {
      over = true;
      this.log(`[RED] pipeline ${id}: ${who} needs ${n} ${what}; this WebGPU device allows ${max}${per} (${limit}): ${n - max} over. The pipeline cannot be built, its draws are skipped`);
    };
    for (const { info: s, st } of stages) {
      const counts: [string, number, string, number][] = [
        ["uniform buffers", (s.ubos?.length ?? 0) + (s.support ? 1 : 0) + (s.hostBlocks?.length ?? 0) + (st === 0 && fixup ? 1 : 0) + (st === 0 && drawParams ? 1 : 0), "maxUniformBuffersPerShaderStage", 12],
        ["sampled textures", s.textures?.length ?? 0, "maxSampledTexturesPerShaderStage", 16], ["samplers", s.textures?.filter(t => t.sampler === undefined).length ?? 0, "maxSamplersPerShaderStage", 16],
        ["storage buffers", (s.storage?.length ?? 0) + (s.stage === "mesh" ? (s.mesh?.task ? 3 : 2) : s.stage === "task" ? 2 : 0), "maxStorageBuffersPerShaderStage", 8], ["storage textures", s.images?.length ?? 0, "maxStorageTexturesPerShaderStage", 4]];
      if (st === 0) counts.push(["vertex attributes", s.attributes?.length ?? 0, "maxVertexAttributes", 16]);
      const who = `the ${["vertex", "fragment", "compute"][st]} shader ${this.shaders.find(x => x?.info === s)?.key ?? ""}`;
      for (const [what, n, limit, fallback] of counts) { const max = this.limit(limit, fallback); if (n > max) red(who, n, what, max, limit, " a stage"); }
    }
    // bind groups: 0 buffers, 1 textures and images, 2 the position fix-up and the draw parameters
    const groups = fixup || drawParams ? 3 : 2, maxGroups = this.limit("maxBindGroups", 4);
    if (groups > maxGroups) red("its layout", groups, "bind groups", maxGroups, "maxBindGroups", "");
    return over;
  }
  // The slots whose sampler binding must be non-filtering: WebGPU refuses a filtering sampler used with an unfilterable-float texture, and a texture may
  // sample through another slot's sampler (ShaderInfo.textures sampler: a number, spv.ts shareSamplers). Every texture that shares such a sampler is then
  // sampled unfiltered (nearest): the price of one sampler for several textures when one of them is depth or of a format the device does not filter
  private static unfilteredSamplers(s: ShaderInfo, also?: (slot: number) => boolean): Set<number> {
    const nf = new Set<number>();
    for (const t of s.textures ?? []) if (!t.depth && t.sampler !== false && (t.sampleType === "unfilterable-float" || also?.(t.slot))) nf.add(typeof t.sampler === "number" ? t.sampler : t.slot);
    return nf;
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
      if (cs.mesh) layouts.push(this.layoutOf([0, 1, 2].filter(b => b !== (cs.mesh!.kind === "ts" ? 1 : cs.mesh!.task ? -1 : 2))
        .map(b => ({ binding: b, visibility: 4, buffer: { type: b === 2 && cs.mesh!.kind === "ms" ? "read-only-storage" : "storage" } }))));
      pipe.layouts = layouts; pipe.g0 = g0;
      pipe.desc = { layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module: this.module(csId), entryPoint: cs.entry } };
      this.device.createComputePipelineAsync(pipe.desc).then((p: GPU) => { if (gen !== this.gen || this.pipes.get(id) !== pipe) return; pipe.gpu ??= p; this.stats.pipelinesAsync++; this.x.gfx_pipeline_done(id, 1); },
        (e: any) => { if (gen !== this.gen || this.pipes.get(id) !== pipe || !pipe.desc) return; pipe.desc = null; pipe.gpu = undefined; this.stats.pipelinesFailed++; if (!this.lost) this.log(`[RED] compute pipeline ${id} did not build: ${e?.message ?? e}`); this.x.gfx_pipeline_done(id, 0); });
      return;
    }
    const vsId = dv.getUint16(k + PK.vs, true), fsId = dv.getUint16(k + PK.fs, true), vs = this.shaders[vsId].info, fs = this.shaders[fsId].info, flags = dv.getUint8(k + PK.flags);
    const mesh = vs.stage === "mesh" ? vs.mesh! : null;     // a mesh draw: the vertex shader is made from the mesh shader's outputs (meshVertexModule)
    const buffers: any[] = [], classes: Record<number, VinClass> = {}, consts: number[] = [], vconv: NonNullable<Pipe["vconv"]> = [];
    for (let loc = 0, m = dv.getUint32(k + PK.attrMask, true); m; loc++, m >>>= 1) {
      if (!(m & 1)) continue;
      const a = dv.getUint32(k + PK.attr + loc * 4, true), fmt = a & 0xff, stream = a >>> 27, vf = NVN_FORMATS[fmt]?.vtx;
      classes[loc] = CLASSES[Number((dv.getBigUint64(k + PK.vin, true) >> BigInt(loc * 2)) & 3n)] ?? "float";
      if (!fmt) { consts.push(loc); continue; }      // the game's state has no such attribute (lower.ts fillKey): the constant (0, 0, 0, 1)
      const divisor = dv.getUint32(k + PK.stream + stream * 8 + 4, true), stride = dv.getUint32(k + PK.stream + stream * 8, true);
      if (!vf && VERTEX_CONV[fmt]) {
        // the stream's own buffer is still bound at its slot (lower.ts sends it), so the attribute's source is known at the draw; the divisor is the stream's
        buffers[stream] ??= { arrayStride: stride, stepMode: divisor ? "instance" : "vertex", attributes: [] };
        vconv.push({ loc, stream, offset: (a >>> 8) & 0x7ffff, stride, fmt, slot: -1 }); continue;
      }
      if (!vf) { this.red(`vf${fmt}`, `vertex attribute format 0x${fmt.toString(16)} has no WebGPU vertex format: pipeline ${id} will fail`); }
      buffers[stream] ??= { arrayStride: stride, stepMode: divisor ? "instance" : "vertex", attributes: [] };
      buffers[stream].attributes.push({ shaderLocation: loc, offset: (a >>> 8) & 0x7ffff, format: vf ?? "float32" });
    }
    // The replayer's own vertex buffers take the lowest slots the game's streams leave free
    let free = 0, constSlot: number | undefined;
    const take = () => { while (buffers[free]) free++; return free; };
    if (consts.length) {
      // one 16-byte element for every vertex and instance (arrayStride 0): (0, 0, 0, 1) as floats at 0, as signed integers at 16, as unsigned at 32
      constSlot = take();
      buffers[constSlot] = { arrayStride: 0, stepMode: "instance", attributes: consts.map(loc => ({ shaderLocation: loc, offset: classes[loc] === "sint" ? 16 : classes[loc] === "uint" ? 32 : 0, format: classes[loc] === "sint" ? "sint32x4" : classes[loc] === "uint" ? "uint32x4" : "float32x4" })) };
    }
    for (const v of vconv) {
      v.slot = take();
      buffers[v.slot] = { arrayStride: v.stride ? VERTEX_CONV[v.fmt].bytes : 0, stepMode: buffers[v.stream].stepMode, attributes: [{ shaderLocation: v.loc, offset: 0, format: VERTEX_CONV[v.fmt].vtx }] };
    }
    if (buffers.length > this.limit("maxVertexBuffers", 8)) this.red(`vbslots${id}`, `pipeline ${id} needs ${buffers.length} vertex buffer slots (${consts.length ? "one for attributes the game's state lacks, " : ""}${vconv.length} for converted formats); this WebGPU device allows ${this.limit("maxVertexBuffers", 8)} (maxVertexBuffers): it will fail`);
    for (let i = 0; i < buffers.length; i++) buffers[i] ??= null;
    const prim = dv.getUint8(k + PK.prim), itype = dv.getUint8(k + PK.itype), cull = dv.getUint8(k + PK.cull);
    const primitive: any = { topology: mesh ? TOPOLOGY_OF[mesh.verts!] : TOPOLOGY[prim], cullMode: cull === 1 ? "front" : cull === 2 ? "back" : "none", frontFace: dv.getUint8(k + PK.front) ? "ccw" : "cw" };
    if (itype) primitive.stripIndexFormat = itype === 3 ? "uint32" : "uint16";
    if (flags & 1) { if (this.device.features?.has?.("depth-clip-control")) primitive.unclippedDepth = true; else this.red("clamp", "depth clamp needs the WebGPU feature depth-clip-control, which this device lacks: depth is clipped"); }
    const ncolor = dv.getUint8(k + PK.ncolor), chmask = dv.getUint32(k + PK.chmask, true), blendEn = dv.getUint8(k + PK.blendEn), written = new Set(fs.outputs ?? []);
    const targets: any[] = [], outClasses: Record<number, VinClass> = {};
    for (let i = 0; i < ncolor; i++) {
      const f = hostFormat(dv.getUint8(k + PK.colorFmt + i), this.caps);
      if (!f?.tex) { targets.push(null); continue; }
      if (written.has(i) && f.kind !== "depth") outClasses[i] = f.kind;
      const nib = (chmask >>> (4 * i)) & 15, t: any = { format: f.tex, writeMask: written.has(i) ? nib : 0 };
      if ((blendEn >> i) & 1) {
        const b = dv.getBigUint64(k + PK.blend + i * 8, true), fld = (s: number, w: number) => Number((b >> BigInt(s)) & ((1n << BigInt(w)) - 1n));
        const comp = (eq: number, src: number, dst: number) => eq >= 4 ? { operation: BLEND_EQ[eq], srcFactor: "one", dstFactor: "one" } : { operation: BLEND_EQ[eq] ?? "add", srcFactor: BLEND_FUNC[src] ?? "one", dstFactor: BLEND_FUNC[dst] ?? "zero" };
        t.blend = { color: comp(fld(31, 3), fld(3, 7), fld(10, 7)), alpha: comp(fld(34, 3), fld(17, 7), fld(24, 7)) };
      }
      targets.push(t);
    }
    const stages = mesh ? [{ info: fs, st: 1 }] : [{ info: vs, st: 0 }, { info: fs, st: 1 }];
    const drawParams = !mesh && !!vs.drawParams;
    const pipe: Pipe = { id, compute: false, desc: null, stages: mesh ? [fsId] : [vsId, fsId], key: k, layouts: [], g0: [], gen, mesh: !!mesh, drawParams, vsFixup: !mesh && !!vs.fixup, ...(mesh ? {} : { constSlot, vconv: vconv.length ? vconv : undefined }) };
    this.pipes.set(id, pipe);
    if (this.overLimits(id, stages, !mesh && !!vs.fixup, drawParams)) { this.pipeFailed(id); return; }
    const { layouts, g0 } = this.groupLayouts(stages, !mesh && !!vs.fixup, drawParams);
    if (mesh) layouts.push(this.layoutOf([{ binding: 0, visibility: 1, buffer: { type: "uniform" } }, { binding: 1, visibility: 1, buffer: { type: "read-only-storage" } }]));
    pipe.layouts = layouts; pipe.g0 = g0; pipe.dynOnly = g0.length > 0 && g0.every(s => s.dyn);
    // Vertex inputs of another class than the shader declares (flag 2, decided by the recorder): the module must be a variant
    const vmod = mesh ? this.meshVertexModule(id, vsId, fsId) : flags & 2 ? this.variantModule(vsId, classes) : this.interpModule(vsId, fsId) ?? this.module(vsId);
    if (!vmod) { this.pipeFailed(id); return; }
    const desc: any = {
      layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: { module: vmod, entryPoint: mesh ? "main" : vs.entry, buffers: mesh ? [] : buffers }, primitive,
      multisample: { count: dv.getUint8(k + PK.samples) || 1, alphaToCoverageEnabled: dv.getUint8(k + PK.a2c) !== 0 && (dv.getUint8(k + PK.samples) || 1) > 1 },
      fragment: { module: this.fragModule(mesh ? -1 : vsId, fsId, outClasses), entryPoint: fs.entry, targets },
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
      if ((dv.getUint8(k + PK.offsetEn) & 4) && df.kind === "depth" && (mesh ? mesh.verts === 3 : prim >= 4)) {
        d.depthBias = Math.round(dv.getFloat32(k + PK.offset + 4, true)); d.depthBiasSlopeScale = dv.getFloat32(k + PK.offset, true); d.depthBiasClamp = dv.getFloat32(k + PK.offset + 8, true);
      }
      desc.depthStencil = d;
    }
    pipe.desc = desc;
    // Asynchronously, so a pipeline first needed later is ready by then; the draw that needs it now builds it itself (usePipeline)
    this.device.createRenderPipelineAsync(desc).then((p: GPU) => { if (gen !== this.gen || this.pipes.get(id) !== pipe) return; pipe.gpu ??= p; this.stats.pipelinesAsync++; this.x.gfx_pipeline_done(id, 1); },
      (e: any) => { if (gen !== this.gen || this.pipes.get(id) !== pipe || !pipe.desc) return; pipe.desc = null; pipe.gpu = undefined; this.stats.pipelinesFailed++; if (!this.lost) this.log(`[RED] pipeline ${id} did not build: ${e?.message ?? e}`); this.x.gfx_pipeline_done(id, 0); });
  }
  // The encoder is submitted where it stands and the open pass goes on in a new one (a render pass on the same attachments, loading what was drawn)
  private splitsLeft = 64;      // a submission: at most so many (flush() fills it up again)
  private splitEncoder() {
    const open = !!this.pass, render = !this.computePass, d = this.passDesc, st = this.passState, blocks = this.passBlocks;
    if (open) { this.passBlocks = []; this.pass.end(); this.pass = null; }
    // not flush(): the submission's segment (counter reports, time stamps), its upload epoch and its fences stay as they are; only the commands go out
    if (this.uniformArena) this.uaWrite();
    if (this.enc) { this.device.queue.submit([this.enc.finish()]); this.enc = null; this.stats.submits++; }
    if (open && render) { this.passDesc = d; this.passState = st; this.reopenRenderPass(); this.passBlocks = blocks; }
    else if (open) { this.pass = this.encoder().beginComputePass(); this.computePass = true; }
    this.bindDirty = true;
  }
  private usePipeline(id: number): boolean {
    const pipe = this.pipes.get(id);
    if (!pipe) { this.red(`nopipe${id}`, `host stream binds pipeline ${id}, which was never created`); this.cur = null; return false; }
    if (!pipe.gpu) {
      if (!pipe.desc) { this.cur = null; return false; }      // it cannot be built (over a limit, no shader variant): its draws are skipped
      // Built now, for this draw. Whether WebGPU takes it is known only later (an error scope answers asynchronously), and an invalid pipeline makes the
      // command buffer it is set in invalid: what was encoded before goes out on its own first, so a refusal costs the rest of this submission and not
      // all of it; when the answer is a refusal the pipeline is dropped, said in red with the reason and reported to the recorder, which stops sending its draws
      const plain = !pipe.mesh && (pipe.compute ? this.shaders[pipe.stages[0]]?.info.stage === "compute" : true), scoped = typeof this.device.pushErrorScope === "function";
      if (plain && this.enc && this.splitsLeft > 0) { this.splitsLeft--; this.splitEncoder(); }
      if (scoped) this.device.pushErrorScope("validation");
      const g = pipe.gpu = pipe.compute ? this.device.createComputePipeline(pipe.desc) : this.device.createRenderPipeline(pipe.desc); this.stats.pipelinesSync++;
      if (scoped) { const gen = this.gen; Promise.resolve(this.device.popErrorScope()).then((e: any) => {
        if (!e || gen !== this.gen || this.pipes.get(id) !== pipe) return;
        if (pipe.gpu === g) pipe.gpu = undefined;
        if (!pipe.desc) return;       // the asynchronous request said so already
        pipe.desc = null; this.stats.pipelinesFailed++;
        this.log(`[RED] ${pipe.compute ? "compute " : ""}pipeline ${id} did not build: ${String(e.message ?? e).split("\n")[0]} (it was built for a draw: what the submission encoded after that draw is lost with it)`);
        this.x.gfx_pipeline_done(id, 0);
      }, () => {}); }
    }
    this.cur = pipe; this.pass.setPipeline(pipe.gpu); this.bindDirty = true;
    if (!pipe.compute && (this.ownSlots.length || pipe.constSlot !== undefined || pipe.vconv)) this.ownBuffers(pipe);
    return true;
  }
  // The vertex buffer slots the replayer fills itself for the current pipeline (Pipe.constSlot, Pipe.vconv). A slot the pipeline before used that way gets
  // back the buffer the stream bound there, which the recorder does not send again
  private ownSlots: number[] = [];
  private constBuf: GPU = null;
  private ownBuffers(pipe: Pipe) {
    const mine = [...(pipe.constSlot !== undefined ? [pipe.constSlot] : []), ...(pipe.vconv ?? []).map(v => v.slot)];
    for (const slot of this.ownSlots) { const vb = mine.includes(slot) ? undefined : this.passState.vb?.get(slot); if (vb) this.pass.setVertexBuffer(slot, vb[0], vb[1]); }
    this.ownSlots = mine; this.vconvKey = "";
    if (pipe.constSlot !== undefined) {
      if (!this.constBuf) {
        this.constBuf = this.newBuffer({ size: 64, usage: 0x20 | 0x08 });
        const d = new DataView(new ArrayBuffer(64));
        d.setFloat32(12, 1, true); d.setInt32(28, 1, true); d.setUint32(44, 1, true);
        this.device.queue.writeBuffer(this.constBuf, 0, d.buffer);
      }
      this.pass.setVertexBuffer(pipe.constSlot, this.constBuf);
    }
  }
  // Attributes of a format WebGPU has no vertex format for (gfx_formats.ts VERTEX_CONV): the elements of the stream's bound range, converted, in a buffer
  // of their own, kept by the range and what was converted and made again when the range's bytes change (hashed once an epoch, as upload())
  private vbSrc = new Map<number, [number, number]>();
  private vconvKey = "";
  private vconvBufs = new Map<string, { buf: GPU; hash: number; checked: number; addr: number; size: number }>();
  private vertexConverted(c: Pipe) {
    const now = `${c.id}:${this.epoch}`;
    if (this.vconvKey === now) return;
    for (const v of c.vconv!) {
      const src = this.vbSrc.get(v.stream);
      if (!src) continue;
      const [addr, size] = src, count = size < v.offset + 4 ? 0 : v.stride ? Math.floor((size - v.offset - 4) / v.stride) + 1 : 1;
      if (!count || !addr || addr + size > this.memory.buffer.byteLength) continue;
      const key = `${addr}:${size}:${v.offset}:${v.stride}:${v.fmt}`;
      let e = this.vconvBufs.get(key);
      if (!e || e.checked !== this.epoch) {
        const hash = this.hashOf(addr, size);
        this.stats.hashes++;
        if (e && e.hash === hash) e.checked = this.epoch;
        else {
          const data = convertVertices(v.fmt, new DataView(this.memory.buffer, addr, size), v.offset, v.stride, count);
          const buf = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(data.byteLength))));
          this.device.queue.writeBuffer(buf, 0, data);
          this.stats.uploads++; this.stats.uploadBytes += data.byteLength;
          if (e) this.inUse.push(e.buf);
          else if (this.vconvBufs.size >= 256) { for (const o of this.vconvBufs.values()) this.inUse.push(o.buf); this.vconvBufs.clear(); }
          this.vconvBufs.set(key, e = { buf, hash, checked: this.epoch, addr, size });
        }
      }
      this.pass.setVertexBuffer(v.slot, e.buf);
    }
    this.vconvKey = now;
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
  // (asked for every sampler of every draw: the sampler made for an index is kept with the 41 bytes of the table it was made from, compared before it is used again)
  private samplerAt = new Map<number, { bytes: Uint8Array; s: GPU }>();
  private sampler(index: number, compare: boolean, filtering = true): GPU {
    const p = Number(this.x.gfx_sampler_table()) + index * 48, u8 = this.u8, ck = index * 4 + (compare ? 2 : 0) + (filtering ? 1 : 0), have = this.samplerAt.get(ck);
    if (have) { const b = have.bytes; let i = 0; while (i < 41 && b[i] === u8[p + i]) i++; if (i === 41) return have.s; }
    const dv = this.dv, registered = index > 0 && dv.getUint8(p + 40) !== 0;
    const key = (registered ? Array.from(this.u8.subarray(p, p + 40)).join(",") : "default") + (compare ? "c" : "") + (filtering ? "" : "n");
    let s = this.samplers.get(key);
    if (s) { this.samplerAt.set(ck, { bytes: u8.slice(p, p + 41), s }); return s; }
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
    this.samplerAt.set(ck, { bytes: u8.slice(p, p + 41), s });
    return s;
  }
  // The bind groups of the current pipeline (render or compute) from what the stream bound
  private bind() {
    this.imgBlits.length = 0;
    const c = this.cur!, layouts = c.layouts, e0: any[] = [], offs: number[] = [], g1: any[] = [];
    const wbufs = new Set<GPU>(), robind: number[] = [], ubind: number[] = [], dynAt = new Map<number, number>();
    // the mirror of global memory first: it may close and open the pass again (a copy into the mirror that must come after what is encoded)
    this.gmWriting = false;
    for (const sid of c.stages) { const s = this.shaders[sid].info; if (s.gmem) this.gmPrepare(s, s.stage === "vertex" ? 0 : s.stage === "fragment" ? 1 : 2); }
    for (const b of c.g0) {
      if (b.kind === "ubo" || b.kind === "host") {
        if (b.kind === "host") this.hostBlock(b);
        const r = this.uboSlot(b.st, b.i);
        ubind.push(e0.length);
        if (b.dyn) { dynAt.set(e0.length, offs.length); e0.push({ binding: b.binding, resource: { buffer: r.buf, offset: 0, size: r.size } }); offs.push(r.off); }
        else e0.push({ binding: b.binding, resource: { buffer: r.buf, offset: r.off, size: r.size } });
      } else {
        // slots 32..34: the mirror of global memory, its range table and the write log (gmPrepare has brought them up to date)
        if (b.i >= 32) { const buf = b.i === 32 ? this.gmBuf : b.i === 33 ? this.gmTable : this.gmLog; e0.push({ binding: b.binding, resource: { buffer: buf, offset: 0, size: buf.size } }); continue; }
        const s = this.ssbo.get(b.st * 64 + b.i);
        const r = s && this.storageBuffer(s.addr, s.size, b.write);
        if (!r) { this.red("nossbo", "a draw or dispatch uses a storage buffer slot with nothing (or nothing valid) bound: a zeroed buffer is bound"); e0.push({ binding: b.binding, resource: { buffer: this.scratchStorage(), offset: 0, size: 65536 } }); continue; }
        if (r.off % 256) this.red("ssboalign", "a storage range inside memory a compute pass wrote is not aligned to 256 bytes: WebGPU cannot bind it at that offset");
        if (b.write) wbufs.add(r.buf); else robind.push(e0.length);
        e0.push({ binding: b.binding, resource: { buffer: r.buf, offset: r.off, size: r.size } });
      }
    }
    this.gmWriting = false;
    // WebGPU refuses a buffer that one dispatch or draw has as writable storage and as anything else (the whole command buffer is then invalid). A
    // game's compute stage may read one range and write another of memory that lives in one GPU buffer here: what it only reads is bound as a copy
    // made just before (in a compute pass the pass is closed for the copy and opened again)
    if (wbufs.size && ubind.some(i => wbufs.has(e0[i].resource.buffer))) for (const i of ubind) robind.push(i);   // a uniform block in a buffer the draw also writes: copied as well
    if (wbufs.size && robind.some(i => wbufs.has(e0[i].resource.buffer))) {
      if (!this.computePass && !this.passDesc) this.red("ssboalias", "a draw reads and writes storage in one GPU buffer: WebGPU refuses it, and this render pass cannot be opened again for a copy");
      else {
        const render = !this.computePass;
        this.pass.end();
        for (const i of robind) {
          const res = e0[i].resource;
          if (!wbufs.has(res.buffer)) continue;
          const n = Math.max(4, down4(res.size + 3)), copy = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(n)))), dk = dynAt.get(i);
          this.encoder().copyBufferToBuffer(res.buffer, dk === undefined ? res.offset : offs[dk], copy, 0, n);
          this.inUse.push(copy); this.stats.ssboCopies++;
          if (dk !== undefined) offs[dk] = 0;
          e0[i] = { binding: e0[i].binding, resource: { buffer: copy, offset: 0, size: res.size } };
        }
        if (render) this.reopenRenderPass(); else { this.pass = this.encoder().beginComputePass(); this.computePass = true; }
        this.pass.setPipeline(c.gpu);
      }
    }
    let ivar: ImageFormatVar[] | undefined;   // storage images bound with another format than their shader declares
    let tvar: TexVar[] | undefined;           // texture slots declared `float` whose texture is depth or of a format the device does not filter
    const standIns: StandIn[] = [];
    const tg = this.tex.gen + this.img.gen + this.texEpoch, g1Kept = !c.compute && c.g1At === tg ? c.g1 : undefined;      // nothing a texture slot holds has changed since this pipeline's last draw
    for (const sid of g1Kept ? NO_STAGES : c.stages) {
      const s = this.shaders[sid].info, st = s.stage === "vertex" ? 0 : s.stage === "fragment" ? 1 : 2;
      const unf = new Set<number>(), samps: { t: NonNullable<ShaderInfo["textures"]>[number]; samp: number; filtering: boolean }[] = [];
      for (const t of s.textures ?? []) {
        const b = this.tex.get(st * 64 + t.slot), tx = b && b.serial ? this.texture(b.serial) : undefined;
        const src = tx && (b!.snap && tx.snap ? tx.snap : tx.gpu), dim = t.dim ?? "2d", want = t.depth ? "depth" : t.sampleType ?? "float";
        let filtering = want === "depth" || want === "float", v: GPU = null;
        if (tx) {
          // what a shader gets from the view: the stencil aspect of a depth-stencil texture is unsigned integers, depth is depth or unfiltered floats
          const have = tx.fmt.kind === "depth" && tx.fmt.stencil && b!.view && (b!.view[0] & 0x20) && (b!.view[0] >> 6) === 1 ? "uint" : tx.fmt.kind;
          let why = "";
          if (tx.gpu.sampleCount > 1) why = "is multisampled";
          else if (want === "depth" ? have !== "depth" : want === "sint" || want === "uint" ? have !== want : have !== "float" && have !== "depth") why = `holds ${have} texels`;
          else if (!(v = this.view(tx, src, b!.view, dim, false, true))) why = `is a ${tx.gpu.dimension === "3d" ? "3D texture" : `2D texture of ${tx.gpu.depthOrArrayLayers} layer${tx.gpu.depthOrArrayLayers > 1 ? "s" : ""}`}, which has no ${dim} view`;
          else if (want === "float" && (have === "depth" || this.unfilterable.has(tx.fmt.tex!))) { (tvar ??= []).push({ sid, st, slot: t.slot }); filtering = false; unf.add(t.slot); }
          // a 2D texture on a 3D or cube slot (a game's placeholder texture stands in every slot it leaves unused): sampled through a copy of that shape
          if (!v && !why.startsWith("holds") && tx.gpu.sampleCount === 1) { v = this.reshaped(tx, dim); if (v) { this.red(`texshape${sid}.${t.slot}`, `texture slot ${t.slot} of the ${s.stage} shader ${this.shaders[sid].key} is declared ${dim}; the texture bound there (tex#${tx.serial} ${tx.fmt.tex} ${tx.gpu.width}x${tx.gpu.height}) is 2D: it is sampled through a ${dim} copy of its first level`); if (want === "float" && this.unfilterable.has(tx.fmt.tex!)) { (tvar ??= []).push({ sid, st, slot: t.slot }); filtering = false; unf.add(t.slot); } } }
          if (!v) this.red(`texfit${sid}.${t.slot}`, `texture slot ${t.slot} of the ${s.stage} shader ${this.shaders[sid].key} is declared ${dim}, ${want}; the texture bound there (tex#${tx.serial} ${tx.fmt.tex} ${tx.gpu.width}x${tx.gpu.height}) ${why}: a blank texture is sampled instead`);
        }
        g1.push({ binding: st * 64 + t.slot * 2, resource: v ?? this.dummyView(dim, want === "depth" || want === "sint" || want === "uint" ? want : "float") });
        if (t.sampler === undefined) samps.push({ t, samp: b ? b.samp : 0, filtering });
      }
      // a sampler that an unfiltered texture samples through (its own slot's or the one it shares) is a non-filtering one, as the layout has it
      const nf = GfxHost.unfilteredSamplers(s, slot => unf.has(slot));
      for (const x of samps) g1.push({ binding: st * 64 + x.t.slot * 2 + 1, resource: this.sampler(x.samp, !!x.t.depth, x.filtering && !nf.has(x.t.slot)) });
      for (const m of s.images ?? []) {
        const b = this.img.get(st * 8 + m.slot), tx = b && b.serial ? this.texture(b.serial) : undefined;
        // A texture WebGPU cannot bind as this storage image (its format is none a device stores to, or not one a shader may read and write): the dispatch
        // works on a stand-in of the class's 16-bit RGBA format, filled from the texture before it and drawn back into the texture after it (imgFlush)
        const access = m.access ?? "write-only", cls = m.type ?? formatClass(m.format);
        const direct = !!tx && !!(tx.gpu.usage & 0x08) && (access !== "read-write" || this.storeRW.has(tx.fmt.tex!));
        let whyNot = "";
        if (tx && !direct) {
          // A shader that names no format for an image it only stores to hands over one 32-bit word a texel (src/shaders/spv.ts placeImage). Into an RGB9E5 texture
          // that word IS the texel: the game's shader packs the shared-exponent format itself (area3.gfxcap: the pass before the upscaler; taken as a float colour
          // the word packed to 0 and the frame stayed black). Its stand-in is r32uint, whose words are copied into the texture as they are
          const bits = !!m.bound && tx.fmt.tex === "rgb9e5ufloat" && access === "write-only" && (c.compute || st === 1);
          const sf = bits ? "r32uint" : cls === "float" ? "rgba16float" : cls === "uint" ? "rgba16uint" : "rgba16sint";
          const lv = b!.view && (b!.view[0] & 1) ? b!.view[2] : 0, ly = b!.view && (b!.view[0] & 2) ? b!.view[6] | b!.view[7] << 8 : 0;
          whyNot = !this.computePass ? "a draw, where the replayer has no stand-in" : tx.fmt.kind === "depth" || tx.fmt.stencil || (!(tx.gpu.usage & 0x10) && tx.fmt.tex !== "rgb9e5ufloat") ? "the format cannot be drawn into either, so a stand-in could not be copied back"
            : formatClass(tx.fmt.tex!) !== cls ? `the shader stores ${cls} texels` : tx.gpu.dimension === "3d" || (m.dim ?? "2d") !== "2d" ? "a 3D or array image has no stand-in" : tx.gpu.sampleCount > 1 ? "multisampled"
            : lv >= tx.gpu.mipLevelCount || ly >= tx.gpu.depthOrArrayLayers ? "the view names a level or layer the texture lacks" : access === "read-write" && !this.storeRW.has(sf) ? `the shader reads and writes it, and this device has no read-write ${sf} storage (texture-formats-tier2)` : "";
          if (!whyNot) {
            const key = `${lv}/${ly}/${sf}`;
            let sc = (tx.imgScratch ??= new Map()).get(key);
            if (!sc) tx.imgScratch.set(key, sc = this.newTexture({ size: { width: Math.max(1, tx.gpu.width >> lv), height: Math.max(1, tx.gpu.height >> lv) }, format: sf, usage: 0x08 | 0x04 | 0x10 | (bits ? 0x01 : 0) }, "a storage image stand-in"));
            if (m.format !== sf) (ivar ??= []).push({ sid, st, slot: m.slot, format: sf });
            g1.push({ binding: 256 + st * 8 + m.slot, resource: sc.createView() });
            if (!standIns.some(x => x.sc === sc)) standIns.push({ t: tx, sc, lv, ly, cls, bits });
            continue;
          }
        }
        if (!tx || !direct) { this.red(`noimg${m.slot}${tx?.fmt.tex ?? ""}${whyNot}`, `a dispatch or draw uses image slot ${m.slot}, where ${tx ? `a ${tx.fmt.tex} texture is bound, which WebGPU cannot bind as a ${access} storage image${SRGB_TWIN[tx.fmt.tex!] && STORAGE_FORMATS.has(SRGB_TWIN[tx.fmt.tex!]) ? ` (an sRGB format: the texture would have to be created as ${SRGB_TWIN[tx.fmt.tex!]} and viewed as sRGB everywhere else)` : ""}${whyNot ? ` (no stand-in: ${whyNot})` : ""}` : "no live texture is bound"}: it is skipped`); return false; }
        const f = tx.fmt.tex!;
        if (f !== m.format) {
          if (formatClass(f) !== (m.type ?? formatClass(m.format)) && !(m.bound && (c.compute || st === 1))) { this.red(`imgclass${m.slot}${f}`, `a dispatch or draw uses image slot ${m.slot} as a ${m.type ?? formatClass(m.format)} image (the shader ${this.shaders[sid].key} declares ${m.bound ? "no format" : m.format}), and a ${f} texture is bound: the shader would have to be translated again for ${formatClass(f)} texels; it is skipped`); return false; }
          (ivar ??= []).push({ sid, st, slot: m.slot, format: f });
        }
        const iview = this.view(tx, tx.gpu, b!.view, m.dim ?? (tx.gpu.dimension === "3d" ? "3d" : "2d"), true);
        if (!iview) { this.red(`imgfit${sid}.${m.slot}`, `image slot ${m.slot} of the shader ${this.shaders[sid].key} is declared ${m.dim ?? "2d"}, and tex#${tx.serial} (${tx.gpu.dimension}, ${tx.gpu.depthOrArrayLayers} deep or layers) has no such view: the dispatch or draw is skipped`); return false; }
        g1.push({ binding: 256 + st * 8 + m.slot, resource: iview });
      }
    }
    const iv = ivar || tvar ? this.imagePipe(c, ivar ?? [], tvar) : null;
    if ((ivar || tvar) && !iv) return false;
    if (standIns.length) {
      // the stand-ins take what their textures hold (the dispatch may read it, or write only part of it); no pass may be open for that
      this.pass.end();
      for (const x of standIns) if (!x.bits) this.copyTexels(this.attachView(x.t, x.lv, x.ly), x.sc.createView(), x.sc.format, x.cls);   // (words: write-only, the dispatch writes them all or the rest reads 0)
      this.pass = this.encoder().beginComputePass(); this.computePass = true;
      this.imgBlits.push(...standIns);
    }
    if (iv) { this.pass.setPipeline(iv.gpu); c.imgOn = true; } else if (c.imgOn || standIns.length) { this.pass.setPipeline(c.gpu); c.imgOn = false; }
    // With every buffer of group 0 at a dynamic offset the group changes only when the arena moves to another chunk:
    // the last one is kept with the pipeline and compared, no key is built
    let g0: GPU | undefined;
    if (c.dynOnly) {
      const l = c.last0;
      if (l && l.bufs.length === e0.length) { g0 = l.group; for (let k = 0; k < e0.length; k++) if (l.bufs[k] !== e0[k].resource.buffer || l.sizes[k] !== e0[k].resource.size) { g0 = undefined; break; } }
      if (!g0) { g0 = this.group(layouts[0], e0); c.last0 = { bufs: e0.map(x => x.resource.buffer), sizes: e0.map(x => x.resource.size), group: g0 }; }
    } else g0 = this.group(layouts[0], e0);
    this.pass.setBindGroup(0, g0, offs);
    const group1 = g1Kept ?? (g1.length ? this.group(iv?.l1 ?? layouts[1], g1) : (c.empty1 ??= this.group(layouts[1], g1)));
    if (!c.compute) { if (!ivar && !tvar && !standIns.length) { c.g1 = group1; c.g1At = tg; } else c.g1At = -1; }
    this.pass.setBindGroup(1, group1);
    this.drawSet = null;
    if (layouts[2] && !c.mesh && !c.compute && !c.drawParams) {
      const key = this.fix.join(",");
      let g = this.fixGroups.get(key);
      if (!g) { const b = this.newBuffer({ size: 16, usage: 0x40 | 0x08 }); this.device.queue.writeBuffer(b, 0, new Float32Array(this.fix)); g = this.device.createBindGroup({ layout: layouts[2], entries: [{ binding: 0, resource: { buffer: b } }] }); this.fixGroups.set(key, g); }
      this.pass.setBindGroup(2, g);
    }
    this.bindDirty = false;
    return true;
  }
  // ---- ?ndve=bypass (src/glue/ndve.ts) ----
  // A dispatch with the stand-in armed: as dispatch() for any key, with the model's dispatches noted and the resampler's taken over when the frame's network did not run
  private ndveDispatch(dv: DataView, p: number) {
    const nd = this.ndve!, id = dv.getUint32(p + 8, true), sid = this.pipes.get(id)?.stages[0], pos = sid === undefined ? -1 : nd.pos(this.shaders[sid]?.key ?? "");
    const tex = (slot: number) => this.tex.get(2 * 64 + slot)?.serial ?? 0, img = (slot: number) => this.img.get(2 * 8 + slot)?.serial ?? 0, push = () => this.ubo.get(uboKey(2, 19))?.data ?? null;
    if (pos === nd.keys.length - 1) this.ndveUploadedPlanes();
    if (pos >= 0 && nd.replaces(pos)) { this.ndveStandIn(img(NDVE_OUTPUT_IMAGE), push()); this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear(); return; }
    // once a layer of this frame's network could not run, the later ones would only write over the picture with what they read from nothing
    const ran = !(pos > 0 && nd.broken) && this.usePipeline(id) && this.bind();
    if (pos === 0) this.ndvePlanes(tex, img);
    if (pos >= 0 && nd.saw(pos, ran, tex)) this.ndveStandIn(img(NDVE_OUTPUT_IMAGE), push());
    if (!ran) return;
    this.pass.dispatchWorkgroups(dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 20, true));
    this.imgFlush();
    this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear();
  }
  // H_DISPATCH_SKIPPED: a watched key's dispatch the recorder could not run, with the compute stage's bindings (hostops.ts)
  private dispatchSkipped(dv: DataView, p: number) {
    const nd = this.ndve;
    this.stats.ndveSkipped++;
    if (!nd || !this.pass || !this.computePass) return;
    const pos = nd.pos(Array.from({ length: 8 }, (_, i) => dv.getUint8(p + 8 + i).toString(16).padStart(2, "0")).join(""));
    if (pos < 0) return;
    if (pos === 0) this.ndvePlanes(slot => this.u64(dv, p + 32 + slot * 8), slot => this.u64(dv, p + 288 + slot * 8));
    if (pos === nd.keys.length - 1) this.ndveUploadedPlanes();
    if (nd.saw(pos, false, slot => this.u64(dv, p + 32 + slot * 8))) this.ndveStandIn(this.u64(dv, p + 288 + NDVE_OUTPUT_IMAGE * 8), this.u8.slice(p + 352, p + 608));
  }
  // The decoder's picture as the colour conversion (dispatch 1) has it bound: an r8unorm luma plane and an rg8unorm chroma plane at half its size (NV12)
  private ndvePlanes(tex: (slot: number) => number, img: (slot: number) => number) {
    const nd = this.ndve!; nd.luma = 0; nd.chroma = 0; nd.rgb = 0;
    let colour = 0, colours = 0;
    // the game binds the planes to the conversion as images (it reads them with image loads); texture slots are looked at too
    for (let slot = 0; slot < 40; slot++) {
      const serial = slot < 32 ? tex(slot) : img(slot - 32), g = serial ? this.texture(serial)?.gpu : null;
      if (!g || g.dimension !== "2d") continue;
      if (g.format === "r8unorm" && !nd.luma) nd.luma = serial; else if (g.format === "rg8unorm" && !nd.chroma) nd.chroma = serial;
      else if (/^(rgba|bgra)8unorm/.test(g.format)) { colour = serial; colours++; }
    }
    // one colour texture and no planes: the host's decoder gave the conversion an RGB picture (src/hle/codec_video.ts keeps the decoded pictures)
    if (!(nd.luma && nd.chroma) && colours === 1 && (this.texture(colour)?.gpu?.width ?? 0) >= 64) nd.rgb = colour;   // (a 4x4 texture is a placeholder)
    if (!(nd.luma && nd.chroma) && !nd.rgb) this.red("ndveplanes", `ndve=bypass: the colour conversion's planes were not found among its textures: ${Array.from({ length: 40 }, (_, i) => i).filter(i => (i < 32 ? tex(i) : img(i - 32))).map(i => { const sr = i < 32 ? tex(i) : img(i - 32), g = this.texture(sr)?.gpu; return `${i < 32 ? "texture" : "image"} slot ${i < 32 ? i : i - 32} tex#${sr} ${g ? `${g.format} ${g.width}x${g.height}` : "(not live)"}`; }).join(", ") || "nothing bound"}`);
  }
  // The game binds the planes to the colour conversion as separate textures, which the recorder's skipped-dispatch record does not carry: the pair
  // of plane textures last uploaded stands for them when one is half the other's size (4:2:0). Looked at when the resampler comes by
  private ndveUploadedPlanes() {
    const nd = this.ndve!;
    if (nd.converted || (nd.luma && nd.chroma)) return;
    const y = this.texture(this.upR8)?.gpu, c = this.texture(this.upRg8)?.gpu;
    if (y && c && y.width >= 64 && c.width === Math.ceil(y.width / 2) && c.height === Math.ceil(y.height / 2)) { nd.luma = this.upR8; nd.chroma = this.upRg8; }
  }
  // The stand-in: the frame's picture resampled bilinearly (texel centres, edges clamped) into the image the resampler writes, rows flipped as its push constants
  // say, alpha 1. In the open compute pass, where the resampler would have run
  private ndveStandIn(outSerial: number, push: Uint8Array | null) {
    const nd = this.ndve!, dst = this.texture(outSerial);
    // when the colour conversion did not run either, the picture was never written: the stand-in then reads the decoder's planes and converts them itself
    /* the planes first, also when the game's conversion ran: its picture came out one flat colour (to be found) */ const yT = nd.luma ? this.texture(nd.luma) : undefined, cT = nd.chroma ? this.texture(nd.chroma) : undefined, planes = !!(yT?.gpu && cT?.gpu);
    const rgbT = planes || !nd.rgb ? undefined : this.texture(nd.rgb);
    const src = planes ? yT : rgbT?.gpu ? rgbT : this.texture(nd.pic);
    if (!src?.gpu || !dst?.gpu) { this.red("ndvetex", `ndve=bypass: the movie network's ${src?.gpu ? "output image" : "input picture"} is no live texture: no stand-in`); return; }
    // An sRGB output is no storage format in WebGPU: the stand-in then writes an image of its own in the format's linear twin and the texels are copied
    // over as they are (the two formats copy to each other), which is what a store into the sRGB image would have left
    const twin = SRGB_TWIN[dst.gpu.format], viaCopy = !STORAGE_FORMATS.has(dst.gpu.format) && !!twin && STORAGE_FORMATS.has(twin) && !!(dst.gpu.usage & 0x02) && dst.gpu.sampleCount === 1;
    const fmt = viaCopy ? twin : dst.gpu.format;
    if ((!viaCopy && !(dst.gpu.usage & 0x08)) || !STORAGE_FORMATS.has(fmt) || dst.gpu.dimension !== "2d" || src.gpu.dimension !== "2d" || src.gpu.sampleCount > 1 || src.fmt.kind !== "float") {
      this.red("ndvefmt", `ndve=bypass: the movie network writes a ${dst.gpu.format} ${dst.gpu.dimension} image (a 2D storage format is needed) from a ${src.gpu.format} picture: no stand-in`); return;
    }
    let scratch: GPU = null;
    if (viaCopy) {
      const sk = `${fmt}:${dst.gpu.width}x${dst.gpu.height}`;
      scratch = this.ndveScratch.get(sk);
      if (!scratch) this.ndveScratch.set(sk, scratch = this.device.createTexture({ size: { width: dst.gpu.width, height: dst.gpu.height }, format: fmt, usage: 0x08 | 0x01 /* STORAGE_BINDING | COPY_SRC */ }));
    }
    let k = this.ndvePipes.get(fmt + (planes ? ":nv12" : ""));
    if (!k) {
      const module = this.device.createShaderModule({ code: `struct P { base: i32, flip: u32 }
@group(0) @binding(0) var src: texture_2d<f32>;
${planes ? "@group(0) @binding(3) var chroma: texture_2d<f32>;\n" : ""}@group(0) @binding(1) var dst: texture_storage_2d<${fmt}, write>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let ds = textureDimensions(dst);
  if (g.x >= ds.x || g.y >= ds.y) { return; }
  let ss = vec2i(textureDimensions(src)); let hi = ss - vec2i(1);
  let c = (vec2f(g.xy) + 0.5) * vec2f(ss) / vec2f(ds) - 0.5; let f = floor(c); let w = c - f;
  let a = clamp(vec2i(f), vec2i(0), hi); let b = clamp(vec2i(f) + vec2i(1), vec2i(0), hi);
  var t = mix(mix(textureLoad(src, a, 0), textureLoad(src, vec2i(b.x, a.y), 0), w.x), mix(textureLoad(src, vec2i(a.x, b.y), 0), textureLoad(src, b, 0), w.x), w.y);
${planes ? `  // NV12 to RGB as BT.709 limited range (the stand-in's assumption; the network's own conversion is the game's shader)
  let cs = vec2i(textureDimensions(chroma)); let ch = cs - vec2i(1);
  let cc = (c + 0.5) * vec2f(cs) / vec2f(ss) - 0.5; let cf = floor(cc); let cw = cc - cf;
  let ca = clamp(vec2i(cf), vec2i(0), ch); let cb = clamp(vec2i(cf) + vec2i(1), vec2i(0), ch);
  let uv = mix(mix(textureLoad(chroma, ca, 0).rg, textureLoad(chroma, vec2i(cb.x, ca.y), 0).rg, cw.x), mix(textureLoad(chroma, vec2i(ca.x, cb.y), 0).rg, textureLoad(chroma, cb, 0).rg, cw.x), cw.y) - vec2f(128.0 / 255.0);
  let yy = (t.r - 16.0 / 255.0) * 1.164383;
  t = vec4f(clamp(vec3f(yy + 1.792741 * uv.y, yy - 0.213249 * uv.x - 0.532909 * uv.y, yy + 2.112402 * uv.x), vec3f(0.0), vec3f(1.0)), 1.0);
` : ""}  var y = i32(g.y);
  if (p.flip != 0u) { y = p.base - y; }
  if (y < 0 || y >= i32(ds.y)) { return; }
  textureStore(dst, vec2i(i32(g.x), y), vec4f(t.rgb, 1.0));
}` });
      const pipe = this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      this.ndvePipes.set(fmt + (planes ? ":nv12" : ""), k = { pipe, layout: pipe.getBindGroupLayout(0) });
    }
    const pw = push && push.length >= 80 ? new DataView(push.buffer, push.byteOffset, push.byteLength) : null, flip = pw ? pw.getUint32(NDVE_FLIP_ON * 4, true) : 0;
    const ub = this.newBuffer({ size: 16, usage: 0x40 | 0x08 });
    this.device.queue.writeBuffer(ub, 0, new Int32Array([pw ? pw.getInt32(NDVE_FLIP_BASE * 4, true) : 0, flip ? 1 : 0, 0, 0]));
    this.inUse.push(ub);
    const group = this.device.createBindGroup({ layout: k.layout, entries: [{ binding: 0, resource: this.view(src, src.gpu, null, "2d", true) }, { binding: 1, resource: scratch ? scratch.createView() : this.view(dst, dst.gpu, null, "2d", true) }, { binding: 2, resource: { buffer: ub } }, ...(planes ? [{ binding: 3, resource: this.view(cT!, cT!.gpu, null, "2d", true) }] : [])] });
    this.pass.setPipeline(k.pipe); this.pass.setBindGroup(0, group);
    this.pass.dispatchWorkgroups(Math.ceil(dst.gpu.width / 8), Math.ceil(dst.gpu.height / 8));
    if (scratch) {
      // the copy cannot be inside the compute pass: the pass ends here and a new one is open for the dispatches that follow
      this.pass.end();
      this.encoder().copyTextureToTexture({ texture: scratch }, { texture: dst.gpu }, { width: dst.gpu.width, height: dst.gpu.height });
      this.pass = this.encoder().beginComputePass(); this.computePass = true;
    }
    this.cur = null; this.bindDirty = true; this.stats.ndveStandIns++;
    // what it read and wrote, once for each kind of source (the first-frame line below is the summary)
    this.red(`ndvesrc${planes ? "p" : rgbT?.gpu ? "r" : "c"}${src.gpu.format}${dst.gpu.format}`, `ndve=bypass: stand-in source ${planes ? "NV12 planes" : rgbT?.gpu ? "the decoder's RGB picture" : "the conversion's output picture"} tex#${src.serial} ${src.gpu.format} ${src.gpu.width}x${src.gpu.height} -> tex#${dst.serial} ${dst.gpu.format} ${dst.gpu.width}x${dst.gpu.height} (conversion ran: ${nd.converted}, rgb ${nd.rgb}, picture ${nd.pic})`);
    if (!nd.frames++) this.log(`[RED] ndve=bypass: nn::ndve's movie network did not run (its shaders are not ready or failed; nxweb has no HMMA lowering): a stand-in replaced it, the ${src.gpu.width}x${src.gpu.height} ${planes ? "decoder picture (NV12 planes, converted as BT.709 limited range by the stand-in)" : rgbT?.gpu ? "decoder picture (the colour conversion's input, which the host's decoder wrote as RGB)" : "picture"} resampled bilinearly into the network's ${dst.gpu.width}x${dst.gpu.height} ${dst.gpu.format} output${scratch ? " (through an image of its own: the format is not one WebGPU stores to)" : ""}${flip ? " (rows flipped)" : ""}. Diagnostic only: not the network's picture`);
  }
  private zero: GPU = null;
  private zeroBuffer(): GPU { return (this.zero ??= this.newBuffer({ size: 65536, usage: 0x40 | 0x08 })); }
  private scratchSt: GPU = null;
  private scratchStorage(): GPU { return (this.scratchSt ??= this.newBuffer({ size: 65536, usage: 0x80 | 0x08 })); }
  private dispatch(dv: DataView, p: number) {
    if (!this.pass || !this.computePass) return;
    this.stats.dispatches++;
    if (this.ndve) { this.ndveDispatch(dv, p); return; }
    if (!this.usePipeline(dv.getUint32(p + 8, true))) { this.ledger.dropped("pipeline not built on the host", true); return; }
    if (!this.bind()) { this.ledger.dropped("bindings not made on the host", true); return; }
    this.pass.dispatchWorkgroups(dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 20, true));
    this.imgFlush();
    this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear();
  }


  // ---- mesh draws (src/gfx/lower.ts meshDraw, src/shaders/meshstage.ts) ----
  // MESH_BEGIN: the draw's control words (CTL_WORDS of a ring, one slice a draw in a submission) are written, an indirect draw's {count, first} copied over them
  // from where the GPU or the CPU wrote it, a compute pass begins and a helper turns the counts into the first grid. MESH_TASK runs the task shader over it and
  // a helper turns the largest launch count into the mesh grid; MESH_RUN runs the mesh shader into the output slots and ends the pass; MESH_DRAW draws the
  // slots in the render pass begun again (drawIndirect: the vertex count is the GPU's). One output buffer and one task buffer serve every mesh draw, in order
  // The grids and draw arguments are copied (by the helpers) into a second ring, the one dispatchWorkgroupsIndirect and drawIndirect read: a
  // buffer may not be both a dispatch's writable storage and its indirect source
  private meshCtls: GPU[] = []; private meshArgs: GPU[] = []; private meshCtlAt = 0; private meshOut: GPU = null; private meshTask: GPU = null; private meshOld: GPU[] = [];
  private meshCur: { ctl: GPU; args: GPU; off: number; task: boolean } | null = null;
  private meshHelp: { prep: GPU; fin: GPU; layout: GPU } | null = null;
  private meshSamples: { buf: GPU; n: number; task: boolean; indirect: boolean }[] = [];
  private meshShown = 0; private fixBufs = new Map<string, GPU>();
  private fixBuffer(): GPU {
    const key = this.fix.join(",");
    let fb = this.fixBufs.get(key);
    if (!fb) { fb = this.newBuffer({ size: 16, usage: 0x40 | 0x08 }); this.device.queue.writeBuffer(fb, 0, new Float32Array(this.fix)); this.fixBufs.set(key, fb); }
    return fb;
  }
  // The draw parameters of a pipeline whose vertex shader reads them (src/shaders/spv.ts drawParameters): base vertex (the first vertex of a non-indexed draw,
  // as Vulkan's BaseVertex), base instance, draw index (a multi-draw's record number), in 16 bytes of the uniform arena at a dynamic offset of group 2. Unchanged from the last draw: nothing
  // A render pass closed in the middle (for a copy no pass may hold) is opened again on the same attachments, loading what was drawn, with the
  // state the stream had set on it; the buffers of the next draw are set again (drawSet)
  private passDesc: any = null;
  private passState: { vp?: number[]; sc?: number[]; bc?: number[]; sr?: number; vb?: Map<number, [GPU, number]> } = {};
  private reopenRenderPass() {
    const d = this.passDesc, desc: any = { colorAttachments: d.colorAttachments.map((a: any) => a && { view: a.view, ...(a.depthSlice !== undefined ? { depthSlice: a.depthSlice } : {}), ...(a.resolveTarget ? { resolveTarget: a.resolveTarget } : {}), loadOp: "load", storeOp: a.storeOp }) };
    if (d.depthStencilAttachment) { const a = { ...d.depthStencilAttachment }; if (a.depthLoadOp) { a.depthLoadOp = "load"; delete a.depthClearValue; } if (a.stencilLoadOp) { a.stencilLoadOp = "load"; delete a.stencilClearValue; } desc.depthStencilAttachment = a; }
    if (d.occlusionQuerySet) desc.occlusionQuerySet = d.occlusionQuerySet;
    this.pass = this.encoder().beginRenderPass(desc); this.computePass = false; this.drawSet = null; this.stats.passReopens++;
    const s = this.passState;
    if (s.vp) this.pass.setViewport(...(s.vp as [number, number, number, number, number, number]));
    if (s.sc) this.pass.setScissorRect(...(s.sc as [number, number, number, number]));
    if (s.bc) this.pass.setBlendConstant(s.bc);
    if (s.sr !== undefined) this.pass.setStencilReference(s.sr);
    if (s.vb) for (const [slot, [b, off]] of s.vb) this.pass.setVertexBuffer(slot, b, off);
    this.ownSlots = []; this.vconvKey = "";
    if (this.cur && !this.cur.compute && (this.cur.constSlot !== undefined || this.cur.vconv)) this.ownBuffers(this.cur);
  }
  private drawSet: { pipe: Pipe; bv: number; bi: number; di: number } | null = null;
  private setDrawParams(bv: number, bi: number, di: number) {
    const c = this.cur!, d = this.drawSet;
    if (!c.drawParams || (d && d.pipe === c && d.bv === bv && d.bi === bi && d.di === di)) return;
    let buf: GPU, off = 0;
    if (this.uniformArena) { const s = this.uaAlloc(16), v = new DataView(s.c.staging.buffer, s.c.staging.byteOffset + s.off, 16); v.setInt32(0, bv, true); v.setInt32(4, bi, true); v.setInt32(8, di, true); v.setInt32(12, 0, true); buf = s.c.buf; off = s.off; }
    else { buf = this.alloc(256); this.device.queue.writeBuffer(buf, 0, new Int32Array([bv, bi, di, 0])); this.inUse.push(buf); }
    const fix = c.vsFixup ? this.fixBuffer() : null, l = c.last2;
    let group = l && l.fix === fix && l.buf === buf ? l.group : undefined;
    if (!group) {
      group = this.device.createBindGroup({ layout: c.layouts[2], entries: [...(fix ? [{ binding: 0, resource: { buffer: fix } }] : []), { binding: 2, resource: { buffer: buf, offset: 0, size: 16 } }] });
      c.last2 = { fix, buf, group };
    }
    this.pass.setBindGroup(2, group, [off]);
    this.drawSet = { pipe: c, bv, bi, di };
  }
  private layoutOf(entries: any[]): GPU {
    const key = JSON.stringify(entries);
    let l = this.layouts.get(key);
    if (!l) { l = this.device.createBindGroupLayout({ entries }); this.layouts.set(key, l); }
    return l;
  }
  private meshVertexModule(id: number, msId: number, fsId: number): GPU {
    const ms = this.shaders[msId], fs = this.shaders[fsId];
    try {
      const code = pullVertexShader(ms.info.mesh!, fragmentInputs(fs.info.wgsl));
      if (this.meshShown++ < 8) { const m = ms.info.mesh!; this.log(`mesh pipeline ${id}: mesh shader ${ms.key} (${m.maxV} vertices, ${m.maxP} ${["", "points", "lines", "triangles"][m.verts!]}, ${m.vertex!.length} + ${m.primitive!.length} output words a vertex / primitive${m.task ? ", reads a task's payload" : ""}) runs as compute; fragment shader ${fs.key} draws its outputs`); }
      return this.device.createShaderModule({ code });
    } catch (e: any) { this.log(`[RED] mesh pipeline ${id} (mesh shader ${ms.key}, fragment shader ${fs.key}): ${e?.message ?? e}: its draws are skipped`); return null; }
  }
  private meshHelpers() {
    if (this.meshHelp) return this.meshHelp;
    const layout = this.layoutOf([0, 1].map(binding => ({ binding, visibility: 4, buffer: { type: "storage" } })));
    const m = this.device.createShaderModule({ code: `@group(0) @binding(0) var<storage, read_write> c: array<u32, ${CTL_WORDS}>;
@group(0) @binding(1) var<storage, read_write> a: array<u32, 16>;
fn draw(n: u32) { c[9] = n; c[12] = n * c[20]; c[13] = 1u; c[14] = 0u; c[15] = 0u; for (var i = 0u; i < 16u; i++) { a[i] = c[i]; } }
@compute @workgroup_size(1) fn prep() {
  let cap = select(c[16], c[17], c[18] != 0u); let n = min(c[0], cap);
  c[2] = min(n, ${0xffff}u); c[3] = (n + ${0xfffe}u) / ${0xffff}u; c[4] = 1u; c[5] = 0u; c[10] = select(0u, 1u, c[0] > cap);
  if (c[18] == 0u) { draw(n); } else { draw(0u); }
}
@compute @workgroup_size(1) fn fin() {
  let tasks = min(min(c[0], c[17]), ${0xffff}u); let ml = min(c[5], ${0xffff}u); let total = tasks * ml;
  c[6] = ml; c[7] = select(tasks, 0u, ml == 0u); c[8] = 1u;
  if (total > c[16]) { c[10] = 1u; }
  draw(min(total, c[16]));
}` });
    const pl = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
    return (this.meshHelp = { layout, prep: this.device.createComputePipeline({ layout: pl, compute: { module: m, entryPoint: "prep" } }), fin: this.device.createComputePipeline({ layout: pl, compute: { module: m, entryPoint: "fin" } }) });
  }
  private meshBuf(cur: GPU, size: number, budget: number): GPU {
    if (cur && cur.size >= size) return cur;
    if (cur) this.meshOld.push(cur);
    return this.newBuffer({ size: Math.max(size, Math.min(budget, (cur?.size ?? 32768) * 2)), usage: 0x80 | 0x08 | 0x04 });
  }
  private meshBegin(dv: DataView, p: number) {
    this.endPass(); this.meshCur = null; this.cur = null;
    const flags = dv.getUint32(p + 8, true), first = dv.getUint32(p + 12, true), count = dv.getUint32(p + 16, true), ind = this.u64(dv, p + 24);
    const msId = dv.getUint32(p + 32, true), tsId = dv.getInt32(p + 36, true), task = (flags & 2) !== 0, indirect = (flags & 1) !== 0;
    const m = this.shaders[msId]?.info.mesh, tm = task ? this.shaders[tsId]?.info.mesh : undefined;
    if (!m || m.kind !== "ms" || (task && tm?.kind !== "ts")) { this.red("meshinfo", "a mesh draw names shaders that are not a registered mesh (and task) shader: skipped"); this.stats.meshFailed++; return; }
    const SW = slotWords(m), TS = tm ? taskStride(tm) : 0, budget = Math.min(this.limit("maxStorageBufferBindingSize", 134217728), 64 << 20);
    const slotCap = Math.max(1, Math.floor(budget / (SW * 4))), taskCap = tm ? Math.max(1, Math.floor(budget / (TS * 4))) : 0;
    if (!indirect && count > (task ? taskCap : slotCap))
      this.red("meshcut", `a mesh draw of ${count} ${task ? "task" : "mesh"} workgroups is over the ${task ? taskCap : slotCap} its buffer holds (${budget >> 20} MB at ${(task ? TS : SW) * 4} bytes each): the rest are not drawn`);
    this.meshOut = this.meshBuf(this.meshOut, (!indirect && !task ? Math.min(count, slotCap) : slotCap) * SW * 4, budget);
    if (task) this.meshTask = this.meshBuf(this.meshTask, (indirect ? taskCap : Math.min(count, taskCap)) * TS * 4, budget);
    const at = this.meshCtlAt++, off = (at & 1023) * CTL_WORDS * 4;
    const ctl = (this.meshCtls[at >> 10] ??= this.newBuffer({ size: 1024 * CTL_WORDS * 4, usage: 0x80 | 0x08 | 0x04 }));
    const args = (this.meshArgs[at >> 10] ??= this.newBuffer({ size: 1024 * CTL_WORDS * 4, usage: 0x80 | 0x100 }));
    const w = new Uint32Array(CTL_WORDS);
    w[0] = indirect ? 0 : count; w[1] = first; w[16] = slotCap; w[17] = taskCap; w[18] = task ? 1 : 0; w[19] = TS; w[20] = m.maxP! * m.verts!;
    this.device.queue.writeBuffer(ctl, off, w);
    if (indirect) {
      // from the mirror of global memory when it holds the record (a culling shader stores it through a loaded address), else from guest memory or a compute pass's own copy
      const gm = ind % 4 === 0 ? this.gmSource(ind, 8) : null, src = gm ? gm.buf : ind % 4 === 0 ? this.upload(ind, 8, 3) : null;
      if (src) this.encoder().copyBufferToBuffer(src, gm ? gm.off : this.upOff, ctl, off, 8);
      else this.red("meshind", `an indirect mesh draw's {count, first} at 0x${ind.toString(16)} is ${ind % 4 ? "not 4-byte aligned" : "in no memory the replayer has"}: drawn as no workgroups`);
    }
    const h = this.meshHelpers();
    this.pass = this.encoder().beginComputePass(); this.computePass = true; this.stats.computePasses++;
    this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear();
    this.pass.setPipeline(h.prep); this.pass.setBindGroup(0, this.device.createBindGroup({ layout: h.layout, entries: this.meshHelpEntries(ctl, args, off) }));
    this.pass.dispatchWorkgroups(1);
    this.meshCur = { ctl, args, off, task };
    this.stats.meshDraws++; if (indirect) this.stats.meshIndirect++; if (task) this.stats.meshWithTask++;
    const n = this.stats.meshDraws;
    if (n <= 3 || (n & (n - 1)) === 0 && n <= 4096) {      // a few draws' counts as the GPU had them, logged after the submission (flush)
      const buf = this.newBuffer({ size: CTL_WORDS * 4, usage: 0x01 | 0x08 });
      this.meshSamples.push({ buf, n, task, indirect }); (this.meshCur as any).sample = buf;
    }
  }
  private meshHelpEntries(ctl: GPU, args: GPU, off: number) {
    return [{ binding: 0, resource: { buffer: ctl, offset: off, size: CTL_WORDS * 4 } }, { binding: 1, resource: { buffer: args, offset: off, size: 64 } }];
  }
  private meshCompute(pipe: number, entries: any[], at: number): boolean {
    const mc = this.meshCur!;
    if (!this.usePipeline(pipe) || !this.bind()) { this.stats.meshFailed++; return false; }
    this.pass.setBindGroup(2, this.device.createBindGroup({ layout: this.cur!.layouts[2], entries: [{ binding: 0, resource: { buffer: mc.ctl, offset: mc.off, size: CTL_WORDS * 4 } }, ...entries] }));
    this.pass.dispatchWorkgroupsIndirect(mc.args, mc.off + at); this.stats.dispatches++;
    return true;
  }
  private meshTaskRun(pipe: number) {
    const mc = this.meshCur;
    if (!mc || !this.computePass) return;
    this.meshCompute(pipe, [{ binding: 2, resource: { buffer: this.meshTask } }], 8);
    this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear();
    const h = this.meshHelp!;
    this.pass.setPipeline(h.fin); this.pass.setBindGroup(0, this.device.createBindGroup({ layout: h.layout, entries: this.meshHelpEntries(mc.ctl, mc.args, mc.off) }));
    this.pass.dispatchWorkgroups(1); this.cur = null;
  }
  private meshRun(pipe: number) {
    const mc = this.meshCur;
    if (!mc || !this.computePass) return;
    this.meshCompute(pipe, [{ binding: 1, resource: { buffer: this.meshOut } }, ...(mc.task ? [{ binding: 2, resource: { buffer: this.meshTask } }] : [])], mc.task ? 24 : 8);
    this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear();
    this.endPass(); this.cur = null;
    const sample = (mc as any).sample;
    if (sample) this.encoder().copyBufferToBuffer(mc.ctl, mc.off, sample, 0, CTL_WORDS * 4);
  }
  private meshDraw() {
    const mc = this.meshCur, c = this.cur;
    if (!mc || !c || !this.pass) return;
    if (this.bindDirty && !this.bind()) return;
    this.pass.setBindGroup(2, this.device.createBindGroup({ layout: c.layouts[2], entries: [{ binding: 0, resource: { buffer: this.fixBuffer() } }, { binding: 1, resource: { buffer: this.meshOut } }] }));
    this.pass.drawIndirect(mc.args, mc.off + 48);
    this.stats.draws++;
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
  // The stand-ins of storage images whose format WebGPU cannot write (bind) are drawn into their textures; the compute pass is opened again
  private imgBlits: StandIn[] = [];
  // The texels of one 2D view into another of the same size, as they are (any class: no sampler, no filtering)
  private copyTexels(srcView: GPU, dstView: GPU, dstFmt: string, cls: "float" | "sint" | "uint") {
    const key = `texels|${dstFmt}|${cls}`, ty = cls === "float" ? "f32" : cls === "uint" ? "u32" : "i32";
    let pl = this.helpers.get(key);
    if (!pl) {
      const m = this.device.createShaderModule({ code: `@group(0) @binding(0) var t: texture_2d<${ty}>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0); }
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4<${ty}> { return textureLoad(t, vec2i(p.xy), 0); }` });
      pl = this.device.createRenderPipeline({ layout: "auto", vertex: { module: m, entryPoint: "vs" }, fragment: { module: m, entryPoint: "fs", targets: [{ format: dstFmt }] } });
      this.helpers.set(key, pl);
    }
    const pass = this.encoder().beginRenderPass({ colorAttachments: [{ view: dstView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setPipeline(pl);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: srcView }] }));
    pass.draw(3); pass.end();
  }
  // A stand-in's texels into an rgb9e5ufloat texture, which WebGPU can neither store to nor draw into but takes copies from a buffer: a compute pass packs
  // the stand-in's floats into the format's words (shared exponent, 9 bits a channel, as the GL / Vulkan specifications round them), one row every `pitch` words
  private packRgb9e5(x: StandIn) {
    const w = x.sc.width, h = x.sc.height, pitch = Math.ceil(w * 4 / 256) * 256, size = pitch * h;
    if (x.bits) {      // an r32uint stand-in holds the format's words already: through a buffer into the texture (no texture-to-texture copy between the two formats)
      const raw = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(size))));
      this.inUse.push(raw);
      this.encoder().copyTextureToBuffer({ texture: x.sc }, { buffer: raw, bytesPerRow: pitch, rowsPerImage: h }, { width: w, height: h });
      this.encoder().copyBufferToTexture({ buffer: raw, bytesPerRow: pitch, rowsPerImage: h }, { texture: x.t.gpu, mipLevel: x.lv, origin: { x: 0, y: 0, z: x.ly } }, { width: w, height: h });
      return;
    }
    let pl = this.helpers.get("rgb9e5");
    if (!pl) {
      const m = this.device.createShaderModule({ code: `struct P { pitch: u32 } @group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var<storage, read_write> o: array<u32>; @group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let d = textureDimensions(t);
  if (id.x >= d.x || id.y >= d.y) { return; }
  let v = clamp(textureLoad(t, vec2i(id.xy), 0).rgb, vec3f(0.0), vec3f(65408.0));
  let maxc = max(v.r, max(v.g, v.b));
  var e = max(-16.0, floor(log2(maxc))) + 16.0;
  var s = exp2(e - 24.0);
  if (floor(maxc / s + 0.5) == 512.0) { e += 1.0; s *= 2.0; }
  let c = vec3u(floor(v / s + 0.5));
  o[id.y * p.pitch + id.x] = c.r | (c.g << 9u) | (c.b << 18u) | (u32(e) << 27u);
}` });
      pl = this.device.createComputePipeline({ layout: "auto", compute: { module: m, entryPoint: "main" } });
      this.helpers.set("rgb9e5", pl);
    }
    const buf = this.alloc(Math.max(256, 2 ** Math.ceil(Math.log2(size)))), par = this.alloc(256);
    this.device.queue.writeBuffer(par, 0, new Uint32Array([pitch / 4, 0, 0, 0]));
    this.inUse.push(buf, par);
    const pass = this.encoder().beginComputePass();
    pass.setPipeline(pl);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: x.sc.createView() }, { binding: 1, resource: { buffer: buf, size } }, { binding: 2, resource: { buffer: par, size: 16 } }] }));
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8)); pass.end();
    this.encoder().copyBufferToTexture({ buffer: buf, bytesPerRow: pitch, rowsPerImage: h }, { texture: x.t.gpu, mipLevel: x.lv, origin: { x: 0, y: 0, z: x.ly } }, { width: w, height: h });
  }
  private imgFlush() {
    if (!this.imgBlits.length) return;
    this.endPass();
    for (const x of this.imgBlits) { if (x.t.fmt.tex === "rgb9e5ufloat") this.packRgb9e5(x); else this.copyTexels(x.sc.createView(), this.attachView(x.t, x.lv, x.ly), x.t.fmt.tex!, x.cls); this.stats.imageStandIns++; }
    this.imgBlits.length = 0;
    this.endPass();
    this.pass = this.encoder().beginComputePass(); this.computePass = true; this.cur = null;
  }
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
  // ClearTexture / ClearTexturei / ClearTextureui (lower.ts clearTex): the region of one level, slice by slice, outside a render pass. As nxnative's clear_tex (nvn_mtl.m):
  // the value is the four floats, or the four integers as numbers, converted to the texture's format as a render pass clear converts them. A whole slice with every
  // component is a render pass's clear (depth from value 0, stencil from value 1 of a depth-stencil texture, value 0 of a stencil one); otherwise a helper draws the
  // value under a scissor with the component mask as its write mask
  private clearTex(dv: DataView, p: number) {
    const t = this.texture(this.u64(dv, p + 8));
    if (!t) return;
    const level = dv.getUint32(p + 16, true), layer = dv.getUint32(p + 20, true), r = [0, 1, 2, 3, 4, 5].map(i => dv.getInt32(p + 24 + i * 4, true));
    const mask = dv.getUint32(p + 48, true) & 15, src = dv.getUint32(p + 52, true), f = t.fmt;
    const v = [0, 1, 2, 3].map(i => src === 1 ? dv.getUint32(p + 56 + i * 4, true) : src === 2 ? dv.getInt32(p + 56 + i * 4, true) : dv.getFloat32(p + 56 + i * 4, true));
    if (!mask) return;
    const lw = Math.max(1, t.width >> level), lh = Math.max(1, t.height >> level), is3d = t.gpu.dimension === "3d";
    const x = Math.max(0, r[0]), y = Math.max(0, r[1]), w = Math.min(lw, r[0] + r[3]) - x, h = Math.min(lh, r[1] + r[4]) - y, nz = Math.max(1, r[5]);
    if (w <= 0 || h <= 0) return;
    const ds = f.kind === "depth" || !!f.stencil, whole = x === 0 && y === 0 && w === lw && h === lh && (ds || mask === 15);
    if (!(t.gpu.usage & 0x10) || f.conv || (ds && !whole)) {
      this.red(`cleartex${f.tex}${ds}`, `ClearTexture of ${ds ? "part of a depth or stencil" : `a ${f.tex}`} texture, which ${ds ? "the host clears only whole" : "WebGPU cannot render to (or the host converts)"}: the clear is dropped`);
      return;
    }
    this.endPass();
    this.stats.clearRects++;
    const kind = f.kind === "uint" || f.kind === "sint" ? f.kind : "float", ty = kind === "uint" ? "vec4u" : kind === "sint" ? "vec4i" : "vec4f";
    const num = v.map(c => kind === "float" ? c : kind === "uint" ? Math.min(0xffffffff, Math.max(0, Math.trunc(c))) : Math.min(0x7fffffff, Math.max(-0x80000000, Math.trunc(c))));
    let pl: GPU | undefined, bg: GPU | undefined;
    if (!whole) {
      const key = `cleartex|${f.tex}|${mask}`;
      pl = this.helpers.get(key);
      if (!pl) {
        const m = this.device.createShaderModule({ code: `struct U { c: ${ty} } @group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) ${ty} { return u.c; }` });
        pl = this.device.createRenderPipeline({ layout: "auto", vertex: { module: m, entryPoint: "vs" }, primitive: { topology: "triangle-list" }, fragment: { module: m, entryPoint: "fs", targets: [{ format: f.tex, writeMask: mask }] } });
        this.helpers.set(key, pl);
      }
      const ub = this.alloc(256);
      this.device.queue.writeBuffer(ub, 0, kind === "uint" ? new Uint32Array(num) : kind === "sint" ? new Int32Array(num) : new Float32Array(num));
      this.inUse.push(ub);
      bg = this.device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub, size: 16 } }] });
    }
    for (let z = r[2]; z < r[2] + nz; z++) {
      const view = this.attachView(t, level, is3d ? 0 : layer + z);
      const pass = this.encoder().beginRenderPass(ds
        ? { colorAttachments: [], depthStencilAttachment: { view, ...(f.kind === "depth" ? { depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: Math.min(1, Math.max(0, v[0])) } : {}),
            ...(f.stencil ? { stencilLoadOp: "clear", stencilStoreOp: "store", stencilClearValue: (f.kind === "depth" ? v[1] : v[0]) >>> 0 & 255 } : {}) } }
        : { colorAttachments: [{ view, ...(is3d ? { depthSlice: z } : {}), loadOp: whole ? "clear" : "load", storeOp: "store", ...(whole ? { clearValue: { r: num[0], g: num[1], b: num[2], a: num[3] } } : {}) }] });
      if (!whole) { pass.setPipeline(pl); pass.setBindGroup(0, bg); pass.setScissorRect(x, y, w, h); pass.draw(3); }
      pass.end();
    }
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
    const src = this.newTexture({ size: { width: w, height: h }, format: "r32float", usage: 0x04 | 0x02 }, "a depth upload");
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
  // A texture whose GPU object these very records made holds zeros (WebGPU clears a new texture), and zeros are what a game's new render targets have
  // in memory: such an upload is not made (the game makes its shadow, depth and colour targets anew every frame: 43 MB of zeros a frame, the depth ones a draw
  // and a submit a layer). `blank` lasts until the first record that is not an upload
  private blank: Tex[] = [];
  private allZero(ptr: number, n: number): boolean {
    const m = this.u8, end = Math.min(ptr + n, m.length);
    let i = ptr;
    for (; i < end && (i & 7); i++) if (m[i]) return false;
    const w = new BigUint64Array(m.buffer, i, (end - i) >> 3);
    for (let k = 0; k < w.length; k++) if (w[k]) return false;
    for (i += w.length << 3; i < end; i++) if (m[i]) return false;
    return true;
  }
  private texData(dv: DataView, p: number) {
    const serial = this.u64(dv, p + 8), made = !this.textures.get(serial)?.gpu, t = this.texture(serial);
    if (!t) return;
    if (made) { t.blank = true; this.blank.push(t); }
    // the last 2D single- and two-channel textures whose texels came from guest memory: a decoder's NV12 planes are such a pair (ndveStandIn)
    if (this.ndve && t.gpu.dimension === "2d") { if (t.gpu.format === "r8unorm") this.upR8 = t.serial; else if (t.gpu.format === "rg8unorm") this.upRg8 = t.serial; }
    const what = dv.getUint32(p + 56, true);
    const level = dv.getUint32(p + 16, true), z = dv.getUint32(p + 20, true), y = dv.getUint32(p + 24, true), slices = dv.getUint32(p + 36, true), ptr = this.u64(dv, p + 40), pitch = dv.getUint32(p + 48, true), x = dv.getUint32(p + 52, true);
    const f = t.fmt, up = (v: number, b: number) => Math.ceil(v / b) * b, lw = up(Math.max(1, t.gpu.width >> level), f.bw), lh = up(Math.max(1, t.gpu.height >> level), f.bh);
    const w = Math.min(dv.getUint32(p + 28, true), lw - x), h = Math.min(dv.getUint32(p + 32, true), lh - y), rows = h / f.bh;
    if (w <= 0 || h <= 0 || level >= t.gpu.mipLevelCount) return;
    if (t.gpu.sampleCount > 1) return;
    if (t.blank && this.allZero(ptr, pitch * (what === 1 ? h : rows) * slices)) { this.stats.zeroUploads++; return; }
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
    this.texEpoch++;
    const t = this.texture(serial);
    if (!t) return;
    this.endPass();
    const g = t.gpu;
    if (g.sampleCount > 1) { this.red("snapms", "a draw samples a multisampled target of its own pass: no copy is made, it reads the texture itself"); return; }
    t.snap ??= this.newTexture({ size: { width: g.width, height: g.height, depthOrArrayLayers: g.depthOrArrayLayers }, format: g.format, dimension: g.dimension, mipLevelCount: g.mipLevelCount, usage: 0x04 | 0x02 | 0x10 }, "a snapshot");
    for (let l = 0; l < g.mipLevelCount; l++)
      this.encoder().copyTextureToTexture({ texture: g, mipLevel: l }, { texture: t.snap, mipLevel: l }, { width: Math.max(1, g.width >> l), height: Math.max(1, g.height >> l), depthOrArrayLayers: g.depthOrArrayLayers });
    this.stats.snapshots++;
  }
  private present(dv: DataView, p: number) {
    const serial = this.u64(dv, p + 8), t = this.texture(serial), win = this.u64(dv, p + 32), index = dv.getUint32(p + 40, true);
    this.lastPresented = serial; this.stats.presents++;
    if (t && this.context) {
      const c = [0, 1, 2, 3].map(i => dv.getInt32(p + 16 + i * 4, true)), uv = c[2] > 0 && c[3] > 0 ? [c[0] / t.width, c[1] / t.height, c[2] / t.width, c[3] / t.height] : [0, 0, 1, 1];
      if (dv.getUint32(p + 44, true) & 1) { uv[1] += uv[3]; uv[3] = -uv[3]; }
      // fitCanvas (a game, not a demo with a canvas of its own size): the canvas takes the size of what the game presents, so the picture is not
      // drawn small and stretched by the page
      if (this.fitCanvas && c[2] > 0 && c[3] > 0) {
        const cv = this.context.canvas, w = Math.min(c[2], 3840), h = Math.min(c[3], 2160);
        if (cv && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; this.onCanvasSize?.(w, h); }
      }
      const pv = this.view(t, t.gpu, null, "2d");
      if (pv) this.blit(pv, uv, this.context.getCurrentTexture().createView(), this.canvasFormat, null, true); else this.red("present3d", "a 3D or multisampled texture is presented: nothing is shown");
    }
    if (dv.getUint32(p + 44, true) & 1) this.presentFlips++;
    this.flush();
    this.imageEvent(win, index, 0);
    const gen = this.gen;
    this.device.queue.onSubmittedWorkDone().then(() => { if (gen === this.gen) this.imageEvent(win, index, 1); }, () => {});
    if (this.sc) { this.sc.presented(serial, dv.getUint32(p + 44, true)); if (!this.sc.active) this.sc = null; }
    if (this.cap) this.captureEnd();
  }

  // ---- the stream ----
  // the null replayer: nothing runs, the ledger still counts
  account(ptr: number, len: number) { if (!this.disposed) this.ledger.walk(this.dv, ptr < 0 ? ptr + 4294967296 : ptr, len); }
  exec(ptr: number, len: number) {
    if (this.disposed) return;
    this.texEpoch++;
    if (this.sc) this.sc.batch(ptr, len);
    let dv = this.dv;
    for (let p = ptr, end = ptr + len; p < end;) {
      const op = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
      if (this.cap) this.captureRecord(op, dv, p);
      this.ledger.record(op, dv, p);
      if (this.blank.length && op !== H.TEX_DATA) { for (const t of this.blank) t.blank = false; this.blank.length = 0; }
      switch (op) {
        case H.TEX_CREATE: {
          const serial = this.u64(dv, p + 8), d = p + 16, format = dv.getInt32(d + 4, true);
          this.texEpoch++;
          this.textures.set(serial, { serial, target: dv.getInt32(d, true), format, flags: dv.getInt32(d + 8, true), samples: dv.getInt32(d + 12, true), width: dv.getUint32(d + 16, true), height: dv.getUint32(d + 20, true),
            depth: dv.getUint32(d + 24, true), levels: dv.getUint32(d + 28, true), swz: dv.getUint16(p + 56, true) || 0x0b1a, views: new Map(), fmt: hostFormat(format, this.caps)! });
          break;
        }
        // the texture's objects are destroyed once the commands encoded so far (which may name them) have been submitted: at the next flush, not by one of its own
        case H.TEX_DESTROY: { const s = this.u64(dv, p + 8), t = this.textures.get(s); this.texEpoch++; if (t) { this.doomed.push(t.gpu, t.snap, ...(t.imgScratch?.values() ?? []), ...(t.blockScratch?.values() ?? []), ...[...(t.shapes?.values() ?? [])].map(sh => sh.tex)); this.textures.delete(s); } break; }
        case H.BEGIN_PASS: this.beginPass(dv, p); break;
        case H.END_PASS: { const targets = !this.computePass && this.pass ? this.passInfo?.targets : undefined; this.endPass(); if (this.cap && targets) this.captureTargets(targets); break; }
        case H.BEGIN_COMPUTE: this.endPass(); this.pass = this.encoder().beginComputePass(); this.computePass = true; this.cur = null; this.ubo.clear(); this.tex.clear(); this.ssbo.clear(); this.img.clear(); this.stats.computePasses++; break;
        case H.DISPATCH: this.dispatch(dv, p); break;
        case H.DISPATCH_SKIPPED: this.dispatchSkipped(dv, p); break;
        case H.SKIP: break;
        case H.SSBO: this.ssbo.set(dv.getUint32(p + 8, true) * 64 + dv.getUint32(p + 12, true), { addr: this.u64(dv, p + 16), size: dv.getUint32(p + 24, true), write: (dv.getUint32(p + 28, true) & 1) !== 0 }); this.bindDirty = true; break;
        case H.IMG: { const flags = dv.getUint32(p + 24, true); this.img.set(dv.getUint32(p + 8, true) * 8 + dv.getUint32(p + 12, true), { serial: this.u64(dv, p + 16), view: flags & 2 ? this.u8.slice(p + 32, p + 48) : null }); this.bindDirty = true; break; }
        case H.MESH_BEGIN: this.meshBegin(dv, p); break;
        case H.MESH_TASK: this.meshTaskRun(dv.getUint32(p + 8, true)); break;
        case H.MESH_RUN: this.meshRun(dv.getUint32(p + 8, true)); break;
        case H.MESH_DRAW: this.meshDraw(); break;
        case H.BUF_READBACK: this.bufReadback(this.u64(dv, p + 8), dv.getUint32(p + 16, true)); break;
        case H.UBO_DATA: this.ubo.set(uboKey(dv.getUint32(p + 8, true), dv.getUint32(p + 12, true)), { addr: 0, size: 0, need: 0, data: this.u8.slice(p + 24, p + 24 + dv.getUint32(p + 16, true)) }); this.bindDirty = true; break;
        case H.VIEWPORT: this.passState.vp = [dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true), Math.max(dv.getFloat32(p + 24, true), dv.getFloat32(p + 28, true))]; this.pass.setViewport(...(this.passState.vp as [number, number, number, number, number, number])); break;
        case H.SCISSOR: this.passState.sc = [dv.getUint32(p + 8, true), dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 20, true)]; this.pass.setScissorRect(dv.getUint32(p + 8, true), dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 20, true)); break;
        case H.PIPELINE_CREATE: this.createPipeline(dv.getUint32(p + 8, true), dv.getUint32(p + 12, true)); break;
        case H.PIPELINE: if (this.pass && !this.computePass) this.usePipeline(dv.getUint32(p + 8, true)); break;
        case H.VBUF: { this.vbSrc.set(dv.getUint32(p + 8, true), [this.u64(dv, p + 16), dv.getUint32(p + 12, true)]); this.vconvKey = ""; const b = this.upload(this.u64(dv, p + 16), dv.getUint32(p + 12, true), 0); if (b) { (this.passState.vb ??= new Map()).set(dv.getUint32(p + 8, true), [b, this.upOff]); this.pass.setVertexBuffer(dv.getUint32(p + 8, true), b, this.upOff); } break; }
        case H.UBO: this.ubo.set(dv.getUint32(p + 8, true) * 16 + dv.getUint32(p + 12, true), { addr: this.u64(dv, p + 16), size: dv.getUint32(p + 24, true), need: dv.getUint32(p + 28, true) }); this.bindDirty = true; break;
        case H.TEX: {
          const flags = dv.getUint32(p + 24, true);
          {      // the slot already holds exactly this (most TEX records of a frame): nothing changes, no bind group is made again
            const o = this.tex.get(dv.getUint32(p + 8, true) * 64 + dv.getUint32(p + 12, true));
            if (o && o.serial === this.u64(dv, p + 16) && o.snap === ((flags & 1) !== 0) && o.samp === dv.getUint32(p + 28, true) && (o.view !== null) === ((flags & 2) !== 0)) {
              let same = true;
              if (o.view) { const u = this.u8, v = o.view; for (let k = 0; k < 16; k++) if (v[k] !== u[p + 32 + k]) { same = false; break; } }
              if (same) break;
            }
          }
          this.tex.set(dv.getUint32(p + 8, true) * 64 + dv.getUint32(p + 12, true), { serial: this.u64(dv, p + 16), snap: (flags & 1) !== 0, view: flags & 2 ? this.u8.slice(p + 32, p + 48) : null, samp: dv.getUint32(p + 28, true) });
          this.bindDirty = true; break;
        }
        case H.BLEND_COLOR: this.passState.bc = [0, 1, 2, 3].map(i => dv.getFloat32(p + 8 + i * 4, true)); this.pass.setBlendConstant([0, 1, 2, 3].map(i => dv.getFloat32(p + 8 + i * 4, true))); break;
        case H.STENCIL_REF: this.passState.sr = dv.getUint32(p + 8, true); this.pass.setStencilReference(dv.getUint32(p + 8, true)); break;
        case H.DRAW: case H.DRAW_IDX: {
          if (!this.cur || this.computePass) { this.ledger.dropped("pipeline not built on the host"); break; }
          if (this.bindDirty && !this.bind()) { this.ledger.dropped("bindings not made on the host"); break; }
          if (this.cur.drawParams) this.setDrawParams(op === H.DRAW ? dv.getUint32(p + 8, true) : dv.getInt32(p + 24, true), dv.getUint32(p + 20, true), dv.getUint32(p + (op === H.DRAW ? 28 : 40), true));
          if (this.cur.vconv) this.vertexConverted(this.cur);
          const conv = dv.getUint32(p + (op === H.DRAW ? 24 : 28), true);
          if (conv) { this.drawConverted(dv, p, op === H.DRAW_IDX, conv); this.stats.draws++; break; }
          if (op === H.DRAW) this.pass.draw(dv.getUint32(p + 12, true), dv.getUint32(p + 16, true), dv.getUint32(p + 8, true), dv.getUint32(p + 20, true));
          else {
            const itype = dv.getUint32(p + 8, true), count = dv.getUint32(p + 12, true), isz = itype === 2 ? 4 : itype === 1 ? 2 : 1;
            const ib = this.upload(this.u64(dv, p + 32), count * isz, itype === 0 ? 1 : 2);
            if (!ib) { this.ledger.dropped("index buffer not uploaded"); break; }
            this.pass.setIndexBuffer(ib, itype === 2 ? "uint32" : "uint16", this.upOff);
            this.pass.drawIndexed(count, dv.getUint32(p + 16, true), 0, dv.getInt32(p + 24, true), dv.getUint32(p + 20, true));
          }
          this.stats.draws++; break;
        }
        case H.CLEAR_RECT: this.clearRect(dv, p); break;
        case H.COPY_B2T: this.copyB2T(dv, p); break;
        case H.COPY_T2T: this.copyT2T(dv, p); break;
        case H.CLEAR_TEX: this.clearTex(dv, p); break;
        case H.SNAPSHOT: this.snapshot(this.u64(dv, p + 8)); break;
        case H.PRESENT: this.present(dv, p); if (this.scArm) this.scBegin()?.batch(p + size, end - p - size); break;
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
        case 42 /* H_MEM_WRITE: the bytes into guest memory here, then as H_MEM_DIRTY of that range */: { const a = this.u64(dv, p + 8), n = dv.getUint32(p + 16, true); if (a && n && a + n <= this.memory.buffer.byteLength) { this.u8.copyWithin(a, p + 24, p + 24 + n); this.dropRange(a, n); } break; }
        case H.MEM_DIRTY: { const n = size >= 24 ? dv.getUint32(p + 16, true) : 0; if (n) this.dropRange(this.u64(dv, p + 8), n); else this.dropUploads(); break; }
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
  // A game still loading may not present for minutes: the capture stops after `maxRecords` host records (its text
  // says so) and dumps the targets of the first CAPTURE_IMAGES passes, so its text and read-backs stay bounded.
  private cap: { lines: string[]; images: Promise<CaptureImage | null>[]; state: { pass: number; draws: number; inPass: number }; png: boolean; records: number; maxRecords: number; dispatches: number; done: (c: Capture) => void } | null = null;
  get capturing(): boolean { return !!this.cap; }
  captureFrame(opts: { png?: boolean; maxRecords?: number } = {}): Promise<Capture> {
    if (this.cap) return Promise.reject(new Error("a capture is already running"));
    return new Promise<Capture>(done => {
      this.cap = { maxRecords: opts.maxRecords ?? CAPTURE_RECORDS, lines: [`nxweb frame capture: canvas ${this.canvasFormat}, uniform arena ${this.uniformArena ? "on" : "off"}, host caps ${this.caps}, ${this.textures.size} live textures, ${this.pipes.size} pipelines`],
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
    if (c.records >= c.maxRecords) { c.lines.push(`(the capture stops here: no present in ${c.records} host records)`); this.captureEnd(); }
  }
  private captureTargets(targets: { name: string; serial: number; level: number; layer: number }[]) {
    const c = this.cap!;
    if (!c.png) return;
    const pass = c.state.pass;
    if (c.images.length >= CAPTURE_IMAGES) { if (c.images.length === CAPTURE_IMAGES) { c.lines.push(`    (targets of later passes are not dumped: ${CAPTURE_IMAGES} images is the limit)`); c.images.push(Promise.resolve(null)); } return; }
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
    c.lines.push(`F ${this.ledger.lastLine || "no frame was presented"}`);
    const keys = this.ledger.keyLines(undefined, k => this.shaderStateOf?.(k));
    if (keys.length) c.lines.push("K shader keys that skipped work, by first use:", ...keys.map(l => `K   ${l}`));
    void Promise.all(c.images).then(images => c.done({ text: c.lines.join("\n") + "\n", images: images.filter((i): i is CaptureImage => !!i), passes: c.state.pass, draws: c.state.draws, dispatches: c.dispatches, records: c.records }));
  }
}
