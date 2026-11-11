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

test("?ndve=bypass (NdveBypass): the stand-in writes a frame's output when a dispatch of its network could not run and the frame's picture is known; never otherwise", async () => {
  const { NdveBypass } = await import("../../src/glue/ndve.ts");
  const nd = new NdveBypass(), last = NDVE_KEYS.length - 1, tex = (s: number) => s === 1 ? 7 : s === 4 ? 9 : 0;
  assert.equal(nd.pos("49dff010b9832251"), 0); assert.equal(nd.pos("4f41ccf24f163e0d"), last); assert.equal(nd.pos("0123456789abcdef"), -1);
  const frame = (ran: (pos: number) => boolean, picture = tex) => {
    const took: string[] = [];
    // as GfxHost: a dispatch that runs is a replay record (replaces, then saw); one that cannot is the recorder's H_DISPATCH_SKIPPED (saw)
    for (let p = 0; p <= last; p++) { if (ran(p) && nd.replaces(p)) { took.push(`replaced ${p}`); continue; } if (nd.saw(p, ran(p), picture)) took.push(`wrote at ${p}`); }
    return took;
  };
  assert.deepEqual(frame(() => true), [], "every dispatch ran: the network's own output");
  assert.deepEqual(frame(() => false), [`wrote at ${last}`], "nothing ran: the stand-in at the resampler");
  assert.equal(nd.pic, 7, "the picture is the first layer's texture slot 1");
  assert.deepEqual(frame(p => p === last), [`replaced ${last}`], "the resampler is ready, the U-Net not: the stand-in instead of the resampler");
  assert.deepEqual(frame(p => p !== 5), [`replaced ${last}`], "one layer failed");
  assert.deepEqual(frame(p => p !== 1, s => s === 4 ? 9 : 0), [`replaced ${last}`], "the first layer bound no picture: the one the last convolution adds (slot 4)");
  assert.equal(nd.pic, 9);
  assert.deepEqual(frame(() => false, () => 0), [], "no picture bound: no stand-in");
});
