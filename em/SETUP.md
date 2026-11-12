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
| /ctl/nxem | this repository (`git init`, local commits only) | |

Why not emsdk: its prebuilt LLVM is glibc-only and Alpine is musl. Why 4.0.22: it is the last release line that
expects LLVM 22, which is what Alpine 3.24 ships (5.x expects LLVM 23). Binaryen 129 against the expected 125 gives
one warning per link (`-Wversion-check`), nothing else seen.

## Install (once; idempotent)

```sh
vm/nx sh '(nohup sh /ctl/nxem/tools/install_emsdk.sh > /ctl/nxem/logs/install.log 2>&1 &)'   # ~1 min, needs network
tail -3 vm/ctl/nxem/logs/install.log        # ends with: emcc ... 4.0.22-git / INSTALL_DONE
```

`tools/install_emsdk.sh` is the copy of `/ctl/emsdk/install.sh` that was run. After a VM reboot nothing has to be
reinstalled: `. /ctl/emsdk/env.sh` is all a shell needs (the build scripts do it). The first build of each flavour
(wasm32, wasm64) compiles Emscripten's libc with the system clang: about 6 minutes each on the loaded VM, then cached.

## Build and run

All from the Mac, in `Zelda-extracted-UNVERIFIED`; logs are readable on the Mac under `vm/ctl/nxem/logs/`.

```sh
# Proof 1: nxnative's thread core under Emscripten pthreads
vm/nx sh '(cd /ctl/nxem && nohup sh build_p1.sh > logs/build_p1.log 2>&1 &)'
vm/nx sh 'cd /ctl/nxem/build/p1 && timeout 200 node p1_stress.js 8 20000'        # [threads] [rounds]

# nxnative's own unit tests of the thread core (builds and runs; result in logs/nxtests.log)
vm/nx sh '(cd /ctl/nxem && nohup sh build_nxtests.sh > logs/build_nxtests.log 2>&1 &)'

# Proof 2: translated ARM64 guest threads on pthreads. 32 = 32-bit memory, 64 = memory64 with the guest above 4 GB
vm/nx sh '(cd /ctl/nxem && nohup sh build_p2.sh 32 > logs/build_p2.log 2>&1 &)'
vm/nx sh 'cd /ctl/nxem && sh run_p2.sh a78c 3000000'            # <v80|a78c> [mutex rounds] [compute iterations]
vm/nx sh '(cd /ctl/nxem && nohup sh build_p2.sh 64 > logs/build_p2_64.log 2>&1 &)'
vm/nx sh 'cd /ctl/nxem && M=64 sh run_p2.sh a78c 3000000'
```

Proof 2 needs nxweb's built translator (`/mnt/build/runtime/translator*.shared.wasm`, `helpers*.shared.wasm`; `npm run
rt:build` in nxweb makes them) and nxweb's `node_modules/.bin/esbuild`. It reads them; it writes nothing into nxweb.

## Rules of the shared VM

One command runs at a time for all agents: start builds with `nohup` in a subshell and read the log from the Mac
side; never `sleep` or poll inside the VM.
