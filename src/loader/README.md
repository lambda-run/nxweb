# loader: Switch code modules into guest memory

Reads NSO0 and NRO0 files, maps them at a guest base, relocates them against each other and against the functions the
host implements, and keeps each module's lifecycle in a kit machine. It plays the role of Horizon's rtld, after
nxnative's `dm/tools/nso.py` (file checks) and `dm/host/loader.c` (binding rules). AssemblyScript, no heap, no game data.

| File | What |
|---|---|
| `nso.ts` | Header of an NSO or NRO, validated against the file size; segments stored or LZ4 compressed; SHA-256 check. |
| `lz4.ts`, `sha256.ts` | LZ4 block decompressor and SHA-256, written here. |
| `module.ts` | Map, MOD0, dynamic section, export table, relocation, host stubs, unload and reload. |
| `index.ts` | The `ld_*` exports (and the kit's). |
| `defs/module.json` | The lifecycle machine (diagram: `docs/machines/module.md`). |
| `host/loader.mts` | TypeScript wrapper over the exports (Node or browser). `host/build.mts`: `npm run loader:build`. |
| `tools/elf2nso.py` | ELF shared object to NSO or NRO, with its own LZ4 compressor: how the tests get module files. |

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

**Lifecycle**: `New → Parsed → Mapped → Relocated → Active → Pinned`, `Unload` from Mapped, Relocated or Active,
`Unloaded → Mapped` again, `Refused` from New, Parsed or Unloaded with the reason as its data. Every map writes the
whole image from the file and zeroes the bss, and the record refers to the file in every state that can reach a map;
only Pin and Refuse let go of it and both are final. So the case nxnative's survey suspected on its JIT-plugin reload
path (a reload with no pristine copy) has no path in the table.

## What is verified (`npm run loader:test`, 68 tests; the machine alone also in `npm run kit:test`)

- SHA-256 against node:crypto; the LZ4 decompressor on hand-made blocks, valid and damaged.
- Three modules built from C by clang and ld.lld, converted by `elf2nso.py` (LZ4 with matches, literal-only, stored,
  with and without hashes, NRO): after loading, **every byte of every image** equals a model computed in the test from
  the ELF files (segments, bss, RELATIVE, RELR with bitmaps, ABS64 with addends, GLOB_DAT, JUMP_SLOT), in both load orders.
- Forced and weaker take-overs, stub address and id both ways, unresolved imports by name, undefined weak symbols,
  protected symbols, the unused forced name report, a full stub region, DT_INIT and init_array order, export lookup.
- Run-time load, unload, reload at another base with data restored and bss zeroed; a file damaged between unload and
  reload; what each state refuses; all 12 transitions of the machine; every way a base can be wrong.
- 31 header and layout faults, each refused for its reason with its red line. Every truncation of four files (23,566),
  every single bit of three files (97,656) and 12,000 random mutations, each through parse, map, relocate, queries,
  unload and reload beside an intact module: no trap, no read past the file (it ends where memory ends), no write
  outside the image (bands checked), no access the checked accessors had to stop.

## Gaps

- No code was executed: init functions, PLT stubs and the entry point are checked as addresses only. Running them
  needs the translator.
- ZBIC (zstd) NSO segments and compressed NROs are refused, as are files that need them. No real game file was tried.
- TLS relocations (TLSDESC, TPREL64) and IRELATIVE are left alone and counted (`relocs.unsupported`), with a red line.
- Thread-local storage setup, `nn::ro` bookkeeping (NRR, hashes of NROs) and the MOD0 module object are not handled.
  MOD0's bss bounds are read but the header's bss size is what is used.
- nxnative's "load alone" mode (a JIT plugin relocated only against itself) is not there.
- Each run-time load walks the symbol relocations of every module loaded before it (as nxnative does); with thousands
  of NROs this wants an index of unresolved slots.
- Memory protection does not exist in linear memory: text and read-only data are as writable as data.
- At most 4096 modules; the arena never gives memory back (an unloaded module keeps its record and export table).
