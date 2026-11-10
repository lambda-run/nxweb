# loader: Switch code modules into guest memory

Reads NSO0 and NRO0 files, maps them at a guest base, relocates them against each other and against the functions the
host implements, and keeps each module's lifecycle in a kit machine. It plays the role of Horizon's rtld, after
nxnative's `dm/tools/nso.py` (file checks) and `dm/host/loader.c` (binding rules). AssemblyScript, no heap, no game data.

| File | What |
|---|---|
| `nso.ts` | Header of an NSO or NRO, validated against the file size; segments stored, LZ4 or ZBIC compressed; SHA-256 check; the same in steps (`loadBegin` / `loadStep`) for an embedder that shows progress. |
| `lz4.ts`, `sha256.ts` | LZ4 block decompressor and SHA-256, written here. |
| `zbic.ts` | ZBIC decompressor (the segment compression of system 22.0.0 on), written here: see "ZBIC" below. |
| `module.ts` | Map, MOD0, dynamic section, export table, relocation, host stubs, unload and reload. |
| `index.ts` | The `ld_*` exports (and the kit's). |
| `defs/module.json` | The lifecycle machine (diagram: `docs/machines/module.md`). |
| `host/loader.mts` | TypeScript wrapper over the exports (Node or browser). `host/build.mts`: `npm run loader:build`. |
| `tools/elf2nso.py` | ELF shared object to NSO or NRO, with its own LZ4 compressor and a small ZBIC compressor (`--zbic`: the reference package when installed, `--zbic-own` without it); `--recode` writes an NSO again with other compression: how the tests get module files. |

## Memory

Guest memory is linear memory: a guest address is the offset. The embedder gives the loader three things, all in the
same memory: an **arena** (records, export tables, names; about 350 bytes per module plus 8 per dynamic symbol), a
**stub region** (4 bytes per host function, a guest address range), and each **file's bytes**, which must stay in place
and unchanged until the module is pinned or refused. The embedder chooses every module's base; `map` refuses a base
that is not page aligned, not inside memory, or that overlaps the arena, the stubs, a file or a mapped module.

## API (through `host/loader.mts`)

```ts
const ld = new Loader(exports, { arena, arenaLen, stubBase, stubCap });
ld.hostAdd("nnosAllocateMemory", true);    // forced: wins over every module's definition (nxnative HLE_FORCE)
ld.hostAdd("nnsocketSend", false);         // weaker: only fills an import no module defines (nxnative HLE)
const set = ld.loadSet(files /* [{ name, ptr, len }] in load order */, (imageSize, name) => base);
set.entry                 // guest address of the first module's first instruction
set.modules[i]            // base, imageSize, text/ro/data, buildId, init, fini, initArray, finiArray, relocation counts
set.initCalls             // each module's DT_INIT in load order: what Horizon's rtld calls
set.unresolved            // [{ module, name, stub }]: imports nothing provides (each also logged red)
set.forcedUnused          // forced names no module referred to (each logged red)
ld.hostFunctions()        // the stub table: [{ id, name, kind, stub, refs, firstModule }]
ld.stubId(addr)           // guest address -> host function id, or -1;  ld.stubAddr(id) the other way
ld.lookup("nnMain")       // first exported definition in load order, or undefined;  ld.lookupIn(handle, name)
ld.codeEntries(h, out, cap) // function entries of a relocated module for a translator: function symbols, DT_INIT /
                          // DT_FINI, init and fini arrays, relative relocations (RELA and RELR) into the text
ld.forceStrict(true)      // a red line per forced name no module refers to; default: one summary line
                          // (`force: N entries hit, M not referenced by this game`), as nxnative
for (const m of set.modules) ld.activate(m.handle);   // after the init calls ran;  ld.pin(handle) for modules that stay
```

A module loaded at run time (an NRO): `h = ld.parse(file)`, `ld.map(h, base)`, `ld.relocate(h)`, run its init,
`ld.activate(h)`; later `ld.unload(h)`, and `ld.map(h, anyBase)` loads it again. The raw exports are in `index.ts`;
they return 0, a handle or an id, or a negative code (`ERR_ARG` -1 nothing changed, `ERR_STATE` -2 the kit refused the
event, `ERR_REFUSED` -3 the module is now Refused, `ERR_NOMEM` -4), with the red line at `ld_error_ptr/len`.

**Binding** of a symbol relocation, as nxnative's `bind_sym`: a forced host name wins; a symbol the module defines binds
to the first definition in the mapped modules in load order (so an earlier module's definition wins over its own),
unless it is local or not of default visibility; an undefined symbol binds to the first definition in load order, else
the host's weaker table, else 0 if it is weak, else a stub the loader makes for the name (kind `HOST_UNRESOLVED`).
Map every module of a set before relocating any (`loadSet` does). When a module is relocated later, the imports of the
modules relocated before it that it defines are bound to it; when it is unloaded, what pointed into it is bound again.

**A stub** is the 4 bytes at `stubBase + 4 * id`, holding `UDF #id`. The translator or the embedder recognizes a call
by its address (`ld_stub_id`); if the word is ever translated, `unimpl(pc, insn)` reports it.

**Lifecycle**: `New → Parsed → Mapped → Relocated → Active → Pinned`, `Relocated → Pinned` directly for a module of
the process's start set (its file is let go of before its init functions run), `Unload` from Mapped, Relocated or Active,
`Unloaded → Mapped` again, `Refused` from New, Parsed or Unloaded with the reason as its data. Every map writes the
whole image from the file and zeroes the bss, and the record refers to the file in every state that can reach a map;
only Pin and Refuse let go of it and both are final. So the case nxnative's survey suspected on its JIT-plugin reload
path (a reload with no pristine copy) has no path in the table.

## ZBIC

From system 22.0.0 an NSO may store its segments as ZBIC: NSO flag bit 7 for the whole module, the per-segment
compression and check-hash bits as before (the SHA-256 is still over the decompressed segment). **ZBIC is Zstandard
(RFC 8878) with two changes**, so no stock zstd reads it:

1. The frame magic is `ZBIC` (`5A 42 49 43`) instead of `28 B5 2F FD`.
2. An FSE table description (the normalized counts of a sequence table in FSE_Compressed mode, and of the table
   that codes Huffman weights) is not Zstandard's variable-width bit field. Its first byte gives the number of bytes
   that follow (low 7 bits) and whether counts are stored plus one (bit 7: how a "less than one" count, -1, is
   written). Those bytes are one number in mixed radix, read from the last byte to the first through a 64-bit
   accumulator that takes another byte whenever it is below 2^40. Its digits: the highest symbol less 1 (base 52),
   the table log less 5 (base 8), the total of the stored counts less 1 (base 2^log), then the cumulative counts
   `C[1..P-1]` (`C[0] = 0`, `C[P]` the total, `P` the power of two above the highest symbol) by **binary
   interpolation**: over the subdivision of `[0, P]` (a node, then its upper half, then its lower half),
   `C[middle] - C[low]` in base `C[high] - C[low] + 1`, a node being skipped when `C[low] = C[high]`; and a last
   digit that carries nothing. The description must be followed by at least one byte and use all of its own.

Everything else is Zstandard as published: frame header (content size or window, a dictionary ID, which is refused
when not 0), raw, RLE and compressed blocks, literals raw, RLE or Huffman-coded in 1 or 4 streams with a new or a
repeated tree (weights as 4-bit fields or FSE-coded), sequences with predefined, RLE, FSE-coded and repeated tables,
the three repeat offsets, the XXH64 checksum, skippable frames, several frames one after the other.

**Where it lives and why.** `zbic.ts`, AssemblyScript in the loader, beside `lz4.ts`: every reader of NSO segments
goes through `nso.ts` (the loader's `map`, and the prepare step's build ID, checks, cuts, function matching and
graphics detection, which compile `nso.ts` into `prepare.wasm`), so one decoder serves the page, the Worker and Node.
The bundled fzstd cannot be reused with a front end: the table descriptions sit inside every compressed block, so a
front end would have to parse and re-emit every block. No heap and nothing beyond wasm MVP: static work area of
about 150 KB (a block's literals, the Huffman table, three sequence tables); the output is its own window (a match
copies from what was already written), so a 100 MB segment needs no more memory than a small one. It also compiles
with `tools/asc64` and decodes the committed streams on a 64-bit memory. Every read is checked against the end of
the input and every write against the end of the output; a damaged stream is refused with one of 16 reasons
(`ZE_*`: "bad FSE table", "damaged Huffman stream", "a match before the start of the output", ...) which the
loader's red line carries: `text segment does not decompress (damaged ZBIC stream: damaged sequence stream)`.
`zbicBegin` / `zbicStep(budget)` decode whole blocks until `budget` more bytes are out, for progress and Cancel.

**Licence.** The format was learned from the `zbic` Python package (github.com/kinnay/zbic, GPLv2), which is
Atmosphere-NX's zstd with its ZBIC changes (GPLv2; zstd itself is BSD or GPLv2). Neither is vendored and no code or
table of either is copied: Zstandard is written here from RFC 8878, the two changes from the format as described
above, and the interpolation order is computed (the reference holds it as a table of 768 numbers). The header of
`zbic.ts` names both sources. The package is used by the tests only, as an optional outside tool.

**Speed** (`npm run loader:zbic-bench`, level 3 streams of the reference; output per second, best of 5):

| | Node 22 | Chromium 153 |
|---|---|---|
| this repository's own test code (1.8 MB of AArch64, 56 % stored) | 289 MB/s | 297 MB/s |
| 100 MB made of perturbed copies of that code (71 % stored) | 245 MB/s, **408 ms** | 227 MB/s, **441 ms** |
| generated text, 20 MB (32 % stored) | 366 MB/s | 369 MB/s |
| random bytes (raw blocks) | 13 GB/s | 13 GB/s |

In steps of 4 MB (what the prepare page uses) the longest step of the 100 MB segment is 21 ms. The SHA-256 of the
same 100 MB, which follows every decode, costs about as much again. No real game module was measured.

**One known difference from the reference** on damaged streams: zstd's fast path for literals in four Huffman
streams checks that each stream gives its count of symbols, not that it ends at its end mark, so it decodes some
damaged streams to bytes (64 of 6000 in the test). This decoder holds every stream to its exact end and refuses
them. Every stream both accept decodes to the same bytes.

## What is verified (`npm run loader:test`, 84 tests; the machine alone also in `npm run kit:test`)

- SHA-256 against node:crypto; the LZ4 decompressor on hand-made blocks, valid and damaged.
- **ZBIC, against the reference codec.** Committed (`test/loader/zbic_fixtures.bin`, 348 KB: 40 streams of generated
  data and of our own test modules' ELF files, each with the SHA-256 of what it decodes to; and
  `test/loader/fixtures/*.nso`, the three test modules as ZBIC NSO files), so this runs where the `zbic` package is
  not installed: every stream decodes to its hash, at once and in steps of 1, 1000 and 200,000 bytes, and between
  them they reach all three block types, raw / RLE / Huffman literals in 1 and 4 streams with new and repeated
  trees, both weight codings, all four modes of each of the three sequence tables, each repeat-offset case, matches
  farther back than a block, and tables with less-than-one counts (the test fails if one is not reached). Frames made
  by hand: a window instead of a content size, 1 / 2 / 4 / 8-byte sizes, a checksum (XXH64 is also checked against
  the checksum node:zlib's zstd writes), skippable frames, two frames, an empty frame; 27 header faults, each
  refused for its reason. Damage: every committed stream cut at every length up to 3000 bytes (81,003 truncations),
  every single bit of seven small streams (29,120 flips) and 30,000 random mutations, the input ending where memory
  ends and bands around the output: refused or decoded, never a trap or a write outside, and 13 of the 16 refusal reasons
  occur (the other three are in the hand-made frames). **With the package installed** (`python3 -m pip install zbic`; otherwise SKIPPED is printed):
  600 fresh inputs of 12 kinds (0 bytes to 1 MB, levels -7 to 22) decode to the same bytes, and 6000 damaged streams
  are accepted or refused as the reference does (apart from the difference above).
- **ZBIC NSO files**: the test modules with ZBIC segments (by the package, or by `elf2nso.py --zbic-own` without it)
  load in both orders, alone, mixed with LZ4 modules and with only one segment compressed, every byte of the images
  equal to the model; the committed files load with their hashes checked; LZ4 segments marked ZBIC, a damaged
  stream, a size that disagrees with the frame and a flipped literal (found by the hash only) are refused; the
  ZBIC files are in the truncation, bit-flip and mutation sweeps below.
- Three modules built from C by clang and ld.lld, converted by `elf2nso.py` (LZ4 with matches, literal-only, stored,
  with and without hashes, NRO): after loading, **every byte of every image** equals a model computed in the test from
  the ELF files (segments, bss, RELATIVE, RELR with bitmaps, ABS64 with addends, GLOB_DAT, JUMP_SLOT), in both load orders.
- Forced and weaker take-overs, stub address and id both ways, unresolved imports by name, undefined weak symbols,
  protected symbols, the unused forced name report, a full stub region, DT_INIT and init_array order, export lookup.
- Run-time load, unload, reload at another base with data restored and bss zeroed; a file damaged between unload and
  reload; what each state refuses; all 13 transitions of the machine; every way a base can be wrong.
- 31 header and layout faults, each refused for its reason with its red line. Every truncation of five files (25,860),
  every single bit of five files (about 134,000) and 12,000 random mutations, each through parse, map, relocate, queries,
  unload and reload beside an intact module: no trap, no read past the file (it ends where memory ends), no write
  outside the image (bands checked), no access the checked accessors had to stop.

## Gaps

- No code was executed: init functions, PLT stubs and the entry point are checked as addresses only. Running them
  needs the translator.
- Compressed NROs (system 23.0.0 on) are refused. ZBIC was verified against the reference codec's own compressor
  and no stream of Nintendo's was decoded here: the first real game file tried in the page (a Switch 2 title's
  `main`) stopped at the refusal this decoder replaces, and has not been run again since.
- The ZBIC decoder takes its four Huffman streams one after the other (zstd interleaves them): about a quarter of
  zstd's native speed.
- TLS relocations (TLSDESC, TPREL64) and IRELATIVE are left alone and counted (`relocs.unsupported`), with a red line.
- Thread-local storage setup, `nn::ro` bookkeeping (NRR, hashes of NROs) and the MOD0 module object are not handled.
  MOD0's bss bounds are read but the header's bss size is what is used.
- nxnative's "load alone" mode (a JIT plugin relocated only against itself) is not there.
- Each run-time load walks the symbol relocations of every module loaded before it (as nxnative does); with thousands
  of NROs this wants an index of unresolved slots.
- Memory protection does not exist in linear memory: text and read-only data are as writable as data.
- At most 4096 modules; the arena never gives memory back (an unloaded module keeps its record and export table).
