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

# Memory, lock-free recording, fs worker (2026-11-13)

All numbers: headless Chromium 156 in the VM (4 CPUs, 8 GB + zram), the real game with a warm translation cache
(5,255 units, 363 MB of wasm), the default path (runtime in a worker), 240 s after the file was given (93 threads, the
intro; the 3D area is not reached in that time). Resident + swapped MB of the renderer process from `/proc/<pid>/smaps`
(`web/em_run.mjs` prints it every 60 s; `MEMINFRA=1` adds Chromium's own memory-infra dump). Real Chrome on the Mac was
not run.

## 1. Where the memory is

Every guest thread's worker is a thread of ONE renderer process, so "per worker" cannot be read from the process list;
blocked workers do not answer CDP either (`Runtime.getHeapUsage`, the memory-infra V8 dumps: "success: false"). What can
be had: the renderer's mappings by kind, the wasm memory by GB of address (pagemap), PartitionAlloc's total, the page's
own counters, and two unit costs measured apart from the game (`tools/chrome_costs.mjs`).

| renderer, MB | before (6f9e89f) | after |
|---|---|---|
| the 16 GB wasm memory, touched | 3,003 | 2,565 |
| of it the host heap (GB 14) | 571 (362 = the registry's copy of the units) | 196 (0) |
| of it guest: GB 0-3 (images, pc map, alias region) / GB 10-11 (guest heap) / the rest | 1,026 / 1,148 / 258 | 987 / 1,150 / 232 |
| PartitionAlloc superpages (1-4 MB mappings); memory-infra `malloc` | 1,409; 1,295 | 1,340; 1,088 |
| executable (compiled wasm and JS) | 598 | 676 |
| other anonymous (V8 heaps, tables, array buffers): 32-256 MB / >=256 MB / 4-32 MB / <1 MB | 456 / 288 / 339 / 374 | 455 / 317 / 321 / 372 |
| files | 394 | 362 |
| **renderer total** | **6,861** | **6,408** |

Other processes (GPU 0.9-1.3 GB with SwiftShader, browser 0.5 GB) are the VM's software GPU and are not the port's.

Unit costs in Chromium 156 (measured, no game): a function-table slot **12.6 bytes** (Node 24: 32, which is where the
earlier "32 bytes" came from); a compiled module that a worker is handed and never instantiates **0.68 KB per module and
worker** (5,255 modules: 3.5 MB a worker, 330 MB for 93); an idle worker 2.2 MB; a compiled module 12 KB at least.
With those: the threads' tables are about 225 MB in all (18.6 M slots in 71 threads that run guest code), the module
lists up to 330 MB. `translated wasm 363 MB` is held once by V8 beside the compiled code (inside `malloc`).

What changed (kernel/nx_guest.js, nx_owner.js, nx_worker_pre.js, nx_units.cpp, nx_proc.c):

- **The registry keeps no bytes of cached units.** The translator thread transfers each cached unit's bytes to the main
  thread (Emscripten's `callHandler` message), which compiles each once and hands the modules to every worker before it
  runs a thread, as before; the bytes never enter the host heap, and the translator realm drops them and the units'
  side tables (120 MB) too. Host heap 571 -> 196 MB. Units translated while the game runs keep their bytes in the heap
  (a running thread can only compile from bytes: a worker inside a thread never reads a message); with a warm cache
  that is 1-3 MB, with no cache it is everything, once. The cache is now a module's first file plus one file per later
  run (`<key>.d1`, ...): a run writes only what it translated.
- **A worker unpacks its list of modules when its thread first runs guest code** (the message is marked by a dummy
  port and kept unread; `malloc` 1,295 -> 1,088 MB together with the side tables). Threads that run no guest code
  (22 of 93) never pay for it.
- **Tables as long as the highest slot called**, slots handed out by use (units several threads used, then room for
  what the run translates, then the units one thread used, thread by thread; the counts are kept beside the cache as
  `units3-*.a64pop`). **This gained almost nothing** and the reason is measured: 209,526 of 265,000 slots belong to
  units that two or more threads used, and 69 of 71 threads end with a table over half the longest (median 235,520 of
  299,008 slots). The job workers each run a large, different part of the game. Paying only for the units a thread
  calls needs a per-thread index (the pc map's first level taken from a per-instance global instead of a constant
  folded into every unit): a translator change in nxweb's `src/a64`, not made here. At 12.6 bytes a slot the prize is
  about 200 MB, not the 600 MB the 32-byte figure suggested.

Not reduced, and why: the guest's own touched memory (2.4 GB: the game's heap, images, the alias region of mapped
stacks); compiled code (0.68 GB, V8's two tiers of 363 MB of wasm); V8's copy of the wire bytes (363 MB). The first
run without a cache still holds every unit's bytes in the host heap until the page is loaded again.
Verified: proof 2 (`M=64 sh run_p2.sh a78c`: P2 PASS), headless boot to presents (first present 30 s after the recorder
started, 844 presents in 240 s, the same 13 red lines as before, none new).

## 2. Lock-free command recording

What `nvnCommandBufferBindVertexBuffer` wrote: `const RANGE: usize = memory.data(16)` in `src/gfx/dispatch.ts`, 16 bytes
of static memory at one address for every instance of the recorder. The entry point stores the buffer's address and
size there and `bindVertexBuffers` reads them back; six threads at once read each other's values.
`nvnCommandBufferBindImage` uses the same 16 bytes. A wasm global does not show such a write, so the static audit
could not see it.

- `tools/gfx_dynaudit.mjs`, the dynamic audit: the recorder alone on a 512 MB memory of its own, a device, four command
  buffers per candidate, every candidate called with six made-up argument patterns while the static data, the globals
  block and the used arena are compared before and after. Result for the current gfx64.wasm: of the 228 entry points
  the static audit lets through, **58 + 66 stay lock-free** (builder setters; recording commands while the buffer has
  32 KB of room), 1 range of scratch (16 bytes at 0x1838d80) is found and passes the scratch test (two fill patterns,
  same records, same bytes left), **104 go back under the lock**: 99 because no pattern made them record anything
  (most are entry points nxweb's recorder answers without a record), 3 that trapped, 2 that only took their error path.
  It takes 4.5 s in Chromium (9 s in Node); the page keeps the verdict in the Cache API by the binary's SHA-256.
- `tools/globals_to_memory.mjs` `statics`: address constants inside such a range go through a new exported global
  `nx_tls` (default: the old address, so the owner's instance is unchanged); every guest thread's instance gets 16 bytes
  of its own (`kernel/nx_guest.js`). 5 constants are rewritten.
- `test/gfx_lockfree_test.mts`: now the full list, 66 recording commands, 6 with changing arguments, 6 workers, 49,896
  commands and 4.1 MB per buffer: **passes** (0 of 6 buffers differ). Negative control `NX_NO_TLS=1` (scratch shared
  again): fails, 4 of 6 differ. `NX_ONLY=4` (BindVertexBuffer alone): passes, and fails with `NX_NO_TLS=1`.
- Enabled by default in the page (`?lockfree=0` turns it off); Node keeps `NX_GFX_LOCKFREE=1`.
  Headless boot with it: first present 28.2 s, 680 presents in 200 s, the same 13 red lines as without, no recorder
  error; in the final default run (200 s, 697 presents) 450,889 NVN calls went without the lock and 854,803 under it (694 sleeps for it). Node boot harness with it: 27.5 s until its memory stop, 9 red lines, none from the recorder.

Not verified: the 3D area (six recording threads, 24,000 calls a frame) is not reached in a headless run, so the
frame-rate gain there is not measured, and neither is how much of that traffic is among the 124 lock-free entry points.
The dynamic audit sees only the paths its made-up arguments take; an entry point the audit could not make record stays
under the lock, so the hot ones among the 104 (BindTexture, the draws: check the list `node em/tools/gfx_dynaudit.mjs`
prints) need better argument patterns before they gain anything.

## 3. fs reads off the owner (`?fsworker=1`)

`owner/fs_worker.ts` (+ `owner/rom.ts`, the RomFS device shared with the owner): a dedicated worker holds the File,
builds the same RomFS device with FileReaderSync (up in 7.1 s, beside the boot), and has its own instance of the fs
module. With `?fsworker=1` the guest threads call the fs module themselves (`fsdirect`), a RomFS `dev_read` leaves its
request in a slot (NXW, 0x1FF1F200) and pends; the worker reads into the shared memory 8 MB at a time, takes the
module's lock, runs `fs_complete` in its instance, writes the result into the caller's context block and wakes it with
`Atomics.notify`. The owner is asked only for a device's first read (it tells the worker the device's id) and for
storage that is not the RomFS (saves). Off by default; without the flag nothing changed.
A first version hung at boot (a thread holding the module's lock waited for the slot while the worker waited for the
lock); the worker now empties the slot into its own queue also while it waits for the lock.

| headless, to the intro | first present | owner: fs sections | longest | over 8 ms | fs worker |
|---|---|---|---|---|---|
| default (owner reads), 249 s | 30.0 s | 13,049 entries, 2,401 ms (0.96 %) | 80.6 ms | 13 (390 ms) | |
| `?fsdirect=1`, 106 s | 27.8 s | 2,233 entries, 2,396 ms (2.26 %) | 124.7 ms | 17 (694 ms) | |
| `?fsworker=1`, 189 s | 28.2 s | 18 entries, 7 ms (0.00 %) | 2.2 ms | 0 | 2,222 reads, 340 MB, 7.9 s reading, longest 301 ms |

(`node em/tools/fs_stretch.mjs logs/<run>.console.txt`.) The owner's event-loop lag did not change (mean 12-15 ms, max
0.4-0.9 s in all three: the replayer and the decoder). Not verified: the loading of the 3D area, where the 0.8-2.4 s
stretches were seen (not reached headless); saves through this path; real Chrome.

## Staged build
`/em-next/` and, promoted by copying, `/em/`: the commit named in their `build.json`, built 2026-11-13 02:53 (lock-free
recording on by default, `?fsworker=1` behind its flag). The run that passed on the default path: `logs/r7` (headless,
200 s, first present 27.8 s, 697 presents, 13 red lines as before, renderer 6,298 MB).

## Round two, item 1 (the road to the 3D area): first findings only
- `web/em_run.mjs` takes `KEYS` (key presses over CDP: `KEYS="50-290/10:KeyZ,55-290/10:Enter"` = A and + every 10 s);
  `tools/movie_trace.mjs <console.txt>` prints per 10 s the AV1 packets in, the presents and the nn::fs entries.
- Without keys (logs/r7) the title movie plays from 50 s on and nothing else happens: 0 fs entries through 212 s.
  With A and + every 10 s (logs/k1, 300 s): from 170 s the game reads files again (504-1,274 fs entries per 10 s),
  sets 3,471 programs in one 11 s report, and writes `save commit #1` (the save mount, kind 3). So the buttons take it
  off the title into a load within 3 minutes of headless time. Whether + then cuts the story movie short was not
  followed (the run ended at 300 s with packets still arriving, 4-28 per 10 s).
- Saves: the page's save storage is `MemStorage` (owner_web.ts): a save does not outlive the page, so "Continue" in a
  later boot cannot work until saves go to OPFS. Not built.
- `?skipmovie=1` was not built.

# Round two (2026-11-13, second session): the road to the area, saves, and what is built but not yet run

Headless numbers: Chromium in the VM, 1-3 presents a second at the title and after (SwiftShader), runs end at 600-700 s
when the tab runs out of memory. Logs under `em/logs/` (k2, s1, s2, s3).

## The road to the first area
- **No button skips the story movie** as far as tested: A and + every 10 s (logs/k2) take the game off the title
  (`save commit #1`, then `content:/Event/Movie/Dm_Kokiri_0000.webm` is opened: the owner now logs every movie file
  opened); packets kept arriving until the run was stopped at 380 s. B and long holds: not tested.
- The story movie is 116,983,337 bytes, video only (V_AV1, Lavf), 154.2 s, 56 clusters, Cues at the end. The game
  feeds one packet per game frame, so its length in wall time is the frame rate's.
- **`?skipmovie=1`** (a test aid; the status line says so; `owner/rom.ts`): every `Dm_*.webm` but the title's is read
  as a valid short WebM that ends after its first cluster: the file's size in the RomFS tables is the start of the
  second cluster, and the Segment's size, the Info's Duration and the SeekHead entries that point past the cut are
  patched in every read (40 files, 2,287 MB read as 133 MB, 4.6 s each on average; Kokiri_0000: 5.0 s).
  - cut without the patches (logs/s2 headless, and the coordinator's Chrome ride): the player never ends, the last
    picture stays with the subtitles running (a parser that finds the file shorter than its Segment waits for data);
  - cut with the patches (logs/s3): title movie opened 76 s after the owner started, story movie 161 s, its last packet
    at about 440 s, then a BLACK screen (mean brightness 0.0 in the screenshots at presents 600-800) with file reads
    going on (200-500 nn::fs entries per 10 s) and units translated 8,512 -> 8,717, until the tab crashed at 615 s.
    The area itself is not reached headless; whether the black screen is the load into it has to be seen in Chrome.
- **Saves are stored** (`owner/owner_web.ts`: nxweb's `OpfsStorage`, directory `nxem-saves` of the origin's private file
  system, both containers opened before the game starts; needs the runtime in a worker, the default; `?saves=mem`,
  `?saves=new`). Verified: the second headless run with the same profile says "save 8768 bytes ... from earlier runs"
  and commits generation 2, the third generation 3. NOT verified: "Continue" (the only save written so far is the
  one at New Game; a save from inside the area needs a Chrome ride).
- Keys: the page latches a press for 150 ms (taps between two HID samples were lost); the headless runner takes
  `KeyZ*1500` (held 1.5 s) and `SHOTS="250,600"` (the canvas as PNG at present counts; `tools/png_diff.mjs a b`).
- Fastest known road: `…/em-next/index.html?skipmovie=1`, A and + alternately from the title.

## Built in this session, not yet run on the game (queue, one heavy run each)
1. `?vpipe=1` (owner.ts videoCall / vpDrop / vpAnswer, kernel/nx_video.c): a reset is a new generation (pictures of
   before it are dropped: `pipeline.stale`), a reset or close empties the pipeline and releases a waiting call,
   `[RED]` when pictures are handed over out of packet order (owner) or out of timestamp order (C, both modes);
   the report's `video.pipeline` counts. To do: title run with and without, compare `[codec] AV1 timing` pictures/s,
   look for the "does not fit the buffer" line; default only if clean. (Window: a call waits at 4 packets inside.)
2. `?asyncsubmit=1`: `ringKeys` checks the key record of every pipeline-create record when its batch runs (entry in
   use, hash as stored): the record points at the pipeline cache's own entry, written once and never moved or freed
   (src/gfx/pipeline.ts), so the batch is self-contained in effect; `ring.keys / keysBad` in the report. To do: title
   run against a plain one (and plain against plain as the control): SHOTS at presents 60,100,130 + png_diff, the
   `recorder lock held by:` table.
3. Lock-free coverage: `?lfaudit=1` (owner.ts startGfx, nx_guest.js nx_js_gfx_call): the first 12 real calls of each
   entry point the static audit lets through and the dynamic audit left locked are made under the lock with the
   recorder's static data, globals block and arena compared around them; `node em/tools/lf_real.mjs <console>` prints
   the clean names (to paste into `owner/lockfree_real.ts` with the SHA-256 of gfx64.wasm as `key`; `?lfreal=0` off)
   and, from `nvnCalls` in the report (kernel/nx_gfx.c counts by id), the top 20 entry points and the lock-free share.
4. Slow presents: the report's `presentSteps` (getCurrentTexture, blit, flush, queueSubmit, imageEvent per present,
   the slow ones listed). To do: read it from a title run (and from a Chrome ride's `nxem.owner`).
5. `?fsworker=1` with saves: not looked at.
Also: `local/zelda-loop` is merged (stream capture `?gfxcapture=`; the page's query is handed to the replayer:
`owner_web.ts` `capture: p.search`); the capture has not been seen working on this page yet.

## Later the same session: results and handover (staged `/em-next/` 504b604; `/em/` is 30cf000)

Verified headless (title, 240 s each, build 30cf000):
- default path (logs/t1, t2): 651 / 473 presents, 13 red lines, none new -> promoted to `/em/` as 30cf000.
- `?asyncsubmit=1` (logs/a1): 634 presents, 13 red lines, 3,781 ring batches, the one pipeline-create key checked was
  intact; the Presentation Thread holds the recorder's lock 18.5-19.2 ms a frame (plain: 45-78), of it waiting for the
  owner at a flush 12.8-14.0 (plain: 35-67). Screenshots at presents 150/180/220/300 against plain: equal, but black
  or nearly (brightness 0-1.7): NOT a lit-frame comparison. Off by default until one passes (SHOTS=450,600 at the title).
- `?vpipe=1` (logs/v1): the dropped picture is found: the owner woke the caller before it wrote the picture's packet
  number into the request block (wrong timestamps, or the caller's next request got the number as its buffer size:
  "does not fit the buffer"). Fixed (the number is written before the wake); the fix has not been re-run. Pictures
  left the pipeline in packet order (361 answered, 0 out of order, at most 4 inside). Picture rate headless 2.3-2.7 a
  second, plain 2.1-2.8: no gain there. Not default.
- NVN calls at the title (logs/t1, presents 194-659): 1,318 a present; 39.8 % to lock-free entry points, 59.7 % under
  the lock on the calling thread, 0.6 % on the owner. Top: BindTexture 15.2 % (free), nvnEventGetValue 14.5 % (lock),
  BindUniformBuffer 6.4 % (free), nvnDeviceGetTextureHandle 5.1 % (lock), BindStorageBuffer 3.8 % (free), the blend /
  channel-mask state setters ~3 % each (lock). The hot locked ones are entry points the STATIC audit rejects, not the
  104 candidates of the real-call audit: the next gain is in tools/gfx_audit.mjs (why EventGetValue,
  DeviceGetTextureHandle, MemoryPoolGetFlags and the state-object setters are rejected), not in ?lfaudit=1.
- slow presents, headless: 5 of 26 over 8 ms (max 15.6); the time is the present's blit (8-12 ms) or
  getCurrentTexture (up to 13 ms); queue.submit and the image events are small. In Chrome: `nxem.owner.presentSteps`.

In 504b604 and NOT yet run on the game by this session (the heavy lane was taken; the coordinator rides it in Chrome):
the game profile's graphics switches to the recorder (`?gfxprofile=0` off), shader wait on (`?shaderwait=0` off),
count-sized recording commands under the lock, the vpipe fix, `frameWork` (draws / submits / command buffers / passes
per present, the submit's lowering ms per present and us per draw, the recorder's time by entry point; in the status
line too), the merges of local/zelda-loop up to 0d40db1 with the main checkout's modules rebuilt (`nx rt`); the proof
test passes on that gfx64.wasm and the dynamic audit says 58 + 66, scratch 0x1838d40+16.

Open, in order:
1. Headless default-path check of 504b604 (or later): `SHOTS=300,450 LIMIT_MB=7500 URL="http://localhost:8080/em-next/index.html?secs=1500" sh run_page.sh 260 t4`,
   then `RUNS=t4 sh build/tmp/ab.sh` (not in git: grep the console for RED lines new against the 13, `FIRST PRESENT`,
   `"frameWork"`); with shader wait on and SHADER_CHAIN 12 the first boot translates every shader again. Promote by
   copying index.html em.js em.wasm build.json audio.js em_worker.js em_status.js fs_worker.js from em-next to em.
2. Lit-frame A/B for asyncsubmit (same command with `&asyncsubmit=1`, SHOTS=450,600, `node tools/png_diff.mjs`); a
   plain-against-plain pair as the control; default it if the frames match.
3. `?vpipe=1` again (no `[RED] nn::codec` line may appear); `?asyncsubmit=1&lfaudit=1` then `node tools/lf_real.mjs`.
4. Continue from the stored save (needs a save from inside the area: a Chrome ride on /em-next/ leaves one).
5. Profiling push: (a) lowering by record type inside the recorder needs counters in src/gfx (AssemblyScript, built in
   the main checkout): not started; from outside there is `frameWork.loweringMsPerPresent`; (b) CDP `Profiler.start`
   per worker target (em_run.mjs already auto-attaches workers: `Target.attachedToTarget`): not tried; (c) done
   (status line). 6. `?fsworker=1` with saves: not looked at.

# Round three (2026-11-13, third session): the frame time in the area, the shader "hang", the Mac's headless Chrome

Runs: VM headless (t5, t6: SwiftShader) and the headless Chrome on the Mac with the real GPU (hB-hE: `run_host.sh`).
**The 3D area was NOT reached by this session**: the game read from the VM's server (`?game=`) loads too slowly (see
"Open"), so every number for the area below is either the coordinator's ride on 504b604 or a benchmark, and the frame
time there with the changes is NOT measured.

## 1. The `?shaderwait` "deadlock" is not a deadlock
The owner was idle and alive (its report in the hanging ride: 0 % busy, event-loop lag 4 ms). The caller was parked on
`RtShaders.pending`, as designed, while its stages were TRANSLATED. The game hands over its 3,471 programs one call at
a time, so a wait per call puts one program at a time through the translator: one Worker, no batches, and the first
wait is the .NET runtime's start. Headless with an empty store (logs/t5, `?shaders=new`): 609 waits took 108.7 s, the
first 17.5 s, no present after 150 s. The headless runs before had a full store and never waited (t3: 0 parked).
Now (owner_web.ts): a call waits only while its stages are READ FROM THE STORE; the moment one goes to the translator
the call returns (the stages queue up, four Workers, batches; the replayer's red line says while draws are skipped).
`?shaderwait=all` waits for translations too; any wait ends after 20 s (`?shaderwaitms=`) with a red line that says
where the stages were, and after three such waits none waits. Same empty store (logs/t6): first present 75 s, 1,172
waits 20.1 s in all, 4,462 calls not waited for, 0 ran out. Status line: `shader waits N (ms, longest, not waited
for, ran out, waiting now)`; report: `shaderWait`.

## 2. Why `?asyncsubmit=1` did nothing in the area
Only a batch whose LAST record was H_FLUSH and that carried no texels went into the ring. Every other `gfx_exec` waited
for the owner, which first runs everything in the ring: one waiting flush costs the whole frame's replay. The recorder
flushes (src/gfx: every `hostFlush()`): before UpdateUniformBuffer / CopyBufferToBuffer / ClearBuffer write guest
memory (lower.ts memWrite, memFill: the source says "some 80 such writes" a frame), before a texture-to-buffer copy,
at a full stream buffer (1 MB; the area's 4 MB a frame: 4 cuts), after a fence (nvnQueueFenceSync: 3 a frame, the batch
ends with H_FENCE, not H_FLUSH), with texels. The area's 111 batches for 6.3 submits a present are these.
- Counted by cause now (kernel/nx_guest.js gfx_exec -> nx_gfx.c g_flush_cause -> owner.ts `flushCauses`, in the report
  and the status line: `flushes per present: A+B in the ring, N waited M ms (texels, memory writes, copies to buffers,
  other cuts, ring full)`).
- Into the ring now: the end of a submission, a cut at a full stream buffer, a batch that ends with a fence.
- Memory writes: `?gfxown=1` + `?asyncsubmit=1` = stream writes (H_MEM_WRITE: the bytes travel in the stream, the
  replayer writes guest memory; src/gfx patch 2 in /ctl/reports/em-gfx-recorder.patch). Without the patch they wait.
- Still waiting, by design: texels in the batch (the record points into the recorder's scratch), a texture-to-buffer
  copy, ClearBuffer, writes over 64 KB, ReadTexels.
Measured (Mac's Chrome, loading screen after New Game, logs/hD, before the fence change): 6 batches a present in the
ring, 3 waited 14 ms a present, all three "cut then other" = the fences. The area: not measured.

## 3. Lowering at 135 us a draw and nvnBufferFinalize at 34 us
Both are walks of the live-buffer table (src/gfx/gmem.ts): `gmemBufDrop` walks it backwards for the object,
`gmemFind` walks all of it when the hint is not the buffer (a draw of a shader that reads memory through a loaded
address). `node em/tools/gmem_bench.mjs <gfx64.wasm> 40000 2354` (the recorder alone, 40,000 live buffers, Node):
nvnBufferFinalize 5.8-16.1 us -> 0.1-0.4 us; a frame of 2,354 end + make 35-39 ms -> 1.2-2.0 ms; a lookup without a
hint 128.5 us -> 0.9 us (the 135 us per draw is one such lookup). The fix (chains by the 64 KiB page a buffer starts
in; the object keeps its entry) is patch 1 in **/ctl/reports/em-gfx-recorder.patch** (applies to local/zelda-loop
2d07808; gfx:test passes in the three memory modes, the proof test and the audit pass). In this tree it is
`src/gfx` of the branch and `?gfxown=1` loads it (`node em/tools/build_gfx_own.mjs`: the recorder at the runtime's
static base, with names). A CPU profile of the area was not taken (not reached); `PROF="640:12"` of em_run.mjs
profiles every worker over CDP (98 of 98 answered at the title, 4 of 106 during a load).
The dynamic audit watched static data only up to the last initialized byte + 128 KB; it watches the whole range now
(8 s instead of 4, kept by the binary's hash).

## 4. The owner's slot
- 22 getters that only read their arguments or an object's fields (nvnEventGetValue, nvnDeviceGet*Handle,
  nvnTextureGet*, nvnMemoryPoolGetFlags/Size/Map, nvnBufferMap/GetAddress/...) are answered without the recorder's
  lock (`?lfgetters=0` off): 25 % of the title's NVN calls. The static audit rejects them because they are cases of
  the one dispatch function.
- The fs worker is the default for a game FILE (`?fsworker=0` off). Saves through it: logs/hC wrote `save commit #1
  generation 1`, the next run (hD) read it and committed generation 2 (both with `fsworker=1`, Mac's Chrome).
  A game from a URL keeps the owner's reads (the worker's synchronous requests took 80-220 ms each).
- Not done: the codec on a thread of its own; nvnSyncWait / nvnQueueFinish / AcquireTexture / PresentTexture stay
  the owner's (they are the game's explicit waits for the replayer; 4 calls a frame in the area).

## The Mac's headless Chrome (`run_host.sh`)
`CDP=http://192.168.64.1:9334 GAME_URL=http://192.168.64.4:8093/zelda-oot.nup node web/em_run.mjs` drives a browser
that is already running; `?game=<url>` reads the container by ranges (owner/game_file.ts, 1 MiB blocks, 96 kept;
web/game_serve.mjs in the VM). `run_host.sh <secs> <name>` takes /ctl/host.lock and /ctl/heavy.sh, starts the server,
closes the target at the end. Title there: 20-34 presents a second (hB, hC, hD).

## Open, in order
1. **The area with the changes**: not reached. Over `?game=` the title movie opened 361 s after the owner started and
   the load after New Game was still running at 740 s (hE, owner's reads); with the fs worker 3,269 reads took 720 s
   (hD). In the VM a request to game_serve costs 15-45 ms whatever its size (direct reads of the share: 3-11 ms), in
   Chrome 80-220 ms. Either make the reads fewer and larger (game_file.ts BLK = 8 MiB, read ahead), or ride it in
   the user's Chrome with the file: `…/em-next/index.html?skipmovie=1&asyncsubmit=1&gfxown=1` and read, in the
   status line: `lowering … ms` (was 131-164), `flushes per present: … waited … ms` (the Presentation Thread's
   `flush` in `per frame ms:` was 537), `NVN-lock`, and in the 10 s report `frameWork.recorderMsPerPresentTop`
   (nvnBufferFinalize was 79 ms), `flushCauses`, `streamWritesPerPresent`.
2. Lit-frame A/B of `asyncsubmit=1` and of stream writes (the picture in the area with and without `gfxown=1`).
3. Headless (SwiftShader) the title movie's start stalls in nvnSyncWait since 504b604 (t3 at present 266, t6 at 243:
   `'workgroupBarrier' must only be called from uniform control flow`, `compute pipeline 10444 did not build`, then no
   present). Not seen in the Mac's Chrome. A failed pipeline should not leave a fence unsignalled: the replayer's.
