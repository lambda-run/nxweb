# What of nxnative is ported

nxnative runs Switch games natively on Apple silicon: the game's ARM64 code runs on the CPU as it is, and a host
(`dm/host`, 81 source files: 49 `.c`, 26 `.h`, 5 `.m`, one `.S`; 17,941 lines of C) answers the kernel's SVCs, about
1,300 SDK functions by name, and NVN on Metal (`dm/gfx`). nxweb ports the host to the browser and replaces "the code
runs on the CPU" by a translator. Counts below are taken from the code in this repository and from the generated
inventories (`test/hle/status.tsv`, `src/gfx/names.txt`, `src/fs/names.ts`), on the day this was written; where an
area is still being worked on by its owner, its README is the current figure. **No game has been run.** Everything
is verified against self-made modules, hand-assembled shaders and nxnative's own tests where they could be ported.

Ported = written here and tested. Cut = left out on purpose, with the reason. Open = needed, not there.

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
| `loader.c`, `main.c`, `entry.S` | `src/loader`, `src/glue/rt_runtime.ts` | Ported: NSO / NRO, relocation, binding rules, run-time load and unload. Cut: offline rewriting of modules (nxnative patches code; the translator needs none). Open: ZBIC (zstd) segments, TLS relocations, NSP / XCI containers, NACP |
| `scripts/build_ipa_from_nsp.py`, `dm/games` (153 profiles), the patch files | `src/prepare`, `tools/prepare` | Ported for a folder of extracted files: detection by nxnative's dump-folder rules, NPDM (program id, system resource, stack size), the profiles converted (153; 66 of 66 registered code cuts), cuts applied in the page, a RomFS device over the folder, a manifest that survives a reload. Applied by the runtime: the memory keys (as a per-game address-space layout), `op_mode`, `perf_mode`, `alloc_big_align`, `game_env`, `launch_param`. Open: packages (NSP / XCI / NCA: nothing is decrypted), frame-step patches (5 games), cuts found by function fingerprints, shaders pre-warm; 14 profiles need more than a 32-bit address space |
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
| NVN on Metal (`dm/gfx/nvn`, 20,281 lines) | `src/gfx` + `src/glue/gfx_host.ts` | Ported: 332 of 743 NVN entry points are implemented (nxnative: 489), the record formats byte for byte, the render pass machine, pipelines, texture content tracking, 42 browser scenes verified by pixels. The rest are red stubs |
| | | Open: compute, storage buffers, images, transform feedback, tessellation and geometry stages, multisample resolve, sparse pools, ASTC and some packed formats, more than one viewport, logic ops, alpha test, border colours (see `src/gfx/README.md`, Gaps) |
| Shader chain: `shader_split.py`, `dmsh_xlate` (Ryujinx), SPIRV-Cross, MSL fix-ups, Metal libraries | `tools/shaders`, `src/shaders`, `src/glue/rt_shaders.ts` | Ported: key, translator (unchanged, also as WebAssembly in the page), a SPIR-V pass with 9 rewrites and naga in place of SPIRV-Cross and the MSL fix-ups, a library format, lookup at run time with translation in a Worker. 3 hand-assembled Maxwell programs and 27 of 43 GLSL test shaders convert. Cut: everything written against MSL text. Open: bindless textures, storage buffers and images, geometry / tessellation lowering, `vs_pad`, integer inputs and outputs, the per-game answer table, NVN2 / Ampere code, `shader_split.py` in a page |
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

## State machines

44 machines in the kit today (kit 2, loader 1, kernel 3, runtime 1, gfx 8, fs 6, hle 15, audio 7, prepare 1), each
with a generated diagram in `docs/machines`; `kit:test` takes all 433 transitions. The audio renderer's four
(`audio_ren`, `audio_ren_thread`, `audio_render`, `audio_ren_update`) are the host's side of the SDK's renderer: the
renderer's life from open to close with its render thread, the thread's loop, one render, one update. A voice's state
(stopped / playing / paused, its wave buffer queue) is the SDK's, in the game, as in nxnative: the host has no voice.

## What "open" means for running a game

In the order a real game would hit them: containers (NSP / XCI / NCA: the prepare step takes extracted folders
only); a real SDK in the guest (rtld's part is played by the loader, but nn::os objects, TLS and SystemEvents have
only been exercised with self-made modules); the address space (14 of 153 profiles need more than 32 bits; the
other 139 fit by arithmetic, unproven); real shader libraries through the chain; a real SDK's audio renderer under
the host's take-overs (they have only driven stand-ins); movies.
