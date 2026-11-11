// NVN2 task and mesh shaders on WebGPU, which has neither stage (nxnative: dm/gfx/tools/dmsh_meshstage.py runs them as compute inside a Metal object / mesh function).
// Here each runs as a compute pass of its own and the mesh shader's outputs are drawn by a vertex shader that pulls them from a storage buffer:
//   task  (optional)  one workgroup per task: its payload and launch count go to the task buffer (group 2 binding 2), the largest count to the draw's control words
//   mesh              one workgroup per launched mesh workgroup: its stage memory's outputs (attribute blocks, primitive count and index bytes) go to its slot of the
//                     output buffer (group 2 binding 1), in the hardware's order (task-major, then launch)
//   draw              maxP * verts vertices a slot (pullVertexShader): a primitive past the slot's count is degenerate
// The translator (job stage_memory, InstEmitAmpereMem.cs AIsberd / AStageOut) reads a task or mesh shader as compute with its stage memory in shared memory at the
// offsets of meshMemory; wrapStage gives naga's compute entry a prologue (the workgroup's number, the payload) and an epilogue (the outputs to the buffers).
// The control words of one draw (group 2 binding 0, CTL_WORDS words, written by the replayer and its helper passes, src/glue/gfx_host.ts):
//   0 count  1 first (NVN's {count, first})  2..4 the first grid (tasks, or mesh workgroups with no task)  5 the largest launch count (atomic)  6..8 the mesh grid after a task
//   9 slots drawn  10 1 when the slots were cut to the capacity  12..15 the draw's indirect arguments  16 slot capacity  17 task capacity  19 words a task in the
//   task buffer (1 + the task's payload words)  20 vertices a slot
// No Node or DOM API.
export const CTL_WORDS = 64, GRID = 65535;
const u16 = (b: Uint8Array, o: number) => b[o] | b[o + 1] << 8;
const u32 = (b: Uint8Array, o: number) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const WORKGROUP = 0, INPUT = 0x10, BLOCK = 32;

// A component of the attribute area: n = -2 the point size, -1 the position, else generic attribute n; c its component
export interface Comp { n: number; c: number }
export interface MeshStage {
  kind: "ts" | "ms"; threads: number; payload: number;
  task?: boolean; verts?: number; maxV?: number; maxP?: number; vertex?: Comp[]; primitive?: Comp[];
  layout: number[]; shared: number;       // the translator's stage_memory (byte offsets of the workgroup's number, the input, the outputs, the primitive bytes) and shared bytes
}
// dmsh_meshstage.sph_outputs: the components an SPH's output map enables, in the attribute area's order
export function sphOutputs(sph: Uint8Array): Comp[] {
  const out: Comp[] = [];
  if (sph[0x35] >> 3 & 1) out.push({ n: -2, c: 0 });
  for (let c = 0; c < 4; c++) if (sph[0x35] >> (4 + c) & 1) out.push({ n: -1, c });
  for (let n = 0; n < 32; n++) for (let c = 0; c < 4; c++) if (sph[0x36 + (n >> 1)] >> (4 * (n & 1) + c) & 1) out.push({ n, c });
  return out;
}
// dmsh_meshstage.info + memory: the stage's facts from its control section and whole code area
export function meshStage(ctl: Uint8Array, area: Uint8Array): MeshStage {
  const kind = ctl[0x56] === 6 ? "ts" : ctl[0x56] === 7 ? "ms" : null;
  if (!kind || ctl.length < 0x6c) throw new Error("not an NVN2 task or mesh control section");
  const threads = u16(ctl, 0x58), payload = u16(ctl, 0x5a), out = INPUT + (payload + 15 & ~15);
  if (!threads) throw new Error(`an NVN2 ${kind === "ts" ? "task" : "mesh"} shader of 0 threads (control +0x58)`);
  if (kind === "ts") return { kind, threads, payload, layout: [WORKGROUP, INPUT, out, out + payload], shared: out + (payload + 3 & ~3) };
  const maxV = u16(ctl, 0x60), maxP = u16(ctl, 0x62), verts = ctl[0x5f] || 3, at = ctl[0x68] & 0x80 ? u32(ctl, 0x64) : 0;
  if (area.length < 0x80 || (at && at + 0x80 > area.length)) throw new Error(`a mesh shader's code area (${area.length} bytes) holds no SPH${at ? ` at +0x${at.toString(16)} (its per-primitive one)` : ""}`);
  const vertex = sphOutputs(area.subarray(0, 0x80)), primitive = at ? sphOutputs(area.subarray(at, at + 0x80)).filter(x => x.n >= 0) : [];
  if (verts > 3) throw new Error(`a mesh shader with ${verts} vertices a primitive (control +0x5f): 1, 2 or 3`);
  const vb = Math.ceil(Math.max(maxV, 1) / BLOCK), pb = Math.ceil(Math.max(maxP, 1) / BLOCK);
  const prim = out + Math.max(vb * vertex.length + pb * primitive.length, 1) * BLOCK * 4;
  return { kind, threads, payload, task: ctl[0x5e] !== 0, verts, maxV, maxP, vertex, primitive, layout: [WORKGROUP, INPUT, out, prim], shared: prim + (4 + verts * pb * BLOCK + 3 & ~3) };
}
// dmsh_meshstage.own_shared: LDS, STS or ATOMS would lie over the stage memory
export function ownShared(code: Uint8Array): boolean {
  for (let o = 0; o + 15 < code.length; o += 16) if ([0x984, 0x388, 0x988, 0x38c, 0x98c, 0xf8c].includes(u16(code, o) & 0xfff)) return true;
  return false;
}
// The words of one output slot (the stage memory from the outputs to its end) and where things are in it
export function slotWords(m: MeshStage) { return (m.shared - m.layout[2]) / 4; }
export function taskStride(m: MeshStage) { return 1 + (m.payload + 3 >> 2); }

// naga's compute entry: [whole text, workgroup size, parameters, body] and where it starts
function entryPoint(wgsl: string): (string[] & { index: number }) | null {
  const at = /@compute\s+@workgroup_size\(([^)]*)\)\s*fn\s+main\s*\(/.exec(wgsl);
  if (!at) return null;
  let d = 1, i = at.index + at[0].length;
  for (; i < wgsl.length && d; i++) d += wgsl[i] === "(" ? 1 : wgsl[i] === ")" ? -1 : 0;
  const params = wgsl.slice(at.index + at[0].length, i - 1), open = wgsl.indexOf("{", i), close = wgsl.indexOf("\n}", open);
  if (open < 0 || close < 0 || wgsl.slice(i, open).trim()) return null;
  return Object.assign([wgsl.slice(at.index, close + 2), at[1], params, wgsl.slice(open + 1, close)], { index: at.index });
}
// naga's compute entry, wrapped. The stage memory is the module's one workgroup array (atomic when the translator stores bytes through a compare-and-swap helper)
export function wrapStage(wgsl: string, m: MeshStage): string {
  const mem = /var<workgroup>\s+(\w+)\s*:\s*array<(atomic<u32>|u32),\s*(\d+)u?>\s*;/.exec(wgsl);
  if (!mem) throw new Error(`${m.kind}: no workgroup array of words (the stage memory) in the translated shader`);
  if ([...wgsl.matchAll(/var<workgroup>/g)].length !== 1) throw new Error(`${m.kind}: workgroup memory besides the stage memory`);
  if (+mem[3] * 4 < m.shared) throw new Error(`${m.kind}: the stage memory has ${+mem[3] * 4} bytes, its layout ${m.shared}`);
  const name = mem[1], atomic = mem[2] !== "u32", L = (i: string) => atomic ? `atomicLoad(&${name}[${i}])` : `${name}[${i}]`, S = (i: string, v: string) => atomic ? `atomicStore(&${name}[${i}], ${v});` : `${name}[${i}] = ${v};`;
  const ep = entryPoint(wgsl);
  if (!ep) throw new Error(`${m.kind}: naga's compute entry point main is not in the form the wrapper expects`);
  const calls = [...ep[3].matchAll(/^\s*(\w+)\(\);\s*$/gm)];
  if (calls.length !== 1) throw new Error(`${m.kind}: the entry point does not call one body function`);
  const params = ep[2].trim() ? ep[2].trim().replace(/,\s*$/, "") + ", " : "";
  const lidB = /@builtin\(local_invocation_index\)\s+(\w+)/.exec(params)?.[1], wgB = /@builtin\(workgroup_id\)\s+(\w+)/.exec(params)?.[1];
  const lid = lidB ?? "nx_lid", wid = wgB ?? "nx_wid";
  const sig = params + (lidB ? "" : "@builtin(local_invocation_index) nx_lid: u32, ") + (wgB ? "" : "@builtin(workgroup_id) nx_wid: vec3<u32>, ");
  const [wg, inp, out, prim] = m.layout.map(b => b >> 2), T = m.threads, call = calls[0][0].trim();
  const pre = ep[3].slice(0, calls[0].index).replace(/^\n/, ""), post = ep[3].slice(calls[0].index! + calls[0][0].length);
  let head = `@group(2) @binding(0) var<storage, read_write> nx_ctl: array<atomic<u32>, ${CTL_WORDS}>;\nvar<workgroup> nx_u: u32;\n`, body: string;
  if (m.kind === "ts") {
    const TS = taskStride(m), pay = TS - 1;
    head += `@group(2) @binding(2) var<storage, read_write> nx_task: array<u32>;\n`;
    body = `    if (${lid} == 0u) { nx_u = min(atomicLoad(&nx_ctl[0]), atomicLoad(&nx_ctl[17])); }
    let nx_n = workgroupUniformLoad(&nx_u);
    let nx_t = ${wid}.x + ${wid}.y * ${GRID}u;
    if (nx_t >= nx_n) { return; }
    if (${lid} == 0u) { ${S(`${wg}`, `atomicLoad(&nx_ctl[1]) + nx_t`)} }
    workgroupBarrier();
${pre}    ${call}
    workgroupBarrier();
    for (var i = ${lid}; i < ${pay}u; i += ${T}u) { nx_task[nx_t * ${TS}u + 1u + i] = ${L(`${out}u + i`)}; }
    if (${lid} == 0u) { let n = ${L(`${out + 1}u`)}; nx_task[nx_t * ${TS}u] = n; atomicMax(&nx_ctl[5], n); }
${post}`;
  } else {
    const SW = slotWords(m);
    head += `@group(2) @binding(1) var<storage, read_write> nx_out: array<u32>;\n`;
    if (m.task) {
      // the task's payload size is the task shader's: its words a task (1 + payload words) are control word 19, written by the replayer
      const own = (m.payload + 3) >> 2;
      head += `@group(2) @binding(2) var<storage, read> nx_task: array<u32>;\n`;
      // slot | 1 << 31 when the workgroup is one its task launched; a slot of the grid that is not is drawn as no primitives
      body = `    if (${lid} == 0u) {
        let ml = atomicLoad(&nx_ctl[6]); let tasks = min(atomicLoad(&nx_ctl[0]), atomicLoad(&nx_ctl[17]));
        let s = ${wid}.y * ml + ${wid}.x;
        var v = s;
        if (${wid}.y < tasks && ${wid}.x < nx_task[${wid}.y * atomicLoad(&nx_ctl[19])]) { v = s | 0x80000000u; }
        if (s >= atomicLoad(&nx_ctl[16])) { v = 0x7fffffffu; }
        nx_u = v;
    }
    let nx_v = workgroupUniformLoad(&nx_u);
    if (nx_v == 0x7fffffffu) { return; }
    let nx_s = nx_v & 0x7fffffffu;
    if ((nx_v >> 31u) == 0u) { if (${lid} == 0u) { nx_out[nx_s * ${SW}u + ${prim - out}u] = 0u; } return; }
    let nx_ts = atomicLoad(&nx_ctl[19]);
    for (var i = ${lid}; i < min(nx_ts - 1u, ${own}u); i += ${T}u) { ${S(`${inp}u + i`, `nx_task[${wid}.y * nx_ts + 1u + i]`)} }
    workgroupBarrier();
    if (${lid} == 0u) { ${S(`${wg}`, `${wid}.x`)} ${S(`${inp}`, `${wid}.x`)} }
`;
    } else body = `    if (${lid} == 0u) { nx_u = min(atomicLoad(&nx_ctl[0]), atomicLoad(&nx_ctl[16])); }
    let nx_n = workgroupUniformLoad(&nx_u);
    let nx_s = ${wid}.x + ${wid}.y * ${GRID}u;
    if (nx_s >= nx_n) { return; }
    if (${lid} == 0u) { ${S(`${wg}`, `atomicLoad(&nx_ctl[1]) + nx_s`)} }
`;
    body += `    workgroupBarrier();
${pre}    ${call}
    workgroupBarrier();
    for (var i = ${lid}; i < ${SW}u; i += ${T}u) { nx_out[nx_s * ${SW}u + i] = ${L(`${out}u + i`)}; }
${post}`;
  }
  return wgsl.slice(0, ep.index) + head + `@compute @workgroup_size(${ep[1]})\nfn main(${sig.replace(/,\s*$/, "")}) {\n${body}}` + wgsl.slice(ep.index + ep[0].length);
}

// A fragment shader's inputs: location, WGSL type, interpolation attribute (naga's entry parameters, or the members of a struct parameter)
export interface FsInput { location: number; type: string; interp: string }
export function fragmentInputs(wgsl: string): FsInput[] {
  const at = /@fragment\s+fn\s+\w+\s*\(/.exec(wgsl);
  if (!at) throw new Error("the fragment shader has no @fragment entry point");
  let d = 1, i = at.index + at[0].length;
  for (; i < wgsl.length && d; i++) d += wgsl[i] === "(" ? 1 : wgsl[i] === ")" ? -1 : 0;
  const ep = [, wgsl.slice(at.index + at[0].length, i - 1)] as const;
  const out: FsInput[] = [];
  const one = (decl: string) => {
    const loc = /@location\((\d+)\)/.exec(decl); if (!loc) return false;
    const interp = /@interpolate\([^)]*\)/.exec(decl)?.[0] ?? "", type = /:\s*([\w<>, ]+?)\s*$/.exec(decl)?.[1];
    if (!type) throw new Error(`fragment input ${decl.trim()}: no type`);
    out.push({ location: +loc[1], type: type.replace(/\s+/g, ""), interp }); return true;
  };
  for (const p of splitTop(ep[1])) {
    if (one(p)) continue;
    const st = /:\s*(\w+)\s*$/.exec(p)?.[1];
    const def = st && new RegExp(`struct\\s+${st}\\s*\\{([^}]*)\\}`).exec(wgsl);
    if (def) for (const mbr of splitTop(def[1])) one(mbr);
  }
  return out.sort((a, b) => a.location - b.location);
}
function splitTop(s: string): string[] {
  const out: string[] = []; let d = 0, cur = "";
  for (const ch of s) { if (ch === "," && !d) { if (cur.trim()) out.push(cur); cur = ""; continue; } if ("(<".includes(ch)) d++; if (")>".includes(ch)) d--; cur += ch; }
  if (cur.trim()) out.push(cur);
  return out;
}
const TYPE = /^(?:vec([234])<(f32|i32|u32)>|(f32|i32|u32)|vec([234])([fiu]))$/;
// The vertex shader that draws a mesh shader's output slots for a fragment shader. Its outputs are what the fragment shader reads, each from the mesh shader's vertex
// (or per-primitive) components; a component nothing wrote reads as the hardware's (0, 0, 0, 1). The position fix-up (lower.ts H_FIXUP) is applied as a translated
// vertex shader applies it. Bindings: @group(2) @binding(0) the fix-up, @binding(1) the output slots
export function pullVertexShader(m: MeshStage, fs: FsInput[]): string {
  const V = m.verts!, P = m.maxP!, SW = slotWords(m), out = m.layout[2], primB = m.layout[3] - out, vstride = m.vertex!.length * BLOCK;
  const pout = Math.ceil(Math.max(m.maxV!, 1) / BLOCK) * vstride, pstride = m.primitive!.length * BLOCK;
  const word = (comps: Comp[], n: number, c: number, base: string) => { const k = comps.findIndex(x => x.n === n && x.c === c); return k < 0 ? null : `nx_mesh[${base} + ${k * BLOCK}u]`; };
  const value = (type: string, n: number) => {
    const t = TYPE.exec(type); if (!t) throw new Error(`fragment input of type ${type}: not one a mesh output can feed`);
    const width = t[1] ? +t[1] : t[4] ? +t[4] : 1, sc = t[2] ?? t[3] ?? { f: "f32", i: "i32", u: "u32" }[t[5]]!, fromPrim = m.primitive!.some(x => x.n === n);
    const parts = Array.from({ length: width }, (_, c) => {
      const w = fromPrim ? word(m.primitive!, n, c, "pb") : word(m.vertex!, n, c, "vb");
      const bits = w ?? (c === 3 ? "0x3f800000u" : "0u");
      return sc === "u32" ? bits : `bitcast<${sc}>(${bits})`;
    });
    return width === 1 ? parts[0] : `${type}(${parts.join(", ")})`;
  };
  const pos = [0, 1, 2, 3].map(c => word(m.vertex!, -1, c, "vb") ?? (c === 3 ? "0x3f800000u" : "0u"));
  if (pos.every((p, c) => p === (c === 3 ? "0x3f800000u" : "0u"))) throw new Error("ms: its SPH enables no position component");
  return `struct NxFix { fix: vec4f }
@group(2) @binding(0) var<uniform> nx: NxFix;
@group(2) @binding(1) var<storage, read> nx_mesh: array<u32>;
struct NxV { @builtin(position) @invariant p: vec4f, ${fs.map(f => `@location(${f.location}) ${f.interp} a${f.location}: ${f.type}`).join(", ")} }
@vertex fn main(@builtin(vertex_index) vi: u32) -> NxV {
  var o: NxV;
  let s = vi / ${P * V}u; let r = vi % ${P * V}u; let p = r / ${V}u; let k = r % ${V}u; let b = s * ${SW}u;
  if (p >= min(nx_mesh[b + ${primB >> 2}u] >> 24u, ${P}u)) { o.p = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let ib = ${primB + 4}u + p * ${V}u + k;
  let n = min((nx_mesh[b + (ib >> 2u)] >> ((ib & 3u) * 8u)) & 0xffu, ${Math.max(m.maxV!, 1) - 1}u);
  let vb = b + (n / 32u) * ${vstride}u + n % 32u;
  let pb = b + ${pout}u + (p / 32u) * ${pstride}u + p % 32u;
  var q = vec4f(${pos.map(w => `bitcast<f32>(${w})`).join(", ")});
  q.y *= nx.fix.y; q.z = q.z * nx.fix.z + q.w * nx.fix.w;
  o.p = q;
${fs.map(f => `  o.a${f.location} = ${value(f.type, f.location)};\n`).join("")}  return o;
}
`;
}
export const TOPOLOGY_OF = ["", "point-list", "line-list", "triangle-list"];
