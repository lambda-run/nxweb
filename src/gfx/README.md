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
| `pipeline.ts` | Pipeline key and cache (render and compute). `shader.ts`: shader keys, library, reflection record. `sync.ts`, `window.ts`, `tables.ts`, `texlayout.ts` (nxnative `nvn_tex.c`), `sha256.ts`, `arena.ts`, `log.ts`. |
| `texcontent.ts`, `fmt.ts`, `astc.ts` | Texture content from guest memory; format classes, sRGB twins and conversions of formats WebGPU lacks; the ASTC decoder. |
| `device.ts` | The host device as a machine: loss and recovery. |
| `profile.ts`, `report.ts`, `texwatch.ts` | What a game's profile switches on; counter reports, timestamps and conditional rendering; textures the CPU keeps writing (flush and scanner). |
| `defs/*.json` | The nine machines: `gfx_cmdbuf`, `gfx_pass`, `gfx_pipeline`, `gfx_image`, `gfx_sync`, `gfx_texture`, `gfx_device`, `gfx_shader`, `gfx_render_enable` (diagrams in `docs/machines/`). |
| `src/glue/gfx_host.ts`, `gfx_formats.ts`, `gfx_capture.ts` | The replayer, its format table, and the frame capture's text and PNG writer. |
| `names.txt`, `host/gen_names.mts`, `gen/names.ts` | The 743 NVN names (nxnative `names.txt`) and the generated lookup table. |

## Interface to the rest of nxweb

- `nvn_lookup(namePtr) -> id` (‑1 for a name NVN does not have, red); `nvn_name(id) -> ptr` the other way (NUL-terminated,
  static memory, valid until the next `nvn_name`; 0 for no such id). `nvn_call(id, argsPtr) -> x0`: `argsPtr` is x0..x7
  (8 × u64) then d0..d7 (8 × f64) as the guest passed them; float arguments are the low 32 bits of their d register.
- **Floats.** `nvn_abi(id)` (and `nvn_abi_table()`: one byte an id, `nvn_count()` of them, to read once): bits 0–3 = how
  many of d0..d7 the function reads (0 for 326 of the 332 implemented functions: the embedder then need not marshal any),
  bit 4 = its result is a float: after `nvn_call` it is at `argsPtr + 64` (low 32 bits, the rest zero) and the embedder
  copies those 8 bytes to d0. The table is generated from `dispatch.ts` (`FL(a, i)`, `RETF`) and checked against the
  prototypes of nxnative's `nvn_protos.h`.
- `gfx_init(arena, bytes)` once: `gfx_arena_bytes()` of linear memory for the tables (**31 MB** today; ask, do not
  assume). Static data sits at the build's `--memoryBase` (64 KB) up to `gfx_static_end()`. Memory is imported (`env.memory`).
- Imports: `env.log(ptr, len)`, `env.gfx_exec(ptr, len)` (the replayer), `env.gfx_guest_call(fn, x0..x3) -> x0` (the
  command memory callback runs guest code), `env.gfx_proc_address(id) -> address` (for `nvnDeviceGetProcAddress`).
- **The replayer** `new GfxHost(device, memory, { canvas, log, requestDevice, uniformArena, forceAstcDecode })`,
  `host.attach(exports)` (tells the recorder what the device can take: `gfx_host_caps`), `host.imports()`.
  `GfxHost.deviceDescriptor(adapter)` is what to pass to `adapter.requestDevice`: every feature the replayer can use
  that the adapter has, and the per-stage limits raised to the adapter's (see "Limits").
- **Hooks** (instead of wrapping exports): `host.onFence(n)`, `host.onImage(window, index, what)` (0 queued, 1 shown),
  `host.onDeviceLost(info)`, `host.onDeviceRestored(texturesGone)`, `host.onShaderVariant(key, classes)`.
  `host.fence(n)` is a promise for fence `n` (null when it is done). An embedder that runs the recorder with no device
  signals through `host.signalFence(n)` / `host.imageEvent(w, i, what)` itself, and the hooks and promises work the same.
- Fences: a number in submission order. Fence `n` is done when the GPU has finished everything submitted before it
  **and every read-back issued before it (texture or storage buffer) has landed in guest memory**. `gfx_fence_done(n)`,
  `gfx_fence_word()` (address of a u64: the highest fence done), `gfx_fence_last()`, `gfx_sync_fence(sync)`.
- **`nvnSyncWait(sync, timeoutNs)`** never blocks. The recorder's answer and what the embedder does:

  | State at the call | x0 | `gfx_wait_fence()` | Embedder |
  |---|---|---|---|
  | never fenced | 2 TIMEOUT_EXPIRED | 0 | returns 2 (as nxnative) |
  | fence done | 0 ALREADY_SIGNALED (1 CONDITION_SATISFIED when an earlier call of this wait parked) | 0 | returns it |
  | fence pending, timeout 0 | 2 | 0 | returns 2 |
  | fence pending, timeout ≠ 0 | 2, the sync is now `Parked` | n | parks the thread on `host.fence(n)`; **finite**: also on its own timer of `timeoutNs` guest nanoseconds; **infinite** (`~0`, anything it treats as forever): no timer |

  Woken by the fence, the embedder makes the call again (any timeout): 1. Woken by its timer, it makes the call again
  **with timeout 0**: 2, and the sync is pending again (1 if the fence completed in between). A parked thread is never
  left on a dead device: on a loss every pending fence completes.
- **`nvnQueueFinish`** flushes and puts a fence behind everything; the call returns at once. The embedder parks the
  thread on `host.fence(gfx_finish_fence())`: everything submitted is then done and every read-back has landed.
- Device loss: `gfx_device_lost()`, `gfx_device_restored()`, `gfx_device_state()` (0 Live, 1 Lost) are the replayer's
  to call; the embedder supplies `requestDevice` (or calls `host.restore(device)`).
- Shader library: `host.registerShader(keyHex, info)`, `info` = the shader chain's reflection record plus `wgsl`
  (below). Frame capture: `host.captureFrame()` (below).
- **A key's state** (machine `gfx_shader`: Unknown, Pending, Failed, Ready): `host.shaderPending(keyHex, "pending" |
  "failed" | "forget")` (`gfx_shader_pending`) tells the recorder that the embedder is fetching or translating a key,
  or could not get it and has said so itself: its draws are then skipped without the recorder's "not in the shader
  map" line. Registering a key that is registered already replaces its record and requests every pipeline built from
  it again (`gfx_pipeline` Reset; the replayer drops its pipeline and module, and a completion of the old one is ignored).
- **`host.dispose()`** destroys every texture and buffer the replayer made (it keeps the set itself: all are created
  through `newTexture` / `newBuffer`), drops pipelines, bind groups and modules, resolves whoever waits on a fence and
  ignores completions still under way. `host.liveObjects` is the count. Nothing may be executed afterwards.

## Records: where they match nxnative and where they depart

Matches, byte for byte (checked against `nvn_obj.h` compiled by gcc, see below): `{u32 op, u32 size}` headers, the op
numbers, every payload layout, the texture snapshots behind records that name textures, records cut to what they use
(draws without the indirect fields, state binds with only the state's bytes, single binds in 24 bytes), 16 bytes kept
for a JUMP after every record but the END, no BEGIN record, CALL = CopyCommands, copy strides as command buffer state.
Object layouts and sizes likewise, including the bit-fields of the state objects and the sampler state from byte 8.

Departs:
- **`cmd_t`**: the `recording` word is unused; the state is a `gfx_cmdbuf` instance at +112 (object 128 bytes, NVN reserves 160).
  A command outside a recording is refused (red) and not written; nxnative writes it, where no handle owns it.
- **`sync_t`**: `{magic, gfx_sync instance}` (24 bytes) instead of `{magic, fenced, fence}`. A wait with a timeout that
  must park is a state (`Parked`), so that the call made again after the park answers CONDITION_SATISFIED.
- **`win_t`**: four `gfx_image` instances where nxnative keeps its pacing clock and present tickets; same size.
- **Lowering** is new: nxnative replays records straight into Metal. Here the walk produces a second, flat stream
  (`hostops.ts`) so that the pass machine and every decision stay in AssemblyScript.
- **Shader key** is always computed at `ProgramSetShaders` (nxnative defers when the code is not yet in a pool).
- **Host-lent segments** come from an 8 MB arena inside linear memory (records hold pointers), not from malloc.
- **QueueFinish** flushes, issues a fence and returns; nothing blocks in a browser turn (the embedder waits on the
  fence). Acquire likewise takes the next image in turn even when it is still queued.
- **CopyBufferToTexture** into a texture whose storage holds its content is made in the storage at submit, not on the
  GPU (below). nxnative mirrors into the storage and copies on the GPU.
- **Compute**: `p_dispatch.caller` is not recorded (nothing here locates a dispatcher by call site).
- UpdateUniformBuffer / CopyBufferToBuffer are done on guest memory in stream order (the replayer is flushed first,
  then told to drop its uploads); they do not end the pass.
- One lowering state for all queues (nxnative: one per queue).

## The pass machine (`gfx_pass`)

WebGPU fixes attachments and load actions at pass begin, cannot clear inside a pass, rejects sampling an attachment,
and has compute passes as a pass kind of their own.

| NVN | Machine | Stream |
|---|---|---|
| SetRenderTargets | → TargetsSet (same targets while Open: nothing) | ends the pass; pending clears land in a pass of their own |
| Clear, whole target, all channels | → ClearPending | becomes the load action; in a pass, the pass ends first |
| Clear, scissored or masked | → Open | `H_CLEAR_RECT`: a triangle inside the pass |
| Draw | → Open | `H_BEGIN_PASS` with the pending clears, then only the state that changed |
| Draw that samples one of its targets | Feedback → TargetsSet, then Draw | `H_SNAPSHOT` (copy), reopen with load, sample the copy; later draws of that pass reuse it |
| DispatchCompute(Indirect) | → Compute (ComputeUnset before any targets) | the render pass ends (pending clears land first), `H_BEGIN_COMPUTE`; consecutive dispatches share the compute pass; a draw after it reopens the render pass with load |
| Texture copy, Downsample, fence, present, non-zero Barrier; a copy into or out of a current target | Break | ends the pass |
| End of QueueSubmitCommands | Submit | ends the pass, `H_FLUSH` |

A pass that ends (either kind) is followed by `H_BUF_READBACK` for each storage range its shaders write: the bytes go
back to guest memory when the GPU is done (fences wait for it), and until then the replayer serves binds inside such
a range (storage, vertex, index, uniform at a 256-byte offset) from the GPU's copy. A written range whose guest
bytes changed since the GPU's copy was made is uploaded again (the game wrote new input).

Pipelines (`gfx_pipeline`): key = shaders + vertex layout + the class of each bound attribute format + blend,
depth-stencil and raster state (with depth clamp) + target formats; a compute pipeline's key is its shader. First
use → `Building`: the replayer starts `create…PipelineAsync` and builds synchronously for the draw that needs it
now; `Ready` or `Failed` comes back through `gfx_pipeline_done`. Draws of a failed pipeline are skipped (red once).
A shader key missing from the library: `[RED] shader <key> is not in the shader map` once, its draws skipped.
A render target view whose format is not the texture's or its sRGB twin is rendered in the texture's own format, in
the key and in the attachment alike (red once). Multisampled targets have 4 samples whatever NVN asked (2, 8 and 16:
red once); `nvnCommandBufferDownsample` is a pass with a resolve target for colour and a draw of sample 0 for depth.

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
| GpuOwned | nothing. Entered when a pass, a copy or a clear writes the texture; left only when the game flushes new content over it and its profile has `tex_flush_upload` (below) |

Measured (100 textures 64×64 RGBA8 with 7 levels, all bound every frame, SwiftShader machine): first submission
14–19 ms for 2.1 MB deswizzled and uploaded; afterwards the checks cost about 0.3–0.5 µs a texture, 30–50 µs a frame.

Failure modes, accepted: a CPU write that touches no probed byte and is not flushed shows up to 60 submissions late
(later if more than 1 MB of textures are due at once); a CPU write into a `GpuOwned` texture's storage is never seen;
a texture changed while a submission that already used it is lowered keeps the old content for that submission.
A flush is remembered only until the next submission and for 16 ranges (more: every texture used in that submission
is hashed in full). The two profile keys below close the first two for the games that need it.

### Textures the CPU keeps writing (`texwatch.ts`; profile keys `tex_flush_upload`, `tex_dirty_upload`)

nxnative's textures are the GPU's alone unless something says the CPU fills them; here every texture is uploaded
from its storage at its first use, so the two keys mean less than in nxnative, and exactly this:

**Registered textures.** With `tex_flush_upload`, a texture is registered when it is made if it can hold what the CPU
writes in place, by nxnative's rule (`hle_nvn.c ft_add`): storage in a pool that is neither `CPU_NO_ACCESS` nor
virtual, block-linear (not `LINEAR` / `LINEAR_RENDER_TARGET`), no packaged layout, not a buffer texture. Up to 16,384
at a time, kept sorted by address (more: red once, the others behave as without the key).

**`tex_flush_upload`: a pool flush publishes.** `nvnMemoryPoolFlushMappedRange` / `nvnBufferFlushMappedRange` over
any part of a registered texture's storage marks that texture, found by a binary search, and the mark stays until
the texture is next used, however many submissions and flushes later:

| State at that use | What happens |
|---|---|
| Uploaded | full hash; different from the upload's → uploaded again |
| GpuOwned | the storage is hashed and compared with **what it held when the GPU took the texture over** (kept at that moment, once a texture). Different: the CPU wrote, its content replaces the GPU's (`CpuWrite` → Unknown → upload: the one way out of `GpuOwned`). The same: the flush was about a neighbour, the GPU's content stays |
| GpuOwned, and the use is another GPU write | the same test; when the CPU wrote, its texels are uploaded first, then the GPU writes (a scissored clear or a draw keeps what it does not cover) |

A registered texture is no longer hashed because some other range was flushed. Departs from nxnative: there a
flush makes a registered texture "CPU-written" whatever the GPU did to it, and later GPU copies into it are also
written into its storage; here the GPU's content is only replaced when the storage really changed, and a GPU copy
into a `GpuOwned` texture does not reach its storage (so after one, a flush with a CPU write replaces all of it).

**`tex_dirty_upload`: no flush at all** (it needs the first key, as in nxnative). nxnative write-protects the pages
of registered textures and looks at the faults (`nvn_ft_written`, `nvn_ft_poll`). There is no page protection in a
WebAssembly memory. The two substitutes, and the choice:

| | A write barrier in translated code (a mark per guest store) | Hashing the storage |
|---|---|---|
| Sees | only stores the translator emits. `memcpy` and its relatives are take-overs that copy in the host (`src/hle/libc.ts`), `nn::fs` reads land in guest memory from the host, the kernel copies: each would have to mark too, or a texture a file is read into is missed | every writer |
| Costs | every guest store of every game, and every host writer instrumented | only registered textures of a game with the key |

Hashing, bounded: the full hash runs at **3.5–4.0 GB/s** (Node 22 and Chromium 153 on this machine, 64 KB to 128 MB),
and a **scanner** spends at most **4 MB a submission** on it, about **1 ms**. At a registered `Uploaded` texture's
first use in a submission, after the sampled hash found nothing: if the scanner is free or already on this texture,
the storage is hashed from where the scan stopped as far as the budget goes; when the scan reaches the end its
hash is compared with the upload's, and a difference uploads the texture again. One texture has the scanner at a
time; one that is not used in the next submission gives it up. So:

- registered textures in use under 4 MB together: a silent rewrite shows **at the next draw**;
- otherwise a round of the scanner takes `ceil(bytes in use / 4 MB)` submissions, and a rewrite is found within
  two rounds (a write behind the scanner's position waits for the next). Tears of the Kingdom's 42 MB texture
  arrays, which nxnative names for this key, would take 11 submissions a scan each;
- only `Uploaded` textures are scanned: one the GPU wrote stays the GPU's until a flush says otherwise, as nxnative
  leaves an uncompressed texture whose storage the GPU wrote. (nxnative does take a block-compressed one back
  without a flush; here a block-compressed texture becomes `GpuOwned` only as the destination of a texture copy.)

Measured in the scene (SwiftShader machine): 16 MB of registered textures drawn every frame, 4 MB hashed a
submission in 1.0–1.1 ms; a submission of three draws with the scan in it 1.3–2.1 ms (recorder and replayer); the
rewrite near the end of the second 8 MB texture found after 4 submissions; the submission that found it 13–20 ms
(8 MB deswizzled and uploaded). `gfx_tex_watch_stat(i)`: 0 textures taken back from the GPU, 1 KB scanned, 2 scans,
3 scans that found a rewrite, 4 textures published by a flush, 5 registered, 6 bytes scanned in the last submission.

**Staged** (a fourth state): `CopyBufferToTexture` and `WriteTexels` into a texture that is not `GpuOwned` write the
texels into its block-linear storage in stream order (what a later ReadTexels, CopyTextureToBuffer or upload sees),
and the next use uploads; no GPU copy is made, so a game that fills a texture level by level at load uploads it once.
If the submission already used the texture, what was encoded so far is submitted first, so earlier draws keep the
old texels. A Staged texture that becomes a target or a copy destination is uploaded before the GPU writes it.

**Formats WebGPU cannot be given directly** are converted row by row on upload (`fmt.ts`, `texcontent.ts send`):

| Guest format | Host texture | How |
|---|---|---|
| DEPTH16, DEPTH24, DEPTH32F, DEPTH24_STENCIL8, DEPTH32F_STENCIL8, STENCIL8 | the same depth format | depth as f32 rows, drawn into the depth attachment (WebGPU writes depth32float and depth24plus no other way); stencil as bytes into the stencil aspect. D24: depth in the upper 24 bits, stencil in the low 8; D32F_S8: a float, then a word with the stencil in its low byte (assumed from the hardware's formats, not checked against a console) |
| RGBA4, RGB5, RGB5A1, RGB565, BGR565, BGR5, BGR5A1, A1BGR5 | rgba8unorm | unpacked; red at bit 0 in guest memory for the RGB ones, as nxnative reads them |
| R16, RG16, RGBA16 and their SN forms | the 16-bit normalized format with `texture-formats-tier1`, else r16float / rg16float / rgba16float | to half floats (11 significant bits: a loss, noted) |
| ASTC 4x4 … 12x12, linear and sRGB | the ASTC format with `texture-compression-astc`, else rgba8unorm(-srgb) | decoded on the CPU (`astc.ts`) |

**ASTC** (`astc.ts`, about 340 lines, written from the specification): 2D blocks, LDR, all 14 block sizes, 1–4 partitions,
dual plane, void extent; the 8-bit result is the top byte of the 16-bit interpolation (the `decode_unorm8` mode), sRGB
endpoints expanded with 0x80. An illegal block is opaque magenta, as are the texels of a partition with an HDR
endpoint mode. Measured in Node on this machine: 10–28 million texels a second (4x4 to 12x12), so a 2048×2048 texture
takes about 0.2–0.4 s once.

`WriteTexels` writes into the storage (next use uploads) or, for a `GpuOwned` texture, straight to the GPU.
`ReadTexels` reads the storage; of a `GpuOwned` texture it is red and writes nothing (WebGPU readback is asynchronous).
`CopyTextureToBuffer` is a CPU copy in stream order when the storage holds the content; otherwise a GPU readback that
lands in guest memory later, and fences issued after it complete only once it has landed (`GfxHost.landed()`).

## What a game's profile switches on (`profile.ts`, `gfx_set_profile`)

nxnative keeps a few mechanisms off unless a game's profile asks for them, because each changes what a game sees
and is right only for games checked with it. The same keys, converted by `tools/prepare/convert_profiles.py`, reach
the recorder as bits (`src/glue/rt_process.ts gfxSettingsFor`, `RtGfx`'s `profile` option): 1 `render_cond on`,
2 `tex_flush_upload on`, 4 `tex_dirty_upload on`, 8 `gpu_timestamps segment`, 16 `present_interval display`.
With no bit set the module behaves as before.

## Counter reports and conditional rendering (`report.ts`, machine `gfx_render_enable`)

`nvnCommandBufferReportCounter(type, address)` makes the GPU write a 16-byte record `{ u64 counter, u64 timestamp }`
when it reaches the command; the timestamp is in ticks of 614.4 MHz on the guest clock (nxnative `nvn_timestamp.h`,
384 ticks per 625 ns, exact in both directions). The recorder cannot write it when it lowers the command, so each
report gets an id and goes into the host stream (`H_REPORT`); at the end of a submission `H_REPORT_COMMIT` says that
the reports so far land together when the GPU has finished that piece of work. The replayer then calls
`gfx_report_land(id, start, end, done)` and the recorder writes guest memory. **A fence issued after a report waits
for it**, like a read-back. An embedder with no device calls `gfx_reports_flush(now)`.

| Counter | Record |
|---|---|
| `TIMESTAMP` (0), `TIMESTAMP_TOP` (0x10) | timestamp; the counter field is the timestamp too, as nxnative writes it, and **0 with `render_cond`** (as the hardware) |
| any other but `SAMPLES_PASSED` | counter 0 and the timestamp (nxnative's placeholder: nothing is counted) |
| `SAMPLES_PASSED` (1) | **not written**, red once: occlusion queries are not counted (WebGPU's are a yes / no, not a count) |

`nvnDeviceGetTimestampInNanoseconds(record)` converts a record's timestamp;
`nvnDeviceGetCurrentTimestampInNanoseconds` answers what the embedder last gave `gfx_set_now` (the runtime gives the
guest clock before the call).

**Which time a report takes** (profile key `gpu_timestamps`; nxnative `nvn_mtl.m rep_ticks`). On the hardware a
report is written when the GPU reaches it, so two reports of one submission bracket the GPU work between them. A
host that writes them all when the submission is done gives them one time, and a game that measures its GPU time
as their difference reads 0 (nxnative: Breath of the Wild's frame-interval controller and dynamic resolution).

| `gpu_timestamps` | A report's timestamp |
|---|---|
| `submission` (the default) | when the submission's last segment was done: one time for all its reports |
| `segment` | `TIMESTAMP_TOP`: the GPU start of the segment the report lies in; any other type: its GPU end |

A **segment** is what the replayer hands to the GPU in one piece (one `queue.submit`). In `segment` mode the
lowering cuts a submission the way nxnative's `sub_cut` does: at a render target change, once 64 draws were made
since the last cut (`H_FLUSH`; nxnative cuts for every game, to keep the GPU busy while it translates; here only for
this key, so other games' streams are what they were). All reports of a submission still land together, when its
last segment is done, so a game that waits for the fence reads them together.

Where a segment's times come from (`GfxHost.timestampSource`, shown on the page's Graphics row as "GPU times"):

| Source | Start of a segment | End of a segment |
|---|---|---|
| `gpu`: the WebGPU feature `timestamp-query` (asked for when the adapter has it) | the stamp at the start of its first render pass | the stamp at the end of its last render pass |
| `cpu`: no such feature, or a segment with no render pass, or `timestampQuery: false` | when it was handed over, or when the segment before it was done if that was later | when the GPU reported it done (`onSubmittedWorkDone`) |

The GPU's clock has no known relation to the guest clock (WebGPU has no paired sample, as Metal has), so the stamps
of a submission are placed on the guest clock by taking the last segment's end as the moment its completion was
reported: differences between reports of one submission are the GPU's own, their absolute place is late by the
event loop's delay. Browsers quantise timestamp queries (100 µs in Chromium unless a developer flag is set). The
`cpu` estimate depends on when the browser runs completion callbacks: it is an upper bound of each segment's end
and is as coarse as the event loop (a frame, when the page is busy). One submission's reports all take one source.
Compute passes are not stamped. Measured in the scene (SwiftShader, `timestamp-query`): a frame of 71 draws reads
5.8 ms of GPU time, 5.7 ms of it in the first segment's 70 draws.

**Conditional rendering** (profile key `render_cond`; nxnative `nvn_mtl.m OP_RENDER_COND`, `rc_value`). Without the
key `SetRenderEnable(false)` and `SetRenderEnableConditional` record nothing and say once, red, that the host draws
anyway: a game that only saves GPU time with them is right either way. With the key each becomes an `OP_RENDER_COND`
record (nxnative's layout) that the lowering evaluates **on the CPU, from guest memory, at its place in the stream**:
`SetRenderEnableConditional(mode, a)` draws when the 64-bit counters at `a` and `a + 16` are equal (mode 0) or
differ (mode 1). While the state is `Skipping`, `ClearColor`, `ClearDepthStencil`, and draws are dropped; state
changes, copies and compute dispatches are not. The state is queue state and lasts across submissions.

What a counter reads at lowering time, in this order:

1. a record a counter that is not counted here ever wrote (`SAMPLES_PASSED` and the placeholders): **unknown**;
2. a timestamp report still on its way to that address: **the 0 it will write**, whatever the CPU put there
   meanwhile (the GPU would overwrite it);
3. guest memory.

A condition with an unknown operand **draws**: only an evaluated condition is a reason to skip (nxnative found that
skipping unknown blocks whitens a scene for good). `UpdateUniformBuffer` and `CopyBufferToBuffer` are made in stream
order; one that covers a record whose report is on its way is the later writer, so the report then lands only the
fields the write left alone.

Departs from nxnative: no occlusion counts (its `SAMPLES_PASSED` reports are real and a condition on a landed one is
evaluated; here such a condition always draws, which costs GPU time and is otherwise right); no tracking of counters
written by shaders (storage buffer writes over a record: nxnative's GPU epochs).

## Frame pacing (`window.ts presentInterval`, `src/glue/rt_gfx.ts`)

On the Switch the next `nvnWindowAcquireTexture` is held for as many vertical syncs (1/60 s) as the window's present
interval, and a game whose logic counts frames relies on it. The recorder answers how many
(`gfx_present_interval(window)`; nxnative `hle_nvn.c present_itv`), the runtime holds the acquire:

| | Vsyncs a frame | `nvnWindowGetPresentInterval` answers |
|---|---|---|
| default (nxnative's interval mode `game`) | the game's own interval; 0 counts as 1 | the game's own |
| profile `present_interval display` | 1, whatever the game set | 1 (nxnative `window_interval`: a game that paces itself by what it reads back would otherwise hold itself to its own interval) |
| a present cap, `gfx_set_present_cap(30 \| 60)` | 60 / cap, in either mode | as above; in display mode the cap's interval |

The acquire (`rt_gfx.ts`): on the deterministic clock the thread wakes at exactly `interval` vsyncs of guest time after
the previous acquire, once the GPU has finished the previous present. On the wall clock with the display's frames
(the page's `requestAnimationFrame`) it wakes at the first display frame at or after that slot (within a quarter of
a vsync); slots are counted from the previous slot, so a 120 Hz screen shows a 60 Hz game on every second frame and
a 144 Hz screen keeps 60 frames a second on average (nxnative's virtual 60 Hz ticks), and a game more than a frame
late starts a new schedule instead of catching up in a burst. Before this the page showed one frame for every
display frame whatever the interval: a 30 fps game ran at the display's rate.

**The cap has no caller yet.** nxnative takes the profile's `fps_target` as the present cap only while the host
also writes that rate into the game's own frame limiter (`hle_fpslock.c`) or steps the game through its frame-step
stubs: a game presented at a rate it does not step by runs fast or slow. Neither is ported
(`docs/PORTING-STATUS.md`, "Frame rate"), so `fps_target`, `fps_max` and `fps_hold` stay listed for their games.

## Window origin, depth mode, and what the shader chain must emit

nxnative (Metal): lower-left origin = negative-height viewport, reversed winding, present flipped; depth mode = a
second vertex entry point. WebGPU has no negative viewport, so the split here is:

- **Recorder / replayer**: with a lower-left origin targets are stored bottom-up (row 0 = bottom, as GL). Viewport and
  scissor rectangles are used as given; front face is inverted in the pipeline key; present flips the blit. Before
  each pass's draws the replayer gets `H_FIXUP = (1, ysign, zscale, zoffset)`: `ysign` −1 for lower-left, else 1;
  `(zscale, zoffset)` = (0.5, 0.5) for NEAR_IS_MINUS_W, (1, 0) for NEAR_IS_ZERO.
- **A translated WGSL module** comes with the chain's reflection record (`src/shaders/library.ts` `Reflection`), which
  `registerShader` consumes in full. `st` = 0 vertex, 1 fragment, 2 compute:

  | Record | WGSL binding | What the host does |
  |---|---|---|
  | `ubos: [i]`, `uboSize: { i: bytes }` | `@group(0) @binding(st*16 + i)` | binds exactly `uboSize[i]` bytes (16 up): the game's bytes up to the size it bound, **zero past it**. Without `uboSize` the bound size is used |
  | `extra: [{ kind: "support" }]` (or `support: true`) | `@group(0) @binding(st*16 + 14)` | Ryujinx's support buffer, 1392 bytes, std140: `viewport_inverse` (2/w, 2/h, 1, 0) at 144, `viewport_size` (w, h, 1, 1) at 160, `render_scale[73]` all 1 from 192, the rest 0 (nothing is BGRA-swapped, no alpha test, no transform feedback); follows the viewport |
  | `textures: [{ slot, dim, depth, sampleType? }]` | texture `@group(1) @binding(st*64 + 2*slot)`, sampler `+1` | `dim` 2d, 2d-array, cube, 3d, cube-array; `depth` → `texture_depth_*` with a comparison sampler (the game's compare function, LEQUAL when it set none); `sampleType` sint / uint / unfilterable-float → a non-filtering sampler |
  | `textures: [{ slot, …, handle: { ubo, offset, sampler? } }]` | the same binding of `slot` | a **bindless** slot: the recorder reads the handle from uniform data at each draw ("Bindless textures"); `BindTexture` on that slot is ignored |
  | `storage: [{ slot, write }]` | `@group(0) @binding(128 + st*16 + slot)`, `var<storage, read>` or `read_write` | the range of `nvnCommandBufferBindStorageBuffer`; written ranges are read back (above) |
  | `images: [{ slot, format, access, dim }]` | `@group(1) @binding(256 + st*8 + slot)`, `texture_storage_*` | the texture of `nvnCommandBufferBindImage`, one level; the texture becomes GPU-owned when written |
  | `attributes: [l]`, `attributeTypes: { l: float \| sint \| uint }`, `variants` / `variant()` | `@location(l)` = NVN attribute `l` | see "Vertex input classes" |
  | `outputs: [i]` (fragment) | `@location(i)` = colour target `i` | targets the shader does not write get write mask 0 |
  | `fixup: true` (vertex) | `struct NxFix { fix: vec4f }` at `@group(2) @binding(0)` | last thing before returning the position: `pos.y *= nx.fix.y; pos.z = pos.z * nx.fix.z + pos.w * nx.fix.w` |
  | `drawParams: true` (vertex) | `struct { bv: i32, bi: i32, di: i32 }` at `@group(2) @binding(2)`, a dynamic offset | the draw's base vertex (first vertex of a non-indexed draw), base instance and draw index (a multi-draw's record number, else 0): SPIR-V BaseVertex / BaseInstance / DrawIndex, which WGSL has no builtin for (nxnative: c0 + 0x640 / 0x644 / 0x648). The host writes them per draw (gfx_host.ts setDrawParams) |

  Any other `extra` kind (c1, driver segments) is refused at registration with a red line: the key then reads as
  missing and its draws are skipped. Fragment coordinates need no fix-up (the chain's README argues it; the support
  buffer gives render scale 1). Alpha test, when ported, needs the fragment stage to discard against the support
  buffer's `alpha_test`, which is 0 today.

### Vertex input classes

WebGPU puts the class of a vertex input (float, sint, uint) in the shader text and requires the bound format to
match; in NVN the format is state. The recorder puts the class of every bound attribute format in the pipeline key
and compares it with `attributeTypes`. Equal (or no `attributeTypes`): the module as registered. Different: the key
says "variant", and the replayer needs another module for that shader: `info.variants["0:float,1:uint"]` (every
location read, ascending), or `info.variant(classes)`, or the embedder's `host.onShaderVariant(key, classes)` (the
chain translating on demand). With none: one red line naming the key, the bound and the declared classes (the
**request to the shader chain**), the pipeline is `Failed`, its draws are skipped. NVN's `*_UI2F` / `*_I2F` formats
(integers converted to float by the fetch) have no WebGPU vertex format at all: red, the pipeline fails.

### Limits

nxnative has no such limits to meet: every binding of a shader is an entry of a Metal argument buffer (`nvn_refl.h`
`NVN_REFL_MAXARG` 768 a shader), so a stage binds as many buffers and textures as NVN allows. WebGPU counts them a
stage. What is done here, in this order:

1. `GfxHost.deviceDescriptor(adapter)` asks for the adapter's own limits (`requiredLimits` = `adapter.limits` for
   the per-stage binding counts, `maxBindGroups`, `maxBindGroupsPlusVertexBuffers`, `maxBindingsPerBindGroup`,
   dynamic uniform offsets, vertex attributes and buffers, buffer and binding sizes, texture sizes). WebGPU grants
   the defaults unless asked.
2. A pipeline's bind group layouts hold only what its shaders' reflection lists (`groupLayouts`): a uniform block,
   texture, storage buffer or image a stage does not use is not bound and does not count, whatever the game bound.
3. A pipeline that still needs more than the device has is refused by the replayer before WebGPU sees it
   (`overLimits`): one red line a limit with the stage, the shader's key, the count, the device's number, the
   WebGPU limit's name and the excess,
   `[RED] pipeline 653: the fragment shader 1f… needs 13 uniform buffers; this WebGPU device allows 12 a stage
   (maxUniformBuffersPerShaderStage): 1 over. The pipeline cannot be built, its draws are skipped`. The pipeline is
   `Failed` and its draws are skipped; no WebGPU validation error is raised. Checked: uniform buffers (game slots +
   support buffer + the vertex fix-up), sampled textures, samplers, storage buffers, storage textures, vertex
   attributes, bind groups (2, or 3 with the fix-up or the draw parameters).

`GfxHostOptions.limits` (name → value) lowers the limits as the replayer sees them: the tests use it, and it shows
what a smaller device would refuse.

WebGPU's defaults against what a stage may declare (14 uniform blocks + support buffer + fix-up, 32 textures, 16
storage buffers, 8 images):

| Limit | Default | SwiftShader here (Chromium 153) | Needed at most |
|---|---|---|---|
| maxUniformBuffersPerShaderStage | 12 | 12 | 16 (vertex), 15 |
| maxSampledTexturesPerShaderStage, maxSamplersPerShaderStage | 16, 16 | 16, 16 | 32 |
| maxStorageBuffersPerShaderStage | 8 | 10 | 16 |
| maxStorageTexturesPerShaderStage | 4 | 4 | 8 |
| maxDynamicUniformBuffersPerPipelineLayout | 8 | 8 | 31: the ones beyond the limit are bound at fixed offsets (works, costs a bind group a draw) |
| maxVertexAttributes, maxVertexBuffers | 16, 8 | 16, 8 | 16, 16 |
| maxBindGroups | 4 | 4 | 3 |

Only SwiftShader was measured, and it grants no more than the defaults for uniform buffers, textures and samplers:
**a stage that uses 13 or more uniform buffers or 17 or more textures has never drawn here**; on this adapter it
takes the red line above (the scene for it draws where a device allows the counts and checks the line where it does
not). What other adapters report is not known here. Making such a stage fit a device at the defaults is not done:
it needs the shader chain to change the module (several uniform blocks behind one binding; nothing in WebGPU's core
puts several textures behind one binding), see the requests at the end.

### Bindless textures

NVN lets a shader sample through a handle (texture ID | sampler ID << 20, IDs of the texture and sampler pools set
with `nvnCommandBufferSetTexturePool` / `SetSamplerPool`) that the game keeps in its own uniform data instead of
binding it to a slot. nxnative (`nvn_mtl.m` `ubo_handle`, `ubo_tex_id`, `ubo_samp_id`; reflection kinds `tex_ubo` /
`samp_ubo` of `dmsh_abi.h`): the translator traces each such handle to a word of a uniform slot, the shader keeps an
ordinary texture and sampler argument, and at each draw the host reads the word from the bound uniform memory, adds
the bases of the pools then set, and puts that texture and sampler into the argument buffer. That maps to WebGPU
as it is, and is what is ported:

- The reflection marks a texture slot with `handle: { ubo, offset, sampler? }` (record `RF_bl`, `RF_blh` in
  `shader.ts`): the handle is the u32 at byte `offset` of uniform slot `ubo` of the same stage. `sampler: { ubo,
  offset }`: a second word ORed into it (handle type 1: the texture in one word, the sampler in the other, either
  order); `sampler: { id }`: the sampler is a constant ID of the shader (type 3; no pool base, as nxnative's `SAMPI`).
- `lower.ts` `slotHandle` resolves it when the draw or dispatch is lowered. Guest memory then holds what the GPU
  would read at that place of the stream: `UpdateUniformBuffer` and `CopyBufferToBuffer` are made in stream order.
  The result is an ordinary texture binding record (`H_TEX`): the replayer knows nothing of it. The uniform slot
  need not be one the shader reads as a block.
- Handles are looked at again whenever uniform bindings or uniform memory changed (`D_UBO`), a pool was set, or
  textures were bound. A handle that names a target of the open pass takes the pass machine's `Feedback` path like a
  bound one (the target is copied, the copy sampled). The handles are not part of the pipeline key.
- A uniform slot that is not bound, or bound shorter than the word, gives handle 0: no texture (the slot reads
  transparent black), red once.

**Not supported** (each is refused by the shader chain by name, so its key reads as missing; nothing is faked):

- **Arrays of handles indexed at run time** (`tex_htab` / `samp_htab`: element k = the handle at `off + 8k` of a
  uniform slot; `tex_c2a`: a run of the driver table) and **whole pools indexed by ID** (`tex_pool` / `samp_pool`,
  what nxnative's `pool_arrays` builds for a handle the translator could trace to no word). Both need an array of
  textures behind one binding with an index only the GPU knows. WebGPU's core has no binding arrays; with them the
  size would still be bounded by the per-stage texture limit (16 by default) where nxnative's tables hold hundreds.
- A bindless texture whose sampler is a separate sampler of the driver table (type 1 with the sampler word in
  `c2`): there are no separate samplers here yet.
- Bindless images and buffer textures (`img_ubo`, `tbuf_ubo`), storage buffer addresses kept in uniform data
  (`sbuf_ubo`).
- A handle word that a compute shader wrote in the same submission: the read-back lands in guest memory after the
  submission was lowered, so the draw sees the old word (nxnative reads the current value and says so red; here
  nothing notices).

## Uploads and bind groups (replayer)

**Uniform data** goes through one large buffer (`uniformArena`, the default): every range a draw or dispatch binds is
copied into a staging array at a 256-byte-aligned slot (only the bytes the shader's block covers, zero past what the
game bound), the array is written to its GPU buffer once at the flush (1 MB chunks), and group 0 is bound with dynamic
offsets: one bind group serves every draw of a pipeline, with no GPU buffer and no hash per range. A range bound again
while guest memory cannot have changed reuses its slot (a camera block shared by 1000 draws is copied once).

Measured, 1000 draws each with its own two uniform ranges, median ms a submission (recorder + replayer, SwiftShader
machine, three runs of the scene; the numbers move by ±1 ms between runs):

| | nothing changed | 100 ranges changed | 1000 changed | |
|---|---|---|---|---|
| a buffer a range, all written every submission (the first implementation) | 6.6–7.5 | 5.4–6.8 | 5.8–5.9 | 2002 buffer writes, 1000 bind groups |
| a buffer a range, hashed (before; `uniformArena: false`) | 2.2–2.5 | 2.4–3.6 | 2.5–3.3 | 2002 hashes, a buffer write a changed range |
| one buffer, dynamic offsets (now) | 2.1–3.4 | 2.0–2.3 | 2.0–2.1 | 2 hashes, 1 write of 500 KB |
| ranges bound 4096 bytes long, hashed | 4.3–4.9 | 7.4–8.7 | 8.1–8.8 | 7.8 MB hashed a submission |
| ranges bound 4096 bytes long, one buffer | 2.1–2.2 | 2.0–2.1 | 2.2–3.1 | 1 write of 500 KB |

So: the per-range hash is gone and the cost no longer depends on how much changed or how long the game binds its
ranges; for small ranges that never change the gain is within the noise (the first version of the arena was slower
than the hashed path there, until slots were keyed by number and the bind group kept with the pipeline).

**Vertex and index data** keep a GPU buffer a bound range across submissions. At its first use after guest memory may
have changed (new submission, `H_MEM_DIRTY`, a read-back landing) the recorder hashes its bytes (`gfx_hash`, the whole
range: vertex data cannot be sampled safely) and the buffer is written only when the hash differs; a range that
changed while commands not yet submitted still reference its buffer gets another buffer. Bind groups of textures are
cached by the views and samplers they bind.

Loops, fans, quads, quad strips and polygons are drawn through a 32-bit index buffer the replayer builds and keeps
(by primitive, range or index hash). Indirect draws, indirect dispatches and indirect-count multi-draws read their
arguments from guest memory at submit and become direct ones (a count the GPU writes in the same submission is not
supported).

## Device loss (`gfx_device`, `device.ts`)

`GPUDevice.lost` → the replayer logs red, calls `gfx_device_lost` (Live → Lost), completes every pending fence (no
guest thread waits on a dead device), calls `onDeviceLost`, and asks the embedder for a new device (`requestDevice`).
Until it comes, submissions are lowered as usual and executed against the dead device, which accepts every call and
draws nothing. With the new device (`restore`): every GPU object is dropped; `gfx_device_restored` (Lost → Live)
sends every texture `Lost` (Uploaded → Unknown: uploaded again from guest memory at its next use; Staged stays;
GpuOwned stays and is empty) and every pipeline `Reset` (requested again from its key). What only the GPU held —
render targets, copy destinations, images — is gone until the game writes it again: one red line with the count.
Read-backs in flight at the loss never land (guest memory keeps its old bytes).

## Frame capture (`host.captureFrame({ png })`, `gfx_capture.ts`)

After nxnative's `DM_NVN_PASSDUMP`: the host stream from the call to the next present as text, one line an event
with a letter in front (`T` texture, `K` pipeline requested with its whole key decoded, `P` pass begin / end, `D`
draw or dispatch, `C` clear rectangle, `B` copy / resolve / snapshot / read-back, `U` texel upload, `F` fence / flush,
`M` memory changed, `S` present), bindings and state indented under their pass, shaders by key; and a PNG of every
render target of every pass, read back when the pass ends (colour formats of 8 bits, half and float, RGB10A2; depth16
and depth32float as grey). Returns `{ text, images: [{ name, pass, target, serial, width, height, format, png }], … }`.
A captured frame is slow (each pass is submitted and read) and otherwise unchanged. A game that is still loading may not present for minutes, so a capture stops after `maxRecords` host records (200,000 by default; its text ends with the reason) and dumps the targets of its first 64 passes; `host.capturing` tells whether one is running (the page answers a second F9 with that instead of an error). `npm run gfx:test` leaves an
example in `build/gfx/capture/`. Not mirrored from nxnative: the binary capture for replay (`nvn_capture.inc`); the
text names guest addresses, so a capture is for reading, not for replaying.

## Verified (`npm run gfx:test`, headless Chromium, WebGPU on SwiftShader; `npm run kit:test` for the tables)

19 Node tests and 55 browser scenes, about 387,000 checks.

- **Layout**: 268 offsets and sizes equal `nvn_obj.h` compiled by gcc (`test/gfx/layout_ref.c`), except the listed
  departures; all objects fit NVN's reserved sizes; state-object bit-fields; the size of 41 recorded commands through
  `GetCommandMemoryUsed`; texture storage size / alignment / level offsets equal `nvn_tex.c` over 420 shapes;
  `DeviceGetInteger` equals nxnative's table.
- **Recording**: handles, empty recording, BeginRecording re-entered, the callback (arguments, size asked, JUMP
  placement), callback that adds nothing and no callback (host-lent segment); all 743 names resolve, and `nvn_name`
  gives each back.
- **ABI**: `nvn_abi` against the 331 prototypes of nxnative's `nvn_protos.h` that are implemented (6 read floats, 4
  return one; two take a float they ignore); a float result read back through `args + 64`.
- **Deswizzler**: 18 textures (2D with mips, non-power-of-two, arrays, cubes, 3D, BC1/BC3/BC7, packaged layouts; 112
  levels and layers) laid out by an independent Python implementation (`test/gfx/swizzle_ref.py`: own layout, one byte
  at a time) come out identical and swizzle back identical; WriteTexels / ReadTexels regions over storage.
- **ASTC**: 119 images compressed and decoded by astcenc (`test/gfx/astc_ref.py`, the `astc-encoder-py` module; all 14
  block sizes, linear and sRGB, three encoder qualities, every partition count with and without a second plane, void
  extents) and 1536 blocks of random bytes: **178,000 texels, every one equal** (illegal blocks: the error colour
  here, NaN → 255 in astcenc's 8-bit output). In a scene: the decoded host texture equals astcenc byte for byte for
  10 textures, and 7 of them drawn next to the same texture on a device that has ASTC differ by at most 3 of 255.
  Without the Python module both print SKIPPED.
- **Scenes** (pixels read back with `copyTextureToBuffer`, expected values computed in the test): clear only;
  per-vertex colour; indexed textured quad nearest / linear; uniform animation + UpdateUniformBuffer + CopyBufferToBuffer;
  depth test on DEPTH32F / D24S8 / DEPTH16 with a scissored depth clear; blending; scissored and masked clears in a pass;
  full clear mid-pass; render to texture; self-sampling draw; CALL; buffer→texture, texture→texture (also scaled), mips
  and array layers; BC1/2/3/4/5/7; RGBA8, sRGB, BGRA8, R8, RG8, RGBA16F, RGB10A2, R11G11B10F as targets; missing key;
  command memory exhaustion; pipeline cache and failure; fences, syncs, window images; pool-backed textures uploaded
  and compared level by level; the content-tracking heuristics including their blind spot; WriteTexels;
  CopyTextureToBuffer on the CPU and from the GPU; 100 textures; both origin / depth conventions with culling;
  fans, quads, quad strips, polygons, line loops, indirect and multi-draws; two-sided stencil and polygon offset;
  sampler compare, lod clamp, anisotropy; an sRGB view. And, new:
  - the embedder interface: `nvnSyncWait` with timeout 0, finite (parked, then expired by the timer's call; parked,
    then woken) and infinite; `nvnQueueFinish`'s fence completing only after a read-back landed; the hooks;
  - the reflection record: a block of 80 bytes bound with 16 (the rest reads zero) and in full; the support buffer
    following two viewports;
  - vertex input classes: float and RGBA8UI layouts on one shader (variant), no variant (skipped, the request line,
    `Failed`), the embedder's hook;
  - limits: a fragment stage with as many uniform blocks as the device allows (8 dynamic + 4 fixed offsets on
    SwiftShader) draws their sum; one more fails with the numbers and no WebGPU error; with the limits clamped
    (`limits`: 5 uniform buffers, 4 textures and samplers a stage) stages at the limits draw their sums and stages 2
    over fail with three lines naming `maxUniformBuffersPerShaderStage`, `maxSampledTexturesPerShaderStage`,
    `maxSamplersPerShaderStage` and "2 over"; clamped to 2 bind groups, the fix-up's third group fails by name; a
    stage with 14 uniform blocks and one with 17 textures on the device as it is (**on SwiftShader both take the red
    line; the drawing branch of that scene has never run**);
  - bindless: handles in a uniform slot the shader does not read (one word; texture word + sampler word in another
    slot; a constant sampler ID against the word's own), rewritten in memory between frames and by an inline update
    between two draws of one pass, IDs of a second texture pool (its base), a handle naming the target of the pass
    (one snapshot, no WebGPU error), a slot bound shorter than the word (reads empty, one red line);
  - compute: a dispatch (clear pending) writes vertices into a storage buffer from a uniform and a read-only storage
    buffer, the next draw uses the range as its vertex buffer, the fence waits for the read-back and guest memory has
    the vertices; a storage image written before any pass and sampled; an indirect dispatch between two draws that
    reads one image's texture and stores another; a storage buffer read by a fragment shader;
  - multisampling: a 4-sample colour and depth target resolved by Downsample (edge pixels are quarter coverages,
    depth read back), 8 samples rendered with 4 (one red line); depth clamp on and off;
  - CopyBufferToTexture made in the storage (no pass break, ReadTexels sees it, a copy into a texture in use keeps
    the earlier draws' texels); DEPTH16 / DEPTH24 / DEPTH32F / D24S8 / D32FS8 from memory through a comparison sampler,
    read back where WebGPU allows, the stencil from memory kept when the texture becomes a target; seven packed
    16-bit formats and R16;
  - cube, 2D array, 3D and cube array textures sampled, every face / layer / slice; a render target view of a
    foreign format (red, rendered in the texture's format, no WebGPU error) and of the sRGB twin;
  - the uniform arena against the per-range paths (the table above), same pixels;
  - device loss: `device.destroy()`, a frame and a fence given to the dead device, the fence completing, a new
    device, the texture uploaded again and the same pipeline built again, same pixels;
  - frame capture: the text (matched line by line) and both PNGs, decoded by the browser and compared with the
    targets.
  - profile keys: `render_cond` (a disabled block; the clear-when-needed pattern with a timestamp report: memory
    before and after the report lands, a second condition while the report is on its way, the same without a
    report, `UpdateUniformBuffer` over a record on its way, a condition on an occlusion query's record, the state
    across submissions; a depth clear under a false condition before a pass with an `EQUAL` depth test, which draws
    everywhere with the key and nothing without it); `tex_flush_upload` (fill, flush, sample; rewrite one byte no
    probe sees, flush one byte, an unrelated submission, sample; 20 flushes beside the texture; a texture the GPU
    wrote flushed with and without a CPU write; published, then a scissored clear); `tex_dirty_upload` (a silent
    rewrite shown at the next draw; a texture outside the registered set; two 8 MB textures at 4 MB a submission;
    the scanner given up); `gpu_timestamps` (both modes with a stepped clock and exact values; with timestamp
    queries: order, anchor, a GPU time that is not 0);
- **Counter reports without a GPU** (`d_report.test.mts`, `e_present.test.mts`): record sizes; the tick conversion
  over long uptimes; which time each mode gives each report type and what a game computes from them (16 ms against
  0); the counter field with and without `render_cond`; an embedder landing them; more than 4096 on their way; the
  present interval and its readback in each mode and under a cap.
- **Machines**: every transition of the nine `gfx_*` tables is walked in `test/gfx/gfx.machine.test.mts`
  (`npm run kit:test`); the scenes themselves take 74 of the 111.
- **Demo**: `npm run gfx:demo`, `test/gfx/demo.html`; the test run saves `build/gfx/demo.png`.

## NVN functions

743 names: **338 implemented, 11 empty by design** (nxnative's list: debug groups, patch size, depth bounds, scratch
memory), **394 red stubs** (`[RED] nvnXxx unimplemented` once, return 0). nxnative implements 489.
Implemented / total by object: DeviceBuilder 3/3, Device 21/61, QueueBuilder 9/23, Queue 10/16, MemoryPoolBuilder 7/8,
MemoryPool 9/10, TexturePool 7/9, SamplerPool 8/9, BufferBuilder 6/7, Buffer 10/11, TextureBuilder 30/44, TextureView
11/14, Texture 21/31, SamplerBuilder 17/25, Sampler 10/15, Program 4/34, Sync 4/6, WindowBuilder 7/20, Window 9/18,
CommandBuffer 84/214, Blend 7/15, Color 5/7, ChannelMask 2/3, Multisample 7/26, Polygon 9/9, DepthStencil 11/13,
VertexAttrib 5/5, VertexStream 5/5, Event(Builder) 0/11, other (NVN2, debug, raw) 0/71. The exact set is the
`case F.` lines of `dispatch.ts`. Since the last count: the sampler getters (four return a float), TextureView
GetFormat / GetTarget, BindStorageBuffer(s), BindImage(s), DispatchCompute(Indirect), SetDepthClamp,
Downsample(TextureView); ReportCounter, ResetCounter, SetRenderEnable, SetRenderEnableConditional, DeviceGetTimestampInNanoseconds,
DeviceGetCurrentTimestampInNanoseconds.

## Gaps

- Texture content: sparse (virtual-pool) textures; three-channel formats (RGB8, RGB16F, RGB32F as textures: WebGPU has
  none); BC on a device without `texture-compression-bc` (not decoded); HDR ASTC and 3D ASTC blocks; multisampled
  storage; ReadTexels of GPU-written textures; the blind spots listed above. **A block-compressed texture whose size
  is not a multiple of its block** (BC, and ASTC on a device that has it) is created padded to whole blocks, as WebGPU
  demands: normalized coordinates then stretch by up to a block (ASTC decoded on the CPU is exact).
- Formats the host converts: copies between guest memory and the GPU's copy of such a texture (CopyBufferToTexture
  into, CopyTextureToBuffer out of a GPU-written RGB565 target and the like) are dropped, red once; 16-bit
  normalized textures lose precision as half floats without `texture-formats-tier1`.
- Compute and storage: a shader that samples a texture it also stores to (WebGPU refuses the dispatch); storage
  ranges that overlap without one containing the other keep separate GPU copies; a uniform range inside a
  GPU-written range must sit at a multiple of 256 bytes from its start; storage images only of WebGPU's storage
  formats and one level; storage written by a vertex or fragment stage is lowered but has no scene; atomics, buffer
  textures, `nvnCommandBufferClearBuffer` / `ClearTexture` are not there.
- Multisampling: sampling a multisampled texture in a shader (`texture_multisampled_2d`: the chain has no such
  binding either); the depth resolve takes sample 0, the stencil is not resolved; sample counts other than 4.
- Depth clamp needs the feature `depth-clip-control` (red once without it).
- Queues with an origin different from the device's.
- Bindless: arrays of handles and whole pools indexed at run time, and the other kinds listed under "Bindless
  textures". Per-stage limits: a stage over the device's limits does not draw ("Limits").
- Counters: only timestamps are real. `SAMPLES_PASSED` is not counted (its record is not written, a render condition
  on it draws); the other counters report 0; events (`SignalEvent`, `WaitForEvent`) are not there. Conditional
  rendering needs the profile's `render_cond`. A counter record a shader writes is not tracked.
- Adjacency and patch primitives; separate textures / samplers; transform feedback;
  tessellation and geometry shaders (a resource bound to their stages is kept, and a red line names the stage: WebGPU
  has neither, nxnative's compute emulation `dmsh_geometry.py` is not ported); indirect counts written by the GPU
  (but a mesh draw's, below).
- Mesh draws (`DrawMeshTasks`, `DrawMeshTasksIndirect`) are emulated: the task shader (if the mesh shader reads a
  payload) and the mesh shader run as compute passes (`src/shaders/meshstage.ts` wraps their compute WGSL), writing
  their outputs to one storage buffer, and a vertex shader made from the mesh shader's outputs pulls them in a
  `drawIndirect` whose count the GPU wrote; an indirect draw's `{count, first}` is read on the GPU. Not done: a mesh
  or task shader with shared memory of its own (refused at translation, as nxnative does), and a draw whose workgroups
  exceed the output buffer (cut, red once).
- One viewport and scissor (more is red once: WebGPU has one); stencil masks and reference of the front face for both
  (WebGPU has one of each); no logic op, alpha test, polygon mode line / point, advanced blend, primitive restart
  index. WebGPU has no border colour (clamp to edge is used) and no view swizzle (red once); a view can reinterpret
  only between a format and its sRGB twin. A viewport larger than its target is clipped (red once).
- Device loss: what only the GPU held is lost; frames between the loss and the new device are not drawn.
- Virtual (sparse) memory pools; acquire pacing waits for the kernel.

## Requests to other owners

- **Runtime**: all answered in `rt_gfx.ts` this round (src/runtime/README.md "Graphics"). The list was:
  `adapter.requestDevice(GfxHost.deviceDescriptor(adapter))`; `host.onFence` / `onImage` /
  `host.fence(n)` in place of the wrapped `gfx_fence_signal` (and `host.signalFence` from the null replayer);
  `gfx_wait_fence()` and the timeout-0 call for `nvnSyncWait`; `gfx_finish_fence()` for `nvnQueueFinish`;
  `nvn_abi_table()` to skip d0..d7 and to copy `args + 64` back for the four float results; `requestDevice` for
  device loss; `host.captureFrame()` behind a key or a URL switch.
- **Shader chain** (`tools/shaders`, `src/shaders`): place storage buffers at `@group(0) @binding(128 + st*16 + i)` and
  images at `@group(1) @binding(256 + st*8 + i)` and report them as `storage` / `images`; let `registerAll` pass
  compute entries and entries whose only `extra` is the support buffer; emit vertex input variants (`variants`, or
  translate on `onShaderVariant`) and, likewise, integer colour outputs; report `sampleType` for integer textures;
  for stages over 12 uniform blocks on devices at the default limits, several blocks behind one binding (the host
  would bind one buffer holding them at fixed places); for stages over 16 textures, and for handle arrays and pools,
  there is no plan that WebGPU's core allows.
