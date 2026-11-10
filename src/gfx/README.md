# gfx: NVN on WebGPU

Port of nxnative `dm/gfx/nvn` (NVN on Metal). Two halves with a hard line between them:

| Half | Where | Does |
|---|---|---|
| Recorder, AssemblyScript | `src/gfx/*.ts` → `build/gfx/gfx.wasm` | Every NVN entry point, guest object state, command records in the game's command memory, and the **lowering** of submitted commands to a host stream. All NVN semantics. |
| Replayer, TypeScript | `src/glue/gfx_host.ts`, `gfx_formats.ts` | Reads the host stream and the tables it points to from linear memory and makes the WebGPU call for each record. Decides nothing. |

```
game ──nvn_call──▶ dispatch.ts ─▶ cmd.ts ── records ──▶ guest command memory        (nxnative's format)
        QueueSubmitCommands ─▶ lower.ts ── walks records, pass machine, pipeline keys
                                   └─ hostops.ts ── host stream ──env.gfx_exec──▶ gfx_host.ts ──▶ WebGPU
```

| File | What |
|---|---|
| `index.ts` | Exports: `nvn_call`, `nvn_lookup`, `gfx_*`, the kit's. |
| `dispatch.ts` | The switch of implemented functions (objects are small enough to live in it). |
| `obj.ts` | Guest object layouts and record formats (nxnative `nvn_obj.h`). |
| `cmd.ts` | Recording: segments, JUMP, the out-of-memory callback, host-lent segments. |
| `lower.ts` | Submit: the walk (CALL, JUMP), current state, the render pass machine, draws, copies. |
| `pipeline.ts` | Pipeline key and cache. `shader.ts`: shader keys and library. `sync.ts`, `window.ts`, `tables.ts`, `texlayout.ts` (nxnative `nvn_tex.c`), `sha256.ts`, `arena.ts`, `log.ts`. |
| `defs/*.json` | The five machines: `gfx_cmdbuf`, `gfx_pass`, `gfx_pipeline`, `gfx_image`, `gfx_sync` (diagrams in `docs/machines/`). |
| `names.txt`, `host/gen_names.mts`, `gen/names.ts` | The 743 NVN names (nxnative `names.txt`) and the generated lookup table. |

## Interface to the rest of nxweb

- `nvn_lookup(namePtr) -> id` (‑1 for a name NVN does not have, red). `nvn_call(id, argsPtr) -> x0`: `argsPtr` is x0..x7
  (8 × u64) then d0..d7 (8 × f64) as the guest passed them; float arguments are the low 32 bits of their d register.
  No implemented function returns a float yet; one that does will write d0 back at `argsPtr + 64`.
- `gfx_init(arena, bytes)` once: 16 MB (`gfx_arena_bytes()`) of linear memory for the tables. Static data sits at the
  build's `--memoryBase` (64 KB) up to `gfx_static_end()`. Memory is imported (`env.memory`).
- Imports: `env.log(ptr, len)`, `env.gfx_exec(ptr, len)` (the replayer), `env.gfx_guest_call(fn, x0..x3) -> x0` (the
  command memory callback runs guest code), `env.gfx_proc_address(id) -> address` (for `nvnDeviceGetProcAddress`).
- Fences for the kernel: `gfx_fence_done(n)`, `gfx_fence_word()` (address of a u64: the highest fence done),
  `gfx_sync_fence(sync)`. `nvnSyncWait` never blocks: it returns ALREADY_SIGNALED or TIMEOUT_EXPIRED.
- Shader library: `GfxHost.registerShader(key, { stage, wgsl, ubos, textures, attributes | outputs })`. WGSL convention:
  `@group(0) @binding(stage*16 + i)` uniform buffer i (stage 0 vertex, 1 fragment); `@group(1) @binding(stage*64 + slot*2)`
  texture, `+1` its sampler; vertex `@location(l)` = NVN attribute l; fragment `@location(i)` = colour target i.

## Records: where they match nxnative and where they depart

Matches, byte for byte (checked against `nvn_obj.h` compiled by gcc, see below): `{u32 op, u32 size}` headers, the op
numbers, every payload layout, the texture snapshots behind records that name textures, records cut to what they use
(draws without the indirect fields, state binds with only the state's bytes, single binds in 24 bytes), 16 bytes kept
for a JUMP after every record but the END, no BEGIN record, CALL = CopyCommands, copy strides as command buffer state.
Object layouts and sizes likewise, including the bit-fields of the state objects and the sampler state from byte 8.

Departs:
- **`cmd_t`**: the `recording` word is unused; the state is a `gfx_cmdbuf` instance at +112 (object 128 bytes, NVN reserves 160).
  A command outside a recording is refused (red) and not written; nxnative writes it, where no handle owns it.
- **`sync_t`**: `{magic, gfx_sync instance}` (24 bytes) instead of `{magic, fenced, fence}`.
- **`win_t`**: four `gfx_image` instances where nxnative keeps its pacing clock and present tickets; same size.
- **Lowering** is new: nxnative replays records straight into Metal. Here the walk produces a second, flat stream
  (`hostops.ts`) so that the pass machine and every decision stay in AssemblyScript.
- **Shader key** is always computed at `ProgramSetShaders` (nxnative defers when the code is not yet in a pool).
- **Host-lent segments** come from an 8 MB arena inside linear memory (records hold pointers), not from malloc.
- **QueueFinish** flushes and returns; nothing blocks in a browser turn. Acquire likewise takes the next image in turn
  even when it is still queued.
- UpdateUniformBuffer / CopyBufferToBuffer are done on guest memory in stream order (the replayer is flushed first,
  then told to drop its uploads); they do not end the pass.
- One lowering state for all queues (nxnative: one per queue).

## The render pass machine (`gfx_pass`)

WebGPU fixes attachments and load actions at pass begin, cannot clear inside a pass, and rejects sampling an attachment.

| NVN | Machine | Stream |
|---|---|---|
| SetRenderTargets | → TargetsSet (same targets while Open: nothing) | ends the pass; pending clears land in a pass of their own |
| Clear, whole target, all channels | → ClearPending | becomes the load action; in a pass, the pass ends first |
| Clear, scissored or masked | → Open | `H_CLEAR_RECT`: a triangle inside the pass |
| Draw | → Open | `H_BEGIN_PASS` with the pending clears, then only the state that changed |
| Draw that samples one of its targets | Feedback → TargetsSet, then Draw | `H_SNAPSHOT` (copy), reopen with load, sample the copy; later draws of that pass reuse it |
| Texture copy, fence, present, non-zero Barrier | Break | ends the pass |
| End of QueueSubmitCommands | Submit | ends the pass, `H_FLUSH` |

Pipelines (`gfx_pipeline`): key = shaders + vertex layout + blend, depth-stencil, raster state + target formats. First
use → `Building`: the replayer starts `createRenderPipelineAsync` and builds synchronously for the draw that needs it
now; `Ready` or `Failed` comes back through `gfx_pipeline_done`. Draws of a failed pipeline are skipped (red once).
A shader key missing from the library: `[RED] shader <key> is not in the shader map` once, its draws skipped.

## Texture content from guest memory (`texcontent.ts`, machine `gfx_texture`)

A texture's storage is a range of a memory pool, block-linear (GOBs of 64 × 8 bytes, 16-byte runs, block height and
depth per level) unless the texture is linear. `blMove` is nxnative's `nvn_deswizzle.c` in both directions; the replayer
receives linear rows (`H_TEX_DATA`), deswizzled 4 MB at a time, or straight from memory for linear textures.

nxnative write-protects texture pages to see CPU writes; a wasm module cannot. Instead each texture is `Unknown`,
`Uploaded(sampled hash)` or `GpuOwned`, checked at its **first use in each submission** (sampled, copied from, presented):

| State | At first use in a submission |
|---|---|
| Unknown | deswizzle and upload every level and layer; keep the full hash and the sampled hash |
| Uploaded | sampled hash again (16 probes of 64 bytes; everything under 1 KB). Different → upload again. Same → full hash too when the game called `FlushMappedRange` over the storage since the last submission, or every 60 submissions within 1 MB of hashing a submission; different → upload again |
| GpuOwned | nothing. Entered when a pass, a copy or a clear writes the texture; never left |

Measured (100 textures 64×64 RGBA8 with 7 levels, all bound every frame, SwiftShader machine): first submission
14–19 ms for 2.1 MB deswizzled and uploaded; afterwards the checks cost about 0.3–0.5 µs a texture, 30–50 µs a frame.

Failure modes, accepted: a CPU write that touches no probed byte and is not flushed shows up to 60 submissions late
(later if more than 1 MB of textures are due at once); a CPU write into a `GpuOwned` texture's storage is never seen;
a texture changed while a submission that already used it is lowered keeps the old content for that submission.

`WriteTexels` writes into the storage (next use uploads) or, for a `GpuOwned` texture, straight to the GPU.
`ReadTexels` reads the storage; of a `GpuOwned` texture it is red and writes nothing (WebGPU readback is asynchronous).
`CopyTextureToBuffer` is a CPU copy in stream order when the storage holds the content; otherwise a GPU readback that
lands in guest memory later, and fences issued after it complete only once it has landed (`GfxHost.landed()`).

## Window origin, depth mode, and what the shader chain must emit

nxnative (Metal): lower-left origin = negative-height viewport, reversed winding, present flipped; depth mode = a
second vertex entry point. WebGPU has no negative viewport, so the split here is:

- **Recorder / replayer**: with a lower-left origin targets are stored bottom-up (row 0 = bottom, as GL). Viewport and
  scissor rectangles are used as given; front face is inverted in the pipeline key; present flips the blit. Before
  each pass's draws the replayer gets `H_FIXUP = (1, ysign, zscale, zoffset)`: `ysign` −1 for lower-left, else 1;
  `(zscale, zoffset)` = (0.5, 0.5) for NEAR_IS_MINUS_W, (1, 0) for NEAR_IS_ZERO.
- **A translated WGSL module must**:
  1. Uniform buffer `i` of a stage: `@group(0) @binding(stage*16 + i)` (stage 0 vertex, 1 fragment), a struct of at most the bound size.
  2. Texture slot `s` (the slot of `nvnCommandBufferBindTexture`): `@group(1) @binding(stage*64 + s*2)`, its sampler at `+1`
     (`sampler_comparison` with a `texture_depth_*` when declared `depth`).
  3. Vertex inputs `@location(l)` = NVN attribute index `l`, typed to match the attribute's format class (float / sint / uint).
     Fragment outputs `@location(i)` = colour target `i`.
  4. Vertex stage, last thing before returning the position: `struct NxFix { fix: vec4f }` at `@group(2) @binding(0)`, then
     `pos.y *= nx.fix.y; pos.z = pos.z * nx.fix.z + pos.w * nx.fix.w;` and declare `fixup: true`. Nothing else may depend on the modes
     (`gl_FragCoord.y` and `dFdy` users must multiply by `nx.fix.y` too if the chain exposes it to fragment stages: not bound there yet).
  5. Come with a reflection record: `{ stage, entry, ubos: [i…], textures: [{ slot, dim: 2d | 2d-array | cube | 3d, depth }…],
     attributes: [l…] (vertex) | outputs: [i…] (fragment), fixup }`, registered under the stage's key (`GfxHost.registerShader`).
  Alpha test, when ported, will need the fragment stage to discard against a replayer-supplied reference: not specified yet.

## Verified (`npm run gfx:test`, headless Chromium, WebGPU on SwiftShader; `npm run kit:test` for the tables)

- **Layout**: 268 offsets and sizes equal `nvn_obj.h` compiled by gcc (`test/gfx/layout_ref.c`), except the two listed
  departures; all objects fit NVN's reserved sizes; state-object bit-fields; the size of 41 recorded commands through
  `GetCommandMemoryUsed`; texture storage size / alignment / level offsets equal `nvn_tex.c` over 420 shapes;
  `DeviceGetInteger` equals nxnative's table.
- **Recording**: handles, empty recording, BeginRecording re-entered, the callback (arguments, size asked, JUMP
  placement), callback that adds nothing and no callback (host-lent segment); all 743 names resolve.
- **Deswizzler**: 18 textures (2D with mips, non-power-of-two, arrays, cubes, 3D, BC1/BC3/BC7, packaged layouts; 112
  levels and layers) laid out by an independent Python implementation (`test/gfx/swizzle_ref.py`: own layout, one byte
  at a time) come out identical and swizzle back identical; WriteTexels / ReadTexels regions over storage.
- **Scenes** (26, pixels read back with `copyTextureToBuffer`, expected values computed in the test): clear only;
  per-vertex colour; indexed textured quad nearest / linear; uniform animation + UpdateUniformBuffer + CopyBufferToBuffer;
  depth test on DEPTH32F / D24S8 / DEPTH16 with a scissored depth clear; blending; scissored and masked clears in a pass;
  full clear mid-pass; render to texture; self-sampling draw; CALL; buffer→texture, texture→texture (also scaled), mips
  and array layers; BC1/2/3/4/5/7; RGBA8, sRGB, BGRA8, R8, RG8, RGBA16F, RGB10A2, R11G11B10F as targets; missing key;
  command memory exhaustion; pipeline cache and failure; fences, syncs, window images; pool-backed textures uploaded
  and compared level by level; the content-tracking heuristics including their blind spot; WriteTexels;
  CopyTextureToBuffer on the CPU and from the GPU; 100 textures; both origin / depth conventions with culling.
- **Demo**: `npm run gfx:demo`, `test/gfx/demo.html`; the test run saves `build/gfx/demo.png`.

## NVN functions

743 names: **306 implemented, 11 empty by design** (nxnative's list: debug groups, patch size, depth bounds, scratch
memory), **426 red stubs** (`[RED] nvnXxx unimplemented` once, return 0). nxnative implements 489.
Implemented / total by object: DeviceBuilder 3/3, Device 19/61, QueueBuilder 9/23, Queue 10/16, MemoryPoolBuilder 7/8,
MemoryPool 9/10, TexturePool 7/9, SamplerPool 8/9, BufferBuilder 6/7, Buffer 10/11, TextureBuilder 30/44, TextureView
9/14, Texture 21/31, SamplerBuilder 13/25, Sampler 3/15, Program 4/34, Sync 4/6, WindowBuilder 7/20, Window 9/18,
CommandBuffer 67/214, Blend 7/15, Color 5/7, ChannelMask 2/3, Multisample 7/26, Polygon 9/9, DepthStencil 11/13,
VertexAttrib 5/5, VertexStream 5/5, Event(Builder) 0/11, other (NVN2, debug, raw) 0/71. The exact set is the
`case F.` lines of `dispatch.ts`.

## Gaps

- Texture content: sparse (virtual-pool) textures, ASTC, RGB5 / RGBA4 / 16-bit-norm formats, depth textures uploaded
  from memory, multisampled storage; ReadTexels of GPU-written textures; the blind spots listed above.
- `gl_FragCoord` / derivative sign under a lower-left origin (fix-up is bound to the vertex stage only); queues with
  an origin different from the device's.
- Triangle fans, quads, line loops, adjacency, patches; indirect and multi-draws; compute; storage buffers; images;
  separate textures / samplers; transform feedback; counters and events; multisample resolve; tessellation, geometry.
- One viewport and scissor; stencil masks and reference of the front face for both; no logic op, alpha test, border
  colour, polygon mode line / point, advanced blend, depth clamp, primitive restart index; a viewport larger than
  its target is clipped (red once).
- Uploads: each bound vertex, index and uniform range is copied to a GPU buffer once per submission (no dirty
  tracking); bind groups are rebuilt per change. Correct, not fast.
- Virtual (sparse) memory pools; `QueueFinish` and acquire pacing wait for the kernel.
