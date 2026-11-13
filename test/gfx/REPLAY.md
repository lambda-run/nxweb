# Capturing frames of the game and replaying them without it

A graphics fix on the replayer side (`src/glue/gfx_host.ts`, the WGSL it is handed) can be tested in seconds on
frames captured once from the running game, instead of riding the game to the place again.

## 1. Capture (once, in the game)

Add to the page's URL (either page: the replayer reads the flag itself):

    ?gfxcapture=<frames>[@<present>|@draws<n>][&gfxcapto=<receiver>][&gfxcapname=<file>][&gfxcaptex=<MB>]

| form | captures |
|---|---|
| `gfxcapture=3` | 3 frames, from the replayer's next present on |
| `gfxcapture=3@2500` | 3 frames after present number 2500 of this replayer |
| `gfxcapture=3@draws500` | 3 frames, from the first present on whose frame issued at least 500 draws on the replayer (the first 3D area: use this) |

- `gfxcapto`: the log receiver (`vm/ctl/recv.mjs`, port 8082). Default: `?logto=` when the page has it, else
  `http://localhost:8082`. From Chrome on the Mac: `gfxcapto=http://192.168.64.4:8082` (the VM, as for the page driver).
- `gfxcapname`: the file's name under `vm/ctl/reports/` (default `area.gfxcap`).
- `gfxcaptex`: the budget for texture contents in MB (default 2048). Textures past it are captured without their
  texels (blank in the replay) and listed in the end chunk and the log line.

Example: `http://localhost:8080/?ndve=bypass&gfxcapture=3@draws500&gfxcapto=http://192.168.64.4:8082&gfxcapname=area.gfxcap`

The log says `gfxcapture: armed ...`, `gfxcapture: begins after present N ...` and, when the file is complete,
`gfxcapture: 3 frames written to area.gfxcap: ...`. The file is POSTed in pieces of at most 8 MB (`POST /<name>`,
then `POST /append/<name>`), in order; the capture costs time and memory only while it runs.

Where the flag is read: `GfxHost`'s constructor looks at `GfxHostOptions.capture`, else `globalThis.NX_GFXCAPTURE`,
else `location.search` of the page **or worker** it runs in. The AssemblyScript page starts its worker as
`worker.js?<the page's query>`, so nothing else is needed there. A page whose worker has another URL (the Emscripten
page's `em_worker.js`) passes the page's query once: `RtGfx`'s option `capture: <page location.search>`, or
`globalThis.NX_GFXCAPTURE = <page location.search>` in the worker before the replayer is made, or by hand at any
time `host.streamCapture("3@draws500")` (returns a promise of the summary).

## 2. Replay (as often as needed, no game)

    vm/vmrun -t 280 'cd /mnt && NODE_OPTIONS="--import=/ctl/cpfix.mjs --import=/ctl/gfx_pw.mjs" node test/gfx/replay.mts /ctl/reports/area.gfxcap'

(outside the VM: `node test/gfx/replay.mts <file>`; needs playwright's Chromium, as `npm run gfx:test`.) Options:
`--out <dir>` (default `<file>.replay`), `--limits maxStorageBuffersPerShaderStage:8,...` (replay as on a smaller
device, `GfxHostOptions.limits`), `--shaders <dir>` (stages translated again by the current chain: for every shader of
the capture with `<dir>/<key>.wgsl` and `<dir>/<key>.refl.json`, the WGSL, `storage`, `gmem` and `extra` of that
reflection record replace the capture's; `tools/shaders/one.mts --out` writes the WGSL, the record is
`convertStage(...).reflection`. For a change of the shader chain that alters bindings the stream does not name, such as
the mirror of global memory; a draw the recorder skipped stays skipped). It bundles the current `gfx_host.ts`, replays the file in headless Chromium (WebGPU
on SwiftShader) and writes:

| file | what |
|---|---|
| `frame-<n>.png` | each presented image as the replay drew it (level 0 of the presented texture, upright) |
| `frame-<n>.live.png` | the same image as the live run had it when it was captured |
| `errors.txt` | every red line of the replayer and every WebGPU validation error, with counts, most frequent first |
| `replay.log` | the replayer's whole log |
| `summary.json` | adapter, statistics, per frame: size, format, texels that differ from the live image, the frame ledger's line |

and prints the same as text. A frame "identical" to the live image means the replay reproduces the live replayer
exactly (same device class); on another GPU (the Mac's Metal against SwiftShader) some texels differ by rounding.

## What a capture holds, and what a replay can and cannot test

The file is a list of chunks in replay order (`src/glue/gfx_stream_capture.ts`):

- `meta`: host caps, features, the position fix-up, where the recorder's sampler table is;
- `shader`: a shader the frames' pipelines use: key, reflection record, WGSL, vertex-input variants made so far;
- `pipe`: a pipeline made before the capture (its 384-byte key record comes as memory); pipelines requested inside
  the capture are in the batches (`H_PIPELINE_CREATE`);
- `tex`: a texture that was live before the capture and that a batch names: its description, and its texels as the
  GPU held them at that moment (every level and layer; depth as depth; multisampled and 24-bit depth textures have none);
- `batch`: host-stream records (`src/gfx/hostops.ts`) exactly as executed, preceded by the 4 KB pages of guest memory
  they name (vertex, index, uniform, storage, texel sources, key records, sampler table) that changed since they were
  last written;
- `frame`: the presented image of the live run; `end`: totals and the textures captured without contents.

A replay runs the real `GfxHost` on a memory that holds only those pages (laid out in address order, the batches'
addresses rewritten). So it tests **everything the replayer does**: pipeline creation, limits, bind groups, formats,
variants of the WGSL made in the replayer, texture views, mesh draws, clears, copies, presents.

It does **not** re-run the recorder or the shader translator: a draw the recorder skipped when the frames were
captured (`H_SKIP`: shader not translated, no such stage, pipeline failed, a table of the recorder full) is skipped in
the replay too, and the WGSL is the one of the capture. After a fix in `src/gfx` or `src/shaders` that changes what
the recorder emits, capture again. (Draws the *replayer* dropped — a pipeline WebGPU refused, bindings it could not
make — are in the capture in full: fixes for those show in a replay.) A pipeline that failed on the capturing device
was reported to the recorder, which stopped sending its draws from then on: capture early, or expect those draws only
up to that moment.

## Proof without the game

- Scene `stream capture: three frames ...` of `npm run gfx:test` (`test/gfx/scenes9.mts`): a running scene (a texture
  from memory, an offscreen target and a depth buffer that exist only on the GPU, pipelines made before and during,
  uniform data rewritten in place every frame) is captured for three frames and replayed on a second replayer:
  every frame is byte-identical to the live one. The file is kept as `build/gfx/capture/proof.gfxcap`.
- `node test/gfx/replay.mts build/gfx/capture/proof.gfxcap`: the same file through the standalone harness, in another
  browser process: 3 frames, identical, 0 red lines.
- The demo page with the URL flag (`test/gfx/demo.html?gfxcapture=3@20&gfxcapname=demo.gfxcap`), the capture POSTed
  to the receiver, then replayed from `vm/ctl/reports/demo.gfxcap`: 3 frames of 640x400, identical.

## Counting and profiling (no game)

**What a capture holds, counted without a GPU:**

    node test/gfx/capstat.mts <capture> [--json <file>] [--passes]

Per presented frame: batches, render and compute passes, draws (indexed or not, with a count of 0, skipped by the
recorder and why), dispatches, pipeline creations, binds (and how many name what is already bound), the vertex,
index and uniform ranges named (distinct and in all), texel uploads and copies; the draws per kind of pass (named by
its targets' size and format); and how many draws repeat an earlier draw of the frame, by pipeline + vertex ranges +
arguments and, stricter, by the uniform ranges, textures and targets too (a draw repeated in that strict sense is
drawn twice for nothing).

**The replayer's CPU profile** (headless Chromium, SwiftShader: the JavaScript is what is measured):

    /ctl/heavy.sh gfxprof node test/gfx/prof.mts /ctl/reports/area.gfxcap [--frame k] [--n 30] [--spin 20000] [--interval 100] [--notex]

replays the capture up to frame k (default: its last), then executes that frame again and again
(`ReplayOptions.repeat`: memory and the set of textures are put back as the frame found them, its pipeline creations
are left out) and prints: ms per frame inside `GfxHost.exec` (the CPU side up to the submit) and until the GPU is
done, the replayer's own counters per frame, time and count per record type, count / ms / bytes per WebGPU method
(wrappers around the interfaces' prototypes), and CDP's sampling profile (self and total time per function; the time
inside a WebGPU call is the self time of `gpu_<Interface>_<method>`). Everything goes to `<capture>.prof.json`.

**The same on a real GPU**: the page `gfxprof.html` of the web server (`web/gfxprof.ts`, built by `npm run web:build`
and by `test/gfx/prof.mts`; `web/serve.mts` serves the capture from the reports directory in ranges and sends the
page with `Document-Policy: js-profiling`):

    http://localhost:8080/gfxprof.html?cap=area.gfxcap&frame=2&n=30&prof=20000

It shows the same tables as text, with the JS Self-Profiling API's samples (Chrome samples every 10 ms, so `prof` ms
of wall time buy `prof / 10` samples), and POSTs the result to the receiver as `gfxprof-<capture>.json`
(`&to=`, `&name=`; `&notex=1` leaves the textures blank for a quick load: the same CPU work).
