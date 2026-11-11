// One stage: SPIR-V (from the Maxwell translator, or from glslang for test shaders) -> WGSL and its reflection record.
// Pure: the caller supplies naga (tools/shaders/naga.mts instantiates the WebAssembly build), so this runs offline and in a page alike.
import { fixForWgsl, type FixOptions, type Binding } from "./spv.ts";
import type { Reflection } from "./library.ts";
import { wrapStage, type MeshStage } from "./meshstage.ts";

export interface Converter { spvToWgsl(spv: Uint8Array, flags?: number): string }
export interface Converted { wgsl: string; reflection: Reflection; bindings: Binding[]; fixedSpv: Uint8Array }

// opts.mesh: a task or mesh shader the translator read as compute (job.ts): its entry is wrapped (meshstage.ts) and the reflection names its stage.
// opts.c1: the shader's own constant segment (job.ts c1, hex), the data of its c1 binding when it reads one
export function convertStage(naga: Converter, spv: Uint8Array, opts: FixOptions & { mesh?: MeshStage; c1?: string } = {}): Converted {
  const f = fixForWgsl(spv, opts);
  if (opts.mesh && f.stage !== "compute") throw new Error(`a ${opts.mesh.kind} shader that is not compute after the translator`);
  // WGSL refuses an implicit-derivative sample (textureSample, dpdx) under control flow that differs between pixels; Maxwell code does it freely (a TEX after a
  // predicate), with the derivative then undefined, as on the hardware. The directive turns WGSL's error off for the module
  // native warp operations (spv_subgroups.ts): WGSL's subgroup builtins, whose uniformity analysis would refuse the translator's divergent votes and shuffles
  const sg = f.subgroups === "native" ? "enable subgroups;\ndiagnostic(off, subgroup_uniformity);\n" : "";
  let wgsl = sg + (f.stage === "fragment" ? "diagnostic(off, derivative_uniformity);\n" : "") + naga.spvToWgsl(f.spv);
  if (opts.mesh) wgsl = wrapStage(wgsl, opts.mesh);
  const cb = f.bindings.filter(b => b.kind === "cbuf"), tex = f.bindings.filter(b => b.kind === "tex"), sb = f.bindings.filter(b => b.kind === "storage");
  for (const t of tex) if (t.sampleType === "sint" || t.sampleType === "uint") f.notes.push(`texture slot ${t.reg} is sampled as ${t.sampleType}: src/gfx declares every texture float or depth`);
  const reflection: Reflection = {
    stage: opts.mesh ? (opts.mesh.kind === "ts" ? "task" : "mesh") : f.stage, entry: "main",
    ...(opts.mesh ? { mesh: opts.mesh } : {}),
    ubos: cb.map(b => b.reg!).sort((a, b) => a - b),
    textures: tex.map(t => ({ slot: t.reg!, dim: t.dim!, depth: t.sampleType === "depth", ...(t.handle ? { handle: t.handle } : {}) })).sort((a, b) => a.slot - b.slot),
    fixup: f.bindings.some(b => b.kind === "fixup"),
    ...(f.bindings.some(b => b.kind === "draw") ? { drawParams: true } : {}),
    ...(sb.length ? { storage: sb.map(b => ({ slot: b.reg!, write: !!b.write, ...(b.ubo === undefined ? {} : { ubo: b.ubo }) })).sort((a, b) => a.slot - b.slot) } : {}),
    uboSize: Object.fromEntries(cb.map(b => [b.reg, b.size ?? 0])),
    extra: f.bindings.filter(b => !["cbuf", "tex", "samp_tex", "fixup", "storage", "draw"].includes(b.kind)).map(b => ({ kind: b.kind, group: b.group, binding: b.binding, size: b.size, bank: b.bank, ...(b.kind === "c1" ? { data: opts.c1 ?? "" } : {}) })),
    notes: f.notes,
  };
  if (f.stage === "vertex") { reflection.attributes = f.inputs.map(i => i.location); reflection.attributeTypes = Object.fromEntries(f.inputs.map(i => [i.location, i.type])); }
  if (f.stage === "fragment") { reflection.outputs = f.outputs.map(o => o.location); reflection.outputTypes = Object.fromEntries(f.outputs.map(o => [o.location, o.type])); }
  return { wgsl, reflection, bindings: f.bindings, fixedSpv: f.spv };
}
