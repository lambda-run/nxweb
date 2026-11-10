# nxweb

nxnative in the browser: Nintendo Switch game code translated to WebAssembly, with the Horizon host in
AssemblyScript and NVN graphics on WebGPU. A port of [nxnative](https://github.com/seedds/nxnative) (MIT).

You supply your own games. Nothing from any game is in this repository. Not affiliated with Nintendo.

**Status: early.** No game runs yet. Self-made test modules (real NSO files built from C) load, run and draw through NVN in the browser:

![The demo page running a translated test module that draws a spinning cube through NVN on WebGPU](docs/images/web-demo.png)


| Area | State (from the tests' own summary lines) |
|---|---|
| State machine kit (`src/kit`) | Working: 40 machines, `kit:test` 99 tests, 397 of 397 transitions exercised |
| ARM64 test programs and reference runner (`test/guests`, `tools`) | Working, 21 programs (61 images) |
| ARM64 to WebAssembly translator (`src/a64`) | Working: instruction fuzz clean (338,000 cases), 75 test images pass in four configurations in Node and in Chromium; translation cache; an option that makes guest accesses to host memory trap |
| Module loader (`src/loader`) | Working, 68 tests (no real game file tried) |
| Kernel core (`src/kernel`) | Working, 63 tests |
| Runtime (`src/runtime`, `src/glue/rt_*`) | Working: 52 end-to-end tests under Node, 62 in Chromium: multi-threaded NSO modules, module files of any size (a 40 MB one in the tests), run-time modules (NRO), faults with exact pcs (host memory guarded by default), restart without reload, a per-game address-space layout, a robustness sweep (64 threads for 30 s of guest time, 500 module reloads, 2000 frames) |
| NVN on WebGPU (`src/gfx`) | Working for 333 of 743 NVN functions (14 Node tests, 46 browser scenes); a translated guest draws through it in the page |
| Shaders (`tools/shaders`, `src/shaders`) | Chain works on hand-assembled Maxwell programs, offline and in the page (translated in a Worker, cached); no game shader has been through it |
| File system (`src/fs`) | Working and attached: RomFS images, crash-safe saves on OPFS; 66 tests, 7 in the browser |
| SDK take-overs (`src/hle`) | The names nxnative answers on the host (1,113 in scope: 985 implemented, 128 cut stubs for movies; `hle:test` 97 tests), attached to the runtime with one answer per name: controllers (several players, vibration), display layer, run-time modules; guests call a spread of them |
| Audio (`src/audio`) | Working and attached: 118 names, the audio renderer as nxnative has it (the SDK's own renderer driven by the host; tested with stand-in SDKs); a guest plays a tone on a sample-exact silent sink and through an AudioWorklet, another two voices through the renderer; `audio:test` 97 tests, 11 in the browser |
| Prepare (`src/prepare`) | A NUP container (one `.nup` file, read in place) or a folder of extracted game files becomes a hand-off the page starts: 153 profiles converted from nxnative, code cuts applied, a verdict in plain words before the long stages; `prepare:test` 30 tests, 13 in the browser. No encrypted package (NSP / XCI) is opened |

How the pieces fit: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What of nxnative is ported, cut or open:
[docs/PORTING-STATUS.md](docs/PORTING-STATUS.md).

Start with [docs/CONTRACT.md](docs/CONTRACT.md). Generated state diagrams are in [docs/machines](docs/machines).

## Opening a game

The page starts with one area, **Open a game**. Give it either of:

- **a `.nup` file** ([NUP](https://github.com/a55uka/nup): one unencrypted file that holds the base game, its updates
  and add-ons, as nxnative accepts it). Drop it on the page or press *Choose file*. It is read where it lies, a
  piece at a time: a many-gigabyte file is neither copied nor loaded into memory.
- **a folder of extracted game files** (nxnative's dump layout: `exefs/` and `romfs/`, or `base/`, `updates/<version>/`
  and `dlc/`). Drop it or press *Choose folder*.

The newest update is started unless you pick another. Before the long steps run, a card says in plain words whether
the game *should start*, *might start* (no profile for it) or *can't run in a browser yet*, with the reason (for
example the 14 profiled games that need more memory than a tab can address) and a *Try anyway* button. Anything else
you drop (`.nsp`, `.xci`, `.nsz`, `.xcz`, a zip, a single code file) is named for what it is, with what to do about
it: nxweb has no keys and opens no encrypted package; convert those to a `.nup` or a folder with the tool you dumped
them with. No game? The demo buttons under the area run self-made test programs.

```
npm install
pip install unicorn capstone     # reference emulator, tests only
npm run web                      # the page above, on http://localhost:8080
npm test                         # needs clang with the aarch64 target and ld.lld
npm run rt:browser               # the same and more in headless Chromium (Playwright)
```
