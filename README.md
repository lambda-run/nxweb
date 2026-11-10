# nxweb

nxnative in the browser: Nintendo Switch game code translated to WebAssembly, with the Horizon host in
AssemblyScript and NVN graphics on WebGPU. A port of [nxnative](https://github.com/seedds/nxnative) (MIT).

You supply your own games. Nothing from any game is in this repository. Not affiliated with Nintendo.

**Status: early.** No game runs yet. What exists is tested in isolation:

| Area | State |
|---|---|
| State machine kit (`src/kit`) | Working, tests pass |
| ARM64 test programs and reference runner (`test/guests`, `tools`) | Working, 21 programs |
| ARM64 to WebAssembly translator (`src/a64`) | Working: instruction fuzz clean, 62 of 71 test programs pass (see `src/a64/README.md` for gaps) |
| Module loader (`src/loader`) | Working, tests pass (no real game file tried) |
| Kernel core (`src/kernel`) | Working in isolation, tests pass |
| NVN on WebGPU (`src/gfx`) | In progress |

Start with [docs/CONTRACT.md](docs/CONTRACT.md). Generated state diagrams are in [docs/machines](docs/machines).

```
npm install
pip install unicorn capstone     # reference emulator, tests only
npm run kit:test
npm run guests:check             # needs clang with the aarch64 target and ld.lld
```
