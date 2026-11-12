# runtime: translator + loader + kernel as one guest process

The first place where the three pieces meet. A `Runtime` (`src/glue/rt_runtime.ts`) holds one guest process: it puts
the kernel, the loader, the runtime core, the translator's core CPU module and every translated unit on **one**
linear memory, loads NSO files, and runs guest threads in a loop that the kernel's scheduler drives.

| File | What |
|---|---|
| `src/glue/rt_layout.ts` | The one table of the host area's ranges (TypeScript constants; the build and the start check read it) |
| `src/glue/rt_runtime.ts` | `Runtime`: memory, instances, loading, the run loop, host-call dispatch, fault capture. No Node APIs |
| `src/runtime/index.ts` | Runtime core (AssemblyScript, in the shared memory): the `process` machine, the fault report, the deterministic clock's arithmetic, the range-table check |
| `src/runtime/defs/process.json` | The process lifecycle (diagram: `docs/machines/process.md`) |
| `src/glue/rt_gfx.ts` | NVN attached to a process: recorder instance, NVN stubs, the waits on the GPU, frame pacing, release of GPU objects |
| `src/glue/rt_input.ts` | The embedder's input sources (keyboard, controllers by source id, scripted steps) merged and published to the take-over table (`hle.input`) |
| `src/glue/rt_audio.ts` | nn::audio (`src/audio`) attached: take-overs to `audio_call`, ticks and deadlines, SystemEvents, the device's runtime side |
| `src/glue/rt_process.ts`, `rt_handoff.ts` | A process's address-space layout and settings from the game's profile; the prepare step's hand-off as process options |
| `src/glue/rt_report.ts` | What the page shows of a process: modules, take-overs, the kit's machines, the bug report text |
| `src/glue/rt_shaders.ts`, `rt_shader_worker.ts` | Shader lookup: library, store, in-page translation in a Worker |
| `src/glue/rt_fs.ts` | The file system (`src/fs`) attached: nn::fs names to `fs_call`, parking on pending / retry |
| `src/glue/hle_rt.ts` | The SDK take-over table (`src/hle`) attached: nn::oe, time, account, network, libc, and now nn::vi, nn::hid, nn::ro and nn::jit (one answer per name) |
| `src/runtime/host/build.mts` | `npm run rt:build`: `build/runtime/{rt,kernel,loader,gfx,fs,hle,translator,helpers}.wasm`, each with a kit stamp |
| `test/runtime/cases.ts` | The end-to-end tests, shared by Node (`run.mts`) and the browser Worker (`web/worker.ts`, `browser.mts`) |
| `test/runtime/more_cases.ts` | The cases that wait for something: translation cache, restart, file system, take-over table, shaders |
| `test/runtime/src/` | The test modules (C and assembly), built into NSOs by `harness.mts` |
| `test/runtime/gfx_cases.ts` | The graphics tests (null replayer under Node, WebGPU and pixel readback in the browser) |
| `test/runtime/int_cases.ts` | Controllers, audio, the NVN waits, device loss, the robustness sweep |
| `test/runtime/guard_bench.mts` | `npm run rt:guard`: the guard's cost measured alone, with paired statistics |
| `test/runtime/all.mts` | The root `npm test` |
| `web/` | The page: `index.html`, `main.ts` (page), `worker.ts` (runtime), `build.mts`, `serve.mts` |

```
npm run rt:test [-- <filter>]      # Node
npm run rt:browser [-- <filter>]   # headless Chromium through Playwright, in a Worker
npm test                           # kit, loader, kernel, a64 guests, runtime
npm run web                        # build build/web and serve the page on http://localhost:8080 (COOP/COEP set)
```

## Memory

One `WebAssembly.Memory({ initial: 2048 pages, maximum: 65536 })` for everything: the kernel, the loader, the runtime
core, the graphics recorder, the file system, the take-over table, the translator, its helpers and every translated
unit import it. Guest addresses are offsets (contract). The guest side is the kernel's default layout
(`src/kernel/README.md`); the host side, 0 .. 0x0800_0000, is this table (`rt_layout.ts`; sizes in address order, so
two ranges cannot overlap, and `rt_ranges_check` refuses a table with a hole, an overlap or an empty range before
anything runs):

| Range | From | To | Holds |
|---|---|---|---|
| null guard | 0x0000_0000 | 0x0001_0000 | nothing |
| rt static | 0x0001_0000 | 0x0010_0000 | `src/runtime` static data: process machine, fault record, clock, scratch, kit trace |
| loader static | 0x0010_0000 | 0x0020_0000 | `src/loader` static data |
| loader arena | 0x0020_0000 | 0x0080_0000 | module records, export tables, names (`ld_init`) |
| kernel static | 0x0080_0000 | 0x0180_0000 | `src/kernel` static data; 14 MB of it is the static leaves of the alias page table (3.5 GB of mapped alias region; more in a 64-bit memory comes from the top of the code region) |
| gfx static | 0x0180_0000 | 0x0190_0000 | `src/gfx` static data |
| gfx arena | 0x0190_0000 | 0x0390_0000 | `gfx_init(arena, gfx_arena_bytes())` |
| file staging | 0x0390_0000 | 0x0490_0000 | module file bytes when they are small (16 MB): the start set of a small program until it is pinned, modules loaded at run time; its free tail is scratch for hashing and entry lists. A larger start set is staged in the guest's own regions: "File staging" below |
| fs static | 0x0490_0000 | 0x04A0_0000 | `src/fs` static data |
| fs arena | 0x04A0_0000 | 0x0510_0000 | `fs_init`: RomFS tables of the mounted images, save trees (7 MB) |
| a64 translator | 0x0510_0000 | 0x0610_0000 | the translator's static data and buffers |
| a64 helpers | 0x0610_0000 | 0x0611_0000 | the helpers' static data |
| a64 entry bits | 0x0611_0000 | 0x0691_0000 | one bit per instruction of the 256 MB code region |
| pc map | 0x0691_0000 | 0x07DC_0000 | two-level pc map: first level (256 KB), zero leaf, then a 64 KB leaf per touched 64 KB of code |
| **hle static** | 0x07DC_0000 | 0x07EC_0000 | `src/hle` static data. **`GUARD_BASE`: from here on the guest may read and write** |
| audio static | 0x07EC_0000 | 0x07FC_0000 | `src/audio` static data and the device ring; its 16 MB arena is host-allocated (`hostAlloc`) at the first nn::audio call |
| host stubs | 0x07FC_0000 | 0x0800_0000 | the loader's stub region: 65536 stubs of 4 bytes |
| code | 0x0800_0000 | | modules, mapped one after the other with a free page between them; above them `hostAlloc` pages |
| heap, stack region, alias region | 0x1800_0000 | 0xFFFF_0000 | per process: the default (heap 1.5 GB, stack region 256 MB at 0x7800_0000, alias 1.87 GB) or the split chosen from the game's profile ("The address space per game") |

**File staging: a module file of any size.** The loader needs each file in linear memory until its module is
pinned, and a game's `main` is 20 to 150 MB on disk or more. The fixed range stays 16 MB (a range sized for the
largest game would be address space and memory every program pays for). `loadNso` adds up the files of the start
set, each on a page:

- they fit the fixed range: staged there, as before;
- they do not: the memory is grown and they are staged **from the base of the process's heap region on**, across the
  stack and alias regions when the heap region is small (the three follow each other without a gap in a layout made
  by `layoutFor`; the default: 0x1800_0000 .. 0xFFFF_0000). Nothing is mapped there while the process is loaded, and
  it is memory the game commits anyway, so no address space is reserved and the pages are used again by its heap.
  One log line says so (`runtime: N bytes of module files are staged from the heap region's base ... on`).

The modules of a start set are **pinned as soon as they are relocated** (`Relocated → Pinned` in the module machine:
they are never unloaded, so nothing maps them from the file again), then the fixed range is free again and what was
staged in the guest's regions is zeroed, before the main thread's stack is mapped and before any guest instruction
runs: the guest cannot see the bytes, and SetHeapSize and the mappings find the zeroes the kernel expects of memory
it never handed out. A load that fails cleans up the same way. The table above stays the one description of the
host area (`STAGING` in `rt_layout.ts` names the rule); the host-area guard is untouched, since the staged bytes are
written by the host and gone before the guest runs.

What remains as limits, each a load fault with its figures (`[RED] fault: load failed: ...`), never a cut file:
the files together must fit the guest's data regions and the host must let the memory grow that far (`the linear
memory cannot grow from .. to ..`); every image must fit the **code region**, which is 252 MB by default and is
sized per game by `layoutFor({ code })` (the page and the hand-off pass the images' sizes from the NSO headers,
`nsoImageBytes`; a larger code region is address space the heap, stack and alias regions do not have); the
loader's own bounds (a segment below 2 GB, an image below 4 GB). A module loaded at run time (`loadModule`) that
does not fit the fixed range is staged in `hostAlloc` pages of the code region, where it stays (a reload maps it
again). Measured: a 41.6 MB file (72 MB image) loads in about 0.5 s under Node; with `RT_HUGE=1`, a 256 MB file
with a 512 MB image loads in 2.4 s on `layoutFor({ code: 512 MB })` (code region 578 MB, heap region 1.5 GB) and
runs to completion. The translator's entry bitmap still covers the first 256 MB of the code region only: function
entries the loader knows beyond it are not marked (those functions are found when they are first called).

How each module gets its place: `asc --importMemory --zeroFilledMemory --memoryBase <range.lo>` (`host/build.mts`;
the translator and helpers through `src/a64/host/build.mts`, which `npm run a64:build` runs too: the bases come from
this one table and `A64Host` refuses binaries built for another). None of the modules has a heap (`--runtime stub`,
static data only), so "static data ends below the range's end" is the whole check: `rt_static_check` compares each
module's static end with the table at start. Without `--zeroFilledMemory` asc writes every zero byte of the static
data into the wasm file (kernel.wasm: 8.9 MB instead of 24 KB) and into memory at instantiation.

**The pc map** is the translator's (`src/a64/README.md`): two levels over all 4 GB of guest addresses, leaves
allocated on demand from the "pc map" range, so a module may be mapped anywhere in the code region (tested at
0x1600_0000). The range holds 326 leaves, that is 20 MB of code with at least one translated function per 64 KB; past
that a leaf is 64 KB from `hostAlloc`, a page of the code region above the modules (`leafAlloc` of the translator's
host). Such a leaf is outside the host area, so the guard does not keep a stray guest write out of it. When the code
region has no room left the error is "the pc map's leaf arena is full and there is no room left to extend it".

**Code ranges.** Each module image is one `addCode(base, imageSize, { text, entries })`: the text bounds keep data
out of the translator's scans, and `entries` are the function entries the loader knows (`ld_code_entries`: defined
function symbols, DT_INIT / DT_FINI, the init and fini arrays, relative relocations whose value points into the
text). `removeCode` forgets a module that is unloaded. Flat test guests keep the one-window `setCode`.

**Growth, not reservation.** The memory starts as the 128 MB host area and grows when something needs it: `ensure()`
for module images, the kernel's `commit()` for the heap, stacks and thread-local slots. Because the main thread's
stack is at 0x7800_0000, the first load grows it to 1921 MiB of *address space*. Measured: creating the memory at
4 GB at once costs 3 ms and no resident memory under Node 22 (RSS 43 -> 46 MB), growing from 128 MB to 1.9 GB 4.7 ms
and none; in Chromium a runtime is created and loaded in 15 ms growing and 8 ms reserving. Growing is the default
because it keeps addresses above the memory's size trapping. `RuntimeOptions.reserve4g` switches.
What is not free: `kernel_init` initializes one kit instance per alias page, 8 MB touched and about 5 ms per process.

**Not `shared` by default.** The memory is not a SharedArrayBuffer unless the embedder asks (next section): the
runtime runs every guest thread in one Worker either way.

### Shared memory (`shared: true`, default off; the page's `?shared=1`)

The first step towards guest cores as Workers, and nothing more: the whole runtime as it is (one Worker, one core
instance, cooperative guest threads, the same scheduler) on a **shared** `WebAssembly.Memory`, with the translator's
shared code generation (`src/a64/README.md`, "Shared memory"). No speed-up is expected from it; what it shows is
that every module, the glue and the page work with a `SharedArrayBuffer` behind the memory.

- **The memory.** memory32: `new WebAssembly.Memory({ initial, maximum: 65536, shared: true })`; memory64:
  `makeMemory64({ ..., maximum: MEM64_MAX_PAGES, shared: true })`. A shared memory has its maximum reserved as
  address space when it is made (4 GB, 16 GB) and never moves; it still grows on demand, and after a grow
  `memory.buffer` is a new, longer SharedArrayBuffer while the old one stays valid at its old length (the glue makes
  its views from `memory.buffer` at each use, as before).
- **The modules.** A module links to a shared memory only when its own memory declaration says shared with a
  sufficient maximum. For rt, kernel, loader, gfx, fs, hle and audio that declaration is the only difference of
  an `asc --sharedMemory --maximumMemory N --enable threads` build (the stub runtime uses no atomics), so their shared
  form is not a second build: `src/glue/wasm_shared.ts` `sharedBuild(bytes, maxPages)` rewrites the limits of the
  normal binary where it is loaded (the page, the test harnesses), for an imported memory and for one the module
  defines. The translator and helpers are the asc-built `translator.shared.wasm` / `helpers.shared.wasm` (and
  `…64.shared.wasm`); the core, the units and the runtime's small register module are generated shared. A set that
  does not match the option fails at once with a `runtime: rt.wasm does not link to the … memory` error.
- **The translator.** `shared: true` reaches `A64Host`: LDXR/STXR are an atomic load and a compare-exchange,
  LDAR/STLR and the LSE instructions wasm atomics, DMB a fence. `optionsKey()` contains the option (and, in memory64,
  the declared maximum), so the mode has its own entries in the translation cache: the first run in the mode
  translates everything again, and the normal mode's entries are untouched.
- **Misaligned atomics.** ARM performs an exclusive or LSE access at an address that is not a multiple of its
  size; a wasm atomic traps. The fault is a trap fault with the guest pc: `an atomic access at a misaligned
  address: the instruction 0x… at guest pc 0x… (… through xN = 0x…): ARM performs it, the wasm atomics of the
  shared-memory mode trap`. Nothing emulates the access: a program that does this does not run in the mode.
- **Browser APIs.** `TextDecoder.decode`, `crypto.getRandomValues`, `Blob`, `Response` and message clones to a
  `BroadcastChannel` refuse a view on a SharedArrayBuffer; the glue already copied at those places (`.slice()` of a
  typed array on a shared buffer is an ordinary one). WebCodecs chunks and the OPFS access handle now get a copy
  when the view is shared (`unshared()`, `fs_dev_opfs.ts`), although both are specified to take one. WebGPU's
  `queue.writeBuffer` / `writeTexture` are specified to take shared views and get them uncopied (uploads are the
  hot path); the page checks one `writeBuffer` when the mode starts and says in red when the browser refuses it.
  The audio device takes its `direct` transport (the worklet reads the module's ring in the process memory itself).
- **The page.** `?shared=1`, only when `crossOriginIsolated` (the page's server sends COOP/COEP); otherwise one red
  line and the normal mode. The options line of the report starts with `shared memory (?shared=1)`.
- **Tests.** `NX_SHARED=1` (or a mode name with `s`: `NX_MEM=32s`) runs a suite's memory modes on a shared memory
  (`tools/modes.mjs`): `npm run rt:test:shared`, `kernel:test:shared`, `hle:test:shared`. In the mode the runtime
  runner's `TextDecoder` refuses shared views like a browser's. Measured under Node 24: `rt:test` 61/61 in
  [32s] and [64s] (as unshared), `hle:test` 106/106 in [32s], [64s], [64his], `kernel:test` the same results as unshared in
  all three; one runtime case makes an `ldxr` at a misaligned address and checks the red line and its pc.

Limits: one Worker (a second thread on the memory would need its own core instance, table and units, and a kernel
that locks: none of that exists); 128-bit `STXP` is two exchanges with a roll-back, not one atomic pair; the
browser side (WebGPU uploads, OPFS, WebCodecs, the audio worklet's direct transport, a 16 GB shared reservation in
Chromium) is not covered by the Node suites.

### Helper Workers (`helpers: N`, default 0; the page's `?helpers=N` with `?shared=1`)

Real parallelism for the guest threads that only compute, and nothing else moves: the kernel, the take-over table,
graphics, files and audio keep their state in per-instance wasm globals, so they exist once, on the runtime's Worker.
A helper Worker (`src/glue/rt_helpers.ts`; `rt_helper_worker.ts` in the page, `test/runtime/helper_node.ts` under
Node) has its own function table, its own core instance (the CPU state), its own instance of the a64 helpers (with
scratch blocks of its own) and, lazily, its own instance of every translated unit at the same table indices, all on
the shared memory. It never calls the kernel, a host function or the translator.

- **A job.** A thread the kernel made Running on core c may spend its next slices on a helper: the runtime posts
  {context block, budget} into a mailbox (one SharedArrayBuffer, `Atomics.wait` / `notify`), the helper does
  `load_ctx`, runs slice after slice, and gives the thread back with `save_ctx` and an exit record: an SVC, a host
  function's stub, a counter read while the guest clock stands, a pc it has no unit for, an exit pc, a trap, or a
  slice end at which it was asked back (or 64 slices). Until then the context block is the helper's and the kernel
  passes core c by (`kernel_core_out`); the thread stays Running.
- **Serving an exit** is what `run()` does for the same event: `kernel_svc` on the context block (the thread goes
  out again when the SVC returned "continue"), `kernel_preempt` and the stack check at a slice end, translate and
  publish for a missing unit, the same fault report for a trap (the helper sends the trap's wasm frame, the side
  tables are here). A host call, an exit pc and a parked counter read run the thread here.
- **The unit registry.** `A64Host.onUnit` posts {module, table base, count} to every helper when a unit is
  installed; a job names how many registry messages its helper must have handled before it runs. A helper's empty
  table slots hold the trampoline, so the first call of a function instantiates its unit there. Dropping
  translations (`removeCode`) calls every thread back first.
- **Who goes out** is measured: a running average of budget units per exit (SVCs, host calls, slice ends) of at
  least `helperMinUnits` (20000), not while the thread cools down after a host call brought it back, never the
  target of SetThreadActivity / GetThreadContext3 (those and SetThreadCoreMask call every thread back before the
  kernel acts), never inside a guest callback. A thread that is out is asked back when a ready thread of its core is
  at least as good (`kernel_core_contended`), which is the preemption it would get here.
- **The kernel's lock words.** User-mode lock code now runs beside the kernel, so the kernel's compare-and-store
  of a lock or arbiter word is a wasm atomic (`src/kernel/base.ts` `cas32`; the kernel is built with
  `--enable threads`, valid on an unshared memory too).
- **Time.** The wall clock only. A counter read on a helper is answered there from the lag the runtime publishes
  (`performance.timeOrigin + performance.now()` on both sides), never earlier than the job's start.
- **Stopping.** A pause calls every thread back; an exit, a fault and `kill()` wait for the helpers' slices to end
  (a slice at most) and drop the records. `run({ async })` returns `idle` while only helpers run and `runAsync`
  wakes on the next exit (`Atomics.waitAsync`); a synchronous `run()` blocks on the mailbox.
- **What it says.** `helperLines()` (the report's "helper Workers" section): guest time in translated code here
  and on each helper, each helper's busy and idle time, exits by reason, and each guest thread's share with where
  it ran. The page's status split adds `guest code: main … ms, helper k … ms (… % busy)` per frame.
- **Tests.** `npm run rt:test:helpers` ([32s], [64s], [64his]): four compute threads with 0, 1 and 3 helpers, a
  mutex / condition variable ping-pong and a contended counter with `kernel_check` after every exit, units
  translated on both sides while a helper runs, a trap's report, pause / exit / kill during a slice.

Limits: not tried in a browser; a guest data race is now a real one; MapMemory copies while helpers run; `STXP`
pairs as above; without the option nothing of this exists (no Worker, no mailbox, the same run loop).

### Memory safety of the host area (the guard: on by default)

Linear memory has no page protection, so a guest write below 0x0800_0000 would land in the kernel's, the loader's or
the translator's state and a null read would return zero. With the guard (translator option `guardBase` =
`GUARD_BASE`, 0x07DC_0000) every guest load and store is biased: the address is computed as `wrap(addr) - guardBase`
and the memory instruction carries the constant offset `guardBase`. WebAssembly computes the effective address
without wrapping, so an address below the guard lands at 4 GB or above and the access traps, at the cost of one
subtraction and no branch (DC ZVA does a one-byte guarded load first). The trap is an ordinary `trap` fault whose pc
is exact, and the line says what it most likely was (see "Process lifecycle and faults").

**What the guard leaves open on purpose.** The take-over table and the audio module hand the guest pointers into
their own static data, as nxnative's host does in its one address space: SystemEvent objects that the SDK's own
`CreateSystemEvent` fills (guest code writing them), `localtime`'s `struct tm`, language lists, the audio device's
name. Their two ranges are therefore the last ones before the stub region and the guard ends below them
(`rt_layout.ts`). `tone.c` reads `GetAudioOutName` and `localtime` under the guard; found while deciding the default:
with the guard at 0x0800_0000 those reads were faults.

**The decision (the 5 % rule: default when the cost is under 5 %).** Measured alone on the development machine
(nothing else running; `npm run rt:guard`: the 61-image corpus, 160.1 M guest instructions, run time without
translation, guard on against off as pairs run back to back in alternating order):

| | rounds | cost |
|---|---|---|
| Node 22, run 1 | 6 x 9 | 2.9 % by the means of the runs (single runs by their minima: -5.9 .. +9.6 %) |
| Node 22, run 2 | 80 pairs | **1.63 % +- 1.07** (mean of the paired differences and its standard error; 95 %: -0.5 .. 3.7 %); median 0.4 %; total time +1.0 % |
| Chromium 153 | 30 pairs | **0.63 % +- 2.88**; by the minima 1.8 %; total time -0.9 % |

A single run of seven rounds scatters by +-6 % (Node) to +-9 % (Chromium, where one such run gave +12 % and the next
measurement of 30 rounds 0.6 %): the earlier figures of about 6 % were inside that noise and taken on a machine other
jobs were using. The cost is 1 to 3 %, under 5 %: **the guard is the default** (`GUARD_DEFAULT` in `rt_runtime.ts`;
`guard: false` is for measurements). `rt:test` still measures it on every run ("guard: what the trap ... costs",
seven rounds, with the paired statistics). The cache key contains the setting. The page has a box that turns it off
for the next run; were it off, a run that ends in a fault turns it on for the next one and the page says so.

Not protected even with it: writes into a module's text or read-only data, guest memory another thread owns, the
two host ranges above `GUARD_BASE`, and host functions (they are host code: `cpu.write` goes anywhere).

## The address space per game (`rt_process.ts`)

`new Runtime(mods, { layout })`: the kernel's cfg block is written from a `ProcessLayout` instead of `kernel_init(0)`.
`settingsFor(profile.apply, { space, stackSize, displayVersion })` makes one from a game's profile (`src/prepare`):
`app_pool`, `mem_used`, `sys_resource`, the program id and `mem_map_limit` go to the kernel, `op_mode`, `perf_mode`,
`alloc_big_align`, `game_env`, `launch_param` and the display version to the take-over table's configuration,
`npdm.stackSize` to `mainStackSize`. `handoffOptions(message)` (`rt_handoff.ts`) does it for the prepare step's
hand-off and adds per module a hash of its applied cuts, which is part of the translation cache key
(`<build id>+cuts<hash>@<address>/<options>`: a cut module keeps its build id).

**Reserved against committed.** A profile's `mem_reserve` / `mem_alias` / `mem_stack` are address space
(`hle_svc.c`: the heap region is `RESERVE - alias - stack - 256 MB`; on the Mac the alias region is at least a
Switch's 64 GB). What a game can commit in heap and alias region together is bounded by the pool the kernel reports:
`APP_POOL`, the Switch's 3285 MiB (0xCD500000) in 124 of the 153 profiles, 1 GB in 13, 9 GB in 11 (Switch 2 titles),
less `mem_used` and the modules. A wasm32 memory has 3.62 GB between 0x1800_0000 and 0xFFFF_0000 for heap, stack
region and alias region. So the split is chosen per game (`layoutFor`):

| Profiles' reserve (heap / alias GB) | Count | With the fixed map | With the split per game |
|---|---|---|---|
| 3.25 / 0.25 (and 2.5 to 3.0 / 0.25): the 4 GB layout, a heap-heavy game | 79 | no | heap = pool - used (3.15 GB, all `SetHeapSize` can reach), stack region 64 MB, alias as reserved: fits |
| 0.125 / 4.375 (and 3.1 to 4.25): a system resource, everything mapped in the alias region | 56 | no | alias = 3.44 GB of the 4.38 reserved, which is more than the pool: fits what can be committed, with less spare address space |
| small ones (up to 1.5 / 1.87) | 4 | yes | as reserved |
| heap and alias both large (1.25 to 2.1 / 2.4 to 5.25) | 3 | no | **short**: which region the game fills is not known without running it |
| a 9 GB pool (heap 4.75 to 9 / alias up to 64) | 11 | no | **short**: the pool itself exceeds 32 bits |

(The rows give the typical case of each class; a profile with a 1 GB pool or a smaller reserve fits as reserved.)
By the test (`layout per game`, which runs `settingsFor` over all 153 profiles): fixed map 4 of 153 have room for
what they reserve; per game **44 fit as reserved, 95 more fit everything their pool lets them commit, 14 cannot**
(listed by title id in the test's output). "Fits" is arithmetic on the profiles: no game has run. A `short` process
gets what there is and one red line. The kernel's alias page table was raised from 2 GB to 3.5 GB (14 MB of the
kernel's static range, taken from file staging, which is 16 MB now; larger start sets are staged in the guest's
own regions, see "File staging"). With `code` (the images' bytes) the code region grows past its 252 MB in 2 MB
steps (images + 64 MB spare), the heap region starts after it, and the images count against the pool when the
split is chosen; without a profile the default alias region gives up what the code region takes.

**memory64, for the 14.** The whole runtime has a second mode: every module built for a 64-bit linear memory
(`rt64.wasm`, `kernel64.wasm`, `loader64.wasm`, `gfx64.wasm`, `fs64.wasm`, `hle64.wasm`, `audio64.wasm`,
`translator64.wasm`, `helpers64.wasm`: the same sources through `tools/asc64`, the same static layout below 4 GB) on
one memory of up to 16 GB (`a64_host.ts` `makeMemory64`). `new Runtime(mods, { layout })` is in the mode when `mods`
are that set (their address tables say; `mem64` states it). memory32 is what it was: same modules, same layout, same
tests.

- *Engine limits.* A 64-bit memory is at most 16 GB in V8 (262144 pages), in Chromium 153 and in Node 22.23, where
  memory64 is on without a flag. Node's JavaScript API has no `address: "i64"`, so the memory comes from a module
  that defines it, in both engines. Growing it is address space: the 9 GB-pool test below ends with a 12.56 GB
  memory and 2 MB more resident memory (Node), and runs the same in headless Chromium.
- *One convention for addresses* (`docs/CONTRACT.md`, "Addresses"): `usize` in AssemblyScript, a number in the glue,
  converted in one place (`wasm_abi.ts` `instantiate()`, from the table `tools/asc64/abi.mjs` writes into each binary
  as the difference of its two builds), never through a 32-bit operator. `npm run audit64` keeps it: 2892 sites
  (casts to 32 bits, 4-byte loads and stores, JavaScript's 32-bit operators) against a reviewed list; a new one
  fails `npm test`.
- *The layout rule has the mode* (`rt_process.ts`): `layoutFor(want, { mem64: true })` is the same rule with the
  regions ending at 0x3_FFFF_0000 and no cap on the alias region; `layoutChoice(want)` is the one answer to "which
  memory does this profile need": the 32-bit layout when it fits ("profile" or "pool"), else the 64-bit one, with
  the most real memory the linear memory may come to hold (pool + images + host area and spare) and the sentence
  the page shows. Over nxnative's 153 profiles: 139 stay 32-bit; **the 14 that were short all fit**, 9 as reserved
  and 5 with everything their pool lets them commit (alias reserves of 16 and 20 GB cut to 10.8 GB), at up to
  9.2 GB of real memory. The profile files carry that verdict (`address_space.mem64`, written by
  `tools/prepare/layout_verdict.mts` from the same function), the prepare page shows it ("runs in 64-bit memory
  mode: heap .., alias .., pool ..; the tab may come to use up to 9.2 GB of real memory") instead of "Can't run",
  and the hand-off's options (`handoffOptions(msg, { mem64: "auto" })`) carry the layout and the choice.
- *The kernel's alias page table is two-level* (`src/kernel/README.md`): leaves on demand, the first 3.5 GB of
  mapped region from static data, the rest from an arena at the top of the code region which the layout sizes
  (`ProcessLayout.aliasArena`, 30 MB for a 10.8 GB region) and the runtime hands over (`kernel_alias_arena`).
- *The page* (`web/worker.ts`): a game whose hand-off layout is a 64-bit one gets the wasm64 set (fetched and
  compiled then), anything else the wasm32 set; `?mem64=1` puts every program in the mode, `?precise=1` / `?precise=2` sets `preciseFaults` (2: a trap's
  register dump is exact). The Options row says
  "64-bit memory mode" and why. The translation cache key has the mode (`m32` / `m64...`).
- *Tests.* Every runner goes through `tools/modes.mjs`: memory32, memory64, and memory64 with **the whole process
  above 4 GB** (`NX_MEM=64hi`: code region at 0x1_8000_0000 with heap, stacks, thread-local, alias regions and
  host-allocated blocks behind it; the flat corpus linked there; the module runners' fake guests above 4 GB), where
  an address cut to 32 bits lands on untouched pages 4 GB lower. `d a 9 GB pool` creates a process from a Switch 2
  profile's keys (heap 8 GB, alias 4 GB, pool 9 GB), where the guest sets a 6.2 GB heap in one call, writes and
  reads a pattern at its bottom, middle and top and in an alias mapping above 8 GB, and walks QueryMemory;
  `prepare:browser` does the same from a synthetic NUP through the page's verdict and Play.
- *What the placement found* (each a wrong address, not an error, before): the audio glue's event binding
  (`ev >>> 0`); `gp()` of `src/audio` and `gok()` of `src/fs` masking to 32 bits; the texture table keeping a
  texture's pool address in 4 bytes, and the texel and present records of the recorder carrying an address in 4;
  the take-over glue's stack argument (`sp & 0xFFFFFFFF`); audio's records keyed by and pointing with 4 bytes
  (outputs, buffers, streams, decoders, renderer threads: its arena is host-allocated, so above 4 GB with the
  process); the loader's module records; the file system's image record, which grew past its table's stride with
  8-byte pointers; and, by the 9 GB test, the kernel's marker for a host-mapped stack (0xFFFF_FFFF_0000_0000 + the
  address), which wrapped for a stack above 4 GB and named heap memory as borrowed.
- *WebGPU takes the views.* `queue.writeBuffer` / `writeTexture` accept a view of a memory larger than 4 GB at
  offsets above 4 GB in Chromium 153, as the whole-memory view with an offset, as a subarray, and as a copy
  (`npm run gfx:mem64`); the copy costs 2.6 to 3.5 times the upload (80 against 30 us for 64 KB, 3.1 against 0.9 ms
  for 4 MB), so the replayer keeps handing views. All 55 scenes pass with the game above 4 GB.
- *Cost* (this machine, others idle). Node 22, the flat corpus through the runtime (`npm run rt:mem64`, 61
  programs, 160 M instructions, 9 interleaved rounds, best / median): memory32 382 / 296 M instructions/s; memory64
  355 / 260 (7.7 % / 13.7 % more time); above 4 GB 350 / 258 (9.2 % / 14.7 %). Doom (`doom:test`, tics 100..600 of
  demo1, null replayer): 5.58 ms a frame and 1028 M instructions/s in memory32; 6.34 ms and 906 M/s in memory64
  (+13.6 %); 6.28 ms and 914 M/s above 4 GB. Headless Chromium 153 (`rt:browser`, one run a mode while other jobs
  ran: no more than an order of size): corpus 195 / 145 / 230 M instructions/s; Doom on the page with `?mem64=1`
  runs and draws (`doom:browser`). A default process holds the same in both modes: 380 MiB of address space after
  a small program and no measurable resident memory beyond memory32's (the kernel's page table is no longer
  initialized whole: 8 MB less touched per process in both modes).

**What is left for a 9 GB title to start from the page** is not memory: the machine must have the real memory the
verdict names (Chromium's behaviour when a tab commits 9 GB, a `RangeError` from the grow or the tab killed, is
not measured: this machine has 15 GB and the tests touch pages sparsely); `fs:browser` and `audio:browser` (the
module-level device tests) run in memory32 only, their modules being covered in the mode by `rt:browser`; a shared
64-bit memory is tried under Node only ("Shared memory" above; the audio worklet's direct transport and guest cores
as Workers are not); and everything in the next
paragraph.

**What a Switch 2 title needs beyond memory** (read from nxnative's notes on The Legend of Zelda: Ocarina of Time,
`0400486024DEC000`, update v131072: `dm/games/0400486024DEC000/README.md` and `game.tsv`; none of it is tried here):
- *NVN2.* The game renders through NVN2 with Ampere shader code in BNSH (`Shader/*.Nin_Ounce_NVN2.bfsha.zs`);
  `src/gfx` records NVN. About 42,850 shaders, among them 500 mesh and 20 task shaders (indirect mesh draws):
  WebGPU has no mesh or task stage. 137 compute pipelines in the recorded manifest, float atomics in storage
  memory, shading-rate images (no-ops in nxnative).
- *Profile keys that are graphics behaviour*: `render_cond on` (agl wraps clears in render conditions: conditional
  rendering has no WebGPU form), `gpu_timestamps segment` (the game's dynamic resolution reads GPU timestamps;
  WebGPU's timestamp queries are optional and coarse), `draw_barriers game`, `tex_flush_upload` /
  `tex_dirty_upload` (the CPU writes terrain maps into textures after creating them).
- *SDK 22.2.8 ("Ounce")*: three modules (`main`, `subsdk0` = NintendoSDK_movie, `sdk`); the take-over table has
  been written against the SDKs of the games tried so far. `sys_resource 0x3000000` (virtual address memory on),
  `mem_map_limit on` (the kernel has the flag), `SetHeapSize 0x18ce00000` at start (6.2 GB in one call),
  `app_pool 0x240000000`. The Switch 2 forms of services nxnative lists for SDK 20 and later (hid mouse mode and
  Joy-Con 2 styles, `nn::pl` fonts, GameChat's `chat:u`, `vi` answering as a 1080p / docked Switch 2).
- *Movies*: AV1, and `nn::ndve`, a movie-enhancement network nxnative runs as its own GPU kernels (11 to 36 ms of
  compute a frame on Macs before that).
- *Game patches*: `patches.py` places a frame-step stub and a dynamic-resolution stub by function fingerprint
  (`fps_target 60`); the prepare step's match writes would carry them.
- *Files*: one NUP container of 25.6 GB; the RomFS keeps most files as zstd with dictionaries (decoded by the
  game), so the file system sees large sequential reads from a 25 GB image in the browser's storage.
- *CPU*: the translator implements the Switch's Cortex-A57 set. nxnative runs guest code natively, so its notes do
  not say whether SDK 22 code built for the Switch 2's CPU uses what the translator leaves out (LSE atomics, RCPC
  `LDAPR`, pointer authentication forms, half-precision arithmetic, dot product): the translator's `probe` export
  over the instruction words of the three modules (what `test/a64/coverage.py` does for the test corpus) answers
  that before anything else is built.
- *Frame cost*: about 60 fps on recent Apple GPUs natively with 6 ms of CPU a frame; translated code at the corpus'
  rate would need its own measurement.

## Start contract (test modules)

There is no SDK and no rtld in the guest; the runtime plays both.

1. `loadNso([main, dep1, dep2, ...])`: load order is the symbol lookup order; the first module is the main module.
   Files are staged, parsed, mapped from 0x0800_0000 with a free page between them, relocated against each other and
   the host functions; each image is told to the kernel (`kernel_module_add`), the code window of the translator is
   the span of all images, the modules are pinned and the staged files released, the main stack is mapped (`kernel_map_stack`) and the main thread created.
2. The main thread first runs the **init functions, as guest calls on the main thread's stack**: for each module
   after the first in load order, then for the first module: `DT_INIT` if there is one, then the `init_array`
   entries in order. (A dependency's initializers have run before the main module's.) x30 of each call is the
   `<rt.start>` host stub, so every return comes back to the runtime, which makes the next call.
3. Then the main module (pinned with the others when the load ended, before the init functions) is entered at its **first instruction** (the
   loader's `entry`) with **x0 = 0, x1 = the main thread's handle**, x2..x29 = 0, sp = the top of its stack,
   x30 = 0xFFFF_FFF0, `tpidrro_el0` = its ThreadLocalRegion, `tpidr_el0` = its TLS block (the kernel's initial state).
4. Returning from the entry (pc = 0xFFFF_FFF0) is a clean exit: the **fini functions** run on the main thread as
   guest calls that return to the exit pc, in the reverse of the init order (run-time modules still loaded, last
   loaded first; the main module; then what it depends on, last in load order first), each module's `fini_array`
   backwards and then its `DT_FINI`. A fini function may make SVCs and wait. Then the process ends with the
   entry's w0. `svc 0x07` (ExitProcess) ends it at once with w0 and runs none, as on Horizon, where the guest's
   own runtime has run them by then.

## Start contract (SDK programs)

A start set that defines `nnosInitialize` and `nnMain` (a game: its `sdk` module) starts as on hardware, where rtld
enters the SDK's `nn::init::Start` (the order of nxnative `dm/host/main.c`). The main thread calls, each as a guest
call returning to `<rt.start>`, those that are defined: `_init_libc0`, `nnosInitialize(x0 = the main thread's
handle, x1 = 0)`, `_init_libc1`, `nninitInitializeSdkModule`, `nninitStartup`, `_init_libc2`; then rtld's
InitModules: each module's `DT_INIT` in load order (an SDK module's `_init` runs its own `init_array`; the array
is called only for a module with no `DT_INIT`); then `nnMain`, entered as the entry is in step 3 above. The SDK's
constructors need nn::os up (the TLS slots of `SdkAllocateTlsSlot`). The module's crt0 is not run. Returning from
`nnMain` is a clean exit as in step 4.

`loadFlat(image, sidecar)` runs a flat guest of the contract's test ABI instead: one image at `base`, all registers
zero (x1, `tpidr`, `tpidrro` cleared after the kernel made the thread), and `svc 0x1E` answered by the contract's
counter (0, 1000, ...) instead of the kernel's clock.

## Run loop

```
run():
  loop:
    ctx = kernel_schedule()                       the kernel picks; cores take turns
    if ctx == 0:
      stopped?            -> finish
      t = kernel_next_timeout()
      t == forever        -> Stopped(fault deadlock)
      deterministic clock -> time := t;  wall clock -> sleep until t (Atomics.wait)
      kernel_tick(time); continue
    load_ctx(ctx); budget := opts.budget; clear the exclusive monitor if the thread changed
    core.run()                                    in try/catch
    kernel_tick(time after the slice)
    trap or reported fault -> save_ctx, rt_fault -> Stopped(fault)
    STOP seen in an SVC    -> Stopped(exit | break)
    pc == 0xFFFF_FFE0      -> continue             an SVC or host call gave the core up; its context is saved
    save_ctx(ctx)
    pc == 0xFFFF_FFF0      -> kernel_thread_returned
    sp outside mapped memory -> Stopped(fault stack)
    budget < 0             -> kernel_preempt
```

- **SVC** (`svc` import, inline): `save_ctx`, `kernel_tick(now)`, `kernel_svc(n, ctx)`. CONTINUE: `load_ctx`, return
  into the guest. SWITCH: `pc := 0xFFFF_FFE0`, the translated frames unwind by the contract's pc check and `run()`
  returns. STOP: the same, with a flag.
- **Time.** Deterministic (default): host time for `kernel_tick` is `ns = units * nsPerUnit` (default 100 ns), where
  a unit is one decrement of `budget` (a function entry or a backward branch of translated code). It is brought up to
  date at every SVC, every `mrs cntpct_el0` and every slice end, from the budget left, so a thread sees time pass
  inside its slice. When every thread waits, time jumps to `kernel_next_timeout()`. Same program, same budget: the
  same slices, SVC count, unit count and guest clock, in Node and in Chromium (the tests compare them). Wall clock
  (`clock: "wall"`): `performance.now()`, with a blocking sleep while every thread waits.
- **`mrs cntpct_el0`** = `kernel_guest_ticks()` after a tick. The translator's `cntYield` is on: the read is a yield
  point (registers written back, pc = the instruction). While the kernel holds the clock for background
  (`kernel_clock_reasons() & 2`) the thread parks: `kernel_clock_wait(ctx)` blocks it as GetSystemTick's wait does,
  but its wake writes no register, and the thread runs the read again when the freeze ends
  (`Runtime.freezeClock(reason, on)`; tested: x0 and x1 survive). Inside a guest callback made by a host function
  a read cannot park: it returns the standing value, red once.
- **Per-thread CPU state outside the context block**: `depth` is set to 0 by `core.run()` before every dispatch, and
  a thread only leaves the core by a full unwind, so nothing is carried over. The exclusive monitor (`excl_addr`,
  `excl_val`, `excl_val2`) is cleared (`excl_addr = -1`) whenever the next slice belongs to another thread, as a
  context switch does on a CPU; a thread resumed after another ran fails its pending STXR and retries.
- **Translator ranges and region mode**: one code range per module (see Memory). The entry scan and the 64 KB chunk
  units work per range (`maxInsns: 1` is used once to count instructions). The stub region is outside every range.
- **Every thread waits forever**: a deadlock fault, except while the guest clock is frozen or the embedder said that
  kernel events are signalled from outside (`expectOutsideEvents()`, set by the take-over table): then an
  asynchronous run returns `idle` and whoever signals calls `requestWake()`.
- **Pause**: `run({ slices, ms })` or `requestPause()` returns in `Paused` at a slice boundary; `run()` resumes.
- The glue decides nothing about who runs or who wakes; it only reports what happened to the kernel.

## Host calls

A stub is `stubBase + 4 * id` in the stub region. The region is **inside the pc map and outside the translator's
code window**, so a `bl`/`blr`/`br` to a stub is an indirect transfer by the protocol: `pc := stub`, registers
written back, `call_indirect pcmap[pc]`. At construction the glue fills the map entries of all 65536 stubs with the
table index of one thunk (a 52-byte wasm module whose only function calls the import `host_call`). So:

```
guest:  bl stub           ->  pcmap[stub] = thunk  ->  Runtime.hostCall()
hostCall: id = (pc - stubBase) / 4; handler = registry[loader's name of id]
          result = handler(cpu)          cpu: x(i), setX, read/write/cstr, log, thread, lr
          number/bigint -> x0;  pc := x30;  return     the caller's pc check passes and it goes on
```

- **Unresolved import** (the loader's kind `HOST_UNRESOLVED`): `[RED] call to unresolved import <name> from <x30>`
  once per name, x0 = 0, return.
- **Blocking**: `return cpu.block(readableEvent, timeoutNs, resume)`. The glue saves the context with `pc` = the
  stub, makes `WaitSynchronization` on the event **for the thread** (`kernel_svc(0x18)`, the handle list in a
  per-thread slot of the runtime core's static memory) and yields. When the kernel wakes the thread it runs the stub
  again, `hostCall` finds the thread's `resume`, calls it with `"signaled" | "timeout" | "cancelled"`, and its result
  is the function's result. x0..x3 are lost across the wait (caller-saved). The host signals with
  `kernel_event_signal`. Nothing in the kernel had to change for this.
- **Jump**: `return cpu.jump(pc)` continues elsewhere (the start sequence uses it).
- **Calling back into the guest**: `cpu.call(fn, ...args)` runs a guest function to completion on the calling thread
  and returns its x0 (what gfx's `env.gfx_guest_call` needs). It is a nested `core.run()` with x30 = 0xFFFF_FFD0; the
  callback may make SVCs that return at once and call host functions, and it is not preempted (its budget is
  refilled and the time accounted). A callback that blocks stops the process with a `host` fault, because the host
  frame it would have to return to cannot be suspended. Tested with budgets 100000 and 50.
- **Never continuing**: `return cpu.never()` ends the calling thread as ExitThread does (aborts, a program handing over).
- **Floating point results**: `cpu.setD(0, bits)` writes d0 (through a context block: JavaScript cannot write a
  `v128` global).
- A stub with no host function behind it is a jump fault.
- Forced names no module refers to are one summary line from the loader (`force: N entries hit, M not referenced by
  this game`), as in nxnative; `Loader.forceStrict(true)` makes each a red line.

### Adding a host function

```ts
const rt = new Runtime(mods, { log: console.log });
rt.register({ name: "nnosAllocateMemory", forced: true,        // forced: wins over every module's own definition
  fn: cpu => { const size = cpu.x(0); /* ... */ return address; } });   // the return value goes to x0
rt.register({ name: "nnsocketSend", fn: cpu => 0 });            // not forced: fills an import no module defines
// One answer per name: registering a name twice throws. A test that replaces an answer says so: rt.override(def)
rt.loadNso(files);   // register before loading: binding happens when the loader relocates
rt.run();
```

`name` is the symbol as it appears in the module's dynamic symbol table. A forced take-over reaches every call that
goes through the module's PLT or GOT. It does not reach a call the compiler bound inside the module (clang's default
for a function defined in the same file: the test modules are built with `-fsemantic-interposition` for this reason).

## Modules at run time (`loadModule`, `unloadModule`, `rt_ro.ts`)

`rt.loadModule(name, bytes)` loads a module file while the process runs: staged once per content (keyed by the
file's SHA-256: a reload maps the pristine copy again, at the base it had), mapped above the modules in the code
region, relocated against everything loaded (the loader binds the earlier modules' imports of its symbols to it),
told to the kernel (`kernel_module_add`) and to the translator (`addCode` with text bounds and entries). The caller
runs its init functions with `cpu.call` and then `activateModule`. `rt.unloadModule(handle)`: `removeCode` (its
units leave the function table, their pc-map entries are cleared), `ld.unload` (what pointed into it is bound
again), `kernel_module_remove`. Its address range stays reserved.

nn::ro is the take-over table's (`src/hle/ro.ts`, 10 names): `hle_rt.ts` maps its imports to these calls. `roLoad` =
`loadModule` on the image bytes copied out of guest memory (the token is the image's base), `roCalls` = DT_INIT, or
the init_array when there is none (fini: DT_FINI, or the fini array backwards), `roActivate` = `activateModule`,
`roUnload` = `unloadModule`, `roLookupIn` = `ld.lookupIn`. Init and fini run as guest callbacks, so they must not
block. A module asked for "alone" (a JIT plugin) is relocated like any other, with one red line: the loader has no
such mode. The glue's own `rt_ro.ts` is gone.

**Code the guest writes (`nn::jit`).** `rt.jitAlloc(rxSize, roSize)` gives two host-allocated blocks; the first is
a code range of the translator. `rt.jitCodeWritten(rx, offset, size)` drops what was translated from the block (all
of it: a unit may span the written range), `rt.jitFree` returns both to a free list by size. Tested with a guest
that writes `mov w0, #n; ret` three times and calls it (`argsg.c`); `nn::jit` itself has only run against the
table's fake plugin.

## Translation cache

`new Runtime(mods, { cache: store })`, `await rt.cacheLoad()` after loading and before `run()`,
`await rt.cacheSave()` when there is something new (it writes nothing when nothing was translated since). One
entry per code range, keyed by **build id @ load address / `A64Host.optionsKey()`** (a flat image: its SHA-256
instead of a build id); the options key contains the translator's cache version and every code-changing option,
`guardBase` included. Stores: `webCacheStore()` (Cache API; the page uses it) and `test/a64/cache_node.ts` (files).
Run-time modules are not covered: they load inside a host call, where nothing can be awaited.

Cold and warm start of the a64 owner's large guest (1.66 MB image, 404,510 instructions translated on a cold start,
6.8 M executed; start = `new Runtime` to exit):

| | cold | warm |
|---|---|---|
| Node 22 | 498 ms (translate + compile 165 ms; then 13.5 MB stored in 15 ms) | 76-84 ms (cache read 20 ms, compile 13-15 ms, 0 instructions translated, 34 units from the cache) |
| Chromium 153 | 568 ms (156 ms; 13.5 MB stored in 100 ms) | 163-195 ms (cache read 43-58 ms, compile 51-58 ms) |

## Shaders (`rt_shaders.ts`)

`new RtShaders(gfx, { library, translator, store })`. At `nvnProgramSetShaders` the glue computes each stage's key
as the recorder does and looks it up: (1) registered by the embedder; (2) the library (`.nxsl`,
`src/shaders/library.ts`); (3) with a translator attached: the store of earlier translations (key + the
translator's chain version), else the translator; the stage's bytes are copied out of guest memory at once. The
game goes on; the recorder skips the draws that use the stage until `GfxHost.registerShader` gets the record, and the
next draw builds the pipeline. One informational line a key (`shader <key> is not in the shader library: it is
translated in the page; draws that use it are skipped until it is there`), one red line a key that fails
(`[RED] shader <key>: translation failed: <why>; its draws are skipped`), or that the library has with bindings the
replayer does not provide.

`workerTranslator({ worker, framework, naga })` is the in-page chain: `rt_shader_worker.ts` (a module Worker) runs
nxnative's translator driver over Ryujinx.Graphics.Shader published for `browser-wasm`, then `src/shaders`' SPIR-V
pass and naga. It is talked to over a BroadcastChannel: the .NET runtime, started in a Worker, never finishes
starting once the Worker's own `message` event has fired (found here; so is that its console forwarding hangs
there). `webShaderStore()` keeps translations in the Cache API. Stages wait in one queue in the page until a Worker is free; a free
Worker takes up to `batch` (4) of them for one run of the translator's main, and there are `workers` of them
(`defaultShaderWorkers()`: half of `hardwareConcurrency`, 1 to 4; each has its own .NET runtime, started when the
queue is longer than the Workers already up can take). At each present, `RtShaders.waited` hands the translator's
`prioritize` the pending keys a draw or dispatch was skipped for since the last one (`gfx_shader_waited`, the
recorder's `progShader`), so a frame's stages go before the rest of a boot's. Each `shader <key> arrived` line splits
its time into queued (a free Worker, the Worker's own start included), runtime start, translator (its share of the
batch) and pass + naga; the report's `shader translation in the page` counter sums it up. `npm run shaders:latency`
measures it on a synthetic Maxwell corpus (`test/shaders/latency/corpus.py`, the ps_ops body repeated, every stage a
distinct key) in headless Chromium on 8 cores: 720 stages handed over at once took 6.9-7.1 s with one Worker a stage at
a time (median arrival 3.8 s; the 14 asked for last 6.9 s), and take 1.7 s with 4 Workers in batches (median 1.25 s;
the 14 asked for last, moved to the front, 0.53 s). Measured in Chromium (SwiftShader): the two stages
of the test guest arrive 781 and 835 ms after the first miss (translator start included), 51 draws skipped
meanwhile; a second run takes both from the store in 130 ms.

The gfx side is reached through `GfxHost.registerShader` only. One thing is not expressible there: the recorder
reports a missing key itself (`[RED] shader <key> is not in the shader map`, once a key). `RtGfx` does not pass
that line on for a key that is on its way or failed (`RtShaders.dropLine`); see Requests.

## The file system (`rt_fs.ts`)

`new RtFs(rt, mods.fs, storage, { programId, forced })` before loading: the module (`build/runtime/fs.wasm`) is
instantiated in the process's memory, all 73 nn::fs names it knows become host functions that land in `fs_call`
(x0..x7 from the argument block), and a call that cannot finish at once parks the calling thread with `waitFor`:
`pending` until `FsHost` completes the storage call it waits for, `retry` until any completion, then the same call
again. Storage: `NodeStorage` (files) under Node; in the page `OpfsStorage`, with the save containers opened ahead
(`preopen`) and the RomFS image a `Blob` read with FileReaderSync, so nothing pends; `MemStorage` without OPFS.
The storage's handles are closed when the process is disposed of (an OPFS access handle is exclusive).

## The SDK take-over table (`hle_rt.ts`)

`attachHle(rt, mods.hle, { config, front, gfx })` registers the names of `src/hle` (1,049 forced, 64 weak; with graphics, the file system and audio attached the
loader's summary for the cube demo is `force: 13 entries hit, 1228 not referenced by this game`). **One answer per name**:
`Runtime.register` throws on a second registration of a name ("the later one wins" let `rt_hle.ts` put 13 older
TypeScript functions with a state of their own over the table's nn::vi and nn::hid); `rt_hle.ts` and `rt_ro.ts` are
removed, and the test attaches graphics, the table, the file system and audio to one process to show that no name
has two answers. What the table gets from the runtime:

- `stackArg(i)` = `[sp + 8 i]` of the calling thread (`HostCpu.stackArg` too), and `guestCall` with more than eight
  arguments: the ninth and later go on the guest stack below sp, 16-byte aligned, for the time of the call (tested
  with twelve and thirteen arguments, `argsg.c`).
- nn::ro and nn::jit: see "Modules at run time".
- `HleFront`: `ctrlPrompt(min, max, answer)` (the controller applet waits on its event until the front end answers;
  the page shows a dialog), `vibration(state)` (the page plays it on the player's controller through the Gamepad
  API's `vibrationActuator`, where there is one), `joyMouseWanted`.
- `gfx` (an `HleGfx`, which `RtGfx` is): `viLayer`, `viCrop`, `viFrameCount`, `viPresentProgress`, `viPresentedNs`,
  and at every present `host.viFrameQueued(frames)` and a tick of every vsync event handed out.
- SystemEvents for other areas: `hle_event_bind` runs the SDK's own `CreateSystemEvent` on the calling guest thread;
  a guest call is allowed whenever a host function is running (`rt.inHostCall`), so audio binds its events through it.

Earlier: the "hle static" range and the build; `cpu.setD`, `cpu.never()`; `rt.onHandleClosed`; `rt.requestExit`;
`rt.hostAlloc`; `rt.expectOutsideEvents()`. Still windowless: the input box, the web view, shared fonts, native images.

## Audio (`rt_audio.ts`)

`new RtAudio(rt, mods.audio, { hle, send })` before loading. The module (`build/runtime/audio.wasm`, static data in
"audio static") is instantiated in the process's memory; its arena is 16 MB from `hostAlloc`, taken at the first
nn::audio call. Its 118 names are forced take-overs: the handler copies the argument block (x0..x7, d0..d7), adds x8
and the call site, ticks the module with both clocks and calls `audio_call`; x0, x0 and x1, or v0 (`setD`) is
written back as the result says. `Runtime.onTick` calls `audio_tick` at every slice end and idle jump, and
`Runtime.addDeadline` makes `audio_next_deadline()` (turned into host time by `kernel_host_time_of`) a deadline of
the run loop: on the deterministic clock a slice's budget is cut to end there and an idle guest's time stops there, so
a silent sink releases its buffer at exactly that guest time; on the wall clock the idle loop wakes then, the
catch-up limit is 100 ms, and while an output plays on a device the loop wakes every 4 ms to feed the ring.
`audio_event_bind` of a guest SystemEvent goes to the take-over table (`sysevent.ts`); the module's own events are
bare kernel events. A renderer take-over that runs SDK code answers with requests (src/audio/README.md, "The
requests"): the glue sends the calling thread into the SDK function with x30 = its `<audio.co>` stub (a `lateStub`),
whose host function resumes the module with x0 / x1, or blocks the thread on the module's event (`cpu.block`); the
render thread's function, given to the SDK's `CreateThread`, is the `<audio.render>` stub. The page hosts `AudioDeviceMain` and passes `{ audio }` messages both ways; the context is made
at the first nn::audio call of a process, closed when the process is disposed of, and starts on the first user
gesture (`AudioDeviceMain` listens itself; the click that starts a program is one).

## Stopping and starting again

`kill()` (Ready, Running or Paused): the process machine's Kill, `kernel_kill()` (every thread leaves, as at
ExitProcess; stop reason 3), then `dispose()`: registered disposers (graphics: every texture and buffer made on the
device while the process was current on it is destroyed, tracked by a per-device patch of `createTexture` /
`createBuffer`; the file system's storage handles), the per-thread wait events (`kernel_handle_close`; an event of a
thread record that went to another thread is closed when it is next asked for), the waits for outside things, every
code range (table slots set to null so the engine can free the modules). A stopped process is disposed of with
`dispose()`; logs, stdout and the stop reason stay readable. The page ends the previous process this way before a
load, so a second program runs without a reload.

## Graphics (`rt_gfx.ts`)

`new RtGfx(rt, gfxModule, { device, canvas, nextFrame })` before `loadNso`. It instantiates the recorder
(`build/runtime/gfx.wasm`, static data in "gfx static", `gfx_init` on "gfx arena") in the process's memory and the
WebGPU replayer (`gfx_host.ts`) in the same JavaScript context (a Worker with an OffscreenCanvas on the page and in
the tests). Without a device the **null replayer** is used: every NVN call, record and lowering happens, nothing is
drawn, fences and window images complete at once (Node tests, instruction counts).

- **Entry points.** `nvnBootstrapLoader(name)` is a forced take-over. It, and `nvnDeviceGetProcAddress(device,
  name)`, answer with a stub address: `nvn_lookup(name)`, then a host stub made on demand under the function's name
  (`Runtime.lateStub`; the loader's stub table takes names after loading). A call to the stub lands in
  `nvn_call(id, args)`: the glue saves the CPU state into a scratch context block (JavaScript cannot read `v128`
  globals) and the runtime core copies x0..x7 and the low 64 bits of v0..v7 into the argument block (`rt_nvn_args`).
- **Recorder imports.** `gfx_exec` → the replayer; `gfx_guest_call` → `Runtime.guestCall` (the command-memory
  callback runs guest code on the calling thread); `gfx_proc_address(id)` → the stub of that id.
- **The device** is requested with `GfxHost.deviceDescriptor(adapter)` (every feature the replayer can use, the
  adapter's per-stage limits), and `requestDevice` is passed on for a lost device: the replayer asks for a new one,
  uploads textures again from guest memory and requests the pipelines again (tested: the cube demo's device destroyed
  at frame 12 of 30 ends with the pixels of a run without a loss; the page has a button that does it).
- **Three calls wait on the GPU** and park the calling guest thread (`cpu.waitFor`, below), on the replayer's own
  promises (`host.fence(n)`; nothing is wrapped, the null replayer calls `host.signalFence` / `imageEvent`):
  `nvnSyncWait` parks when the recorder says so through `gfx_wait_fence()`: timeout 0 never parks; a finite timeout
  parks with a deadline of that many nanoseconds, and when the timer wins the call is made again with timeout 0
  (wall clock; on the deterministic clock guest time stands still while the GPU works, so a timeout cannot run
  out); `~0` and anything from 2^62 on has no timer. `nvnQueueFinish` parks on `host.fence(gfx_finish_fence())`:
  submitted work done and every read-back landed. `nvnWindowAcquireTexture`: frame pacing, see below.
- **Arguments.** `nvn_abi_table()` is read once: a function that takes no float (326 of 332) gets only x0..x7
  (`cpu.argsX()`), one that does gets d0..d7 too, and the four float results are copied from `args + 64` to d0. The
  registers are marshalled by a 300-byte helper module on the core's globals (`args_x`, `args_xd`, `set_d0`) instead
  of a full `save_ctx` per call.
- **Shaders.** A key that is being fetched or has failed is told to the recorder (`GfxHost.shaderPending`, machine
  `gfx_shader`), which then does not report it missing: the text filter on its red line is gone. A key registered
  again has its pipelines requested again. `GfxHost.dispose()` destroys what the replayer made (the patch of the
  device's `createTexture` / `createBuffer` is gone). `gfx.captureFrame()` is the page's F9 and button.
- **Frame pacing.** An acquire after the first is held for `interval` vertical syncs of 1/60 s, as the Switch holds
  it. The interval is the recorder's (`gfx_present_interval`: the game's own, 1 with the profile's `present_interval
  display`, 60 / cap under a present cap; `src/gfx/README.md`, "Frame pacing"). Wall clock with the embedder's
  `nextFrame()` (the Worker's `requestAnimationFrame`): the first display frame at or after the slot, slots counted
  from the previous slot, so the rate is the game's on a screen of any refresh rate (before, one frame was shown
  for every display frame whatever the interval). Wall clock without: a timer. Deterministic clock: exactly
  `interval` refreshes of guest time after the previous acquire, and not before the GPU has finished the previous
  present.
- **The game's profile.** `RtGfx`'s `profile` option (`rt_process.ts gfxSettingsFor`, part of `settingsFor` and so
  of `handoffOptions`) turns the profile's graphics keys into the recorder's switches (`gfx_set_profile`). Counter
  reports are stamped with the guest clock as it is when the GPU's completion arrives (`guestNow`), and with the
  null replayer they land at once.

## Waiting for things outside the guest, and the asynchronous outer loop

`cpu.waitFor(done, at, resume)`: the thread waits until the promise `done` has resolved **and** host time has reached
`at`. It is a kernel wait (WaitSynchronization on an event kept per thread, made by the glue as for `cpu.block`); the
glue signals the event from the run loop when both conditions hold. Nothing spins: `run()` returns `{ idle: true }`
when every thread waits and something outside is still due.

`runAsync()` is the loop for a host with an event loop: `run({ async: true, yieldMs: 8 })` in a loop; after `yielded`
(8 ms of slices) a zero timer, after `idle` a promise that the completion of any outside wait, the next guest
deadline, `requestPause()` or `kill()` resolves. Slices themselves stay synchronous. A plain `run()` that meets a
wait it cannot make synchronously stops with a `host` fault.

**No real time in deterministic mode.** The time `at` of an outside wait is a point on the guest clock, and the
guest clock is not allowed to pass it while the outside thing has not happened: slices are cut so that they end at
`at` (the budget is clamped), a jump of an idle guest stops there, and when it is reached and `done` is still
pending the whole guest stands still (`idle`) until it resolves. So the thread wakes at exactly `at`, however long
WebGPU took; a wait with no `at` is "now", which makes it synchronous as far as the guest can tell while JavaScript
still returns to the event loop. Result: with the same program and budget the slices, SVC count, budget units, guest
clock and pixels are identical from run to run (tested), in Chromium as under Node's null replayer (the two differ
from each other by one slice per parked wait).

## Input (`rt_input.ts`)

`new RtInput(hle)`: every source's state goes to the take-over table as a snapshot (`hle.input(player, snapshot)`);
the players, the npads, the press latch and the input hold are the table's. `set(KEYBOARD, pad)` is the keyboard;
`set(sourceId, pad)` a controller, which takes a player slot by its stable id (`hle.padSlot`: the same controller
gets its player back after a reconnect; `set(id, null)` when it leaves); `script("frame:key[+key][~frames],...")`
are scripted steps in frames (presents), deterministic, sticks as `L<x>/<y>` in hundredths. Player 1 is the keyboard,
the script and the controller in slot 0 merged (buttons ORed, each stick axis the more deflected one); the others
are players 2 to 8. `sourceOf(player)` says where a player's vibration goes. Tested with a guest that reads four
npads while the test connects, removes and reconnects controllers (`pads.c`).

## The page (`web/`)

`npm run web` → http://localhost:8080. Main thread: controls, canvas (handed to the Worker), keyboard and
controllers, the audio context, dialogs. Worker: the runtime with graphics, the take-over table, audio, the file
system, the shader lookup and `runAsync()`.

- **Programs.** A game folder goes through the prepare step (`web/prepare.html`, a frame of the page: pick the
  folder, the stages with their state and counts, Play); its hand-off (`nxweb:handoff`) is posted to the Worker,
  which builds the process from it (`handoffOptions`: layout and settings from the profile, saves in OPFS under the
  hand-off's name, the RomFS and add-on contents as devices over the folder's files). Two built-in demos (the cube;
  a 440 Hz tone through nn::audio), built from `test/runtime/src`. NSO files, a shader library and a RomFS image can
  still be picked or dropped directly.
- **Doom.** A third button, on when the build has `demo/doom.nso` (the doomgeneric engine as a guest, `test/doom`;
  `web:build` makes it only when the engine is on the build machine, and copies the data file only when `DOOM_WAD`
  names it). Without a data file in the build the button opens a file dialog; `doom1.wad` can also be dropped on the
  page. The Worker makes a one-file RomFS image of the bytes (`fs_romfs_one.ts`), gives the canvas the size of the
  game's window (1280x720; the page then shows it at full width) and registers the guest's two hooks (`doom_frame`,
  whose game facts the page shows; `doom_args`).
- **State.** The badge is the `process` machine's state (`rt_state`), the reason beside `Stopped` the data it
  carries. **Machines**: a table of the kit's machines this process has stepped (transitions taken of each table,
  the newest step from the trace rings, which modules stepped it), with the state now for the ones the page can ask
  from a module's exports: process, oe_focus, audio_out, gfx_device, guest_clock, hle_exit, input_hold, ctrl_prompt,
  pad_slot. **Modules**: build id, base, sizes, unresolved imports by name; take-overs hit against not referenced.
- **Log.** Every line, red ones in red and counted, guest output in green; a text filter and "red lines only".
  **Copy report** makes one text block (the machines' states, modules, counters, the adapter, the translator's
  options key, the fault's lines, the last 200 log lines) with nothing from guest memory: the guest's own output
  lines are left out. It goes to the clipboard and into the page.
- **Input.** The keyboard is player 1 and its state is sent at every key event (controllers are sampled once per
  animation frame; sampled like that, a key pressed and released between two frames was lost: found with Doom's
  menu on a busy machine, tested by a press and release inside one task); every controller the Gamepad API reports
  is a source of its own (its id and index hashed) and a player of its own; vibration is played on the player's controller (`vibrationActuator`), a
  held state every 400 ms. The controller applet's prompt is a dialog (OK / Close).
- **Graphics.** F9 or the button captures a frame: the pass text and the target images. A test button destroys the
  GPU device under the running process.
- **The guard** is on; a box turns it off for the next run (measurements).
- Translated code is cached in the Cache API; saves live in OPFS. "Guest instructions per second" is budget units ×
  a ratio measured for the demo at build time; for other modules only budget units are shown.

## Process lifecycle and faults

`Empty -Load-> Loading -LoadOk-> Ready -Start-> Running <-Pause/Resume-> Paused`, and `Stopped` (final) from
`Running` by `Exit`, `Break`, `Fault`, from `Loading` by `Fault`, and from `Ready`, `Running` or `Paused` by `Kill`
(the embedder's stop). `Stopped` carries `kind << 32 | value`:
exit code, break, or the fault kind. Every fault logs its red lines and `run()` returns; nothing is thrown. The
lines are also `StopInfo.fault.lines` (the page's report copies them into its fault block). What, where and in which
thread; x0..x30, sp, pc, nzcv, tpidr_el0 and tpidrro_el0 on four lines; for a trap without `preciseFaults: 2` a note that the registers are
as last written back; pc and x30 as module + offset from its image base and, when the module's symbol table has a
function symbol there, symbol + offset (`Loader.symbolAt`), or the host stub's name; the frame records from x29 (at
most 16, each return address placed the same way); then the thread's last SVCs (at most 16, the kernel's ring
`src/kernel/ring.ts`), each with its arguments, its results (and a QueryMemory's MemoryInfo) or "waiting" / "did not
return", and the pc it returns to:

```
[RED] fault: wasm trap in thread 0x1001 (#0) at pc=0x8000090: memory access out of bounds: the instruction 0xb9400000 at 0x8000090 loads or stores through x0 at an address below 0x7dc0000 (a null or host-area pointer) or beyond the end of the memory
[RED]   x0=0x0 x1=0x1f x2=0x0 x3=0x0 x4=0x0 x5=0x0 x6=0x0 x7=0x0
[RED]   x8=0x1f x9=0x780ffee8 x10=0xa x11=0x8001039 x12=0x0 x13=0x1e x14=0x0 x15=0x0
[RED]   x16=0x8002108 x17=0x8000090 x18=0x0 x19=0x0 x20=0x0 x21=0x0 x22=0x0 x23=0x0
[RED]   x24=0x0 x25=0x0 x26=0x0 x27=0x0 x28=0x0 x29=0x780ffed0 x30=0x80000b0 sp=0x780ffec0 pc=0x8000090 nzcv=0x8 tpidr=0x17c02000 tpidrro=0x17c01000
[RED]   the registers are as last written back (the function's entry or its last call), pc excepted; preciseFaults: 2 (the page: ?precise=2) makes them exact
[RED]   pc=0x8000090 is fault_null+0x90 (read_word+0x0); x30=0x80000b0 is fault_null+0xb0 (read_through+0x10)
[RED]   the frames from x29=0x780ffed0, innermost first:
[RED]     frame 1: fp=0x780ffed0 returns to 0x800016c, fault_null+0x16c (no symbol)
[RED]     frame 2: fp=0x780fffe0 returns to 0xfffffff0, not in the text of a loaded module
[RED]   the last 1 of the 1 SVCs of thread 0x1001, oldest first:
[RED]     #1 svc 0x27 OutputDebugString(x0=0x780ffee8 x1=0x1f) -> 0x0, returns to 0x80004b4
```

When base + offset of the trapped access is a valid address and only the translator's folded form traps (an
immediate offset carried in the wasm memory operand, `A64Host.memargFold`: the base below the guard, or base +
offset wrapping), the first line says so instead: `... loads or stores through x5 = 0x... + offset 0x20 = 0x..., a
valid address: base + offset wraps or the base is below the guard, and the memarg-offset fold ... traps where
hardware would not`. That is a translator limit, not a guest bug.

| Fault | Comes from | pc |
|---|---|---|
| `unimplemented` | the translator's `unimpl(pc, insn)` import | exact; `aux` = the instruction word |
| `brk` | the `brk(pc, imm)` import | exact |
| `jump` | the translate callback: the pc is not in a loaded module's text (or not translatable, or a reserved value) | the target; x30 is where it came from for a call |
| `trap` | `WebAssembly.RuntimeError` or stack exhaustion out of `core.run()` | exact for a trap in translated code (`A64Host.faultFromError`: the trap's innermost wasm frame and the unit's side table; V8 only, else the last pc written back); the register dump is as of the last write-back unless `preciseFaults: 2`. An out-of-bounds access names the instruction and its base register |
| `stack` | the check at the end of a slice: `sp - 1` is in a free segment (`kernel_query_memory`) | where the slice ended |
| `deadlock` | every thread waits and no wait has a deadline | of the last thread that ran |
| `load` | the loader or the kernel refused a file | none |
| `host` | an exception in glue or in a host function | last written back |

## Verified (`npm run rt:test`: 58 tests under Node; `npm run rt:browser`: 69 in Chromium)

Large module files (`more_cases.ts`, `large_nso.ts`, `src/large.c`; Node and Chromium): a synthetic NSO of 41.6 MB
made in the test (text and 24 MB of data LZ4 compressed, 40 MB of read-only data stored, three hashes checked,
72 MB image) is staged in the guest's regions, loaded and run: the guest checks every word of both segments, its
bss, and that 96 MB of heap read zero; the same on a per-game layout and across a 32 MB heap region; a small
program still uses the fixed range and grows nothing. Refused with their figures: files that fit no staging
space, an image larger than the code region that is left, the file cut short, one flipped bit in the stored
40 MB, a run-time module file that fits neither the fixed range nor the code region. `RT_HUGE=1 npm run rt:test --
"target size"` builds and runs the same guest as a 256 MB file with a 512 MB image (Node only, not part of the
default run: 330 MB of build output).

New in the integration round (`test/runtime/int_cases.ts` and the cases named):

- One answer per name: a second `register` throws, `override` replaces, an override of nothing is refused; the table,
  graphics, the file system and audio attach to one process, and attaching the table twice throws.
- Arguments: a host function reads four stack arguments; the host calls a guest function with thirteen; generated
  code is translated again after each `jitCodeWritten`, and freed code memory is handed out again.
- Run-time modules through the table's nn::ro (the earlier case, now on `attachHle`).
- Controllers: keyboard and three controllers by source id over six steps (join, leave, a newcomer taking player 1,
  the first one back as player 3), the controller applet's prompt as a wait answered by the front end, vibration to
  player 2's controller.
- Audio, no device: 400 buffers of 5 ms driven by the buffer-released SystemEvent (bound by the guest's own
  `CreateSystemEvent` through the table): every release exactly 5,000,000 ns of guest time after the one before, with
  budgets 100000 and 50, identical slices, units and clock on a second run; pointers into host static data read under
  the guard; the wall clock (60 buffers in 0.30 s). Audio in Chromium: the same guest with the page's AudioContext and
  AudioWorklet (`sab` transport): about 3 s of 440 Hz at amplitude 0.5 reach the device, fitted sine above 60 dB, no
  gap, no device underrun (waived, and said, when the run loop came back more than 25 ms late). The test browsers
  play through Chromium's fake output stream (`--disable-audio-output`; `RT_BROWSER_AUDIO=device` for the system's):
  on this machine (no sound device, a PulseAudio server with a null sink) every new output stream through PulseAudio
  plays about 3 quanta, then calls back no more for about 1.9 s, then 375 a second (a bare worklet, no nxweb code, a
  fresh context each time: 400 quanta in 3 s where 1125 are due, the first report after 1947 ms; a context opened while
  the stream is still up does not stall, one opened 5 s after the last one closed stalls again; the fake stream: 1128
  quanta, the first report after 1 to 2 ms, every time). The tone case and the page's audio demo met it every run:
  Live, then the module's stall watchdog (no callback for 200 ms) moved the output to the silent sink, retried 1 s
  later, about 1.2 of the 3 s reached the device, and the page test failed on the watchdog's red line. The module did
  what it is for; the tests were measuring the system's output stream.
- Audio renderer (`audren.c` and its stand-in SDK `ren_sdk.h`): the host's take-overs open the guest SDK's renderer
  for CPU / manual rendering and run it from a render thread the SDK starts for them; two voices come out at the sink
  as the expected signal sample for sample, one block per 5 ms of guest time; the wave buffers come back consumed;
  budgets 100000 and 50; the render thread blocked on the SDK's update lock for 12 ms; 12 open / close rounds. In
  Chromium the same guest through the AudioWorklet, six rounds, each stretch of sound equal to the expected signal.
- The NVN waits with a "GPU" the test holds back (wall clock): SyncWait never fenced 2, timeout 0 2, 30 ms timeout 2
  after 30 ms, a fence met 15 ms into a 5 s wait 1, again 0, infinite 1, QueueFinish returning when its fence
  completed: 3 parked, 1 timed out; float arguments and results by the ABI table. The same guest on WebGPU.
- Device loss (Chromium): see Graphics.
- Robustness, each twice with the same seed (identical output, slices, SVCs, units, guest clock) and once with
  another (different): 64 threads on four mutexes and two condition variables with timeouts, sleeps and exits, 968
  waves (60,984 threads) in 30.0 s of guest time, 1.36 M SVCs, every lock word 0 and one handle left; 3000 rounds
  of SetHeapSize and MapMemory / UnmapMemory with a second thread on the heap, 0 wrong reads, no growth between
  round 300 and the end; an NRO loaded, called and unloaded 500 times with the function table, the pc map, the
  loader's arena and the memory level from round 50 on; 2000 frames with 500 texture rewrites in pool memory and 20
  present-interval changes (64.98 s of guest time; in Chromium the same pixels twice and a level count of GPU objects).
- The address space per game and the hand-off's options: see "The address space per game".
- The page (Chromium with the default autoplay policy): the earlier walk, then the machines table (process Running,
  gfx_device Live), the modules table, the guard note, a frame capture by F9 (pass text, a decoded 480-pixel-wide
  image), the device destroyed and restored while running (red lines only about the loss, the red count, the filter,
  "red only"), the report's contents, the audio demo going Live from its click and ending by itself, and a game
  folder through the prepare frame (Ready, Play, the process running on the profile's layout and reading its RomFS).

Found by these (and fixed): `HostCpu.x()` handed out negative BigInts for registers with bit 63 set (a wasm i64
global reads signed), so `nvnSyncWait(sync, ~0)` had a deadline in the past; the function table grew by a module's
units at every reload (12 slots a round: slots of dropped units are reused now); the kernel's alias page table was a
literal 8 MB beside a constant that said how many pages it holds; an option passed as `undefined` replaced its
default (`mainStackSize: undefined` made the main stack's mapping fail); the audio module raised the ring's `live`
word before the lead was in the ring (see src/audio/README.md); pointers into host static data were unreadable under
the guard.

Earlier:

- The range table and each module's static end; a broken table is refused.
- (a) hello: output, x0 and x1 at entry, exit code by return.
- (b) two modules: calls through the PLT, data through the GOT, a data pointer and a function pointer across
  modules, the init order; again with the modules mapped beyond the pc map.
- (c) threads: four threads on four cores doing plain computation (slices end by budget), a counter under the SDK's
  mutex with contention forced (ArbitrateLock / ArbitrateUnlock both used), two producers and two consumers on a
  bounded queue with two condition variables, events with a timeout, a signal from another thread and ResetSignal,
  sleeps ending in deadline order, join on a running and on an exited thread. Identical output over 20 runs
  (also identical slice, SVC, unit counts and guest clock), with budgets 50, 1000, 20000 and 2^24, on the wall
  clock, and when paused every 50 slices. `race`: unsynchronized threads; 20 runs each at budgets 40, 333 and 100000
  are identical within a budget and differ between budgets.
- (d) heap: SetHeapSize twice, a first-fit allocator with 600 allocations checked, a QueryMemory walk of the whole
  address space: the module's text (r-x), read-only data (r--), data (rw-), the thread-local region, the heap, the
  main stack, and the free ranges between them, contiguous.
- (e) host calls: forced over a module's definition (from both modules), weak filling an undefined import, weak
  losing to a module's definition, an unresolved import called twice (one red line, 0), host functions reading and
  writing guest memory, a host function blocking until another guest thread makes the host signal, its timeout, and
  a host function calling a guest callback five times (the callback makes an SVC); with budgets 100000 and 50.
- (f) faults: jump to 0x6000_0000, an undefined instruction, a load from 0xF000_0000 in a second thread, runaway
  recursion, a damaged NSO, a deadlock, a fatal `svcBreak`: each `Stopped` with its kind and the red lines.
- (g) the 21-program corpus (61 flat images) through this loop, budgets 100000 and 50: 61 of 61 both times.
- Guard (`guard: true`): a null read and a write into the kernel's static data each end in a `trap` fault whose pc
  is the load or store instruction itself (the line names the instruction and its base register); without it the
  read gives 0 and the write lands. The guard's cost on the corpus is measured by a test of its own (see Memory).
- (h) run-time modules: an NRO is loaded through nn::ro, its init function runs, it is called through a looked-up
  symbol and through the main module's own import (bound at load, 0 again after unload), a double load is refused,
  it is unloaded (fini function) and loaded again, three rounds, its data restored each time; no translated unit
  of it is left afterwards. Budgets 100000 and 50.
- (h) fini: the main thread returns from the entry and five fini functions run in order, one of them sleeping.
- (h) counter: a thread reading `cntpct_el0` while the clock is frozen for background parks at the read and resumes
  with x0 and x1 intact. Budgets 100000 and 50.
- Cache: two NSO modules cold (642 instructions translated, 27 KB stored under two keys), warm (3 units, nothing
  translated, same output), a miss under other options; cold and warm start of the large guest (see above).
- Restart: the cube demo started and killed five times after a warm-up: 0 kernel threads alive, kernel stop reason
  3, no translated unit left, no red line; in Chromium 10 GPU textures and buffers alive while running and 0 after
  each stop; under Node (`--expose-gc`) heap + external level over the five cycles (+0.0 MB). Chromium does not
  report memory to the test's Worker (`measureUserAgentSpecificMemory` and `performance.memory` are absent there),
  so in the browser "memory stable" rests on the GPU object count and the kernel's counts.
- File system: `fsg.nso` mounts a RomFS built by `tools/mkromfs.py`, reads a 100,003-byte file (FNV-64 compared),
  mounts its save data, writes a counter and commits; run 2 reads what run 1 committed; run 3 is killed between
  write and commit; run 4 finds the committed value; run 5 the next. Twice: on the platform's storage (Node files;
  OPFS with containers opened ahead: 0 calls parked) and on storage that answers later (20 calls parked).
- Take-over table: `hleg.nso` calls 22 names by their mangled symbols: operation and performance mode, focus,
  `StandardUserSystemClock::GetCurrentTime` and `ToCalendarTimeInUtc` at a fixed time, account count / uid /
  nickname, nifm and socket offline answers, `sinf`, `sqrtf`, `pow`, `strtod` (results through d0), then the message
  loop on `PopNotificationMessage`: two focus messages the test causes, and the host's shutdown, which ends the
  process as `exit 0` with the table's exit machine in `Exited(hostShutdown)`. Handheld: operation mode 0.
  One summary line for 686 unreferenced forced names, no red line.
- Shaders, Node and Chromium: `mx.nso` hands NVN the hand-assembled Maxwell programs. Library first (2 stages, no
  draw skipped); a stand-in translator held back by the test: 3 draws skipped, one informational line a stage, then
  drawn, results stored; second run from the store; a stage nothing translates: one red line with its key; nothing
  attached: the recorder's own red line. Chromium, pixels: left half only the texture's five colours times the
  tint, right half background, the same hash with library and translated stages.
- Shaders in the page (Chromium, when `build/shaders` has the translator): both stages translated by the real chain
  in a Worker, stored in the Cache API, the same pixels as the offline library; second run from the store; the cut
  pixel stage: one red line. Without the artifacts both shader tests print SKIPPED (seen in the clean-copy run).
- `process` machine: all 12 transitions (`npm run kit:test`).
- Graphics, Node (null replayer) and Chromium (WebGPU on SwiftShader, in a Worker, OffscreenCanvas): `cube.nso`
  includes nxnative's real `nvn.h`, gets 95 entry points by name, a window through nn::vi, and renders a clear, a
  triangle and the textured cube (texture written block-linear into pool memory, uniform data new every frame):
  12 frames paced one refresh of guest time apart, 629 NVN calls, a SyncWait that parks on a fresh fence, QueueFinish.
  Scripted input reaches the npad reads. `cube2.nso`: a second thread writes the uniforms under the SDK mutex, an
  event each way per frame; identical with budgets 100000, 700 and 50.
- Pixels (Chromium only): the clear colour on all 129600 pixels; the triangle's 41472 pixels (the geometry's area)
  with red, green and blue at the right corners; the cube: only the texture's five colours on the background, the
  same hash on a second run, a different one with `4:Right~6` (twice the same) and another with the left stick.
  `build/runtime/cube.png`, `triangle.png`, `cube_turned.png` are the presented textures read back.
- Wall clock with `requestAnimationFrame`: 40 frames at the display rate, the run loop busy about 5 % of the time,
  the Worker's event loop serving timers meanwhile; each of the 39 acquires after the first parked for its display
  frame or counted late (`acquireLate`: the frame before it took past its slot, so it is not held), at most 4 late.
  The test used to want exactly 39 parked and failed once on 38 (one slow SwiftShader frame).
- The page: opened in Chromium, demo started by a click, `Running`, frames advancing, ArrowRight seen in the pad
  readout, Pause (frames stop), Resume, Stop (`Stopped`, killed); then started and stopped five more times without
  a reload (take-over table, file system on OPFS and shader lookup attached each time), the later runs starting
  from the translation cache; no red line; `build/runtime/web.png`.
- Without nxnative's `nvn.h` (`NXNATIVE_NVN_INCLUDE` overrides the directory) the graphics guests are not built and
  their tests report SKIPPED.

Measured on the development machine (4 cores), run time without translation:

| | Node 22.23 | Chromium 153 |
|---|---|---|
| (g) corpus, 160.1 M guest instructions | 306-333 M insn/s (0.48-0.52 s, three runs) | 176-247 M insn/s (0.65-0.91 s, three runs) |
| (c) threads, 6.46 M guest instructions | 454-492 M insn/s (13.1-14.2 ms) | 616-653 M insn/s (9.9-10.5 ms) |

The cube guests in Chromium (SwiftShader, no GPU), unpaced on the wall clock, 300 frames:

| | cube | cube2 (two threads) |
|---|---|---|
| frames per second | 154-184 | 170-198 |
| guest instructions per frame | 911 | 742 |
| per frame: translated code and SVCs | 0.09-0.15 ms | 0.13 ms |
| per frame: host calls outside WebGPU (NVN recorder, hid, stubs) | 0.19-0.20 ms | 0.14-0.16 ms |
| per frame: WebGPU calls in the replayer | 0.21-0.25 ms | 0.18-0.20 ms |
| per frame: waiting for the GPU and the event loop | 4.8-6.0 ms | 4.6-5.4 ms |
| guest instructions per second of translated-code time | 5.9-10.5 M | 5.3-5.6 M |

(Two runs each.) A frame of these guests is 45 NVN calls and almost no computation, so "translated code" is mostly the price of
entering and leaving it 49 times (each NVN call saves the CPU state once to marshal x0..x7 and d0..d7). Paced by
`requestAnimationFrame` the page shows 60 frames/s with 15.6 ms of each frame idle.

(c)'s instruction count is taken from a run with `maxInsns = 1`, where a budget unit is one instruction; its run
time is the best of five normal runs and is so short that the figure is rough. (g) is slower here than in the
translator's own runner because of the slices (budget 100000 instead of 2^30) and the context copies per SVC.

## Gaps

- **Memory protection is the guard only**: the host area below 0x07DC_0000 traps; the take-over table's and the
  audio module's static data above it do not, text and read-only data are writable, an address at or above 4 GB
  wraps (contract). A host function that hands the guest a pointer into another module's static data (graphics, the
  file system) would fault under the guard: none is known.
- **Code size beyond the files**: the pc map grows past its fixed range into the code region, one byte of map per
  byte of code that was translated (tested with 27 MB of text touched in every 64 KB). The code region's spare is
  64 MB beyond the images, shared with run-time modules and host blocks, so a game that executes more than about
  80 MB of its code would need a larger spare. The entry bitmap covers the first 256 MB of the code region.
- **Address space**: 14 of nxnative's 153 profiles do not fit a 32-bit memory (see "The address space per game"; the translator has a 64-bit memory mode, the other modules not yet);
  "fits" for the other 139 is arithmetic, no game has run. A profile's `mem_reserve`-style keys beyond the split,
  frame-step patches and the other "needs" of a profile are listed by the page and not applied.
- **nn::jit** has not run with a real plugin; a module asked for "alone" is linked like any other (red once).
- **Audio**: the audio renderer's take-overs have driven stand-in SDKs only (src/audio/README.md); on the wall clock a host
  timer that comes late lets two buffers come back in one tick. One device context per process, made at the first
  nn::audio call.
- **Controllers**: no motion source (the Gamepad API has none), no touch from the page yet, Joy-Con pairs are not
  told apart from pads.
- **Stack overflow is found late**: at the end of the slice, when sp is already in unmapped memory (the test ends
  3.6 MB below the stack). A stack that borders mapped memory overflows into it unnoticed.
- **After a trap the registers are stale** (last write-back) unless `preciseFaults: 2` (about twice the run time);
  the pc is exact under V8 only.
- **No executed-instruction counter.** It is not cheap in this translator: it needs a new CPU-state global that
  every unit imports (the global indices and every unit's bytes change) and per-basic-block accounting in the
  assembler, with blocks left early by a trap or an unwind counted wrong unless each exit corrects it. Not done;
  counting is still by a second run with `maxInsns: 1`.
- **One Worker**: the memory is not shared and every guest thread runs in one host thread.
- **Run-time modules**: their address ranges are never reused by another module; init and fini functions run as
  callbacks and may not block; no NRR hash check; not in the translation cache. A thread that is inside a module
  when it is unloaded goes on in code the translator no longer knows (a jump fault at its next indirect transfer).
- **Translation cache**: a whole range is stored again when anything new was translated in it; nothing evicts old
  entries (other options, other load addresses).
- **Shaders**: no per-game answer table in the page (texture types, attribute and output classes are the
  translator's defaults); the recorder's "missing key" line is suppressed by its text; compute stages and stages
  whose reflection has `extra` bindings (the support buffer, c1, driver segments) are refused, which a pixel
  shader that reads `gl_FragCoord` hits; no eviction in the store; the in-page translator is not built in CI.
- **File system**: the page takes a standard RomFS image only (not nxnative's `DMROMFS1`, not NSP / XCI); saves are
  keyed by the main module's id, not the program id; add-on content and the program id are not set by the page.
- **Take-over table**: the input box, the web view, shared fonts and native images have no page side; a SystemEvent
  handed to the guest needs the SDK's own `nn::os` (there is none in the test guests), so the message loop is tested
  through `PopNotificationMessage`, not through the event.
- **Deterministic time** counts budget units, not instructions, and an SVC costs nothing.
- Wall-clock idle in a synchronous `run()` uses `Atomics.wait`; a page's main thread must use `runAsync()`.
- Graphics waits: a finite `nvnSyncWait` timeout cannot run out on the deterministic clock (guest time stands still
  while the GPU works); acquire pacing knows one window; `nn::vi`'s layer size and crop are noted and not applied
  to the present.
- `kill()` does not give linear memory back: the Runtime's memory goes when the last reference to it does (Node
  after a collection: level over 5 restarts; Chromium does not report it to a Worker, see Verified).
- Host functions are found by name at the first call of each stub; there is no arity or type information.
- Browser run needs the full Chromium build: in `chrome-headless-shell` 153 any out-of-bounds wasm access kills the
  renderer (SIGSEGV, not a `RuntimeError`).
- CI (`.github/workflows/ci.yml`): three jobs; this round added `audio:test` to the fast job (`prepare:test` is in
  `npm test`) and `prepare:browser` before `rt:browser` in the browser job (the page test uses the folder it writes).
  The edited workflow has not run on GitHub.
- `RT_GFX_KEEP=1` / `RT_KIT_KEEP=1` let `rt:build` go on with the last `gfx.wasm` or with kit tables that are out
  of date while another area is mid-edit. Never set in CI.

## Requests to other owners

- **gfx**: answered this round in `src/gfx` and `gfx_host.ts`: `dispose()`, the `gfx_shader` machine with
  `shaderPending`, pipelines requested again for a key registered again. Still open for real shaders (the items of
  `tools/shaders/README.md`): uniform ranges of at least `uboSize` zero-filled, `cube-array`, the `extra` bindings,
  integer textures; and applying `nn::vi`'s layer size and crop at the present.
- **loader**: a mode that relocates a module against itself only (a JIT plugin); reuse of an unloaded module's
  address range by another module.
- **prepare**: FRAME_STEP patches need a patch area in the loader's map and a per-frame state page; none of that exists.
- **a64**: a larger or growable pc-map leaf arena (21 MB of translated code today); an executed-instruction counter
  if wanted (see Gaps); `faultFromError` for engines other than V8.
- **kit / every area**: a build that loads another area's wasm should check its kit stamp
  (`src/kit/host/stamp.mts`); the runtime, loader, kernel and fs builds write one.
- **shaders**: a `[JSExport]` call interface for the translator instead of `runMain` and its in-memory files (one
  `runMain` per stage costs about 40 ms warm), and the answer table as run-time facts from the bound state.
- **fs**: a reader for nxnative's `DMROMFS1` (or a packer that writes standard RomFS).
