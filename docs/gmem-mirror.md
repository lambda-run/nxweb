# Global memory through loaded addresses: one mirrored storage buffer

The game's shaders read and write memory through 64-bit GPU addresses they load at run time (GPU-driven culling writes
indirect draw records this way; the movie network writes whole pictures). nxnative gives the translated shader a table
of every memory pool and a physical pointer (`GlobalToStorage.cs` `TryGenerateRawStorageOp`, `dmsh_abi.h`
`DMSH_GMEM_MAP_*`, `nvn_mtl.m` `gmem_map` / `gml_*`). WebGPU has no pointers and no shared memory, so nxweb keeps a
**mirror**: one storage buffer holding a copy of every guest range a shader may reach, and fills nxnative's table so
that "guest address + delta" is a byte offset into it. This note fixes the choices. Code: `src/shaders/spv.ts`
`globalMemory` (translator pass), `src/gfx/lower.ts` `emitGmem` (recorder), `src/glue/gfx_gmem.ts` (`GmemMap`: placement
and table) and `src/glue/gfx_host.ts` "the mirror of global memory" (replayer).

It replaces the earlier scheme (one read-only storage buffer per followed address, at most 8, loads only), which ran
into WebGPU's 8 to 10 storage buffers a stage and could not translate a store.

## Bindings of a module that uses the mirror

| group 0 binding | what | declared |
|---|---|---|
| `128 + stage*16 + 32` | the mirror, `array<u32>` | `read` unless the module stores; `read_write`, and `array<atomic<u32>>` when it has an atomic or a sub-word store (naga upgrades the type from the SPIR-V atomics) |
| `128 + stage*16 + 33` | the range table, 65,536 words | `read` |
| `128 + stage*16 + 34` | the write log, 256 words (only modules that store through an address) | `read_write`, atomic |
| `224 + stage` | the bases of the stage's storage slots in the mirror, 32 words (uniform; only modules with storage slots of their own) | uniform |

So a stage needs 2 or 3 storage buffers whatever it reads; the device's `maxStorageBuffersPerShaderStage` (8 guaranteed,
10 on most desktops) no longer limits the number of ranges. A module that uses the mirror takes **all** its storage from
it: an access to word `i` of the range bound at storage slot `s` is rewritten to word `base[s] + i` of the mirror. Its own
slots therefore cost no binding, and a store through a bound slot and a load through an address of the same memory meet
in the same bytes. Modules that never touch global memory through a loaded address are unchanged (one storage buffer a
slot).

## Table and lookup

The table is nxnative's, word for word, because the lookup is the translator's own code and is not rewritten: 8,192
entries of 8 words `{start lo, start hi, end lo, end hi, delta lo, delta hi, hint, 0}`, sorted by start, disjoint,
entry 0 empty, unused entries starting at `~0`. Per access the helper tries the entry it chose last in this invocation,
then the tagged hint of the address's 2 MiB chunk (word 6 of entry `chunk & 8191`), then a 13-step branchless binary
search; a miss reads 0 or drops the store. `GmemMap.table()` writes the entries and the hints.

`delta = mirror offset of the range − guest start` (64-bit two's complement). The helper's "host address" is then a
byte offset; the pass replaces `OpConvertUToPtr(host)` by a pointer to `mirror[host.lo >> 2]` and nothing else. Loads
keep their meaning: 8/16-bit loads read the word and shift, 64/128-bit loads become 2 or 4 word loads. Stores: 32-bit
is a word store; 64-bit is two helper calls (as the translator writes it); 8/16-bit is the translator's
compare-and-swap loop on the containing word, which naga turns into `atomicCompareExchangeWeak`; guest atomics stay
atomics.

Ranges are 4-byte aligned outward (a mirror word is a guest word) and keep their guest address modulo 256 in the mirror,
so a part of a range can be bound directly as a uniform, storage, vertex or index buffer wherever the guest's own
alignment allowed it. The first 256 bytes of the mirror belong to no range and stay zero; the base of an unbound slot
points there.

## What is in the mirror, and when it is uploaded

Granularity is the **live NVN buffer** (not the pool, as nxnative has it: nxnative maps pools without copying, here every
byte in the table has to be uploaded). A range enters the mirror when a draw or dispatch names it:

1. the ranges bound at the storage slots the module uses (and compute uniform slots it reads through their address);
2. the live buffer each **followed address** lies in. The pass follows every helper call's address back to constant
   word pairs of bound storage buffers (`gmem.pointers`, up to 16; `write` when a storing helper is called with it) and
   to words of the driver segment c0, which hold the addresses bound at the stage's own slots (these just add the slot
   to case 1). The recorder reads the pointer words from guest memory at each draw or dispatch, finds the smallest live
   buffer holding each address (`gmemFind`) and sends it as `H_SSBO` slot `32 + k`.

In the 3,924 dumped shaders every one of the 129 modules with raw global memory is fully followed this way, so there is
**no read log and no learning from misses** yet. An address the pass cannot follow (one loaded through another loaded
address) is not an error any more: it reads what the mirror happens to hold, or 0; the reflection counts such accesses
(`gmem.untraced`) and the replayer says so in red when the shader is registered. A read log would need writable storage,
which a vertex stage cannot have; if such shaders appear, the plan is a small "miss log" of addresses in compute and
fragment stages, resolved with `gmemFind`.

Upload: per range, when it is named in a new epoch (guest memory may have changed), its guest bytes are hashed
(`gfx_hash`, as every other upload) and written to the mirror only if the hash differs from the one the mirror last
took. Nothing is hashed that the current draw does not name; nothing is hashed per frame as a whole. Ranges unused for
240 submissions leave the mirror (every 64 submissions); buffers over 128 MiB are not taken.

Order within a submission: an upload into a range no encoded command has used yet is a `queue.writeBuffer`; into a range
already used in the open encoder it is a staging buffer and a `copyBufferToBuffer` encoded in place (the pass is closed
and reopened), so earlier draws keep what they read. Table updates are additive within a submission (ranges are only
dropped between submissions; freed mirror space is reused only after the submission).

## Size and device limits

One buffer. It starts at 4 MiB (`gmemInitial`) and doubles (a copy in the encoder; the old buffer dies after the
submission) up to `min(1 GiB, maxStorageBufferBindingSize, maxBufferSize)`. `GfxHost.deviceDescriptor` already requests
every adapter limit; Chrome on the M2 grants 4 GiB − 4 for both (the WebGPU defaults are 128 MiB and 256 MiB, which
still work, with less room). A full mirror or table (8,191 ranges) is a red line and the range reads 0. No segments:
they would need a mirror choice per access in the shader and a binding each.

## Writes: who holds the newer bytes, read-back, the write log

A range named with a write flag (a written slot, or an address a storing helper is called with) is the GPU's from that
bind until its read-back lands. The recorder puts such ranges on the pass's read-back list (`H_BUF_READBACK` at the end
of the pass, the path written storage slots already used); the replayer copies them out of the mirror, writes guest
memory when the GPU is done, and fences wait for it as before. While a range is the GPU's, binds of memory inside it by
*other* shaders (vertex, index, uniform, read-only storage of modules that do not use the mirror) are served from the
mirror itself, and an indirect mesh draw's `{count, first}` record is copied from the mirror into the indirect ring
whenever the mirror holds that address (`gmSource`), GPU-written or not. If the guest writes a range again before the
read-back lands, the guest's bytes win at the range's next use (the hash differs), as with the old per-range copies.

The write flag is static and conservative on one side only: it marks every range a storing helper *may* reach through a
followed address. For stores through addresses nobody followed there is the translator's **write log**: a 1 KiB bitmap,
one bit a table entry, set by the helper before it stores (read first, `atomicOr` only when clear). The replayer copies
it out and clears it at each submission, and whenever the table is renumbered under it; an entry it names that no
read-back covered in that submission is marked the GPU's and read back with the next submission (one submission late;
its fence does not wait for it). nxnative uses the same log only for hazard tracking; here it also moves data.

## Usage scopes

WebGPU refuses a buffer that is writable storage and anything else within one usage scope (a compute dispatch; a whole
render pass), and writable storage in a vertex stage.

- The mirror is declared read-only in every module that does not store, so render passes read it freely (vertex and
  fragment), also as vertex / index / uniform source.
- Compute dispatches (and mesh and task shaders, which run as compute) may store: each dispatch is its own scope. While
  such a dispatch is bound, other bindings of the same dispatch are never served from the mirror (they fall back to
  guest memory).
- A **vertex** stage that stores through a loaded address is refused by the pass, and a **fragment** stage that does is
  refused at registration: the writer would have to run as compute or in a pass of its own. Not built; none of the
  dumped shaders needs it (all 12 fragment and 16 vertex modules only read).
- Indirect sources are never the mirror itself: mesh draws copy the record into the ring that `drawIndirect` /
  `dispatchWorkgroupsIndirect` read.

## Verified, and how

- Translator: the 3,924 dumped stages (`vm/ctl/reports/sh-*.bin`) through the translator, the pass and naga: 3,916
  converted before (the 8 failures were all "written through an address the shader loaded"), 3,924 after; 136 of them
  use the mirror (60 + 8 compute, 17 vertex, 12 fragment, 34 mesh, 5 task), every address followed (`untraced` 0).
  Chromium's WGSL compiler (Tint, SwiftShader device) takes 130 of those 136; the other 6 are movie-network stages that
  now get past this pass and fail on something else: `workgroupBarrier` in the HMMA helper is called from non-uniform
  control flow, which WGSL forbids (open; not a global memory matter).
- `test/gfx/i_gmem.test.mts` (Node): placement, merging, freeing, limits, and the table searched as the helper does.
- `test/gfx/scenes10.mts` (browser, SwiftShader): the translator's real load and store helpers (taken from the chain's
  output, `gmem_helpers.mts`) against the replayer's table and mirror: a compute shader stores an indirect record
  through a loaded address and the mesh draw after it draws from it; read-back into guest memory; 14 followed addresses
  and 17 ranges in one stage with 3 storage bindings; the write log's late read-back; a miss; the hint; growth; a
  fragment stage reading the mirror in a render pass.

## Known gaps

- Pointer words are read on the CPU at record time: when a compute pass of the same submission wrote them, they are
  stale (as before).
- Ordinary indirect draws and multi-draw counts are still read on the CPU at record time (`lower.ts draw`); a record or
  count the GPU wrote in the same submission is not seen (they see the previous read-back: one frame late, and a count
  of 0 skips the draw). nxnative's `mdx_run` masking compute is not ported. Plan: the recorder sends indirect draws as
  such (record address, count address, draw number) without deciding on CPU-visible numbers; the replayer, when
  `gmSource` finds the record in a range the GPU holds, runs a small compute before the pass that copies record `i` into
  the indirect ring, zeroed when `i >= count` read from the mirror, and draws with `drawIndirect` /
  `drawIndexedIndirect`; converted primitives and 8-bit indices stay on the CPU path. Batch the copies up to the next
  GPU write (nxnative `g_wr_epoch` / `g_mdx_epoch`), or every draw splits the render pass.
- Vertex / fragment writers (above); no read log / learning (above).
- Merging two placed ranges into a larger one (a new buffer overlapping both) moves GPU-held bytes through a temporary
  buffer; read-backs still in flight for the old ranges land in guest memory but do not clear the new range's GPU flag.
