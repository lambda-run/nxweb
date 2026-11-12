// Variants of a translated stage's WGSL that depend on what it is drawn with, made from the text naga wrote (as images.ts does for storage image formats).
// Plain TypeScript, no Node or browser API: the replayer (src/glue/gfx_host.ts) asks for them when a pipeline is built; each is a pure function of its arguments,
// so the caller keeps the module by the signature it asked with.
//   vertexInputVariant    a vertex stage bound with attribute formats of another class (float / sint / uint) than its inputs declare
//   fragmentInputVariant  a fragment stage drawn with a vertex stage that does not write every varying it reads
//   stageInterface        the locations (and types) a stage's entry point reads and writes
// The shape relied on is naga's for a module read from SPIR-V: `@vertex fn main(@location(0) a: vec4<f32>, @builtin(vertex_index) b: u32) -> VertexOutput {`,
// the outputs a struct of `@location(n) [@interpolate(..)] name: type` members or one attributed type; every input a parameter of its own.
export type VinClass = "float" | "sint" | "uint";
export interface Varying { location: number; name: string; type: string; cls: VinClass; interpolate?: string }

interface Param { text: string; attrs: string; name: string; type: string; location?: number }
interface Entry { at: number; paramsAt: number; paramsEnd: number; params: Param[]; ret: string; bodyAt: number }

const SCALAR: Record<string, VinClass> = { f32: "float", f16: "float", i32: "sint", u32: "uint" };
const WORD: Record<VinClass, string> = { float: "f32", sint: "i32", uint: "u32" };
function classOf(type: string): VinClass | undefined { const m = /^(?:vec[234]<\s*(\w+)\s*>|(\w+))$/.exec(type.trim()); return m ? SCALAR[m[1] ?? m[2]] : undefined; }
// `type` with its scalar replaced (vec3<f32> -> vec3<u32>)
function retype(type: string, cls: VinClass): string { return type.trim().replace(/\b(f32|f16|i32|u32)\b/, WORD[cls]); }

// The parts of a parameter list or a struct body at its top-level commas (an attribute's or a type's own commas are not)
function split(list: string): string[] {
  const out: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(" || ch === "<") depth++; else if (ch === ")" || ch === ">") depth--; else if (ch === "," && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
  }
  out.push(list.slice(from));
  return out.filter(s => s.trim());
}
function member(text: string): Param | undefined {
  const m = /^\s*((?:@\w+\s*(?:\((?:[^()]|\([^()]*\))*\))?\s*)*)(\w+)\s*:\s*([\s\S]+?)\s*$/.exec(text);
  if (!m) return undefined;
  const loc = /@location\(\s*(\d+)\s*\)/.exec(m[1]);
  return { text, attrs: m[1], name: m[2], type: m[3], ...(loc ? { location: +loc[1] } : {}) };
}
function entry(wgsl: string, stage: "vertex" | "fragment"): Entry | undefined {
  const m = new RegExp(`@${stage}\\s*fn\\s+\\w+\\s*\\(`).exec(wgsl);
  if (!m) return undefined;
  const paramsAt = m.index + m[0].length;
  let depth = 1, i = paramsAt;
  for (; i < wgsl.length && depth; i++) { if (wgsl[i] === "(") depth++; else if (wgsl[i] === ")") depth--; }
  if (depth) return undefined;
  const paramsEnd = i - 1, brace = wgsl.indexOf("{", i);
  if (brace < 0) return undefined;
  const params = split(wgsl.slice(paramsAt, paramsEnd)).map(member);
  if (params.some(p => !p)) return undefined;
  return { at: m.index, paramsAt, paramsEnd, params: params as Param[], ret: wgsl.slice(i, brace).replace(/^\s*->\s*/, "").trim(), bodyAt: brace + 1 };
}
const varying = (p: Param): Varying => ({ location: p.location!, name: p.name, type: p.type, cls: classOf(p.type) ?? "float", ...(/@interpolate\(([^)]*)\)/.exec(p.attrs) ? { interpolate: /@interpolate\(([^)]*)\)/.exec(p.attrs)![1].trim() } : {}) });

// What the stage's entry point reads and writes by location; undefined when the text has no such entry point of the shape above
export function stageInterface(wgsl: string, stage: "vertex" | "fragment"): { inputs: Varying[]; outputs: Varying[] } | undefined {
  const e = entry(wgsl, stage);
  if (!e) return undefined;
  const inputs = e.params.filter(p => p.location !== undefined).map(varying);
  let outs: Param[] = [];
  if (/^\w+$/.test(e.ret)) {
    const st = new RegExp(`struct\\s+${e.ret}\\s*\\{([^}]*)\\}`).exec(wgsl);
    if (!st) return undefined;
    outs = split(st[1]).map(member).filter((p): p is Param => !!p);
  } else if (e.ret) {
    const one = member(`${e.ret.replace(/\s*(\S+)$/, " nx_out: $1")}`);
    if (one) outs = [one];
  }
  return { inputs, outputs: outs.filter(p => p.location !== undefined).map(varying).sort((a, b) => a.location - b.location) };
}

// A vertex stage for the attribute classes bound. The translator's code holds every attribute as the bits of a register (Maxwell's are untyped) and declares the
// input float unless told otherwise; with an integer attribute bound, the translator's own text for it declares the input with that class and takes its bits
// (Ryujinx AttributeType.Sint / Uint: floatBitsToInt's inverse on the load). The same here on naga's text: the input is declared with the bound class and the
// body is handed bitcast<declared type>(input). `classes`: location -> the class bound (locations the stage does not read are ignored).
// undefined: the text has no vertex entry point of the known shape, or an input whose type has no class
export function vertexInputVariant(wgsl: string, classes: Record<number, VinClass>): string | undefined {
  const e = entry(wgsl, "vertex");
  if (!e) return undefined;
  const lets: string[] = [];
  const params = e.params.map(p => {
    const want = p.location === undefined ? undefined : classes[p.location], have = classOf(p.type);
    if (want === undefined || want === have) return p.text.trim();
    if (have === undefined || !WORD[want]) { lets.push("?"); return p.text.trim(); }
    const raw = `nx_in_${p.name}`;
    lets.push(`let ${p.name} = bitcast<${p.type.trim()}>(${raw});`);
    // an integer input takes no interpolation attribute in a vertex stage; none is written there
    return `${p.attrs.replace(/@interpolate\([^)]*\)\s*/, "")}${raw}: ${retype(p.type, want)}`;
  });
  if (lets.includes("?")) return undefined;
  if (!lets.length) return wgsl;
  return wgsl.slice(0, e.paramsAt) + params.join(", ") + wgsl.slice(e.paramsEnd, e.bodyAt) + "\n    " + lets.join("\n    ") + wgsl.slice(e.bodyAt);
}

// A fragment stage for a vertex stage that leaves some of its inputs unwritten. NVN (as GL) draws: the varying is undefined; WebGPU refuses the pipeline ("The
// fragment input at location N doesn't have a corresponding vertex output"). Each such input stops being an input and reads a constant: (0, 0, 0, 1) for four
// floats (what the console's GPU gives an attribute nothing feeds), zero for anything else.
// `written`: the locations the vertex (or mesh) stage writes, or that stage's WGSL. null: every input is written (the stage's own text does); undefined: the
// text has no fragment entry point of the known shape
export function fragmentInputVariant(wgsl: string, written: Iterable<number> | string): string | null | undefined {
  let have: Set<number>;
  if (typeof written === "string") { const v = stageInterface(written, "vertex"); if (!v) return undefined; have = new Set(v.outputs.map(o => o.location)); }
  else have = new Set(written);
  const e = entry(wgsl, "fragment");
  if (!e) return undefined;
  const gone = e.params.filter(p => p.location !== undefined && !have.has(p.location));
  if (!gone.length) return null;
  const lets = gone.map(p => `let ${p.name} = ${/^vec4<\s*f32\s*>$/.test(p.type.trim()) ? "vec4<f32>(0f, 0f, 0f, 1f)" : `${p.type.trim()}()`};`);
  return wgsl.slice(0, e.paramsAt) + e.params.filter(p => !gone.includes(p)).map(p => p.text.trim()).join(", ") + wgsl.slice(e.paramsEnd, e.bodyAt) + "\n    " + lets.join("\n    ") + wgsl.slice(e.bodyAt);
}
// The signature of fragmentInputVariant's result for these written locations: the fragment inputs left out (ascending, "5,6"), "" when none. A cache key
export function missingInputs(wgsl: string, written: Iterable<number> | string): string {
  const e = entry(wgsl, "fragment"), v = typeof written === "string" ? stageInterface(written, "vertex")?.outputs.map(o => o.location) : [...written];
  if (!e || !v) return "";
  const have = new Set(v);
  return e.params.filter(p => p.location !== undefined && !have.has(p.location!)).map(p => p.location!).sort((a, b) => a - b).join(",");
}
