// Scenes of `npm run gfx:test` (browser) for NVN2 mesh shading (src/gfx/lower.ts meshDraw, src/shaders/meshstage.ts, GfxHost "mesh draws"): task and mesh
// shaders written here in the form naga gives the translator's compute output (one workgroup array of words, the stage memory, at the offsets meshStage
// computes from a control section and SPH made here), wrapped as the shader chain wraps them, drawn direct and indirect. Checked on pixels.
import { Env } from "./env.mts";
import { type Scene, T, ubo } from "./scenes.mts";
import { meshStage, wrapStage, type MeshStage } from "../../src/shaders/meshstage.ts";
import type { ShaderInfo } from "../../src/glue/gfx_host.ts";

const BLACK = [0, 0, 0, 255], RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255];
// An NVN2 control section of a task (6) or mesh (7) shader and its code area's SPH (position and attribute 0 enabled)
function stageOf(kind: 6 | 7, o: { threads?: number; payload?: number; task?: boolean; maxV?: number; maxP?: number } = {}): MeshStage {
  const ctl = new Uint8Array(0x6c), dv = new DataView(ctl.buffer), area = new Uint8Array(0x80);
  ctl[0x56] = kind; dv.setUint16(0x58, o.threads ?? 32, true); dv.setUint16(0x5a, o.payload ?? 0, true); ctl[0x5e] = o.task ? 1 : 0; ctl[0x5f] = 3;
  dv.setUint16(0x60, o.maxV ?? 4, true); dv.setUint16(0x62, o.maxP ?? 2, true);
  area[0x35] = 0xf0; area[0x36] = 0x0f;
  return meshStage(ctl, area);
}
const naga = (words: number, body: string) => `var<workgroup> global: array<u32, ${words}>;
var<private> lid_1: u32;
fn main_1() {
    if (lid_1 != 0u) { return; }
${body}
    return;
}

@compute @workgroup_size(32, 1, 1)
fn main(@builtin(local_invocation_index) param: u32) {
    lid_1 = param;
    main_1();
}
`;
// A mesh shader's body: one quad (4 vertices, 2 triangles) from x0, y0 (NDC, 1 wide and h high) with colour c, all WGSL expressions
function quad(m: MeshStage, x0: string, y0: string, c: string[], h = 1): string {
  const o = m.layout[2] >> 2, p = m.layout[3] >> 2, f = (s: string) => `bitcast<u32>(f32(${s}))`;
  let s = `    let x0 = ${x0}; let y0 = ${y0};\n`;
  [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([dx, dy], v) => {
    [`x0 + ${dx}.0`, `y0 + ${dy * h}.0`, "0.5", "1.0", ...c].forEach((e, k) => { s += `    global[${o + k * 32 + v}] = ${f(e)};\n`; });
  });
  return s + `    global[${p}] = 2u << 24u;\n    global[${p + 1}] = 0x02020100u;\n    global[${p + 2}] = 0x0301u;\n`;
}
async function register(e: Env, name: string, m: MeshStage, raw: string) {
  const s = await e.blobs(name), info: ShaderInfo = { stage: m.kind === "ts" ? "task" : "mesh", entry: "main", wgsl: wrapStage(raw, m), mesh: m };
  if (e.host.registerShader(s.key, info) < 0) throw new Error(`registerShader ${name}`);
  return s;
}
const words = (m: MeshStage) => m.shared + 3 >> 2;
function begin(e: Env, prog: number, bits: number) {
  const G = e.G, cmd = G.cmd, i = G.acquire(e.win);
  G.begin(); G.targets(cmd, [e.wtex[i]], 0); G.defaultStates(cmd); G.clear(cmd, [0, 0, 0, 1]);
  G.c("CommandBufferBindProgram", [cmd, prog, bits]);
  return i;
}

export const scenes6: Scene[] = [
  { name: "mesh shading: a mesh shader's quads drawn from its outputs (DrawMeshTasks, direct and indirect, first honoured), a task shader launching mesh workgroups with its payload, geometry-stage bindings reported", async run(e, t) {
    const G = e.G, cmd = G.cmd, fs = await e.shader("fs_color");
    // a mesh shader alone: workgroup w draws x -1 + w .. w, all of y, colour (1 - w, w, 0)
    const ms = stageOf(7);
    t.eq([ms.layout, ms.shared], [[0, 16, 16, 1040], 1140], "the stage memory of 4 vertices and 2 triangles of 8 words: as dmsh_meshstage.memory");
    const msq = await register(e, "ms_quad", ms, naga(words(ms), `    let w = f32(global[0]);\n` + quad(ms, "-1.0 + w", "-1.0", ["1.0 - w", "w", "0.0", "1.0"], 2)));
    const prog = G.program([msq, fs]);
    let i = begin(e, prog, 0x82);
    G.c("CommandBufferBindUniformBuffer", [cmd, 2, 0, ubo(e, [1, 1, 1, 1]), 16]);       // the geometry stage: kept, reported
    G.c("CommandBufferDrawMeshTasks", [cmd, 0, 2]);
    e.finish(i);
    let img = await e.read();
    t.rect(img, 0, 0, 32, 64, RED, "mesh workgroup 0: the left half"); t.rect(img, 32, 0, 64, 64, GREEN, "mesh workgroup 1: the right half");
    // indirect: {count 1, first 1} in guest memory, read on the GPU
    const rec = G.put(new Uint32Array([1, 1, 0, 0]));
    i = begin(e, prog, 0x82);
    G.c("CommandBufferDrawMeshTasksIndirect", [cmd, rec]);
    e.finish(i);
    img = await e.read();
    t.rect(img, 0, 0, 32, 64, BLACK, "the indirect draw's one workgroup is number 1 (first): nothing left"); t.rect(img, 32, 0, 64, 64, GREEN, "workgroup 1: the right half");
    // a task shader: task t (of 2) launches 2 mesh workgroups and passes t in its payload; launch x of task t draws the quad at (x, t): colour (x, t, 1)
    const ts = stageOf(6, { payload: 32 }), msT = stageOf(7, { payload: 32, task: true });
    const tsq = await register(e, "ts_grid", ts, naga(words(ts), `    global[${(ts.layout[2] >> 2) + 1}] = 2u;\n    global[${(ts.layout[2] >> 2) + 4}] = global[0];\n`));
    const msg = await register(e, "ms_grid", msT, naga(words(msT), `    let x = f32(global[0]); let tk = f32(global[${(msT.layout[1] >> 2) + 4}]);\n` + quad(msT, "-1.0 + x", "-1.0 + tk", ["x", "tk", "1.0", "1.0"])));
    const prog2 = G.program([tsq, msg, fs]);
    i = begin(e, prog2, 0xc2);
    G.c("CommandBufferDrawMeshTasks", [cmd, 0, 2]);
    e.finish(i);
    img = await e.read();
    t.rect(img, 0, 32, 32, 64, [0, 0, 255, 255], "task 0, launch 0: bottom left"); t.rect(img, 32, 32, 64, 64, [255, 0, 255, 255], "task 0, launch 1: bottom right");
    t.rect(img, 0, 0, 32, 32, [0, 255, 255, 255], "task 1, launch 0: top left"); t.rect(img, 32, 0, 64, 32, [255, 255, 255, 255], "task 1, launch 1: top right");
    await e.settle(); await e.settle();
    t.eq([e.stat(21), e.stat(22), e.stat(23), e.stat(24), e.host.stats.meshDraws, e.host.stats.meshFailed], [3, 1, 1, 0, 3, 0], "3 mesh draws, 1 indirect, 1 with a task shader, none skipped or failed");
    const logs = e.g.logs.join("\n");
    t.ok(/mesh draw 1: \{count 2, first 0\}, 2 output slots drawn \(12 vertices\)/.test(logs), `the first mesh draw's counts as the GPU had them are logged: ${logs}`);
    t.ok(/mesh draw 2: \{count 1, first 1\}, 1 output slots drawn \(6 vertices\) \(indirect/.test(logs), "the indirect draw's counts are the GPU's");
    t.ok(/mesh draw 3: \{count 2, first 0\}, tasks launched up to 2 mesh workgroups each, 4 output slots drawn/.test(logs), "the task draw's launches");
    t.ok(/\[RED\] a resource is bound to the geometry stage/.test(logs), "the geometry-stage binding is reported");
    t.ok(!/uniform buffer bound to a geometry or tessellation stage/.test(logs), "the old line is gone");
  } },
];
