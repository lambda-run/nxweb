# nn::ndve's movie network in nxweb

Zelda: Ocarina of Time (Switch 2) plays its title and opening movies through `nn::ndve`, a Nintendo library linked into the game's `main`
(`nn::ndve::RouleauArchiveIO` reads `Movie/Ndve/Ndve-Nvn2-vid_seq5.dat`). Every movie frame it runs 14 NVN compute dispatches
(src/glue/ndve.ts `NDVE_KEYS`, nxnative `dm/gfx/nvn/nvn_ndve.inc` `k_ndve_keys`):

| # | key | what |
|---|---|---|
| 1 | `49dff010` | colour conversion, NV12 to RGBA8 1920x1080 (from the archive's NDSR pack) |
| 2-12 | `ba079f68` ... `a8b4fb48` | a U-Net over the picture packed 2x2 at 960x540 (16 / 32 / 64 channels), HMMA.16816.F16 convolutions |
| 13 | `5a7d69b0` | the last convolution, added to the picture, into an RGB10A2 1920x1080 image |
| 14 | `4f41ccf2` | the resampler, 4/3 to RGBA8 2560x1440, with a small HMMA network of its own and a dither |

nxweb has no HMMA lowering, so dispatches 2-14 do not run, and the resampler's image (what the frame then draws and presents) stays black.

## The diagnostic stand-in: `?ndve=bypass`

Off by default. With `?ndve=bypass` on the page URL (`RtGfx` option `ndve: "bypass"`, `GfxHost.ndveBypass()`):

- The recorder is told the model's keys (`gfx_watch_key`). A dispatch of one of them that cannot run (the shader is not registered: still being
  translated, failed, or unknown; or its pipeline did not build) is reported to the replayer (`H_DISPATCH_SKIPPED`, src/gfx/hostops.ts) with the
  compute stage's bound textures, images and push constants, inside a compute pass where the dispatch would have been. Keys not watched record
  nothing, so with the flag off the host stream is the same as before.
- `NdveBypass` (src/glue/ndve.ts) follows each frame: the colour conversion starts it, the first U-Net layer's texture slot 1 is the picture (the
  last convolution's slot 4 if that one bound none), any of dispatches 2-13 that did not run marks the frame broken. At the resampler, when it
  cannot run or the frame is broken, the replayer runs its own compute kernel instead: the picture resampled bilinearly (texel centres, edges clamped,
  alpha 1) into the image the resampler binds (image slot 1), in that image's format and size, rows flipped when the resampler's push constants
  say so (word 19 on, word 18 the row base, as nxnative's `resample` kernel reads them). These are bindings of the library's model, not of a game.
- The first frame it writes logs one line:
  `[RED] ndve=bypass: nn::ndve's movie network did not run (...): a stand-in replaced it, the 1920x1080 picture resampled bilinearly into the network's 2560x1440 rgba8unorm output. Diagnostic only: not the network's picture`.
  A stand-in that cannot be made logs `[RED] ndve=bypass: ...: no stand-in` (no live picture or output, or an output format WebGPU cannot store to).

The picture is the colour conversion's, unenhanced: it shows whether the rest of the frame (HUD, present) works once the movie has a picture, nothing
about the network. The RGB10A2 image of dispatch 13 is not written. Tests: `npm run gfx:test` scenes "ndve=bypass" (test/gfx/scenes8.mts: 14
synthetic keys, the stand-in's texels against bilinear values computed in the test, a flipped frame, a frame whose resampler is ready but not the
U-Net, and the same frames with the flag off left as they were) and `npm run hle:test` (test/hle/n_ndve.test.mts: when `NdveBypass` writes).

## The real fix: nxnative's host NDVE kernels as WGSL compute

nxnative does not translate the network's dispatches either: `nvn_ndve.inc` recognises the model and runs it as 13 host kernels
(`dm/gfx/msl/ndve_engine.metal`; docs/reference/shaders.md, "The NDVE movie network by the host"), bit for bit with the translated shaders
(`dm/gfx/tests/test_ndve_engine.py`). Porting that to nxweb is these pieces.

### Recognition and plumbing (src/glue/gfx_host.ts, where `ndveDispatch` is now)

- The same rules as `ndve_engine_dispatch`: the keys in order (position decides for the repeated `a8b4`, `e6be`, `0a56`); dispatch 2's storage buffer
  2 is the first layer's weights, and every later dispatch's storage buffers 2 / 3 must be at the offsets the layer table gives from it (each layer's
  weights `taps x K x N` halves, then `N` biases, each padded to 256 bytes but the last biases, summing to the model's `0x3c320` bytes,
  `ndve_offsets`); the picture dispatch 13 adds (texture slot 4) is the one dispatch 2 read (slot 1); 1920x1080 RGBA8 in, 1920x1080 RGB10A2 out;
  the resampler's constants (input 0,0-1919,1079, output 0,0-2559,1439, dither on, `c[20] == 1`), its picture 1920x1080 RGB10A2, its dither
  512x512, its output 2560x1440 RGBA8, its weights (storage buffer 2, at least 0x3000 bytes). Anything else: the game's dispatches, logged once;
  a deviation after dispatches were skipped turns the engine off for the run.
- The recorder already sends what is needed when the shaders are registered (H_TEX / H_IMG / H_SSBO / push constants for the reflection's slots); for
  dispatches that cannot run it sends `H_DISPATCH_SKIPPED`, which would need the storage buffers 2 / 3 added (today: textures, images, push constants).
- Weights come from guest memory through the replayer's storage-buffer path (`storageBuffer(addr, size)`), the 0x3c320-byte table as one binding.
- Tensors: eight f16 NHWC buffers with a one-pixel zero border and 16 spare rows (`k_ndve_t`: 3 x 960x540x16, 3 x 480x270x32, 2 x 240x135x64), about
  92 MB, zeroed once; kernels write interiors only. Plus a 1920x1080 f16 luma buffer for the resampler.
- Output formats: `rgb10a2unorm` is a storage format only with `texture-formats-tier1`; without it `out_16` writes the RGB10A2 image through a
  render pass (a full-screen draw reading the network's output buffer) instead of `textureStore`. The resampler's RGBA8 output is a core storage format.

### The kernels (13, from ndve_engine.metal)

`pack_input`, `conv3s_16_16` / `conv3s_32_32` / `conv3s_64_64` (3x3, input tile staged in workgroup memory), `down_16_32` / `down_32_64` (2x2 stride 2),
`up_64_32` / `up_32_16` (2x2 transposed, skip connection as the chain's C), `out_16` (last 3x3, unpacked 2x2, added to the picture), `rs_luma`,
`resample` (six 8x8 blocks of the resampler's network on a 16x16 luma window, delta added to a bilinear sample, dithered, rounded to 8 bits), and
`cmp_img` for a check mode like `DM_NDVE_ENGINE=check`.

What does not carry over from Metal:

- **No matrix unit.** WGSL has no `simdgroup_matrix`. Each HMMA.16816 becomes plain arithmetic: for every output, C, then the products of input
  channels 0-7 summed in f32 in order and rounded once to f16, then channels 8-15 the same way (test_dmsh_hmma.py's reference, "HMMA rounds its f16
  accumulator once per 8 products"); a chain's first call starts from C = 0. A product of two f16 values is exact in f32, so FMA contraction cannot
  change a bit; only the order of the sums can, and the reference fixes it. (Chromium has an experimental subgroup-matrix extension; its accumulation
  order is the hardware's and would have to be proven against the reference before use. Not checked here.)
- **f16.** WGSL f16 needs the `shader-f16` device feature (`enable f16;`), which GfxHost does not request today. Without it, halves are stored as
  `u32` pairs and rounded with `pack2x16float` / `unpack2x16float`, whose rounding of values between f16 numbers must be checked against
  round-to-nearest-even on each backend (the WGSL spec leaves some of it to the implementation): part of the test below.
- **Safe math.** ndve_engine.metal is built with `fp math_mode(safe)` and keeps the game's order in the epilogues (D + bias in f32, ReLU, one rounding;
  in `out_16`, (picture + D) + bias). WGSL has no fast-math switch; whether a backend (Dawn's MSL / HLSL / SPIR-V output) reassociates is a property
  of the backend's compile options, to be pinned down by the test rather than assumed.
- **Speed.** nxnative's kernels take 10.8 ms of GPU for one title frame on an M1 Pro with matrix tiles (the translated dispatches 36.3 ms). Scalar
  WGSL arithmetic will be slower than that; how much is not measured. The weights are loaded once a tap and the 3x3 inputs staged per workgroup,
  as nxnative does, so each HMMA's operands come from workgroup memory.

### The bar: bit-exact

The port is done when a test, like `test_ndve_engine.py`, runs every kernel on random inputs and weights at the network's sizes in Chromium's WebGPU
(SwiftShader in CI, and a real GPU) and matches a reference bit for bit, and runs the whole network on one synthetic frame against the reference
end to end. The reference is the translated shaders' arithmetic, not the WGSL kernels themselves: each HMMA as HMMA_BODY does it (the order above,
PTX mma.m16n8k16's fragment layout, TensorPass's chain flags), written independently (a CPU implementation in JS or Python with explicit f16
rounding; numpy's `float16` rounds to nearest even). nxnative's own figures are what it reached on Metal: all 10 kernels identical on three Macs;
in the game, the resampler identical in every frame and the network within 10 texels of 1/1023 of the translated dispatches (fast-math in the
translated shaders, not the engine). nxnative's in-game check (`DM_NDVE_ENGINE=check`, the engine beside the game's dispatches) has no nxweb
counterpart, because nxweb cannot run the game's dispatches; the game-level check is a run of the page: the movie visible, the engine's
first-frame log line, and the report's frame times.
