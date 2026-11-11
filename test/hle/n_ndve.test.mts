// nn::ndve, the movie enhancement network (nxnative docs/reference/shaders.md, "nn::ndve's movie enhancement file" and "The NDVE movie network
// by the host"): a library linked into the game's main that runs as the game's own code and NVN compute dispatches. nxnative takes none of its
// functions over and neither does nxweb; what the host knows of it is its model's shader keys, which the log names (src/glue/ndve.ts)
import assert from "node:assert/strict";
import { test, status, inventory } from "./harness.mts";
import { NDVE_KEYS, ndveRole } from "../../src/glue/ndve.ts";

test("nn::ndve: no name of it is taken over (nxnative has none), so its calls run as the game's code; nn::codec, whose pictures it reads, is implemented", () => {
  assert.deepEqual(inventory().filter(r => /ndve/i.test(JSON.stringify(r))), []);
  assert.deepEqual(status().filter(r => /ndve/i.test(r.mangled)), []);
  // what the movie library and nn::ndve call around a frame is implemented, none of it a cut stub
  for (const f of ["hle_codec_video.c"]) assert.ok(status().filter(r => r.file === f).every(r => r.status !== "cut"), f);
});

test("nn::ndve's model keys (nxnative nvn_ndve.inc): 14 dispatches a movie frame, each named in the log with its role; any other key is not the model's", () => {
  assert.equal(NDVE_KEYS.length, 14);
  assert.match(ndveRole("49dff010b9832251")!, /dispatch 1 of 14: the colour conversion \(NV12 to RGBA8\)/);
  assert.match(ndveRole("0a56002cdc7e1fce")!, /dispatch 7 and 8 of 14: a U-Net layer/);
  assert.match(ndveRole("a8b4fb48fee0ccf8")!, /dispatch 3 and 12 of 14/);
  assert.match(ndveRole("5a7d69b067a7f011")!, /dispatch 13 of 14: the U-Net's last convolution/);
  assert.match(ndveRole("4f41ccf24f163e0d")!, /dispatch 14 of 14: the resampler/);
  assert.equal(ndveRole("0123456789abcdef"), null);
});
