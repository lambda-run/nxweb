// SPIR-V rewriting between the Maxwell translator (Ryujinx.Graphics.Shader through nxnative's dmsh_xlate) and naga's WGSL writer.
// Plain TypeScript with no Node or browser API: it runs in the offline build (tools/shaders/build_lib.mts) and would run in a page.
// What it does and why is tools/shaders/README.md, "The SPIR-V pass"; in short, in this order:
//   1. drops the capabilities and the extension the translator declares for every shader and this one does not use;
//   2. drops the stores to gl_PointSize, gl_ClipDistance, gl_CullDistance (WGSL has none of them; naga then leaves the members out);
//   3. splits each combined image sampler into a texture and a sampler (WGSL has no combined type; naga does not read one);
//   4. turns the table of bound uniform sizes into constants, drops uniform variables nothing reads, and shrinks each uniform block `vec4 data[4096]` to the vectors the shader can reach (WebGPU wants the bound range to cover the type);
//   5. gives every resource its nxweb binding (src/gfx/README.md) from the translator's variable name, and reports it;
//   6. appends the position fix-up to a vertex shader (origin and depth mode are run-time state, lower.ts H_FIXUP).
// Every loss is a note; a construct that has no place yet is an error, so a library never holds a shader that silently differs.

export const Op = { Name: 5, MemberName: 6, Extension: 10, ExtInstImport: 11, EntryPoint: 15, ExecutionMode: 16, Capability: 17, TypeVoid: 19, TypeBool: 20, TypeInt: 21, TypeFloat: 22,
  TypeVector: 23, TypeImage: 25, TypeSampler: 26, TypeSampledImage: 27, TypeArray: 28, TypeRuntimeArray: 29, TypeStruct: 30, TypePointer: 32, TypeFunction: 33,
  Constant: 43, ConstantComposite: 44, Function: 54, FunctionEnd: 56, Variable: 59, Load: 61, Store: 62, AccessChain: 65, InBoundsAccessChain: 66, Decorate: 71, MemberDecorate: 72,
  CompositeConstruct: 80, CompositeExtract: 81, SampledImage: 86, FAdd: 129, FMul: 133, Label: 248, Return: 253,
  BeginInvocationInterlockEXT: 5364, EndInvocationInterlockEXT: 5365 } as const;
const Dec = { Block: 2, BufferBlock: 3, ArrayStride: 6, BuiltIn: 11, Location: 30, Binding: 33, DescriptorSet: 34, Offset: 35 };
const SC = { UniformConstant: 0, Input: 1, Uniform: 2, Output: 3, Private: 6, StorageBuffer: 12 };

export interface Inst { op: number; w: number[] }   // w: the operand words, without the first (length and opcode)
export interface Module { version: number; generator: number; bound: number; insts: Inst[] }

export function parse(bytes: Uint8Array): Module {
  if (bytes.length % 4 || bytes.length < 20) throw new Error("SPIR-V: not a whole number of words");
  const u = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  if (u[0] !== 0x07230203) throw new Error("SPIR-V: no magic number");
  const insts: Inst[] = [];
  for (let i = 5; i < u.length;) {
    const n = u[i] >>> 16, op = u[i] & 0xffff;
    if (!n || i + n > u.length) throw new Error(`SPIR-V: instruction at word ${i} runs past the end`);
    insts.push({ op, w: Array.from(u.subarray(i + 1, i + n)) });
    i += n;
  }
  return { version: u[1], generator: u[2], bound: u[3], insts };
}
export function serialize(m: Module): Uint8Array {
  let n = 5;
  for (const i of m.insts) n += 1 + i.w.length;
  const u = new Uint32Array(n);
  u[0] = 0x07230203; u[1] = m.version; u[2] = m.generator; u[3] = m.bound; u[4] = 0;
  let p = 5;
  for (const i of m.insts) { u[p++] = ((1 + i.w.length) << 16) | i.op; u.set(i.w, p); p += i.w.length; }
  return new Uint8Array(u.buffer);
}
function str(w: number[], at: number): string {
  let s = "";
  for (let i = at; i < w.length; i++) for (let b = 0; b < 4; b++) { const c = (w[i] >>> (8 * b)) & 0xff; if (!c) return s; s += String.fromCharCode(c); }
  return s;
}
function strWords(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i <= s.length; i += 4) { let v = 0; for (let b = 0; b < 4 && i + b < s.length; b++) v |= s.charCodeAt(i + b) << (8 * b); out.push(v >>> 0); }
  return out;
}

// ---- what the pass reports ----
// kind: the names of nxnative's dmsh_abi.h where they mean the same thing
export interface Binding {
  kind: "cbuf" | "support" | "c1" | "drvcb" | "tex" | "samp_tex" | "fixup";
  group: number; binding: number;
  reg?: number;        // cbuf: uniform slot; tex / samp_tex: texture slot
  bank?: number;       // drvcb: 0 or 2
  size?: number;       // buffers: bytes the WGSL type covers = the least the host may bind
  dim?: "2d" | "2d-array" | "cube" | "cube-array" | "3d";
  sampleType?: "float" | "depth" | "sint" | "uint";
  // tex: a bindless texture. The handle is not a bound slot's: it is the 32-bit word at byte `offset` of game uniform slot `ubo` (texture ID in the low 20 bits,
  // sampler ID in the high 12), read by the host at each draw; `sampler`: a second word ORed into it, or the sampler ID as a constant (nxnative tex_ubo / samp_ubo)
  handle?: { ubo: number; offset: number; sampler?: { ubo: number; offset: number } | { id: number } };
  name: string;        // the translator's name of the variable, for the reader
}
export interface FixResult {
  spv: Uint8Array;
  stage: "vertex" | "fragment" | "compute";
  bindings: Binding[];
  inputs: { location: number; type: "float" | "sint" | "uint" }[];
  outputs: { location: number; type: "float" | "sint" | "uint" }[];
  notes: string[];     // what was lost or assumed, in words
}
export interface FixOptions {
  // "nxweb": the translator's names decide (step 5). "keep": descriptor sets and bindings stay as they are; a sampler split off a texture at (set, b) goes to (set, b + 1)
  // and the caller keeps b + 1 free (test shaders written in GLSL with the nxweb numbers already in their layout qualifiers)
  bindings?: "nxweb" | "keep";
  fixup?: boolean;     // vertex: append the position fix-up (default true)
  shrinkUniforms?: boolean;   // default true
}

// The nxweb binding convention (src/gfx/README.md), with the three things a translated shader has and a hand-written one has not:
//   group 0, binding stage * 16 + 14: the translator's support buffer (only when the shader reads it)
//   group 3, binding stage * 16 + 0: the shader's own constants c1;  + 1: driver segment c0;  + 2: driver segment c2
//   group 2, binding 0: the position fix-up (one vec4f), vertex shaders
export const STAGE_INDEX = { vertex: 0, fragment: 1, compute: 2 } as const;
export const SUPPORT_SLOT = 14, CBSIZE_BANK = 25;
const C2_TEX = 0x20, C2_SEPTEX = 0x168;   // nxnative dmsh_abi.h: combined texture slot r's handle word is at c2 byte 0x20 + 8 r, up to the separate texture table

class Ctx {
  m: Module; notes: string[] = [];
  names = new Map<number, string>();
  def = new Map<number, Inst>();               // result id -> its instruction (types, constants, variables, body results)
  deco = new Map<number, Inst[]>();            // target id -> OpDecorate
  mdeco = new Map<number, Inst[]>();           // struct id -> OpMemberDecorate
  constructor(m: Module) { this.m = m; this.index(); }
  index() {
    this.names.clear(); this.def.clear(); this.deco.clear(); this.mdeco.clear();
    for (const i of this.m.insts) {
      if (i.op === Op.Name) this.names.set(i.w[0], str(i.w, 1));
      else if (i.op === Op.Decorate) push(this.deco, i.w[0], i);
      else if (i.op === Op.MemberDecorate) push(this.mdeco, i.w[0], i);
      const r = resultId(i);
      if (r) this.def.set(r, i);
    }
  }
  id(): number { return this.m.bound++; }
  decoration(id: number, d: number): number | undefined { return this.deco.get(id)?.find(i => i.w[1] === d)?.w[2]; }
  has(id: number, d: number): boolean { return !!this.deco.get(id)?.some(i => i.w[1] === d); }
  setDecoration(id: number, d: number, v: number) {
    const e = this.deco.get(id)?.find(i => i.w[1] === d);
    if (e) e.w[2] = v; else this.addDecoration(id, d, v);
  }
  addDecoration(id: number, d: number, ...v: number[]) {
    const inst = { op: Op.Decorate, w: [id, d, ...v] };
    this.m.insts.splice(this.firstType(), 0, inst); push(this.deco, id, inst);
  }
  firstType(): number { return this.m.insts.findIndex(i => (i.op >= Op.TypeVoid && i.op <= Op.TypeFunction) || i.op === Op.Constant || i.op === Op.Variable); }
  firstFunction(): number { return this.m.insts.findIndex(i => i.op === Op.Function); }
  constU32(id: number): number | undefined { const c = this.def.get(id); return c && c.op === Op.Constant ? c.w[2] : undefined; }
  // An existing or new instruction among the types and constants, placed at `at` when new
  intern(op: number, operands: number[], at: number, hasType: boolean): { id: number; added: number } {
    for (const i of this.m.insts) {
      if (i.op === Op.Function) break;
      if (i.op !== op) continue;
      const ops = hasType ? [i.w[0], ...i.w.slice(2)] : i.w.slice(1);
      if (ops.length === operands.length && ops.every((v, k) => v === operands[k])) return { id: hasType ? i.w[1] : i.w[0], added: 0 };
    }
    const id = this.id(), inst = { op, w: hasType ? [operands[0], id, ...operands.slice(1)] : [id, ...operands] };
    this.m.insts.splice(at, 0, inst); this.def.set(id, inst);
    return { id, added: 1 };
  }
}
function push<K, V>(m: Map<K, V[]>, k: K, v: V) { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }
// The result id of the instructions this pass looks at (types have it first; everything else that has a type has it second)
function resultId(i: Inst): number {
  if (i.op >= Op.TypeVoid && i.op <= Op.TypeFunction) return i.w[0];
  if (i.op === Op.ExtInstImport || i.op === Op.Label) return i.w[0];
  if (i.op === Op.Constant || i.op === Op.ConstantComposite || (i.op >= 41 && i.op <= 52) || i.op === Op.Function || i.op === Op.Variable || i.op === Op.Load || i.op === Op.AccessChain ||
    i.op === Op.InBoundsAccessChain || i.op === Op.SampledImage) return i.w[1];
  return 0;
}

const CAP = { Float64: 10, SampledBuffer: 46, ImageBuffer: 47, GroupNonUniform: 61, GroupNonUniformVote: 62, GroupNonUniformArithmetic: 63, GroupNonUniformBallot: 64,
  GroupNonUniformShuffle: 65, DrawParameters: 4427, FragmentShaderPixelInterlockEXT: 5378 };

// 1. The translator declares these for every shader (CodeGen/Spirv/SpirvGenerator.cs); naga stops at the extension
function dropUnused(c: Ctx) {
  const ops = new Set(c.m.insts.map(i => i.op));
  const subgroup = [...ops].some(o => o >= 333 && o <= 366), f64 = c.m.insts.some(i => i.op === Op.TypeFloat && i.w[1] === 64);
  const bufferImage = c.m.insts.some(i => i.op === Op.TypeImage && i.w[2] === 5);
  const drawParams = c.m.insts.some(i => (i.op === Op.Decorate && i.w[1] === Dec.BuiltIn && i.w[2] >= 4424 && i.w[2] <= 4426));
  const interlock = ops.has(Op.BeginInvocationInterlockEXT) || ops.has(Op.EndInvocationInterlockEXT);
  if (subgroup) throw new Error("subgroup operations (Maxwell warp instructions): WGSL has none without the subgroups feature, and nothing here lowers them");
  if (f64) throw new Error("64-bit floats: WGSL has none (nxnative retranslates with softfloat64; do the same before this pass)");
  if (bufferImage) throw new Error("a buffer texture: WGSL has none (nxnative's host binds them as 2D rows; needs the same decision here)");
  if (interlock) c.notes.push("pixel interlock dropped: WebGPU has no fragment shader interlock, so read-modify-write of images or storage in this pixel shader is not ordered");
  if (drawParams) c.notes.push("reads the draw's base vertex / base instance / draw index: left to naga");
  const gone = new Set([CAP.Float64, CAP.SampledBuffer, CAP.ImageBuffer, CAP.GroupNonUniform, CAP.GroupNonUniformVote, CAP.GroupNonUniformArithmetic, CAP.GroupNonUniformBallot,
    CAP.GroupNonUniformShuffle, CAP.FragmentShaderPixelInterlockEXT, ...(drawParams ? [] : [CAP.DrawParameters])]);
  c.m.insts = c.m.insts.filter(i => !(i.op === Op.Capability && gone.has(i.w[0])) && !(i.op === Op.Extension && str(i.w, 0) === "SPV_EXT_fragment_shader_interlock") &&
    i.op !== Op.BeginInvocationInterlockEXT && i.op !== Op.EndInvocationInterlockEXT && !(i.op === Op.ExecutionMode && i.w[1] >= 5366 && i.w[1] <= 5371));
}

// 1b. OpIsNan / OpIsInf: WGSL has neither and naga refuses them. nxnative's translator writes an OpIsNan before every texture sample (a NaN coordinate reads texel 0),
// so every pixel shader has one. Written on the bits, which a compiler that assumes no NaN cannot fold: (bits & 0x7fffffff) > 0x7f800000, or == for infinity
function nanTests(c: Ctx) {
  if (!c.m.insts.some(i => i.op === 156 || i.op === 157)) return;
  let at = c.firstFunction(), r;
  const add = (op: number, ops: number[], hasType: boolean) => { r = c.intern(op, ops, at, hasType); at += r.added; return r.id; };
  const u32 = add(Op.TypeInt, [32, 0], false), mask = add(Op.Constant, [u32, 0x7fffffff], true), inf = add(Op.Constant, [u32, 0x7f800000], true);
  const vecs = new Map<number, { t: number; mask: number; inf: number }>();
  const forN = (n: number) => {
    if (n === 1) return { t: u32, mask, inf };
    let v = vecs.get(n);
    if (!v) { const t = add(Op.TypeVector, [u32, n], false); v = { t, mask: add(Op.ConstantComposite, [t, ...Array(n).fill(mask)], true), inf: add(Op.ConstantComposite, [t, ...Array(n).fill(inf)], true) }; vecs.set(n, v); }
    return v;
  };
  for (const i of c.m.insts.filter(i => i.op === 156 || i.op === 157)) { const rt = c.def.get(i.w[0])!; forN(rt.op === Op.TypeVector ? rt.w[2] : 1); }   // the types first: adding one moves the list
  const out: Inst[] = [];
  for (const i of c.m.insts) {
    if (i.op !== 156 && i.op !== 157) { out.push(i); continue; }
    const rt = c.def.get(i.w[0])!, v = forN(rt.op === Op.TypeVector ? rt.w[2] : 1), a = c.id(), b = c.id();
    out.push({ op: 124 /* Bitcast */, w: [v.t, a, i.w[2]] }, { op: 199 /* BitwiseAnd */, w: [v.t, b, a, v.mask] }, { op: i.op === 156 ? 172 /* UGreaterThan */ : 170 /* IEqual */, w: [i.w[0], i.w[1], b, v.inf] });
  }
  c.m.insts = out;
}

// 1c. OpUMulExtended / OpSMulExtended (Maxwell IMUL.HI, the translator's MultiplyHigh): naga reads neither. Scalars only, as the translator writes them. The low word is
// OpIMul; the high word is built from 16-bit halves, and the signed one from the unsigned: hi_s = hi_u - (a < 0 ? b : 0) - (b < 0 ? a : 0)
function mulExtended(c: Ctx) {
  const muls = c.m.insts.filter(i => i.op === 151 || i.op === 152);
  if (!muls.length) return;
  let at = c.firstFunction(), r;
  const add = (op: number, ops: number[], hasType: boolean) => { r = c.intern(op, ops, at, hasType); at += r.added; return r.id; };
  const u32 = add(Op.TypeInt, [32, 0], false), i32 = add(Op.TypeInt, [32, 1], false), k16 = add(Op.Constant, [u32, 16], true), kff = add(Op.Constant, [u32, 0xffff], true), k31 = add(Op.Constant, [i32, 31], true);
  const pair = new Map<number, [number, number]>();   // the struct result -> its two members' ids
  const out: Inst[] = [];
  for (const i of c.m.insts) {
    if (i.op === 151 || i.op === 152) {
      const st = c.def.get(i.w[0])!, t = c.def.get(st.w[1])!;
      if (t.op !== Op.TypeInt) throw new Error("an extended multiply of vectors");
      const signed = i.op === 152, T = t.w[0];
      const e = (op: number, type: number, ...ops: number[]) => { const id = c.id(); out.push({ op, w: [type, id, ...ops] }); return id; };
      const U = (x: number) => T === u32 ? x : e(124, u32, x);
      const a = U(i.w[2]), b = U(i.w[3]);
      const a0 = e(199, u32, a, kff), a1 = e(194, u32, a, k16), b0 = e(199, u32, b, kff), b1 = e(194, u32, b, k16);
      const m1 = e(128, u32, e(132, u32, a1, b0), e(194, u32, e(132, u32, a0, b0), k16));
      const m2 = e(128, u32, e(132, u32, a0, b1), e(199, u32, m1, kff));
      let hi = e(128, u32, e(128, u32, e(132, u32, a1, b1), e(194, u32, m1, k16)), e(194, u32, m2, k16));
      if (signed) {
        const sa = e(124, u32, e(195, i32, T === i32 ? i.w[2] : e(124, i32, i.w[2]), k31)), sb = e(124, u32, e(195, i32, T === i32 ? i.w[3] : e(124, i32, i.w[3]), k31));   // all ones when negative
        hi = e(130, u32, e(130, u32, hi, e(199, u32, sa, b)), e(199, u32, sb, a));
      }
      const lo = e(132, T, i.w[2], i.w[3]);
      pair.set(i.w[1], [lo, T === u32 ? hi : e(124, T, hi)]);
    } else if (i.op === Op.CompositeExtract && pair.has(i.w[2])) out.push({ op: 83 /* CopyObject */, w: [i.w[0], i.w[1], pair.get(i.w[2])![i.w[3]]] });
    else { if (i.op !== Op.Name && i.op !== Op.Decorate && i.w.some((w, k) => k > 0 && pair.has(w)) && i.op >= Op.Load) throw new Error("the result of an extended multiply used whole"); out.push(i); }
  }
  c.m.insts = out;
}

// 2. gl_PerVertex: only the position survives. A write of a point size other than the constant 1, or of any clip or cull distance, is a loss
function perVertex(c: Ctx): number {
  let posVar = 0;
  for (const [struct, list] of c.mdeco) {
    const builtins = new Map<number, number>();   // member -> builtin
    for (const d of list) if (d.w[2] === Dec.BuiltIn) builtins.set(d.w[1], d.w[3]);
    if (!builtins.size) continue;
    const ptrs = new Set(c.m.insts.filter(i => i.op === Op.TypePointer && i.w[2] === struct).map(i => i.w[0]));
    const vars = new Set(c.m.insts.filter(i => i.op === Op.Variable && ptrs.has(i.w[0]) && i.w[2] === SC.Output).map(i => i.w[1]));
    if (!vars.size) continue;
    const dead = new Map<number, number>();       // access chain id -> builtin
    for (const i of c.m.insts) {
      if ((i.op !== Op.AccessChain && i.op !== Op.InBoundsAccessChain) || !vars.has(i.w[2])) continue;
      const member = c.constU32(i.w[3]);
      if (member === undefined) throw new Error("gl_PerVertex indexed by a value that is not a constant");
      const b = builtins.get(member);
      if (b === 0) posVar = i.w[2]; else if (b !== undefined) dead.set(i.w[1], b);
    }
    for (const i of c.m.insts) {
      if (i.op === Op.Store && dead.has(i.w[0])) {
        const b = dead.get(i.w[0])!, v = c.def.get(i.w[1]);
        const one = v && v.op === Op.Constant && v.w[2] === 0x3f800000;
        if (b === 1 && !one) c.notes.push("gl_PointSize written with something other than 1: WebGPU draws points one pixel wide, the size is lost");
        if (b === 3 || b === 4) c.notes.push(`${b === 3 ? "gl_ClipDistance" : "gl_CullDistance"} written: lost (WebGPU's clip-distances feature is not used yet)`);
      } else if (i.op === Op.Load && dead.has(i.w[2])) throw new Error("gl_PointSize or a clip distance read back from the output");
    }
    c.m.insts = c.m.insts.filter(i => !(((i.op === Op.AccessChain || i.op === Op.InBoundsAccessChain) && dead.has(i.w[1])) || (i.op === Op.Store && dead.has(i.w[0]))));
    c.notes = [...new Set(c.notes)];
  }
  return posVar;
}

// 3. Combined image samplers. The variable keeps its id, name and decorations and becomes the texture; a sampler variable is added beside it, and every load of the
// pair loads both and joins them with OpSampledImage, which is what the instructions that follow already expect
function splitSamplers(c: Ctx): Map<number, number> {
  const samplerOf = new Map<number, number>();   // texture variable -> its sampler variable
  const sampled = new Map<number, number>();     // OpTypeSampledImage -> image type
  for (const i of c.m.insts) if (i.op === Op.TypeSampledImage) sampled.set(i.w[0], i.w[1]);
  const ptr = new Map<number, number>();         // pointer type -> sampled image type
  for (const i of c.m.insts) {
    if (i.op !== Op.TypePointer || i.w[1] !== SC.UniformConstant) continue;
    if (sampled.has(i.w[2])) ptr.set(i.w[0], i.w[2]);
    else { const a = c.def.get(i.w[2]); if (a && (a.op === Op.TypeArray || a.op === Op.TypeRuntimeArray) && sampled.has(a.w[1])) throw new Error("an array of combined samplers (a bindless texture table): not placed yet"); }
  }
  if (!ptr.size) return samplerOf;
  for (let k = 0; k < c.m.insts.length; k++) {
    const v = c.m.insts[k];
    if (v.op !== Op.Variable || !ptr.has(v.w[0])) continue;
    const image = sampled.get(ptr.get(v.w[0])!)!;
    let n = 0, r;
    r = c.intern(Op.TypePointer, [SC.UniformConstant, image], k, false); n += r.added; const imagePtr = r.id;
    r = c.intern(Op.TypeSampler, [], k + n, false); n += r.added; const sampler = r.id;
    r = c.intern(Op.TypePointer, [SC.UniformConstant, sampler], k + n, false); n += r.added; const samplerPtr = r.id;
    const sv = c.id();
    v.w[0] = imagePtr;
    c.m.insts.splice(k + n + 1, 0, { op: Op.Variable, w: [samplerPtr, sv, SC.UniformConstant] });
    samplerOf.set(v.w[1], sv);
    c.names.set(sv, (c.names.get(v.w[1]) ?? `t${v.w[1]}`) + "_samp");
    k += n + 1;
    (v as any).image = image; (v as any).sampler = sampler;
  }
  const out: Inst[] = [];
  for (const i of c.m.insts) {
    if (i.op === Op.Load && samplerOf.has(i.w[2])) {
      const v = c.def.get(i.w[2]) as any, a = c.id(), b = c.id();
      out.push({ op: Op.Load, w: [v.image, a, i.w[2]] }, { op: Op.Load, w: [v.sampler, b, samplerOf.get(i.w[2])!] }, { op: Op.SampledImage, w: [i.w[0], i.w[1], a, b] });
    } else out.push(i);
  }
  c.m.insts = out;
  // the entry point's interface lists every global from SPIR-V 1.4 on; below that only inputs and outputs, so nothing to add (the translator writes 1.3)
  for (const [tv, sv] of samplerOf) {
    const at = c.m.insts.findIndex(i => i.op === Op.Name);
    c.m.insts.splice(at < 0 ? c.firstType() : at, 0, { op: Op.Name, w: [sv, ...strWords(c.names.get(sv)!)] });
    const set = c.decoration(tv, Dec.DescriptorSet) ?? 0, b = c.decoration(tv, Dec.Binding) ?? 0;
    c.addDecoration(sv, Dec.DescriptorSet, set); c.addDecoration(sv, Dec.Binding, b + 1);
  }
  return samplerOf;
}

// 4. A uniform block the translator declares is `struct { vec4 data[4096]; }` whatever the shader reads: 64 KB, which WebGPU would require the host to bind for every slot.
// When every access has a constant vector index the array is cut after the last one read; an access with a computed index keeps the whole array
function shrinkUniforms(c: Ctx): Map<number, number> {
  const size = new Map<number, number>();   // variable -> bytes
  const vars = c.m.insts.filter(i => i.op === Op.Variable && i.w[2] === SC.Uniform);
  for (const v of vars) {
    const p = c.def.get(v.w[0])!, st = c.def.get(p.w[2])!;
    if (st.op !== Op.TypeStruct) continue;
    const full = structSize(c, st);
    size.set(v.w[1], full);
    if (st.w.length !== 2) continue;
    const arr = c.def.get(st.w[1])!;
    if (arr.op !== Op.TypeArray) continue;
    const len = c.constU32(arr.w[2])!, stride = c.decoration(arr.w[0], Dec.ArrayStride) ?? 16;
    let max = -1, dynamic = false;
    for (const i of c.m.insts) {
      if ((i.op !== Op.AccessChain && i.op !== Op.InBoundsAccessChain) || i.w[2] !== v.w[1]) continue;
      const idx = i.w.length > 4 ? c.constU32(i.w[4]) : undefined;
      if (idx === undefined) dynamic = true; else max = Math.max(max, idx);
    }
    if (dynamic || max < 0 || max + 1 >= len) continue;
    // a type of its own: the translator shares one array type among all its uniform slots
    const at = c.m.insts.indexOf(v);
    const uint = c.def.get(arr.w[2])!.w[0];
    const n = c.id(), a = c.id(), s = c.id(), np = c.id();
    c.m.insts.splice(at, 0, { op: Op.Constant, w: [uint, n, max + 1] }, { op: Op.TypeArray, w: [a, arr.w[1], n] }, { op: Op.TypeStruct, w: [s, a] }, { op: Op.TypePointer, w: [np, SC.Uniform, s] });
    c.addDecoration(a, Dec.ArrayStride, stride); c.addDecoration(s, Dec.Block);
    c.m.insts.splice(c.firstType(), 0, { op: Op.MemberDecorate, w: [s, 0, Dec.Offset, 0] });
    v.w[0] = np;
    size.set(v.w[1], (max + 1) * stride);
  }
  c.index();
  return size;
}
function structSize(c: Ctx, st: Inst): number {
  let end = 0;
  const offs = c.mdeco.get(st.w[0])?.filter(d => d.w[2] === Dec.Offset) ?? [];
  for (let k = 1; k < st.w.length; k++) end = Math.max(end, (offs.find(d => d.w[1] === k - 1)?.w[3] ?? 0) + typeSize(c, st.w[k]));
  return (end + 15) & ~15;
}
function typeSize(c: Ctx, t: number): number {
  const i = c.def.get(t)!;
  if (i.op === Op.TypeInt || i.op === Op.TypeFloat) return i.w[1] / 8;
  if (i.op === Op.TypeVector) return typeSize(c, i.w[1]) * i.w[2];
  if (i.op === Op.TypeArray) return (c.decoration(t, Dec.ArrayStride) ?? typeSize(c, i.w[1])) * (c.constU32(i.w[2]) ?? 1);
  if (i.op === Op.TypeStruct) return structSize(c, i);
  if (i.op === 24 /* matrix */) return typeSize(c, i.w[1]) * i.w[2];
  return 0;
}

// 4b. The uniform slots' bound sizes (bank 25, nxnative's TranslationFlags.MetalUniformBounds: a read past the size the game bound gives 0). WebGPU already requires the
// bound range to cover the block's type, so the host pads a short binding with zeros up to `size` and the comparison is always true: the table becomes a private
// variable of all ones and the GPU compiler folds the selects away. No buffer, no binding
function privatizeBoundSizes(c: Ctx) {
  for (const v of c.m.insts.filter(i => i.op === Op.Variable && i.w[2] === SC.Uniform)) {
    if (!new RegExp(`^[a-z]+_c${CBSIZE_BANK}$`).test(c.names.get(v.w[1]) ?? "")) continue;
    const st = c.def.get(c.def.get(v.w[0])!.w[2])!, arr = c.def.get(st.w[1])!, vec = c.def.get(arr.w[1])!, uint = vec.w[1];
    let at = c.m.insts.indexOf(v), r;
    const add = (op: number, ops: number[], hasType: boolean) => { r = c.intern(op, ops, at, hasType); at += r.added; return r.id; };
    const ones = add(Op.Constant, [uint, 0xffffffff], true);
    const cv = add(Op.ConstantComposite, [vec.w[0], ...Array(vec.w[2]).fill(ones)], true);
    const ca = add(Op.ConstantComposite, [arr.w[0], ...Array(c.constU32(arr.w[2])!).fill(cv)], true);
    const cs = add(Op.ConstantComposite, [st.w[0], ca], true);
    const pp = add(Op.TypePointer, [SC.Private, st.w[0]], false), pu = add(Op.TypePointer, [SC.Private, uint], false);
    v.w = [pp, v.w[1], SC.Private, cs];
    for (const i of c.m.insts) if ((i.op === Op.AccessChain || i.op === Op.InBoundsAccessChain) && i.w[2] === v.w[1]) {
      if (c.def.get(c.def.get(i.w[0])!.w[2])!.op !== Op.TypeInt) throw new Error("the bound size table read other than word by word");
      i.w[0] = pu;
    }
    const gone = new Set([v.w[1], st.w[0]]);
    c.m.insts = c.m.insts.filter(i => !((i.op === Op.Decorate && gone.has(i.w[0]) && (i.w[1] === Dec.Block || i.w[1] === Dec.Binding || i.w[1] === Dec.DescriptorSet)) || (i.op === Op.MemberDecorate && i.w[0] === st.w[0])));
  }
}
// Uniform variables no instruction of a function names (the translator declares the support buffer in every shader)
function dropUnreferenced(c: Ctx) {
  const f = c.firstFunction(), used = new Set<number>();
  for (let k = f; k < c.m.insts.length; k++) for (const w of c.m.insts[k].w) used.add(w);
  const gone = new Set(c.m.insts.filter(i => i.op === Op.Variable && (i.w[2] === SC.Uniform || i.w[2] === SC.UniformConstant) && !used.has(i.w[1])).map(i => i.w[1]));
  c.m.insts = c.m.insts.filter(i => !((i.op === Op.Variable && gone.has(i.w[1])) || ((i.op === Op.Decorate || i.op === Op.Name) && gone.has(i.w[0]))));
}

function imageInfo(c: Ctx, image: number): { dim: Binding["dim"]; sampleType: Binding["sampleType"] } {
  const t = c.def.get(image)!, comp = c.def.get(t.w[1])!, depth = t.w[3] === 1, arrayed = t.w[4] === 1, ms = t.w[5] === 1;
  if (ms) throw new Error("a multisampled texture: not placed yet");
  const d = t.w[2];
  if (d === 0) throw new Error("a 1D texture: WebGPU's 1D textures cannot be arrays, mipmapped or rendered to; needs the 2D-row treatment nxnative gives buffer textures");
  const dim = d === 1 ? (arrayed ? "2d-array" : "2d") : d === 2 ? "3d" : d === 3 ? (arrayed ? "cube-array" : "cube") : undefined;
  if (!dim) throw new Error(`image dimension ${d} has no WGSL texture type`);
  return { dim, sampleType: depth ? "depth" : comp.op === Op.TypeFloat ? "float" : comp.w[2] ? "sint" : "uint" };
}

// 5. Bindings from the translator's names (the interface nxnative's reflection reads too, dmsh_build.py reflect / decode_tex):
//   support_buffer; <p>_c<bank> uniform bank (3..16 = game uniform slot bank - 3, 25 = bound sizes, 1 = own constants, 0 / 2 = driver segments);
//   <p>_t..._tcb_<HANDLE> a texture whose handle is the driver table's word HANDLE & 0x3fff (type in HANDLE >> 28: 0 = combined)
//   <p>_t..._cb<SLOTS>_<HANDLE> bindless (nxnative dmsh_build.py decode_ubo_tex): the handle is word HANDLE & 0x3fff of the game's uniform bank SLOTS & 0xffff
//     (3..16 = uniform slot bank - 3). Type 0: that word holds texture and sampler. Type 1: the sampler is in word (HANDLE >> 14) & 0x3fff of bank (SLOTS >> 16) - 1
//     (the same bank when that is 0). Type 3: the sampler is the constant ID (HANDLE >> 14) & 0x3fff.
//     Such a texture is given a texture slot no bound texture of the shader uses (the lowest free ones, in the order of the variables), and the binding of that slot
const TEX_NAME = /^[a-z]+_t\w*?_(?:cb(\d+)|tcb)_([0-9A-F]+)$/;
function bindlessHandle(name: string, slots: number, h: number): NonNullable<Binding["handle"]> {
  const tb = slots & 0xffff, sb = slots >>> 16 ? (slots >>> 16) - 1 : tb, o0 = (h & 0x3fff) * 4, o1 = ((h >>> 14) & 0x3fff) * 4, type = h >>> 28;
  if (tb < 3 || tb > 16) throw new Error(`texture ${name}: its handle is in uniform bank ${tb}, which is not one of the game's uniform slots: not placed`);
  if (type === 0) return { ubo: tb - 3, offset: o0 };
  if (type === 3) return { ubo: tb - 3, offset: o0, sampler: { id: o1 / 4 } };
  if (type === 1 && sb >= 3 && sb <= 16) return { ubo: tb - 3, offset: o0, sampler: { ubo: sb - 3, offset: o1 } };
  if (type === 1 && sb === 2) throw new Error(`texture ${name}: a bindless texture whose sampler is a separate sampler of the driver table (c2 + 0x${o1.toString(16)}): not placed yet (src/gfx has no separate samplers)`);
  throw new Error(`texture ${name}: a bindless handle of type ${type} (sampler bank ${sb}): not placed`);
}
function place(c: Ctx, stage: FixResult["stage"], samplerOf: Map<number, number>, sizes: Map<number, number>, mode: "nxweb" | "keep"): Binding[] {
  const st = STAGE_INDEX[stage], out: Binding[] = [];
  const set = (id: number, group: number, binding: number) => { if (mode === "nxweb") { c.setDecoration(id, Dec.DescriptorSet, group); c.setDecoration(id, Dec.Binding, binding); } };
  const where = (id: number, group: number, binding: number) => mode === "nxweb" ? { group, binding } : { group: c.decoration(id, Dec.DescriptorSet) ?? 0, binding: c.decoration(id, Dec.Binding) ?? 0 };
  // the texture slots the shader's bound textures take: bindless textures go to the others
  const taken = new Set<number>();
  if (mode === "nxweb") for (const v of c.m.insts) if (v.op === Op.Variable && samplerOf.has(v.w[1])) {
    const m = TEX_NAME.exec(c.names.get(v.w[1]) ?? "");
    if (m && (m[1] === undefined || (+m[1] & 0xffff) === 2)) taken.add((((parseInt(m[2], 16) & 0x3fff) * 4) - C2_TEX) / 8);
  }
  const freeSlot = (name: string) => { for (let s = 0; s < 32; s++) if (!taken.has(s)) { taken.add(s); return s; } throw new Error(`texture ${name}: bindless, and the shader's 32 texture slots are all taken`); };
  for (const v of c.m.insts.filter(i => i.op === Op.Variable)) {
    const id = v.w[1], sc = v.w[2], name = c.names.get(id) ?? "";
    if (sc === SC.StorageBuffer || (sc === SC.Uniform && c.has(c.def.get(c.def.get(v.w[0])!.w[2])!.w[0], Dec.BufferBlock))) throw new Error(`storage buffer ${name}: not placed yet (src/gfx has no storage buffers)`);
    if (sc === SC.Uniform) {
      let b: Omit<Binding, "group" | "binding"> & { group: number; binding: number }, m;
      if (mode === "keep") b = { kind: "cbuf", reg: (c.decoration(id, Dec.Binding) ?? 0) - st * 16, group: 0, binding: 0, name };
      else if (name === "support_buffer") b = { kind: "support", group: 0, binding: st * 16 + SUPPORT_SLOT, name };
      else if ((m = /^[a-z]+_c(\d+)$/.exec(name))) {
        const bank = +m[1];
        if (bank >= 3 && bank <= 16) b = { kind: "cbuf", reg: bank - 3, group: 0, binding: st * 16 + bank - 3, name };
        else if (bank === 1) b = { kind: "c1", group: 3, binding: st * 16, name };
        else if (bank === 0 || bank === 2) b = { kind: "drvcb", bank, group: 3, binding: st * 16 + 1 + bank / 2, name };
        else throw new Error(`uniform bank ${bank} (${name}): not placed`);
      } else throw new Error(`uniform block ${name || id}: not a name the translator gives`);
      Object.assign(b, where(id, b.group, b.binding), { size: sizes.get(id) });
      set(id, b.group, b.binding); out.push(b);
    } else if (sc === SC.UniformConstant) {
      if (samplerOf.has(id)) {
        const info = imageInfo(c, (v as any).image), sv = samplerOf.get(id)!;
        let slot: number, handle: Binding["handle"];
        if (mode === "keep") slot = ((c.decoration(id, Dec.Binding) ?? 0) - st * 64) >> 1;
        else {
          const m = TEX_NAME.exec(name);
          if (!m) throw new Error(`texture ${name || id}: not a name the translator gives`);
          const h = parseInt(m[2], 16), byte = (h & 0x3fff) * 4, type = h >>> 28;
          if (m[1] !== undefined && (+m[1] & 0xffff) !== 2) {
            handle = bindlessHandle(name, +m[1], h); slot = freeSlot(name);
            const sm: any = handle.sampler;
            c.notes.push(`texture ${name} is bindless: slot ${slot} takes its handle from uniform slot ${handle.ubo} + 0x${handle.offset.toString(16)}${sm ? ("id" in sm ? `, sampler ID ${sm.id}` : `, its sampler from uniform slot ${sm.ubo} + 0x${sm.offset.toString(16)}`) : ""} at each draw`);
          } else if (type !== 0) throw new Error(`texture ${name}: a separate texture and sampler (handle type ${type}), not placed yet`);
          else if (byte < C2_TEX || byte >= C2_SEPTEX || (byte - C2_TEX) % 8) throw new Error(`texture ${name}: handle word at c2 + 0x${byte.toString(16)} is not a combined texture slot`);
          else slot = (byte - C2_TEX) / 8;
          if (slot >= 32) throw new Error(`texture ${name}: combined slot ${slot} is past the 32 the binding convention has room for`);
        }
        const t: Binding = { kind: "tex" as const, reg: slot, ...where(id, 1, st * 64 + slot * 2), ...info, name };
        if (handle) t.handle = handle;
        set(id, t.group, t.binding); out.push(t);
        const s = { kind: "samp_tex" as const, reg: slot, ...where(sv, 1, st * 64 + slot * 2 + 1), sampleType: info.sampleType, name: c.names.get(sv)! };
        set(sv, s.group, s.binding); out.push(s);
      } else if ([...samplerOf.values()].includes(id)) continue;
      else throw new Error(`${name || id}: an image or a separate texture / sampler, not placed yet`);
    }
  }
  return out;
}

// 6. position.y *= fix.y; position.z = position.z * fix.z + position.w * fix.w, before every return of the entry point (src/gfx/lower.ts emitState)
function fixup(c: Ctx, posVar: number): Binding {
  const entry = c.m.insts.find(i => i.op === Op.EntryPoint)!.w[1];
  const v4 = c.def.get(c.def.get(c.def.get(c.def.get(posVar)!.w[0])!.w[2])!.w[1])!;   // variable -> pointer -> struct -> member 0
  if (v4.op !== Op.TypeVector || v4.w[2] !== 4) throw new Error("gl_Position is not the first member of gl_PerVertex");
  const f32 = v4.w[1], vec4 = v4.w[0];
  let at = c.firstFunction(), r;
  const add = (op: number, ops: number[], hasType: boolean) => { r = c.intern(op, ops, at, hasType); at += r.added; return r.id; };
  const u32 = add(Op.TypeInt, [32, 0], false);
  const k = [0, 1, 2, 3].map(n => add(Op.Constant, [u32, n], true));
  const st = c.id(); c.m.insts.splice(at++, 0, { op: Op.TypeStruct, w: [st, vec4] });
  const pst = add(Op.TypePointer, [SC.Uniform, st], false), pUf = add(Op.TypePointer, [SC.Uniform, f32], false), pOf = add(Op.TypePointer, [SC.Output, f32], false);
  const uv = c.id(); c.m.insts.splice(at++, 0, { op: Op.Variable, w: [pst, uv, SC.Uniform] });
  c.addDecoration(st, Dec.Block); c.m.insts.splice(c.firstType(), 0, { op: Op.MemberDecorate, w: [st, 0, Dec.Offset, 0] });
  c.addDecoration(uv, Dec.DescriptorSet, 2); c.addDecoration(uv, Dec.Binding, 0);
  c.m.insts.splice(c.m.insts.findIndex(i => i.op === Op.Name || i.op === Op.Decorate), 0, { op: Op.Name, w: [uv, ...strWords("nx_fixup")] });
  const out: Inst[] = []; let inEntry = false;
  for (const i of c.m.insts) {
    if (i.op === Op.Function) inEntry = i.w[1] === entry;
    if (inEntry && i.op === Op.Return) {
      const ld = (ptrType: number, base: number, ...idx: number[]) => { const p = c.id(), v = c.id(); out.push({ op: Op.AccessChain, w: [ptrType, p, base, ...idx] }, { op: Op.Load, w: [f32, v, p] }); return { p, v }; };
      const fy = ld(pUf, uv, k[0], k[1]).v, fz = ld(pUf, uv, k[0], k[2]).v, fw = ld(pUf, uv, k[0], k[3]).v;
      const y = ld(pOf, posVar, k[0], k[1]), z = ld(pOf, posVar, k[0], k[2]), w = ld(pOf, posVar, k[0], k[3]);
      const ny = c.id(), a = c.id(), b = c.id(), nz = c.id();
      out.push({ op: Op.FMul, w: [f32, ny, y.v, fy] }, { op: Op.Store, w: [y.p, ny] },
        { op: Op.FMul, w: [f32, a, z.v, fz] }, { op: Op.FMul, w: [f32, b, w.v, fw] }, { op: Op.FAdd, w: [f32, nz, a, b] }, { op: Op.Store, w: [z.p, nz] });
    }
    out.push(i);
  }
  c.m.insts = out;
  return { kind: "fixup", group: 2, binding: 0, size: 16, name: "nx_fixup" };
}

function interface_(c: Ctx, sc: number): { location: number; type: "float" | "sint" | "uint" }[] {
  const out: { location: number; type: "float" | "sint" | "uint" }[] = [];
  for (const v of c.m.insts.filter(i => i.op === Op.Variable && i.w[2] === sc)) {
    const loc = c.decoration(v.w[1], Dec.Location);
    if (loc === undefined) continue;
    let t = c.def.get(c.def.get(v.w[0])!.w[2])!;
    while (t.op === Op.TypeVector || t.op === Op.TypeArray) t = c.def.get(t.w[1])!;
    out.push({ location: loc, type: t.op === Op.TypeFloat ? "float" : t.w[2] ? "sint" : "uint" });
  }
  return out.sort((a, b) => a.location - b.location);
}

export function fixForWgsl(bytes: Uint8Array, opts: FixOptions = {}): FixResult {
  const c = new Ctx(parse(bytes));
  const ep = c.m.insts.filter(i => i.op === Op.EntryPoint);
  if (ep.length !== 1) throw new Error(`${ep.length} entry points: one stage per module is expected`);
  const model = ep[0].w[0], stage = model === 0 ? "vertex" : model === 4 ? "fragment" : model === 5 ? "compute" : undefined;
  if (!stage) throw new Error(`execution model ${model} (geometry, tessellation, task or mesh): WebGPU has no such stage`);
  dropUnused(c); c.index();
  nanTests(c); c.index();
  mulExtended(c); c.index();
  dropUnreferenced(c); c.index();
  privatizeBoundSizes(c); c.index();
  const posVar = perVertex(c); c.index();
  const samplerOf = splitSamplers(c); c.index();
  const sizes = opts.shrinkUniforms === false ? new Map<number, number>(c.m.insts.filter(i => i.op === Op.Variable && i.w[2] === SC.Uniform).map(v => [v.w[1], structSize(c, c.def.get(c.def.get(v.w[0])!.w[2])!)])) : shrinkUniforms(c);
  const bindings = place(c, stage, samplerOf, sizes, opts.bindings ?? "nxweb"); c.index();
  if (stage === "vertex" && opts.fixup !== false) {
    if (!posVar) throw new Error("a vertex shader that never writes gl_Position");
    bindings.push(fixup(c, posVar)); c.index();
  }
  for (const i of c.m.insts) delete (i as any).image, delete (i as any).sampler;
  return { spv: serialize(c.m), stage, bindings, inputs: interface_(c, SC.Input), outputs: interface_(c, SC.Output), notes: c.notes };
}
