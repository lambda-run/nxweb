# hle: the SDK functions taken over by name

nxnative runs the game's own copy of Nintendo's SDK and answers about a thousand of its functions on the host, by
their mangled names, instead of letting the SDK talk to system services that do not exist (`dm/host/hle.h`: `HLE`,
`HLE_FORCE`, `HLE_FORCE_BIG`; `dm/host/hle_*.c`). This area is that table for nxweb: the service layer that is not
file system, graphics, audio, movies, cheats or controllers.

| File | What |
|---|---|
| `tools/hle_names.py` | The inventory of nxnative's table, and the generator of everything below marked generated |
| `test/hle/inventory.tsv`, `status.tsv` | Generated: every entry of `dm/host/*.c` (file, kind, mangled, demangled, C signature, reason), and what answers each one here |
| `gen/table.ts` | Generated: names, flags, the bodies compiled from the C text, the dispatch to the hand-written functions |
| `index.ts` | The embedder's API: `hle_call`, `hle_lookup`, the enumeration, configuration, front end reports |
| `base.ts` | The argument block, results, waits, the log line, configuration, the imports |
| `ops.ts` | The interpreter of the compiled bodies |
| `sysevent.ts` | The service layer's SystemEvents (`hle_bind_system_event`, `hle_signal_system_event`, `hle_clear_system_event`) |
| `oe.ts`, `time.ts`, `account.ts`, `misc.ts`, `net.ts`, `offline.ts`, `friends.ts`, `mii.ts`, `sf.ts`, `nvdrv.ts`, `swkbd.ts`, `web.ts`, `sdk16.ts`, `sdkinit.ts`, `os.ts`, `libc.ts`, `lifecycle.ts` | One per nxnative file (`hle_<name>.c`; `libc.ts` is `hle_table.c`) |
| `cal.ts`, `data.ts` | Calendar arithmetic and `struct tm`; the profile image copied from `hle_account.c` |
| `defs/*.json` | Eight machines (kit); diagrams in `docs/machines/` |
| `host/build.mts` | `npm run hle:build`; `hleBuildShared(out, base)` for the runtime's shared memory |
| `src/glue/hle_host.ts` | `HleHost`: one instance of the module and its outside as one interface, `HleEnv` |
| `src/glue/hle_rt.ts` | `attachHle(rt, module, options)`: the table registered with a `Runtime`. Type-checked, **not run** (see Gaps) |

```
npm run hle:names     # inventory, status, gen/table.ts and the table in this file, from nxnative's sources
npm run hle:check     # fails when one of them is out of date
npm run hle:build     # build/hle/hle.wasm
npm run hle:test      # 62 tests, and the coverage rule for the eight machines as the module drives them
npm run kit:test      # the machines' tables on their own (test/hle/hle.machine.test.mts)
```

## The convention

The module is AssemblyScript on the guest's linear memory (guest addresses index it, wrapped to 32 bits). Nothing
allocates (`--runtime stub`, static data only: about 350 KB today, `hle_static_end()`).

```
hle_count() -> n            ids 0 .. n-1; then hle_internal_count() host-only functions the guest reaches through stubs
hle_name(id) -> C string    the symbol as it appears in a module's dynamic symbol table
hle_demangled(id) -> C string
hle_flags(id)               bit 0 forced (wins over every module's own definition; else it fills an import no module
                            defines), bit 1 implemented (else a red stub), bit 3 a weak entry whose name also has a
                            forced entry (mktime, localtime_r), bit 4 compiled from the C body, bit 5 a repeat of a
                            name and kind (none today)
hle_lookup(name) -> id | -1 the forced entry when a name has both kinds

hle_call(id, args) -> i64   x0
hle_ret_flags()             bit 0: x1 is part of the result (hle_ret_x1; a 16-byte struct by value)
                            bit 1: d0 is (hle_ret_d0: the register's low 64 bits; a float is the low 32)
                            bit 2: wait, see below        bit 3: the call does not return to the guest
```

**Arguments** (`base.ts`): a block of 208 bytes, `hle_args()` gives one.

| Offset | |
|---|---|
| +0 | x0..x7 |
| +64 | d0..d7 (the low 64 bits of v0..v7; a `float` is the low 32) |
| +128 | x8, the indirect result register (`PlayReport::Send` returns a struct through it) |
| +136 | x30, the call site (abort reports) |
| +144 | 8 x u64 continuation slots: zero at `hle_call`, kept by the embedder across a wait |

`hle_call` copies the block into a frame of its own, so a take-over that calls back into the guest, which calls
another take-over, keeps its arguments (16 levels).

**ABI differences** (the notes of `hle.h`): Switch code does not extend a narrow integer argument, so a take-over
never reads a whole register for a `bool`, `char`, `short`, `int` or `unsigned`: `B()`, `I()`, `W()` truncate
(`SetOperationModeChangedNotificationEnabled(0x100)` is "off", `LoadFont(..., index, capacity)` passes 32 bits on).
Results are returned at the width of the C return type: an `int` -1 is `0x0000_0000_FFFF_FFFF`, a `long` -1 fills
x0. No take-over in scope is variadic in a way that matters: `Fcntl(int, int, ...)` ignores its tail and
`VAbortImpl` gets a `va_list` it does not expand (as nxnative).

**Waiting.** A take-over never blocks. Where nxnative blocks the calling thread (a condition variable, a sleep, the
input box), the call returns with bit 2 set: "wait on the readable kernel event handle `hle_wait_handle()` for at most
`hle_wait_timeout()` ns (-1: no limit), then call `hle_resume(id, args, how)`" with the same block (its continuation
slots as the first call left them) and how the wait ended (1 signaled, 2 timed out, 3 cancelled). The result of
`hle_resume` may ask to wait again. This is `cpu.block(event, timeout, resume)` of the runtime as it stands; a sleep
is a wait on an event nobody signals. Waiting take-overs: `PopNotificationMessage`, `Poll` / `Select` /
`EventFdRead`, `ShowKeyboard`, `InlineKeyboard::Calc`, `OfflineWebSession::WaitForExit`, `ShowOfflineHtmlPage`.

**Calling back into the guest.** Where nxnative forwards to the SDK's own function (`guest_sym` and a call) the module
uses the imports `hle_guest_sym(name)` (the address in the guest's own modules, never a take-over) and
`hle_guest_call(fn, args, n)`: the SystemEvent binding (`nn::os::CreateSystemEvent`,
`GetWritableHandleOfSystemEvent`), `getenv`, `StandardAllocator::Allocate`, `ClaimPeriodicBenefitWithUserSystemClock`,
`ScalableFontEngine::LoadFont` / `Initialize` / `GetPointerToWorkBuffer`, the inline keyboard's six callbacks, and
the profanity filter's vtable (which also needs `hle_module_of` and `hle_stub_addr`).

### Imports (`env`), as `HleEnv` in `src/glue/hle_host.ts`

| Import | For |
|---|---|
| `log(ptr, len)` | one UTF-8 line; red lines start with `[RED] ` |
| `hle_guest_ns()`, `hle_mono_ns()`, `hle_real_ns()` | the guest clock (`kernel_guest_ns`), the host's monotonic clock, ns since 1970 UTC |
| `hle_tz(posix, out)` | the host's zone at a moment: `{ i32 offset seconds, i32 dst, char name[8] }` |
| `hle_entropy(ptr, len)` | random bytes |
| `hle_event_new(writeOut) -> r`, `hle_event_signal(w)`, `hle_event_clear(h)`, `hle_event_dup_readable(h)` | `kernel_event_new / _signal / _clear / _dup_readable` |
| `hle_guest_sym(name) -> u64`, `hle_guest_call(fn, args, n) -> u64`, `hle_module_of(addr) -> i32`, `hle_stub_addr(id) -> u64` | guest code, see above |
| `hle_host_alloc(size) -> u64` | guest-addressable host memory (font engine work buffers of 512 KB) |
| `hle_clock_freeze(reason, on)` | `kernel_clock_freeze` (reason 2 while the inline keyboard's box is up) |
| `hle_text_request(req)` | the input box; answered by the export `hle_text_answer(result, ptr, len)` then or later |
| `hle_web_open(path, callback, hidden, delay, pulse) -> 0 / 1 / 2`, `hle_web_show()`, `hle_web_send(ptr, n)`, `hle_web_close()`, `hle_input_hold(on)` | the web view; reports back through `hle_web_message / _ended / _failed` |
| `hle_vsync_event(binding)` | a vsync event was handed out: call `hle_vsync_tick(binding)` every vertical blank until it returns 0 |
| `hle_connected_npad()` | nfp: the controller the NFC device is on |
| `hle_native_image_blank(w, h)`, `hle_native_image_blank_free(handle)` | GameChat camera storage (graphics side) |
| `hle_exit_request(reason, value, ptr, len)` | the exit path; the embedder calls `hle_exit_done()` when audio, graphics and the run loop have stopped |

Exports for the embedder beside the calls: `hle_cfg(key, value)` / `hle_cfg_str(key, ptr, len)` (what nxnative reads
from its environment and the game profile: operation mode, language, nickname, fixed time, `game_env`, launch
parameter, display version, `DM_KBD`, SDK major, ...: `CFG_*` / `STR_*` in `base.ts`, `HleHost.config`),
`hle_aoc_set`, `hle_font_set`, `hle_focus_set(1|2|3)`, `hle_set_opmode(0|1)`, `hle_shutdown()`, `hle_notify(msg)`,
`hle_applet_enter(name)` / `hle_applet_leave()` and `hle_event_bind / _signal / _clear / hle_handle_closed` for the
other service areas (a controller applet, audio events), `hle_mii_standin(kind, out, cap)` for the file system's
MountSystemData, `hle_call_count(id)` (nxnative's `DM_HLECOUNT`), and the kit's exports.

## Adding a take-over

1. It must be in nxnative's table: `npm run hle:names` reads `dm/host/*.c`. A file not yet in scope is added to
   `SCOPE` in `tools/hle_names.py` (`"hle_x.c": "x"` for `src/hle/x.ts`).
2. If its C body only stores constants through its arguments, zeroes a buffer, binds or signals an event, opens an
   applet and returns a constant, there is nothing to write: the generator compiles it (`ops`). Check its row in
   `test/hle/status.tsv`.
3. Otherwise write `export function <cname>(a: usize): u64` in the module of its C file, with nxnative's identifier
   (`h_oe_GetFocus`). Read arguments with `X / W / I / B / P / D / F`, return x0; `setX1`, `retF32`, `retF64`,
   `wait(handle, ns)`, `noReturn()` for the rest. State is module-level and reset in the module's `...Init()`
   (called from `hle_init`). No allocation: static buffers (`memory.data`), no string building.
4. A lifecycle is a machine in `defs/` (kit), stepped from guards; events that may not apply are asked with `can`.
5. `npm run hle:names` (the function is found by its name and wired into `gen/table.ts`), then a test in
   `test/hle/` that checks results and every byte written against the C code, and `npm run hle:test`.

An entry with neither a compilable body nor a function is a stub: `[RED] <demangled name> unimplemented` once, then
`STUB_RET[cname]` (the tool's table for results that are evident from nxnative's "nothing to do" case) or 0. There is
none today.

## Status

Generated by `npm run hle:names` from the inventory.

<!-- status:begin -->
| nxnative file | entries | forced | weak | implemented by hand | implemented from the C body | stubbed (red) | |
|---|---|---|---|---|---|---|---|
| `gfx/hle_vi.c` | 31 | 31 | 0 | 12 | 19 | 0 | `src/hle/vi.ts` |
| `hle_account.c` | 41 | 41 | 0 | 14 | 27 | 0 | `src/hle/account.ts` |
| `hle_codec_video.c` | 101 | 101 | 0 | 0 | 0 | 101 | `src/hle/codec_video.ts` (cut: video codecs) |
| `hle_friends.c` | 33 | 33 | 0 | 2 | 31 | 0 | `src/hle/friends.ts` |
| `hle_hid.c` | 169 | 169 | 0 | 96 | 73 | 0 | `src/hle/hid.ts` |
| `hle_jit.c` | 7 | 7 | 0 | 5 | 2 | 0 | `src/hle/jit.ts` |
| `hle_mii.c` | 17 | 17 | 0 | 6 | 11 | 0 | `src/hle/mii.ts` |
| `hle_misc.c` | 138 | 138 | 0 | 20 | 118 | 0 | `src/hle/misc.ts` |
| `hle_movie.c` | 27 | 27 | 0 | 0 | 0 | 27 | `src/hle/movie.ts` (cut: movies) |
| `hle_net.c` | 101 | 101 | 0 | 15 | 86 | 0 | `src/hle/net.ts` |
| `hle_nvdrv.c` | 7 | 7 | 0 | 1 | 6 | 0 | `src/hle/nvdrv.ts` |
| `hle_oe.c` | 55 | 55 | 0 | 30 | 25 | 0 | `src/hle/oe.ts` |
| `hle_offline.c` | 132 | 132 | 0 | 11 | 121 | 0 | `src/hle/offline.ts` |
| `hle_os.c` | 4 | 3 | 1 | 4 | 0 | 0 | `src/hle/os.ts` |
| `hle_ro.c` | 10 | 10 | 0 | 7 | 3 | 0 | `src/hle/ro.ts` |
| `hle_sdk16.c` | 84 | 84 | 0 | 40 | 44 | 0 | `src/hle/sdk16.ts` |
| `hle_sdkinit.c` | 7 | 7 | 0 | 7 | 0 | 0 | `src/hle/sdkinit.ts` |
| `hle_sf.c` | 13 | 13 | 0 | 8 | 5 | 0 | `src/hle/sf.ts` |
| `hle_swkbd.c` | 31 | 31 | 0 | 14 | 17 | 0 | `src/hle/swkbd.ts` |
| `hle_table.c` | 63 | 0 | 63 | 63 | 0 | 0 | `src/hle/libc.ts` |
| `hle_time.c` | 29 | 29 | 0 | 24 | 5 | 0 | `src/hle/time.ts` |
| `hle_web.c` | 13 | 13 | 0 | 9 | 4 | 0 | `src/hle/web.ts` |
| `hle_count.c` | 0 | 0 | 0 | 0 | 0 | 0 | no table entries (see below) |
| `hle_haptics.c` | 0 | 0 | 0 | 0 | 0 | 0 | no table entries (see below) |
| `hle_lifecycle.c` | 0 | 0 | 0 | 0 | 0 | 0 | no table entries (see below) |
| `hle_movie_av1.c` | 0 | 0 | 0 | 0 | 0 | 0 | no table entries (see below) |
| `hle_movie_avc.c` | 0 | 0 | 0 | 0 | 0 | 0 | no table entries (see below) |
| `hle_touch.c` | 0 | 0 | 0 | 0 | 0 | 0 | no table entries (see below) |
| **in scope** | **1113** | **1049** | **64** | **388** | **597** | **128** | |
| `hle_audio.c` | 64 | 64 | 0 | | | | out of scope: audio |
| `hle_audren.c` | 22 | 22 | 0 | | | | out of scope: audio |
| `hle_codec.c` | 32 | 32 | 0 | | | | out of scope: audio |
| `hle_fs.c` | 73 | 73 | 0 | | | | out of scope: file system (src/fs) |
| `hle_glslc.c` | 1 | 1 | 0 | | | | out of scope: not assigned to src/hle |
| **dm/host total** | **1274** | | | | | | 192 out of scope; the scope also has 31 of dm/gfx |
| `gfx/gl/hle_gl.m` | 160 | | | | | | graphics, counted only (160 of them pass-through table rows) |
| `gfx/hle_nv.c` | 8 | | | | | | graphics, counted only |
| `gfx/nvn/hle_nvn.c` | 9 | | | | | | graphics, counted only |
| `gfx/vk/hle_vk.m` | 134 | | | | | | graphics, counted only (134 of them pass-through table rows) |
<!-- status:end -->

`hle_lifecycle.c` and `hle_count.c` register nothing: the first is the exit path (`lifecycle.ts`, machine `hle_exit`),
the second a per-entry call counter, which is `hle_call_count(id)` here. Of `hle_os.c` the table entries are ported
(entropy, getenv, the allocator hook); its guest clock, freeze reasons and object side table are the kernel's.
"Not assigned" files (`hle_ro.c`, `hle_jit.c`, `hle_glslc.c`) register names that belong to the loader and graphics.

## Machines

| Machine | Port of | Instances |
|---|---|---|
| `oe_focus` | `g_focus`, `g_seen` | #0 what the front end reported, #1 what the game sees (out of focus while an applet is open) |
| `oe_msg` | the coalescing rule of `mq_push_` | 15, 30, 31: a second Post while queued keeps the first queue position |
| `oe_notify_event` | `g_mq_ev`, `mq_ev_sync` | bound once, then signalled while the queue holds a notification |
| `hle_exit` | `dm_host_shutdown_then`'s once, its callers | Running, Exiting(reason), Exited(reason): hostShutdown, executeProgram, abort |
| `nifm_request` | `g_nifm_hold` | on hold for the first query after a submission |
| `swkbd_request` | the blocking `front_text_input` | Idle, Asking, Answered(ok / cancel / noWindow); one at a time |
| `swkbd_inline` | `g_ikb[].state`, `.pending` | per keyboard (4): Unstarted, Hidden, Shown, Asking |
| `web_session` | `g_web_state` | None, Started, Shown, Ended |

## Tests (`npm run hle:test`)

Node, `HleHost` over `build/hle/hle.wasm` with the module's own memory as guest memory, kernel events as a map,
clocks as variables, guest functions as JavaScript functions at made-up addresses.

- The table: the inventory against a plain search of nxnative's sources; every in-scope name resolves with its kind
  and is implemented; every entry called twice with zero arguments (and resumed when it waits) without a trap.
- nxnative's own tests, ported: `t_oe.c` (all its checks; the concurrent bursts as their sequential interleavings),
  `t_time.c`, `t_net_eventfd.c` (its writer and closer threads as events between a wait and its resume),
  `t_sf.c`, `t_swkbd.c`, `t_pctl.c` (with the GameChat camera storage), `t_language.c`, `t_nfc.c`,
  `t_shared_font.c`. Not ported: `t_system_event.c` and `t_notify_sched.c` test `hle_thread.c`'s scheduler and
  handle table (the kernel's); the binding table's behaviour is covered in `g_sdk16.test.mts` "events".
- Layouts byte for byte against the C writes, with guard bytes around them: ClockSnapshot (0xD0), SystemClockContext,
  SteadyClockTimePoint, CalendarTime, CalendarAdditionalInfo, `struct tm`, `timespec`, Uid, UserHandle, Nickname, the
  profile JPEG (compared with the literal in `hle_account.c`), Mii CharInfo (0x58) and CharInfoElement, the MiiModel
  stand-in files, the GameChat storage type, the HIPC / CMIF responses, the keyboard's String (UTF-8 and UTF-16) and
  its ChangedStringArg, OfflineHtmlPageReturnValue, SharedFontData, BuiltInFontData, the BFTTF header,
  NfpDeviceHandle, DisplayVersion, LanguageCode, the pseudo device id, the launch parameter, the pdm statistics.
- The compiled bodies: each of the 500 called with zero arguments and compared with an independent reading of the C
  source in the test (the constant its body ends with: 334 compared, 166 return nothing); store widths, null checks,
  event binding, the once-only red line.
- The machines: 39 of 39 transitions taken by the module itself; `kit:test` walks every table and every refusal.

## Behaviours I could not determine

- **The SystemEventType layout.** nxnative never writes it: the SDK's `CreateSystemEvent` does. Without an SDK in the
  guest (`hle_guest_sym` finds neither function) the binding is a host-only kernel event, the guest's struct is left
  alone and one red line says so. A guest that waits on such an event through its own `nn::os` needs the SDK.
- **`dm_thread_service_connect` / `_request`, `dm_thread_native_wait`**: nxnative's scheduling remedies around HLE
  calls. The kernel here has a real scheduler; nothing is done.
- **`VAbortImpl`'s tail**: nxnative prints a guest backtrace; here the call site (x30) and its module index.
- **`getenv` forwarding and the allocator hook** look the SDK's function up in every guest module (nxnative: the
  allocator in the module named `sdk`).
- **Shared fonts**: which stand-in a browser embedder supplies is its choice; nothing is bundled (nxnative falls back
  to a macOS system font). Without one the queries answer "not loaded" and one red line.
- **`oe::GetDisplayVersion`** by main's build ID is the embedder's lookup (`displayVersion`); unknown is 1.0.0.

## Departures from nxnative, and why

- **No blocking**: every blocking wait is a "wait on this event, call me again" result (above).
- **`die()` is a red line and a failing result**, not the end of the process, where the guest can go on:
  `account::GetUserId` on a foreign handle (RES_FAIL), a full notification queue (the notification is dropped), more
  than 64 host service sessions (handle 0), `dm_applet_leave` without enter, a missing `detail::Claim...` (0), a
  missing SDK allocator (null), a missing `LoadFont` (403), an invalid focus state, `CreateSystemEvent` failing.
- **One socket error store.** nxnative keeps `t_skerr` per thread in `hle_net.c` and answers a constant ENETDOWN from
  `hle_offline.c`'s `GetLastErrno`; here both files read one store (asked for by the task; threads are green, so a
  switch between a failing call and its `GetLastError` can show another thread's error).
- **`EventFdRead` on an empty blocking descriptor** waits for the next write or close with a 100 ms poll, as nxnative.
- **Text input is asynchronous**: `hle_text_request` and `hle_text_answer` instead of a blocking front-end call.
  While one request is out, a second keyboard waits (one applet at a time); an `Appear` during an inline keyboard's
  request does not arm a second one.
- **Add-on content** is a list the embedder sets (nxnative lists `DM_AOC_DIR` at the first query); **the launch
  parameter file** is bytes the embedder sets; **`ExecuteProgram`** hands the index and the parameter bytes to the
  embedder through the exit request (nxnative: `DM_PROGRAMS`, `DM_EXEC_OUT`, `execve`).
- **Web content messages** are held in 32 slots of 2047 bytes (nxnative: `malloc`, any length); longer ones are cut, red.
- **`DM_OE_SCRIPT`, `DM_TEST_SWKBD_*`** are not ported: the embedder scripts `hle_focus_set` / `hle_set_opmode`.
- **The MiiModel stand-in** is offered as bytes (`hle_mii_standin`), not written to a host folder.
- **libc pass-through** is written out, not Apple's libc: `strtod` / `atof` / `strtof` are not correctly rounded in
  the last place for long digit strings and read no hex floats; math is AssemblyScript's (musl ports), which can
  differ from Apple's libm in the last place; `errno` is not set; `strftime` is the C locale with the common
  conversions (an unknown one is copied, red once).
- **Logs** of constant bodies compiled from the C text are dropped unless red; hand-written ones keep nxnative's text
  where it is short.

## Requests to the runtime owner

1. **A range for the module's static data** in `src/glue/rt_layout.ts` ("hle static", 1 MB is ample: about 350 KB used),
   `hleBuildShared(join(OUT, "hle.wasm"), range("hle static").lo)` in `rt:build`, and `hle?: WebAssembly.Module`
   in `RuntimeModules`. The host area is fully assigned today.
2. **`HostCpu.setD(i, bits)`**: a host function cannot write `d0` (the runtime README lists it as a gap). The 28
   pass-through math functions that return a float or double and `strtod` / `atof` / `strtof` need it; `hle_rt.ts` logs red once without it.
3. **x8 in the argument block** or as now `cpu.x(8)`: used; fine as it is.
4. **A "this thread never continues" result** for a host function (aborts, `ExecuteProgram`): `hle_rt.ts` gives the
   core up with pc 0xFFFF_FFE0, which is unverified.
5. **`svc CloseHandle` reported** to `HleHost.handleClosed(handle)`: nxnative unbinds a SystemEvent when its write
   handle closes. Without it the next signal finds the dead handle and binds again (tested), which is correct but late.
6. **Forced names no module refers to are logged red by the loader, one line each.** This table has 704 forced
   names and serves every game, as nxnative's does: there the unreferenced ones are one summary line
   (`force: N entries hit, M not referenced by this game`) and red only with `DM_FORCE_STRICT`.
7. **`rt_hle.ts` and this table**: no name overlaps today (vi and npad are not in scope). `nn::oe` operation mode is
   here (`hle_opmode()`); the npad style in `rt_hle.ts` is fixed to docked and should follow it.

## Gaps

- `src/glue/hle_rt.ts` is run by the runtime's tests (`test/runtime/more_cases.ts` "hle", guest `hleg.c`: 22 names
  across oe, time, account, nifm, socket and libc, in Node and Chromium) and by the page. Requests 1, 2, 4, 5, 6 and
  7 above are answered (`src/runtime/README.md`, "The SDK take-over table"). Still without a page side: the input
  box, the web view, shared fonts, native images.
- Out of scope and not in the module's table: file system, graphics (`dm/gfx`), audio, codecs, movies, cheats,
  controllers and touch, `nn::ro`, `nn::jit`, glslc (the status table lists them).
- No game has run against this: every result is nxnative's C read and re-expressed, checked by tests written from the
  same C, not by an SDK.
- The web view, the input box, vsync, fonts and blank native images are imports with no browser implementation here.
