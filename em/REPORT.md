# nxem spike report (2026-11-12) — condensed by the coordinating session

Question: is an Emscripten route (real pthreads on Web Workers over one shared memory, nxnative's C kernel, nxweb's
translator and graphics) a better foundation for threads than finishing nxweb's own shared-memory mode?

Short answer: the two hardest pieces work, in node, at toy scale. Nothing ran in Chrome and nothing ran the game.
All runs were in the Alpine VM at load 9-12 (other agents), so timings are noisy and pessimistic.

## Proof 1: nxnative's thread core under Emscripten pthreads — PASS
- `dm/host/hle_thread.c` (1,362 lines) compiles with 3 scripted edits (`kernel/port_thread.py`), 63 lines of shim
  headers and 30 lines of stubs.
- Stress test, 8 pthreads: 592,742 thread SVCs, counters exact, no deadlock; three 16-thread runs also pass.
  Covers ArbitrateLock/Unlock, WaitProcessWideKey/Signal, events + WaitSynchronization, sleeps, WaitForAddress.
- nxnative's own unit tests of that file pass unchanged: t_condvar (+ negative control), t_sync_wait 7/7,
  t_pollwait 6/6, t_clockwait 4/4.

## Proof 2: translated ARM64 guest threads in parallel, SVCs into the C kernel — PASS
- Guest threads created by the ARM64 guest run nxweb-translated code on separate workers; seam is
  `kernel/nx_guest.c` + `kernel/nx_guest.js` (257 lines).
- Passes in a 32-bit memory and in memory64 with the guest above 4 GB, for ARMv8.0 exclusives and for LSE.
- 4-thread guest mutex counter exact at 12,000,000. Compute scaling: 2 threads x1.57-1.99, 4 threads x2.35-3.43.
- Lazy translation from any thread and a host-to-guest call work.

## Scale check
A synthetic guest of 455,061 instructions (9.86 MB of wasm): each further thread costs 23-126 ms to compile and
instantiate and 9-16 MB of memory above an empty worker. The game is perhaps 10-50 times that (a guess).

## Not verified
Chrome; game scale (thousands of units x 20-30 threads); graphics, HLE marshalling, memory SVCs, files, audio,
movies (designed in ARCHITECTURE.md, not built); whether the movie decoder behaves with this kernel.

## Opinion of the agent that ran the spike
Go for Emscripten as the kernel and thread foundation, behind a 1-2 day gate: (1) in Chrome, a fixed shared memory64
of the game's size with 24 pthreads; (2) the game's real translation cache through the per-thread unit registry,
measuring the cost of the 2nd and 20th thread. Its rough estimate to the title screen is 5-8 weeks of ordinary
engineering time (a guess). If nxweb can put a guest thread on its own Worker within days, staying with nxweb is
shorter; the per-thread-instance seam is plain JS and nxweb can take it as it is.

Toolchain: Emscripten 4.0.22 under /ctl/emsdk using Alpine's clang (see SETUP.md). 4 local commits, nothing pushed.
