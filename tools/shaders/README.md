# Shaders: from a game's GPU binary to WGSL

Switch games ship GPU shaders compiled for the Tegra X1: Maxwell machine code and a control section, one pair per stage.
WebGPU takes WGSL. This folder is the chain between the two, as far as it could be built and run without a game:

```
game files ─ shader_split.py (nxnative) ─▶ control section + code area per stage, key = sha256(control + code)[0..8]
   ─ xlate.py ─▶ dmsh_xlate (nxnative's driver over Ryujinx.Graphics.Shader, .NET) ─▶ <key>.spv + <key>.res.json
   ─ src/shaders/spv.ts (the SPIR-V pass) ─▶ SPIR-V naga can read, with nxweb's bindings
   ─ naga (tools/shaders/naga_wasm, WebAssembly) ─▶ WGSL
   ─ build_lib.mts ─▶ library.nxsl ─ src/shaders/library.ts ─▶ GfxHost.registerShader(key, { wgsl, ...reflection })
```

Everything right of `shader_split.py` ran here, offline and inside a page (`npm run shaders:test`, results below).
**No game shader has been through it**: there are none in this environment. What ran is six Maxwell programs
assembled by hand (`maxwell_asm.py`) and 46 GLSL shaders written to look like the translator's output.

| File | What |
|---|---|
| `maxwell_asm.py` | Six hand-assembled Maxwell programs (a vertex and five pixel shaders: a texture query of level of detail, the driver's banks among them) wrapped as code area + control section, with their keys. Not GLSLC output. |
| `xlate.py` | Code + control → translator job → SPIR-V. nxnative's `job_for`, NVN graphics and compute only. |
| `src/shaders/spv.ts` | SPIR-V reader / writer and the pass (below). No Node or DOM API. |
| `src/shaders/convert.ts` | One stage: pass + naga → WGSL + reflection record. |
| `naga_wasm/`, `naga.mts`, `naga_node.mts` | naga 30.0.1 as a 707 KB WebAssembly module with three C exports; its loader. |
| `src/shaders/library.ts` | The library format, writer and loader. |
| `build_lib.mts` | Directory of SPIR-V (or GLSL, for tests) → library + report. |
| `xlate_wasm.csproj`, `build_xlate_wasm.sh` | The translator published for `browser-wasm`. |
| `test/shaders/` | `run.mts` (Node + headless Chromium), `page.mts` (raw WebGPU), `corpus/` (GLSL + expectations), `e2e/`. |

npm: `shaders:naga` (build the wasm), `shaders:asm`, `shaders:xlate`, `shaders:lib`, `shaders:xlate-wasm`, `shaders:test`.

## 1. nxnative's chain, stage by stage

| # | Stage (nxnative) | In → out | Metal-specific? | nxweb |
|---|---|---|---|---|
| 1 | `dm/gfx/tools/shader_split.py` (3,250 lines, ~60 container formats) | game files → one record per stage: control section, code area, key; `shader_map.tsv`, pair tables | No | Reuse unchanged. Python; reads the user's game files, so it runs on their machine (or needs porting to run in a page: not attempted). |
| 2 | Key: `hle_nvn.c keys_hash` | sha256 of the control section's first `min(0x880, control+0x20)` bytes + the code area (length at control +0x704), first 8 bytes | No | Done in `src/gfx/shader.ts` (recorder) and `src/shaders/job.ts` `keyControl` (runtime, `src/glue/rt_gfx.ts`). NVN2 (control version 0xc9): the first 0x48 bytes with +0x30..+0x33 as zero + the code area (length at control +0x44), as `keys_hash` / `nvn_ctl_lens`. `maxwell_asm.py` / `ampere_asm.py` compute the same key independently; `test/shaders/run.mts` checks `job.ts` against `hle_nvn.c keys_hash` (cut out of `$NXNATIVE`, built with OpenSSL) and `shader_split.py skey` on 132 synthetic sections. The profile key `shader_key_skip` (hash a range as zeros) is not in nxweb. |
| 3 | `dmsh_build.py job_for` | record → translator job: strip the 0x30 header (compute: instructions at +0x100), c1 = code between control +0x700 and +0x704, VertexA/B merge, transform feedback layout, early fragment tests (control +0x718), per-game answers (`shader_facts.tsv`: texture types, attribute / output classes, compute sizes) | No | `src/shaders/job.ts` `jobFor` (the page's shader worker) and `xlate.py` `job_for` (offline) do the first two and early tests; NVN2: job `arch: "sm86"`, code cut to control +0x38 (`inst_len`), c1 between +0x40 and +0x44 (`c1_segment`), the stage from +0x56 (5 compute) or the SPH, compute's c0 layout `nvn2_cs` (+0xb1, +0xb2, +0xb3, +0xba, +0xa9 × 4, +0xb4, +0xb5), its thread group / shared memory (+0x58, +0x64, as `shader_split.py` writes the answer table), early fragment tests at +0x5b. The test compares both with nxnative's own `job_for` on 90 synthetic NVN2 sections. Not done: VertexA/B, transform feedback, the answer table; NVN2 task / mesh (+0x56 6 / 7: nxnative runs them as compute in a Metal mesh stage, `dmsh_meshstage.py`; WebGPU has no mesh pipeline) and tessellation / geometry are refused by name. |
| 4 | `dmsh_xlate` (`Program.cs` + vendored Ryujinx 1.3.2 with nxnative's changes) | job → SPIR-V 1.3 + `res.json` (bindings, slots, flags) | Partly: flags `MetalImageAtomics`, `MetalUniformBounds`; no depth rewrite; origin upper-left; all resources in set 0 with running binding numbers (for one Metal argument buffer) | Runs here unchanged, natively and as WebAssembly. An nxweb driver should drop `MetalUniformBounds` (the pass undoes it) and decide on image atomics. |
| 5 | SPIRV-Cross `--msl --msl-argument-buffers …` | SPIR-V → MSL | Yes | **Replaced** by the SPIR-V pass + naga → WGSL. |
| 6 | MSL text fix-ups in `dmsh_build.py` and `dmsh_*.py` (regular expressions on SPIRV-Cross's output) | MSL → MSL: `precise::min/max`, `vs_depth` (two entry points), `vs_pad` (outputs the partner reads), `int_inputs` / `dmsh_vin` (integer inputs), `fs_uint` (integer outputs), `border_emu`, `pool_arrays` (bindless), `dmsh_pull` (vertex pulling), `dmsh_fetch` (framebuffer fetch), `dmsh_alpha`, `dmsh_logic`, `dmsh_geometry`, `dmsh_meshstage`, `tg_spill`, … | Yes, all of it: each is written against MSL text | **None carries over as code.** Each need that WebGPU also has must be redone, on SPIR-V (as the pass does) rather than on WGSL text. See section 5. |
| 7 | `reflect()` | MSL argument buffer members → `<key>_b.json`: kind (`dmsh_abi.h` `DMSH_KIND_*`), NVN slot, argument index | The carrier is Metal's; the kinds are not | The pass reports the same kinds from the same names (`fp_c3`, `fp_t_tcb_8`, …). |
| 8 | Metal compiler, `metallib`, `pso_offline.py`, `shader_lib.py` image | MSL → libraries, pipeline archive | Yes | Gone: the browser compiles WGSL. The library is `library.nxsl`. |

## 2. What a translated shader assumes (the ABI), and where each thing is decided

- **Uniform buffers.** Maxwell reads constant banks `c[n]`. The NVN driver uses `c[0]` and `c[2]` for itself, `c[1]` is the
  shader's own constants, `c[3 + r]` is the game's uniform slot `r` (14 per stage). The translator declares each bank it
  reads as `struct { vec4 data[4096]; }` named `<vp|fp|cp>_c<n>` and reads single components. Decided by: Ryujinx
  (`ResourceManager`), numbering by `Program.cs` `CreateConstantBufferBinding`.
- **Bound sizes** (`c25`, `DMSH_CBSIZE_BANK`): nxnative's translator compares every read's offset with the size the game
  bound and gives 0 past it, as Maxwell does. Metal needs that; in WebGPU the binding must cover the declared type, so
  the pass folds the table to constants and the host zero-fills.
- **Driver tables** (`dmsh_abi.h`): `c[2]` holds the handle of every texture binding, one 32-bit word every 8 bytes:
  combined textures (`nvnCommandBufferBindTexture`) slot r at 0x20 + 8r, images at 0x120, separate textures at 0x168
  (reflection slot 128 + r), separate samplers at 0x568. `c[0]` holds storage buffer address tables per stage (vertex
  0x110, compute 0x310, geometry 0x410, pixel 0x510), compute dispatch size, largest point size (0x610), sample
  positions (0x620), base instance (0x644). A texture instruction's handle is traced by the translator to its `c[2]`
  word, and the variable is named after it: `fp_t_tcb_8` = word 8 = byte 0x20 = combined slot 0. Reads of `c[0]` /
  `c[2]` that are not handles stay as buffer reads (`drv_reads`), which the host fills.
- **Textures and samplers.** SPIR-V combined image samplers. Handle type (top 4 bits of the name's hex) 0 = one handle
  with texture and sampler; 1/2 = separate texture word OR sampler word; 3 = constant sampler ID. Texture *type* is not
  in the code: Maxwell's `TEX` says 2D / 3D / cube / array, but 1D vs buffer, and anything about a size query, come from
  the per-game answer table or from the shader's other instructions (`Program.cs` `TextureTypesOf`).
- **Bindless.** A handle read from the game's own uniform buffer (`fp_t_cb7_2A` = `c[7]` word 0x2A) is a texture the
  host must look up per draw: `tex_ubo` / `samp_ubo`. Handles the translator cannot trace become arrays indexed by the
  handle's IDs (2^20 textures, 2^12 samplers) which `pool_arrays` turns into pointers into the game's whole texture
  and sampler pools (`tex_pool`, `tex_htab`, `tex_c2a`). Metal argument buffers can hold that; **WebGPU has no
  unbounded binding arrays** (64 KB uniform limit, sampled textures per stage 16 by default).
  Here: a single handle in a uniform slot (`tex_ubo` / `samp_ubo`, handle types 0, 1 with the sampler word in a
  uniform slot, 3) is placed. The pass gives the texture the lowest texture slot no bound texture of the shader
  uses and reports `handle: { ubo, offset, sampler? }` on that slot; the host reads the handle at each draw
  (src/gfx/README.md "Bindless textures"). Arrays of handles and pools are refused ("an array of combined
  samplers"), as is a bindless texture whose sampler is a separate sampler of `c[2]`: no answer.
- **Vertex inputs.** `Location l` = NVN attribute `l` (generic attribute `a[0x80 + 16 l]`). Declared float unless the
  answer table says sint / uint. Maxwell's fetch puts the format's converted bits in a register; Metal and WebGPU
  both require the declared class to match the bound format, which is pipeline state, not shader state.
- **The pulling path** (`dmsh_pull.py`, `<key>_bp`): a second vertex function with no stage inputs that reads the vertex
  streams itself through a per-draw layout block and decodes NVN formats at run time, so one pipeline serves every
  vertex layout while the exact one compiles. Metal reads vertex buffers as raw memory at buffer slot 16+. In WebGPU the
  same thing needs the streams bound as storage buffers (read-only storage in the vertex stage; 8 per stage by
  default, and none at all on some compatibility-mode devices). Not built; it is an optimisation for compile stalls.
- **Fragment outputs.** `Location i` = colour target i, components per the program header's output map (`frag_out_map`);
  float unless the answer table says integer. Depth output when the header says so.
- **Origin and depth.** The translator is told: origin upper-left, no Y flip, no depth rewrite, so position and
  `gl_FragCoord` come out exactly as the guest computed them. nxnative then adds `z' = z/2 + w/2` as a second MSL entry
  point and flips with a negative-height viewport. nxweb: one fix-up uniform, section 4.
- **Support buffer** (`support_buffer`, Ryujinx's): fragment-is-BGRA flags, alpha test reference, viewport size, render
  scale. The translator divides `gl_FragCoord.xy` by the render scale, so any pixel shader that reads its coordinate
  needs this buffer with scale 1.
- **Precision.** `reduced: true` (nxnative's default) marks only some operations `NoContraction`. naga drops the
  decoration; WGSL has no equivalent of `invariant` on arbitrary expressions (it keeps `@invariant` on the position).

## 3. Tools: what installed, what ran

| Tool | How | Result |
|---|---|---|
| .NET SDK 10.0.403 | `dotnet-install.sh` from builds.dotnet.microsoft.com (16 s) | Works. `apt install dotnet-sdk-10.0` also resolves (10.0.114) but the mirror delivered ~70 KB/s and was stopped. |
| nxnative's prebuilt `dmsh_xlate_bin/dmsh_xlate.dll` | `dotnet dmsh_xlate.dll` | Runs on Linux as is: the DLLs are portable, only the launcher is Mach-O. `--source-sha` prints `8986080b40b79cab`, the lock file's value. |
| Translator from source | copy of `dm/gfx/tools/dmsh_xlate` + `dm/third_party/ryujinx`, `dotnet publish` (NuGet reachable) | Builds; same source hash. |
| Translator as WebAssembly | `Microsoft.NET.Sdk.WebAssembly`, `browser-wasm`, trimmed, no `wasm-tools` workload (interpreter) | Builds in 34 s; 5.49 MB of wasm (1.77 MB brotli) + 388 KB of JS. Runs under Node and in Chromium; SPIR-V byte-identical to the native run. |
| glslang 15.1.0, spirv-tools 2025.1, spirv-cross | `apt install glslang-tools spirv-tools spirv-cross` | Work. glslang is only for test shaders. |
| naga-cli 30.0.1 | `cargo install naga-cli` (2 min) | Works; used to cross-check. |
| naga as wasm | `rustup target add wasm32-unknown-unknown`; `naga_wasm/` (`spv-in`, `wgsl-out` only) | 707,481 bytes (211 KB gzip), 30 s to build. The npm packages are no use: `naga-wasm` is an empty placeholder, `wasm-naga` is naga 0.3. |
| tint | no npm package ships it; dawn.googlesource.com answers, a build from source was **not attempted** | Not evaluated as a converter. Chromium's Tint is the consumer: it compiled every WGSL module in the tests. Tint's SPIR-V reader is not exposed to pages in any case. |
| github.com release pages | 403 | Refused. |

## 4. The SPIR-V pass (`src/shaders/spv.ts`)

naga's SPIR-V reader and WGSL writer refuse the translator's output as it comes. Found by running, in this order:

| # | Found | Because | The pass |
|---|---|---|---|
| 1 | `unsupported extension SPV_EXT_fragment_shader_interlock` on every pixel shader | Ryujinx declares it (and subgroup, buffer-image, Float64 capabilities) for every shader | Drops what the module does not use. Used interlock is dropped with a note; subgroups, doubles, buffer textures are errors. |
| 2 | `Unsupported relational function: IsNan` on every pixel shader that samples | nxnative's translator replaces NaN coordinates by 0 before each sample; WGSL has no `isnan` | Rewritten on the bits: `(bits & 0x7fffffff) > 0x7f800000`. Same for `IsInf`. |
| 3 | `unsupported instruction UMulExtended` | Maxwell `IMUL.HI`; nxnative counts 348,587 in one game | High word from 16-bit halves, signed from unsigned. Arithmetic checked in JavaScript against BigInt (100,100 pairs), not on a GPU. |
| 4 | `Unsupported builtin value: PointSize` on every vertex shader | Ryujinx writes `gl_PointSize = 1` in every vertex shader; WGSL has no point size | Stores to point size, clip and cull distances removed (naga then omits the members). Non-constant point size and any clip distance: a note (a loss). |
| 5 | `invalid id` on every combined sampler | naga has no combined image samplers; WGSL neither | **Splitting rule**: the variable keeps its id, name and decorations and becomes the texture; a sampler variable `<name>_samp` is added; each `OpLoad` of the pair becomes load texture, load sampler, `OpSampledImage`. **Numbering**: combined slot `s` of stage `st` → texture `@group(1) @binding(st*64 + 2s)`, sampler `+1`. Depth images give `texture_depth_*` + `sampler_comparison` (naga infers it from the comparison instructions). |
| 6 | 64 KB uniform blocks | `vec4 data[4096]` whatever is read; WebGPU requires the bound range to cover the type, and 65,536 is exactly the default `maxUniformBufferBindingSize` | Bound-size table (`c25`) → private constant of all ones; unused uniforms removed; each block cut after the last vector read at a constant index (a computed index keeps 4096). The reflection carries `uboSize`. |
| 7 | Bindings | Set 0 with running numbers | From the names: `<p>_c<3+r>` → `@group(0) @binding(st*16 + r)`; `support_buffer` → `st*16 + 14`; `c1`, the driver's `c0` / `c2` and the push constants `c24` → host blocks `@group(0) @binding(208 + st*4 + k)` (k: c1 0, c0 1, c2 2, c24 3; the host fills c1 from the job's c1 segment, c0 / c2 with the driver words, c24 with what `nvnCommandBufferPush*Constants` pushed); textures as in 5. A bindless texture (`<p>_t…_cb<bank>_<handle>`, bank 3..16) takes a free texture slot and a `handle` in the record. Separate, image, storage, array-of-sampler variables are errors ("not placed yet"). |
| 8 | Origin and depth | run-time state in NVN | Vertex: `@group(2) @binding(0)` one `vec4f`; before every return of the entry point `pos.y *= fix.y; pos.z = pos.z*fix.z + pos.w*fix.w` (`src/gfx/README.md` item 4). |
| 9 | `'textureSample' must only be called from uniform control flow` (Chromium, not naga) | WGSL's derivative uniformity analysis; Maxwell samples under predicates | `diagnostic(off, derivative_uniformity);` at the top of every fragment module. Derivatives there are then undefined, as on the hardware. |
| 10 | `unsupported instruction ImageQueryLod` | Maxwell `TMML`; WGSL has no `textureQueryLod` | Pixel stage: from the coordinate's derivatives, scaled by the level-0 size (`textureDimensions`), λ = ½·log2(max(\|dx\|², \|dy\|²)), clamped to the view's levels; a cube by the major axis. The sampler's bias and LOD clamps are left out (noted). Other stages have no derivatives: 0, noted. |
| 11 | `ConstExpression ... Literal(Infinity)` / `Literal(NaN)` (232 of the 702 stages of one game) | the translator writes Maxwell's immediates as float constants, `+inf` / NaN among them (FMNMX, FSETP bounds); naga refuses them as constant expressions, and Tint refuses any constant expression it folds to one | `nonFiniteConstants`: each becomes a private `u32` variable holding the bits, loaded and bitcast at the top of each function that reads it (a composite holding one is built there), so the value only exists at run time. |
| 12 | `Unsupported builtin value: BaseInstance` (309 of 702) | the translator turns NVN's c0 reads at 0x640 / 0x644 / 0x648 into BaseVertex / BaseInstance / DrawIndex (`DrawParametersReplace.cs`; Maxwell's instance ID is `InstanceIndex - BaseInstance`); WGSL's `vertex_index` / `instance_index` include the bases, but WGSL has no builtin for them | `drawParameters`: the loads read `@group(2) @binding(2)` `{ i32 base vertex, base instance, draw index }`, which the host writes per draw at a dynamic offset (reflection `drawParams`; `src/gfx/README.md`). |

Every rewritten module passes `spirv-val` (38 modules in the test).

### The corpus (`test/shaders/corpus`, 46 GLSL shaders → glslang → pass → naga → Chromium)

Written after reading Ryujinx's `CodeGen/Spirv` for what it emits. **29 convert; 27 of those compile in Chromium.**

Converts and compiles: uniform arrays with constant and computed indices; `texture`, `textureLod`, `textureGrad`, bias,
constant and **run-time** offsets (gather), `texelFetch`, `textureSize`, `textureQueryLevels`, `textureGather`,
projective; shadow samplers incl. gather and explicit LOD; 3D, cube, 2D array, cube array, cube shadow, array shadow;
integer textures with `texelFetch`; bit-field extract / insert / reverse, bit count, find MSB / LSB, shifts, bit casts;
extended multiply (through the pass); `fma`, min / max / clamp, round-even, trunc, `exp2`, `log2`, `pow`, `inversesqrt`,
`isnan` / `isinf` and infinite / NaN constants (through the pass), half-float pack / unpack; loops, `continue`, `break`, `switch` without
fall-through, `discard` in a branch, samples in non-uniform branches and loops; `gl_FragCoord`, `gl_FrontFacing`,
derivatives, `gl_FragDepth`; integer and multiple colour outputs; early fragment tests; `gl_VertexIndex`,
`gl_InstanceIndex`, `gl_BaseVertex` / `gl_BaseInstance` / `gl_DrawID` (through the pass and the host), integer attributes, flat / noperspective outputs; a private array indexed at run time (local memory).

Fails, **and Ryujinx emits it** (so real shaders will hit it):

| Construct | Where it fails | Needs |
|---|---|---|
| Storage buffers, `imageLoad` / `imageStore`, image atomics | the pass (not placed) | Bindings in `src/gfx` first. WebGPU: no storage images of most formats, no image atomics at all, fragment-stage storage writes need care; atomics exist only on `atomic<u32/i32>` in storage buffers. |
| Buffer textures, 1D textures | the pass | The 2D-rows treatment nxnative gives buffer textures (`tbuf_as_2d`), in the pass and the host. |
| Multisampled textures | the pass | A binding kind (`texture_multisampled_2d`), small. |
| Arrays of samplers (bindless tables: handle arrays, pools) | the pass | See section 2: no design; WebGPU's core has no binding arrays. Single bindless handles are placed. |
| Integer texture through a filtering sample | naga validation | Rewrite to `textureLoad` at the nearest texel in the pass. |
| 64-bit floats | the pass | Translate with `softfloat64` first, as nxnative does. |
| Subgroup operations, `OpControlBarrier` shuffles | the pass (error) | nxnative lowers a few by hand; nothing here. |
| `gl_PointCoord`, `gl_SampleID` / sample position / sample mask, `gl_Layer`, `gl_PrimitiveID` | naga, or Chromium (`primitive_index` needs a device feature) | Point sprites have no WebGPU form; sample builtins exist in WGSL but naga's reader refuses these; layer needs the geometry lowering anyway. |
| Dual-source blending | Chromium: needs the `dual-source-blending` feature | Request the feature when present. |
| Geometry, tessellation, task / mesh stages; transform feedback | the pass (no such stage) | nxnative lowers geometry to compute; WebGPU would need the same and has no transform feedback. |

Fails, Ryujinx does not emit it (so it does not matter): add-with-carry, `frexp` / `modf`, `interpolateAt*`, fall-through `switch`.

## 5. What does not carry over from nxnative's fix-ups, and what replaces it

| nxnative | Why it exists | nxweb |
|---|---|---|
| `vs_depth` (two entry points), negative viewport | depth mode, origin | Done: the fix-up uniform. |
| `precise::min/max` | NaN operands | **Open.** WGSL leaves `min` / `max` with NaN to the implementation. Needs a select-based rewrite in the pass if games depend on it (nxnative found one that does). |
| `vs_pad` (declare outputs the pixel shader reads) | Metal refuses a pipeline whose fragment input has no vertex output | **Same rule in WebGPU.** Needs the pair tables and a pass that adds outputs with (0, 0, 0, 1). Not built. |
| `int_inputs`, `dmsh_vin` shadows | input class must match the vertex format | **Same rule in WebGPU** (`src/gfx/README.md` item 3). Options in section 7. |
| `fs_uint` | integer render targets | Same rule; a per-target variant, by a pass on the output variable. Not built. |
| `border_emu` | Metal has three border colours | WebGPU has **no** border colour address mode at all: needs emulation in every sample of such a sampler, or clamping. Not built. |
| `dmsh_alpha` | alpha test | WebGPU has none either: a discard against a uniform, as the gfx README anticipates. Ryujinx can emit it (`AlphaTestCompare`), but as a translation-time constant; a uniform-driven variant needs a pass. |
| `dmsh_logic` | logic ops | No WebGPU form without reading the target. |
| `dmsh_fetch` | framebuffer fetch (tile memory) | No WebGPU form; `src/gfx` already snapshots. |
| `pool_arrays`, htab, c2a | bindless tables | No design; the hard one. Single handles in uniform slots need no fix-up and are placed (section 2). |
| `dmsh_geometry`, `dmsh_meshstage`, `tg_spill`, atomics | stages and memory Metal lacks | Each needs its own answer; several have none in WebGPU 1.0. |

## 6. The library (`src/shaders/library.ts`)

`src/gfx` had only in-memory registration, so this is new: one file, binary index, text payloads.

```
+0  "NXSL"   +4 u32 version (1)   +8 u32 count   +12 u32 metaLength
+16 count × 24 bytes, sorted by key as a little-endian u64:
      key[8] (digest order; its hex is registerShader's keyHex), u32 stage (0 vertex, 1 fragment, 2 compute),
      u32 offset, u32 wgslLength, u32 reflLength
then meta (JSON: { chain, built, failed }), then per entry: WGSL (UTF-8), reflection (JSON)
```

Reflection = the record of `src/gfx/README.md` item 5 (`stage, entry, ubos, textures[{slot, dim, depth}], attributes |
outputs, fixup`) plus `uboSize` (slot → bytes the WGSL type covers), `attributeTypes` / `outputTypes`, `extra` (bindings
that are none of those: support buffer, c1, driver segments) and `notes` (losses). `ShaderLibrary.get(keyHex)`,
`.has`, `.keys()`, `.entries()`, `.registerAll(host)`; the constructor refuses a damaged file (magic, version,
truncation, offsets, order). Not compressed: serve it with HTTP compression; an entry can be fetched by range.

### What `src/gfx` must change to consume it

1. Call `new ShaderLibrary(bytes).registerAll(host)` (or `get` on a missing key). Nothing else is needed for shaders
   that use only game uniform slots and combined 2D / 3D / cube / array textures: the record is the one it asked for.
2. **Uniform binding size.** Bind at least `uboSize[slot]` bytes, zero-filled past the size the game bound
   (`gfx_host.ts` binds `min(buffer, bound size)`; a game binding fewer bytes than the shader's type covers would fail
   validation, and reads past the bound size must give 0). This replaces nxnative's bound-size table. README item 1
   says "a struct of at most the bound size": the chain cannot promise that, the type's size comes from the code.
3. `dim: "cube-array"` exists in the record; `registerShader` packs four dimensions in two bits.
4. `extra` bindings: the support buffer (`@group(0) @binding(stage*16 + 14)`, Ryujinx's layout, render scale 1) for any
   pixel shader that reads `gl_FragCoord.xy`; later c1 and the driver segments at group 3. `registerAll` skips entries
   that need them and says so.
5. Integer and unfilterable textures: the record says `depth` or not; `sampleType` sint / uint is only a note today.
6. Requesting `dual-source-blending`, `primitive-index`, `clip-distances` when the adapter has them.

### On the open item: `gl_FragCoord.y` and `dFdy` under a lower-left origin

Proposal: **no fragment fix-up, given how `src/gfx` stores targets.** With a lower-left origin it stores targets
bottom-up (row 0 = GL's bottom row) and mirrors clip-space y in the vertex fix-up. A fragment at GL window row `r`
therefore lands in stored row `r`, and WebGPU's `@builtin(position).y` for stored row `r` is `r + 0.5`: the value GL's
`gl_FragCoord.y` has. `dpdy` differences rows `r` and `r + 1`, GL's direction too. So both already equal what the
guest shader was compiled to expect, in both origins, and binding `fix` to fragment stages would be wrong. What does
depend on the mode: front facing (handled by the inverted winding in the pipeline key) and point coordinates (not
available at all). This is reasoning from the README's description; **no test here exercises it**, and it holds only
while every consumer of a target (sampling, copies, present) uses the same bottom-up convention.

## 7. Recommendation: translate in the page, cache per key; keep the offline tool as the same code

Measured here (x86-64 Linux, Node 22, Chromium on SwiftShader; three small stages, so per-stage costs are floors):

| | Size | Time |
|---|---|---|
| Translator, native .NET | 5.1 MB publish folder (needs a .NET runtime) | 265–300 ms for 3 stages, process start included |
| Translator, WebAssembly (interpreter) | 5.49 MB wasm (1.77 MB brotli, 2.18 MB gzip) + 0.39 MB JS | runtime up in 230–260 ms; 3 stages 260–380 ms first call, 33–42 ms second |
| SPIR-V pass + naga, WebAssembly | 707 KB (211 KB gzip) | instantiate 14–17 ms; 3–20 ms a stage (first is slowest) |
| Output | 3.4–6.2 KB SPIR-V → 3.1–6.9 KB WGSL a stage | |

1. **In the page, on demand, cached by key** (IndexedDB / OPFS, the entry format of the library). Reasons, in order:
   - It works: the whole chain ran in Chromium and produced the offline library's WGSL byte for byte.
   - The user installs nothing. The offline route needs Python, .NET and Node on their machine, plus `shader_split.py`
     pointed at their game files; the page already has the code and control section at `nvnProgramSetShaders`.
   - **Translation can use run-time facts that the offline build has to guess or tabulate**: the bound vertex formats
     (input classes), the bound textures' types (nxnative's per-game `shader_facts.tsv`), render target classes, the
     partner stage (`vs_pad`). nxnative's answer tables exist only because it must translate before the game runs.
   - 2 MB compressed once is small beside a game.
   Costs: the interpreter is the slow way to run .NET (AOT needs the `wasm-tools` workload: not tried; it trades size
   for speed); a first-seen shader stalls its draw unless translation runs in a worker and the draw is skipped or
   deferred (nxweb already skips draws of missing keys); and `src/gfx` computes keys from the stage alone, so a variant
   per vertex layout needs a wider cache key.
2. **Offline library as an optional pre-warm**, built by the *same* TypeScript and wasm (`build_lib.mts` is that), for
   users who run `shader_split.py`, and for testing whole games' shader sets in bulk. Do not make it the only route.
3. **Stop depending on text fix-ups.** Everything nxweb adds should be a SPIR-V pass (`spv.ts` is about 510 lines for nine of
   them) or a translator option, never a regular expression over WGSL.
4. **Give nxweb its own translator driver** (a copy of `Program.cs`, ~300 lines): no `MetalUniformBounds`, nxweb's
   binding numbers directly, the JSON job replaced by a call interface (`[JSExport]`) so the page need not go through
   an in-memory file system. Not built here: the unmodified driver was enough to prove the chain.

### Unknowns only real game shaders can settle

1. **How much of a real library converts.** The three Maxwell programs use 24 instruction kinds; GLSLC uses far more.
   Every row of the "fails, and Ryujinx emits it" table will occur; how often is unknown.
2. **Bindless textures** (handles in uniform buffers, pool arrays): how many shaders, and whether a bounded scheme
   (resolve per draw to at most 16 textures) covers them. nxnative's notes say Unreal, Unity and RE Engine bind
   separately and several first-party engines index pools.
3. **Limits.** WebGPU defaults: 12 uniform buffers and 16 sampled textures + 16 samplers per stage, 16 vertex
   attributes, 8 storage buffers. A stage may read 14 game slots + support + c1 + driver segments. Whether real shaders
   exceed 12, and whether devices grant more, needs counts from real libraries.
4. **Size and time on real shaders**: nxnative reports 220 KB MSL sources for one game. naga's and the browser
   compiler's time on such modules, and `createRenderPipelineAsync` stalls, are unmeasured.
5. **naga's structured control flow** on Ryujinx's output for large shaders with loops and early returns (naga rejects
   some shapes); and the browser compilers' handling of thousands of `select`s and private globals.
6. **Float semantics**: NaN in `min` / `max` / `clamp`, denormals (`.FTZ`), `NoContraction`, `invariant` position
   between passes (z-fighting between a depth pre-pass and the colour pass if the two vertex shaders compile apart).
7. **Whether the `debug: false` translator crash seen here** (`KeyNotFoundException` in the SPIR-V generator on a
   texel fetch; `debug: true`, nxnative's default, is fine) matters: it decides how verbose the WGSL is.
8. **Vertex input classes**: how often a game feeds one shader both float and integer formats (nxnative needed
   shadow inputs for a quarter of one game's replay time).
9. The fragment-coordinate argument above, on a game with a lower-left window.

## 8. Test results (`npm run shaders:test`, 27 tests, 0 failed)

Node: SPIR-V round trip (43 modules); garbage refused by the reader, by naga; corpus against `expect.json` (27 convert,
16 refused, each with the expected reason); `spirv-val` on 38 rewritten modules; uniform shrinking (96 bytes for
`data[0]`, `data[5]`; 65,536 for a computed index); sampler split and numbering; fix-up placement; losses as notes;
extended multiply arithmetic; library round trip, damage, `registerAll`; Maxwell keys = sha256; **translator: 4 of 4
hand-assembled programs translated, its output passes `spirv-val`; random bytes, an empty file and a missing file each
refused with one `[RED]` line and exit status 1, no crash or hang**; the Maxwell library with nxweb's bindings, among them a
bindless program (`TEXB` with its handle loaded from `c[5]`: the translator names the texture `fp_t_cb5_A`, the pass
reports `handle: { ubo: 2, offset: 0x28 }` on slot 0 and `registerAll` passes it on); the pass on the other bindless
names (two words, constant sampler ID) and its refusals (sampler in `c[2]`, a bank that is no uniform slot).

Chromium (headless, WebGPU on SwiftShader): Tint compiles 25 of 27 corpus modules (2 need device features), 2 of 2
end-to-end, 4 of 4 Maxwell-derived. **Rendered and read back, 3,720 pixels compared with values computed in the test,
tolerance 1/255**, for each of: GLSL-derived shaders, upper-left / near 0; the same, lower-left / near −w (fix-up
`(1, −1, 0.5, 0.5)`, picture mirrored); **Maxwell-derived shaders** (hand-assembled code → Ryujinx → pass → naga →
library → WebGPU) in both modes. The check is shown to fail on a mirrored picture. The pass and naga run in the page
and give the offline WGSL; the whole chain including the translator runs in the page and gives the offline library.

The scene: a quad over the left half placed by vertex uniform slot 0, a 2 × 2 texture sampled nearest through a split
combined sampler at slot 0, times a tint from fragment uniform slot 0, pixels under an alpha threshold discarded.

Without `dotnet` on `PATH` or without the nxnative checkout (`NXNATIVE`), the Maxwell tests print `SKIPPED` and the rest run.
