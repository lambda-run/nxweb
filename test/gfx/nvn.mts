// What a small game's graphics layer looks like, on the fake guest: every line is an NVN call through nvn_call
// (Guest.call). Objects are allocated at the sizes NVN reserves for them (include/nvn.h), as a game's are.
import { Guest } from "./guest.mts";

export const SIZEOF = { DEVICE: 0x3000, DEVICE_BUILDER: 0x40, QUEUE: 0x2000, QUEUE_BUILDER: 0x40, MEMORY_POOL: 0x100, MEMORY_POOL_BUILDER: 0x40, TEXTURE_POOL: 0x20, SAMPLER_POOL: 0x20,
  BUFFER: 0x30, BUFFER_BUILDER: 0x40, TEXTURE: 0xC0, TEXTURE_BUILDER: 0x80, TEXTURE_VIEW: 0x28, SAMPLER: 0x30, SAMPLER_BUILDER: 0x60, PROGRAM: 0xC0, SYNC: 0x40, WINDOW: 384, WINDOW_BUILDER: 0x40,
  COMMAND_BUFFER: 0xA0, BLEND_STATE: 0x8, COLOR_STATE: 0x4, CHANNEL_MASK_STATE: 0x4, MULTISAMPLE_STATE: 0x18, POLYGON_STATE: 0x4, DEPTH_STENCIL_STATE: 0x8, VERTEX_ATTRIB_STATE: 0x4, VERTEX_STREAM_STATE: 0x8 };
export const FMT = { R8: 0x01, RG8: 0x0d, RG32F: 0x16, RGB32F: 0x22, RGBA8: 0x25, RGBA16F: 0x29, RGBA32F: 0x2e, DEPTH16: 0x32, DEPTH24: 0x33, DEPTH32F: 0x34, DEPTH24_STENCIL8: 0x35, RGBA8_SRGB: 0x38,
  RGB10A2: 0x3d, R11G11B10F: 0x3f, BC1: 0x42, BC3: 0x44, BC7: 0x4d, BGRA8: 0x9a };
export const PRIM = { POINTS: 0, LINES: 1, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6 };
export const STAGE = { VERTEX: 0, FRAGMENT: 1 }, STAGE_BITS = { VERTEX: 1, FRAGMENT: 2 };
export const POOL_FLAGS = { CPU_CACHED: 0x4, GPU_CACHED: 0x20, CPU_NO_ACCESS: 0x1, SHADER_CODE: 0x40 };
export const BLEND = { ZERO: 1, ONE: 2, SRC_ALPHA: 5, ONE_MINUS_SRC_ALPHA: 6 }, EQ = { ADD: 1 };
export const DEPTH_FUNC = { LESS: 2, LEQUAL: 4, ALWAYS: 8 };
export const FILTER = { NEAREST: 0, LINEAR: 1 }, WRAP = { CLAMP_TO_EDGE: 7, REPEAT: 1 };
export const TARGET = { T2D: 1, T2D_ARRAY: 4 };

export interface Pool { obj: number; mem: number; size: number; used: number }
export interface TextureOpts { w: number; h: number; format: number; levels?: number; target?: number; depth?: number; flags?: number; packaged?: number[] }

export class Game {
  g: Guest;
  dev = 0; queue = 0; cmd = 0; cmdPool!: Pool; data!: Pool; texStore!: Pool; texPool = 0; sampPool = 0;
  nextTexId = 256; nextSampId = 256;     // the first 256 descriptors are the driver's (NVN_DEVICE_INFO_RESERVED_*)
  constructor(g: Guest) { this.g = g; }
  c(name: string, ints: (number | bigint)[] = [], floats: number[] = []) { return this.g.call("nvn" + name, ints, floats); }

  // Device, queue, memory pools, a command buffer with 1 MB of command memory, descriptor pools: what every game sets up first
  init(opts: { cmdBytes?: number; glConventions?: boolean } = {}): this {
    const g = this.g;
    const db = g.alloc(SIZEOF.DEVICE_BUILDER); this.dev = g.alloc(SIZEOF.DEVICE);
    this.c("DeviceBuilderSetDefaults", [db]); this.c("DeviceBuilderSetFlags", [db, 0]);
    if (this.c("DeviceInitialize", [this.dev, db]) !== 1) throw new Error("DeviceInitialize");
    // upper left and near = 0, as nearly every game sets them; glConventions keeps NVN's defaults (lower left, near = -w)
    if (!opts.glConventions) { this.c("DeviceSetWindowOriginMode", [this.dev, 1]); this.c("DeviceSetDepthMode", [this.dev, 1]); }
    const qb = g.alloc(SIZEOF.QUEUE_BUILDER); this.queue = g.alloc(SIZEOF.QUEUE);
    this.c("QueueBuilderSetDevice", [qb, this.dev]); this.c("QueueBuilderSetDefaults", [qb]);
    const qmem = this.c("QueueBuilderGetQueueMemorySize", [qb]);
    this.c("QueueBuilderSetQueueMemory", [qb, g.alloc(qmem, 4096), qmem]);
    if (this.c("QueueInitialize", [this.queue, qb]) !== 1) throw new Error("QueueInitialize");
    this.cmdPool = this.pool(opts.cmdBytes ?? 1 << 20, POOL_FLAGS.CPU_CACHED | POOL_FLAGS.GPU_CACHED);
    this.data = this.pool(4 << 20, POOL_FLAGS.CPU_CACHED | POOL_FLAGS.GPU_CACHED);
    this.texStore = this.pool(24 << 20, POOL_FLAGS.CPU_NO_ACCESS | POOL_FLAGS.GPU_CACHED);
    this.cmd = this.commandBuffer(this.cmdPool, 0, this.cmdPool.size);
    const dpool = this.pool(1 << 20, POOL_FLAGS.CPU_CACHED | POOL_FLAGS.GPU_CACHED);
    this.texPool = g.alloc(SIZEOF.TEXTURE_POOL); this.sampPool = g.alloc(SIZEOF.SAMPLER_POOL);
    this.c("TexturePoolInitialize", [this.texPool, dpool.obj, 0, 2048]);
    this.c("SamplerPoolInitialize", [this.sampPool, dpool.obj, 2048 * 32, 2048]);
    return this;
  }
  pool(size: number, flags: number): Pool {
    const g = this.g, b = g.alloc(SIZEOF.MEMORY_POOL_BUILDER), obj = g.alloc(SIZEOF.MEMORY_POOL), mem = g.alloc(size, 4096);
    this.c("MemoryPoolBuilderSetDefaults", [b]); this.c("MemoryPoolBuilderSetDevice", [b, this.dev]); this.c("MemoryPoolBuilderSetStorage", [b, mem, size]); this.c("MemoryPoolBuilderSetFlags", [b, flags]);
    if (this.c("MemoryPoolInitialize", [obj, b]) !== 1) throw new Error("MemoryPoolInitialize");
    return { obj, mem, size, used: 0 };
  }
  // Bytes in the data pool, at the GPU address a game would pass (pool address + offset)
  put(bytes: ArrayLike<number> | ArrayBufferView, align = 256): number {
    const src = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Uint8Array.from(bytes as ArrayLike<number>);
    const p = this.data, off = (p.used + align - 1) & ~(align - 1);
    p.used = off + src.length;
    const addr = this.c("MemoryPoolGetBufferAddress", [p.obj]) + off;
    this.g.u8.set(src, addr);
    return addr;
  }
  commandBuffer(pool: Pool, off: number, bytes: number): number {
    const cmd = this.g.alloc(SIZEOF.COMMAND_BUFFER);
    if (this.c("CommandBufferInitialize", [cmd, this.dev]) !== 1) throw new Error("CommandBufferInitialize");
    this.c("CommandBufferAddCommandMemory", [cmd, pool.obj, off, bytes]);
    this.c("CommandBufferAddControlMemory", [cmd, this.g.alloc(4096), 4096]);
    return cmd;
  }
  texture(o: TextureOpts): number {
    const g = this.g, b = g.alloc(SIZEOF.TEXTURE_BUILDER), t = g.alloc(SIZEOF.TEXTURE);
    this.c("TextureBuilderSetDevice", [b, this.dev]); this.c("TextureBuilderSetDefaults", [b]);
    this.c("TextureBuilderSetTarget", [b, o.target ?? TARGET.T2D]); this.c("TextureBuilderSetFormat", [b, o.format]);
    this.c("TextureBuilderSetSize2D", [b, o.w, o.h]); if (o.depth) this.c("TextureBuilderSetDepth", [b, o.depth]);
    this.c("TextureBuilderSetLevels", [b, o.levels ?? 1]); this.c("TextureBuilderSetFlags", [b, o.flags ?? 0]);
    if (o.packaged) this.c("TextureBuilderSetPackagedTextureLayout", [b, g.bytes(o.packaged)]);      // the 8 layout bytes of a texture file
    const size = this.c("TextureBuilderGetStorageSize", [b]), align = this.c("TextureBuilderGetStorageAlignment", [b]);
    const off = (this.texStore.used + align - 1) & ~(align - 1);
    this.texStore.used = off + size;
    if (this.texStore.used > this.texStore.size) throw new Error("texture storage pool full");
    this.c("TextureBuilderSetStorage", [b, this.texStore.obj, off]);
    if (this.c("TextureInitialize", [t, b]) !== 1) throw new Error("TextureInitialize");
    return t;
  }
  view(o: { level?: number; layer?: number; format?: number }): number {
    const v = this.g.alloc(SIZEOF.TEXTURE_VIEW);
    this.c("TextureViewSetDefaults", [v]);
    if (o.level !== undefined) this.c("TextureViewSetLevels", [v, o.level, 1]);
    if (o.layer !== undefined) this.c("TextureViewSetLayers", [v, o.layer, 1]);
    if (o.format !== undefined) this.c("TextureViewSetFormat", [v, o.format]);
    return v;
  }
  // Registers the texture in the texture pool: its texture ID
  texId(tex: number, view = 0): number { const id = this.nextTexId++; this.c("TexturePoolRegisterTexture", [this.texPool, id, tex, view]); return id; }
  sampId(min: number, mag: number, wrap = WRAP.CLAMP_TO_EDGE, o: { lod?: [number, number]; compare?: number; aniso?: number; bias?: number } = {}): number {
    const g = this.g, b = g.alloc(SIZEOF.SAMPLER_BUILDER), s = g.alloc(SIZEOF.SAMPLER), id = this.nextSampId++;
    this.c("SamplerBuilderSetDevice", [b, this.dev]); this.c("SamplerBuilderSetDefaults", [b]);
    this.c("SamplerBuilderSetMinMagFilter", [b, min, mag]); this.c("SamplerBuilderSetWrapMode", [b, wrap, wrap, wrap]);
    if (o.lod) this.c("SamplerBuilderSetLodClamp", [b], o.lod); if (o.bias !== undefined) this.c("SamplerBuilderSetLodBias", [b], [o.bias]);
    if (o.compare) this.c("SamplerBuilderSetCompare", [b, 1, o.compare]); if (o.aniso) this.c("SamplerBuilderSetMaxAnisotropy", [b], [o.aniso]);
    if (this.c("SamplerInitialize", [s, b]) !== 1) throw new Error("SamplerInitialize");
    this.c("SamplerPoolRegisterSampler", [this.sampPool, id, s]);
    return id;
  }
  handle(texId: number, sampId: number): number { return this.c("DeviceGetTextureHandle", [this.dev, texId, sampId]); }
  // A program from two precompiled shader stages (control section + code area each)
  program(stages: { control: number; code: number }[]): number {
    const g = this.g, p = g.alloc(SIZEOF.PROGRAM);
    if (this.c("ProgramInitialize", [p, this.dev]) !== 1) throw new Error("ProgramInitialize");
    const sd = g.u64(stages.flatMap(s => [s.code, s.control]));
    if (this.c("ProgramSetShaders", [p, stages.length, sd]) !== 1) throw new Error("ProgramSetShaders");
    return p;
  }
  window(w: number, h: number, n = 2, format = FMT.RGBA8): { win: number; tex: number[] } {
    const g = this.g, b = g.alloc(SIZEOF.WINDOW_BUILDER), win = g.alloc(SIZEOF.WINDOW);
    const tex = Array.from({ length: n }, () => this.texture({ w, h, format, flags: 1 /* DISPLAY */ }));
    this.c("WindowBuilderSetDevice", [b, this.dev]); this.c("WindowBuilderSetDefaults", [b]);
    this.c("WindowBuilderSetNativeWindow", [b, 0x1234]); this.c("WindowBuilderSetTextures", [b, n, g.u64(tex)]);
    if (this.c("WindowInitialize", [win, b]) !== 1) throw new Error("WindowInitialize");
    return { win, tex };
  }
  acquire(win: number, sync = 0): number { const out = this.g.alloc(4); this.c("WindowAcquireTexture", [win, sync, out]); return this.g.dv.getInt32(out, true); }
  // State objects are small structs a game keeps and copies by value
  vertexLayout(cmd: number, attrs: { format: number; offset: number; stream?: number }[], streams: { stride: number; divisor?: number }[]) {
    const g = this.g, a = g.alloc(4 * attrs.length, 4), s = g.alloc(8 * streams.length, 8);
    attrs.forEach((x, i) => { this.c("VertexAttribStateSetDefaults", [a + i * 4]); this.c("VertexAttribStateSetFormat", [a + i * 4, x.format, x.offset]); this.c("VertexAttribStateSetStreamIndex", [a + i * 4, x.stream ?? 0]); });
    streams.forEach((x, i) => { this.c("VertexStreamStateSetDefaults", [s + i * 8]); this.c("VertexStreamStateSetStride", [s + i * 8, x.stride]); this.c("VertexStreamStateSetDivisor", [s + i * 8, x.divisor ?? 0]); });
    this.c("CommandBufferBindVertexAttribState", [cmd, attrs.length, a]); this.c("CommandBufferBindVertexStreamState", [cmd, streams.length, s]);
  }
  // All state objects at their NVN defaults, as engines bind them at the start of a frame
  defaultStates(cmd: number) {
    const g = this.g, bl = g.alloc(8, 8), co = g.alloc(4, 4), cm = g.alloc(4, 4), ms = g.alloc(0x18, 8), po = g.alloc(4, 4), ds = g.alloc(8, 8);
    this.c("BlendStateSetDefaults", [bl]); this.c("ColorStateSetDefaults", [co]); this.c("ChannelMaskStateSetDefaults", [cm]); this.c("MultisampleStateSetDefaults", [ms]);
    this.c("PolygonStateSetDefaults", [po]); this.c("DepthStencilStateSetDefaults", [ds]);
    this.c("CommandBufferBindBlendState", [cmd, bl]); this.c("CommandBufferBindColorState", [cmd, co]); this.c("CommandBufferBindChannelMaskState", [cmd, cm]);
    this.c("CommandBufferBindMultisampleState", [cmd, ms]); this.c("CommandBufferBindPolygonState", [cmd, po]); this.c("CommandBufferBindDepthStencilState", [cmd, ds]);
    return { bl, co, cm, ms, po, ds };
  }
  targets(cmd: number, color: number[], depth = 0, views: number[] = []) {
    this.c("CommandBufferSetRenderTargets", [cmd, color.length, color.length ? this.g.u64(color) : 0, views.length ? this.g.u64(views) : 0, depth, 0]);
  }
  clear(cmd: number, rgba: number[], index = 0, mask = 0xf) { this.c("CommandBufferClearColor", [cmd, index, this.g.f32(rgba), mask]); }
  begin(cmd = this.cmd) { this.c("CommandBufferBeginRecording", [cmd]); }
  end(cmd = this.cmd): number { return this.c("CommandBufferEndRecording", [cmd]); }
  submit(handles: number[]) { this.c("QueueSubmitCommands", [this.queue, handles.length, this.g.u64(handles)]); }
  present(win: number, index: number) { this.c("QueuePresentTexture", [this.queue, win, index]); }
  used(cmd = this.cmd): number { return this.c("CommandBufferGetCommandMemoryUsed", [cmd]); }
}
