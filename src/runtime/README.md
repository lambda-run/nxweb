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
| `src/glue/rt_hle.ts` | nn::vi and nn::hid take-overs, the input state (live and scripted) |
| `src/glue/rt_ro.ts` | nn::ro (run-time modules) over `Runtime.loadModule` / `unloadModule` |
| `src/glue/rt_shaders.ts`, `rt_shader_worker.ts` | Shader lookup: library, store, in-page translation in a Worker |
| `src/glue/rt_fs.ts` | The file system (`src/fs`) attached: nn::fs names to `fs_call`, parking on pending / retry |
| `src/glue/hle_rt.ts` | The SDK take-over table (`src/hle`) attached (its owner's file; run by this area's tests) |
| `src/runtime/host/build.mts` | `npm run rt:build`: `build/runtime/{rt,kernel,loader,gfx,fs,hle,translator,helpers}.wasm`, each with a kit stamp |
| `test/runtime/cases.ts` | The end-to-end tests, shared by Node (`run.mts`) and the browser Worker (`web/worker.ts`, `browser.mts`) |
| `test/runtime/more_cases.ts` | The cases that wait for something: translation cache, restart, file system, take-over table, shaders |
| `test/runtime/src/` | The test modules (C and assembly), built into NSOs by `harness.mts` |
| `test/runtime/gfx_cases.ts` | The graphics tests (null replayer under Node, WebGPU and pixel readback in the browser) |
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
| kernel static | 0x0080_0000 | 0x0120_0000 | `src/kernel` static data (8.5 MiB used) |
| gfx static | 0x0120_0000 | 0x0130_0000 | `src/gfx` static data |
| gfx arena | 0x0130_0000 | 0x0330_0000 | `gfx_init(arena, gfx_arena_bytes())` |
| file staging | 0x0330_0000 | 0x04A0_0000 | NSO / NRO file bytes, which the loader needs in memory until a module is pinned (23 MB); its free tail is scratch for hashing and entry lists |
| hle static | 0x04A0_0000 | 0x04B0_0000 | `src/hle` static data (about 350 KB) |
| fs static | 0x04B0_0000 | 0x04C0_0000 | `src/fs` static data (about 400 KB) |
| fs arena | 0x04C0_0000 | 0x0530_0000 | `fs_init`: RomFS tables of the mounted images, save trees (7 MB) |
| a64 translator | 0x0530_0000 | 0x0630_0000 | the translator's static data and buffers (15.4 MB) |
| a64 helpers | 0x0630_0000 | 0x0631_0000 | the helpers' static data |
| a64 entry bits | 0x0631_0000 | 0x06B1_0000 | one bit per instruction of the 256 MB code region |
| pc map | 0x06B1_0000 | 0x07FC_0000 | two-level pc map: first level (256 KB), zero leaf, then a 64 KB leaf per touched 64 KB of code |
| host stubs | 0x07FC_0000 | 0x0800_0000 | the loader's stub region: 65536 stubs of 4 bytes |
| code | 0x0800_0000 | | modules, mapped one after the other with a free page between them; above them `hostAlloc` pages |
| stack | 0x7800_0000 | 0x7810_0000 | the main thread's stack (1 MB by default), the first mapping of the kernel's stack region |

How each module gets its place: `asc --importMemory --zeroFilledMemory --memoryBase <range.lo>` (`host/build.mts`;
the translator and helpers through `src/a64/host/build.mts`, which `npm run a64:build` runs too: the bases come from
this one table and `A64Host` refuses binaries built for another). None of the modules has a heap (`--runtime stub`,
static data only), so "static data ends below the range's end" is the whole check: `rt_static_check` compares each
module's static end with the table at start. Without `--zeroFilledMemory` asc writes every zero byte of the static
data into the wasm file (kernel.wasm: 8.9 MB instead of 24 KB) and into memory at instantiation.

**The pc map** is the translator's (`src/a64/README.md`): two levels over all 4 GB of guest addresses, leaves
allocated on demand from the "pc map" range, so a module may be mapped anywhere in the code region (tested at
0x1600_0000). The range holds 327 leaves, that is 21 MB of code with at least one translated function per 64 KB; a
game with more translated code than that needs a larger range (the error is "the pc map's leaf arena is full").

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

**Not `shared`.** The memory is not a SharedArrayBuffer: the translator has shared builds
(`translator.shared.wasm`, atomics for exclusives) but the runtime runs every guest thread in one Worker.

### Memory safety of the host area (`guard: true`, off by default)

Linear memory has no page protection, so a guest write below 0x0800_0000 lands in the kernel's, the loader's or the
translator's state and a null read returns zero. With `new Runtime(mods, { guard: true })` (translator option
`guardBase` = 0x0800_0000) every guest load and store is biased: the address is computed as
`wrap(addr) - guardBase` and the memory instruction carries the constant offset `guardBase`. WebAssembly computes
the effective address without wrapping, so an address below the guard lands at 4 GB or above and the access traps,
at the cost of one subtraction and no branch (DC ZVA does a one-byte guarded load first). The trap is an ordinary
`trap` fault whose pc is exact, and the line says what it most likely was (see "Process lifecycle and faults").

Cost, measured on the 61-image corpus (160.1 M guest instructions, run time without translation, guard on against
off, 7 interleaved rounds per run, on a machine other jobs were using): Node 22, six runs: +5.6 / +2.6 / +6.8 /
+8.6 / +5.7 % by the minimum of the rounds and +3.4 / +5.8 / +2.0 / +9.9 / +10.5 % by the median (means: about
+5.9 % and +6.3 %); Chromium 153, one run: +5.3 % (minimum), +6.2 % (median). That is not under the 5 % the task
set for making it the default, so it is an option, off by default: a debugging aid for a wild pointer, at about
6 %. `rt:test` measures it again on every run ("guard: what the trap ... costs"). The cache key contains the
setting.

Not protected even with it: writes into a module's text or read-only data, guest memory another thread owns, and
host functions (they are host code: `cpu.write` goes anywhere).

## Start contract (test modules)

There is no SDK and no rtld in the guest; the runtime plays both.

1. `loadNso([main, dep1, dep2, ...])`: load order is the symbol lookup order; the first module is the main module.
   Files are staged, parsed, mapped from 0x0800_0000 with a free page between them, relocated against each other and
   the host functions; each image is told to the kernel (`kernel_module_add`), the code window of the translator is
   the span of all images, the main stack is mapped (`kernel_map_stack`) and the main thread created.
2. The main thread first runs the **init functions, as guest calls on the main thread's stack**: for each module
   after the first in load order, then for the first module: `DT_INIT` if there is one, then the `init_array`
   entries in order. (A dependency's initializers have run before the main module's.) x30 of each call is the
   `<rt.start>` host stub, so every return comes back to the runtime, which makes the next call.
3. Then the modules are activated and pinned, and the main module is entered at its **first instruction** (the
   loader's `entry`) with **x0 = 0, x1 = the main thread's handle**, x2..x29 = 0, sp = the top of its stack,
   x30 = 0xFFFF_FFF0, `tpidrro_el0` = its ThreadLocalRegion, `tpidr_el0` = its TLS block (the kernel's initial state).
4. Returning from the entry (pc = 0xFFFF_FFF0) is a clean exit: the **fini functions** run on the main thread as
   guest calls that return to the exit pc, in the reverse of the init order (run-time modules still loaded, last
   loaded first; the main module; then what it depends on, last in load order first), each module's `fini_array`
   backwards and then its `DT_FINI`. A fini function may make SVCs and wait. Then the process ends with the
   entry's w0. `svc 0x07` (ExitProcess) ends it at once with w0 and runs none, as on Horizon, where the guest's
   own runtime has run them by then.

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

`registerRo(rt)` puts nn::ro over this, after nxnative `hle_ro.c`: `Initialize`, `Finalize`, `GetBufferSize` (the
NRO header's bss size; 0x816 for an image without NRO0), `LoadModule` (both signatures; the `nn::ro::Module` is
filled as the SDK fills it, init = DT_INIT, or the init_array when there is none), `UnloadModule` (fini, then
unload), `LookupSymbol`, `LookupModuleSymbol` (a name the module does not define fails quietly, as on Horizon),
`RegisterModuleInfo` (an NRR registers nothing here), `UnregisterModuleInfo`. Departure: nxnative finds an NRO it
rewrote offline by the image's hash; here the image the game passes is loaded as it is. Init and fini run as guest
callbacks, so they must not block.

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
there). `webShaderStore()` keeps translations in the Cache API. Measured in Chromium (SwiftShader): the two stages
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

`attachHle(rt, mods.hle, { config, front })` registers the 766 names of `src/hle` (708 forced). What this area
added for it: the "hle static" range and the build; `cpu.setD`, `cpu.never()`; `rt.onHandleClosed` (svc CloseHandle
is told to the table); `rt.requestExit(code)` (the table's exit request ends the process through the process
machine's Exit: 0 for a host shutdown or a program handing over, 1 for an abort); `rt.hostAlloc`;
`rt.expectOutsideEvents()` and a wake on every event signal; the loader's summary line for unreferenced forced names;
`registerHid(rt, input, { handheld })` follows the table's operation mode. Front end stand-ins: vsync events tick at
every present (the page); the input box answers "no window", the web view "no web view", shared fonts are not
loaded and native images are 0: the table's own windowless answers, each in the log.

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
- **Three calls wait on the GPU** and park the calling guest thread (`cpu.waitFor`, below):
  `nvnSyncWait(sync, timeout ≠ 0)` when the recorder says the fence is not done: until the replayer's
  `gfx_fence_signal` for that fence (the replayer's exports are wrapped so the glue hears it), then the call is made
  again; `nvnQueueFinish`: until `queue.onSubmittedWorkDone()`; `nvnWindowAcquireTexture`: frame pacing, see below.
- **Frame pacing.** An acquire after the first waits for the next display frame. Wall clock: the embedder's
  `nextFrame()` (the Worker's `requestAnimationFrame`), else a timer `interval` × 16.67 ms after the previous
  acquire. Deterministic clock: exactly `interval` refreshes of guest time after the previous acquire, and not before
  the GPU has finished the previous present.

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

## Input and the window (`rt_hle.ts`)

- `registerVi`: `nn::vi::Initialize`, `OpenDefaultDisplay`, `CreateLayer`, `GetNativeWindow` (opaque tokens; NVN
  only stores the native window). nxnative takes over none of these: it runs the SDK's own nn::vi against its vi
  service. Without an SDK the take-over has to be at this level.
- `registerHid(rt, input)`: `InitializeNpad`, `SetSupportedNpadStyleSet`, `SetSupportedNpadIdType`,
  `GetNpadStyleSet`, `GetNpadState` and `GetNpadStates` for full-key and handheld, after nxnative `hle_hid.c`: the
  40-byte state, one player, docked (the pad is npad No1 with style FullKey; a handheld read gets a state with no
  attributes), supported ids and styles respected, stick direction bits 16..23 past 0x4000, histories filled with
  the current state under consecutive sampling numbers.
- `RtInput`: `set(pad)` from the embedder (the page sends keyboard and Gamepad API state when it changes; a press
  shorter than a read interval is latched), and `script("frame:key[+key][~frames],...")`, nxnative's DM_KEYS idea
  with frames (presents) as the time base so that it is deterministic; sticks as `L<x>/<y>` in hundredths.

## The page (`web/`)

`npm run web` → http://localhost:8080. Main thread: controls, canvas (handed to the Worker), keyboard and gamepad.
Worker: the runtime with graphics, the take-over table, the file system, the shader lookup and `runAsync()`. The
demo button runs `cube.nso`, built from `test/runtime/src` by `npm run web:build`. Files can be picked or dropped:
NSO files (the one named `main` first), a shader library (`.nxsl`; the older JSON shape `{ "<key>": { stage, wgsl,
... } }` still registers directly), a RomFS image (`.romfs`, `.img`, `.istorage`: the rom device, a standard RomFS;
nxnative's own packer writes `DMROMFS1`, which `src/fs` does not read). Saves go to the Origin Private File System
under `saves-<first 8 bytes of the main module's id>` (the program id is in the NPDM, which the page does not read).
Translated code is cached in the Cache API (`cacheLoad` at the start, `cacheSave` five seconds in and at a stop).
When `build/shaders` holds the in-page translator, `web:build` copies it beside the page and missing shader keys
are translated in a Worker. The state badge is the `process` machine's state (`rt_state`), the reason beside
`Stopped` is the data that state carries; no log text is parsed. Stop is the machine's `Kill` event, after which
everything the process held is released. The log shows every line, red ones in red, guest output in green.
"Guest instructions per second" is budget units × a ratio measured for the demo at build time; for other modules
only budget units are shown.

## Process lifecycle and faults

`Empty -Load-> Loading -LoadOk-> Ready -Start-> Running <-Pause/Resume-> Paused`, and `Stopped` (final) from
`Running` by `Exit`, `Break`, `Fault`, from `Loading` by `Fault`, and from `Ready`, `Running` or `Paused` by `Kill`
(the embedder's stop). `Stopped` carries `kind << 32 | value`:
exit code, break, or the fault kind. Every fault logs two red lines and `run()` returns; nothing is thrown:

```
[RED] fault: wasm trap in thread 0x1001 (#0) at pc=0x8000128: memory access out of bounds: the instruction 0xb9400268 at 0x8000128 loads or stores through x19 at an address below 0x8000000 (a null or host-area pointer) or beyond the end of the memory
[RED]   x0=0x0 x1=0x1f x2=0x0 x3=0x0 x29=0x780fffe0 x30=0x8000124 sp=0x780ffee0 nzcv=0x8
```

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

## Verified (`npm run rt:test`: 39 tests under Node; `npm run rt:browser`: RTB_COUNT in Chromium)

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
  the Worker's event loop serving timers meanwhile.
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

- **No memory protection by default.** A guest write below 0x0800_0000 overwrites host state and a null pointer
  reads zeroes unless the process runs with `guard: true` (about 6 % slower; see Memory). Text and read-only data
  are writable either way; an address at or above 4 GB wraps (contract).
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
- Graphics waits: `nvnSyncWait`'s timeout is not honoured once the thread parks; `QueueFinish` waits for submitted
  work, not for pending readbacks; acquire pacing knows one window. An NVN call costs a full `save_ctx`.
- nn::vi: four calls with opaque tokens, one display, one layer. nn::hid: one player, no Joy-Con styles, no
  six-axis, vibration or touch.
- `kill()` does not give linear memory back: the Runtime's memory goes when the last reference to it does (Node
  after a collection: level over 5 restarts; Chromium does not report it to a Worker, see Verified).
- Host functions are found by name at the first call of each stub; there is no arity or type information.
- Browser run needs the full Chromium build: in `chrome-headless-shell` 153 any out-of-bounds wasm access kills the
  renderer (SIGSEGV, not a `RuntimeError`).
- CI (`.github/workflows/ci.yml`) passes actionlint and a local run of each job's commands in a clean copy; it has
  not run on GitHub.
- `RT_GFX_KEEP=1` / `RT_KIT_KEEP=1` let `rt:build` go on with the last `gfx.wasm` or with kit tables that are out
  of date while another area is mid-edit. Never set in CI.

## Requests to other owners

- **gfx**: (1) `GfxHost.dispose()` that destroys what the replayer made (today `RtGfx` tracks textures and buffers
  by patching the device's `createTexture` / `createBuffer`); (2) a way to mark a shader key as pending
  (`gfx_shader_pending(key)`), so that the recorder does not report it missing and `RtGfx` need not drop that
  line by its text; (3) rebuild pipelines of a key that is registered again; (4) the items of
  `tools/shaders/README.md` "What src/gfx must change" still open for real shaders: uniform ranges of at least
  `uboSize` zero-filled, `cube-array`, the `extra` bindings (support buffer first), integer textures.
- **a64**: a larger or growable pc-map leaf arena (21 MB of translated code today); an executed-instruction counter
  if wanted (see Gaps); `faultFromError` for engines other than V8.
- **kit / every area**: a build that loads another area's wasm should check its kit stamp
  (`src/kit/host/stamp.mts`); the runtime, loader, kernel and fs builds write one.
- **shaders**: a `[JSExport]` call interface for the translator instead of `runMain` and its in-memory files (one
  `runMain` per stage costs about 40 ms warm), and the answer table as run-time facts from the bound state.
- **fs**: a reader for nxnative's `DMROMFS1` (or a packer that writes standard RomFS).
