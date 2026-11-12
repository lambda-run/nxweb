# Setup (Alpine VM; nothing is installed on the Mac)

Everything lives under `/ctl` in the VM (= `vm/ctl` on the Mac's disk), so it survives a VM reboot. The VM's own
packages (node 24, clang 22, lld, python3, git) come back with `/ctl/provision.sh` as before; this track adds no apk
package to the RAM disk.

## What is where

| path (VM) | what | size |
|---|---|---|
| /ctl/emsdk/emscripten | Emscripten 4.0.22 from the GitHub tag tarball (python + JS only; `test/` and `site/` not unpacked), `npm install --omit=dev` | 122 MB |
| /ctl/emsdk/binaryen | Alpine's `binaryen-129-r0.apk` fetched with `apk fetch` and unpacked here (not installed) | 26 MB |
| /ctl/emsdk/cache | Emscripten's system libraries, built on first use (wasm32 and wasm64, pthreads) | ~60 MB |
| /ctl/emsdk/emscripten.cfg, env.sh | config: `LLVM_ROOT=/usr/bin` (Alpine's clang 22.1.3 / wasm-ld), `BINARYEN_ROOT`, `NODE_JS`, `CACHE` | |
| /ctl/nxweb-em/em | this directory (branch `emscripten-port` of nxweb; before the move: /ctl/nxem, history kept by `git subtree add`) | |

Why not emsdk: its prebuilt LLVM is glibc-only and Alpine is musl. Why 4.0.22: it is the last release line that
expects LLVM 22, which is what Alpine 3.24 ships (5.x expects LLVM 23). Binaryen 129 against the expected 125 gives
one warning per link (`-Wversion-check`), nothing else seen.

## Install (once; idempotent)

```sh
vm/nx sh '(nohup sh /ctl/nxweb-em/em/tools/install_emsdk.sh > /ctl/nxweb-em/em/logs/install.log 2>&1 &)'   # ~1 min, needs network
tail -3 vm/ctl/nxweb-em/em/logs/install.log        # ends with: emcc ... 4.0.22-git / INSTALL_DONE
```

`tools/install_emsdk.sh` is the copy of `/ctl/emsdk/install.sh` that was run. After a VM reboot nothing has to be
reinstalled: `. /ctl/emsdk/env.sh` is all a shell needs (the build scripts do it). The first build of each flavour
(wasm32, wasm64) compiles Emscripten's libc with the system clang: about 6 minutes each on the loaded VM, then cached.

## Build and run

The directory is `em/` of the nxweb tree on branch `emscripten-port` (worktree `/ctl/nxweb-em`; the Mac side is
`vm/ctl/nxweb-em`). It imports nxweb's glue from that tree's `src/`, takes nxweb's built modules (translator,
helpers, loader) from the main checkout's `/mnt/build/runtime` (read-only; `NXWEB_BUILD` overrides) and uses the main
checkout's `node_modules` through a symlink (`ln -sfn /mnt/node_modules /ctl/nxweb-em/node_modules`).
`build.py` compiles `.c` with emcc and `.cpp` with em++ into `build/obj/` and links once with em++.

```sh
cd /ctl/nxweb-em/em
python3 build.py p1                      # thread core stress test          -> build/p1
python3 build.py p2 --mem 32|64          # translated guest threads (node)  -> build/p2, build/p2_64
python3 build.py p2 --env web [--gb 16]  # the same as a page               -> build/web/p2
python3 build.py nxtests                 # nxnative's own unit tests of hle_thread.c
python3 build.py p4                      # the real game's code: boot harness (node, 16 GB memory64) -> build/p4
sh check_all.sh                          # all of the above, built and run; one line each in logs/check_all.log

sh run_p2.sh a78c 3000000                # <v80|a78c> [mutex rounds] [compute iterations]; M=64 for memory64
sh run_nxtests.sh                        # result in logs/nxtests.log
node tools/extract_exefs.mts             # once: the game's code modules out of /game/zelda-oot.nup -> build/game/exefs
sh run_p4.sh 90                          # boot harness for 90 s; log and report in logs/p4.log

# Chromium gate (headless, /ctl/headless/cdp.mjs): the page of proof 2, then the game's translation cache
(nohup node web/serve.mjs > logs/serve.log 2>&1 &)                     # http://localhost:8091/ from build/web, COOP/COEP
node web/cache_dump.mjs dump                                           # nxweb's cache blobs -> build/web/put/tc*.bin
sh run_gate.sh gate1 150                                               # logs/gate1.log
MR=20000 sh run_gate.sh gate2 500 24 - "http://localhost:8091/put/tc3.bin,http://localhost:8091/put/tc1.bin"
sh hle/test/run.sh thunks                # the thunk generator's own test
```

From the Mac every line is `vm/nx sh '<line>'`; anything over a minute as `(nohup sh -c "..." > logs/x.log 2>&1 &)`.
The first Proof 2 / boot build needs nothing built in this tree. Game files and cache blobs stay under `build/`
(ignored by git).

## Rules of the shared VM

One command runs at a time for all agents: start builds with `nohup` in a subshell and read the log from the Mac
side; never `sleep` or poll inside the VM.
