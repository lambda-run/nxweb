# nxweb architecture

nxweb runs Nintendo Switch code modules in a browser: ARM64 code is translated to WebAssembly, the Horizon side
(kernel, loader, SDK functions, file system, graphics, audio) is AssemblyScript on the same linear memory, and
TypeScript glue connects it to the browser's APIs. It is a port of nxnative (`docs/PORTING-STATUS.md` says of what).
The rules every area shares are in `docs/CONTRACT.md`.

## The pieces

| Piece | Where | What it is |
|---|---|---|
| Kit | `src/kit`, `docs/machines` | State machines as data: every lifecycle is a table generated from `src/<area>/defs/*.json`; `kit:test` fails while a transition has no test |
| Translator | `src/a64`, `src/glue/a64_host.ts` | ARM64 → WebAssembly, a unit (wasm module) per 64 KB chunk of functions, on demand; CPU state in wasm globals of one core module; a two-level pc map in memory |
| Loader | `src/loader` | NSO / NRO into guest memory, relocation, binding against other modules and host functions (stubs) |
| Kernel | `src/kernel` | Horizon's SVCs for one process: threads on four virtual cores, locks, condition variables, events, memory, the guest clock. Never blocks, never reads a clock |
| Runtime | `src/runtime`, `src/glue/rt_*.ts` | One guest process: the one memory, the run loop, host-call dispatch, faults, the process machine; attaches everything below |
| Graphics | `src/gfx`, `src/glue/gfx_host.ts` | NVN: a recorder (AssemblyScript) lowers submitted commands to a host stream, a replayer (TypeScript) makes the WebGPU calls |
| Shaders | `tools/shaders`, `src/shaders`, `src/glue/rt_shaders.ts` | Maxwell shader binaries → SPIR-V (Ryujinx's translator) → a SPIR-V pass → WGSL (naga); offline into a library, or in the page in a Worker |
| File system | `src/fs`, `src/glue/fs_*.ts`, `rt_fs.ts` | nn::fs on RomFS images and transactional save containers (OPFS) |
| SDK take-overs | `src/hle`, `src/glue/hle_*.ts`, `rt_hle.ts`, `rt_ro.ts` | The SDK functions nxnative answers on the host, by mangled name: nn::oe, time, account, network (offline), libc pass-through, nn::vi, nn::hid, nn::ro |
| Audio | `src/audio` | nn::audio (another area; not attached to the runtime yet) |
| Page | `web/` | Main thread: controls, canvas, input. Worker: everything above and the run loop |

## The memory map

One `WebAssembly.Memory` (wasm32, up to 4 GB). A guest address is an offset into it.

```
0x0000_0000  host area (128 MB): one range per module, from src/glue/rt_layout.ts
               null guard | rt | loader + arena | kernel | gfx + arena | file staging | hle | fs + arena
               | a64 translator, helpers, entry bits, pc map | host stubs (65536 x 4 bytes, directly below the code)
0x0800_0000  code region (252 MB): module images, a free page between them; host allocations above them
0x17C0_0000  thread-local region: 0x3000 per thread (TLR, thread object, TLS block)
0x1800_0000  heap (svcSetHeapSize), up to 1.5 GB
0x7800_0000  stack region: the main thread's stack first; MapMemory destinations
0x8800_0000  alias region (MapPhysicalMemory), to 0xFFFF_0000
0xFFFF_FF00  special pc values (0xFFFF_FFF0 return to host, 0xFFFF_FFE0 yield)
```

Every AssemblyScript module is built with `--importMemory --memoryBase <its range>` and has no heap; the runtime
checks at start that the table tiles the host area and each module's static data ends inside its range. With the
`guard` option guest loads and stores are compiled so that an address below 0x0800_0000 traps, which keeps guest
bugs out of host state (about 6 % slower, so off by default). The memory starts at 128 MB and grows on demand.

## The life of a guest call, from translated code to WebGPU and back

Take `nvnQueueSubmitCommands(queue, 1, &handle)` in a game's render thread.

1. **Translated code.** The call is `bl` to a PLT entry, which loads the function pointer the game got from
   `nvnDeviceGetProcAddress` and branches to it: an indirect transfer. By the contract the unit writes the registers
   it caches in wasm locals back to the CPU-state globals, sets `pc` to the target and does
   `call_indirect table[pcmap[pc]]`.
2. **Stub.** The target is a host stub (`stubBase + 4 * id`, in the host area). Every stub pc maps to one thunk in
   the function table, a 52-byte module whose only function calls the import `host_call`.
3. **Dispatch** (`Runtime.hostCall`). The id is `(pc - stubBase) / 4`; the handler is the one registered under the
   loader's name for that id. It gets a `HostCpu`: registers, guest memory, `block`, `waitFor`, `call`, `never`.
4. **NVN recorder.** `RtGfx`'s handler copies x0..x7 and d0..d7 into an argument block (`rt_nvn_args`) and calls
   `nvn_call(id, args)` in `gfx.wasm`. For a submit, `lower.ts` walks the command records the game recorded into
   its own command memory, runs the render pass machine and the pipeline cache, and writes a flat host stream.
5. **Replayer.** The recorder calls its import `gfx_exec(ptr, len)`; `GfxHost.exec` reads the stream from linear
   memory and makes the WebGPU calls: buffer uploads (hashed, cached), bind groups, passes, draws, `queue.submit`.
6. **Back.** `nvn_call` returns x0; the handler's result goes to x0, `pc := x30`, the thunk returns, the calling
   unit sees the pc it expects and goes on.
7. **When the call must wait** (`nvnWindowAcquireTexture` for the next frame, `nvnSyncWait` on a fence, an fs call
   on storage): the handler returns `cpu.waitFor(promise, at, resume)`. The glue saves the context with pc = the
   stub, makes a kernel WaitSynchronization on an event kept for the thread, sets pc to the yield value, and every
   translated frame unwinds by the contract's pc check. The run loop schedules other threads, or returns to the
   event loop (`runAsync`) when nothing can run. When the promise has resolved and guest time has reached `at`, the
   glue signals the event; the kernel wakes the thread, it enters the stub again, the dispatcher finds its `resume`
   and the call completes.

An SVC takes the short path: `svc #n` calls the import `svc(n)`, which saves the context, calls `kernel_svc(n, ctx)`
and either loads the context back (continue) or unwinds (the thread waits, or a better one is ready).

## How to add a host function

```ts
const rt = new Runtime(mods, { log: console.log });
rt.register({ name: "_ZN2nn3foo3BarEi", forced: true,           // forced: wins over a module's own definition
  fn: cpu => { const x = cpu.w(0); /* ... */ return 0; } });    // the result goes to x0 (cpu.setD(0, bits) for d0)
rt.loadNso(files);                                              // register before loading
```

`name` is the symbol in the module's dynamic symbol table. A function that waits returns `cpu.block(event, timeout,
resume)` or `cpu.waitFor(promise, at, resume)`; one that calls guest code uses `cpu.call(fn, ...args)`. A function
with logic belongs in AssemblyScript: an SDK function that nxnative takes over goes into `src/hle` (its README, "Adding a take-over": the table is
generated from nxnative's sources), an nn::fs name into `src/fs`, an NVN entry point into `src/gfx/dispatch.ts`;
the glue only routes. A test guest declares the import with an asm label and the test checks what it printed
(`test/runtime/src/hleg.c`).

## How to add a state machine

1. Write `src/<area>/defs/<name>.json`: `name`, `doc`, `states`, `initial`, `final`, `events`, `transitions`
   (`[from, event, to]`), optional `data` per state (`src/kit/README.md`).
2. `npm run kit:diagrams` regenerates `src/kit/gen/tables.ts` and `docs/machines/<name>.md`. Machine ids are
   positions in the table: **every wasm module that uses the kit must be built again** (builds write a stamp,
   `src/kit/host/stamp.mts`, and the runtime refuses modules built from other tables).
3. In AssemblyScript: `Inst.at(ptr).init(NAME, 0)`, `.step(NameE.Event, data)`, `.can(...)`, `.state`. An event the
   table does not allow is refused and logged red by the kit; code does not carry its own state flags.
4. `test/<area>/<name>.machine.test.mts` takes every transition and checks every other pair is refused;
   `npm run kit:test` fails until it does.

## How to run each test tier

```
npm install; pip install unicorn capstone        # clang with the aarch64 target and ld.lld are needed too
npm test             # the fast tier: kit, loader, kernel, a64 guest programs (4 configurations), runtime under Node
npm run fs:test      # file system; npm run hle:test: take-over table; npm run shaders:test; npm run audio:test
npm run a64:fuzz     # instruction fuzz against Unicorn (338,000 cases; minutes)
npm run rt:browser   # the runtime's cases in headless Chromium: WebGPU pixels, the page, OPFS, in-page shaders
npm run a64:browser  # the translator's gates in Chromium;  npm run fs:browser;  npm run gfx:test (42 scenes)
npm run web          # the page, http://localhost:8080
```

Browser tests launch Playwright's full Chromium build with a software WebGPU adapter (SwiftShader).
`package.json` pins `playwright` 1.63.0; on the development machine the pre-installed copy of that version
(found through `NODE_PATH`, browsers under `PLAYWRIGHT_BROWSERS_PATH`) is what `require("playwright")` resolves to;
in CI `npm ci` and `npx playwright install chromium` provide it. Tests that need the nxnative checkout (`NXNATIVE`,
default `/home/user/nxnative`: `nvn.h` for the graphics guests, `home_quit.h`, layout references, the inventories)
print SKIPPED without it; shader tests that need the offline library or the in-page translator skip without the
artifacts in `build/shaders` (dotnet, cargo and nxnative build them). CI: `.github/workflows/ci.yml`, three jobs
(fast, fuzz, browser).
