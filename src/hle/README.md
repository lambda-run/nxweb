# hle: the SDK functions taken over by name

nxnative runs the game's own copy of Nintendo's SDK and answers about a thousand of its functions on the host, by
their mangled names, instead of letting the SDK talk to system services that do not exist (`dm/host/hle.h`: `HLE`,
`HLE_FORCE`, `HLE_FORCE_BIG`; `dm/host/hle_*.c`). This area is that table for nxweb: the service layer, controllers and the touch
screen (`hle_hid.c`), the display layer (`dm/gfx/hle_vi.c`), modules loaded at run time (`hle_ro.c`, `hle_jit.c`), and
the movie and video codec names as stubs (cut). Not here: file system, graphics, audio, cheats.

| File | What |
|---|---|
| `tools/hle_names.py` | The inventory of nxnative's table, and the generator of everything below marked generated |
| `test/hle/inventory.tsv`, `status.tsv` | Generated: every entry of `dm/host/*.c` and `dm/gfx/hle_vi.c` (file, kind, mangled, demangled, C signature, reason), and what answers each one here |
| `gen/table.ts` | Generated: names, flags, the bodies compiled from the C text, the dispatch to the hand-written functions |
| `index.ts` | The embedder's API: `hle_call`, `hle_lookup`, the enumeration, configuration, front end reports |
| `base.ts` | The argument block, results, waits, the log line, configuration, the imports |
| `ops.ts` | The interpreter of the compiled bodies |
| `sysevent.ts` | The service layer's SystemEvents (`hle_bind_system_event`, `hle_signal_system_event`, `hle_clear_system_event`) |
| `oe.ts`, `time.ts`, `account.ts`, `misc.ts`, `net.ts`, `offline.ts`, `friends.ts`, `mii.ts`, `sf.ts`, `nvdrv.ts`, `swkbd.ts`, `web.ts`, `sdk16.ts`, `sdkinit.ts`, `os.ts`, `libc.ts`, `lifecycle.ts` | One per nxnative file (`hle_<name>.c`; `libc.ts` is `hle_table.c`) |
| `hid.ts` | `hle_hid.c`: npads, styles and Joy-Con assignment, states and histories, the style event, six-axis sensors, vibration entry points, the controller applet, Jcms / Nmouse, the input latch and hold; the embedder's snapshot (`hle_input`) |
| `touch.ts`, `motion.ts`, `haptics.ts`, `padslots.ts` | `hle_touch.c` (touch screen states, the gesture recognizer), `motion_fusion.h` (the orientation fusion), `hle_haptics.c` (the vibration state the embedder plays), `pad_slots.h` (player slots, by source id) |
| `vi.ts` | `dm/gfx/hle_vi.c`: display, layer, native window, crop, frame number and history |
| `ro.ts`, `jit.ts`, `sha256.ts` | `hle_ro.c` and `hle_jit.c`: NRO load / unload and the JIT plugin environment, as calls on the embedder's loader and translator |
| `movie.ts`, `codec_video.ts` | `hle_movie.c`, `hle_codec_video.c`: CUT. Every name resolves to a stub that fails as nxnative does without a decoder (see "Cut") |
| `cal.ts`, `data.ts` | Calendar arithmetic and `struct tm`; the profile image copied from `hle_account.c` |
| `defs/*.json` | Fifteen machines (kit); diagrams in `docs/machines/` |
| `host/build.mts` | `npm run hle:build`; `hleBuildShared(out, base)` for the runtime's shared memory |
| `src/glue/hle_host.ts` | `HleHost`: one instance of the module and its outside as one interface, `HleEnv` |
| `src/glue/hle_rt.ts` | `attachHle(rt, module, options)`: the table registered with a `Runtime` (run by `test/runtime` and the page) |

```
npm run hle:names     # inventory, status, gen/table.ts, the coverage (gen/coverage.ts) and the tables in this file, from nxnative's sources
npm run hle:check     # fails when one of them is out of date
npm run hle:build     # build/hle/hle.wasm
npm run hle:test      # 97 tests, and the coverage rule for the fifteen machines as the module drives them
npm run kit:test      # the machines' tables on their own (test/hle/hle.machine.test.mts)
```

## The convention

The module is AssemblyScript on the guest's linear memory (guest addresses index it, wrapped to 32 bits). Nothing
allocates (`--runtime stub`, static data only: about 460 KB today, `hle_static_end()`).

```
hle_count() -> n            ids 0 .. n-1; then hle_internal_count() host-only functions the guest reaches through stubs
hle_name(id) -> C string    the symbol as it appears in a module's dynamic symbol table
hle_demangled(id) -> C string
hle_flags(id)               bit 0 forced (wins over every module's own definition; else it fills an import no module
                            defines), bit 1 implemented (else a red stub), bit 3 a weak entry whose name also has a
                            forced entry (mktime, localtime_r), bit 4 compiled from the C body, bit 5 a repeat of a
                            name and kind (none today), bit 6 cut: a stub (bit 1 clear) with an answer of its own
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

A ninth and later integer argument is on the guest stack: the import `hle_stack_arg(i)` reads `[sp + 8 * i]` of the
calling thread, valid during the call before it calls back into the guest. Three take-overs need it today:
`nn::jit::GenerateCode` (12 arguments), and the cut `ReadDecoderOutputImageRgba(Hdr)` / `Nv12` (their sizes).

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
`EventFdRead`, `ShowKeyboard`, `InlineKeyboard::Calc`, `OfflineWebSession::WaitForExit`, `ShowOfflineHtmlPage`, and `hid::ShowControllerSupport`
while the embedder's controller prompt is up.

**Calling back into the guest.** Where nxnative forwards to the SDK's own function (`guest_sym` and a call) the module
uses the imports `hle_guest_sym(name)` (the address in the guest's own modules, never a take-over) and
`hle_guest_call(fn, args, n)`: the SystemEvent binding (`nn::os::CreateSystemEvent`,
`GetWritableHandleOfSystemEvent`), `getenv`, `StandardAllocator::Allocate`, `ClaimPeriodicBenefitWithUserSystemClock`,
`ScalableFontEngine::LoadFont` / `Initialize` / `GetPointerToWorkBuffer`, the inline keyboard's six callbacks, and
the profanity filter's vtable (which also needs `hle_module_of` and `hle_stub_addr`), an NRO's init and fini functions,
the JIT plugin's entry points (`nnjitpluginGenerateCode` takes 13 arguments: with `n` above 8 the embedder puts the
rest on the guest stack, as AAPCS64 does; the plugin's helpers are host stubs it reaches through `hle_stub_addr`),
and the game's `operator delete` for a cut movie decoder.

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
| `hle_stack_arg(i) -> u64` | the i-th 8-byte stack argument of the guest call being taken over |
| `hle_ctrl_prompt(min, max) -> 0 / -1` | the controller applet's prompt for too few players (0 shown, -1 no window); answered by the export `hle_ctrl_answer(1 OK / 0 closed)` then or later |
| `hle_joy_mouse_wanted(on)` | the game set up (or finalized) the Joy-Con mouse sensors |
| `hle_vibration(state)` | a player's motors changed: `{ i32 player, u64 epoch at +8, 2 x { f32 amplitude low, frequency low, amplitude high, frequency high } at +16 }` (after `hle_haptics_init(1, ...)`) |
| `hle_vi_layer(w, h)`, `hle_vi_crop(x, y, w, h)` | `vi::CreateLayer` with a size; `vi::SetLayerCrop` changed (all 0: none): for the present |
| `hle_vi_frame_count() -> u64`, `hle_vi_present_progress(out)`, `hle_vi_presented_ns(ticket) -> i64` | frames presented; `{ u64 queued, u64 handed on }`; when a present reached the screen (0 not known, -1 dropped): `GetLatestFrameNumber`, `ListFrameHistory` |
| `hle_ro_load(image, size, sha, alone) -> token`, `hle_ro_call(token, fini, index) -> fn`, `hle_ro_activate(token)`, `hle_ro_unload(token)`, `hle_ro_lookup_in(token, name) -> addr` | the loader, for `nn::ro` and the JIT plugin (`ro.ts` has the contract) |
| `hle_jit_memory(rxSize, roSize, out) -> 0 ok`, `hle_jit_code_written(rx, offset, size)`, `hle_jit_free(rx, rxSize, ro, roSize)` | the translator, for `nn::jit` (`jit.ts`) |
| `hle_native_image_blank(w, h)`, `hle_native_image_blank_free(handle)` | GameChat camera storage (graphics side) |
| `hle_exit_request(reason, value, ptr, len)` | the exit path; the embedder calls `hle_exit_done()` when audio, graphics and the run loop have stopped |

Exports for the embedder beside the calls: `hle_cfg(key, value)` / `hle_cfg_str(key, ptr, len)` (what nxnative reads
from its environment and the game profile: operation mode, language, nickname, fixed time, `game_env`, launch
parameter, display version, `DM_KBD`, SDK major, ...: `CFG_*` / `STR_*` in `base.ts`, `HleHost.config`),
`hle_aoc_set`, `hle_font_set`, `hle_focus_set(1|2|3)`, `hle_set_opmode(0|1)`, `hle_shutdown()`, `hle_notify(msg)`,
`hle_applet_enter(name)` / `hle_applet_leave()` and `hle_event_bind / _signal / _clear / hle_handle_closed` for the
other service areas (audio events), `hle_mii_standin(kind, out, cap)` for the file system's
MountSystemData, `hle_call_count(id)` (nxnative's `DM_HLECOUNT`), and the kit's exports. For controllers:
`hle_input(player, snapshot)` (below), `hle_input_peek(out)`, `hle_hold(reason, on)` / `hle_hold_state()`,
`hle_ctrl_answer(result)`, `hle_pad_slot(op, id)`, `hle_players_reported()`, `hle_player_npad(p)`, `hle_npad_style(id)`,
`hle_input_samples()`, `hle_cheat_keys()`, `hle_joy_mouse_wanted()`, `hle_haptics_init(sink, enabled)` / `_route` /
`_enable` / `_suspend` / `_epoch` / `_available`, and the fusion on its own (`hle_motion_map / _reset / _update / _fill /
_phone`). For the display and modules: `hle_vi_frame_queued(frame)`, `hle_vi_layer_size()`, `hle_vi_layer_crop()`,
`hle_vi_native_window()`, `hle_ro_refuse(sha)`, `hle_ro_loaded()`, `hle_jit_envs()`, `hle_sha256(p, n, out)`.
`HleHost` (`src/glue/hle_host.ts`) wraps them: `input`, `inputPeek`, `hold`, `ctrlAnswer`, `padSlot`, `haptics`,
`viFrameQueued`, `roRefuse`, and the new `config` keys (`motion*`, `consoleMotion`, `inputScripted`, `display`,
`sdkOunce`). Every new member of `HleEnv` is optional: without it the take-overs answer as nxnative does with no
window, no motor and no loader, and what cannot be answered is one red line.

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
none of that kind today. The 128 stubs of the status table are the cut files' (next section).

## Cut: movies and video codecs

`hle_movie.c` (27 names) and `hle_codec_video.c` (101) are in scope so that every name resolves, and cut: each entry
is a stub (flag bit 1 clear, bit 6 set) that logs `[RED] <demangled name> is cut (movies and video codecs are not
played): it fails as in nxnative without a decoder` once and then answers (`cut_ops` in the tool; `movie.ts`,
`codec_video.ts` for the few that write an object, return a struct or read the stack):

- **`movie::Decoder`: nxnative has a "no decoder" path, and this is it.** There a Decoder constructed with a type or
  output format the host does not decode gets the SDK's vtable and a null implementation, one red line ("every method
  returns failure"), and each method returns its code for a null implementation: `0x1000` (`0x2002` from `Start`,
  `0x2003` from `Stop`, 0 from `GetLastError`). The stubs give every decoder that treatment: the constructors write
  the vtable (`_ZTVN5movie7DecoderE` + 0x10) and no implementation, the methods return those codes and write nothing,
  the deleting destructor calls the game's `operator delete`. A player sees `Configure` / `Start` fail and skips the
  movie; nothing can wait on a decoder event, because none is ever registered or signalled.
- **`movie::Extractor::SetDataSource` returns `0x1000`.** This entry is under `#if 0` in nxnative today (27 counts it):
  it is nxnative's answer from before it played movies ("the host does not demux, opening reports failure"), which is
  the state here, so it is active in this table.
- **`nn::codec` (the Switch 2's decoders): nxnative has no "cannot decode" path.** Its initializers always succeed.
  The stubs answer what its calls answer for a decoder or pool type with no host object behind it (`cv_of` /
  `pool_of` null): module 111 description 2004 (`0xFA86F`) from Register, Unregister, Start, Submit, Acquire and the
  property reads; success from Finalize, Stop, Flush; no submission event; no native image handle; a black picture
  from the readers (video black from `Nv12`). The initializers and the pool create nothing, null the type's host
  pointer and return the same 2004; the work size queries answer 0x1000 / 0x1000 as there; the preference (a value)
  is filled. Whether every Switch 2 player takes 2004 from `InitializeXxxDecoder` as "no movie" is not known: none
  has run here.
- `nn::syncpt` events and `nn::gs::TryWaitNativeSync` live in the same file: a sync handle no decoder made reads as
  reached (as in nxnative), so `CreateSyncPointEvent` binds its SystemEvent, `RequestSyncPointEvent` signals it at
  once, and the multi-wait holder, try-wait and destroy calls go to the SDK's `nn::os` as there.

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
the second a per-entry call counter, which is `hle_call_count(id)` here. `hle_touch.c`, `hle_haptics.c`,
`hle_movie_av1.c` and `hle_movie_avc.c` register nothing either: the first two are ported as `touch.ts` and
`haptics.ts` (read through `hle_hid.c`'s entries), the last two are decoders behind the cut files. Of `hle_os.c` the
table entries are ported (entropy, getenv, the allocator hook); its guest clock, freeze reasons and object side table
are the kernel's. `hle_glslc.c` (not assigned) registers a name that belongs to graphics. One of `hle_movie.c`'s 27
(`Extractor::SetDataSource`) is under `#if 0` in nxnative; the tool counts it and "Cut" says why it is active here.

## Coverage: nxnative's take-overs nxweb does not answer

`tools/hle_coverage.py` (run by `npm run hle:names`, checked by `npm run hle:check`) lists every name nxnative takes
over: the HLE / HLE_FORCE / HLE_FORCE_BIG entries of `dm/host/*.c` and of every source under `dm/gfx` (hle_vi.c,
hle_nv.c, nvn/hle_nvn.c), the libc pass-through list and the GL / Vulkan import tables, and what in nxweb answers each:
this directory's table, `src/fs/names.ts`, `src/audio/names.ts`, or a literal `name: "..."` in `src/glue/*.ts` (the
runtime registrations such as `nvnBootstrapLoader`). `test/hle/coverage.tsv` has every name;
`src/hle/gen/coverage.ts` the ones not answered, which the Prepare page's Code stage looks up in each module's dynamic
symbol table (`src/glue/hle_scan.ts`, `npm run prepare:scan -- <game folder>`). A port that registers a name
another way than a literal `name:` is not seen: add the name literally.

<!-- coverage:begin -->
| nxnative file | names | answered in nxweb | not answered |
|---|---|---|---|
| `dm/gfx/gl/hle_gl.m` | 171 | 0 | 171 |
| `dm/gfx/hle_nv.c` | 8 | 0 | 8 |
| `dm/gfx/hle_vi.c` | 31 | 31 | 0 |
| `dm/gfx/nvn/hle_nvn.c` | 9 | 1 | 8 |
| `dm/gfx/vk/hle_vk.m` | 134 | 0 | 134 |
| `dm/host/hle_account.c` | 41 | 41 | 0 |
| `dm/host/hle_audio.c` | 64 | 64 | 0 |
| `dm/host/hle_audren.c` | 22 | 22 | 0 |
| `dm/host/hle_codec.c` | 32 | 32 | 0 |
| `dm/host/hle_codec_video.c` | 101 | 101 | 0 |
| `dm/host/hle_friends.c` | 33 | 33 | 0 |
| `dm/host/hle_fs.c` | 73 | 73 | 0 |
| `dm/host/hle_glslc.c` | 1 | 0 | 1 |
| `dm/host/hle_hid.c` | 169 | 169 | 0 |
| `dm/host/hle_jit.c` | 7 | 7 | 0 |
| `dm/host/hle_mii.c` | 17 | 17 | 0 |
| `dm/host/hle_misc.c` | 138 | 138 | 0 |
| `dm/host/hle_movie.c` | 27 | 27 | 0 |
| `dm/host/hle_net.c` | 101 | 101 | 0 |
| `dm/host/hle_nvdrv.c` | 7 | 7 | 0 |
| `dm/host/hle_oe.c` | 55 | 55 | 0 |
| `dm/host/hle_offline.c` | 132 | 132 | 0 |
| `dm/host/hle_os.c` | 4 | 4 | 0 |
| `dm/host/hle_ro.c` | 10 | 10 | 0 |
| `dm/host/hle_sdk16.c` | 84 | 84 | 0 |
| `dm/host/hle_sdkinit.c` | 7 | 7 | 0 |
| `dm/host/hle_sf.c` | 13 | 13 | 0 |
| `dm/host/hle_swkbd.c` | 31 | 31 | 0 |
| `dm/host/hle_table.c` | 63 | 63 | 0 |
| `dm/host/hle_time.c` | 29 | 29 | 0 |
| `dm/host/hle_web.c` | 13 | 13 | 0 |
| **all (distinct names)** | **1625** | **1303** | **322** |
<!-- coverage:end -->

## Controllers (`hid.ts`)

Input arrives through one export: `hle_input(player, snapshot)`, a full snapshot of one player (0x1B0 bytes; the
layout is at the top of `hid.ts`, `HleHost.input(player, InputSnapshot)` builds it): flags (connected, which samples
are present, which Joy-Cons the pad holds, a motor), the source's stable id, buttons (NpadButton bits; bit 63 shakes
player 1's controller), the four stick axes, a motion sample in the controller's frame, one from a raw stream in the
Switch frame with its sample time, the console's own sensors, each Joy-Con's buttons, stick, motion and mouse sensor,
and the screen's touch points. `player` is 0..7, or -1 to let the source id take or free a player slot. Call it when a
source changed and once per frame while motion or touches are live (a motion source expires after 300 ms).

What the game then reads is nxnative's, entry for entry: player 1 always connected, Handheld (0x20) in handheld mode
and No1 docked, following `nn::oe`'s operation mode; players 2..8 on No2..No8 while connected and supported
(`SetSupportedNpadIdType`); a one-player game gets every controller as player 1; JoyDual / JoyLeft / JoyRight and
the single / dual assignment calls, the split by the controller applet; the 0x28-byte state for all five styles, the
16-entry histories filled with the current state under consecutive sampling numbers (from 65537), stick direction
bits; the style event bound per npad, signalled at bind when its controller is there and when a player comes, goes
or a pad's Joy-Con halves change; six-axis handles and states (5 ms apart on the guest clock, flat at rest, the shake,
live motion through `motion.ts`); the touch screen and gestures in handheld mode only; vibration handles by style and
npad, values sanitized and kept per motor (`haptics.ts`) and forwarded on change; the controller applet's counts and
its 2202-3101 when too few players stay; mouse, keyboard, debug pad, console six-axis sensor and Poke Ball Plus as
not connected.

Three things are different by design (the survey of nxnative's `hle_hid.c`):

- **One snapshot per read.** nxnative derives an npad's style from eight atomics read one at a time, and a
  disconnect between two reads once shifted by -1. Here every take-over starts with `view()`: the operation mode, the
  connected players, the supported ids and styles, the assignment modes and every pad's Joy-Con halves are copied
  once, and the table of the nine npads (pad, kind, style) is derived from that copy alone; states, sensors and
  vibration handles of the call are answered from that table. `i_hid.test.mts` drives 400 random changes and checks
  that all nine npads' style, states, sensor counts and vibration handles agree after each.
- **The hold has reasons** (machine `input_hold`, one instance per reason: 1 the offline web page, which `web.ts`
  takes itself, 2 the controller prompt, 3 the software keyboard, 4 the embedder's own). The game reads no buttons
  and centred sticks while any holds; the first take and the last release drop the latched presses. nxnative's one
  boolean let a second holder's release give the input back under the first.
- **A source is known by a stable id** (machine `pad_slot`), not by its name string: two controllers of one model
  keep their players across a reconnect, where nxnative may swap them.

And one simplification: player 1 has one path. nxnative ORs three for player 1 (keyboard / touch, the DM_KEYS / DM_CTL
script, its controller: buttons ORed, each stick axis the more deflected one); the embedder does that OR before it
publishes player 1's snapshot.

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
| `pad_slot` | `pad_slots.h`: `owner[]`, `last[]` | per slot (8): Unused, Held(source), Kept(source that left) |
| `input_hold` | `g_hold` | per reason (4): Released, Holding; the game's input is held while any holds |
| `touch_finger` | `g_f[].st`, `.reported`, `.again` | per finger id (16): Empty, DownNew, Down, LiftedNew, Lifted, LiftedAgain: Start once, End once |
| `six_shake` | `g_shake_on`, `g_shake_t0`, `g_shake_end` | Rest, Held, Finishing(end): whole cycles from the press |
| `ctrl_prompt` | the blocking `front_ctrl_support` | Idle, Asking, Answered(ok / closed / noWindow) |
| `ro_module` | `module_t.loaded`, `nn::ro::Module.state` | per loaded module (64): Empty, Mapped, Loaded, Finalizing |
| `jit_env` | `jit_env` | per environment (4): None, Created, Ready |

## Tests (`npm run hle:test`)

Node, `HleHost` over `build/hle/hle.wasm` with the module's own memory as guest memory, kernel events as a map,
clocks as variables, guest functions as JavaScript functions at made-up addresses.

- The table: the inventory against a plain search of nxnative's sources (`dm/host` and `gfx/hle_vi.c`); every
  in-scope name resolves with its kind and is implemented, except the 128 cut ones, which are stubs and nothing else
  is; every entry called twice with zero arguments (and resumed when it waits) without a trap, each cut one logging
  its red line once.
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
- The compiled bodies: each of the 597 called with zero arguments and compared with an independent reading of the C
  source in the test (the constant its body ends with: 392 compared, 205 return nothing); store widths, null checks,
  event binding, the once-only red line.
- The machines: 71 of 71 transitions taken by the module itself; `kit:test` walks every table and every refusal.
- Controllers (`i_hid.test.mts`): nxnative's `t_hid.c` ported check for check where the thing checked exists here:
  `t_slots` and the press-to-join block (with source ids for names), `t_npads` (with the prompt's four cases as
  answers of the fake front end), `t_joycons`, `t_jcms` and the Nmouse block, `t_vibration`, `t_motion_live`,
  `t_motion_hid`; `t_haptics.c` without `dm_haptics_level`. Not ported: `t_script` and `t_rec` (DM_KEYS, DM_CTL and
  DM_REC are not in this port), `t_rumble_log` (DM_RUMBLE_LOG), `t_motion_threads` (one thread here), and the
  front ends' device tests (`t_pad_hid.c`, `t_pad_pro.c`, `t_pad_apple.m`, `t_motion_pro.c`, `t_motion_apple.m`,
  `t_switch2.c`, `t_ctrl_prompt.c`, `t_haptics_apple.m`: Apple and HID device code the embedder replaces). New:
  the prompt as a wait with two threads, the hold's reasons, slots through `hle_input(-1, ...)`, the shake's cycles
  against the formulas, the layouts below, and the random consistency walk.
- Touch and gestures (`j_touch.test.mts`): `t_touch.c` and `t_gesture.c` check for check, then 6,000 random
  operations run through `hle_touch.c` itself compiled with cc (`test/hle/ref/touch_ref.c`; the test copies
  `hle_touch.c` next to two shim headers): 1,477 `TouchScreenState<N>` byte for byte and 24,206 gesture entries of
  all ten types byte for byte.
- Motion (`k_motion.test.mts`): `t_motion.c` check for check, then 17,460 updates (seven axis maps, tilted and
  noisy sessions, gaps, NaN / infinity / overflow, bad times and gains) compared field by field with
  `motion_fusion.h` compiled with cc (`test/hle/ref/motion_ref.c`): 17,390 bit for bit, 70 within 1.2e-7 in the
  rotation matrix, which is sinf / cosf (musl's in AssemblyScript, the C library's there); every other field of
  every step is exact. Without cc the comparison is skipped and says so (`HLE_REQUIRE_CC=1` makes that a failure).
- vi, ro, jit, cut (`l_vi_ro_jit.test.mts`): `t_vi_history.c` ported; the nn::ro half of `t_nro.c` (load order,
  lookups, unload and load again, refusal) against a fake loader, its relocation half being `loader.c`'s; nn::jit
  against a fake plugin whose entry points are JavaScript functions (the service's preparation sequence, the
  resolver and helpers through host stubs, GenerateCode's stack arguments, every failure); the 128 cut names, each
  called, each with its one red line and its answer. `t_codec_video.c`, `t_movie_avc.c`, `t_movie_vpx.c` test the
  decoders that are cut.
- More layouts byte for byte with guard bytes: NpadState (0x28, all five styles, 16 entries), SixAxisSensorState
  (0x60; note the C code's negative zero in the direction at rest), TouchScreenState<1..16>, GestureState (0x60),
  JcmsState (32), NmouseState (48), VibrationValue and the handles' bytes, ControllerSupportResultInfo, MouseState,
  KeyboardState, DebugPadState, NpadControllerColor, DisplayInfo (0x60), FrameInfo (40), the panel identifier,
  nn::ro::Module, the JIT environment and its info, the plugin's configuration, VideoDecoderImagePreference.

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
- **Controllers**: one snapshot per read, the hold's reasons, slots by source id, one path for player 1
  ("Controllers" above). Scripted and recorded input (`DM_KEYS`, `DM_CTL`, `DM_REC`), `DM_HID_RECEIPT_LOG`,
  `dm_input_sampled_right`, `dm_pad_hook`, `DM_RUMBLE_LOG`, `DM_JCMS_LOG`, `DM_TOUCH_LOG` and `dm_haptics_level` (the
  Core Haptics mapping) are not ported: scripting, recording and device adaptation are the embedder's. The style
  events fire exactly where nxnative fires them, which means not on an operation mode change (No1 and Handheld swap
  silently there too). A motion sample without a time is timed by its arrival, as `dm_motion_set`; `DM_MOTION_LOG`
  prints thousandths instead of `%f`. The fusion's sinf / cosf are AssemblyScript's (a last place of the rotation
  matrix in 70 of 17,460 compared steps).
- **The controller applet's prompt is asynchronous**: `hle_ctrl_prompt` and `hle_ctrl_answer`, the caller waiting on
  an event (nxnative blocks in `front_ctrl_support`); a second thread's applet waits for the first one's prompt.
- **`nn::vi`'s present side is imports**: the layer's size and crop are told (`hle_vi_layer`, `hle_vi_crop`), the
  frame count and the present queue asked (`hle_vi_frame_count`, `hle_vi_present_progress`, `hle_vi_presented_ns`,
  in ns where nxnative has seconds as a double), and each queued present reported (`hle_vi_frame_queued`). The
  display's pixels for `QueryDisplayBufferMaxResolution` are configuration (`display`).
- **`nn::ro` loads the image the game passes** through the embedder's loader, where nxnative finds an NRO rewritten
  offline by the image's hash; one module per hash at a time, as there. A module joins the symbol lookups after its
  init functions ran (`hle_ro_activate`, as `src/glue/rt_ro.ts` orders it; in nxnative `nro_load` puts it in before
  its init). `DM_NRO_CAPTURE` is not ported.
- **`nn::jit` runs the plugin through the translator**, as nxnative does on the Mac in a MAP_JIT mapping; the
  capture and serving of generated code (`DM_JIT_CAPTURE`, `DM_JIT_SERVE`, nxnative's way on iOS) is not ported. Four
  environments at most. The per-environment mutex is not ported: a guest call does not yield here.
- **Movies and video codecs are cut** ("Cut" above); `dm_movie_playing` (the frame step's 30 fps hold) with them.
- **Logs** of constant bodies compiled from the C text are dropped unless red; hand-written ones keep nxnative's text
  where it is short.

## Requests to the runtime owner

1. **A range for the module's static data** in `src/glue/rt_layout.ts` ("hle static", 1 MB is ample: about 460 KB used with controllers, vi, ro and jit),
   `hleBuildShared(join(OUT, "hle.wasm"), range("hle static").lo)` in `rt:build`, and `hle?: WebAssembly.Module`
   in `RuntimeModules`. The host area is fully assigned today.
2. **`HostCpu.setD(i, bits)`**: a host function cannot write `d0` (the runtime README lists it as a gap). The 28
   pass-through math functions that return a float or double and `strtod` / `atof` / `strtof` need it; `hle_rt.ts` logs red once without it.
3. **x8 in the argument block** or as now `cpu.x(8)`: used; fine as it is.
4. **A "this thread never continues" result** for a host function (aborts, `ExecuteProgram`): `hle_rt.ts` gives the
   core up with pc 0xFFFF_FFE0, which is unverified.
5. **`svc CloseHandle` reported** to `HleHost.handleClosed(handle)`: nxnative unbinds a SystemEvent when its write
   handle closes. Without it the next signal finds the dead handle and binds again (tested), which is correct but late.
6. **Forced names no module refers to are logged red by the loader, one line each.** This table has 1,049 forced
   names and serves every game, as nxnative's does: there the unreferenced ones are one summary line
   (`force: N entries hit, M not referenced by this game`) and red only with `DM_FORCE_STRICT`.
7. **`rt_hle.ts` is replaced by this table**: `nn::vi` (31 names) and `nn::hid` (169) are in it now, and
   `Runtime.register` keeps the last registration of a name, so `registerVi` / `registerHid` called after `attachHle`
   (as `web/worker.ts` and `test/runtime/gfx_cases.ts` do today) put `rt_hle.ts`'s 4 vi and 9 hid functions over
   this table's, with a state of their own that the other 160 hid names do not share. To remove: both calls, the
   file's `registerVi`, `registerHid` and `NATIVE_WINDOW` (GetNativeWindow hands out `hle_vi_native_window()`; NVN
   only stores it). `RtInput` (live state, latch, the frame script) stays the embedder's and feeds
   `hle.input(0, { buttons, lx, ly, rx, ry })` when it changes: the press latch is in the module, so `RtInput.read`
   and its latch go; a scripted step calls `hle.input` at its frame and `config({ inputScripted: true })` keeps the
   controller applet from waiting. `registerHid`'s `handheld` option goes: the style follows `hle_opmode()` itself.
8. **`src/glue/rt_ro.ts` is replaced too**: `nn::ro`'s 10 names are in the table. `HleEnv.roLoad` =
   `rt.loadModule(name, cpu.read(image, size))` (token: `m.base`), `roCalls` = `m.init ? [m.init] : m.initArray`
   (fini: `m.fini`, or the fini array reversed), `roActivate` = `rt.activateModule`, `roUnload` = `rt.unloadModule`,
   `roLookupIn` = `rt.ld.lookupIn`. `alone: true` (the JIT plugin) asks for a module relocated against itself only
   and kept out of the lookups: the loader has no such mode yet.
9. **`HleEnv.stackArg`** = `cpu.dv().getBigUint64(Number(cpu.sp()) + 8 * i, true)` of the cpu running the take-over,
   and **`guestCall` with more than eight arguments** (the JIT plugin's GenerateCode takes 13): the rest go on the
   guest stack below sp, 16-byte aligned, for the time of the call.
10. **`nn::jit` needs code the guest wrote translated**: `jitMemory` gives two guest-addressable blocks (the game
   jumps into the first), `jitCodeWritten(rx, offset, size)` must drop the translations of that range.
11. **The front end**: `HleFront` in `hle_rt.ts` wants `ctrlPrompt`, `vibration`, `joyMouseWanted`, and from the
   graphics glue `viLayer`, `viCrop`, `viFrameCount`, `viPresentProgress`, `viPresentedNs`, plus a call of
   `host.viFrameQueued(frames)` at each present (`RtGfx`'s `onPresent`). All are optional members of `HleEnv`, so
   `hle_rt.ts` compiles unchanged; without `viFrameCount` the frame number is 0 and one red line.

## Gaps

- Requests 1 to 11 above are answered (`src/runtime/README.md`, "The SDK take-over table", "Modules at run time",
  "Input"): `rt_hle.ts` and `rt_ro.ts` are gone and `Runtime.register` refuses a second answer for a name; input
  arrives through `RtInput` (keyboard, controllers by source id, scripted steps); nn::ro runs a guest's NRO through
  `Runtime.loadModule` (three rounds, and 500 in the robustness sweep); `stackArg`, thirteen-argument guest calls and
  code memory for nn::jit are there; the controller prompt, vibration and nn::vi's present side are connected.
  What is still approximated: a module asked for "alone" is linked like any other (red once), `viLayer` / `viCrop`
  are noted and not applied to the present.
- The table's static data sits above the runtime's guard (`GUARD_BASE`): the guest is handed pointers into it
  (SystemEvent objects the SDK fills, `localtime`'s `struct tm`, language lists).
- Guests have called: 22 names of oe, time, account, nifm, socket and libc (`hleg.c`), nn::vi's four window calls and
  the npad reads (`cube.c`), nn::ro (`ro_main.c`, `stress_ro.c`), four npads with the controller applet and vibration
  (`pads.c`), `localtime` (`tone.c`). `nn::jit` has run against a fake plugin made of JavaScript functions only.
- Out of scope and not in the module's table: file system, graphics (`dm/gfx` but `hle_vi.c`), audio and its codecs,
  cheats, glslc (the status table lists them). Movies and video codecs are in the table as cut stubs.
- The Gamepad API gives no gyro: live motion needs a source the embedder finds (DeviceMotion for the console's own
  sensors, WebHID for a controller's); without one the sensors lie flat and shake by the shake bit.
- No game has run against this: every result is nxnative's C read and re-expressed, checked by tests written from the
  same C, not by an SDK.
- The web view, the input box, fonts and blank native images are imports with no browser implementation here.
