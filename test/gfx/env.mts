// The test environment of one scene (browser): a fresh fake guest with the recorder in it, the WebGPU replayer, a
// small "game" (nvn.mts), precompiled-shader stand-ins, and pixel readback. Shared by the scenes and the demo.
import { Guest } from "./guest.mts";
import { Game, FMT, STAGE, PRIM } from "./nvn.mts";
import { GfxHost, type ShaderInfo, type GfxHostOptions } from "../../src/glue/gfx_host.ts";

// Hand-written WGSL standing in for the offline translation of a game's shaders (binding convention: src/gfx/README.md)
const VO = `struct VO { @builtin(position) p: vec4f, @location(0) v: vec4f }`;
export const SHADERS: Record<string, ShaderInfo> = {
  // position (vec2) + colour (vec3)
  vs_color: { stage: "vertex", attributes: [0, 1], wgsl: `${VO} @vertex fn main(@location(0) pos: vec2f, @location(1) col: vec3f) -> VO { return VO(vec4f(pos, 0.0, 1.0), vec4f(col, 1.0)); }` },
  fs_color: { stage: "fragment", outputs: [0], wgsl: `@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return v; }` },
  // position (vec2) + uv (vec2)
  vs_quad: { stage: "vertex", attributes: [0, 1], wgsl: `${VO} @vertex fn main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VO { return VO(vec4f(pos, 0.0, 1.0), vec4f(uv, 0.0, 1.0)); }` },
  // the same, placed by vertex uniform buffer 0: scale.xy, offset.xy, then depth
  vs_quad_ubo: { stage: "vertex", attributes: [0, 1], ubos: [0], wgsl: `${VO} struct U { xf: vec4f, z: vec4f } @group(0) @binding(0) var<uniform> u: U;
@vertex fn main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VO { return VO(vec4f(pos * u.xf.xy + u.xf.zw, u.z.x, 1.0), vec4f(uv, 0.0, 1.0)); }` },
  fs_tex: { stage: "fragment", outputs: [0], textures: [{ slot: 0 }], wgsl: `@group(1) @binding(64) var t: texture_2d<f32>; @group(1) @binding(65) var s: sampler;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return textureSample(t, s, v.xy); }` },
  fs_tex_invert: { stage: "fragment", outputs: [0], textures: [{ slot: 0 }], wgsl: `@group(1) @binding(64) var t: texture_2d<f32>; @group(1) @binding(65) var s: sampler;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return vec4f(1.0 - textureSample(t, s, v.xy).rgb, 1.0); }` },
  // a depth texture through a comparison sampler: the reference is fragment uniform 0's first value
  fs_shadow: { stage: "fragment", outputs: [0], ubos: [0], textures: [{ slot: 0, depth: true }], wgsl: `struct U { c: vec4f } @group(0) @binding(16) var<uniform> u: U;
@group(1) @binding(64) var t: texture_depth_2d; @group(1) @binding(65) var s: sampler_comparison;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { let lit = textureSampleCompare(t, s, v.xy, u.c.x); return vec4f(lit, 1.0 - lit, 0.0, 1.0); }` },
  // fragment uniform buffer 0: the colour
  fs_ubo: { stage: "fragment", outputs: [0], ubos: [0], wgsl: `struct U { c: vec4f } @group(0) @binding(16) var<uniform> u: U; @fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return u.c; }` },
  // as the shader chain must emit it: the position fix-up last (origin and depth mode), from @group(2) @binding(0)
  vs_quad_fix: { stage: "vertex", attributes: [0, 1], ubos: [0], fixup: true, wgsl: `${VO} struct U { xf: vec4f, z: vec4f } @group(0) @binding(0) var<uniform> u: U;
struct NxFix { fix: vec4f } @group(2) @binding(0) var<uniform> nx: NxFix;
@vertex fn main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VO {
  var p = vec4f(pos * u.xf.xy + u.xf.zw, u.z.x, 1.0);
  p.y *= nx.fix.y; p.z = p.z * nx.fix.z + p.w * nx.fix.w;
  return VO(p, vec4f(uv, 0.0, 1.0));
}` },
  // does not match a float vertex layout: its pipeline cannot be built
  vs_bad: { stage: "vertex", attributes: [0, 1], wgsl: `${VO} @vertex fn main(@location(0) pos: vec2i, @location(1) uv: vec2f) -> VO { return VO(vec4f(vec2f(pos), 0.0, 1.0), vec4f(uv, 0.0, 1.0)); }` },
  // ---- the shader chain's reflection record, consumed in full ----
  // a block of 80 bytes (uboSize) of which a game may bind fewer: what lies past the bound size must read as zero
  fs_ubo_big: { stage: "fragment", outputs: [0], ubos: [0], uboSize: { "0": 80 }, wgsl: `struct U { c: vec4f, pad: array<vec4f, 3>, d: vec4f } @group(0) @binding(16) var<uniform> u: U;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return vec4f(u.c.rgb + u.d.rgb + u.pad[1].rgb, 1.0); }` },
  // Ryujinx's support buffer at @group(0) @binding(stage * 16 + 14): viewport size and inverse, render scale
  fs_support: { stage: "fragment", outputs: [0], extra: [{ kind: "support", group: 0, binding: 30, size: 1392 }], wgsl: `struct E { @size(16) v: u32 } struct F { @size(16) v: f32 }
struct Support { alpha_test: u32, @align(16) is_bgra: array<E, 8>, viewport_inverse: vec4f, viewport_size: vec4f, frag_scale_count: i32, @align(16) render_scale: array<F, 73>, tfe_offset: vec4i, tfe_vertex_count: i32 }
@group(0) @binding(30) var<uniform> support: Support;
@fragment fn main(@builtin(position) p: vec4f, @location(0) v: vec4f) -> @location(0) vec4f {
  let xy = p.xy / support.render_scale[1].v;
  return vec4f(xy.x * support.viewport_inverse.x * 0.5, support.viewport_size.y / 256.0, support.render_scale[72].v * 0.5 + f32(support.is_bgra[3].v + support.alpha_test), 1.0); }` },
  // cube, 2D array, 3D and cube array textures; fragment uniform 0: a direction or coordinate and a layer
  fs_cube: { stage: "fragment", outputs: [0], ubos: [0], textures: [{ slot: 0, dim: "cube" }], wgsl: `struct U { c: vec4f } @group(0) @binding(16) var<uniform> u: U;
@group(1) @binding(64) var t: texture_cube<f32>; @group(1) @binding(65) var s: sampler;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, u.c.xyz, 0.0); }` },
  fs_array: { stage: "fragment", outputs: [0], ubos: [0], textures: [{ slot: 0, dim: "2d-array" }], wgsl: `struct U { c: vec4f } @group(0) @binding(16) var<uniform> u: U;
@group(1) @binding(64) var t: texture_2d_array<f32>; @group(1) @binding(65) var s: sampler;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, v.xy, i32(u.c.w), 0.0); }` },
  fs_3d: { stage: "fragment", outputs: [0], ubos: [0], textures: [{ slot: 0, dim: "3d" }], wgsl: `struct U { c: vec4f } @group(0) @binding(16) var<uniform> u: U;
@group(1) @binding(64) var t: texture_3d<f32>; @group(1) @binding(65) var s: sampler;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, vec3f(v.xy, u.c.z), 0.0); }` },
  fs_cube_array: { stage: "fragment", outputs: [0], ubos: [0], textures: [{ slot: 0, dim: "cube-array" }], wgsl: `struct U { c: vec4f } @group(0) @binding(16) var<uniform> u: U;
@group(1) @binding(64) var t: texture_cube_array<f32>; @group(1) @binding(65) var s: sampler;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, u.c.xyz, i32(u.c.w), 0.0); }` },
  // vertex input classes: declared float; a game may bind the colour as an integer format, which needs the variant
  vs_color4: { stage: "vertex", attributes: [0, 1], attributeTypes: { "0": "float", "1": "float" }, wgsl: `${VO} @vertex fn main(@location(0) pos: vec2f, @location(1) col: vec4f) -> VO { return VO(vec4f(pos, 0.0, 1.0), col); }`,
    variants: { "0:float,1:uint": `${VO} @vertex fn main(@location(0) pos: vec2f, @location(1) col: vec4u) -> VO { return VO(vec4f(pos, 0.0, 1.0), vec4f(col) / 255.0); }` } },
  vs_color4_novariant: { stage: "vertex", attributes: [0, 1], attributeTypes: { "0": "float", "1": "float" }, wgsl: `${VO} @vertex fn main(@location(0) pos: vec2f, @location(1) col: vec4f) -> VO { return VO(vec4f(pos, 0.0, 1.0), col); }` },
  // ---- compute ----
  // writes a quad's vertices (position, uv) into storage buffer 0, placed by uniform 0 and scaled by read-only storage buffer 1
  cs_quad: { stage: "compute", ubos: [0], storage: [{ slot: 0, write: true }, { slot: 1 }], wgsl: `struct U { xf: vec4f } @group(0) @binding(32) var<uniform> u: U;
@group(0) @binding(160) var<storage, read_write> verts: array<vec4f, 4>; @group(0) @binding(161) var<storage, read> scale: array<vec4f, 1>;
@compute @workgroup_size(4) fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = vec2f(f32(id.x & 1u), f32(id.x >> 1u));
  verts[id.x] = vec4f((c * 2.0 - 1.0) * u.xf.xy * scale[0].xy + u.xf.zw, c.x, 1.0 - c.y); }` },
  // stores a pattern into image 0 (RGBA8): red and green from the texel coordinate, blue from uniform 0
  cs_image: { stage: "compute", ubos: [0], images: [{ slot: 0, format: "rgba8unorm" }], wgsl: `struct U { c: vec4f } @group(0) @binding(32) var<uniform> u: U;
@group(1) @binding(272) var img: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(img, vec2i(id.xy), vec4f(f32(id.x) / 15.0, f32(id.y) / 15.0, u.c.z, 1.0)); }` },
  // reads a texture (slot 0) and writes its inverse into image 0
  cs_invert: { stage: "compute", textures: [{ slot: 0 }], images: [{ slot: 0, format: "rgba8unorm" }], wgsl: `@group(1) @binding(128) var t: texture_2d<f32>; @group(1) @binding(129) var s: sampler;
@group(1) @binding(272) var img: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(img, vec2i(id.xy), vec4f(1.0 - textureLoad(t, vec2i(id.xy), 0).rgb, 1.0)); }` },
  // a fragment shader reading a table from read-only storage buffer 0, indexed by fragment uniform 0
  fs_table: { stage: "fragment", outputs: [0], ubos: [0], storage: [{ slot: 0 }], wgsl: `struct U { c: vec4f } @group(0) @binding(16) var<uniform> u: U;
@group(0) @binding(144) var<storage, read> tab: array<vec4f, 4>;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return tab[u32(u.c.x)]; }` },
  // the demo's cube: position (vec3) + uv (vec2), vertex uniform buffer 0 = model-view-projection
  vs_cube: { stage: "vertex", attributes: [0, 1], ubos: [0], wgsl: `${VO} struct U { mvp: mat4x4f } @group(0) @binding(0) var<uniform> u: U;
@vertex fn main(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VO { return VO(u.mvp * vec4f(pos, 1.0), vec4f(uv, 0.0, 1.0)); }` },
};

export interface Shader { control: number; code: number; key: string }
export interface Image { width: number; height: number; bytesPerPixel: number; data: Uint8Array; px(x: number, y: number): number[] }
// A quad over the whole clip square: position, uv (uv 0,0 at the top left), and its indices
export const QUAD = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]);
export const QUAD_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

// A fragment shader with n uniform blocks (a colour each), which it adds up: for WebGPU's per-stage limits
export function fsManyUbos(n: number): ShaderInfo {
  return { stage: "fragment", outputs: [0], ubos: Array.from({ length: n }, (_, i) => i), uboSize: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, 16])),
    wgsl: `struct U { c: vec4f } ${Array.from({ length: n }, (_, i) => `@group(0) @binding(${16 + i}) var<uniform> u${i}: U;`).join(" ")}
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return vec4f((${Array.from({ length: n }, (_, i) => `u${i}.c`).join(" + ")}).rgb, 1.0); }` };
}

export class Env {
  g!: Guest; host!: GfxHost; G!: Game; wasm!: WebAssembly.Module;
  win = 0; wtex: number[] = []; W = 64; H = 64;
  private made = new Map<string, Shader>();
  quad = 0; quadIdx = 0;

  static async create(device: any, wasm: WebAssembly.Module, opts: { canvas?: any; w?: number; h?: number; cmdBytes?: number; glConventions?: boolean; host?: GfxHostOptions } = {}): Promise<Env> {
    const e = new Env();
    e.wasm = wasm;
    let host!: GfxHost;
    e.g = await Guest.create(wasm, { gfx_exec: (p, n) => host.exec(p >>> 0, n >>> 0) });
    host = e.host = new GfxHost(device, e.g.memory, { ...opts.host, canvas: opts.canvas, log: l => e.g.logs.push(l) });
    host.attach(e.g.x);
    e.G = new Game(e.g).init({ cmdBytes: opts.cmdBytes, glConventions: opts.glConventions });
    e.W = opts.w ?? 64; e.H = opts.h ?? 64;
    const w = e.G.window(e.W, e.H); e.win = w.win; e.wtex = w.tex;
    e.quad = e.G.put(QUAD); e.quadIdx = e.G.put(QUAD_INDICES);
    return e;
  }
  // A precompiled shader stage as a game ships it: a control section (0x880 bytes, its code length at +0x704) and a code
  // area. The key is computed here independently of the recorder (WebCrypto), and the WGSL registered under it
  async blobs(name: string): Promise<Shader> {
    const control = new Uint8Array(0x880), code = new Uint8Array(96 + name.length);
    for (let i = 0; i < control.length; i++) control[i] = (i * 31 + name.charCodeAt(i % name.length)) & 0xff;
    for (let i = 0; i < code.length; i++) code[i] = (i * 7 + name.charCodeAt(i % name.length) * 3) & 0xff;
    new DataView(control.buffer).setUint32(0x20, 0, true); new DataView(control.buffer).setUint32(0x704, code.length, true);
    const both = new Uint8Array(control.length + code.length); both.set(control); both.set(code, control.length);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", both));
    const key = Array.from(digest.subarray(0, 8), b => b.toString(16).padStart(2, "0")).join("");
    return { control: this.g.bytes(control), code: this.G.put(code), key };
  }
  async shader(name: string, as = name): Promise<Shader> {
    let s = this.made.get(as);
    if (!s) { s = await this.blobs(as); if (this.host.registerShader(s.key, { entry: "main", ...SHADERS[name] }) < 0) throw new Error(`registerShader ${name}`); this.made.set(as, s); }
    return s;
  }
  // Another fake guest and replayer on the same device (a scene that compares replayer options)
  sibling(host: GfxHostOptions): Promise<Env> { return Env.create(this.host.device, this.wasm, { host }); }
  async computeProgram(cs: string): Promise<number> { return this.G.program([await this.shader(cs)]); }
  async program(vs: string, fs: string): Promise<number> { return this.G.program([await this.shader(vs), await this.shader(fs)]); }

  // The commands most scenes start a frame with: targets, default state objects, the quad's vertex layout and buffer, a program
  frame(cmd: number, target: number, prog: number, depth = 0) {
    const G = this.G;
    G.targets(cmd, [target], depth);
    const st = G.defaultStates(cmd);
    G.vertexLayout(cmd, [{ format: FMT.RG32F, offset: 0 }, { format: FMT.RG32F, offset: 8 }], [{ stride: 16 }]);
    G.c("CommandBufferBindVertexBuffer", [cmd, 0, this.quad, QUAD.byteLength]);
    G.c("CommandBufferBindProgram", [cmd, prog, 3]);
    return st;
  }
  drawQuad(cmd: number) { this.G.c("CommandBufferDrawElements", [cmd, PRIM.TRIANGLES, 1 /* u16 */, 6, this.quadIdx]); }
  bindTexture(cmd: number, texId: number, sampId: number, slot = 0) { this.G.c("CommandBufferBindTexture", [cmd, STAGE.FRAGMENT, slot, this.G.handle(texId, sampId)]); }
  // Ends the recording, submits it and presents window image `index`
  finish(index: number, cmd = this.G.cmd) { const h = this.G.end(cmd); this.G.submit([h]); this.G.present(this.win, index); }
  async read(serial = this.host.lastPresented, level = 0, layer = 0): Promise<Image> {
    const r = await this.host.readTexture(serial, level, layer);
    return { ...r, px: (x, y) => Array.from(r.data.subarray((y * r.width + x) * r.bytesPerPixel, (y * r.width + x + 1) * r.bytesPerPixel)) };
  }
  serial(tex: number): number { const dv = this.g.dv; return dv.getUint32(tex + 120, true) + dv.getUint32(tex + 124, true) * 4294967296; }
  // Lets the GPU finish and the replayer's completion handlers run
  async settle() { await this.host.device.queue.onSubmittedWorkDone(); await new Promise(r => setTimeout(r, 0)); await this.host.device.queue.onSubmittedWorkDone(); await new Promise(r => setTimeout(r, 0)); }
  stat(i: number): number { return this.g.x.gfx_stat(i) >>> 0; }
}
