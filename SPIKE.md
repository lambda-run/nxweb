# Spike: guest cores on Web Workers that share one memory

EXPERIMENTAL. Branch `spike/workers`. Nothing here is wired into `npm test`. The spike code is `src/spike_workers/`
and `test/spike_workers/`; the logs every number below comes from are in `test/spike_workers/results/`.
Eight existing files were also edited (`src/kernel/*.ts`, `src/a64/emit.ts`, `src/a64/int.ts`; see "Edits outside the
spike directories"); green threads on the unshared build behave as before and the existing test tiers still pass
(see "Existing tiers").

## The answer

Yes: guest cores run in parallel on Workers over one shared `WebAssembly.Memory`, with one kernel, one translator
state and one pc map. It ran the threads guest of `test/runtime` and a new stress guest correctly on 1 to 4 Workers
under Node `worker_threads` and in headless Chromium.

| | measured on 4 Workers against today's green threads |
|---|---|
| Compute in 4 guest threads (SHA-256, LZ77) | 3.5x to 3.9x faster in Node, 3.4x to 3.6x in Chromium (2 Workers: 1.9x to 2.0x) |
| One thread, shared-memory build against today's build | no difference outside the noise (0.94x to 1.04x) |
| 4 threads that mostly make SVCs which never block | 0.5x to 0.7x: slower |
| 4 threads fighting for one SDK mutex | 0.32x to 0.41x: much slower (a lock convoy; every blocked wait is an OS sleep and wake). 2 and 3 Workers: 0.14x to 0.6x |
| A wake from one core to another | about 16 µs (waiter spinning) to 23 µs (waiter asleep), against 5 µs for a green-thread switch |
| Determinism | gone; the timing of sleeps and thread starts varies by milliseconds with the host's load |

So the gain is real for code that computes on several cores, and the cost is real for code that hands work between
threads many times a frame. Which of the two a given game is must be measured on that game before this is built
in full ("Recommended design", step 0).

Things the spike found that are bugs today the moment a second host thread exists:

1. Every AssemblyScript module keeps state in WebAssembly globals (kernel 53, hle 186, gfx 142, translator 80, fs 26,
   loader 31, rt 11), which each instance has for itself. Fixed generically by a build pass (`mtify`).
2. A second instance of a module writes the module's static data again (data segments, start function).
3. The translator's helper module has one static scratch area: FRECPE gave wrong results in 16 to 20 of 20 runs on
   4 Workers. Fixed with a private helpers instance per Worker.
4. `dmb` / `dsb` compile to nothing: Dekker's test failed in 14 to 358 of 200,000 rounds in every run on 4 Workers
   (40 runs). Fixed (`atomic.fence` on a shared memory): 0 in each of 60 runs afterwards.
5. Three lines of the threads guest are only schedule-independent under green threads.

And one thing that helps today's single-thread mode: `expire()` scanned all 256 thread records on every SVC. With a
lower bound of the earliest deadline (`minDl`) the SVC-heavy guest went from 645 ms to 217 ms on green threads
(one run before, five after).

## Machine

`nproc` = 4 (Intel Xeon @ 2.10 GHz, a virtual machine). Other jobs were running the whole time: the load average was
between 1.9 and 6.0 during the runs (each log states it at its start). With 4 Workers plus a coordinator thread on 4
busy CPUs, every figure for 4 Workers is a lower bound of what an idle 4-core machine gives, and all timing
jitter figures are upper bounds. Node v22.23.4 (V8 12.4); Chromium 153.0.8010.12, Playwright channel `chromium`,
headless, page served with COOP `same-origin` and COEP `require-corp` (`crossOriginIsolated` = true).

## What was built

| File | What |
|---|---|
| `src/spike_workers/mtify.mts` | Build pass: moves every mutable wasm global of a module into linear memory and emits a primary binary (with data and start) and a secondary one (without) |
| `src/spike_workers/a64mt.ts` | Per-Worker translator host: own core instance and table, shared pc map, translate lock, two ways for a unit to reach other Workers |
| `src/spike_workers/engine.ts` | One host thread's share of the process: kernel instance, run loop for green threads and for Workers, SVC path with in-place waits, pause acknowledgement |
| `src/spike_workers/coord.ts` | Coordinator (makes the memory, boots the primary first, relays, collects) and the Worker-side message loop |
| `src/spike_workers/worker_node.mts`, `worker_web.ts` | The Worker entry for Node and for the browser bundle |
| `src/spike_workers/build.mts` | Builds all of it into `build/spike_workers/` |
| `test/spike_workers/guests/` | `stress.c`, `bench.c` (five workloads), `dekker.c`, `crt0.S`, `xsvc.S`; `threads.c` and `race.c` are taken from `test/runtime/src` unchanged |
| `test/spike_workers/run_node.mts`, `browser.mts`, `series.ts` | Correctness series (Node, Chromium), expected texts |
| `test/spike_workers/bench.mts`, `sweep.mts` | Speed |
| `test/spike_workers/evidence.mts`, `modcache.mjs`, `tablecost.mjs`, `try.mts`, `one.mts` | Single facts and single runs |

Three configurations share one code path (`engine.ts`):

- **green unshared (today)**: `build/runtime/kernel.wasm`, `translator.wasm`, `helpers.wasm`, unshared memory, one
  engine, deterministic clock.
- **green shared**: the shared-memory binaries, still one engine and green threads. This is the deterministic test
  mode on the new build, and the measure of what atomics and the lock's code path cost one thread.
- **N Workers**: N engines. Worker w runs the virtual cores c with c % N == w. Wall clock.

The guests are flat images (contract test ABI) so that neither the loader nor the take-over table is needed; they use
SVCs only.

### How to run

```
npm run rt:build                                   # today's binaries (the baseline)
node src/spike_workers/build.mts                   # everything of the spike
node test/spike_workers/run_node.mts --runs 200    # correctness, Node (about 9 minutes)
node test/spike_workers/browser.mts --runs 200 --reps 5   # correctness and speed, Chromium (about 12 minutes)
node test/spike_workers/bench.mts --reps 5         # speed, Node
node test/spike_workers/try.mts stress 4           # one run with all counters; options in the file's header
node test/spike_workers/evidence.mts               # memory growth across threads; globals per module
```

## Design decisions of the spike

**Workers are cores, not threads.** A game makes dozens of threads; a Worker per guest thread would mean dozens of
core instances, tables and unit instances, and nxnative's handoff remedies. The kernel's scheduler already keeps its
state per core. `kernel_mt_schedule(worker, genOut)` is the scheduling point of one Worker over its cores. Guest
threads move between Workers freely because the whole CPU state is in the context block at every SVC and slice end.

**The pc map is shared and holds global table indices.** A private map per Worker would cost 64 KB per 64 KB of
code per Worker and would make every Worker translate, or at least look up, everything itself; the map is read by
translated code with two plain loads and that stays. Consequence: unit U occupies the same index range in every
Worker's function table. The next free index is a word in shared memory, taken under the translate lock.

**A Worker's table.** Every slot a Worker has not filled holds the core's trampoline, so an index published by
another Worker calls `translate(pc)` here, which sees a non-zero pc map entry and installs that unit locally. The
table grows in steps of 1024 with the trampoline as fill value. An index beyond the table's current length traps in
`call_indirect`; the contract (pc set and registers written back before every indirect transfer) makes that
recoverable: the run loop catches the trap, grows the table and enters the guest again at `pc` (`tableMiss`; 149 and
175 such traps over the 200 runs of each guest on 4 Workers in Node, all recovered). Creating the table at its final size instead was the first version; it
is wrong for Node 22, where instantiating any module that imports a table costs time proportional to the table's
length: 0.03 ms at 1024 slots, 1.2 ms at 65,536, 9.3 ms at 524,288 (`tablecost.mjs`; 23 ms when the slots hold a
function). Chromium 153: 0.004 to 0.024 ms at every length. This also applies to today's `a64_host.ts` under Node
with a large game, since the table has one slot per function.

**A translation miss** is served by the Worker that misses, with its own translator instance over the shared
translator state, under one translate lock (a futex-style lock on a control-block word), after looking at the pc map
again. It compiles the unit, takes table indices, installs it locally, publishes it, and only then writes the pc map.

**How a unit reaches the other Workers.** Both ways are implemented (`transport`):

- `"bytes"` (default): the unit's bytes go into a `SharedArrayBuffer` (the unit store) with a directory entry; a
  Worker that needs the unit makes its own `WebAssembly.Module` from the same bytes, synchronously, inside
  `translate()`. In V8 this does not compile again: its process-wide native module cache returns the compiled module
  for identical bytes. Measured with eager compilation so that the constructor's time is the compile time: Node,
  gfx.wasm (193 KB) 3.8 ms first, 0.2 ms for the same bytes in another Worker, 6.5 ms for other bytes; hle.wasm
  (303 KB) 8.5 / 0.4 / 9.2 ms. Chromium (same thread): 9.8 ms first, 0.8 ms again. With the default lazy
  compilation the constructor is cheap either way (0.06 to 0.10 ms per unit in Node, 0.16 to 0.54 ms in Chromium),
  and the sharing is what keeps each function from being compiled once per Worker later. This is a property of V8,
  not of the specification; another engine would compile per Worker.
- `"message"`: the `WebAssembly.Module` object is posted to the other Workers through the coordinator. A browser has
  no synchronous receive, so a Worker that needs a unit whose message it has not processed makes `translate()`
  return STOP; the guest unwinds by the pc check, the run loop awaits the message and enters again. It works (20 of
  20 on both guests in both environments) and costs 0.25 to 0.81 ms per wait, 375 to 398 waits in 20 runs.

  The task said "compiled once, instantiated per Worker (the Module is transferable)". Both satisfy "compiled once" in
  V8. I recommend `"bytes"`: no unwinding, no dependence on the coordinator's event loop, no window in which a
  Worker stalls for a message, and the store is also what a translation cache loads into.

**One kernel instance per Worker over the same static data.** `mtify` rewrites the module's text form (binaryen,
which ships with AssemblyScript): `(global.get $g)` becomes a load and `(global.set $g x)` a store at a fixed address
in the module's own range (its last page), the initial values become one more data segment, and the secondary binary
is the primary without data, data-count and start sections. Exactly one Worker instantiates the primary, first; the
others instantiate the secondary. `memory.size` and `memory.grow` need nothing: wasm code always sees the current
size of a shared memory. The same pass ran on all eight modules of `build/runtime` and every result validates
(`evidence.mts`). AssemblyScript has no shadow stack pointer with `--runtime stub`; a module that had one would need
it kept as a real global (`keep` parameter) and a stack area per instance.

**kLock** (`src/kernel/base.ts`) is a real lock in a threads build once `kernel_mt_config(workers, spin)` was
called: a word 0 / 1 / 2 (free, held, held with waiters), a compare-exchange spin, then `memory.atomic.wait`;
unlock notifies only when the word was 2. With workers = 0 it is the re-entry check it was. `ASC_FEATURE_THREADS`
guards the atomic instructions, so the unshared build does not contain them.

**Blocking waits.** The task proposed `Atomics.wait` on a per-thread word. With Workers as cores the thing that
sleeps is a core, so the word is per Worker: the scheduler's `flag(core)` (already called wherever a core's ready set
changes) bumps and notifies it. A Worker sleeps on it with the value the kernel read under the lock when it found
nothing to run, so a wake between that decision and the sleep is not lost. A thread whose SVC blocked stays
**inside the SVC** while its Worker has nothing else (no unwind, no re-entry through `run()`); when the kernel hands
the same thread back, its context is loaded and the SVC returns. When another thread is chosen instead, the frames
unwind as today. The thread may meanwhile have run on another Worker; that is safe because translated frames hold no
guest state across a call, and a frame that continues does so only if `pc` is what it expects (the contract's pc
check, as after longjmp). Counters over 200 runs of the threads guest on 4 Workers: 173,794 waits ended in place,
2,797 by unwinding. The option `inplace: false` unwinds always; it passes too.

**Timeouts.** An idle Worker sleeps until the earliest deadline of any wait, then calls `kernel_tick`; expiry wakes
the thread and kicks its core. Every SVC brings the wall time (`kernel_svc_at`: tick and SVC under one taking of
the lock).

**Pause** (`SetThreadActivity` on a thread that is Running on another Worker): the kernel sets the target's `pendw`
word and returns `KERNEL_ACT_ACK`; the caller's Worker waits on that word; the target's own next scheduling point
(`kernel_svc`, `kernel_preempt`) makes the transition `PauseRequest` and clears and notifies the word. A resume
before that withdraws the request. Process stop clears it. A thread that is Running on another core of the caller's
own Worker (fewer than 4 Workers) is at a scheduling point and is paused at once (without this the 1-Worker run
hung; found by the stress guest). In the spike the pending state is a field beside the kit machine, not a `kthread`
state. Measured: 3,988 to 3,998 acknowledgements per 200 runs, mean 0.23 to 0.26 ms each with a budget of 100,000
(the target runs a loop without SVCs, so the latency is the rest of its slice); 0.13 ms with a budget of 2,000.

**Green threads stay.** Same kernel source, same engine. On both builds the green runs gave one single
(guest ns, slices, SVCs) triple over 20 runs of each guest: deterministic as before.

## Correctness

Expected texts are in `test/spike_workers/series.ts`. A run passes "exact" when stdout, exit code and stop reason are
the expected ones, no fault was raised and no red line was logged. Fresh Workers and a fresh memory for every run.

The stress guest (`stress.c`, 8 threads on 4 cores) checks: 800,000 increments of a 64-bit word and 2,400,000 of a
32-bit word next to it through `ldaxr`/`stlxr` loops; 20,000 plain increments under the SDK mutex with an overlap
detector; FRECPE on 8 threads against the single-thread result; 20 rounds of pause, `GetThreadContext3` and resume
on a thread spinning on another core (the counter must stand still while paused, the context must be plausible,
the thread must run on after resume); `SetHeapSize` to 64 MB while three other cores compute, then a thread on
another core writes at the top of the new heap and prints from there.

### Node worker_threads (`results/node_correctness.log`, final code)

| Guest | Configuration | Exact | Differ only in the timing lines | Failed |
|---|---|---|---|---|
| threads | green unshared / green shared | 20/20, 20/20 | | 0 |
| threads | 1 Worker / 3 Workers | 20/20, 17/20 | 0, 3 | 0 |
| threads | **2 Workers** | **194/200** | 6 | 0 |
| threads | **4 Workers** | **159/200** | 41 | 0 |
| threads | 4 Workers, always unwind / units by message | 15/20, 10/20 | 5, 10 | 0 |
| stress | green unshared / green shared / 1 / 3 Workers | 20/20 each | | 0 |
| stress | **2 Workers** | **200/200** | | 0 |
| stress | **4 Workers** | **200/200** | | 0 |
| stress | 4 Workers: always unwind / budget 2000 / units by message | 20/20 each | | 0 |
| dekker | 4 Workers / 3 Workers | 20/20, 20/20 | | 0 |

An earlier full run with the kernel as it was before `kernel_svc_at` and `minDl` (its log was overwritten by the
final one) gave: threads 188/200 exact + 12
timing (2 Workers), 123/200 + 77 (4 Workers); stress 200/200 and 200/200.

### Headless Chromium (`results/browser.log`)

| Guest | Configuration | Exact | Differ only in the timing lines | Failed |
|---|---|---|---|---|
| threads | green unshared / green shared / 1 / 3 Workers | 20/20 each | | 0 |
| threads | **2 Workers** | **197/200** | 3 | 0 |
| threads | **4 Workers** | **195/200** | 5 | 0 |
| threads | 4 Workers, units by message | 20/20 | | 0 |
| stress | green unshared / green shared / 1 / 3 Workers | 20/20 each | | 0 |
| stress | **2 Workers** | **200/200** | | 0 |
| stress | **4 Workers** | **200/200** | | 0 |
| stress | 4 Workers, units by message | 20/20 | | 0 |

The dekker guest was added after this run. A second, short Chromium run with the final code
(`results/browser_short.log`, 20 runs per series, load average 4.4): dekker on 4 Workers 20/20 exact; stress 20/20 on
2, 3 and 4 Workers and by message; threads 17/20 + 3 timing (2 Workers), 14/20 + 6 (3 Workers), 18/20 + 2 (4 Workers),
17/20 + 3 (by message); no failure.

### The runs that were not exact

All 73 inexact threads runs of the two final logs (and all 95 of the earlier Node run) differ from the expected
text only in one or more of three lines, and each of those lines states something that only green threads guarantee:

| Line | Expected | Seen instead | Why |
|---|---|---|---|
| 2 | `ArbitrateLock used: yes` | `no` | Four threads are started one after the other; with real parallelism the first can finish its 200 short critical sections before the others contend |
| 7 | `wake order 1 2 0` (sleeps of 3, 1, 2 ms) | any other order | The three sleeps end 1 ms apart. A timed `Atomics.wait` came back up to 2.07 ms late on this machine (measured in the engine, `lateMaxMs`), and the three threads start at different moments |
| 8 | `wait on an exited thread rc=0x0 ... it left 77` | `rc=0xea01 ... it left 0` | A thread started on another core has not run to its end 1 ms after `StartThread`: its Worker has to wake up and may have to install units first |

Node, 4 Workers, final run, by line (a run can have several): line 2 in 7 runs, line 7 in 21, line 8 in 17.
`series.ts` (`modTiming`) masks exactly these three facts and nothing else; a run whose masked text is still not the
expected one counts as failed. None did. These are not kernel errors, but they are the first evidence of the cost
named below under "Timing".

### Demonstrations (differences are the point; 20 runs each)

| What | Node | Chromium |
|---|---|---|
| `race` (unsynchronized by design), green threads | 1 distinct output | 1 |
| `race`, 4 Workers | 9 distinct outputs | 6 |
| stress with ONE helpers scratch area (`helpers.shared.wasm` as built today) | FRECPE wrong in 20 of 20 runs (e.g. "2 of 8 threads got the single-thread result") | 18 of 20 |
| dekker with `dmb` compiled to nothing | both cores read 0 in 14 to 193 of 200,000 rounds, in every one of 20 runs | 14 to 358, in every one of 20 runs |

### Failures met while building, with what they were

| Symptom | Cause | State |
|---|---|---|
| Second translator instance trapped in `buildCore` (memory access out of bounds) | The first `mtify` matched the folded text form, but `asc -t` writes the linear form: nothing had been rewritten, and one Worker had hidden that | Fixed: the pass prints the binary itself and refuses a text in which a moved global is still used |
| stress hung on 1 Worker | Pause waited for an acknowledgement from a thread of the caller's own Worker | Fixed in `svc.ts` |
| 23 ms per unit instantiation | Table created at full size, Node 22 | Changed to grow on demand and on trap |
| threads "failed" 3 of 5 on 4 Workers | The three timing-dependent lines | Explained above, masked, counted separately |
| stress phase 4 "ran on after resume 7 of 20" | The guest gave the resumed thread 100 µs to show progress | The guest now waits until progress shows (up to 2000 sleeps) |

No run of the final code ended in a fault, a trap, a red kernel line, a wrong total or a hang.

## Speed

Wall time of the run phase (after boot; translation included, it is 2 to 22 ms), repetitions interleaved so that
load hits every configuration alike, 5 repetitions. "Speedup" is today's time divided by the configuration's.

### Node (`results/node_bench.log`; load average 1.9 at the start)

| Guest | green unshared (today) min / median ms | green shared | 1 Worker | 2 Workers | 3 Workers | 4 Workers | speedup at 2 / 4 Workers (min; median) |
|---|---|---|---|---|---|---|---|
| bench_sha: 4 threads x SHA-256 of 64 KB x 400 | 1460 / 1593 | 1478 / 1560 | 1447 / 1610 | 728 / 782 | 742 / 771 | 379 / 403 | 2.01x / 3.85x; 2.04x / 3.96x |
| bench_lz: 4 threads x LZ77 of 64 KB x 500 | 1648 / 1773 | 1589 / 1647 | 1584 / 1627 | 865 / 919 | 827 / 872 | 467 / 500 | 1.90x / 3.53x; 1.93x / 3.55x |
| bench_contend: 4 threads x 40,000 x (2000 private steps, shared atomic add, 32 adds under ONE mutex) | 640 / 676 | 642 / 682 | 648 / 686 | 2869 / 3083 | 4678 / 4802 | 1675 / 1781 | 0.22x / 0.38x |
| bench_svc: 4 threads x 60,000 x (signal, wait, reset own event; nothing blocks) | 217 / 233 | 226 / 249 | 305 / 329 | 307 / 423 | 330 / 359 | 321 / 372 | 0.71x / 0.68x; 0.55x / 0.63x |
| bench_sha_1t: one thread | 1540 / 1588 | 1510 / 1659 | 1487 / 1522 | | | | |
| bench_lz_1t: one thread | 1711 / 1752 | 1762 / 1824 | 1720 / 1806 | | | | |

### Chromium (`results/browser.log`; load average 2.1 at the start)

| Guest | green unshared (today) | green shared | 1 Worker | 2 Workers | 3 Workers | 4 Workers | speedup at 2 / 4 Workers (min; median) |
|---|---|---|---|---|---|---|---|
| bench_sha | 1803 / 1895 | 1788 / 1892 | 1858 / 1962 | 956 / 991 | 906 / 954 | 505 / 629 | 1.89x / 3.57x; 1.91x / 3.01x |
| bench_lz | 1826 / 1847 | 1804 / 1885 | 1804 / 1931 | 948 / 1099 | 945 / 997 | 544 / 586 | 1.93x / 3.36x; 1.68x / 3.15x |
| bench_contend | 863 / 891 | 865 / 924 | 878 / 915 | 1427 / 1777 | 2860 / 3111 | 2124 / 2782 | 0.60x / 0.41x; 0.50x / 0.32x |
| bench_svc | 172 / 177 | 180 / 184 | 452 / 522 | 293 / 338 | 330 / 340 | 318 / 337 | 0.59x / 0.54x |
| bench_sha_1t | 1679 / 1840 | 1763 / 1899 | 1794 / 1976 | | | | |
| bench_lz_1t | 1696 / 1945 | 1761 / 1915 | 1757 / 1948 | | | | |

### Reading the numbers

- **Compute scales.** 4 Workers: 3.53x to 3.85x (Node), 3.36x to 3.57x (Chromium) on a machine that was not idle.
- **3 Workers is no better than 2 for four threads on four cores**: Worker 0 then runs cores 0 and 3 and decides the
  finish time. The number of Workers should be the number of cores the guest uses (three for an application:
  GetInfo's core mask is 7).
- **The single-thread cost of the shared-memory mode**: on code without exclusives it is not measurable here: green
  shared against green unshared is 0.95x to 1.04x on the two compute guests and the two one-thread guests in both
  environments, inside the run-to-run spread. On exclusives it shows in Chromium: `stress` phase 1 is 1.6 million
  `ldaxr`/`stlxr` pairs, and the whole guest took a median of 66 ms unshared against 82 ms shared over 20 runs each,
  which would be about 10 ns per pair (Node: 81 against 83 ms).
- **SVC-bound code gets slower.** 720,033 SVCs: 0.30 µs each on green threads, 0.42 µs on 1 Worker in Node and 0.63 µs
  in Chromium. That step has nothing to do with contention: on Workers every SVC reads the wall clock
  (`performance.now()` and a BigInt), on green threads the clock is arithmetic on the budget. On 4 Workers the SVCs
  of the four threads still take turns under the one kernel lock, so nothing is gained and the total stays about
  1.5x to 2x of green threads. Remedies not built: read the clock only when a deadline is near or the SVC needs
  time; answer SVCs that touch no shared state without the lock.
- **Contention on one SDK mutex is the bad case**: 0.14x to 0.6x. The SDK's mutex hands the lock to the first
  waiter (`ArbitrateUnlock`). On Workers that waiter's core is asleep or spinning; until it runs, the lock is owned
  by a thread that is not running and every other thread that wants it queues too. On 4 Workers in Node: 160,000
  rounds, 44,622 waits, 42,439 idle periods of which 7,792 ended while still spinning. Green threads never contend
  here (21 SVCs in the whole run) because a thread is only ever switched at a slice end. Real hardware has the same
  convoy with a cheaper wake.
- **A wake across cores** (`bench_ping`: a token between two cores through two events, 20,000 round trips of two
  wakes and six SVCs; `results/node_sweep.log`, 3 repetitions, min / median ms, load average 3.7): green threads
  193 / 195, which is 9.7 µs per round trip. 2 Workers with the waiter polling its word 2000 times before it sleeps
  (the default): 694 / 806, 35 µs per round trip; 18,604 of 21,771 idle periods ended in the poll. Without polling:
  905 / 1060, 45 µs. Polling 200,000 times: 626 / 697. Always unwinding instead of waiting in place: 654 / 701. So a
  wake of another core costs about 16 µs when the waiter spins and 23 µs through `Atomics.wait` and `notify`,
  against about 5 µs for a switch between green threads, on this loaded machine.
- **Tuning that did not help** (same log). `bench_svc` on 4 Workers with 100 / 2000 / 20,000 compare-exchange attempts
  before a contended kernel lock sleeps: 368 / 410 / 438 ms. `bench_contend` on 4 Workers with 0 / 2000 / 20,000
  polls of an idle Worker: 2476 / 1917 / 3359 ms; always unwinding: 1656 ms; the medians are 2428 to 4612 ms. One
  taking of the lock per SVC instead of two did help: 444 to 368 ms.

## What breaks or gets hard

**Determinism is gone in parallel mode.** Evidence: `race` gives 6 to 9 different outputs in 20 runs; three lines of
the threads guest vary. What replaces the determinism tests:
- Green threads stay the deterministic tier and keep every test that exists. The shared build must pass that tier
  too (it did here for the two guests: one (guest ns, slices, SVCs) triple over 20 runs).
- For Workers: guests whose output is independent of the schedule, run many times (what this spike does), with
  totals that expose lost updates, overlap detectors, and `kernel_check` after every N-th SVC under the lock in a
  debug option (not built here).
- The kernel's property test (random steps, invariants after each) driven from several host threads.
- Timing assertions need tolerances; tests that compare a wake order 1 ms apart cannot be exact.

**Timing.** Sleeps and timeouts are the host's timers: a timed wait came back up to 2.07 ms late. A thread started on
another core begins when that Worker has woken and installed the code it needs: lines 7 and 8 of the threads guest
failed in 21 and 17 of 200 runs for that reason. A running core cannot be interrupted from outside (its `budget` is a
global of its own instance), so a better thread that became ready on a busy core, and a pause, wait for that core's
next SVC or slice end: 0.13 to 0.33 ms mean with the budgets tried.

**Host services that assume one thread.** Each is an AssemblyScript module with static state and wasm globals
(`evidence.mts`: rt 11 mutable globals, loader 31, hle 186, fs 26, gfx 142). None was run on Workers in this spike.
What each needs:
- *Take-over table (hle)*: `mtify`, one lock around every entry (calls are short). Its glue keeps JavaScript state
  per thread (the `resume` closure of a call that waits, found again when the woken thread enters the stub): that
  state lives in one Worker, while the kernel may hand the thread to another. Either a thread with a pending
  continuation stays on its Worker (no stealing for it), or continuations become data in shared memory.
- *File system*: OPFS sync access handles belong to the Worker that opened them. Every fs call hops to the one
  Worker that owns storage; the calling guest thread waits on a kernel event, which is what `cpu.waitFor` already
  does for storage waits. fs.wasm then needs no lock, because one thread runs it.
- *Audio*: the mixer runs on a timer or the worklet's clock, not on a guest thread; the guest's calls only move
  buffers. One lock around the module, or run it in the service Worker.
- *Graphics recorder*: `nvn_call` only reads guest memory and writes the recorder's state and the host stream, so
  it can run on the calling core's Worker under a gfx lock (per queue would be finer; NVN requires the application
  to synchronize a queue itself). Command buffer recording by several guest threads at once then scales.
- *WebGPU* lives in one Worker. The replayer (`gfx_exec`) must run there: the recorder's Worker passes (ptr, len) of
  the finished stream and goes on; order is the order of submission. The three calls that wait on the GPU already
  park the guest thread on a kernel event; the GPU Worker signals it. A guest core that sleeps in `Atomics.wait`
  has no event loop, so WebGPU promises, `requestAnimationFrame`, timers, fetch and OPFS async calls never complete
  on such a Worker: everything asynchronous has to live in a Worker (or the page) that never blocks, a **service
  Worker thread** beside the core Workers. That is one more thread than cores.
- *Loader*: runs once, on the primary, before the cores start. `nn::ro` loads at run time need the translate lock
  and a rendezvous for unloads (below).

**The translation cache.** Units are in the unit store; importing a cache means filling the store, the directory and
a pending table at start, and any Worker installs from it. Fault side tables must be per unit in the store too,
because the trap happens on whichever Worker ran the code. `removeCode` / `invalidate` (module unload, changed code)
must clear table slots and drop instances in every Worker: that needs all cores at a safe point, the same
rendezvous a pause uses. Not built.

**guest_call from host functions.** Today a callback that blocks is a host fault, because JavaScript frames cannot
unwind. With in-place waits a callback may block: its Worker sleeps inside the SVC. The price is that this Worker
cannot run another thread until the callback returns; a thread that becomes ready on its cores has to be taken by
another Worker (the scheduler's steal, which only takes threads whose mask allows it).

**Memory growth.** wasm code sees the new size at once. JavaScript does not: a view made before another thread grew
the memory keeps its length (65,536; index 65,546 reads `undefined`), the old buffer object keeps its byteLength,
and `memory.buffer` read again returns a new `SharedArrayBuffer` of the new length (`evidence.mts`). The spike makes
views from `memory.buffer` at every use and counts the changes: 800 to 1,587 refreshes over 200 stress runs, each of
which grows the memory by 64 MB while three other cores run. The rule for the real glue: no typed-array or DataView
field that outlives a call. The alternative is a memory that never grows (initial = maximum), which costs address
space, not pages, but fails on hosts that cannot reserve it.

**Browsers without cross-origin isolation.** On the same page without COOP/COEP in Chromium 153:
`self.crossOriginIsolated` is false, the global `SharedArrayBuffer` is undefined, `new WebAssembly.Memory({ shared:
true })` still succeeds, and posting it to a Worker throws `DataCloneError: SharedArrayBuffer transfer requires
self.crossOriginIsolated`. So there is no parallel mode there, and green threads must remain a complete mode, not a
test mode only. COEP `require-corp` also constrains every subresource of the page.

**The translator on a shared memory.**
- Barriers: fixed here (`atomic.fence` for DMB / DSB when the memory is shared; the unshared output is unchanged).
- The helpers' scratch memory: a private instance per Worker here; the real build needs a helpers build without
  `--importMemory`, which today's `A64Host` layout check does not expect.
- `STXP` of a 64-bit pair is two exchanges with a roll-back (a64 README): another core can see the first half. Not
  tested here.
- Exclusives are compare-exchange against the value the load saw, not a monitor on the address: an A-B-A change in
  between is not noticed. Not tested here.
- A plain load racing a plain store of another core is whatever the host gives; on an x86 host that is stronger than
  ARM, on an ARM host it is ARM. Guest data races behave as on hardware, which is the point, but they are now real.

**The kernel.** Open in the spike:
- `SetThreadCoreMask` on a thread that is Running on another Worker moves it at once (`schedMoved`): two Workers
  could run it. It needs the same pending protocol as pause. No guest here does it.
- A thread that pauses another and is itself paused before the acknowledgement does not wait; `GetThreadContext3`
  would then answer invalid state.
- No deadlock detection: an idle Worker sleeps at most 50 ms and looks again.
- With fewer Workers than cores a thread that is Running on a core whose Worker is busy with its other core cannot
  be stolen.
- The clock freeze, `kernel_clock_wait` and the cntpct yield were not exercised on Workers.
- The re-entry check of the lock does not exist while it is a real lock.
- The scans over 256 thread records in the scheduler and the wait queues now run under a lock other cores wait for.

## Recommended design for the real implementation, in order

0. **Measure one real game first**, on green threads, with counters that already exist or are trivial: per frame,
   budget units executed per core, SVCs, waits that block, wakes of a thread on another core. Parallel mode wins
   roughly when (compute that can overlap) exceeds (cross-core wakes x 16 to 23 µs + SVCs x 0.2 µs). A game that makes
   2,000 cross-core wakes a frame loses 32 to 46 ms a frame to them. If the result is marginal, stop here.
1. **Make the build ready without changing behaviour**: `mtify` (or the same rule in source: no module-level `let`,
   state in a `memory.data` block) for kernel and translator; primary and secondary binaries; helpers without
   imported memory; the fence; `minDl` and `kernel_svc_at` (these two are worth taking for green threads alone).
   The shared build runs the whole existing deterministic tier in one Worker. No Workers yet.
2. **Kernel**: the real lock; the kick word per Worker; `kernel_mt_schedule`; a `PausePending` state in `kthread`
   (with its transitions, tests and diagrams) instead of the spike's field; the same pending protocol for a core
   mask change; the rendezvous ("every core at a safe point") as one primitive used by pause, unload and stop;
   deadlock detection by counting idle Workers. The property test driven from several threads.
3. **Translator glue**: `a64mt.ts` merged into `a64_host.ts` as a mode: shared pc map with global indices, table with
   trampoline fill and growth on trap, unit store with the bytes transport, translate lock, side tables in the
   store, the cache loading into the store.
4. **Runtime split**: what is one per process (memory, loader state, stubs, kernel) and what is one per Worker
   (core, table, unit instances, current thread, the thunk module at the same table index). Three core Workers for
   the three application cores plus one service thread that keeps an event loop. The run loop of `engine.ts` with
   in-place waits; the process machine driven by the coordinator.
5. **Host calls**: a declaration per host function: runs on the calling core under its module's lock, or hops to
   the service thread and parks the guest thread (the existing `waitFor`). hle under one lock; fs and everything
   asynchronous on the service thread; continuations pinned to their Worker.
6. **Graphics**: recorder on the calling core under a lock, replayer on the GPU's thread fed in submission order;
   the GPU waits signalled from there.
7. **Tests**: the schedule-independent series of this spike as a tier of its own (Node and Chromium), with the
   threads guest's three lines either rewritten or masked; the demonstrations kept as regression tests of the
   detectors.
8. **Then** tune: clock reads per SVC, lock-free SVCs, spin lengths on a machine with idle cores, a finer gfx lock.

Parallel mode should be a choice per title or per session, with green threads as the default until step 0 says
otherwise, and the only mode without cross-origin isolation.

## Which existing areas change, and how deep

| Area | Change | Depth |
|---|---|---|
| `src/kernel` | Lock, kick, Worker scheduling point, pause and core-move pending, rendezvous, idle count; one kit machine gains a state. The spike's edits are about 150 changed lines in 6 files and cover the first four | Medium: small in lines, every line is concurrency |
| `src/a64` (translator) | Fence (done, 5 lines). STXP pair. Nothing else: the `shared` option existed | Small |
| `src/glue/a64_host.ts` | A second mode: global table indices, trampoline fill, unit store, translate lock, per-Worker install, side tables in the store, cache into the store | Large (the spike's `a64mt.ts` is 254 lines without cache, faults and code removal) |
| `src/glue/rt_runtime.ts`, `src/runtime` | Split into per-process and per-Worker parts; run loop; host-call routing; fault collection from several Workers; process machine across threads | Large: the deepest change |
| Builds (`src/*/host/build.mts`) | Shared variants, `mtify`, primary and secondary, stamps for both | Small to medium |
| `src/hle`, `src/glue/hle_*.ts`, `rt_hle.ts` | Lock at the entry, continuations pinned or made data, page-side input written from the service thread | Medium |
| `src/fs`, `rt_fs.ts` | All calls on the service thread | Small to medium |
| `src/gfx`, `gfx_host.ts`, `rt_gfx.ts` | Recorder lock, stream handed to the GPU thread, waits signalled across threads | Medium |
| `src/audio` | Lock or service thread | Small |
| `src/loader` | Runs on the primary only; `nn::ro` at run time through the rendezvous | Small |
| `web/` | COOP/COEP on the server (the test servers already send them), one Worker per core plus the service thread, fallback without isolation | Small to medium |
| Tests | A parallel tier; tolerances for timing | Medium |

## Edits outside the spike directories

All marked `SPIKE` in comments.

- `src/kernel/base.ts`: `kLock` / `kUnlock` real under `ASC_FEATURE_THREADS` once configured; `kick`, the kick words,
  `ACT_ACK`.
- `src/kernel/sched.ts`: `flag()` kicks the core's Worker; `schedReady` kicks the cores that may steal.
- `src/kernel/svc.ts`: pending pause (`pause`, `pendApply`, `resume`), stop kicks every Worker.
- `src/kernel/thread.ts`: two fields, `pendw` and `ackFor` (the record still fits in front of the context block).
- `src/kernel/index.ts`: `kernel_mt_config`, `kernel_mt_kick_word`, `kernel_mt_schedule`, `kernel_mt_ack_word`,
  `kernel_svc_at`; `pendApply` at the two scheduling points.
- `src/kernel/sync.ts`: `minDl`, the lower bound that lets `expire()` return without scanning. This one changes the
  unshared kernel too (same results, less time).
- `src/a64/emit.ts`, `int.ts`: option 16 and `atomic.fence` for DMB / DSB on a shared memory.

### Existing tiers after these edits

`npm run kernel:test`: 63 tests, 0 failed, 86/86 transitions (run after every kernel edit).
`npm test`, run once after the last edit of `src/kernel` and `src/a64`: 6 areas, 0 failed (kit 95 tests; loader 68;
kernel 63; a64 guests 75 passed in each of the 4 configurations, the shared-memory one included, and 9 of 9 feature
tests; runtime under Node 39 tests). `rt:browser`, `a64:browser`, `a64:fuzz` and the fs, hle, gfx, shaders and audio
tiers were not run.

## Limits of this spike

- No loader, no take-over table, no file system, no graphics, no audio on Workers: SVC-only guests.
- Benchmarks are small kernels, not a game. The contention guest is a worst case by construction.
- One machine, 4 virtual CPUs, never idle. No run on an ARM host (weaker memory order), none in Firefox or Safari.
- 200 runs find races that happen often. They do not show the absence of rare ones.
