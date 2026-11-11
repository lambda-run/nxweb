// The device features GfxHost.deviceDescriptor asks an adapter for, and what the in-page shader translator is told of them:
// WebGPU's subgroups when the adapter has them (warp operations as WGSL subgroup builtins, src/shaders/spv_subgroups.ts),
// one-invocation subgroups otherwise. The scenes (page.mts) check the same on Chromium's real adapter.
import assert from "node:assert/strict";
import { test } from "./harness.mts";
import { GfxHost } from "../../src/glue/gfx_host.ts";

const adapter = (features: string[], limits: Record<string, number> = {}) => ({ features: new Set(features), limits });
test("device features: subgroups is asked for when the adapter has it, and decides the translator's warp path", () => {
  const withSg = GfxHost.deviceDescriptor(adapter(["subgroups", "float32-filterable", "not-a-feature"]));
  assert.deepEqual(withSg.requiredFeatures, ["float32-filterable", "subgroups"]);
  assert.deepEqual(GfxHost.deviceDescriptor(adapter(["float32-filterable"])).requiredFeatures, ["float32-filterable"]);
  assert.equal(GfxHost.hasSubgroups({ features: new Set(withSg.requiredFeatures) }), true);
  assert.equal(GfxHost.hasSubgroups({ features: new Set(["float32-filterable"]) }), false);
  assert.equal(GfxHost.hasSubgroups(undefined), false);
});
