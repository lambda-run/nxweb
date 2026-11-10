// The test environment of one scene (browser): a fresh fake guest with the recorder in it, the WebGPU replayer, a
// small "game" (nvn.mts), precompiled-shader stand-ins, and pixel readback. Shared by the scenes and the demo.
import { Guest } from "./guest.mts";
import { Game, FMT, STAGE, PRIM } from "./nvn.mts";
import { GfxHost, type ShaderInfo } from "../../src/glue/gfx_host.ts";

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
  // the demo's cube: position (vec3) + uv (vec2), vertex uniform buffer 0 = model-view-projection
  vs_cube: { stage: "vertex", attributes: [0, 1], ubos: [0], wgsl: `${VO} struct U { mvp: mat4x4f } @group(0) @binding(0) var<uniform> u: U;
@vertex fn main(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VO { return VO(u.mvp * vec4f(pos, 1.0), vec4f(uv, 0.0, 1.0)); }` },
};

export interface Shader { control: number; code: number; key: string }
export interface Image { width: number; height: number; bytesPerPixel: number; data: Uint8Array; px(x: number, y: number): number[] }
// A quad over the whole clip square: position, uv (uv 0,0 at the top left), and its indices
export const QUAD = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]);
export const QUAD_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

export class Env {
  g!: Guest; host!: GfxHost; G!: Game;
  win = 0; wtex: number[] = []; W = 64; H = 64;
  private made = new Map<string, Shader>();
  quad = 0; quadIdx = 0;

  static async create(device: any, wasm: WebAssembly.Module, opts: { canvas?: any; w?: number; h?: number; cmdBytes?: number; glConventions?: boolean } = {}): Promise<Env> {
    const e = new Env();
    let host!: GfxHost;
    e.g = await Guest.create(wasm, { gfx_exec: (p, n) => host.exec(p >>> 0, n >>> 0) });
    host = e.host = new GfxHost(device, e.g.memory, { canvas: opts.canvas, log: l => e.g.logs.push(l) });
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
