// The demo page (test/gfx/demo.html, `npm run gfx:demo`): a spinning textured cube. The "game" is the same fake guest
// as in the tests: every frame it writes its uniform memory, records NVN commands through nvn_call, submits and
// presents; the recorder lowers them and the replayer draws with WebGPU and blits the window texture to the canvas.
import { Env } from "./env.mts";
import { FMT, PRIM, STAGE, DEPTH_FUNC, FILTER } from "./nvn.mts";

const W = 640, H = 400, BG = [0.05, 0.07, 0.12, 1];
type M = Float32Array;
const mul = (a: M, b: M): M => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const perspective = (fov: number, aspect: number, n: number, f: number): M => { const t = 1 / Math.tan(fov / 2); return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, f / (n - f), -1, 0, 0, n * f / (n - f), 0]); };   // depth 0..1 (NVN_DEPTH_MODE_NEAR_IS_ZERO)
const translate = (x: number, y: number, z: number): M => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const rotY = (a: number): M => new Float32Array([Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]);
const rotX = (a: number): M => new Float32Array([1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1]);

function cube(): { vertices: Float32Array; indices: Uint16Array } {
  const faces = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
  const v: number[] = [], idx: number[] = [];
  faces.forEach(([n, u, w], f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) v.push(n[0] + a * u[0] + b * w[0], n[1] + a * u[1] + b * w[1], n[2] + a * u[2] + b * w[2], (a + 1) / 2, (1 - b) / 2);
    idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4 + 2, f * 4 + 1, f * 4 + 3);
  });
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}
// 8x8 texels: a checkerboard of four colours with a light border
function texture(): Uint8Array {
  const t = new Uint8Array(8 * 8 * 4), cols = [[230, 80, 60], [250, 200, 70], [70, 170, 240], [90, 210, 130]];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const edge = x === 0 || y === 0 || x === 7 || y === 7, c = edge ? [245, 245, 245] : cols[((x >> 1) + (y >> 1) * 2 + ((x ^ y) & 1) * 2) & 3];
    t.set([...c, 255], (y * 8 + x) * 4);
  }
  return t;
}

async function main() {
  const status = document.getElementById("status")!, canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const gpu = (navigator as any).gpu;
  if (!gpu) { status.textContent = "This browser has no WebGPU (navigator.gpu is missing)."; throw new Error("no WebGPU"); }
  const adapter = await gpu.requestAdapter(), device = await adapter.requestDevice();
  const wasm = await WebAssembly.compileStreaming(fetch("/build/gfx/gfx.wasm"));
  const e = await Env.create(device, wasm, { canvas, w: W, h: H }), G = e.G, cmd = G.cmd;
  const prog = await e.program("vs_cube", "fs_tex"), mesh = cube();
  const vb = G.put(mesh.vertices), ib = G.put(mesh.indices), mvp = G.put(new Float32Array(16));
  const depth = G.texture({ w: W, h: H, format: FMT.DEPTH24_STENCIL8 });
  const tex = G.texture({ w: 8, h: 8, format: FMT.RGBA8 }), texId = G.texId(tex), samp = G.sampId(FILTER.NEAREST, FILTER.NEAREST), texels = G.put(texture());
  const proj = perspective(Math.PI / 4, W / H, 0.1, 50);
  const demo = { frames: 0, check: async () => {
    const img = await e.read(), bg = BG.map(v => Math.round(v * 255)), seen = new Set<number>();
    let cubePx = 0, background = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const d = img.data;
      if (Math.abs(d[i] - bg[0]) <= 1 && Math.abs(d[i + 1] - bg[1]) <= 1 && Math.abs(d[i + 2] - bg[2]) <= 1) background++; else { cubePx++; seen.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | d[i + 2] >> 4); }
    }
    return { frames: demo.frames, width: img.width, height: img.height, cube: cubePx, background, colours: seen.size, red: e.g.red(), errors: e.host.stats.errors, draws: e.stat(1), passes: e.stat(0), calls: e.g.calls };
  } };
  (window as any).__demo = demo;
  const frame = (ms: number) => {
    const a = ms / 1000;
    new Float32Array(e.g.memory.buffer, mvp, 16).set(mul(proj, mul(translate(0, 0, -5.5), mul(rotY(a * 0.9), rotX(a * 0.6)))));
    const i = G.acquire(e.win);
    G.begin();
    if (demo.frames === 0) G.c("CommandBufferCopyBufferToTexture", [cmd, texels, tex, 0, e.g.u32([0, 0, 0, 8, 8, 1]), 0]);     // the texture upload, once
    G.targets(cmd, [e.wtex[i]], depth);
    const st = G.defaultStates(cmd);
    G.c("DepthStencilStateSetDepthTestEnable", [st.ds, 1]); G.c("DepthStencilStateSetDepthFunc", [st.ds, DEPTH_FUNC.LESS]); G.c("CommandBufferBindDepthStencilState", [cmd, st.ds]);
    G.clear(cmd, BG); G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0], [1.0]);
    G.c("CommandBufferSetViewport", [cmd, 0, 0, W, H]); G.c("CommandBufferSetScissor", [cmd, 0, 0, W, H]);
    G.vertexLayout(cmd, [{ format: FMT.RGB32F, offset: 0 }, { format: FMT.RG32F, offset: 12 }], [{ stride: 20 }]);
    G.c("CommandBufferBindVertexBuffer", [cmd, 0, vb, mesh.vertices.byteLength]);
    G.c("CommandBufferBindProgram", [cmd, prog, 3]);
    G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.VERTEX, 0, mvp, 64]);
    e.bindTexture(cmd, texId, samp);
    G.c("CommandBufferDrawElements", [cmd, PRIM.TRIANGLES, 1, 36, ib]);
    e.finish(i);
    e.g.top = top;               // the per-frame scratch of the fake guest is reused
    demo.frames++;
    if (demo.frames % 30 === 0 || demo.frames === 1) status.textContent = `frame ${demo.frames}: ${e.g.calls} NVN calls so far, ${e.stat(1)} draws in ${e.stat(0)} passes, ${e.g.x.gfx_pipeline_count()} pipeline, ${e.g.red().length} red lines`;
    requestAnimationFrame(frame);
  };
  const top = e.g.top;
  requestAnimationFrame(frame);
}
main().catch(err => { const s = document.getElementById("status"); if (s && !s.textContent) s.textContent = String(err); console.error(err); });
