// Pool textures: a texture read through a handle the translator traced to no word it can name. Ryujinx's bindless fallback (BindlessToArray.cs, sized by nxnative's
// Program.cs QueryTextureArrayLengthFromPool) then declares the game's whole pools as arrays, `<p>_t<type>_cb0_40000000[2^20]` of textures and `<p>_s_cb0_40000000[2^12]`
// of samplers, and indexes them with the handle's two IDs (texture ID = handle & 0xfffff, sampler ID = handle >> 20). nxnative binds the pools themselves (Metal
// argument buffers, dmsh_build.py pool_arrays, reflection kinds tex_pool / samp_pool). WebGPU has no binding arrays and 16 sampled textures a stage, so here:
//   - each pool array becomes POOL_SLOTS ordinary combined textures in free texture slots (fewer when the shader's bound textures leave less room);
//   - the pass finds where the handle comes from: one word of a record table in a storage buffer, word (stride * i + offset) / 4 for a run-time i (a light list:
//     one record per light, its shadow map's handle inside). The recorder walks that table at each draw (src/gfx/lower.ts poolHandle), binds the first distinct
//     live handles to the slots, and writes which handle each slot got into driver segment c2 at C2_POOL + 4 * entry;
//   - every read through the pool becomes a switch: the handle is compared with the table's words and the read is made on the slot that holds it; a handle in no
//     slot reads 0.
// A handle from anywhere else (a uniform word at a run-time index, a varying, arithmetic) is refused by name. Runs before the combined samplers are split (spv.ts step 3)
import { type Ctx, Op, Dec, SC, type Inst, type FixOptions, type FixResult, storageSlot } from "./spv.ts";

export const POOL_SLOTS = 4, POOL_ENTRIES = 16, C2_POOL = 0x980, STAGE_TEXTURES = 16;
// tex binding: the slot takes the `index`-th distinct live handle among the words at byte `offset` + `stride` * i (i = 0, 1, ... to the bound size; stride 0: that one
// word) of the range bound at storage slot `sbuf` of the stage; the handle it got is word `entry` of the table at c2 + C2_POOL
// `columns`: bit k = the word 4 (k + 1) bytes after it in each record holds a handle too. `at`: the shader reads one record only, and which is uniform data: i = the
// sum of the terms, each the u32 at byte `offset` of uniform slot `ubo` of the stage (`mask`: its low 20 bits); `guard`: i is 0 unless the first term's word has
// 0b10 in its top two bits (a material's texture reference: a tag and an index into the table of all the scene's textures). Only that record's handles take slots
export interface PoolAt { terms: { ubo: number; offset: number; mask: boolean }[]; guard: boolean }
export interface PoolHandle { sbuf: number; offset: number; stride: number; index: number; entry: number; columns?: number; at?: PoolAt }

const O = { ExtInst: 12, ConstantNull: 46, CopyObject: 83, Image: 100, Bitcast: 124, IAdd: 128, IMul: 132, LogicalNot: 168, Select: 169, IEqual: 170, INotEqual: 171, ULessThan: 176, ShiftRightLogical: 194, ShiftRightArithmetic: 195, ShiftLeftLogical: 196,
  BitwiseOr: 197, BitwiseAnd: 199, Phi: 245, LoopMerge: 246, SelectionMerge: 247, Branch: 249, Switch: 251 };
const SC_FUNCTION = 7, UMIN = 38;
// the instructions that read a texture: type, result, then the sampled image (87..94 samples, 96 / 97 gathers, 105 the LOD query) or the image (95 fetch, 103 / 104 size, 106 levels)
const ON_SAMPLED = new Set([87, 88, 89, 90, 91, 92, 93, 94, 96, 97, 105]), ON_IMAGE = new Set([95, 103, 104, 106]);

export function poolTextures(c: Ctx, stage: FixResult["stage"], sbufs: NonNullable<FixOptions["sbufs"]>, mesh?: "ts" | "ms"): Map<number, PoolHandle> {
  const placed = new Map<number, PoolHandle>();
  const elem = (v: Inst) => { const a = c.def.get(c.def.get(v.w[0])!.w[2]); return a && a.op === Op.TypeArray ? c.def.get(a.w[1]) : undefined; };
  const globals = c.m.insts.filter(i => i.op === Op.Variable && i.w[2] === SC.UniformConstant);
  const texPools = globals.filter(v => elem(v)?.op === Op.TypeImage), sampPools = globals.filter(v => elem(v)?.op === Op.TypeSampler);
  if (!texPools.length && !sampPools.length) return placed;
  const nameOf = (id: number) => c.names.get(id) ?? `${id}`;
  if (!texPools.length) throw new Error(`${nameOf(sampPools[0].w[1])}: a sampler pool with no texture pool: not placed yet`);
  if (c.m.insts.some(i => i.op === O.Phi)) throw new Error(`texture ${nameOf(texPools[0].w[1])}: a pool texture in a module with OpPhi: not placed yet`);
  const bound = globals.filter(v => c.def.get(c.def.get(v.w[0])!.w[2])?.op === Op.TypeSampledImage).length;
  // as many slots as leave the stage within WebGPU's default 16 sampled textures, and one a pool when the bound textures alone are past that (a device with more may draw it)
  const KW = Math.max(1, Math.min(POOL_SLOTS, Math.floor((STAGE_TEXTURES - bound) / texPools.length), Math.floor(POOL_ENTRIES / texPools.length)));
  if (texPools.length > POOL_ENTRIES) throw new Error(`texture ${nameOf(texPools[0].w[1])}: ${texPools.length} pool textures, more than the table's ${POOL_ENTRIES} entries: not placed yet`);

  // ---- where a value comes from: results by id, and the single store of a function variable ----
  const defs = new Map<number, Inst>(), stores = new Map<number, number[]>();
  const first = c.firstFunction();
  const TRACED = new Set<number>([O.ExtInst, O.CopyObject, O.Bitcast, O.IAdd, O.IMul, O.ShiftRightLogical, O.ShiftRightArithmetic, O.ShiftLeftLogical, O.BitwiseAnd, O.BitwiseOr, O.Select, O.LogicalNot, O.IEqual, O.INotEqual, O.ULessThan, Op.Load, Op.AccessChain, Op.InBoundsAccessChain]);
  for (let k = first; k < c.m.insts.length; k++) {
    const i = c.m.insts[k];
    if (TRACED.has(i.op)) defs.set(i.w[1], i);
    else if (i.op === Op.Store) { const a = stores.get(i.w[0]); if (a) a.push(i.w[1]); else stores.set(i.w[0], [i.w[1]]); }
  }
  const isLocal = (p: number) => { const v = c.def.get(p); return !!v && v.op === Op.Variable && v.w[2] === SC_FUNCTION; };
  const peel = (id: number): number => {
    for (let n = 0; n < 64; n++) {
      const d = defs.get(id);
      if (!d) return id;
      if (d.op === O.Bitcast || d.op === O.CopyObject) id = d.w[2];
      else if (d.op === Op.Load && isLocal(d.w[2]) && stores.get(d.w[2])?.length === 1) id = stores.get(d.w[2])![0];
      else return id;
    }
    return id;
  };
  const konst = (id: number) => c.constU32(peel(id));
  // a * i + b for one run-time value i (`x`; a = 0: a constant), or nothing when the value is not that. `guard`: the value is b instead (i = 0) when this condition is false
  type Affine = { a: number; b: number; x?: number; guard?: number };
  const affine = (id: number, depth = 0): Affine | undefined => {
    id = peel(id);
    const k = c.constU32(id), leaf = { a: 1, b: 0, x: id };
    if (k !== undefined) return { a: 0, b: k };
    const d = defs.get(id);
    if (!d || depth > 32) return leaf;
    if (d.op === O.IAdd) {
      const x = affine(d.w[2], depth + 1), y = affine(d.w[3], depth + 1);
      if (!x || !y) return undefined;
      return x.a && y.a ? leaf : { ...(x.a ? x : y), a: x.a + y.a, b: x.b + y.b };
    }
    if (d.op === O.IMul || d.op === O.ShiftLeftLogical) {
      const kx = konst(d.w[2]), ky = konst(d.w[3]);
      const f = d.op === O.IMul ? (ky ?? kx) : ky === undefined ? undefined : 2 ** ky, x = d.op === O.IMul && ky === undefined ? d.w[3] : d.w[2];
      if (f === undefined) return leaf;
      const v = affine(x, depth + 1);
      return v && { ...v, a: v.a * f, b: v.b * f };
    }
    if (d.op === O.ShiftRightLogical || d.op === O.ShiftRightArithmetic) {
      const n = konst(d.w[3]), v = n === undefined ? undefined : affine(d.w[2], depth + 1);
      if (!v || n === undefined) return leaf;
      const f = 2 ** n;
      return v.a % f || v.b % f ? leaf : { ...v, a: v.a / f, b: v.b / f };
    }
    if (d.op === O.Select) {      // cond ? a i + b : b
      const t = affine(d.w[3], depth + 1), f = affine(d.w[4], depth + 1);
      return t && f && t.a && !f.a && f.b === t.b && t.guard === undefined && guardWord(d.w[2]) ? { ...t, guard: d.w[2] } : leaf;
    }
    return leaf;
  };
  // a word of one of the game's uniform slots (through the translator's bound-size select, which the recorder's read answers the same way: 0 past the bound size)
  const uboWord = (id: number): { ubo: number; offset: number } | undefined => {
    id = peel(id);
    const d = defs.get(id);
    if (!d) return undefined;
    if (d.op === O.Select && konst(d.w[4]) === 0 && defs.get(peel(d.w[2]))?.op === O.ULessThan) return uboWord(d.w[3]);
    const p = d.op === Op.Load ? defs.get(d.w[2]) : undefined, bank = p && /^[a-z]+_c(\d+)$/.exec(c.names.get(p.w[2]) ?? "")?.[1];
    if (!p || (p.op !== Op.AccessChain && p.op !== Op.InBoundsAccessChain) || p.w.length !== 6 || bank === undefined || +bank < 3 || +bank > 16) return undefined;
    const vec = c.constU32(p.w[4]), comp = c.constU32(p.w[5]);
    return vec === undefined || comp === undefined ? undefined : { ubo: +bank - 3, offset: vec * 16 + comp * 4 };
  };
  const terms = (id: number, depth = 0): PoolAt["terms"] | undefined => {
    id = peel(id);
    const w = uboWord(id), d = defs.get(id);
    if (w) return [{ ...w, mask: false }];
    if (!d || depth > 4) return undefined;
    if (d.op === O.IAdd) { const x = terms(d.w[2], depth + 1), y = terms(d.w[3], depth + 1); return x && y && [...x, ...y]; }
    if (d.op === O.BitwiseAnd && (konst(d.w[3]) === 0xfffff || konst(d.w[2]) === 0xfffff)) { const m = uboWord(konst(d.w[3]) === 0xfffff ? d.w[2] : d.w[3]); return m && [{ ...m, mask: true }]; }
    return undefined;
  };
  // (w & 0xc0000000) == 0x80000000, as the translator writes it (!(… != …)): the word w
  const guardWord = (cond: number) => {
    let d = defs.get(peel(cond)), not = false;
    if (d && d.op === O.LogicalNot) { d = defs.get(peel(d.w[2])); not = true; }
    if (!d || d.op !== (not ? O.INotEqual : O.IEqual)) return undefined;
    const k = konst(d.w[3]) === 0x80000000 ? d.w[2] : konst(d.w[2]) === 0x80000000 ? d.w[3] : undefined, m = k === undefined ? undefined : defs.get(peel(k));
    if (!m || m.op !== O.BitwiseAnd) return undefined;
    return konst(m.w[3]) === 0xc0000000 ? uboWord(m.w[2]) : konst(m.w[2]) === 0xc0000000 ? uboWord(m.w[3]) : undefined;
  };
  // the record index as uniform data, when it is that
  const indexAt = (x: number | undefined, guard: number | undefined): PoolAt | undefined => {
    if (x === undefined) return undefined;
    x = peel(x);
    const d = defs.get(x);
    if (guard === undefined && d && d.op === O.Select && konst(d.w[4]) === 0 && guardWord(d.w[2])) { guard = d.w[2]; x = d.w[3]; }
    const t = terms(x);
    if (!t || t.length > 2) return undefined;
    if (guard === undefined) return { terms: t, guard: false };
    const g = guardWord(guard), k = g ? t.findIndex(e => e.mask && e.ubo === g.ubo && e.offset === g.offset) : -1;
    return k < 0 ? undefined : { terms: [t[k], ...t.filter((_, n) => n !== k)], guard: true };
  };
  const isStorage = (id: number) => {
    const v = c.def.get(id);
    return !!v && v.op === Op.Variable && (v.w[2] === SC.StorageBuffer || (v.w[2] === SC.Uniform && c.has(c.def.get(c.def.get(v.w[0])!.w[2])!.w[0], Dec.BufferBlock)));
  };
  // the storage buffer word an ID of the pool arrays' index is taken from: min(handle & 0xfffff, 0xfffff) the texture's, min(handle >> 20, 0xfff) the sampler's
  const source = (id: number, part: "texture" | "sampler"): (Affine & { buffer: number }) | undefined => {
    for (let n = 0; n < 16; n++) {
      id = peel(id);
      const d = defs.get(id);
      if (!d) return undefined;
      if (d.op === O.ExtInst && d.w[3] === UMIN) id = konst(d.w[5]) !== undefined ? d.w[4] : d.w[5];
      else if (d.op === O.BitwiseAnd && part === "texture" && (konst(d.w[3]) === 0xfffff || konst(d.w[2]) === 0xfffff)) id = konst(d.w[3]) === 0xfffff ? d.w[2] : d.w[3];
      else if (d.op === O.ShiftRightLogical && part === "sampler" && konst(d.w[3]) === 20) id = d.w[2];
      else if (d.op === Op.Load) {
        const p = defs.get(d.w[2]);
        if (!p || (p.op !== Op.AccessChain && p.op !== Op.InBoundsAccessChain) || p.w.length !== 5 || !isStorage(p.w[2])) return undefined;
        const w = affine(p.w[4]);
        return w && { ...w, buffer: p.w[2], a: w.a * 4, b: w.b * 4 };
      } else return undefined;
    }
    return undefined;
  };

  // ---- the reads, and where each pool's handles come from ----
  type Ref = { pool: number; t: number; s?: number };
  const texAC = new Map<number, Ref>(), images = new Map<number, Ref>(), sampAC = new Map<number, number>(), samplers = new Map<number, number>(), sampled = new Map<number, Ref>();
  const poolIds = new Set(texPools.map(v => v.w[1])), samp = new Set(sampPools.map(v => v.w[1]));
  // what an instruction is to the pools: "plumbing" (it goes), a read (the pool element it reads), or nothing
  const track = (i: Inst): Ref | "plumbing" | undefined => {
    if ((i.op === Op.AccessChain || i.op === Op.InBoundsAccessChain) && (poolIds.has(i.w[2]) || samp.has(i.w[2]))) {
      if (i.w.length !== 4) throw new Error(`${nameOf(i.w[2])}: a pool array indexed with ${i.w.length - 3} indices: not placed yet`);
      if (poolIds.has(i.w[2])) texAC.set(i.w[1], { pool: i.w[2], t: i.w[3] }); else sampAC.set(i.w[1], i.w[3]);
      return "plumbing";
    }
    if (i.op === Op.Load && texAC.has(i.w[2])) { images.set(i.w[1], texAC.get(i.w[2])!); return "plumbing"; }
    if (i.op === Op.Load && sampAC.has(i.w[2])) { samplers.set(i.w[1], sampAC.get(i.w[2])!); return "plumbing"; }
    if (i.op === Op.SampledImage && (images.has(i.w[2]) || samplers.has(i.w[3]))) {
      const im = images.get(i.w[2]), s = samplers.get(i.w[3]);
      if (!im || s === undefined) throw new Error(`${im ? nameOf(im.pool) : "a bound texture"}: a pool ${im ? "texture" : "sampler"} joined with a ${im ? "sampler" : "texture"} that is not of the pools: not placed yet`);
      sampled.set(i.w[1], { ...im, s });
      return "plumbing";
    }
    if (i.op === O.Image && sampled.has(i.w[2])) { images.set(i.w[1], sampled.get(i.w[2])!); return "plumbing"; }
    return ON_SAMPLED.has(i.op) ? sampled.get(i.w[2]) : ON_IMAGE.has(i.op) ? images.get(i.w[2]) : undefined;
  };
  const from = new Map<number, { buffer: number; stride: number; offsets: number[]; at?: PoolAt; atKey: string }>();
  for (let k = first; k < c.m.insts.length; k++) {
    const ref = track(c.m.insts[k]);
    if (!ref || ref === "plumbing") continue;
    const name = nameOf(ref.pool), src = source(ref.t, "texture"), ssrc = ref.s === undefined ? src : source(ref.s, "sampler");
    if (!src || !ssrc) throw new Error(`texture ${name}: a pool texture whose handle is not a word of a storage buffer (min(h & 0xfffff, 0xfffff), min(h >> 20, 0xfff) of one loaded word): not placed yet`);
    if (ssrc.buffer !== src.buffer || ssrc.a !== src.a || ssrc.b !== src.b)
      throw new Error(`texture ${name}: a pool texture read with its texture and sampler IDs from different words (${nameOf(src.buffer)} ${src.a} i + ${src.b}, ${nameOf(ssrc.buffer)} ${ssrc.a} i + ${ssrc.b}): not placed yet`);
    const at = src.a ? indexAt(src.x, src.guard) : undefined, atKey = JSON.stringify(at ?? null), was = from.get(ref.pool);
    if (src.guard !== undefined && !at) throw new Error(`texture ${name}: a pool texture whose record is chosen by a condition the pass does not know (${nameOf(src.buffer)} ${src.a} i + ${src.b}): not placed yet`);
    if (!was) from.set(ref.pool, { buffer: src.buffer, stride: src.a, offsets: [src.b], at, atKey });
    else if (was.buffer !== src.buffer || was.stride !== src.a || was.atKey !== atKey)
      throw new Error(`texture ${name}: a pool texture whose reads take their handles from different tables or records (${nameOf(was.buffer)} ${was.stride} i, ${nameOf(src.buffer)} ${src.a} i): not placed yet`);
    else if (!was.offsets.includes(src.b)) was.offsets.push(src.b);
  }
  // a pool read at one record the recorder can name needs a slot a handle of the record; one whose table is walked gets what the stage has room for
  const slotsOf = (id: number) => { const f = from.get(id); if (!f) throw new Error(`texture ${nameOf(id)}: a pool texture no instruction the pass knows reads: not placed yet`); return f.at ? f.offsets.length : KW; };
  if (texPools.reduce((n, v) => n + slotsOf(v.w[1]), 0) > POOL_ENTRIES) throw new Error(`texture ${nameOf(texPools[0].w[1])}: the pool textures need more than the table's ${POOL_ENTRIES} entries: not placed yet`);

  // ---- types, constants and the table's block ----
  let at = c.firstFunction(), r;
  const add = (op: number, ops: number[], hasType: boolean) => { r = c.intern(op, ops, at, hasType); at += r.added; return r.id; };
  const uint = add(Op.TypeInt, [32, 0], false), int = add(Op.TypeInt, [32, 1], false), bool = add(Op.TypeBool, [], false), float = add(Op.TypeFloat, [32], false);
  const ptrUF = add(Op.TypePointer, [SC.Uniform, float], false);
  const ku = (n: number) => add(Op.Constant, [uint, n], true), ki = (n: number) => add(Op.Constant, [int, n], true);
  const prefix = /^([a-z]+)_/.exec(nameOf(texPools[0].w[1]))?.[1] ?? "";
  let c2 = c.m.insts.find(i => i.op === Op.Variable && i.w[2] === SC.Uniform && c.names.get(i.w[1]) === `${prefix}_c2`)?.w[1];
  const c2New = c2 === undefined;
  if (c2 === undefined) {
    // a bank of the translator's (struct { vec4 data[4096]; }) lends its type
    const like = c.m.insts.find(i => {
      if (i.op !== Op.Variable || i.w[2] !== SC.Uniform || !new RegExp(`^${prefix}_c\\d+$`).test(c.names.get(i.w[1]) ?? "")) return false;
      const s = c.def.get(c.def.get(i.w[0])!.w[2])!, a = s.op === Op.TypeStruct && s.w.length === 2 ? c.def.get(s.w[1]) : undefined, e = a && a.op === Op.TypeArray ? c.def.get(a.w[1]) : undefined;
      return !!e && e.op === Op.TypeVector && e.w[1] === float && e.w[2] === 4 && (c.constU32(a!.w[2]) ?? 0) >= 4096;
    });
    if (!like) throw new Error(`texture ${nameOf(texPools[0].w[1])}: a pool texture in a shader with no uniform bank to take the table's type from: not placed yet`);
    c2 = c.id();
    const v = { op: Op.Variable, w: [like.w[0], c2, SC.Uniform] };
    c.m.insts.splice(c.m.insts.indexOf(like) + 1, 0, v); c.def.set(c2, v); at++;
    c.names.set(c2, `${prefix}_c2`);
  }

  // ---- the slots: K combined textures in place of each pool ----
  const slots = new Map<number, { vars: number[]; image: number; si: number; first: number }>();   // pool variable -> its slots
  const newNames: [number, string][] = c2New ? [[c2, `${prefix}_c2`]] : [];
  let entries = 0;
  texPools.forEach(v => {
    const image = elem(v)!.w[0], K = slotsOf(v.w[1]);
    let k = c.m.insts.indexOf(v), n = 0;
    r = c.intern(Op.TypeSampledImage, [image], k, false); n += r.added; const si = r.id;
    r = c.intern(Op.TypePointer, [SC.UniformConstant, si], k + n, false); n += r.added; const ptr = r.id;
    k += n; at += n;
    const vars: number[] = [];
    for (let j = 0; j < K; j++) {
      const id = c.id(), inst = { op: Op.Variable, w: [ptr, id, SC.UniformConstant] };
      c.m.insts.splice(k + 1 + j, 0, inst); c.def.set(id, inst); at++;
      vars.push(id); newNames.push([id, `${nameOf(v.w[1])}_p${j}`]);
    }
    slots.set(v.w[1], { vars, image, si, first: entries }); entries += K;
  });

  // ---- the function bodies ----
  // `add` puts types and constants before the first function while the bodies are walked, so the bodies are walked in a copy
  const body = c.m.insts.slice(at), out: Inst[] = [];
  let entryLabel = -1, temps = new Map<number, number>(), reads = 0;
  const e = (op: number, t: number, ...ops: number[]) => { const x = c.id(); out.push({ op, w: [t, x, ...ops] }); return x; };
  const typeOf = (id: number) => defs.get(id)?.w[0] ?? (c.def.get(id)?.op === Op.Constant ? c.def.get(id)!.w[0] : undefined);
  const asUint = (id: number, what: string) => { const t = typeOf(id); if (t === uint) return id; if (t !== int) throw new Error(`${what}: a pool index that is no 32-bit integer the pass knows: not placed yet`); return e(O.Bitcast, uint, id); };
  for (let k = 0; k < body.length; k++) {
    const i = body[k];
    if (i.op === Op.Function) { entryLabel = -1; temps = new Map(); }
    if (i.op === Op.Label && entryLabel < 0) { out.push(i); entryLabel = out.length; continue; }
    const ref = track(i);
    if (ref === "plumbing") continue;
    if (!ref) { out.push(i); continue; }
    const pool = slots.get(ref.pool)!, name = nameOf(ref.pool);
    for (let j = k + 1; j < body.length && body[j].op !== Op.Label; j++) if (body[j].op === O.LoopMerge) throw new Error(`texture ${name}: a pool texture read in a loop's header block: not placed yet`);
    // the handle as the shader has it, and the slot whose table word it equals (K: none)
    let h = asUint(ref.t, name);
    if (ref.s !== undefined) h = e(O.BitwiseOr, uint, h, e(O.ShiftLeftLogical, uint, asUint(ref.s, name), ku(20)));
    const K = pool.vars.length;
    let sel = ku(K);
    for (let j = K - 1; j >= 0; j--) {
      const entry = pool.first + j, vec = (C2_POOL >> 4) + (entry >> 2);
      let w = e(O.Bitcast, uint, e(Op.Load, float, e(Op.AccessChain, ptrUF, c2, ki(0), ki(vec), ki(entry & 3))));
      if (ref.s === undefined) w = e(O.BitwiseAnd, uint, w, ku(0xfffff));
      sel = e(O.Select, uint, e(O.IEqual, bool, w, h), ku(j), sel);
    }
    let tmp = temps.get(i.w[0]);
    if (tmp === undefined) {
      tmp = c.id();
      const v = { op: Op.Variable, w: [add(Op.TypePointer, [SC_FUNCTION, i.w[0]], false), tmp, SC_FUNCTION] };
      out.splice(entryLabel, 0, v); temps.set(i.w[0], tmp);
    }
    const labels = pool.vars.map(() => c.id()), none = c.id(), merge = c.id();
    out.push({ op: O.SelectionMerge, w: [merge, 0] }, { op: O.Switch, w: [sel, none, ...labels.flatMap((l, j) => [j, l])] });
    pool.vars.forEach((v, j) => {
      out.push({ op: Op.Label, w: [labels[j]] });
      const si = e(Op.Load, pool.si, v), value = e(i.op, i.w[0], ON_IMAGE.has(i.op) ? e(O.Image, pool.image, si) : si, ...i.w.slice(3));
      out.push({ op: Op.Store, w: [tmp, value] }, { op: O.Branch, w: [merge] });
    });
    out.push({ op: Op.Label, w: [none] }, { op: Op.Store, w: [tmp, add(O.ConstantNull, [i.w[0]], true)] }, { op: O.Branch, w: [merge] });
    out.push({ op: Op.Label, w: [merge] }, { op: Op.Load, w: [i.w[0], i.w[1], tmp] });
    reads++;
  }
  c.m.insts = [...c.m.insts.slice(0, at), ...out];

  // ---- the pools themselves go, with their array types; the slots get names ----
  const gone = new Set<number>([...slots.keys(), ...samp]), goneTypes = new Set<number>();
  for (const v of [...texPools, ...sampPools]) { goneTypes.add(v.w[0]); goneTypes.add(c.def.get(v.w[0])!.w[2]); }
  c.m.insts = c.m.insts.filter(i => !(i.op === Op.Variable && gone.has(i.w[1])) && !((i.op === Op.Name || i.op === Op.Decorate) && (gone.has(i.w[0]) || goneTypes.has(i.w[0]))) &&
    !((i.op === Op.TypePointer || i.op === Op.TypeArray) && goneTypes.has(i.w[0])));
  // and the sampler type and the pointers to a pool's element when nothing else names them: the split of the combined samplers (spv.ts step 3) takes an existing
  // type wherever it stands, and these stand after the bound textures' variables
  const isType = (i: Inst) => i.op >= Op.TypeVoid && i.op <= Op.TypeFunction;
  const unused = (id: number) => { const t0 = c.firstType(); return !c.m.insts.some((i, k) => k >= t0 && i.op !== Op.Name && i.op !== Op.Decorate && i.op !== Op.MemberDecorate && (isType(i) ? i.w.indexOf(id, 1) > 0 : i.w[0] === id)); };
  const elems = new Set<number>([...texPools, ...sampPools].map(v => elem(v)!.w[0]));
  for (const pass of [Op.TypePointer, Op.TypeSampler]) for (const t of c.m.insts.filter(i => i.op === pass && (pass === Op.TypeSampler ? elems.has(i.w[0]) : i.w[1] === SC.UniformConstant && elems.has(i.w[2]))))
    if (unused(t.w[0])) c.m.insts.splice(c.m.insts.indexOf(t), 1);
  const nameAt = c.m.insts.findIndex(i => i.op === Op.Name);
  for (const [id, n] of newNames) { c.names.set(id, n); c.m.insts.splice(nameAt < 0 ? c.firstType() : nameAt, 0, { op: Op.Name, w: [id, ...nameWords(n)] }); }

  for (const [id, pool] of slots) {
    const src = from.get(id)!, name = nameOf(id), K = pool.vars.length, offsets = [...src.offsets].sort((x, y) => x - y), base = offsets[0];
    const sbuf = storageSlot(c.decoration(src.buffer, Dec.Binding), nameOf(src.buffer), stage, sbufs, mesh);
    const where = `(${src.stride} i + ${offsets.join(" | ")}) / 4 of ${nameOf(src.buffer)} (storage slot ${sbuf})`;
    if (!(sbuf >= 0 && sbuf < 16) || (src.stride !== 0 && src.stride < 8) || src.stride > 0xffff || base < 0 || base > 0xffff || src.stride % 4 || offsets.some(o => o % 4))
      throw new Error(`texture ${name}: a pool texture whose handle is word ${where}: no record table the recorder can walk (a stride of 8 to 65532 bytes, or one word): not placed yet`);
    let columns = 0;
    for (const o of offsets.slice(1)) { const k = (o - base) / 4 - 1; if (k > 7) throw new Error(`texture ${name}: a pool texture whose handles are words ${where}, more than 32 bytes apart: not placed yet`); columns |= 1 << k; }
    if (src.at && src.at.terms.some(t => t.offset > 0xffff)) throw new Error(`texture ${name}: a pool texture whose record index is uniform data past 64 KB: not placed yet`);
    pool.vars.forEach((v, j) => placed.set(v, { sbuf, offset: base, stride: src.stride, index: j, entry: pool.first + j, ...(columns ? { columns } : {}), ...(src.at ? { at: src.at } : {}) }));
    const words = `0x${base.toString(16)}${offsets.slice(1).map(o => ` / 0x${o.toString(16)}`).join("")}${src.stride ? ` + ${src.stride} i` : ""} of storage slot ${sbuf}`;
    c.notes.push(`pool texture ${name} (the game's whole texture pool indexed by a handle): ${K} slot${K === 1 ? "" : "s"}, bound at each draw to ` + (src.at
      ? `the live handles at ${words}, i = ${src.at.terms.map(t => `uniform slot ${t.ubo} + 0x${t.offset.toString(16)}${t.mask ? " & 0xfffff" : ""}`).join(" + ")}${src.at.guard ? " (0 unless the first word's top bits are 0b10)" : ""}`
      : `the first ${K} distinct live handles among the words at ${words}`) + `; a handle in none of them reads 0 (table at c2 + 0x${(C2_POOL + 4 * pool.first).toString(16)})`);
  }
  if (reads) c.notes.push(`${reads} pool texture read${reads === 1 ? "" : "s"} made as a switch over the pool's slots`);
  return placed;
}
function nameWords(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i <= s.length; i += 4) { let v = 0; for (let b = 0; b < 4 && i + b < s.length; b++) v |= s.charCodeAt(i + b) << (8 * b); out.push(v >>> 0); }
  return out;
}
