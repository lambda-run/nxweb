// Warp instructions (Maxwell VOTE, SHFL, S2R SR_LANEID / SR_*MASK; GLSL's KHR_shader_subgroup) made into something WGSL has, one of two ways (FixOptions.subgroups):
//   "native": the device has WebGPU's `subgroups` feature. naga emits WGSL's subgroup builtins (convert.ts adds `enable subgroups;`). The translator's code means
//     32-lane warps (Ryujinx HelperFunctionManager with subgroup size 32), so the ops are rewritten to that view of any subgroup: the lane is
//     subgroup_invocation_id & 31, a ballot is the 32-bit word of the lane's warp, votes and elect come from that word, an indexed shuffle or broadcast reads within
//     the warp, the lane masks are computed (WGSL has none), SubgroupSize is at most 32. Exact where subgroups have 32 lanes or more (NVIDIA, AMD, Apple); a narrower subgroup
//     (Intel 8 / 16, SwiftShader 4) leaves the rest of a warp out of reach.
//   "single": no `subgroups` (Firefox, some adapters), or a vertex shader (WGSL has subgroup builtins in compute and fragment shaders only): each invocation is a
//     subgroup of its own, as nxnative's spv_single_lane (dmsh_build.py) does for Metal: ballot = this lane's bit when the predicate holds, shuffles and broadcasts
//     read the own value, all / any = the predicate, all-equal and elect = true, reductions and inclusive scans = the own value, exclusive scans = the identity,
//     SubgroupSize = 1, SubgroupLocalInvocationId = 0, the lane masks those of lane 0.
import { Ctx, Op, Dec, SC, str, type Inst } from "./spv.ts";

export type SubgroupPath = "native" | "single";

const BI = { SubgroupSize: 36, NumSubgroups: 38, SubgroupId: 40, LaneId: 41, EqMask: 4416, GeMask: 4417, GtMask: 4418, LeMask: 4419, LtMask: 4420 };
const MASKS = new Set([BI.EqMask, BI.GeMask, BI.GtMask, BI.LeMask, BI.LtMask]), SUBGROUP_BI = new Set(Object.values(BI));
const CAPS = [61, 62, 63, 64, 65, 66, 67];      // GroupNonUniform, Vote, Arithmetic, Ballot, Shuffle, ShuffleRelative, Clustered (68 is Quad)
const GLSL_FIND_ILSB = 73, GLSL_FIND_UMSB = 75;
// results of a one-lane exclusive scan: the operation's identity, per opcode (bits of the 32-bit integer or float, or the bool)
const IDENTITY: Record<number, number | boolean> = { 349: 0, 350: 0, 351: 1, 352: 0x3f800000, 353: 0x7fffffff, 354: 0xffffffff, 355: 0x7f800000, 356: 0x80000000, 357: 0, 358: 0xff800000,
  359: 0xffffffff, 360: 0, 361: 0, 362: true, 363: false, 364: false };
// body instructions without a result type (the rest have [type, id, ...])
const NO_RESULT = new Set([8, 56, 62, 63, 99, 218, 219, 224, 225, 228, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 317, 4416, 5364, 5365, 5380]);

export function usesSubgroups(c: Ctx): boolean {
  return c.m.insts.some(i => (i.op >= 333 && i.op <= 366) || (i.op === Op.Decorate && i.w[1] === Dec.BuiltIn && SUBGROUP_BI.has(i.w[2])));
}

// The path taken, or undefined when the module has no warp operation (its subgroup capabilities, which the translator declares for every shader, are dropped)
export function subgroups(c: Ctx, stage: "vertex" | "fragment" | "compute", want: SubgroupPath): SubgroupPath | undefined {
  const dropCaps = () => { c.m.insts = c.m.insts.filter(i => !(i.op === Op.Capability && (CAPS.includes(i.w[0]) || i.w[0] === 68))); };
  if (!usesSubgroups(c)) { dropCaps(); return undefined; }
  const path: SubgroupPath = want === "native" && stage !== "vertex" ? "native" : "single", native = path === "native";
  const builtin = new Map<number, number>();     // Input variable -> its subgroup builtin
  for (const i of c.m.insts) if (i.op === Op.Variable && i.w[2] === SC.Input) { const b = c.decoration(i.w[1], Dec.BuiltIn); if (b !== undefined && SUBGROUP_BI.has(b)) builtin.set(i.w[1], b); }
  const gone = new Set([...builtin].filter(([, b]) => !native || MASKS.has(b)).map(([v]) => v));
  if (!native) for (const [v, b] of builtin) if (b === BI.NumSubgroups || b === BI.SubgroupId) throw new Error(`${b === BI.NumSubgroups ? "NumSubgroups" : "SubgroupId"} in a one-invocation subgroup lowering: not done`);

  const glob = (op: number, ops: number[], hasType: boolean) => c.intern(op, ops, c.firstFunction(), hasType).id;
  const u32 = glob(Op.TypeInt, [32, 0], false), bool = glob(Op.TypeBool, [], false), uvec4 = glob(Op.TypeVector, [u32, 4], false);
  const ku = (v: number) => glob(Op.Constant, [u32, v >>> 0], true);
  const kTrue = glob(41, [bool], true), kFalse = glob(42, [bool], true);
  const constOf = (t: number, v: number | boolean): number => {
    const d = c.def.get(t)!;
    if (d.op === Op.TypeVector) { const k = constOf(d.w[1], v); return glob(Op.ConstantComposite, [t, ...Array(d.w[2]).fill(k)], true); }
    if (d.op === Op.TypeBool) return glob(v ? 41 : 42, [t], true);
    if ((d.op !== Op.TypeInt && d.op !== Op.TypeFloat) || d.w[1] !== 32) throw new Error("a warp operation on a value that is not 32-bit: not lowered");
    return glob(Op.Constant, [t, Number(v) >>> 0], true);
  };
  const vec4Of = (t: number, x: number) => { const d = c.def.get(t)!; if (d.op !== Op.TypeVector) return constOf(t, x); const z = constOf(d.w[1], 0); return glob(Op.ConstantComposite, [t, constOf(d.w[1], x), z, z, z], true); };
  let glslId = 0;
  const glsl = () => {
    if (glslId) return glslId;
    const have = c.m.insts.find(i => i.op === Op.ExtInstImport && str(i.w, 1) === "GLSL.std.450");
    if (have) return glslId = have.w[0];
    glslId = c.id();
    let at = 0; c.m.insts.forEach((i, k) => { if (i.op === Op.Capability || i.op === Op.Extension || i.op === Op.ExtInstImport) at = k + 1; });
    c.m.insts.splice(at, 0, { op: Op.ExtInstImport, w: [glslId, ...words("GLSL.std.450")] });
    return glslId;
  };
  // native: the subgroup_invocation_id variable (added when the shader has none)
  let laneVar = [...builtin].find(([, b]) => b === BI.LaneId)?.[0], laneType = u32;
  if (native && laneVar !== undefined) laneType = c.def.get(c.def.get(c.def.get(laneVar)!.w[0])!.w[2])!.op === Op.TypeInt ? c.def.get(c.def.get(laneVar)!.w[0])!.w[2] : u32;
  if (native && laneVar === undefined) {
    const ptr = glob(Op.TypePointer, [SC.Input, u32], false);
    laneVar = c.id();
    c.m.insts.splice(c.firstFunction(), 0, { op: Op.Variable, w: [ptr, laneVar, SC.Input] });
    c.addDecoration(laneVar, Dec.BuiltIn, BI.LaneId);
    if (stage === "fragment") c.addDecoration(laneVar, 14 /* Flat: Vulkan wants it on an integer input of a fragment stage */);
    c.m.insts.find(i => i.op === Op.EntryPoint)!.w.push(laneVar);
  }

  const typeOf = new Map<number, number>();
  for (const i of c.m.insts) if ((i.op === Op.Constant || i.op === Op.ConstantComposite || (i.op >= 41 && i.op <= 52) || [1, 12, 55, 57].includes(i.op) || (i.op >= Op.Load && !NO_RESULT.has(i.op))) && i.w.length > 1) typeOf.set(i.w[1], i.w[0]);
  const f = c.firstFunction(), body = c.m.insts.slice(f), out: Inst[] = [];
  const e = (op: number, type: number, ...ops: number[]) => { const id = c.id(); out.push({ op, w: [type, id, ...ops] }); return id; };
  const set = (id: number, op: number, type: number, ...ops: number[]) => { out.push({ op, w: [type, id, ...ops] }); };
  const copy = (type: number, id: number, v: number) => set(id, 83, type, v);
  const asU32 = (x: number) => typeOf.get(x) === u32 ? x : e(124, u32, x);
  // per instruction, so every value is computed where it is used (helpers live in functions of their own)
  const rawLane = () => laneType === u32 ? e(Op.Load, u32, laneVar!) : e(124, u32, e(Op.Load, laneType, laneVar!));
  const lane32 = () => native ? e(199, u32, rawLane(), ku(31)) : ku(0);
  const warpBase = () => e(199, u32, rawLane(), ku(0xffffffe0));
  // a ballot's predicate: naga writes a constant true one as `subgroupBallot()`, which WGSL does not have (the builtin takes a bool). The translator ballots
  // a constant true itself (the active lanes), so every constant true predicate becomes a true that is none: lane == lane
  const isTrue = (p: number) => { const d = c.def.get(p); return !!d && (d.op === 41 /* OpConstantTrue */ || d.op === 48 /* OpSpecConstantTrue */); };
  const liveTrue = () => { const r = rawLane(); return e(170, bool, r, r); };
  const ballotWord = (p: number) => native ? e(77, u32, e(339, uvec4, ku(3), isTrue(p) ? liveTrue() : p), e(194, u32, rawLane(), ku(5))) : e(169, u32, p, ku(1), ku(0));
  // the warp's active lanes
  const active = () => ballotWord(liveTrue());
  const findLsb = (x: number) => e(12, u32, glsl(), GLSL_FIND_ILSB, x);
  const eqMask = () => native ? e(196, u32, ku(1), lane32()) : ku(1);
  const ltMask = () => native ? e(130, u32, eqMask(), ku(1)) : ku(0);
  const leMask = () => native ? e(197, u32, ltMask(), eqMask()) : ku(1);
  const maskOf = (b: number) => b === BI.EqMask ? eqMask() : b === BI.LtMask ? ltMask() : b === BI.LeMask ? leMask() : b === BI.GtMask ? (native ? e(200, u32, leMask()) : ku(0)) : (native ? e(200, u32, ltMask()) : ku(1));
  const bitOf = (word: number, i: number) => e(171, bool, e(199, u32, e(194, u32, word, e(199, u32, i, ku(31))), ku(1)), ku(0));
  // the value of a subgroup builtin of type t, as the variable gives it (one-lane constants, or the native warp view's masks)
  const builtinValue = (b: number, t: number): number => {
    if (!native && !MASKS.has(b)) return constOf(t, b === BI.SubgroupSize ? 1 : 0);
    if (!native) return vec4Of(t, b === BI.GtMask || b === BI.LtMask ? 0 : 1);
    const d = c.def.get(t)!, comp = d.op === Op.TypeVector ? d.w[1] : t, x = maskOf(b), xc = comp === u32 ? x : e(124, comp, x);
    if (d.op !== Op.TypeVector) return xc;
    const z = constOf(comp, 0); return e(Op.CompositeConstruct, t, xc, ...Array(d.w[2] - 1).fill(z));
  };
  // what naga has no IR for, from shuffles of the 32-lane warp view: the scans other than add and multiply (Hillis-Steele over ShuffleUp), clustered reductions (butterflies)
  const BIN: Record<number, number> = { 349: 128, 350: 129, 351: 132, 352: 133, 359: 199, 360: 197, 361: 198, 362: 167, 363: 166, 364: 165 };
  const EXT: Record<number, number> = { 353: 39, 354: 38, 355: 37, 356: 42, 357: 41, 358: 40 };   // GLSL.std.450 SMin UMin FMin SMax UMax FMax
  const combine = (op: number, t: number, a: number, b: number) => BIN[op] ? e(BIN[op], t, a, b) : e(12, t, glsl(), EXT[op], a, b);
  const pick = (t: number, p: number, a: number, b: number) => {
    const d = c.def.get(t)!;
    return e(169, t, d.op === Op.TypeVector ? e(Op.CompositeConstruct, glob(Op.TypeVector, [bool, d.w[2]], false), ...Array(d.w[2]).fill(p)) : p, a, b);
  };
  const scan = (op: number, t: number, x: number, inclusive: boolean) => {
    let acc = x;
    for (const d of [1, 2, 4, 8, 16]) acc = pick(t, e(174, bool, lane32(), ku(d)), combine(op, t, acc, e(347, t, ku(3), acc, ku(d))), acc);
    return inclusive ? acc : pick(t, e(174, bool, lane32(), ku(1)), e(347, t, ku(3), acc, ku(1)), identity(op, t, x));
  };
  // min / max of floats start at +-infinity, which WGSL has no literal for: the bits, cast where used
  // (and that WGSL compilers fold and refuse when constant: so the bits are ORed into the value's own bits ANDed with 0)
  const identity = (op: number, t: number, x: number) => {
    if (op !== 355 && op !== 358) return constOf(t, IDENTITY[op]);
    const d = c.def.get(t)!, ut = d.op === Op.TypeVector ? glob(Op.TypeVector, [u32, d.w[2]], false) : u32;
    return e(124, t, e(197, ut, e(199, ut, e(124, ut, x), constOf(ut, 0)), constOf(ut, IDENTITY[op])));
  };
  const cluster = (op: number, t: number, x: number, size: number) => {
    if (!(size >= 1 && size <= 32 && (size & (size - 1)) === 0)) throw new Error(`a clustered reduction of ${size} lanes: not lowered`);
    let acc = x;
    for (let m = 1; m < size; m <<= 1) acc = combine(op, t, acc, e(346, t, ku(3), acc, ku(m)));
    return acc;
  };
  const chains = new Map<number, { b: number; t: number; index: number }>();
  for (const i of body) {
    const [type, id] = i.w;
    if ((i.op === Op.AccessChain || i.op === Op.InBoundsAccessChain) && gone.has(i.w[2])) {
      if (i.w.length !== 4) throw new Error("a subgroup builtin indexed twice");
      chains.set(id, { b: builtin.get(i.w[2])!, t: c.def.get(c.def.get(i.w[2])!.w[0])!.w[2], index: i.w[3] }); continue;
    }
    if (i.op === Op.Load && gone.has(i.w[2])) { copy(type, id, builtinValue(builtin.get(i.w[2])!, type)); continue; }
    if (i.op === Op.Load && chains.has(i.w[2])) { const ch = chains.get(i.w[2])!; set(id, 77, type, builtinValue(ch.b, ch.t), ch.index); continue; }
    // (a warp is 32 lanes of a wider subgroup)
    if (i.op === Op.Load && native && builtin.get(i.w[2]) === BI.SubgroupSize) { set(id, 12, type, glsl(), 38, e(Op.Load, type, i.w[2]), constOf(type, 32)); continue; }
    if (i.op === Op.Load && native && i.w[2] === laneVar) { set(id, 199, type, e(Op.Load, type, laneVar), constOf(type, 31)); continue; }
    if ((i.op === Op.Store || i.op === 63 || i.op === 57) && i.w.some(w => gone.has(w) || chains.has(w))) throw new Error("a subgroup builtin used other than loaded");
    if (i.op < 333 || i.op > 366) { out.push(i); continue; }
    const scope = i.w[2], v = i.w[3];
    switch (i.op) {
      case 333: if (native) set(id, 170, type, lane32(), findLsb(active())); else copy(type, id, kTrue); break;    // Elect
      case 334: if (native) set(id, 170, type, ballotWord(v), active()); else copy(type, id, v); break;           // All
      case 335: if (native) set(id, 171, type, ballotWord(v), ku(0)); else copy(type, id, v); break;                       // Any
      case 336: {                                                                                                         // AllEqual
        if (!native) { copy(type, id, kTrue); break; }
        const vt = typeOf.get(v), d = vt === undefined ? undefined : c.def.get(vt)!;
        if (!d || (d.op !== Op.TypeBool && d.op !== Op.TypeInt && d.op !== Op.TypeFloat)) throw new Error("all-equal of a vector or of a value of unknown type: not lowered");
        if (d.op === Op.TypeBool) { const b = ballotWord(v); set(id, 166, type, e(170, bool, b, active()), e(170, bool, b, ku(0))); break; }
        const first = e(345, vt!, scope, v, e(197, u32, warpBase(), findLsb(active())));
        set(id, 170, type, ballotWord(e(d.op === Op.TypeFloat ? 180 : 170, bool, v, first)), active()); break;
      }
      case 337: if (native) set(id, 345, type, scope, v, e(197, u32, warpBase(), e(199, u32, asU32(i.w[4]), ku(31)))); else copy(type, id, v); break;   // Broadcast
      case 338: if (native) set(id, 345, type, scope, v, e(197, u32, warpBase(), findLsb(active()))); else copy(type, id, v); break;           // BroadcastFirst
      case 339: if (native) set(id, Op.CompositeConstruct, type, ballotWord(v), ku(0), ku(0), ku(0)); else copy(type, id, pick(type, v, vec4Of(type, 1), vec4Of(type, 0))); break;   // Ballot
      case 340: copy(type, id, bitOf(e(Op.CompositeExtract, u32, v, 0), lane32())); break;                                // InverseBallot
      case 341: { const k = asU32(i.w[4]); copy(type, id, bitOf(e(77, u32, v, e(194, u32, k, ku(5))), k)); break; }     // BallotBitExtract
      case 342: {                                                                                                         // BallotBitCount
        const gop = i.w[3], b = i.w[4], x = e(Op.CompositeExtract, u32, b, 0);
        if (gop === 0) set(id, 128, type, e(128, u32, e(205, u32, x), e(205, u32, e(Op.CompositeExtract, u32, b, 1))), e(128, u32, e(205, u32, e(Op.CompositeExtract, u32, b, 2)), e(205, u32, e(Op.CompositeExtract, u32, b, 3))));
        else if (gop === 1 || gop === 2) set(id, 205, type, e(199, u32, x, gop === 1 ? leMask() : ltMask()));
        else throw new Error(`ballot bit count with group operation ${gop}: not lowered`);
        break;
      }
      case 343: case 344: set(id, 12, type, glsl(), i.op === 343 ? GLSL_FIND_ILSB : GLSL_FIND_UMSB, e(Op.CompositeExtract, u32, v, 0)); break;   // BallotFindLSB / MSB
      case 345: if (native) set(id, 345, type, scope, v, e(197, u32, warpBase(), e(199, u32, asU32(i.w[4]), ku(31)))); else copy(type, id, v); break;   // Shuffle
      case 346: case 347: case 348: case 365: case 366: if (native) out.push(i); else copy(type, id, v); break;          // ShuffleXor / Up / Down, quad ops
      default: {                                                                                                          // 349..364: reductions and scans
        const gop = i.w[3], x = i.w[4];
        if (native) {
          // WGSL has subgroupAdd .. subgroupXor of numbers and the add and multiply scans; logical ones go through 0 / 1 integers
          const logical = i.op >= 362, d = c.def.get(type)!, ut = !logical ? type : d.op === Op.TypeVector ? glob(Op.TypeVector, [u32, d.w[2]], false) : u32;
          const op = logical ? i.op - 3 : i.op, xu = logical ? pick(ut, x, constOf(ut, 1), constOf(ut, 0)) : x;
          let r: number;
          if (gop === 0 || ((gop === 1 || gop === 2) && op <= 352)) { if (!logical) { out.push(i); break; } r = e(op, ut, scope, gop, xu); }
          else if (gop === 1 || gop === 2) r = scan(op, ut, xu, gop === 1);
          else if (gop === 3) r = cluster(op, ut, xu, c.constU32(i.w[5]) ?? 0);
          else throw new Error(`group operation ${gop}: not lowered`);
          if (logical) set(id, 171, type, r, constOf(ut, 0)); else copy(type, id, r);
          break;
        }
        if (gop === 2) copy(type, id, identity(i.op, type, x)); else copy(type, id, x);
      }
    }
  }
  c.m.insts = [...c.m.insts.slice(0, c.firstFunction()), ...out];
  if (gone.size) {
    const ep = c.m.insts.find(i => i.op === Op.EntryPoint)!;
    let k = 2; for (;;) { const x = ep.w[k++]; if ((x & 0xff) === 0 || (x & 0xff00) === 0 || (x & 0xff0000) === 0 || (x >>> 24) === 0) break; }
    ep.w = [...ep.w.slice(0, k), ...ep.w.slice(k).filter(id => !gone.has(id))];
    c.m.insts = c.m.insts.filter(i => !((i.op === Op.Variable && gone.has(i.w[1])) || ((i.op === Op.Decorate || i.op === Op.Name) && gone.has(i.w[0]))));
  }
  if (native) {
    let at = c.m.insts.findIndex(i => i.op !== Op.Capability);
    for (const cap of [61, 64, 65, 66]) if (!c.m.insts.some(i => i.op === Op.Capability && i.w[0] === cap)) c.m.insts.splice(at++, 0, { op: Op.Capability, w: [cap] });
    c.notes.push("warp operations on WebGPU subgroups: read as 32-lane Maxwell warps (lane = subgroup_invocation_id & 31, a ballot is the warp's 32-bit word, votes and elect come from it, " +
      "indexed shuffles and broadcasts stay in the warp, SubgroupSize is at most 32; reductions and add / multiply scans span the device's subgroup); exact where the device's subgroups have 32 lanes or more, a narrower subgroup leaves the rest of a warp out of reach");
  } else {
    dropCaps();
    c.notes.push(`warp operations lowered for one-invocation subgroups (${want === "native" ? "WGSL has no subgroup operations in vertex shaders" : "the device has no WebGPU subgroups feature"}): ` +
      "ballot = this invocation's bit when the predicate holds, shuffles and broadcasts read the own value, all / any = the predicate, all-equal and elect = true, reductions = the own value, " +
      "SubgroupSize = 1, SubgroupLocalInvocationId = 0; exact only where the result does not need other lanes' values");
  }
  return path;
}

function words(s: string): number[] {
  const b = new TextEncoder().encode(s), w = new Array((b.length >> 2) + 1).fill(0);
  b.forEach((x, k) => { w[k >> 2] |= x << ((k & 3) * 8); });
  return w;
}
