// The runtime's graphics tests: guests that draw through NVN (test/runtime/src/cube.c, cube2.c), with the recorder in
// the process's memory and either the WebGPU replayer (browser: pixels are read back) or the null replayer (Node:
// everything but the drawing). Shared by run.mts and web/worker.ts; also used by the page (web/) for its demo.
import { Runtime, type RuntimeOptions, type RunResult } from "../../src/glue/rt_runtime.ts";
import { RtGfx } from "../../src/glue/rt_gfx.ts";
import { RtInput, BTN } from "../../src/glue/rt_input.ts";
import { attachHle } from "../../src/glue/hle_rt.ts";
import type { HleHost } from "../../src/glue/hle_host.ts";
import type { HleFront } from "../../src/glue/hle_rt.ts";
import type { ShaderInfo } from "../../src/glue/gfx_host.ts";
import type { Env, CaseResult } from "./cases.ts";
import { RtShaders, type ShaderOptions } from "../../src/glue/rt_shaders.ts";

// Hand-written WGSL standing in for the translation of the guests' shader "binaries" (binding convention and the
// position fix-up: src/gfx/README.md, "what the shader chain must emit")
const VO = `struct VO { @builtin(position) p: vec4f, @location(0) v: vec4f }
struct NxFix { fix: vec4f } @group(2) @binding(0) var<uniform> nx: NxFix;
fn fixup(q: vec4f) -> vec4f { var p = q; p.y *= nx.fix.y; p.z = p.z * nx.fix.z + p.w * nx.fix.w; return p; }`;
export const SHADERS: Record<string, ShaderInfo> = {
  vs_color: { stage: "vertex", attributes: [0, 1], fixup: true, wgsl: `${VO} @vertex fn main(@location(0) pos: vec2f, @location(1) col: vec3f) -> VO { return VO(fixup(vec4f(pos, 0.0, 1.0)), vec4f(col, 1.0)); }` } as ShaderInfo,
  fs_color: { stage: "fragment", outputs: [0], wgsl: `@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return v; }` } as ShaderInfo,
  vs_cube: { stage: "vertex", attributes: [0, 1], ubos: [0], fixup: true, wgsl: `${VO} struct U { mvp: mat4x4f } @group(0) @binding(0) var<uniform> u: U;
@vertex fn main(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VO { return VO(fixup(u.mvp * vec4f(pos, 1.0)), vec4f(uv, 0.0, 1.0)); }` } as ShaderInfo,
  fs_tex: { stage: "fragment", outputs: [0], textures: [{ slot: 0 }], wgsl: `@group(1) @binding(64) var t: texture_2d<f32>; @group(1) @binding(65) var s: sampler;
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f { return textureSample(t, s, v.xy); }` } as ShaderInfo,
};
// The key of the dummy shader blob the guests make for `name` (gfx.h shader_blob): sha256(control + code)[0..8]
export async function shaderKey(name: string): Promise<string> {
  const control = new Uint8Array(0x880), code = new Uint8Array(96 + name.length);
  for (let i = 0; i < control.length; i++) control[i] = (i * 31 + name.charCodeAt(i % name.length)) & 0xff;
  for (let i = 0; i < code.length; i++) code[i] = (i * 7 + name.charCodeAt(i % name.length) * 3) & 0xff;
  const dv = new DataView(control.buffer); dv.setUint32(0x20, 0, true); dv.setUint32(0x704, code.length, true);
  const both = new Uint8Array(control.length + code.length); both.set(control); both.set(code, control.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", both));
  return Array.from(digest.subarray(0, 8), b => b.toString(16).padStart(2, "0")).join("");
}
let keys: [string, string][] | undefined;
export async function demoShaders(): Promise<[string, ShaderInfo][]> {
  keys ??= await Promise.all(Object.keys(SHADERS).map(async n => [n, await shaderKey(n)] as [string, string]));
  return keys.map(([n, k]) => [k, SHADERS[n]]);
}

export interface Gpu { device: any; canvas?: any; nextFrame?: () => Promise<unknown>; requestDevice?: () => Promise<any>; adapter?: any }
export interface GfxProcess { rt: Runtime; gfx: RtGfx; hle: HleHost; input: RtInput; frameNs: bigint[]; shaders?: RtShaders }
export interface GfxBoot extends RuntimeOptions { frames: number; script?: string; gpu?: Gpu; raf?: boolean; unpaced?: boolean; nullReplayer?: boolean; shaders?: ShaderOptions; noDemoShaders?: boolean; onPresent?: (f: number, p: GfxProcess) => void;
  holdFences?: () => boolean; hleConfig?: Parameters<HleHost["config"]>[0]; front?: HleFront; setup?: (p: GfxProcess) => void;
  profile?: { bits: number };              // the game profile's graphics switches (src/gfx/profile.ts)
  display?: () => Promise<unknown> }       // a display's frames in place of the GPU's (a fake screen for the pacing tests)
// A process with graphics, the take-over table (nn::vi, nn::hid and the rest; docked) and the demo's shader library attached
export async function bootGfx(env: Env, files: { name: string; bytes: Uint8Array }[], o: GfxBoot): Promise<GfxProcess> {
  const rt = new Runtime(env.mods, o), frameNs: bigint[] = [];
  let p!: GfxProcess;
  const gpu = o.nullReplayer ? undefined : o.gpu;
  const gfx = new RtGfx(rt, env.mods.gfx!, { device: gpu?.device, canvas: gpu?.canvas, nextFrame: o.display ?? (o.raf ? gpu?.nextFrame : undefined), unpaced: o.unpaced, requestDevice: gpu?.requestDevice, holdFences: o.holdFences, profile: o.profile,
    onPresent: f => { frameNs.push(rt.guestNs()); o.onPresent?.(f, p); } });
  const hle = attachHle(rt, env.mods.hle!, { config: { opmode: 1, ...o.hleConfig }, gfx, front: o.front }), input = new RtInput(hle);
  gfx.onPresentQueued(f => input.frame(f));   // scripted steps are in frames
  p = { rt, gfx, hle, input, frameNs, shaders: o.shaders ? new RtShaders(gfx, o.shaders) : undefined };
  if (!o.noDemoShaders) for (const [key, info] of await demoShaders()) if (gfx.registerShader(key, info) < 0) throw new Error("registerShader failed");
  if (o.script) input.script(o.script, l => rt.log(l));
  o.setup?.(p);
  rt.register({ name: "demo_frames", fn: () => o.frames });
  if (!rt.loadNso(files)) throw new Error("load failed: " + rt.red.join(" | "));
  return p;
}

function fail(msg: string): never { throw new Error(msg); }
function eq(got: unknown, want: unknown, what: string): void {
  const str = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
  if (str(got) !== str(want)) fail(`${what}:\n--- got ---\n${str(got)}\n--- want ---\n${str(want)}`);
}
function ok(c: unknown, what: string): void { if (!c) fail(what); }
const hash = (d: Uint8Array) => { let h = 0x811c9dc5; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); };

export interface Shot { name: string; width: number; height: number; rgba: Uint8Array }
export interface GfxCase { name: string; fn: () => Promise<string[]> }
export const W = 480, H = 270;

export function gfxCases(env: Env, gpu: Gpu | undefined, shots: Shot[]): GfxCase[] {
  const list: GfxCase[] = [];
  const test = (name: string, fn: () => Promise<string[] | void>) => list.push({ name, fn: async () => (await fn()) ?? [] });
  const where = gpu ? "WebGPU" : "null replayer";
  const run = async (file: string, o: GfxBoot) => {
    const p = await bootGfx(env, [{ name: file, bytes: env.nso(file) }], { gpu, ...o });
    const r: RunResult = await p.rt.runAsync();
    if (r.state !== "Stopped" || r.stop?.kind !== "exit" || r.stop.code !== 0) fail(`${file}: expected Stopped(exit 0), got ${r.state} ${r.stop?.kind} ${r.stop?.fault?.detail ?? ""}\n${p.rt.stdout()}\n${p.rt.red.join("\n")}`);
    eq(p.rt.red, [], "red lines");
    return p;
  };
  const pixels = async (p: GfxProcess) => {
    await gpu!.device.queue.onSubmittedWorkDone();
    const img = await p.gfx.host.readTexture(p.gfx.host.lastPresented);
    eq([img.width, img.height, img.bytesPerPixel], [W, H, 4], "presented image");
    const px = (x: number, y: number) => Array.from(img.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
    return { data: img.data as Uint8Array, px };
  };
  const BG = [13, 18, 31, 255], near = (a: number[], b: number[], tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const fingerprint = (p: GfxProcess) => `${p.rt.stats.slices}/${p.rt.stats.svcs}/${p.rt.units}/${p.rt.guestNs()}/${p.gfx.stats.nvnCalls}`;

  test(`gfx cube (${where}): a guest gets NVN through nvnBootstrapLoader and nvnDeviceGetProcAddress, a window through nn::vi, and renders 12 frames paced at 60 Hz of guest time`, async () => {
    const p = await run("cube", { frames: 12 });
    eq(p.rt.stdout(), "cube: 12 frames, 12 pad reads, buttons seen 0x0\n", "stdout");
    const s = p.gfx.stats, x = p.gfx.x;
    eq([s.frames, s.acquires, s.acquireParked, s.finishes], [12, 12, 11, 1], "frames, acquires, parked acquires, QueueFinish");
    eq(s.syncWaits, 13, "SyncWait calls");
    if (gpu) ok(s.syncParked === 1, `the SyncWait on a fresh fence parked the thread until the GPU finished (${s.syncParked})`);
    eq([x.gfx_stat(1) >>> 0, x.gfx_stat(2) >>> 0, x.gfx_stat(5) >>> 0], [11, 0, 12], "draws issued, draws skipped, submissions");
    // each frame after the first is acquired exactly one refresh after the one before it
    const gaps = p.frameNs.slice(2).map((t, i) => Number(t - p.frameNs[i + 1]));
    ok(gaps.every(g => Math.abs(g - 16_666_667) < 200_000), "frame times (guest ns between presents): " + gaps.join(" "));
    const again = await run("cube", { frames: 12 });
    eq(fingerprint(again), fingerprint(p), "slices/SVCs/units/guest ns/NVN calls of a second run");
    return [`${s.nvnCalls} NVN calls through host stubs, ${p.rt.stats.hostCalls} host calls in all, ${s.syncWaits} SyncWait (${s.syncParked} parked), guest clock at the end ${(Number(p.rt.guestNs()) / 1e6).toFixed(2)} ms`,
      `identical on a second run: slices/SVCs/units/guest ns/NVN calls = ${fingerprint(p)}`];
  });
  // Frame pacing, on the guest clock: stress_gfx presents as fast as it can and asks for present interval 1, 2 and 3
  // for 100 frames each. What holds it is the acquire (rt_gfx.ts), for the interval the recorder answers
  // (src/gfx/window.ts presentInterval). Deterministic: the acquire wakes at exactly its slot of guest time
  test(`frame pacing on the guest clock (${where}): a guest presenting as fast as it can is held to its own present interval; to one frame a vsync with the profile's present_interval display; to a present cap of 60 or 30 whatever it asks`, async () => {
    const VS = 16_666_667;
    const pace = async (o: { bits?: number; cap?: number }) => {
      const p = await bootGfx(env, [{ name: "stress_gfx", bytes: env.nso("stress_gfx") }], { gpu, frames: 300, profile: o.bits ? { bits: o.bits } : undefined,
        setup: q => { q.rt.register({ name: "stress_mark", fn: () => {} }); if (o.cap) q.gfx.x.gfx_set_present_cap(o.cap); } });
      const r: RunResult = await p.rt.runAsync();
      eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], "how it ended: " + p.rt.red.slice(-3).join(" | ") + p.rt.stdout());
      // guest time between one present and the next, in vsyncs; frame i's interval was set at frame floor(i / 100) * 100
      const d = p.frameNs.slice(1).map((t, i) => Number(t - p.frameNs[i]));
      const off = Math.max(...d.map(v => Math.abs(v - Math.round(v / VS) * VS)));
      const out = { vsyncs: d.map(v => Math.round(v / VS)), off, ms: Number(/guest ms (\d+)/.exec(p.rt.stdout())![1]), parked: p.gfx.stats.acquireParked };
      if (gpu) p.rt.dispose();
      return out;
    };
    const runs = (v: number[]) => { const o: string[] = []; for (let i = 0, j = 0; i < v.length; i = j) { while (j < v.length && v[j] === v[i]) j++; o.push(`${j - i}x${v[i]}`); } return o.join(" "); };
    const game = await pace({}), display = await pace({ bits: 16 }), cap60 = await pace({ cap: 60 }), cap30 = await pace({ cap: 30 }), both = await pace({ bits: 16, cap: 30 });
    // 300 frames: the acquires of frames 1..99 wait 1 vsync, 100..199 wait 2, 200..299 wait 3
    eq(runs(game.vsyncs), "99x1 100x2 100x3", "the game's own interval: 60, 30 and 20 frames a second of guest time");
    eq(runs(display.vsyncs), "299x1", "present_interval display: one frame a vsync whatever the game asks");
    eq(runs(cap60.vsyncs), "299x1", "a cap of 60: interval 1");
    eq(runs(cap30.vsyncs), "299x2", "a cap of 30: interval 2, half the rate");
    eq(runs(both.vsyncs), "299x2", "the cap also holds in display mode");
    for (const [n, r] of Object.entries({ game, display, cap60, cap30 })) { ok(r.off < 1_000_000, `${n}: every present within 1 ms of a whole number of vsyncs after the one before (${r.off} ns)`); eq(r.parked, 299, `${n}: every acquire but the first parked`); }
    eq([Math.round(game.ms / 10), Math.round(display.ms / 10), Math.round(cap30.ms / 10)], [998, 498, 997], "guest time for the 300 frames, in 10 ms: 599, 299 and 598 vsyncs");
    return [`guest ms for 300 frames: the game's intervals ${game.ms}, display ${display.ms}, cap 60 ${cap60.ms}, cap 30 ${cap30.ms}; presents off a whole vsync by at most ${Math.max(game.off, display.off, cap30.off)} ns`];
  });
  // The same on the wall clock with a display that is not at 60 Hz: its frames come every 8 ms here (a 120 Hz screen
  // stood in for by a timer). A frame is shown on the first display frame at or after its slot, so the game still
  // gets 60 frames a second, and 30 at interval 2, not the display's 120
  test(`frame pacing on the wall clock with a 120 Hz display (${where}): a game at present interval 1 gets 60 frames a second, not the display's rate`, async () => {
    const display = () => new Promise<void>(r => setTimeout(r, 8));
    const t0 = performance.now();
    const p = await run("cube", { frames: 40, clock: "wall", display });
    const ms = performance.now() - t0, ideal = 39 * 16.667;
    eq(p.rt.stdout(), "cube: 40 frames, 40 pad reads, buttons seen 0x0\n", "stdout");
    ok(ms >= ideal * 0.97, `40 frames took ${ms.toFixed(0)} ms: faster than 60 a second (${ideal.toFixed(0)} ms)`);
    ok(ms < ideal * 2.5, `40 frames took ${ms.toFixed(0)} ms: far slower than 60 a second`);
    return [`40 frames in ${ms.toFixed(0)} ms on a display with a frame every 8 ms = ${(39000 / ms).toFixed(1)} frames/s`];
  });
  test(`gfx input (${where}): nn::hid npad reads see scripted input (buttons, stick direction bits)`, async () => {
    const p = await run("cube", { frames: 12, script: "3:Right~4,8:L100/0~2,9:A,10:Bogus" }).catch(e => e as Error);
    ok(p instanceof Error && /cannot read step .{1,2}10:Bogus/.test(p.message), "a step that cannot be read is red");
    const q = await run("cube", { frames: 12, script: "3:Right~4,8:L100/0~2,9:A" });
    const want = BTN.Right | BTN.A | 1 << 18;
    eq(q.rt.stdout(), `cube: 12 frames, 12 pad reads, buttons seen 0x${want.toString(16)}\n`, "stdout");
    ok(q.input.publishes >= 6, "snapshots published to the table: " + q.input.publishes);
    return [q.rt.logs.filter(l => l.startsWith("hid ")).join("; ")];
  });
  test(`gfx two threads (${where}): one renders, one updates the uniforms under a mutex, an event per frame; identical across runs and budgets`, async () => {
    const lines: string[] = [], seen = new Set<string>();
    for (const budget of [100000, 100000, 700, 50]) {
      const frames: string[] = [];
      const p = await run("cube2", { frames: 10, budget, onPresent: gpu ? undefined : (f, p) => frames.push(String(p.rt.guestNs())) });
      eq(p.rt.stdout(), "cube2: 10 frames, 10 uniform updates by the second thread\n", `stdout (budget ${budget})`);
      let sig = frames.join(",");
      if (gpu) sig = hash((await pixels(p)).data);
      seen.add(sig);
      lines.push(`budget ${String(budget).padStart(6)}: ${p.rt.stats.slices} slices, ${gpu ? "last frame's pixels " + sig : "frame times equal"}`);
    }
    if (gpu) eq(seen.size, 1, "the last frame's pixels differ between runs or budgets: " + [...seen].join(" "));
    return lines;
  });
  if (!gpu) return list;

  test("gfx pixels: frame 0 is the clear colour everywhere", async () => {
    const { data, px } = await pixels(await run("cube", { frames: 1 }));
    for (let i = 0; i < data.length; i += 4) if (!near([data[i], data[i + 1], data[i + 2], data[i + 3]], [0, 64, 128, 255])) fail(`pixel ${i / 4} is ${data.subarray(i, i + 4)}`);
    return [`all ${W * H} pixels are ${px(0, 0)}`];
  });
  test("gfx pixels: frame 1 is the triangle (red top, green bottom left, blue bottom right) on the background", async () => {
    const p = await run("cube", { frames: 2 }), { data, px } = await pixels(p);
    for (const [x, y] of [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3], [W / 2, H - 5]]) ok(near(px(x, y), BG), `background at ${x},${y}: ${px(x, y)}`);
    const top = px(W / 2, Math.round(H * 0.17)), bl = px(Math.round(W * 0.17), Math.round(H * 0.85)), br = px(Math.round(W * 0.83), Math.round(H * 0.85)), mid = px(W / 2, Math.round(H * 0.6));
    ok(top[0] > 180 && top[1] < 60 && top[2] < 60, "top vertex is red: " + top);
    ok(bl[1] > 180 && bl[0] < 60 && bl[2] < 60, "bottom left is green: " + bl);
    ok(br[2] > 180 && br[0] < 60 && br[1] < 60, "bottom right is blue: " + br);
    ok(mid[0] > 40 && mid[1] > 40 && mid[2] > 40, "the middle mixes all three: " + mid);
    let inside = 0; for (let i = 0; i < data.length; i += 4) if (!near([data[i], data[i + 1], data[i + 2], 255], BG)) inside++;
    const area = 0.5 * (0.8 * W) * (0.8 * H);
    ok(Math.abs(inside - area) < area * 0.03, `triangle pixels ${inside}, expected about ${area}`);
    shots.push({ name: "triangle", width: W, height: H, rgba: data });
    return [`${inside} triangle pixels (geometry says ${area}); top ${top}, bottom left ${bl}, bottom right ${br}`];
  });
  test("gfx pixels: the textured cube after 12 frames: depth-tested faces in the texture's colours, deterministic, and turned by scripted input", async () => {
    const shot = async (script?: string) => {
      const p = await run("cube", { frames: 12, script }), { data, px } = await pixels(p);
      let cube = 0; const fam = new Set<number>();
      for (let i = 0; i < data.length; i += 4) if (!near([data[i], data[i + 1], data[i + 2], 255], BG)) { cube++; fam.add((data[i] >> 5) << 6 | (data[i + 1] >> 5) << 3 | data[i + 2] >> 5); }
      return { p, data, px, cube, fam };
    };
    const a = await shot();
    for (const [x, y] of [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3]]) ok(near(a.px(x, y), BG), `background at ${x},${y}: ${a.px(x, y)}`);
    ok(!near(a.px(W / 2, H / 2), BG), "the cube covers the centre: " + a.px(W / 2, H / 2));
    ok(a.cube > W * H * 0.08 && a.cube < W * H * 0.5, `cube pixels ${a.cube} of ${W * H}`);
    // the texture has four colours and a near-white border: with nearest filtering only those appear
    const palette = [[230, 80, 60], [250, 200, 70], [70, 170, 240], [90, 210, 130], [245, 245, 245]];
    let off = 0; const used = new Set<number>();
    for (let i = 0; i < a.data.length; i += 4) {
      const c = [a.data[i], a.data[i + 1], a.data[i + 2]];
      if (near([...c, 255], BG)) continue;
      const k = palette.findIndex(q => near(c, q, 3));
      if (k < 0) off++; else used.add(k);
    }
    eq(used.size, 5, "palette colours seen");
    ok(off === 0, `${off} cube pixels are not a texture colour`);
    const b = await shot(), c = await shot("4:Right~6"), d = await shot("4:Right~6"), e = await shot("4:L-100/0~6");
    eq(hash(b.data), hash(a.data), "the same run again");
    ok(hash(c.data) !== hash(a.data), "holding Right for 6 frames did not change the picture");
    eq(hash(d.data), hash(c.data), "the same scripted input again");
    ok(hash(e.data) !== hash(a.data) && hash(e.data) !== hash(c.data), "the left stick turns it the other way");
    shots.push({ name: "cube", width: W, height: H, rgba: a.data }, { name: "cube_turned", width: W, height: H, rgba: c.data });
    return [`${a.cube} cube pixels, 5 texture colours, 0 others; pixel hash ${hash(a.data)} twice; with "4:Right~6" ${hash(c.data)} twice; with "4:L-100/0~6" ${hash(e.data)}`,
      `texture uploads from guest pool memory: ${a.p.gfx.x.gfx_stat(8) >>> 0}, pipelines ${a.p.gfx.x.gfx_pipeline_count()}`];
  });
  test("gfx wall clock: frames are paced by requestAnimationFrame, guest threads park instead of spinning, and the loop returns to the event loop", async () => {
    let turns = 0; const timer = setInterval(() => turns++, 1);
    const t0 = performance.now();
    const p = await run("cube", { frames: 40, clock: "wall", raf: true });
    const ms = performance.now() - t0;
    clearInterval(timer);
    eq(p.rt.stdout(), "cube: 40 frames, 40 pad reads, buttons seen 0x0\n", "stdout");
    // every acquire after the first is held for its display frame unless the frame before it took past its slot (a
    // slow SwiftShader frame on a busy machine: 38 parked and 1 late, seen once); a few late ones are the host's
    const { acquireParked: parked, acquireLate: late } = p.gfx.stats;
    ok(parked + late === 39 && late <= 4, `parked acquires ${parked}, at or past their slot ${late}, of 39`);
    ok(turns > 20, `the event loop got ${turns} timer turns while the guest ran`);
    const busy = p.rt.stats.runMs;
    ok(busy < ms * 0.8, `run loop busy ${busy.toFixed(0)} ms of ${ms.toFixed(0)} ms: it spins`);
    return [`40 frames in ${ms.toFixed(0)} ms = ${(39000 / ms).toFixed(1)} frames/s; ${parked} acquires parked, ${late} late; run loop busy ${busy.toFixed(0)} ms (${(busy / ms * 100).toFixed(0)} %), ${turns} timer turns of the event loop meanwhile, ${p.rt.stats.slices} slices`];
  });
  test("gfx speed: the cube guests unpaced on the wall clock (an acquire waits only for the GPU): frames, guest instructions, and where a frame's time goes", async () => {
    const lines: string[] = [], N = 300;
    for (const file of ["cube", "cube2"]) {
      // the instruction count of the same N frames: single-instruction mode makes a budget unit one instruction
      const counted = await run(file, { frames: N, maxInsns: 1, budget: 1 << 20, nullReplayer: true });
      const insns = counted.rt.units;
      const t0 = performance.now();
      const p = await run(file, { frames: N, clock: "wall", unpaced: true });
      const ms = performance.now() - t0, loop = p.rt.stats.runMs, host = p.rt.times.hostMs, exec = p.gfx.times.execMs, tr = p.rt.a64.translateNs / 1e6;
      const guest = loop - host - tr, per = (v: number) => (v / N).toFixed(3);
      lines.push(`${file}: ${N} frames in ${ms.toFixed(0)} ms = ${(N * 1000 / ms).toFixed(0)} frames/s; ${insns} guest instructions (${Math.round(insns / N)} per frame) = ${(insns / guest / 1000).toFixed(1)} M insn/s of translated-code time, ${(insns / ms / 1000).toFixed(2)} M insn/s of wall time`,
        `  per frame: ${per(ms)} ms wall = translated code + SVCs ${per(guest)} ms, host calls ${per(host)} ms (NVN recorder and other host functions ${per(host - exec)} ms, WebGPU calls in the replayer ${per(exec)} ms), translation ${per(tr)} ms, waiting for the GPU and the event loop ${per(ms - loop)} ms; ${Math.round(p.gfx.stats.nvnCalls / N)} NVN calls and ${Math.round(p.rt.stats.hostCalls / N)} host calls per frame`);
    }
    return lines;
  });
  return list;
}

export async function runGfxCases(env: Env, gpu: Gpu | undefined, only: string | undefined, shots: Shot[], report: (r: CaseResult) => void): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  if (!env.mods.gfx || !env.haveGfxGuests) {
    const r = { name: "gfx: SKIPPED, the graphics guests were not built (nxnative's nvn.h was not found; set NXNATIVE_NVN_INCLUDE)", ok: true, why: "", info: [], ms: 0 };
    out.push(r); report(r); return out;
  }
  for (const c of gfxCases(env, gpu, shots)) {
    if (only && !c.name.includes(only)) continue;
    const t0 = performance.now();
    let r: CaseResult;
    try { const info = await c.fn(); r = { name: c.name, ok: true, why: "", info, ms: performance.now() - t0 }; }
    catch (e) { r = { name: c.name, ok: false, why: e instanceof Error ? (e.stack ?? e.message) : String(e), info: [], ms: performance.now() - t0 }; }
    out.push(r); report(r);
  }
  return out;
}
