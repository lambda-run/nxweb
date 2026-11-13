// The SPIR-V pass's integer signedness (src/shaders/spv.ts intSigns) and the versions of its rewrites (src/shaders/passes.ts), which key the page's store
// of translations and the shader pack (tools/shaders/pack.mts). `npm run gfx:test` runs these in Node.
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "./harness.mts";
import { parse, serialize, fixForWgsl } from "../../src/shaders/spv.ts";
import { glslToSpv } from "../../tools/shaders/build_lib.mts";
import { PASSES, passStamp, failureStamp, translationCurrent } from "../../src/shaders/passes.ts";

// a compute shader with one signed operation of each kind, whose opcodes are then turned into the unsigned forms the translator writes on i32 words
const GLSL = `#version 450
layout(local_size_x = 1) in;
layout(std430, binding = 160) buffer B { int v[]; } b;
void main() { int a = b.v[0], c = b.v[1]; b.v[2] = a >> 3; b.v[3] = a / c; b.v[4] = bitfieldExtract(a, 4, 8); b.v[5] = int(float(a)); }
`;
const typeOf = (insts: { op: number; w: number[] }[]) => {
  const ty = new Map<number, number>(), vt = new Map<number, number>();
  for (const i of insts) { if (i.op === 21) ty.set(i.w[0], i.w[2]); else if (i.w.length >= 2 && i.op > 41) vt.set(i.w[1], i.w[0]); }
  return (id: number) => ty.get(vt.get(id) ?? -1);
};
test("SPIR-V pass: unsigned shifts, divides, extracts and conversions of i32 operands are made on u32 operands (naga takes the signedness from the operand)", () => {
  const d = mkdtempSync(join(tmpdir(), "signs-")), f = join(d, "s.comp");
  writeFileSync(f, GLSL);
  const m = parse(glslToSpv(f));
  const swap: Record<number, number> = { 195: 194, 135: 134, 202: 203, 111: 112 };   // SRA->SRL, SDiv->UDiv, BFSExtract->BFUExtract, SToF->UToF
  let n = 0;
  for (const i of m.insts) if (swap[i.op]) { i.op = swap[i.op]; n++; }
  assert.ok(n >= 4, `the GLSL gave ${n} signed operations to turn`);
  const out = parse(fixForWgsl(serialize(m), { bindings: "keep" }).spv), sg = typeOf(out.insts);
  for (const i of out.insts) if ([194, 134, 203, 112].includes(i.op)) assert.equal(sg(i.w[2]), 0, `opcode ${i.op}: its operand is unsigned`);
  // and the signed forms of unsigned operands the other way: SRA of a u32 is made on an i32
  const m2 = parse(fixForWgsl(serialize(m), { bindings: "keep" }).spv);
  for (const i of m2.insts) if (i.op === 194) i.op = 195;
  const out2 = parse(fixForWgsl(serialize(m2), { bindings: "keep" }).spv), sg2 = typeOf(out2.insts);
  for (const i of out2.insts) if (i.op === 195) assert.equal(sg2(i.w[2]), 1, "ShiftRightArithmetic: its operand is signed");
});
test("SPIR-V pass: the rewrites that changed a stage are reported (fired) and stamped; a stamp is current until one of them, or a quiet one's trigger, changes", () => {
  const d = mkdtempSync(join(tmpdir(), "signs-")), f = join(d, "s.comp");
  writeFileSync(f, GLSL);
  const m = parse(glslToSpv(f));
  for (const i of m.insts) if (i.op === 195) i.op = 194;
  const r = fixForWgsl(serialize(m), { bindings: "keep" });
  assert.ok(r.fired.includes("intSigns"), `fired: ${r.fired}`);
  const t = { wgsl: "x", reflection: { passes: passStamp(r.fired) } };
  assert.ok(translationCurrent(t), "current as made");
  const keep = PASSES.intSigns, other = Object.keys(PASSES).find(n => !r.fired.includes(n))!, keepO = PASSES[other];
  try {
    PASSES.intSigns = [keep[0] + 1, keep[1]]; assert.ok(!translationCurrent(t), "a new version of a rewrite that fired: made again");
    PASSES.intSigns = keep; PASSES[other] = [keepO[0] + 1, keepO[1]]; assert.ok(translationCurrent(t), `a new version of a quiet rewrite (${other}): kept`);
    PASSES[other] = [keepO[0] + 1, keepO[1] + 1]; assert.ok(!translationCurrent(t), "a quiet rewrite's wider trigger: made again");
    PASSES[other] = keepO;
    const fail = { wgsl: "", reflection: null, failed: "x", passes: failureStamp() };
    assert.ok(translationCurrent(fail)); PASSES[other] = [keepO[0] + 1, keepO[1]]; assert.ok(!translationCurrent(fail), "a failure is kept only under the same table");
  } finally { PASSES.intSigns = keep; PASSES[other] = keepO; }
});
