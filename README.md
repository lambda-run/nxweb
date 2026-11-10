# nxweb

nxnative in the browser: Nintendo Switch game code translated to WebAssembly, with the Horizon host in
AssemblyScript and NVN graphics on WebGPU. A port of [nxnative](https://github.com/seedds/nxnative) (MIT).

You supply your own games. Nothing from any game is in this repository. Not affiliated with Nintendo.

**Status: early.** No game runs yet. Self-made test modules (real NSO files built from C) load, run and draw through NVN in the browser:

![The demo page running a translated test module that draws a spinning cube through NVN on WebGPU](docs/images/web-demo.png)


| Area | State |
|---|---|
| State machine kit (`src/kit`) | Working, tests pass |
| ARM64 test programs and reference runner (`test/guests`, `tools`) | Working, 21 programs |
| ARM64 to WebAssembly translator (`src/a64`) | Working: instruction fuzz clean (338,000 cases), all 75 test programs pass in Node and Chromium |
| Module loader (`src/loader`) | Working, tests pass (no real game file tried) |
| Kernel core (`src/kernel`) | Working, tests pass |
| Runtime (`src/runtime`, `src/glue/rt_*`) | Working: translator + loader + kernel on one memory; multi-threaded NSO test modules run in Node and Chromium |
| NVN on WebGPU (`src/gfx`) | Working in isolation: 302 of 743 NVN functions, 22 browser scenes pass |

Start with [docs/CONTRACT.md](docs/CONTRACT.md). Generated state diagrams are in [docs/machines](docs/machines).

```
npm install
pip install unicorn capstone     # reference emulator, tests only
npm run web                      # the page above, on http://localhost:8080
npm test                         # needs clang with the aarch64 target and ld.lld
```
