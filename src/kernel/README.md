# kernel: Horizon's kernel for one guest process

AssemblyScript, no host APIs. It answers the SVCs the SDK's `nn::os` makes (threads, scheduling, locks, condition
variables, the address arbiter, events, memory, the clock), with nxnative's result codes and register conventions
(`dm/host/hle_thread.c`, `hle_svc.c`, `hle_os.c`). It never blocks and never reads a clock: a wait marks the thread
Waiting and the SVC returns "switch"; time comes in through `kernel_tick`.

| File | What |
|---|---|
| `defs/kthread.json`, `guest_clock.json`, `alias_page.json` | The three machines (kit); diagrams in `docs/machines/` |
| `index.ts` | The embedder's API (`kernel_*`), the consistency check |
| `svc.ts` | SVC dispatch, process stop, pause, GetInfo |
| `sync.ts` | Waits and wakes: lock, condition variable, address, synchronization object, sleep, timeouts |
| `sched.ts` | The scheduler (the only file that knows cores) |
| `thread.ts`, `handle.ts`, `clock.ts`, `mem.ts`, `base.ts` | Thread records and contexts, handle table and events, guest clock, memory bookkeeping, results / log / lock |

`npm run kernel:build`, `npm run kernel:test` (77 tests), `npm run kit:test` (the machines' tables).

## API for the embedder

Imports: `env.log(ptr, len)` (UTF-8 line; red lines start with `[RED] `), `env.debug_string(ptr, len)` (OutputDebugString).

```
kernel_init(cfg) -> 0 | layout error      cfg = 0: defaults; else 16 u64 (index.ts): the regions, pool, used memory,
                                          system resource, program id, flags (1 map limit, 2 Switch 2 counter,
                                          4 no priority inheritance), process id
kernel_create_main_thread(entry, stackTop) -> handle (0x1001)
loop:
  ctx = kernel_schedule()                 context block (contract's save_ctx layout) of the thread to run; 0 = all wait
  if (!ctx) { wait until kernel_next_timeout() or an outside event; kernel_tick(now); continue }
  load_ctx(ctx); run the thread at its pc with a budget
  on `svc n`:  save_ctx(ctx); a = kernel_svc(n, ctx)
               a == CONTINUE: load_ctx(ctx), return to the guest
               a == SWITCH:   set pc = 0xFFFF_FFE0 so the translated code unwinds, back to the loop
               a == STOP:     kernel_stop_reason() (1 ExitProcess, 2 Break), kernel_exit_code()
  budget ran out:     save_ctx(ctx); kernel_preempt(ctx)
  pc == 0xFFFF_FFF0:  save_ctx(ctx); kernel_thread_returned(ctx)
kernel_tick(now)                          host monotonic ns; ends the waits whose deadline has come
```

A waiting thread's result (x0, and w1 for WaitSynchronization) is written into its context block when its wait ends,
so the embedder only ever loads a context and runs it. Also: `kernel_schedule_core(core)` (one core's scheduling
point), `kernel_clock_freeze(reason, on)` / `kernel_clock_reasons()` / `kernel_guest_ns()` / `kernel_guest_ticks()`
(for `mrs cntpct_el0`; while reason 1 holds a guest read must wait, as GetSystemTick does), `kernel_module_add(base,
size, roOffset, dataOffset)` / `kernel_module_remove`, `kernel_device_share(addr, size, on)`, `kernel_map_stack(base, size)` (a stack in the stack
region for a thread the embedder starts, the main thread's; QueryMemory reports it as a mapped stack), `kernel_query_memory(addr, out)`
(svcQueryMemory for the embedder), `kernel_clock_wait(ctx)` (a counter read by `mrs cntpct_el0` while the background
freeze holds: the thread waits for the clock as GetSystemTick does, but its wake writes no register, so the embedder
runs the read again), `kernel_handle_close(h)` (CloseHandle for handles the embedder made), `kernel_kill()` (the
embedder ends the process: every thread leaves as at ExitProcess, stop reason 3), `kernel_event_new` /
`_dup_readable` / `_signal` / `_clear` (events a service hands its client), `kernel_seed_entropy`, and for tests and
dumps `kernel_thread_info`, `kernel_thread_ctx`, `kernel_count`, `kernel_check`; for a fault report
`kernel_svc_ring(index, out, cap)` / `kernel_svc_total(index)`: each thread record's last 16 SVCs (`ring.ts`, 112 bytes
each: number, x0..x5 as it entered, x0 and x1 as it returned or as its wait's wake wrote them, the return pc, and for
QueryMemory the MemoryInfo it wrote). Every entry takes the kernel lock
(`base.ts kLock`): today it only catches re-entry; it is the one function that becomes a real lock with Workers.

## Scheduler and threads

Four virtual cores, or eight with kernel flag 8 (the Switch 2's count: its games pin threads to cores 4 and 5): a
thread queues on its ideal core (or the lowest core of its mask); a mask that names no core there is queues on core 0. Each core runs its ready
thread of best priority; equals run in the order they became ready; a preempted thread keeps its place. `SleepThread`
0 / -1 go behind the equals, -2 lets a lower priority have one turn. `kernel_preempt` rotates equals. An idle core
takes a waiting thread whose mask allows it. A wake or start of a better thread on the caller's core makes the
caller's SVC return SWITCH, which is nxnative's "same-core handoff" as a consequence of the scheduler instead of a
wait loop. A Running thread is its core's current thread; green threads give the cores turns (`kernel_schedule`).
With eight cores a thread whose SVC made a better thread ready on another core stands back (it leaves its core, still
ready) until that thread has blocked, yielded, exited or used four slices: the wake hand-off (`sched.ts` HOLD), which
keeps the order two such threads have when they share a core. Kernel flag 16 turns it off.
Lock owners inherit the priority of their waiters for scheduling only (`eff`); GetThreadPriority reports what the
guest set. Thread contexts, the handle table (0x1000 + slot, lowest free first), ids from 0x51, the ThreadLocalRegion
fields (+0x110 thread id, +0x1F8 thread object) and the wait order (priority, then arrival) are nxnative's.

## Address-space layout

Guest addresses index the linear memory. Five regions, set by `kernel_init`; the default (one 4 GB memory):

| Region | Default | GetInfo | Holds |
|---|---|---|---|
| host | 0 .. 0x0800_0000 | | the modules' own static memory; not guest memory (QueryMemory: free pages) |
| code | 0x0800_0000 + 0x0FC0_0000 | ASLR base (12) | module images (`kernel_module_add`); the contract's test guests load here |
| thread-local | 0x17C0_0000 + 0x0040_0000 | 20 = its first page | user exception context page, then 0x3000 per thread: TLR 0x200, thread object, TLS block 0x2000 at +0x1000 |
| heap | 0x1800_0000 + 0x6000_0000 (1.5 GB) | 4 / 5 | SetHeapSize |
| stack | 0x7800_0000 + 0x1000_0000 (256 MB) | 14 / 15 | MapMemory destinations |
| alias | 0x8800_0000 + 0x77FF_0000 (1.875 GB) | 2 / 3 | MapPhysicalMemory; ends at 0xFFFF_0000, below the special pc values |

Order heap, stack, alias as in nxnative. ASLR size (13) = code base to alias end. Pool 0xCD50_0000, used memory
0x0400_0000 (nxnative's `app_pool` / `mem_used` defaults). The alias region's pages are one 16-byte kit instance each in a
**two-level table** (`mem.ts`): a directory of 4096 entries (64 GB of region, 32 KB) and leaves of 4096 pages (64 KiB,
16 MB of region) made when a page of theirs is first mapped or unmapped; a page without a leaf is Fresh, so a new
process touches none of it (the flat table was initialized whole: 8 MB and 5 ms a process). The first 224 leaves are
static data (the 14 MB the flat table had: 3.5 GB of mapped region, every layout of a 32-bit memory, where 3.5 GB
stays the limit of the region). In the build for a 64-bit memory the region may be larger and the leaves beyond those
come from `kernel_alias_arena(base, size)`, host-side memory the embedder gives after `kernel_init` (the runtime: the
top of the code region, sized by the layout at 1/256 of the region beyond 3.5 GB); a map that needs a leaf nobody can
give fails with ResultOutOfResource and a red line. Regions may lie anywhere below 0x3_FFFF_0000 there (0xFFFF_0000
in a 32-bit memory). The kernel grows the memory (`memory.grow`) when a heap, map or thread-local slot needs it.

## Verified (`npm run kernel:test`: 69 tests, 86/86 transitions taken by the kernel itself)

Every SVC below with its success paths, each result code and timeouts: 0x01–0x07, 0x08–0x12, 0x16–0x1F, 0x21, 0x24–0x27,
0x29, 0x2C, 0x2D, 0x32–0x35, 0x45. Ported nxnative scenarios: `t_condvar`, all seven groups of `t_sync_wait`,
`t_preempt` (condition order, wake-to-run through event / mutex / condition variable, handoff scope), `t_svc_memory`
(alias_lifecycle, device_shared_refused, ownership, module_sources, fragmented_queries, metadata_limit, heap_regrow),
`t_heap_size`. Determinism: the same script twice gives the identical kit trace and results. Property test: 28,000
random steps over 7 threads on 3 cores with a supervisor that pauses, resumes, re-prioritises and cancels; after every
step `kernel_check` (one Running thread per core, reference counts, lock words of lock waiters, page counter), lock
words name a live owner or 0, no waiter is past its deadline, no better thread was ready when one was chosen, and at
the end every thread finishes and nothing leaks.

## Departures from nxnative, and why

- **A real scheduler.** nxnative runs every guest thread on its own pthread and approximates per-core priority with
  handoff waits; its clock-wait prediction, spin gates, QoS mapping and service-request waits are remedies for that
  and are not ported. Its yield back-off and short-wait polls are, as an option (next section): they were left out
  because a spinning thread here takes no host core of its own, but it takes the one host thread all guest threads
  and the embedder's event loop share.
- **Priority inheritance for scheduling.** nxnative only lends a QoS class under `DM_QOS_MAP`; with strict priorities a
  low-priority lock owner would otherwise never run (flag 4 turns it off).
- **GetSystemTick** returns the tick in x0 (Horizon's ABI, the contract) and also in x1, where nxnative puts it (x0 = 0 there).
- **Sleeps and timeouts run on the guest clock** (nxnative: only under `DM_DETCLOCK`), so any positive SleepThread sleeps.
- **ExitProcess, GetProcessId** are implemented (placeholders in nxnative). **ConnectToNamedPort** returns a stub
  session handle and **SendSyncRequest** 0, both `[RED]` once; nxnative's placeholder returns 0 and no handle.
- **GetThreadContext3** gives a never-started or just-paused thread its real context, `tpidr` included (nxnative: zeros
  for a thread that never ran, `tpidr` always 0); `pc` is the instruction after the SVC. On an exited thread: invalid state.
- **Wake order of one event's waiters** is arrival order (nxnative: its list order, latest first).
- **QueryMemory** is one map of the guest address space: free ranges are bounded by images and the thread-local region
  too (they are host memory outside nxnative's block); the thread-local region reports state 0xC.
- **Bad guest pointers** return 0xD401 instead of faulting; a full thread or handle table returns 0xCE01 in red (nxnative dies).
- **Alias pages** have one state each (Fresh / Mapped / Stale); device-shared and borrowed ranges stay range tables.

## Poll back-off (`kernel_poll_backoff(1)`; off after `kernel_init`)

`backoff.ts`, after nxnative's `yield_backoff_ns`, `thr_yield` and `poll_wait_begin` (`dm/host/hle_thread.c`). On a
console a thread that polls sits on a core of its own; here every yield is a scheduling point and every short wait a
round trip through the embedder, on the one host thread that also runs the threads doing the work.

- A **run** is one thread's yields (`SleepThread` 0, -1, -2), or its sleeps and timed waits under 20 us that time out,
  with no other SVC between them. A run of yields starts again when x19..x28 differ from those of the last two yields
  (a loop that yields between steps of work; two, for a loop that waits at two yields); a run of short waits when the
  thread ran more than 20 us between two, used a whole time slice, or a wait was signalled.
- A yield in a run (never its first) becomes a sleep of an eighth of the run so far, 10 to 250 us, once the run has
  lasted 2 ms. Without the 2 ms when no thread is ready on another core (what the thread waits for then comes from a
  timer or the embedder's event loop, which a spin keeps away) and when the pass read the system counter
  (`GetSystemTick`, `kernel_guest_ticks`: it waits for a time).
- A short sleep or timed wait in a run (never its first) waits that long instead when that is longer. A signal still
  ends it at once.

The guest cannot tell but by the clock: a yield and a timeout may take any time, and no result changes. A poller is
late by at most 250 us and whatever the embedder's timer adds. Not applied inside a guest callback
(`kernel_preempt_hold`). Not ported: the clock-wait prediction (a learned period) and the spin gates (they need the
rewriter). The runtime turns it on with the wall clock only (`RuntimeOptions.pollBackoff`, the page's `?backoff=0`
turns it off): on the deterministic clock a run stays a function of the executed budget.

`kernel_stats_ptr()` / `kernel_stats_stride()`: per thread record, counters the kernel always keeps (`backoff.ts`):
SVCs by number, each wait SVC by timeout class (zero, under 1 ms, under 5 ms, longer, none) and result (woke, timed
out, returned at once), and what the back-off did. The runtime's report prints them (`Runtime.exitLines`).

## Gaps

- Workers: a pause of a thread running on another host thread needs a pending state in `kthread` and a waiting caller;
  `kLock` must become a real lock; `sched.ts` already keeps its state per core.
- Linear memory is never given back: unmapped pages and a shrunk heap stay resident (they read zero when mapped again).
- O(threads) scans in the scheduler and the wait queues (256 threads at most); no per-thread CPU time; no core 3 in
  GetInfo's core mask (7, as nxnative) though the scheduler has four or eight cores.
- Not implemented (answer 0 with `[RED] svc 0xNN unimplemented`): IPC beyond the stubs, shared and transfer memory,
  code memory, process and debug SVCs. SetHeapSize does not check Horizon's 2 MB multiple, WaitForAddress an unknown
  type, CreateThread its priority or core, CloseHandle an invalid handle (all as nxnative).
- The service layer's SystemEvent binding table (`hle_bind_system_event`) belongs to the HLE services, not here.
