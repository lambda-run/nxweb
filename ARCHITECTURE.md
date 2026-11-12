# nxem: an Emscripten-threaded core for the browser port

Status: design for a spike (2026-11-12). What is proven is in REPORT.md; everything else here is a proposal.
Paths: `nxnative/` = `vm/ctl/repos/nxnative` (commit dbf84998), `nxweb/` = the nxweb working tree (2610451).

## The idea in one paragraph

nxnative already has the thread model the browser port lacks: one host thread per guest thread, one global
kernel lock, per-thread condition variables, and the list of workarounds this game needs. It is C. Emscripten turns
C pthreads into Web Workers over one shared `WebAssembly.Memory`. nxweb already has the two things nxnative cannot
bring to a browser: a translator that turns ARM64 into wasm at run time (with a tested shared-memory mode) and a
WebGPU replayer with a shader pipeline. nxem is nxnative's host compiled by Emscripten, with two seams rebuilt:
guest execution (each pthread drives its own instance of nxweb's translated code) and graphics (nxnative's NVN
recorder feeding nxweb's replayer instead of Metal).

```
 page (main thread: canvas, input, WebGPU device, audio worklet; never blocks)
   |  postMessage / SharedArrayBuffer rings
 Emscripten module, PROXY_TO_PTHREAD  ---- one shared memory (memory64), no growth ----
   | pthread = Web Worker each:
   |   guest thread N : [own wasm table][own a64 core instance = CPU state][own instance of every unit]
   |        translated code --svc import--> nx_svc() --> hle_thread.c / hle_svc.c ... (C, same thread)
   |        translated code --stub pc----> nx_host_call() --> HLE C function (nn:: take-overs, NVN recorder)
   |   translator thread : nxweb A64Host (the only realm that owns the translator), publishes unit bytes
   |   GPU feeder thread : drains the NVN record stream into a ring the page's replayer reads
   |   host helpers      : audio renderer, movie decode, fs, as nxnative has them
```

## 1. What compiles nearly as it is

"Nearly" has a measured meaning for the first file: `hle_thread.c` (1,362 lines) needed 3 edits (kernel/port_thread.py)
and 3 small shim headers (kernel/shim/) to compile and pass a stress test under Emscripten pthreads.

| nxnative file(s) | lines | what it needs | notes |
|---|---|---|---|
| host/hle_thread.c (threads, locks, condition variables, address arbiter, events, sleeps, yields) | 1,362 | done in the spike: shims for Mach/QoS, stub for the pause signal, guest calls through `nx_guest_call` | G at :104, `block` :273, `pick` :247, `note_runnable` :259, `dm_yield_to_core_peers` :215, lock words :296-318, CreateThread :1020-1036, WaitProcessWideKeyAtomic :1128-1153 |
| host/thread.c, hle_guestthread.c, hle_bigstack.c | 235 | rewrite small parts: TLS/TLR slots are per-thread wasm globals (`tpidr`, `tpidrro`) of the core instance, not pthread keys; "big stack" has no meaning (the guest stack is guest memory, the host stack is the worker's) | |
| host/hle_os.c, hle_time.c, hle_misc.c, hle_account.c, hle_friends.c, hle_mii.c, hle_oe.c, hle_offline.c, hle_net.c, hle_swkbd.c, hle_web.c, hle_sf.c, hle_ro.c, hle_sdk16.c, hle_sdkinit.c, hle_table.c | ~2,700 | mostly none (0-4 Apple lines each); clock source; swkbd/web need a page UI | pure bookkeeping HLE |
| host/hle_fs.c, save_sync.c | 1,791 | POSIX files -> Emscripten FS: WORKERFS/OPFS for the game's RomFS (read-only, large), IDBFS or OPFS for saves; per-service mutex (:67) works as is | file access from pthreads must not proxy to the main thread per call (use OPFS sync access handles in a worker, or WasmFS) |
| host/hle_hid.c, hle_touch.c, hle_haptics.c | 1,496 | input source: a shared struct the page writes (Gamepad API) instead of GameController | pad_*.h, motion_*.h, *.m are Apple-only and are dropped |
| host/hle_audren.c, hle_codec.c (Opus), hle_audio.c | 1,658 | audren as is (mutex :107); the output device (CoreAudio AudioUnit, hle_audio.c:2) -> a ring buffer an AudioWorklet reads (nxweb has that worklet: nxweb/src/glue/audio_worklet.ts) | audren calls guest code (5 sites): through `nx_guest_call` |
| host/hle_codec_video.c, hle_movie*.c | 1,944 | the decode back end is VideoToolbox / dav1d (hle_codec_video.c:24-46): replace with dav1d compiled by Emscripten (threads work) or WebCodecs via a proxy to a helper worker; keep the queueing and the host-lock waits (hle_movie.c:160-174, hle_codec_video.c:55) | this is where nxweb's 8-core race lives; nxnative's ordering comes with the C |
| gfx/hle_nv.c, hle_vi.c, gfx/nvn/hle_nvn.c + *.inc (NVN entry points and the record stream) | ~6,000 of 21,800 | the recorder half is C and platform-neutral (guest threads record, submit under a lock: hle_nvn.c:87, nvn_queue.inc:110-174); the Metal half (nvn_mtl.m, host_msl.m, ~15,000 lines) is dropped | see seam 3 |
| host/hle_cheats.c, hle_fpslock.c, hle_uemalloc.c, hle_uecvar.c, hle_jit.c, hle_oodle.c, hle_glslc.c, probe.c, crash.c, memstat.m, front_mac.m, pad/motion/haptics *.m | ~7,000 | not needed for this game's boot, or Apple front end | skip |

All of this assumes the module is built with `-sMEMORY64=1` (wasm64): nxnative's HLE code overlays C structs on guest
memory and stores guest pointers in `void *` / `uint64_t`. With 8-byte pointers and the LP64 type sizes the structs
have the layout the code was written for, and a guest address is a C pointer with no translation (the guest's
address space *is* the linear memory). A wasm32 build is fine for the thread core (the spike ran both) but would
break every struct with a pointer field.

## 2. Seam: guest execution (proven in the spike, small scale)

nxnative jumps into rewritten native code (`dm_thread_enter`, host/entry.S:161-173) and guest code re-enters the
host through a gate (entry.S:41-160) and through imports bound to C functions by name (host/hle.h:7 `HLE(...)`,
hle.c `resolve_import`; 1,068 entries plus 417 `NVN(...)`). In nxem:

- **Per-thread instances.** Translated code keeps the CPU state in wasm globals of a "core" module instance
  (nxweb/docs/CONTRACT.md "Guest CPU state"), so every pthread instantiates its own core, its own copy of the helpers
  and its own instance of every translated unit, with a function table of its own. Table indices are the same in
  every thread, so the one pc map in the shared memory serves all (nxweb/test/a64/lse_threads.ts does this with four
  node threads; kernel/nx_guest.js does it inside Emscripten pthreads).
- **No dynamic linking in the Emscripten sense.** The units are not Emscripten side modules: they import only the
  memory, their thread's table, the core's globals, the helpers, and four functions (`svc`, `unimpl`, `brk`,
  `cntpct`). `-sMAIN_MODULE` / dlopen is not used and not wanted (it would force PIC and a shared table).
  The Emscripten module's own table is separate from the guest tables.
- **Unit registry in shared memory.** A `WebAssembly.Module` can only travel by `postMessage`, and a pthread that is
  running or blocked never reads messages. So the translator thread copies each unit's bytes into the C heap and
  appends `{bytes, len, table base}` to a registry (kernel/nx_guest.c); a thread instantiates what it is missing when
  it hits a slot it has not filled. Every thread's table is pre-sized and pre-filled with the core's "translate this
  pc" trampoline, so a call to a function another thread translated lands in `translate`, which syncs and returns the
  index. Each thread compiles the same bytes again; V8 shares compiled code between isolates of one process by wire
  bytes, which should make the second compile cheap (**measured only for tiny units; unverified at game scale**).
- **One translator realm.** nxweb's translator keeps state in wasm globals and in its `A64Host` object, so it lives
  in one thread. Any thread that needs code asks it over a mutex + condition variable (`nx_translate`), marked as a
  native wait so the kernel's same-core handoff does not count the asker as running. nxweb's translation cache
  (Cache API, async) must be loaded before the guest starts, on the page side, and handed over as bytes.
- **SVC.** The unit's `svc(n)` import saves the registers into the thread's context block (`core.save_ctx`, the
  0x330-byte layout of CONTRACT.md), calls `nx_svc(n, ctx)` in C on the same thread, and loads them back. `x0..x30`
  are at +0 exactly as nxnative's `regs[]`, so `svc_thread` takes the block as it is. Blocking SVCs block the worker
  in `pthread_cond_wait` (Atomics.wait), which is legal in a worker.
- **Host calls (take-overs, NVN).** As in nxweb (src/glue/rt_runtime.ts:374-379): a stub region whose pcs all map to
  one wasm thunk that calls a `host_call` import; the stub index selects the HLE function. New work: nxnative's HLE
  functions take their arguments by the C ABI because the guest calls them natively (hle.h:2-3). Here a generated
  thunk per entry must load `x0..x7` / `v0..v7` according to the C prototype and store the result. The prototypes are
  in the `HLE(mangled, ret, cname, args...)` lines, so a script can generate the thunks (as port_thread.py does for
  one file). **Not built in the spike.** Variadic entries and the few that take structs by value need hand thunks.
- **Host -> guest calls.** nxnative calls guest functions as C function pointers (`guest_sym`, 43 call sites in
  host/, more in gfx). Each becomes `nx_guest_call(pc, args)`: a nested run of the calling thread's core until a
  return sentinel pc (proven: REPORT.md). The call sites must be edited or the function-pointer typedefs wrapped.
- **Thread exit.** `ExitThread` calls `pthread_exit` from inside translated code; Emscripten unwinds the worker's JS
  and wasm frames and returns the worker to its pool with the core instance intact (reused by the next guest thread:
  no re-instantiation). Works in the spike.
- **Pausing (SetThreadActivity / GetThreadContext3).** nxnative stops a running thread with SIGUSR2
  (hle_thread.c:398-420). No signals in a worker: the target must stop itself at a yield point. The translator
  already has a budget counter checked at back edges and calls; a pause request has to make the target's next check
  fail (a shared flag the check reads, or a per-thread budget cell in memory instead of a wasm global). **Needs a
  translator change; not needed by this game as far as known (IL2CPP's collector uses it); unverified.**
- **Faults.** nxnative uses SIGSEGV handlers for dirty tracking and lazy pages (hle_svc.c). A wasm trap ends the
  thread's run; nxweb turns traps into fault reports. Anything nxnative does with `mprotect` must become explicit.

## 3. Seam: memory (the largest rewrite after graphics)

nxnative reserves the guest address space with `mmap` and implements SetHeapSize / MapMemory / QueryMemory with
`mprotect`, fixed mappings and file-backed pages (host/hle_svc.c:260-318, :809-883; loader.c:804-818). A wasm memory
is flat: no protection, no aliasing, no reserve-without-commit beyond what the engine does.

- Emscripten's own data, stacks and heap must sit in a hole of the guest's layout. `-sGLOBAL_BASE` moves them (the
  spike puts them at 256 MB in a 32-bit memory and at 7 GB in a 64-bit one; nxweb's host area 0..0x0800_0000 stays free
  for the translator's tables). The guest's 8-9 GB pool and the 16 GB limit V8 gives a 64-bit memory leave little
  room: the layout needs to be planned with nxweb's `rt_layout.ts`, not improvised.
- **No growth.** `ALLOW_MEMORY_GROWTH` with pthreads makes every JS view stale on growth and every access check it;
  the translated units import the memory with a declared maximum that must cover the real one. Create the memory
  once at its final size (initial = maximum, shared). Whether Chrome commits or only reserves an 8-12 GB shared
  memory64 on the user's machine is **unverified** (node in the VM reserved 8 GB without trouble).
- MapMemory (the SDK moves thread stacks with it) has to copy or use nxweb's alias-page model
  (nxweb/src/kernel/README.md:128). Port nxweb's memory manager semantics to C, or keep nxweb's AssemblyScript kernel
  module for memory SVCs only and call it under G. To decide.
- memory64 costs speed in every engine today (explicit bounds checks): same cost as nxweb, no difference between
  the two routes.

## 4. Seam: graphics

nxnative: guest threads record NVN commands, one thread owns the GPU, submit happens under a lock
(gfx/nvn/hle_nvn.c:87, nvn_queue.inc:110-174), Metal executes (nvn_mtl.m). nxweb: an AssemblyScript recorder with
the same record stream ("57 OP_* in both", reports/gap-table.md headline counts) and a TypeScript replayer on WebGPU
(nxweb/src/glue/gfx_host.ts) plus the shader pipeline (nxweb/src/shaders).

Proposal: keep nxnative's C recorder (it has 489 implemented entry points against nxweb's 380) and make its submit
write the record stream into a shared ring; the replayer (gfx_host.ts, unchanged) runs on the page's main thread or
in a dedicated plain Worker with an OffscreenCanvas and reads the ring. WebGPU objects cannot be shared between
workers, so exactly one realm replays, which is nxnative's "one thread owns the GPU" rule. Open points:

- nxweb's replayer consumes nxweb's "lowered" stream (src/gfx/lower.ts), not nxnative's raw record stream. Either
  port lower.ts to C or keep it in JS in the replayer realm. **How far the two streams have drifted is unverified.**
- Calls that return data synchronously (queries, texture read-back, `nvnQueueFinish`, sync objects, present pacing)
  need the guest thread to block on a futex until the replayer answers. A blocked pthread can wait; the page's main
  thread cannot, so the replayer must never wait on a guest thread.
- Shader conversion stays where nxweb has it (workers + cache); the C recorder only needs shader identity.

## 5. Emscripten constraints that shape the design

- **PROXY_TO_PTHREAD is required.** The browser's main thread may not block (`Atomics.wait` throws there) and every
  kernel wait blocks. The main thread only runs the page, creates workers (pthread_create is proxied to it, so it
  must keep returning to its event loop), and replays graphics.
- **Thread creation is asynchronous** unless a pool is warm (`-sPTHREAD_POOL_SIZE`). The game creates dozens of
  threads; `StartThread` returns before the worker runs anything, which nxnative already tolerates (its
  `dm_thread_service_connect` waits for started threads to be dispatched, hle_thread.c:159). A new worker needs
  ~30-80 ms once to build its table and core (measured, tiny guest); with a real game it also has to instantiate all
  units translated so far. Pre-warm the pool before boot.
- **Cross-origin isolation** is already in place for nxweb's page (SharedArrayBuffer).
- **Blocking file and network calls from pthreads** are proxied to the main thread by default in Emscripten's FS;
  that puts a round trip and the main thread's latency into every read. Use WasmFS + OPFS or a dedicated I/O worker.
- **Toolchain.** Emscripten 4.0.22 with Alpine's clang 22 and binaryen 129 works for wasm32 and wasm64 with pthreads
  (SETUP.md). No Emscripten SDK binaries exist for musl, so the distro compiler is the only option in this VM.
- **Debugging.** No signals, no thread suspension, no backtraces of other threads: nxnative's hitch and deadlock dumps
  (hle_thread.c:472-535, :670-790) print less. The kernel's own state (who waits on what) still prints.

## 6. What "boots the game to the title" needs, in order

| step | work | size (rough) | done when |
|---|---|---|---|
| 0 | this spike: thread core + guest seam | done | REPORT.md |
| 1 | wasm64 build as the only build; memory layout shared with nxweb's rt_layout; fixed 12-16 GB memory in Chrome | S, but a **blocker if Chrome refuses the size** | page creates the memory and both sides agree on the map |
| 2 | loader: reuse nxweb's NSO loader output (it already places modules and builds stubs) or port nxnative loader.c without mmap; `guest_sym` / `module_of` from its symbol tables | M | main NSO mapped, entry translated |
| 3 | memory SVCs (hle_svc.c without mmap/mprotect) | M-L | SDK init runs: heap, stacks mapped, QueryMemory sane |
| 4 | HLE thunk generator + stub region + `nx_guest_call` at all 43+ call sites | M | 1,068 entries callable; `511 forced names hit, 0 unresolved` as in nxweb's run b1 |
| 5 | bring over the plain HLE files (os, time, fs on OPFS/WORKERFS, hid from the page, account, oe, sf) | M | game reaches its first NVN call |
| 6 | graphics: C recorder -> ring -> gfx_host.ts; synchronous answers | L (the biggest unknown) | first frame on the canvas |
| 7 | audio out through the worklet; movie decode (dav1d-wasm or WebCodecs proxy) | M | logo movie plays, title music |
| 8 | translation cache, thread-pool warm-up, per-thread unit instantiation at game scale | M | boot time comparable with nxweb |

Sizes: S = under a day, M = days, L = a week or more, for one person who knows both trees.

## 7. Blockers and unknowns (honest list)

1. **Game-scale unit instantiation per thread.** The game has on the order of 10^5 translated functions in thousands
   of units, and every guest thread (20-30) needs its own instances. Memory per instance and compile time per thread
   are not measured. If V8's cross-isolate code sharing does not hold, this alone can sink the route. First thing to
   measure after the spike: publish nxweb's real translation cache for this game into the registry and time thread 2.
2. **Globals as CPU state.** The per-thread-instance design exists only because the translator keeps registers in
   wasm globals. The alternative (registers in memory, one instance for all threads, units shared by all workers
   through one `postMessage` at start) is a translator change in nxweb and would cost speed. Not needed if (1) holds.
3. **Chrome and a fixed 12-16 GB shared memory64.** Unverified on the target machine.
4. **Graphics stream compatibility** between nxnative's recorder and nxweb's replayer. Unverified.
5. **HLE argument marshalling** for 1,068 + 417 functions: mechanical, but every wrong thunk is a silent bug.
6. **Pause/GetThreadContext3, fault-driven features**: need translator support; believed unused by this game.
7. **A second kernel.** nxweb's AssemblyScript kernel, HLE and recorder (about 15,000 lines) would be retired in
   favour of nxnative's C. Fixes made in nxweb since the port (memory64 audit, alias pages, WebCodecs path) have to be
   carried over by hand.
8. **Same-core handoff under worker scheduling.** nxnative's handoff waits in 50 µs sleeps for a woken thread to
   block (hle_thread.c:215-231). Workers wake more slowly than Darwin threads (measured: ~10 µs per uncontended
   SVC, tens of µs for a wake); timing-sensitive workarounds (yield back-off :791-820, clock-wait prediction
   :851-893, `sleep_precise` :976) were tuned on Apple hardware and will need re-tuning.
