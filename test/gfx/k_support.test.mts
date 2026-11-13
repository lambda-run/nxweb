// The translator's support buffer in naga's WGSL is made over to the std140 layout the recorder fills (src/shaders/images.ts supportLayout)
import assert from "node:assert/strict";
import { test } from "./harness.mts";
import { supportLayout } from "../../src/shaders/images.ts";

test("support buffer: arrays of scalars become 16-byte elements, every index reads .v, other text is left alone", () => {
  const src = `struct type_7 {\n    member: u32,\n    member_1: array<u32, 8>,\n    member_2: vec4<f32>,\n    member_5: array<f32, 73>,\n}\n@group(0) @binding(30) \nvar<uniform> support_buffer: type_7;\nfn f(i: i32) -> f32 { let a = support_buffer.member_5[0i]; let b = support_buffer.member_5[a_[i]]; return a + b + f32(support_buffer.member_1[3i]) + support_buffer.member_2.x; }`;
  const out = supportLayout(src);
  assert.ok(out.includes("member_1: array<NxStd140_u32, 8>") && out.includes("member_5: array<NxStd140_f32, 73>") && out.includes("struct NxStd140_f32 { @size(16) @align(16) v: f32 }"));
  assert.ok(out.includes("support_buffer.member_5[0i].v;") && out.includes("support_buffer.member_5[a_[i]].v;") && out.includes("f32(support_buffer.member_1[3i].v)") && out.includes("support_buffer.member_2.x"));
  assert.equal(supportLayout(out), out, "made over once");
  assert.equal(supportLayout("fn g() {}"), "fn g() {}");
  const whole = src.replace("let a = support_buffer.member_5[0i];", "let w = support_buffer.member_5; let a = w[0i];");
  assert.equal(supportLayout(whole), whole, "the whole array taken: left as it is");
});
