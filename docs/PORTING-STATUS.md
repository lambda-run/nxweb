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
| `loader.c`, `main.c`, `entry.S` | `src/loader`, `src/glue/rt_runtime.ts` | Ported: NSO / NRO, relocation, binding rules, run-time load and unload. Cut: offline rewriting of modules (nxnative patches code; the translator needs none). Open: ZBIC (zstd) segments, TLS relocations, NSP / XCI containers, NPDM / NACP |
| `hle_svc.c`, `hle_thread.c`, `thread.c`, `hle_guestthread.c` | `src/kernel` | Ported: 41 SVC numbers (0x01-0x12, 0x16-0x1F, 0x21, 0x24-0x27, 0x29, 0x2C, 0x2D, 0x32-0x35, 0x45) with a real scheduler in place of pthreads. Cut: nxnative's scheduling remedies (yield back-off, QoS mapping, spin gates). Open: IPC beyond stubs, shared / transfer / code memory, process and debug SVCs |
| `hle_os.c` | `src/kernel/clock.ts`, `src/hle/os.ts` | Ported: guest clock with freeze reasons, entropy, getenv, allocator hook |
| `hle_ro.c` (10 names) | `src/glue/rt_ro.ts` | Ported: 10 of 10 names over the loader. Cut: finding NROs by hash among offline-rewritten ones. Open: NRR checks |
| `hle_fs.c` (73 names), `romfs_image.h`, `romfs_identity.h`, `save_sync.*` | `src/fs` | Ported: 73 of 73 names (72 implemented, `MountSystemData` a stub), standard RomFS, transactional saves on OPFS. Cut: host folders, overlays, save sync. Open: nxnative's `DMROMFS1` image format |
| `hle_account.c`, `hle_friends.c`, `hle_mii.c`, `hle_misc.c`, `hle_net.c`, `hle_nvdrv.c`, `hle_oe.c`, `hle_offline.c`, `hle_sdk16.c`, `hle_sdkinit.c`, `hle_sf.c`, `hle_swkbd.c`, `hle_table.c`, `hle_time.c`, `hle_web.c`, `hle_lifecycle.c`, `hle_count.c` | `src/hle` | Ported: 768 table entries (704 forced, 64 weak), 268 written by hand and 500 compiled from the C bodies, 0 stubs. Open on the page side: the input box, the web view, shared fonts, native images (the table answers as nxnative does without a window) |
| `hle_hid.c` (169 names), `hle_touch.c`, `hle_haptics.*`, `pad_*.h`, `motion_*.h`, `dm_input.h`, `ctrl_prompt.h`, `switch2_proto.h` | `src/glue/rt_hle.ts` (8 names); `src/hle` (in progress by its owner) | Ported: 8 npad names (one player, full-key or handheld). Open: the other 161, touch, motion, vibration. Cut: Apple controller back ends (the Gamepad API replaces them) |
| `hle_audio.c`, `hle_audren.c`, `hle_codec.c` (118 names) | `src/audio` (another area) | In progress; not attached to the runtime |
| `hle_codec_video.c`, `hle_movie*.c/h` (128 names and the decoders) | | Open |
| `hle_jit.c` (7), `hle_glslc.c` (1) | | Open (in progress in `src/hle`) |
| `hle_cheats.c`, `hle_fpslock.c`, `hle_uecvar.c`, `hle_uemalloc.c`, `hle_oodle.c`, `hle_bigstack.c`, `hle_fdstat.c`, `memstat.m`, `probe.c`, `crash.c` | | Open: per-game aids and diagnostics, none ported. Faults are reported by the runtime (`src/runtime`) |
| `front.h`, `front_mac.m`, `home_quit*.h`, `web_apple.m`, `pad_switch2_apple.m`, `haptics_apple.m` | `web/` | Replaced: the page (canvas, keyboard, Gamepad API, file pickers). `home_quit.h`'s machine is the kit's reference example (`test/kit`) |

Of the 1,274 `HLE` / `HLE_FORCE` entries in `dm/host`: **859 answered here** (768 in `src/hle`, 73 in `src/fs`, 10 in
`rt_ro.ts`, 8 of `hle_hid.c` in `rt_hle.ts`), **415 open** (161 hid, 118 audio, 128 video, 7 jit, 1 glslc).
nn::vi (31 entries in `dm/gfx/hle_vi.c`): 4 answered in `rt_hle.ts`.

## Graphics (`dm/gfx`)

| nxnative | nxweb | State |
|---|---|---|
| NVN on Metal (`dm/gfx/nvn`, 20,281 lines) | `src/gfx` (3,730 lines) + `src/glue/gfx_host.ts` | Ported: 333 of 743 NVN entry points have a case in `dispatch.ts` (nxnative: 489), the record formats byte for byte, the render pass machine, pipelines, texture content tracking, 42 browser scenes verified by pixels. The rest are red stubs |
| | | Open: compute, storage buffers, images, transform feedback, tessellation and geometry stages, multisample resolve, sparse pools, ASTC and some packed formats, more than one viewport, logic ops, alpha test, border colours (see `src/gfx/README.md`, Gaps) |
| Shader chain: `shader_split.py`, `dmsh_xlate` (Ryujinx), SPIRV-Cross, MSL fix-ups, Metal libraries | `tools/shaders`, `src/shaders`, `src/glue/rt_shaders.ts` | Ported: key, translator (unchanged, also as WebAssembly in the page), a SPIR-V pass with 9 rewrites and naga in place of SPIRV-Cross and the MSL fix-ups, a library format, lookup at run time with translation in a Worker. 3 hand-assembled Maxwell programs and 27 of 43 GLSL test shaders convert. Cut: everything written against MSL text. Open: bindless textures, storage buffers and images, geometry / tessellation lowering, `vs_pad`, integer inputs and outputs, the per-game answer table, NVN2 / Ampere code, `shader_split.py` in a page |
| OpenGL and Vulkan front ends (`dm/gfx/gl`, `vk`: 294 pass-through rows) | | Cut: NVN only |
| `hle_vi.c`, `hle_nv.c` | `rt_hle.ts`, `rt_gfx.ts` | Ported in part: the window path and frame pacing; no vi service, no vsync event outside `src/hle`'s |

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
| nn::hid | 169 | 8 |
| nn::audio, codecs | 118 | 0 attached |
| movies | 128 | 0 |

## State machines

38 machines in the kit today (kit 2, loader 1, kernel 3, runtime 1, gfx 7, fs 6, hle 15, audio 3, some of them added
by owners still at work), each with a generated diagram in `docs/machines`.

## What "open" means for running a game

In the order a real game would hit them: containers and metadata (NSP / XCI, NPDM, NACP); a real SDK in the guest
(rtld's part is played by the loader, but nn::os objects, TLS and SystemEvents have only been exercised with
self-made modules); real shader libraries through the chain; audio; the rest of hid; movies.
