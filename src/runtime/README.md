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
| `src/runtime/host/build.mts` | `npm run rt:build`: `build/runtime/{rt,kernel,loader,translator,helpers}.wasm` |
| `test/runtime/cases.ts` | The end-to-end tests, shared by Node (`run.mts`) and the browser Worker (`web/worker.ts`, `browser.mts`) |
| `test/runtime/src/` | The test modules (C and assembly), built into NSOs by `harness.mts` |
| `test/runtime/all.mts` | The root `npm test` |

```
npm run rt:test [-- <filter>]      # Node
npm run rt:browser [-- <filter>]   # headless Chromium through Playwright, in a Worker
npm test                           # kit, loader, kernel, a64 guests, runtime
```

## Memory

One `WebAssembly.Memory({ initial: 2048 pages, maximum: 65536 })`. Guest addresses are offsets (contract). The guest
side is the kernel's default layout (`src/kernel/README.md`); the host side, 0 .. 0x0800_0000, is this table
(`rt_layout.ts`; sizes in address order, so two ranges cannot overlap, and `rt_ranges_check` refuses a table with a
hole, an overlap or an empty range before anything runs):

| Range | From | To | Holds |
|---|---|---|---|
| null guard | 0x0000_0000 | 0x0001_0000 | nothing; a guest null pointer reads zeroes here |
| rt static | 0x0001_0000 | 0x0010_0000 | `src/runtime` static data (75 KiB used): process machine, fault record, clock, scratch, kit trace |
| loader static | 0x0010_0000 | 0x0020_0000 | `src/loader` static data (110 KiB used) |
| loader arena | 0x0020_0000 | 0x0080_0000 | module records, export tables, names (`ld_init`) |
| kernel static | 0x0080_0000 | 0x0120_0000 | `src/kernel` static data (8.5 MiB used: thread records with their context blocks, handle table, 8 MiB of alias page states) |
| gfx static | 0x0120_0000 | 0x0130_0000 | reserved for `src/gfx` static data (its `--memoryBase`); gfx is not instantiated by the runtime yet |
| gfx arena | 0x0130_0000 | 0x0230_0000 | reserved: the 16 MB of `gfx_init(arena, bytes)` |
| file staging | 0x0230_0000 | 0x0430_0000 | NSO file bytes, which the loader needs in memory until a module is pinned |
| pc map | 0x0430_0000 | 0x07FC_0000 | the translator's pc map: one `u32` per guest instruction of 0x07FC_0000 .. 0x0B88_0000 |
| host stubs | 0x07FC_0000 | 0x0800_0000 | the loader's stub region: 65536 stubs of 4 bytes |
| code | 0x0800_0000 | | modules, mapped one after the other with a free page between them |
| stack | 0x7800_0000 | 0x7810_0000 | the main thread's stack (1 MB by default), the first mapping of the kernel's stack region |

How each module gets its place: `asc --importMemory --zeroFilledMemory --memoryBase <range.lo>`
(`host/build.mts`). The kernel and the loader have no heap (`--runtime stub`, static data only), so "static data ends
below the range's end" is the whole check: `rt_static_check` compares `rt_static_end()`, `ld_heap_base()` and
`kernel_static_end()` with the table at start. Without `--zeroFilledMemory` asc writes every zero byte of the static
data into the wasm file (kernel.wasm: 8.9 MB instead of 24 KB) and into memory at instantiation.

**The pc map** costs as many bytes as the code it covers, and the kernel's code region is 252 MB while the whole
host area is 128 MB. Chosen: 60.75 MB of map in the host area, covering the stub region and the first 60.5 MB of the
code region (the stub region is put directly below the code region so that one map covers both). Only touched pages
of the map are resident. A pc beyond the map is still correct: the index-0 trampoline calls the glue, which keeps
those entries in a JavaScript map (`far`) and translates on first use (tested by mapping the modules at 0x0BC9_0000).
It is slower, and functions the translator added to a unit on its own are translated again when they are entered
indirectly. A game with more than 60 MB of images needs either a different kernel layout (a region for the map) or a
map that covers text only.

**Growth, not reservation.** The memory starts as the 128 MB host area and grows when something needs it: `ensure()`
for module images, the kernel's `commit()` for the heap, stacks and thread-local slots. Because the main thread's
stack is at 0x7800_0000, the first load grows it to 1921 MiB of *address space*. Measured: creating the memory at
4 GB at once costs 3 ms and no resident memory under Node 22 (RSS 43 -> 46 MB), growing from 128 MB to 1.9 GB 4.7 ms
and none; in Chromium a runtime is created and loaded in 15 ms growing and 8 ms reserving. So reserving is free
here, and so is growing; growing is the default because it keeps addresses above the memory's size trapping (the
"load beyond memory" test) and because nothing was measured on other engines. `RuntimeOptions.reserve4g` switches.
What is not free: `kernel_init` initializes one kit instance per alias page, 8 MB touched and about 5 ms per process.

**Not on the shared memory: the translator itself.** `A64Host` instantiates `translator.wasm` and `helpers.wasm`
with their own memories and no memory import, and I may not edit it. The translator is a compiler: it holds a copy of
the code window (plus half as much again for marks) and a 40 MB output buffer, none of which the guest needs to see.
The core module and all units are on the shared memory. Also not possible today: a memory with `shared: true`
(SharedArrayBuffer). The modules the translator emits declare their memory import unshared, and the engine refuses
the link (`mismatch in shared state of memory`). Both are requests to the a64 owner (see the end).

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
4. Returning from the entry (pc = 0xFFFF_FFF0) ends the process with exit code w0; so does `svc 0x07` with w0.
   `fini_array` and `DT_FINI` are not run.

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
- **`mrs cntpct_el0`** = `kernel_guest_ticks()` after a tick. The kernel asks that a read waits while the clock is
  frozen for background; that is **not done**: an `mrs` is not a point where translated code can unwind, so the read
  returns the standing value and one red line says so (see Gaps).
- **Per-thread CPU state outside the context block**: `depth` is set to 0 by `core.run()` before every dispatch, and
  a thread only leaves the core by a full unwind, so nothing is carried over. The exclusive monitor (`excl_addr`,
  `excl_val`, `excl_val2`) is cleared (`excl_addr = -1`) whenever the next slice belongs to another thread, as a
  context switch does on a CPU; a thread resumed after another ran fails its pending STXR and retries.
- **Translator window and region mode**: one `setCode` window from the first image's base to the last image's end,
  set once after relocation. The entry scan and the 64 KB chunk units work on it unchanged (all tests run in this
  mode; `maxInsns: 1` is used once to count instructions). The stub region is outside the window by construction.
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
- A stub with no host function behind it is a jump fault.

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

## Process lifecycle and faults

`Empty -Load-> Loading -LoadOk-> Ready -Start-> Running <-Pause/Resume-> Paused`, and `Stopped` (final) from
`Running` by `Exit`, `Break`, `Fault` and from `Loading` by `Fault`. `Stopped` carries `kind << 32 | value`:
exit code, break, or the fault kind. Every fault logs two red lines and `run()` returns; nothing is thrown:

```
[RED] fault: wasm trap in thread 0x1002 (#1) at pc=0x80001e8 (last synced pc, the fault is at or after it): memory access out of bounds
[RED]   x0=0x0 x1=0x45 x2=0x0 x3=0x0 x29=0x8006170 x30=0x80001e8 sp=0x8006070 nzcv=0x8
```

| Fault | Comes from | pc |
|---|---|---|
| `unimplemented` | the translator's `unimpl(pc, insn)` import | exact; `aux` = the instruction word |
| `brk` | the `brk(pc, imm)` import | exact |
| `jump` | the translate callback: the pc is not in a loaded module's text (or not translatable, or a reserved value) | the target; x30 is where it came from for a call |
| `trap` | `WebAssembly.RuntimeError` or stack exhaustion out of `core.run()` | the last pc written back (function entry or last call): registers cached in wasm locals are lost |
| `stack` | the check at the end of a slice: `sp - 1` is in a free segment (`kernel_query_memory`) | where the slice ended |
| `deadlock` | every thread waits and no wait has a deadline | of the last thread that ran |
| `load` | the loader or the kernel refused a file | none |
| `host` | an exception in glue or in a host function | last written back |

## Verified (`npm run rt:test`: 22 tests; the same 22 in Chromium with `npm run rt:browser`)

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
- `process` machine: all 9 transitions (`npm run kit:test`).

Measured on the development machine (4 cores), run time without translation:

| | Node 22.23 | Chromium 153 |
|---|---|---|
| (g) corpus, 160.1 M guest instructions | 306-333 M insn/s (0.48-0.52 s, three runs) | 176-247 M insn/s (0.65-0.91 s, three runs) |
| (c) threads, 6.46 M guest instructions | 454-492 M insn/s (13.1-14.2 ms) | 616-653 M insn/s (9.9-10.5 ms) |

(c)'s instruction count is taken from a run with `maxInsns = 1`, where a budget unit is one instruction; its run
time is the best of five normal runs and is so short that the figure is rough. (g) is slower here than in the
translator's own runner because of the slices (budget 100000 instead of 2^30) and the context copies per SVC.

## Gaps

- **No memory protection.** Linear memory cannot protect pages. A guest write below 0x0800_0000 overwrites the
  kernel's or the loader's static data; a null pointer reads zeroes; text is writable; an address at or above 4 GB
  wraps (contract) and hits whatever is there. Only an access past the memory's current size traps.
- **Stack overflow is found late**: at the end of the slice, when sp is already in unmapped memory (with the default
  budget up to a few MB below the stack: the test ends 3.6 MB below). A stack that borders mapped memory (a thread
  stack inside a module's bss) overflows into it unnoticed. Recursion does not exhaust the wasm stack any more (the
  translator's depth limit unwinds), so the engine does not catch it either.
- **After a trap the pc and registers are stale** (last write-back). The translator would have to write back before
  every access that can trap, or keep a pc side table.
- **The translator is not on the shared memory, and the memory is not `shared`** (above). Workers per core need both.
- **One translator code window** over all images, copied; data between the texts is in it. A jump into a module's
  data is caught only when it enters through the translate callback (indirect); a direct branch inside the window is
  followed by the translator.
- **No dynamic modules in the loop**: `ld.parse/map/relocate` work, but nothing calls `setCode` again, adds the text
  range or tells the kernel (NRO loading belongs to `nn::ro`, not written).
- Deterministic time counts budget units, not instructions, and an SVC costs nothing; a guest that spins on
  `cntpct_el0` without a backward branch or call would not see time move.
- Wall-clock idle uses `Atomics.wait` (a Worker or Node); on a browser's main thread it would spin. There is no
  asynchronous `run`: the embedder calls `run({ ms })` in a loop to keep a Worker responsive.
- The kernel's background freeze is not honoured by `mrs cntpct_el0` (red line once). Doing it needs the translator
  to treat the read like an SVC (pc written back, pc check after the import) and a kernel wait that does not write
  x0/x1 into the context as the GetSystemTick wait does.
- gfx is not attached: its two ranges are reserved and `cpu.call` exists, nothing more.
- `fini` functions never run. TLS relocations stay unsupported in the loader. File staging is 32 MB.
- Host functions are found by name at the first call of each stub; there is no arity or type information.
- Browser run needs the full Chromium build: in `chrome-headless-shell` 153 as installed here, any out-of-bounds
  wasm access kills the renderer (SIGSEGV, not a `RuntimeError`), with or without `--js-flags=--no-wasm-trap-handler`.
- CI (`.github/workflows/ci.yml`) was written but never run; it does not run the browser tests.
