# What of nxnative is ported

nxnative runs Switch games natively on Apple silicon: the game's ARM64 code runs on the CPU as it is, and a host
(`dm/host`, 81 source files: 49 `.c`, 26 `.h`, 5 `.m`, one `.S`; 17,941 lines of C) answers the kernel's SVCs, about
1,300 SDK functions by name, and NVN on Metal (`dm/gfx`). nxweb ports the host to the browser and replaces "the code
runs on the CPU" by a translator. Counts below are taken from the code in this repository and from the generated
inventories (`test/hle/status.tsv`, `src/gfx/names.txt`, `src/fs/names.ts`), on the day this was written; where an
area is still being worked on by its owner, its README is the current figure. **No game has been run.** Everything
is verified against self-made modules, hand-assembled shaders and nxnative's own tests where they could be ported,
and one third-party program that is not a Switch game (Doom, below).

Ported = written here and tested. Cut = left out on purpose, with the reason. Open = needed, not there.

## A third-party program: Doom (`test/doom`)

Not a Switch game and not part of nxnative: the open-source engine doomgeneric (GPL-2, fetched by
`tools/doom/fetch.sh`, never committed) built as an NSO from C with this repository's platform layer and C library,
as the first workload of some size that nobody here wrote. With the shareware data file (not included):

| | State |
|---|---|
| Boot, title, attract demos | Works. All three recorded demos run to their end under `-timedemo`; every 50th frame of demo3 (42 frames over 2134 tics) is bit-identical to the same engine built for the test machine with the host's compiler |
| A new game from the menu, playing with keyboard or pad | Works (tested with scripted input under Node and with the keyboard in headless Chromium) |
| Saved games | Works: files of the save data (nn::fs, committed at once); a second process loads what the first saved |
| Screen | 640x400 XRGB copied into an NVN texture every frame (`CopyBufferToTexture`), drawn 4:3 into a 1280x720 window |
| Speed | 5.7 M guest instructions per frame; about 1.1 G instructions per second under Node (5 ms per frame unpaced); 35 frames per second in headless Chromium on SwiftShader with 4 to 5 ms of work per frame |
| Sound and music | Open: the engine runs with its null sound module |
| Found in nxweb on the way | Two things, both fixed with a test in their area. The translator's single-instruction mode (how instructions are counted) made one WebAssembly module per instruction: 2 GB of engine memory after 7,000 instructions; now the instructions after an entry share its module. The page sampled the keyboard once per animation frame: a key pressed and released between two frames never reached the game; now every key event is sent. Nothing else: no instruction, relocation, SVC, nn::fs or NVN path was missing or wrong |

## The CPU (no counterpart in nxnative)

| | State |
|---|---|
| ARM64 → WebAssembly translator (`src/a64`, 4,096 lines of AssemblyScript) | Ported (new): the user-mode instruction set of the Cortex-A57 level, 169 instruction classes fuzzed against Unicorn (338,000 cases), 75 guest images in Node and Chromium |
| Not on the Switch CPU, reported if executed | Cut: LSE atomics, half-precision arithmetic, SVE, pointer authentication forms |
| FPSR cumulative flags, FPCR.FZ / DN | Open (ignored) |
| Threads on Workers (shared memory) | Open: the translator has shared builds; the runtime uses one Worker |

## Host files (`dm/host`)

| nxnative | nxweb | State |
|---|---|---|
| `loader.c`, `main.c`, `entry.S` | `src/loader`, `src/glue/rt_runtime.ts` | Ported: NSO / NRO, relocation, binding rules, run-time load and unload. Cut: offline rewriting of modules (nxnative patches code; the translator needs none). Open: ZBIC (zstd) segments, TLS relocations, NSP / XCI containers (a NUP container is opened by the prepare step, with its NACP) |
| `scripts/build_ipa_from_nsp.py`, `dm/games` (153 profiles), the patch files | `src/prepare`, `tools/prepare` | Ported for a NUP container (`scripts/pack_nup.py`: `src/prepare/host/nup.ts`, the same checks, the file read in place by ranges, zstd frames decompressed per file on demand, every file checked against its SHA-256 as it is first read whole, NACP name / display version / icon; compared with nxnative's own reader in the tests) and for a folder of extracted files: detection by nxnative's dump-folder rules, NPDM (program id, system resource, stack size), the profiles converted (153; 66 of 66 registered code cuts, 17 of 17 function-matched rules), cuts applied in the page, cuts for unregistered builds placed by function fingerprint (`src/prepare/match.ts`: nxnative's `nso_match.py`, fingerprints equal on 937 of 937 compiled test functions that have one), a RomFS device over the folder, a manifest that survives a reload. Applied by the runtime: the memory keys (as a per-game address-space layout), `op_mode`, `perf_mode`, `alloc_big_align`, `game_env`, `launch_param`. Open: encrypted packages (NSP / XCI / NCA: nothing is decrypted, the page says what such a file is and what to convert it to), NUP limits (a file larger than about 2 GB that is stored compressed cannot be decompressed in one piece; `addon_update` and `system` packages are named and not used), frame-step stubs (8 profiles: "Frame-step stubs" below), the nine rewrites nxnative finds by code, shaders pre-warm; 14 profiles need more than a 32-bit address space (the prepare step's report takes that verdict from the runtime's `layoutFor` and names them) |
| `hle_svc.c`, `hle_thread.c`, `thread.c`, `hle_guestthread.c` | `src/kernel` | Ported: 41 SVC numbers (0x01-0x12, 0x16-0x1F, 0x21, 0x24-0x27, 0x29, 0x2C, 0x2D, 0x32-0x35, 0x45) with a real scheduler in place of pthreads. Cut: nxnative's scheduling remedies (yield back-off, QoS mapping, spin gates). Open: IPC beyond stubs, shared / transfer / code memory, process and debug SVCs |
| `hle_os.c` | `src/kernel/clock.ts`, `src/hle/os.ts` | Ported: guest clock with freeze reasons, entropy, getenv, allocator hook |
| `hle_ro.c` (10 names) | `src/hle/ro.ts` over `Runtime.loadModule` | Ported: 10 of 10 names; a guest loads, calls and unloads an NRO 500 times. Cut: finding NROs by hash among offline-rewritten ones. Open: NRR checks |
| `hle_fs.c` (73 names), `romfs_image.h`, `romfs_identity.h`, `save_sync.*` | `src/fs` | Ported: 73 of 73 names (72 implemented, `MountSystemData` a stub), standard RomFS, transactional saves on OPFS. Cut: host folders, overlays, save sync. Open: nxnative's `DMROMFS1` image format |
| `hle_account.c`, `hle_friends.c`, `hle_mii.c`, `hle_misc.c`, `hle_net.c`, `hle_nvdrv.c`, `hle_oe.c`, `hle_offline.c`, `hle_sdk16.c`, `hle_sdkinit.c`, `hle_sf.c`, `hle_swkbd.c`, `hle_table.c`, `hle_time.c`, `hle_web.c`, `hle_lifecycle.c`, `hle_count.c` | `src/hle` | Ported (with the rows below: 1,113 table entries in scope, 1,049 forced and 64 weak; 388 written by hand, 597 compiled from the C bodies, 128 cut stubs). Open on the page side: the input box, the web view, shared fonts, native images (the table answers as nxnative does without a window) |
| `hle_hid.c` (169 names), `hle_touch.c`, `hle_haptics.*`, `pad_*.h`, `motion_*.h`, `dm_input.h`, `ctrl_prompt.h`, `switch2_proto.h` | `src/hle` (`hid.ts`, `touch.ts`, `motion.ts`, `haptics.ts`, `padslots.ts`), `src/glue/rt_input.ts` | Ported: 169 of 169 names; players by source id, the controller applet as a wait (a page dialog), vibration to the Gamepad API. A guest reads four npads. Open: a motion source and touch from the page. Cut: Apple controller back ends, DM_KEYS / DM_CTL / DM_REC (scripted steps in frames replace them) |
| `hle_audio.c`, `hle_audren.c`, `hle_codec.c` (118 names) | `src/audio`, `src/glue/rt_audio.ts` | Ported and attached: 118 names resolve, all implemented: AudioOut / AudioIn / OutputStream, the Opus decoder manager, and the audio renderer as nxnative has it: no mixer of the host's; the game's SDK renderer is opened for CPU rendering with manual execution, driven from a render thread the SDK starts for the host, its command list walked for the DeviceSink (header layouts of SDK 4 to 21), with the catch-up rule of `AudioRenderSystem::Update`. A take-over that runs SDK code is a sequence of steps the calling guest thread runs as guest code, so it can block on the SDK's update lock. A guest plays a tone on the silent sink (exact release times) and through an AudioWorklet; another, with a stand-in SDK renderer of its own, plays two voices through the renderer take-overs: the expected samples at the sink and at the worklet, the wave buffers reported consumed. Open: no real SDK's renderer has run (there is none in the tree); the render time statistics |
| `hle_codec_video.c`, `hle_movie*.c/h` (128 names and the decoders) | `src/hle` (`movie.ts`, `codec_video.ts`) | Cut: every name resolves to a stub that fails as nxnative does without a decoder |
| `hle_jit.c` (7), `hle_glslc.c` (1) | `src/hle/jit.ts` | jit: ported against a fake plugin, with code memory and re-translation in the runtime; never run with a real plugin. glslc: open |
| `hle_cheats.c`, `hle_fpslock.c`, `hle_uecvar.c`, `hle_uemalloc.c`, `hle_oodle.c`, `hle_bigstack.c`, `hle_fdstat.c`, `memstat.m`, `probe.c`, `crash.c` | | Open: per-game aids and diagnostics, none ported. Faults are reported by the runtime (`src/runtime`) |
| `front.h`, `front_mac.m`, `home_quit*.h`, `web_apple.m`, `pad_switch2_apple.m`, `haptics_apple.m` | `web/` | Replaced: the page (canvas, keyboard, Gamepad API, file pickers). `home_quit.h`'s machine is the kit's reference example (`test/kit`) |

Of the 1,274 `HLE` / `HLE_FORCE` entries in `dm/host`: **1,273 resolve here** (1,082 in `src/hle`, 73 in `src/fs`, 118
in `src/audio`), of which 128 are cut stubs (movies, video codecs); **1 open** (glslc). nn::vi (31 entries in `dm/gfx/hle_vi.c`): 31 in `src/hle`. Every name has
one answer: the runtime refuses a second registration.

## Graphics (`dm/gfx`)

| nxnative | nxweb | State |
|---|---|---|
| NVN on Metal (`dm/gfx/nvn`, 20,281 lines) | `src/gfx` + `src/glue/gfx_host.ts` | Ported: 332 of 743 NVN entry points are implemented (nxnative: 489), the record formats byte for byte, the render pass machine, pipelines, texture content tracking, bindless textures whose handle is a word of a uniform slot (resolved at each draw, as nxnative's `tex_ubo` / `samp_ubo`), 46 browser scenes verified by pixels. The rest are red stubs |
| | | Open: compute, storage buffers, images, transform feedback, tessellation and geometry stages, multisample resolve, sparse pools, ASTC and some packed formats, more than one viewport, logic ops, alpha test, border colours (see `src/gfx/README.md`, Gaps). Per-stage binding limits: the device is asked for the adapter's limits, only what a shader uses is bound, and a stage that still does not fit fails with a red line naming the WebGPU limit and the excess; nxnative binds through Metal argument buffers and has no such limit. The only adapter measured (SwiftShader) grants the defaults (12 uniform buffers, 16 textures, 16 samplers a stage), so a stage beyond them has not drawn here. Bindless handle arrays and pools indexed at run time (`tex_htab`, `tex_c2a`, `tex_pool`): not supported, WebGPU's core has no binding arrays |
| Shader chain: `shader_split.py`, `dmsh_xlate` (Ryujinx), SPIRV-Cross, MSL fix-ups, Metal libraries | `tools/shaders`, `src/shaders`, `src/glue/rt_shaders.ts` | Ported: key, translator (unchanged, also as WebAssembly in the page), a SPIR-V pass with 9 rewrites and naga in place of SPIRV-Cross and the MSL fix-ups, a library format, lookup at run time with translation in a Worker. 4 hand-assembled Maxwell programs (one bindless) and 27 of 43 GLSL test shaders convert; a bindless texture whose handle the translator traced to a uniform word is placed with where its handle is. Cut: everything written against MSL text. Open: bindless handle arrays and pools, bindless with a separate sampler, storage buffers and images, geometry / tessellation lowering, `vs_pad`, integer inputs and outputs, the per-game answer table, NVN2 / Ampere code, `shader_split.py` in a page |
| OpenGL and Vulkan front ends (`dm/gfx/gl`, `vk`: 294 pass-through rows) | | Cut: NVN only |
| `hle_vi.c`, `hle_nv.c` | `src/hle/vi.ts`, `rt_gfx.ts` | Ported: nn::vi's 31 names with the present side from the graphics glue (frame count, present progress, vsync events ticked at each present), frame pacing; the layer's size and crop are noted, not applied. `hle_nv.c`: open |

## Services (as nxnative groups its take-overs)

| Service | Entries in nxnative | Here |
|---|---|---|
| nn::oe, applet lifecycle | 55 + parts of sdk16 | 55, with focus, messages, operation mode, exit path |
| nn::account, friends, mii | 41 + 33 + 17 | all 91 |
| nn::time | 29 | 29 |
| nn::socket, nifm, ssl, http (offline answers) | 101 + 132 | all 233 |
| nn::swkbd, nn::web | 31 + 13 | all 44; no page-side box or view yet |
| libc pass-through | 63 | 63 (math in d0, strtod, mem*, str*, time) |
| nn::fs | 73 | 73 |
| nn::ro | 10 | 10 |
| nn::hid | 169 | 169 |
| nn::vi | 31 | 31 |
| nn::jit | 7 | 7 (against a fake plugin) |
| nn::audio, codecs | 118 | 118, attached; the audio renderer is the SDK's own, driven by the host (tested with a stand-in SDK) |
| movies, video codecs | 128 | 128 cut stubs |

## Frame-step stubs (`FRAME_STEP`, `MATCH_FRAME_STEP`): not converted, and what is missing

What they are in nxnative (`dm/tools/patch_nso.py`, "Frame step in whole vsyncs"; the stubs themselves are in
`dm/games/<id>/patches.py`): for a `main` of a registered build, a Python function `FRAME_STEP[build ID](ctx)`
assembles code into a **patch area** beside the module (`ctx.emit`, `ctx.here()`), replaces instructions of the
game with branches into it (`ctx.site(offset, original bytes)`, `ctx.put(offset, words, reason)`), and that code
reads and writes a **state page** (`ctx.state`: the page after nxnative's key page, zero in the file, read-write).
The host writes the page: `loader.c dm_fps_state_apply` once at start (+0 the target frame rate as a float, 0 =
every stub runs the original instructions; +0x10 the render scale; +0x40 dynamic resolution on or off; +0x48 to
+0x98 the screen shape and HUD placement), and `hle_nvn.c fstep_tick` at every present (+0x20 the step in vsyncs it
decided with `nvn_fstep.h`: how long the frame stays on screen, plus one while the game is behind real time). The
stubs write back (+0x24 a step the game fixes itself, +0x28 one game's vsyncs per update, +0x30 vsyncs stepped).
`MATCH_FRAME_STEP` is the same for a build without `FRAME_STEP`: the function the stubs patch is found by its
fingerprint (`nso_match.locate_stub`) and the stub writes at `ctx.base` + offsets, reads the game's globals with
`ctx.address(offset)` from the original text and may name more functions (`ctx.others`).

In the pinned nxnative: `FRAME_STEP` for 5 builds of 5 profiles (01002B00111A2000, 01006F8002326000,
01007300020FA000, 01007EF00011E000, 0100ECD018EBE000: 176 sites, 5,179 stub words by the converter's recording)
and `MATCH_FRAME_STEP` rules in 4 (01002B00111A2000, 0100F2C0115B6000, 0400486024DEC000, 0400C3F00006E000): 8
profiles. `src/prepare/profiles/report.json` (`conversion.unconverted`) and each profile's `unconverted` list name
them, and the prepare page shows the line for the game. The profile keys they serve stay class c: `fps_target`
(for these games), `render_base`, `screen_aspect`, `fps_hold`.

What does not exist here, precisely:

1. **A patch area in the module's mapping.** `src/loader` maps an NSO's three segments and its bss and nothing
   beside them; the hand-off (`HandOff`) carries module files and same-length cuts. Needed: executable words
   mapped with the module within branch reach of its text (±128 MB for `b`, which the 252 MB code region does not
   give for free), known to the translator as code (its entry bits and pc map cover the code region by module).
2. **The state page**: a zero, read-write guest page at an address the stubs' `adrp` reaches, and its address
   given to the runtime (nxnative: `FPS_STATE_OFF` in the fixups table).
3. **The stubs as data.** A stub function is Python that computes its words from `ctx.here()` and `ctx.state`
   (branches back into the game, `adrp` to the state page), so what it emits depends on where the patch area and
   the page lie, and in nxnative those offsets follow from the module's size. The converter runs each function
   with a recording context at an assumed layout, which counts sites and words but yields words that are right
   only for that layout. To emit them the recording must either be made with the layout the loader will use for
   that build (the build is known, the module's size is not until the player's file is read), or record which
   words are position dependent. A `MATCH_FRAME_STEP` stub additionally needs the matched addresses and the
   original text at prepare time, that is, the stub's logic in the page, not its output.
4. **The driver.** Nothing writes a step: `src/glue/rt_gfx.ts` paces `nvnWindowAcquireTexture` to the display
   frame and counts presents, but there is no port of `nvn_fstep.h` (156 lines, a pure function with nxnative's
   unit test `tests/t_fstep.c`) or of `fstep_tick` (frame cost, late frames, holds, probes), and no present
   interval the host decides (`present_interval` and `fps_target` are class c for every profile). With the page at
   0 the stubs run the original instructions, so installing them without the driver would change nothing.
5. **The settings** that fill the page at start (target rate, render scale, dynamic resolution, screen shape): no
   page-side setting exists for any of them.

Nothing was emitted or half-applied: a profile with these patches runs the game's own frame logic.

## State machines

44 machines in the kit today (kit 2, loader 1, kernel 3, runtime 1, gfx 8, fs 6, hle 15, audio 7, prepare 1), each
with a generated diagram in `docs/machines`; `kit:test` takes all 434 transitions. The audio renderer's four
(`audio_ren`, `audio_ren_thread`, `audio_render`, `audio_ren_update`) are the host's side of the SDK's renderer: the
renderer's life from open to close with its render thread, the thread's loop, one render, one update. A voice's state
(stopped / playing / paused, its wave buffer queue) is the SDK's, in the game, as in nxnative: the host has no voice.

## What "open" means for running a game

Module file size is no longer one of them: a start set that does not fit the runtime's 16 MB staging range is
staged in the process's own heap, stack and alias regions while it is loaded and released before the first guest
instruction, and the code region is sized from the images (`src/runtime/README.md`, "File staging"). Tested with a
synthetic 41.6 MB NSO in `rt:test` and `rt:browser`, and by hand (`RT_HUGE=1`) with a 256 MB file whose image is
512 MB; no real game file was tried. The pc map grows past its fixed 20 MB into the code
region (tested with 27 MB of text touched in every 64 KB). Still fixed: the entry bitmap covers the first 256 MB of
the code region.

In the order a real game would hit them: containers (NSP / XCI / NCA: the prepare step takes a NUP container or an
extracted folder, nothing encrypted); a real SDK in the guest (rtld's part is played by the loader, but nn::os objects, TLS and SystemEvents have
only been exercised with self-made modules); the address space (14 of 153 profiles need more than 32 bits; the
other 139 fit by arithmetic, unproven); real shader libraries through the chain; a real SDK's audio renderer under
the host's take-overs (they have only driven stand-ins); movies.
