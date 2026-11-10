# prepare: a NUP container or a folder of game files becomes what the runtime starts

nxnative packs a game with `scripts/build_ipa_from_nsp.py`: extract, pick the game's profile, rewrite the code
modules, split and translate the shaders, package. nxweb does the part of that which still means something in a page,
on the player's own files, uploading nothing.

**Input: a NUP container (one `.nup` file) or a folder of files that are already extracted.** No NSP, XCI or NCA is
opened, nothing is decrypted and no keys are read; the page says what such a file is and what to do with it
("NUP containers" and "The page" below). The folder layout is the one nxnative accepts for dump folders (its README,
"From a folder of files"; `scripts/pack_dump.py`), and a container is presented to the stages as exactly that:

```
base/exefs/        main, main.npdm, sdk, rtld, subsdk*      base/romfs/ is optional when an update has one
base/romfs/
updates/<version>/exefs/, updates/<version>/romfs/         <version> in decimal; the patched RomFS, not a patch
dlc/<DLC title ID>/<n>/romfs/                               (or dlc/<id>/romfs/)
exefs/ and romfs/ directly in the folder count as base/
```

| File | What |
|---|---|
| `index.ts` | The module's exports (`build/prepare/prepare.wasm`, AssemblyScript, its own memory): the machine and its counters, an arena |
| `npdm.ts` | `main.npdm`: program ID (the title ID, as nxnative), system resource size, 64-bit flag, main stack size |
| `cuts.ts` | NSO identity (build ID), the whole-module check, registered cuts applied and the module written as an NSO again; over `src/loader`'s NSO reader, LZ4 and SHA-256 (imported, not changed) |
| `match.ts`, `gen/match_writes.ts` | Function-matched cuts: the module's functions from its unwind table, nxnative's function fingerprint, a rule list resolved to cuts. The second file is generated: which registers Capstone lists an instruction as writing (`tools/prepare/gen_match_writes.py`) |
| `romfs_build.ts` | The header and four tables of a standard RomFS image for a tree that stays a directory |
| `bnsh.ts` | The BNSH shader container scan (a proof for the pre-warm, see Shaders) |
| `defs/prepare.json` | The one machine (diagram: `docs/machines/prepare.md`) |
| `host/prepare.ts` | `Prepare`: the pipeline, the manifest, the hand-off. No Node or DOM API |
| `host/detect.ts` | What a folder holds, by nxnative's rules: pure functions of its listing |
| `host/nup.ts`, `nup_node.ts` | A NUP container: `Nup` (the validated superblock and table of contents), `scanNup`, `NupTree` (the container as the folder the stages read), `NupReader` (file data by ranges, zstd frames, SHA-256 checks, the bounded cache), `packSource` (the same in the Worker); a `.nup` on disk under Node |
| `host/verdict.ts` | `verdictFor` (should start / might start / can't run, with the reason), `failureSentence`, `explainFile` (what a dropped file is, from its name and first bytes): pure functions |
| `sha_stream.ts` | SHA-256 over data that arrives in pieces (a fixed 64 KB buffer): a file of any size is hashed without lying in the module's memory |
| `host/wasm.ts` | `PrepWasm`: the module behind a TypeScript face |
| `host/tree.ts`, `tree_node.ts` | The folder: `HandleTree` (directory picker, dropped handle, OPFS), `EntryTree` (`webkitGetAsEntry`), `FileListTree` (`<input webkitdirectory>`), `MemTree`, `NodeTree` |
| `host/store.ts`, `store_node.ts` | Where the manifest and outputs live: `OpfsStore`, `MemStore`, `NodeStore` |
| `host/romdev.ts` | `DirRomDevice`: the RomFS device over the directory; `PrepStorage` |
| `host/profiles.ts`, `profiles_node.ts` | Access to the converted profiles |
| `profiles/*.json` | Generated: one file per game, `_sdk.json`, `index.json`, `report.json` (`tools/prepare/convert_profiles.py`) |
| `../../tools/prepare/convert_profiles.py` | nxnative's `dm/games` and patch files into the above |
| `../../tools/prepare/layout_verdict.mts` | The runtime's layout rule (`src/glue/rt_process.ts`) over the profiles' memory keys, for the converter |
| `../../tools/prepare/gen_match_writes.py`, `match_reference.py` | The register-write table measured from Capstone; nxnative's own `nso_match.py` on an image, for the tests |
| `../../tools/prepare/nup_reference.py` | nxnative's own `pack_nup.py` on a container, for the tests |
| `../../web/prepare.html`, `prepare.ts`, `prepare_build.mts` | "Open a game": the page and its build, the frame at the top of the main page (`web/index.html`), whose Play hands over to the page's Worker |

```
npm run prepare:test [-- <filter>]   # Node, 30 tests, about 25 s after the builds (the first run compiles 92 modules with unwind tables)
npm run prepare:browser              # headless Chromium (Playwright), 13 tests: the page, a .nup and a folder, OPFS, a reload mid-stage, Play in a Worker
npm run web:shots                    # screenshots of the landing state and a verdict card into build/web-shots/
npm run prepare:measure [-- <files>] # the directory device against a packed image, 50,000 files
npm run prepare:profiles             # convert nxnative's profiles again (prepare:profiles:check: are they current)
npm run prepare:writes               # measure the register-write table from Capstone again (prepare:writes:check)
npm run prepare:web                  # build build/web/prepare.html and serve it on http://localhost:8081
npm run kit:test                     # includes test/prepare/prepare.machine.test.mts
```

## The pipeline: one machine

`Idle → Detect → Index → Profile → Code → Shaders → Ready`, `Failed(reason)` and `Cancelled` from any stage, `Start`
again from Ready, Failed or Cancelled. Each stage ends with `Done` (it worked) or `Skip` (its record stands). The
reasons of Failed are the machine's data: `layout npdm arch version dlc module romfs profile cut read storage
internal`. The instance lives in the module; `Prepare` is its guard and never offers an event the table refuses
(asserted: `kit_refused_total() == 0` after every scenario).

**Progress is the state plus counters** (`prep_count`, `PrepWasm.counts()`): stage units done / total, bytes done /
total, files seen, code modules, cuts applied, RomFS files and directories, add-on contents, stages skipped and run.
The page draws from `snapshot()` only; the log lines are for people.

| Stage | Input hash is made from | Work | Output in the manifest |
|---|---|---|---|
| Detect | the layout, the asked version, name / size / time of every file outside a `romfs/` | reads `main.npdm` and the first 0x100 bytes of each exefs file | layout kind, title ID, versions, the chosen version and its roots, NPDM facts, every NSO with its build ID in load order, DLC with index |
| Index | name / size / time of every file and directory of the chosen `romfs/` and of each DLC's | builds RomFS tables in the module, stores `rom.tables`, `rom.index`, `aoc<i>.*` | per tree: files, directories, bytes, image size, the tables' SHA-256 |
| Profile | title ID, version, module build IDs, NPDM facts, a container's control data, the profile's JSON, the SDK cuts that match and the rules for every game's modules of these names, the RomFS tables' hash | selects the profile, the modules to load, the cuts, the function-matched rules for modules no registered cut names; reads `main` once for the graphics interface it imports | found / by title or build / provisional, registered build or not, `apply`, `needs`, load list, cuts, `match`, `space` and `layout` (the address-space verdict), `pool`, `graphics` (`nvn` / `vulkan` / `gl` / `unknown`, by nxnative's rule: `nvnBootstrapLoader`, Vulkan functions, EGL), warnings |
| Code | name / size / time and build ID of each module to load, the cuts, the rules | reads each module whole, checks it (segments unpacked, SHA-256), places function-matched cuts, applies cuts, stores a cut module as `code/<name>.nso` | per module: from the folder or the store, size, SHA-256, cuts; `matched` (each patch: where, or why not), `matchCuts` |
| Shaders | chain version, store name, title ID | nothing ahead (see Shaders) | `{ mode: "on-demand", chain, store }` |

**Detection** is nxnative's, rule for rule (`detect.ts` names the functions): the title ID is the ACI0 program ID of
the base's `main.npdm`, else of the newest whole update's, and must be a base title ID; **the newest update is
prepared by default**, `version` picks another, 0 is the base; an update's program ID must be the base's; an
update's folder is the whole game (its code, its patched RomFS, never laid over the base's); a DLC is
`0 < its ID - application ID - 0x1000 <= 2000`, that difference being the index the game asks for, with exactly one
`romfs`. Beyond nxnative: a 32-bit program (NPDM flag) is refused (`arch`), and the refusal of a folder says which
of ten things it looks like (empty, packages, the exefs folder itself, one folder too high, ...).

**Game identity**: title ID from `main.npdm`; the build ID of every NSO in the version's exefs (the first 16 bytes
in hex, as nxnative's profiles write it).

### The manifest

`manifest.json` in the store (OPFS directory `nxweb-prepare-<folder name>`; a directory under Node):

```json
{ "format": 3, "folder": "MyGame", "machine": "Ready", "reason": "",
  "stages": { "detect": { "state": "done", "input": "<sha256>", "output": { ... }, "ms": 12 },
              "index": { ... }, "profile": { ... }, "code": { ... }, "shaders": { ... } } }
```

`state` is `pending`, `running`, `done`, `failed` (with `error`, `reason`) or `cancelled`. Rules:

- A stage is **skipped** when its record is `done` with the same `input`. Hashes are over listings (name, size,
  modification time), as nxnative's reuse checks, not over file contents: a 10 GB RomFS is not read to decide.
- The record is written `running` before the work and `done` after it, each a whole-file replace (OPFS
  `createWritable`, rename under Node). A tab that dies leaves `running`; the next run does that stage again. Blobs
  are written before the record that names them.
- **Cancel** (`prepare.cancel()`) takes effect at the stage's next step; the record becomes `cancelled`.
- **Redo** is one call: `prepare.redo("code")` removes that record and runs. Later stages run again only if what the
  stage gives them changed.
- `format` is in every hash and in the file: another format is a fresh start.

### The hand-off (`await prepare.handoff()`, the machine is Ready)

```ts
interface HandOff {
  titleId, programId, name, version, displayVersion
  profile: { id, provisional, registeredBuild, apply: Record<string,string>, needs: { key, value, what }[],
             space: { heap_region, alias_region, stack_region } | null,   // what the profile reserves: the runtime lays the process out from it
             layout: { fit: "profile" | "pool" | "short", note } | null } // the verdict of the runtime's rule when the profile was converted
  npdm: { sysResource, stackSize, is64, name }
  modules: { name, buildId, size, cuts, bytes(): Promise<Uint8Array> }[]   // load order, cuts already applied
  rom: FsDevice | null;  aoc: Map<index, FsDevice>
  storage(saves: FsStorage): FsStorage   // rom + aoc in front of whatever keeps the saves
  saveId: "nxweb-save-<title id>"        // OpfsStorage's directory
  cuts: { module, buildId, off, orig, new, why }[]   // registered ones and function-matched ones ("... [function match]")
  hooks: TranslatorHook[]                // always [] in this round
  shaders: { mode: "on-demand", chain, store }
  message(): Promise<HandOffMessage>     // the same as plain data and Blobs, for postMessage to the Worker
}
```

A message's `rom` and `aoc` images carry one Blob per file for a folder; for a container they carry `nup` instead
(the user's one File and each file's extent, codec and SHA-256), and `storageFromMessage(msg, saves, { sha256, log })`
checks the files with the hash function it is given (`PrepWasm.sha256`: the page's Worker loads `wasm/prepare.wasm`
for it).

In the Worker: `storageFromMessage(msg, new OpfsStorage(msg.saveId))` gives the `FsStorage` for `RtFs`; modules are
`msg.modules[i].file` (Blobs: the user's Files, or the cut modules in OPFS). The page fires
`window` event `nxweb:handoff` with the message on Play. `test/prepare/web/worker.ts` is a complete receiver.

## RomFS from a folder: a device over the directory, decided by measurement

`src/fs` mounts standard RomFS images through a block device. Two ways to give it a folder: build an image (nxnative
writes its own with `romfs_image.py`), or make the folder itself the device. The second is implemented:
`romfs_build.ts` builds the image's header and tables from the listing (tables first, then a data section that is
never written), and `DirRomDevice` answers a read of the tables from memory and a read of the data section from the
file it falls in (binary search over the files' start offsets). `src/fs` needs no change: it reads the tables once,
checks them completely, then makes one device read per `ReadFile`.

Measured (`npm run prepare:measure`, Node 22, this machine, four runs, 50,000 files in 2,600 directories, 105 MB):

| | directory device | packed image (`tools/mkromfs.py build`) |
|---|---|---|
| make it | listing 228-242 ms + tables 98-111 ms (3.28 MB, 66 bytes a file); nothing copied | 1.1-1.3 s for 109 MB: every byte read and written once, and stored a second time |
| fs mount (tables read and checked) | 12-13 ms | 8-9 ms |
| OpenFile + ReadFile (whole) + CloseFile, 5,000 random files | 30-32 µs a file first pass, 18-24 µs second | 12-15 µs, 10-13 µs |

The directory device costs one `open` per file not among the 256 kept open (8,962 opens in the two passes), 6 to
18 µs here. The image costs a full copy: at the measured 80 to 100 MB/s a 10 GB game is minutes of writing and 10 GB of
the origin's quota, again for every update. So: the directory.

In Chromium (`npm run prepare:browser`, OPFS as the folder, `PREPARE_BROWSER_FILES=50000`): listing 50,000 files
through `FileSystemDirectoryHandle` (`entries()` and `getFile()` for each: the size and time are nowhere else) took
9.5 s, 191 µs a file; 500 whole-file reads on the main thread (`Blob.slice().arrayBuffer()`) 0.8 to 1.3 ms each over four runs. The
listing is paid at every start, also a resumed one, because the hashes are made from it. In the Worker the device
reads with `FileReaderSync`, so an fs call never parks (checked: `romSync` in the browser test).

Independent check: for a synthesized tree of 400 files, `tools/mkromfs.py`'s reader (which shares nothing with the
builder here) finds in the dumped virtual image exactly the entries, sizes and SHA-256 it finds in the image
`mkromfs.py` built; the same for each DLC.

**Updates and DLC.** The chosen version's `romfs/` is the game's RomFS, whole. Each DLC's `romfs/` is its own device,
handed out for `FS_KIND.AOC` at the DLC's index.

## NUP containers

A `.nup` ([SPEC v1](https://github.com/a55uka/nup)) is one unencrypted file: a superblock, a table of contents with
its SHA-256, and packages (base, updates by version, add-ons by title ID), each an `exefs/` and a `romfs/` tree whose
files are stored raw or as one zstd frame, each with a SHA-256, and a meta block that may hold the NACP and icons.
`host/nup.ts` reads it as nxnative's `scripts/pack_nup.py` does, check for check and with its sentences: the magic
and format version, the header size and flags, the file's length against the header's ("copied or downloaded
partly?"), the regions, the table's hash, every record's bounds, the reserved package fields, the codecs, the name
pool, the folder slots; then `scan`'s rules (one base at most, no update of version 0 or twice, a DLC with a
`romfs/` and once, and "no base game" in its two forms: no base record with every update marked standalone, or a
base record with no files). Beyond nxnative: a folder reached twice in a walk is refused (a loop would not end), and
names that are no path component are refused in `romfs/` as in `exefs/`.

**To the stages a container is a dump folder** (`NupTree` is a `PrepTree`): `base/`, `updates/<version>/`,
`dlc/<title ID>/0/romfs/`. An update without `romfs/` lists the base game's under its own (nxnative `romfs_of`). So
Detect, Index, Profile and Code are the folder's code, unchanged: the newest update by default, `version` picks
another, a DLC is an add-on content device at its index, program IDs are read from the NPDMs. `addon_update` and
`system` packages are named in the notes and not used, as in nxnative.

**Nothing is read whole.** Opening reads the superblock and the table of contents (0x50 bytes a file). After that a
raw file is a range of the user's File (`Blob.slice`), and a zstd file is decompressed when it is first read
([fzstd](https://github.com/101arrowz/fzstd), MIT, pure JavaScript, bundled). Held in memory: a small cache (32 MB
in all, files up to 4 MB, least recently used out first) and the one last file larger than that. In the Worker the
reads are synchronous (`FileReaderSync`), so an fs call never parks.

**Identity and checks.** A file's "modification time" in the listing is 48 bits of its SHA-256 from the table of
contents (which the table's own hash covers), so the stages' input hashes follow the content the container
declares: a second run on the same container reads 0 bytes of file data to decide that all five stages are kept
(tested), and a container whose file changed runs the stage that depends on it. File *data* is checked against its
SHA-256 the first time all of it is in hand: every zstd file (its frame is decompressed whole), every raw file up
to 8 MB (read whole on first use), and a larger raw file when one read asks for all of it (the code modules are
read so by Code). A mismatch, a short frame or a frame of another size fails the read with nxnative's sentence
("does not match its size or SHA-256 (damaged file)"): `Failed(read)` in a stage, a red line and an I/O error for
the game. The hash is the module's (`sha_stream.ts`, fed 64 KB at a time).

**Control data.** A package's NACP gives the name and display version (the first non-empty language; the
deflate-compressed title area of newer SDKs is inflated where the platform has `DecompressionStream`), its icon
record or localized icons the picture. With no base game they come from the application record (nxnative
`control`). The profile's name and display version win when there is a profile.

**Checked against nxnative itself** (test "the NUP reader against nxnative's own", when the checkout and a zstd
module for its Python are there: `pip install backports.zstd` before Python 3.14; otherwise it prints SKIPPED): for
synthetic containers written by the test (the writer of nxnative's `test_nsp_nup.py`, ported to
`test/prepare/nup_synth.mts`), the packages, every file's path, size and bytes (by SHA-256 of what each reader
gives), the folders and the meta records are equal, and the damaged ones are refused by both with the same sentence.

## The page

`web/prepare.html` is "Open a game", alone or as the frame at the top of `web/index.html`:

- **Getting a game in**: drop a `.nup` or a folder on the page (the main page passes a drop anywhere on it to the
  frame), *Choose file* (`showOpenFilePicker`), *Choose folder* (`showDirectoryPicker`). Where a picker is missing
  or throws anything but `AbortError` (a sandboxed or cross-origin frame refuses both with `SecurityError`), the
  button clicks its `<input type=file>` / `<input webkitdirectory>` by itself. A handle (File System Access) is kept
  in IndexedDB and offered as *Continue with <name>* after a reload, with the permission asked again; a File from
  an input or a plain drop cannot be kept, so it is chosen again. A folder that holds exactly one `.nup` opens it.
- **What is not a game** is named from its first bytes and extension (`explainFile`): encrypted packages (`.nsp`,
  `.xci`, `.nsz`, `.xcz`, `.nca`), a single NSO or NRO, a zip or another archive, an nxnative `RomFS.img`, a RomFS
  image, an empty or unknown file, a `.nup` that is damaged, cut short, or an update without its game.
- **The verdict card** appears when Detect is done (name, icon, version, a version picker) and gets its verdict when
  Profile is, before Code: *Should start* / *Might start: no profile for this game, running with defaults* /
  *Can't run in a browser yet* with one sentence (`verdictFor`): the address-space verdict ("This game needs about
  9 GB of memory. A browser tab can give it 4 GB." for the 11 profiles with a 9 GB pool, the reserved address space
  for the other 3), a `main` that imports OpenGL or Vulkan and not NVN, a multi-program game; the other class c
  `needs` and unconverted patch kinds are listed under it as what may be wrong. The technical lines are behind a
  disclosure. Play is *Try anyway* on a can't-run verdict: the report of a failed attempt is useful.
- **Progress**: a row per stage with a plain label, its state, a bar (bytes for Code, trees for Index), its counts,
  its time, Cancel, and Redo. A failure is a sentence (`failureSentence`, by the machine's reason) over the
  technical line.

## Profiles

`tools/prepare/convert_profiles.py` reads `dm/games/<id>/game.tsv` of all 153 profiles and writes
`profiles/<id>.json`: `builds` (version, display version, module build IDs), `apply` (class a), `needs` (class c,
with the sentence the page shows), `dropped` (class b, names), `cuts`, `match_cuts`, `unconverted`, `address_space`
(and `patches: { converted: false, reason }` when its patch file could not be evaluated, see Code patches).
`index.json` maps title IDs and main build IDs to profiles; `report.json` holds the counts below, the address-space
verdict of every profile and, for each patch kind that is not converted, the profiles that have it.

**Selection**, as nxnative: by title ID; else by `main`'s build ID among every profile's build rows (a regional
release of a known build), with this title's program ID; else none: **provisional** (modules in Horizon's load
order, `sys_resource` from the NPDM, the default pool), and the page says "no profile: provisional". The modules
loaded are the profile's `modules` that the exefs holds, restricted to the build row of `main`'s build when there is
one. A build no row registers gets the profile without per-build cuts, with a warning naming the modules.

### Key classification

(a) applies as is, handed over in `apply`; (b) Apple / Metal / rewriter / offline-chain specific, dropped;
(c) switches a mechanism nxweb does not have: the per-game features to build. "Profiles" is how many of the 153 set
the key.

| Key | Class | Profiles | Where it goes / why dropped / what is missing |
|---|---|---|---|
| `title_id`, `program_id`, `name`, `build`, `package`, `modules`, `romfs_marker`, `app_pool` | a | 153 each | identity and the prepare step itself; `program_id`, `app_pool` → `kernel_init` cfg +104, +80 |
| `sys_resource` | a | 122 | `kernel_init` cfg +96; compared with `main.npdm` |
| `mem_used` | a | 37 | `kernel_init` cfg +88 |
| `mem_map_limit` | a | 5 | `kernel_init` flag 1 |
| `pad_layout` | a | 83 | which controls the game needs (simple / full / touch): a hint for on-screen controls |
| `op_mode`, `perf_mode`, `alloc_big_align` | a | 8, 2, 5 | `hle_cfg` `CFG_OPMODE`, `CFG_PERF_BOOST`, `CFG_ALLOC_BIG_ALIGN` |
| `launch_param`, `game_env` | a | 2, 1 | `hle_cfg_str` `STR_LAUNCH_SPEC`, `STR_GAME_ENV` |
| `render_cond` | a | 10 | the recorder, `gfx_set_profile` bit 1: `SetRenderEnable(Conditional)` evaluated when a submission is lowered; a timestamp report writes counter 0 (`src/gfx/README.md`, "Counter reports and conditional rendering") |
| `tex_flush_upload` | a | 12 | the recorder, `gfx_set_profile` bit 2: textures in pools the CPU writes are registered and a pool flush over one publishes it (`src/gfx/texwatch.ts`) |
| `tex_dirty_upload` | a | 11 | the recorder, `gfx_set_profile` bit 4: registered textures are hashed in full by a scanner, 4 MB a submission, where nxnative tracks page writes (`src/gfx/texwatch.ts`) |
| `gpu_timestamps` | a | 5 | the recorder, `gfx_set_profile` bit 8: a timestamp report takes the GPU start / end of the segment it lies in; the submission is cut every 64 draws at a target change (`src/gfx/README.md`, "Counter reports") |
| `present_interval` | a | 8 | the recorder, `gfx_set_profile` bit 16, and the acquire: `display` = one frame a vsync whatever the game sets, which it also reads back (`src/gfx/README.md`, "Frame pacing") |
| `game_args`, `shared_font`, `device_api` | a | 0 | documented keys no profile sets |
| `ipa`, `app_category`, `zip_store` | b | 153 each | iOS packaging |
| `mem_reserve`, `mem_alias`, `mem_stack` | b | 153 each | the Apple host's guest block; the regions they give are what the runtime's per-game layout starts from (see `address_space`) |
| `shader_versions`, `shader_note`, `shader_groups` | b | 153, 153, 148 | bookkeeping of nxnative's offline shader tables |
| `depth_mode` | b | 52 | for Metal pipelines made before the game runs; nxweb takes the game's `nvnDeviceSetDepthMode` |
| `pso_mtl4`, `pso_gpu`, `enc_thread`, `present_snap`, `draw_barriers`, `vconv_range` | b | 1, 0, 1, 1, 1, 1 | Metal replayer settings and optimizations |
| `core_preempt` | b | 0 | a remedy over pthreads; nxweb's kernel schedules itself |
| `jit_key_data`, `jit_out_code`, `jit_route` | b | 1 each | the nn::jit image an iPhone is served; nxweb translates at run time |
| `address_space` (derived) | c | 14 | the runtime's layout rule answers "short" for the profile's regions (below) |
| `fps_target` | c | 33 | `hle_fpslock.c`, FRAME_STEP stubs, the engine finders |
| `fps_max` | c | 6 | 120 fps |
| `tex_dyn_slots` | c | 4 | Ryujinx's fallback texture arrays in the shader chain |
| `fps_hold`, `program_of`, `screen_aspect`, `shader_key_skip`, `snowdrop_pools`, `stdalloc_cap` | c | 2 each | frame holding; multi-program games; screen-shape stubs; masked shader keys; Snowdrop's pools; StandardAllocator cap |
| `programs`, `render_base`, `ue_fps_cvar`, `ue_texture_pool` | c | 1 each | multi-program launcher; render scale stub; Unreal console variables |

**Counts over the 153 profiles** ((profile, key) pairs): **a 1,535, b 1,432, c 73**. Keys known to the converter: a 25,
b 20, c 14 (22, 18 and 14 of them set by some profile). **The class c keys some profile sets** are these 14:
`fps_target` 33, `address_space` 14, `fps_max` 6, `tex_dyn_slots` 4, `fps_hold` 2, `program_of` 2, `screen_aspect` 2,
`shader_key_skip` 2, `snowdrop_pools` 2, `stdalloc_cap` 2, `programs` 1, `render_base` 1, `ue_fps_cvar` 1,
`ue_texture_pool` 1.

### The address space: the runtime's verdict

Whether a game's memory keys fit is not decided here. The converter computes the three regions a profile reserves
(nxnative `hle_svc.c`: the heap region is `mem_reserve - 256 MB - mem_stack - mem_alias`) and hands them, with the
profile's `app_pool`, `mem_used` and `sys_resource`, to **the function a process is laid out with**: `settingsFor` /
`layoutFor` of `src/glue/rt_process.ts`, run by `tools/prepare/layout_verdict.mts`. No number of the layout is
written in the converter. What it answers is stored in the profile (`address_space`: the regions, `fit`, `note`, the
sizes the process gets) and in `report.json` (`address_space`: the rule's name and constants, and the profiles of
each verdict by title ID, with the rule's sentence for those that do not fit as reserved):

| `fit` | Profiles | Meaning | In the profile |
|---|---|---|---|
| `profile` | 44 | the regions fit as reserved | nothing listed |
| `pool` | 95 | the regions are cut to the address space there is, and still hold everything the pool lets the game commit | nothing listed; the page shows the sentence under Memory |
| `short` | 14 | not even that (11 Switch 2 titles with a 9 GB pool; 3 whose heap and alias regions are both large) | a `needs` entry `address_space` (class c) with the rule's sentence; the runtime starts the process with what there is and one red line |

The prepare step hands the regions over (`HandOff.profile.space`) and the runtime calls the same function on them
(`handoffOptions`), so the verdict in the files is the layout the process gets; `prepare:profiles:check` and the test
"the converted profiles" fail when the rule changes and the files were not converted again (the test also calls
`settingsFor` on every profile and compares). "Fits" is arithmetic on the profiles: no game has run.

A key the converter does not know stops it with a red line (a new nxnative key must be classified).

## Code patches

What `dm/tools/patch_nso.py` does, sorted:

| | What | Here |
|---|---|---|
| Native execution on Apple only | x18 reads and writes to a thread slot; `tpidr_el0` / `tpidrro_el0` through slots; `svc` and `cntpct_el0` gates; `sub sp, sp, xN` alignment; acquire / release ordering on exclusives; Trinity's `dmb ish`; the jump-table and exclusive-window analysis that makes those sites relocatable; patch-area layout | Dropped: the translator implements the instructions, the kernel takes `svc` directly, there is no host kernel to appease |
| | `engine_patches.py`: Unity 2018 `ThreadedStreamBuffer` plain loads → load-acquire | Dropped while guest threads run on one Worker (every interleaving is sequentially consistent). Needed again with threads on Workers |
| Game knowledge | **Registered cuts** (`CUTS`, by build ID) in `patches.py` and `sdk_patches.py` | **Converted and applied: 69 of 69** |
| | Function-matched cuts (`MATCH_CUTS`: 4 rules in 3 profiles, 12 SDK-wide, 1 engine-wide) | **Converted: 17 of 17, and matched in the page** (`match.ts`, below) for modules whose build no registered cut names |
| | Frame-step and screen-shape stubs (`FRAME_STEP`: 5 builds, 176 sites, 5,179 stub words; `MATCH_FRAME_STEP`: 4 rules) | Not converted: code in a patch area beside the module that reads a state page the host writes each frame. What the runtime lacks is listed in `docs/PORTING-STATUS.md`, "Frame-step stubs"; `report.json` names the 8 profiles |
| | Observation gates (`OBS`) | None registered in any patch file today (0 of 0); the rewriter's own gates (address regions, Unreal) are placed by the finders below |
| | Rewrites found by code in any build (9): `ue_cvar`, `fps_target`, `ue_fixed_rate`, `unity_fps`, `ue_malloc`, `unity_bucket`, `snowdrop_pools`, `ue_region`, `ue_ring` | Not ported |
| | Spin-wait loops | Nothing needed for correctness, see below |

**Conversion is mechanical.** Each patch file is executed, not imported, in a namespace whose builtins are a short
whitelist and whose only importable modules are `struct` and nxnative's `nso_asm` (its 28 lines evaluated the same
way). `CUTS` are data once evaluated: 66 cuts in 15 builds of 22 patch files, 3 in 1 build of `sdk_patches.py`, all
with byte strings of equal length (checked). `MATCH_CUTS` are data too, and each rule is checked as nxnative's
`nso_match.validate` checks it (sizes, fingerprints, cuts inside their function and not overlapping, no PC-relative
replacement except a branch that stays inside the function); a rule that fails is a red line and exit code 1.
`FRAME_STEP` functions are called with a recording context (which is how the 176 sites and 5,179 words are known),
but what they write branches into a patch area and addresses a state page, neither of which exists here.

**A patch file the sandbox cannot evaluate is skipped, not fatal.** A newer nxnative has a `patches.py` that imports
`nso_match`; the converter used to stop on it. Now a file that imports a module the sandbox does not provide, uses a
builtin outside the whitelist, or raises while it is evaluated leaves its profile converted from `game.tsv` alone:
no cuts, `patches: { converted: false, reason }`, an `unconverted` entry of kind `PATCH_FILE` (the page lists it),
the file in `report.json` (`conversion.patch_files_skipped`), a summary at the end of the run, exit code 0. The
same holds for `sdk_patches.py` and `engine_patches.py`. `--strict` makes it a failure again. Tested on a synthetic
tree made in the test (five profiles; nothing is fetched). `nso_match` itself is not offered to the sandbox: no
patch file of the pinned checkout imports it, so what one would need from it is not known, and the module needs
Capstone, classes and `nso_code` (not small, and not something to evaluate in a sandbox on a guess).

**Application** (`cuts.ts`): the module is unpacked (hashes checked), each cut's original bytes are compared with
the image at its offset **byte for byte, in order, and the first mismatch stops everything** with nxnative's line
(`cut original bytes mismatch 0x...: the module has ..., the cut expects ...`); nothing is written then, and the
machine ends `Failed(cut)`. Otherwise the image is written as an NSO again (stored segments, three new hashes,
which the loader verifies) under the same build ID. The translator therefore sees only cut code and needs no hook:
every converted cut is a same-length byte replacement. `TranslatorHook` (return a constant, skip a call, call a
host function at a pc) is defined in the hand-off for patches that are not: none converts to one yet.

Which cuts a game gets: its profile's by build ID, then `_sdk.json`'s by the build ID of whichever module has it
(the SDK cuts shorten the address-region manager's node area, which a 32-bit alias region needs even more than an
iPhone's 4.375 GB). A module whose build has neither gets the function-matched rules.

### Function-matched cuts (`match.ts`)

nxnative's `dm/tools/nso_match.py` places a cut in a build nobody registered by finding the function it lies in. A
rule holds a function's size, one or more fingerprints and cuts at offsets from the function's start; a rule of
several functions applies whole or not at all; rules of one name are one patch's reviewed implementations, of which
exactly one must match. As in nxnative (`patch_nso.py`): rules are tried only on a module whose build has no
registered cuts (an empty list counts as registered); the selected profile's rules (`match_cuts` by module name)
are one list and a miss is a red line; `_sdk.json`'s (`sdk_patches.py` and `engine_patches.py`: for every game's
module of that name, whatever the profile, also with no profile) are another and a miss is a plain line; cuts of
one list that overlap stop the prepare (`Failed(cut)`). What is found goes through the same `cutApply` as a
registered cut, with every original byte compared, and into the hand-off's `cuts` (so into the translation cache
key).

The fingerprint is SHA-256 over the function's words with only relocation-dependent bits masked, and over what
each branch that leaves it leads to (an imported name through the PLT, `svc #n; ret`, or another function's size
and masked body). `match.ts` reads the functions from `.eh_frame_hdr` as `nso_code.py` does and computes that
number. Two things in `nso_match.py` come from Capstone and had to be replaced:

- *Which register an instruction writes.* After an ADRP the low part of the address is masked in the first add /
  load / store on its register within eight instructions, unless a branch or a write to the register comes first;
  "a write" is Capstone's `regs_access()`, which is not the architecture's (`cmp x1, #1` is listed as writing x1,
  `adds w3, w2, #1` as writing nothing). `gen/match_writes.ts` is that list **measured from Capstone**
  (`tools/prepare/gen_match_writes.py`: 43 instruction classes, 48 samples for each value of a class's opcode
  bits, 4,316 runs of keys). A key that was not regular in every sample, and a word in no class, counts as writing
  every register. That direction is the safe one: it masks less than nxnative did, so the fingerprint differs and
  the patch is not placed; it can never make two different functions agree.
- *Every word of the function decodes.* Not checked here. Decoding depends on no bit a fingerprint masks, so a
  function that equals a reference function in every unmasked bit decodes exactly when the reference does; a
  function Capstone refuses gets a fingerprint here that no rule can hold.

An imported name with a byte outside printable ASCII, a quote or a backslash is not taken (JSON would escape it):
its callers have no fingerprint.

**Checked against nxnative itself** (test "function fingerprints are nxnative's", when the checkout and Capstone
5.0.7 are there; otherwise it prints SKIPPED, and CI installs Capstone unpinned): the runtime's and the translator's test sources are compiled once more with unwind tables (92 modules,
clang -O2 and -Os, 956 functions with four hand-made images) and every function's fingerprint is compared with what
`dm/tools/nso_match.py` gives: **937 equal, 28 without one on both sides, 4 that nxnative refuses for an
undecodable word, 0 different**. The write table is compared with Capstone on 300,000 more words (105,051 decode:
87,522 as Capstone lists them, 17,529 counted as written where Capstone lists less, **0 the other way**). The table
names its Capstone version (5.0.7); with another version installed both comparisons print SKIPPED. No game module
was matched: nxnative's 17 rules are tried on the test module (none matches, as it must) and the mechanism on
self-made code, where a rule made from a function finds it again after relocation and the game runs with the cut.

Cost: a module that has rules and no registered cut is unpacked and hashed twice (once to match, once to cut), and
nxnative's rules for every game mean that is `sdk` and `main` of every unregistered build.

**Spin waits.** nxnative copies a loop that polls memory behind a gate so the host can yield: on Apple hosts each
guest thread is a host thread, and a spinner takes a core from the thread it waits for. Here the translator counts
budget on every backward branch and returns to the run loop when it is used up, and the kernel then schedules by
priority and core as Horizon does: a spinner is preempted like any thread and the thread it waits for runs. So
**nothing is needed for correctness**, and nothing was built. What remains is cost: a spinner burns its whole slice
(100,000 budget units) each time it is scheduled, on the one Worker everything shares. If a game shows that, the
place for a remedy is the translator (it sees the loop when it translates it; nxnative's criterion, "no store, call
or SVC, no live register written", is checkable there), not a rewrite of the module.

## Shaders stage

The stage records "translate on demand, cached": the runtime's `RtShaders` with `workerTranslator` and
`webShaderStore` (`src/glue/rt_shaders.ts`) does the work when the game first binds a program; prepare hands over
the chain version and store name and does nothing ahead. The stage exists so that a pre-warm has its place in the
machine and the manifest.

**The pre-warm is not in this round**, except the BNSH container scan (`bnsh.ts`): the reader as
`shader_split.py` `bnsh_shaders` / `check` / `skey` have it, tested on a synthetic container built in the test from
the hand-assembled Maxwell programs of `tools/shaders/maxwell_asm.py`: every stage is found and its key is the one
the chain computes. What a pre-warm would still need, counted in `shader_split.py` (3,250 lines, 167 functions):
BNSH is 1 of the 27 source kinds its header lists; the others include BAHS, Unity bundles and serialized files,
GLSLC outputs in `main`, Unreal shader archives (Oodle, decoded by the game's own code in nxnative), MonoGame
effects and some twenty engine archives, with six helper modules (`cra`, `cpk`, `frostbite`, `smash_arc`, `unityfs`,
`vbf`). Even for BNSH alone a pre-warm needs the wrappers it sits in: zstd, Yaz0 and SARC. NVN2 control sections,
task and mesh stages and `shader_key_skip` are not read here (reported per stage, not dropped silently).

## Verified

`npm run prepare:test` (30 tests; the last seven are the container's and the verdict's, described below): SHA-256 against node:crypto; NPDM fields and 5 refusals; build IDs and damaged
modules; **11 layout variants** and **24 malformed folders**, each with its reason; RomFS paths that cannot be;
the entry-API tree with stand-in entries; the directory device against `mkromfs.py`'s reader; a cut applied (exit
code 42 → 7 and changed read-only data, in the runtime) and refused (mismatch, out of range, malformed); **the whole
pipeline ending in a process that runs in the runtime's harness** and reads its RomFS from the folder, with a
profile's cut applied and a second module loaded; update layering and DLC devices; **stage skipping by hash** (unchanged, a RomFS file touched, resized, a module touched, a new cut, another version asked) and redo of each stage; **a kill at each of 15 points** (5 stages × begin, work, end) and twice in a row,
each resumed and run; cancel in each stage; profile selection by title (the converted nxnative profiles), by build,
none, and a mismatching registered cut; the converted files against a fresh conversion, every rule's shape, and
every profile's address-space verdict against `settingsFor`; the machine; BNSH; **function-matched cuts**: 17
groups of cases on hand-made images (relocation, changed code and callees, imports, system call wrappers, ambiguity,
several functions, several implementations, overlap, damaged unwind data, 400 mutations), the fingerprints and the
write table against nxnative and Capstone, and the pipeline (a patch placed by its function, the game exits with
7 instead of 42); **the converter on a synthetic nxnative tree** (patch files it cannot evaluate, `--strict`).

Containers (`test/prepare/nup_tests.mts`): the listing and bytes of a synthetic container with raw and zstd files
(open reads the superblock and table only; of a 9 MB raw file only the range asked for is read); **44 damaged or
malformed containers**, each refused with its reason (bad magic, format version, a truncated and a grown file, the
table's hash, records out of bounds, reserved fields, codecs, a folder that holds itself, `scan`'s refusals, ExeFS
names), and a changed byte of a raw file and of a zstd frame found when the file is read, also through the pipeline
(`Failed(read)`); **the whole pipeline on a container** (a profile by title ID with a registered cut; the guest
reads its RomFS out of the container and runs with the cut; version 0; the DLC device; all five stages kept on a
second run with 0 bytes read; a changed file runs Index); the variants (an update without `romfs/`, standalone
updates, a base record with no files, a partial update, other package kinds, a foreign DLC, a 32-bit program, the
NACP reader); the hand-off message read back through the device with the cache bounded (62 MB read, 35 MB peak);
the comparison with nxnative's reader; the verdict for all 153 profiles (14 can't run for memory, each with its
sentence), main's imports, and 15 kinds of files explained.

`npm run prepare:browser` (13 tests, Chromium 153): **a `.nup` chosen through the page, Play, the guest runs in a
Worker** reading its RomFS out of the container with `FileReaderSync` (frames decompressed and checked there); a
`.nup` as a dropped file handle, continued after a reload from IndexedDB, and through `showOpenFilePicker`; the
pickers refused (`SecurityError`), closed (`AbortError`) and missing; eight things that are not a game explained,
a folder with one `.nup`, and the can't-run verdict with *Try anyway*; and, as before: the page through `showDirectoryPicker` (replaced by a function
that returns an OPFS directory: headless Chromium has no dialog; everything after the call is real), a dropped
directory handle, `<input webkitdirectory>` with a real folder; the manifest in OPFS; **a reload in the middle of
Code and of Index, resumed from the handle kept in IndexedDB**; cancel; redo; **Play: the message posted to a Worker
that starts the game in the runtime**, RomFS read with `FileReaderSync`; listing latency.

`npm run kit:test`: the prepare machine's 24 transitions, every other pair refused.

## Gaps

- **No encrypted containers, no keys**: NSP / XCI / NCA are not opened (the page says what they are). A dump folder
  has no NACP: its name is the profile's, or the NPDM's.
- NUP: a file is decompressed in one piece, so a file stored compressed must fit one `Uint8Array` with its
  compressed bytes beside it (about 2 GB decompressed is the engine's limit; a few hundred MB is what a phone
  gives); a raw file has no such limit. A raw file over 8 MB that the game reads in pieces is never checked
  against its SHA-256 (only a read of all of it is). The table of contents is read whole (0x50 bytes a file, at
  most 1 GB). zstd frames with a dictionary are not supported by fzstd (the format has none). Parsing and
  decompression run on the thread that asks: the page's main thread during prepare, the Worker during play; a
  large module's decompression blocks the page for its duration. The container reader is TypeScript (as
  `detect.ts`), not AssemblyScript; the hash is the module's. `addon_update` and `system` packages are not used.
- The graphics interface is read from `main`'s imports only: a game whose drawing code is in another module or an
  NRO reads as "not known" and gets no verdict from it. No game was tried: OpenGL and Vulkan games are recognised
  by the names nxnative looks for.
- The verdict is a prediction from profiles and files; "should start" has not been observed for any game.
- No game was prepared: every folder in the tests is synthetic (the runtime's test guests as modules).
- `FRAME_STEP`, `MATCH_FRAME_STEP`, the nine finders: not ported (above; `docs/PORTING-STATUS.md`, "Frame-step
  stubs"). `MATCH_CUTS` is, but no rule has been matched on a game module, and a function with an instruction the
  write table does not know between an ADRP and its use (rare in compiled code: none in the 956 test functions) is
  not found where nxnative finds it.
- The register-write table is Capstone 5.0.7's. nxnative does not pin a Capstone version; a rule whose fingerprint
  was made with a version that lists writes differently is not found here (a miss, never a wrong match).
- The profile's class (a) values are handed over, not applied: nothing in the runtime takes a profile yet
  (Requests). `romfs_marker` only warns.
- The pipeline runs on the page's main thread; checking and hashing a 100 MB module blocks it for its duration. The
  module's arena grows to about three times the largest module and is freed only with the instance (one per picked
  folder).
- The listing is paid at every start (9.5 s for 50,000 files in Chromium). Hashes are over name, size and time: a
  file changed in place with both kept is not noticed.
- Names that are not valid UTF-8 cannot come through the browser's file APIs and were not tried. `<input
  webkitdirectory>` cannot report empty directories.
- Only Chromium was run. `OpfsStore` uses `createWritable`; the Resume button needs a storable directory handle
  (File System Access). **In Chromium 153 an OPFS directory handle read back from IndexedDB in an off-the-record
  context takes the browser down**: the browser test uses a profile directory for that reason.
- ZBIC (zstd) NSOs are refused by the loader's reader, so by Code (`module`).
- Multi-program games (`programs`): the program in the folder is prepared alone.

## Requests to the integration owner

Answered in the integration round (src/runtime/README.md, "The address space per game" and "The page"): 1 (the
main page takes `nxweb:handoff` from this page in a frame and its Worker builds the process: `web/worker.ts`,
`src/glue/rt_handoff.ts`; `npm run web` builds and serves both), 2 (`settingsFor`: the kernel's cfg block, the
take-over table's configuration, the stack size), 3 (`cutsKey`: a hash of a module's applied cuts in its cache key),
4 (the layout is chosen per game: 139 of 153 profiles fit, 14 do not; memory64 measured and not recommended now; the prepare step's verdict is that function's), 5,
6 (`prepare:test` in `npm test`, `prepare:browser` in the CI browser job, rows in the docs). Open: 7.

1. **Take the hand-off**: listen for `nxweb:handoff` (or call `prepare.handoff()`), post the message to the Worker,
   `storageFromMessage(msg, new OpfsStorage(msg.saveId))`, `loadNso` the module Blobs. `web/build.mts` can call
   `buildPreparePage()` (`web/prepare_build.mts`) so `npm run web` serves the page.
2. **Apply `profile.apply`**: `Runtime` calls `kernel_init(0)`; the kernel already takes `app_pool`, `mem_used`,
   `sys_resource`, the program ID and the `mem_map_limit` flag in its cfg block, and `hle_cfg` / `hle_cfg_str` take
   `op_mode`, `perf_mode`, `alloc_big_align`, `game_env`, `launch_param`, the display version. `npdm.stackSize` →
   `mainStackSize`.
3. **Translation cache key**: a cut module keeps its build ID. Add a hash of `HandOff.cuts` for the module to the
   key (`build id @ address / options`), or a stale translation of the uncut code is reused.
4. **Address space**: answered by the per-game layout; the prepare step now reports its verdict (above) instead of
   a comparison of its own.
5. The kit tables were regenerated for `prepare` (it sorts before `runtime`, so `PROCESS` moved): every kit module
   needs its build; `rt:build` was run here.
6. CI: `prepare:test` in the fast tier, `prepare:browser` in the browser job; rows for prepare in
   `docs/ARCHITECTURE.md` and `docs/PORTING-STATUS.md`.
7. For `FRAME_STEP` (5 games' 60 fps and screen shape): a patch area in the loader's map, a per-frame state page
   and the frame-step driver (`docs/PORTING-STATUS.md`, "Frame-step stubs", has the list); then the recorded stubs
   can be emitted. For `OBS`-style patches: a translator hook at a pc.
