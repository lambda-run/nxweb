# audio: nn::audio and nn::codec

Port of nxnative `dm/host/hle_audio.c` (AudioOut, AudioIn, SDK 21's OutputStream and input streams), the sink and
timing part of `hle_audren.c` (the audio renderer runs the game's own SDK code; the host supplies where a frame goes
and when the next is due) and `hle_codec.c` (hardware Opus decoders). The entries of nxnative
`docs/reference/audio.md` are the requirements; the tests name the entry they cover.

Logic is AssemblyScript (`build/audio/audio.wasm`, 62 KB, `--runtime stub`, no allocation outside the arena it is
given). The device is TypeScript glue. Nothing in the module reads a clock, calls a browser API or blocks.

| File | What |
|---|---|
| `index.ts` | The module's exports |
| `names.ts` | Generated (`npm run audio:names`): the 118 mangled names nxnative takes over in the three files, `Fn.<x>` = nxnative's `h_<x>` |
| `calls.ts` | `audio_lookup`, `audio_call`: what each name does |
| `out.ts` | AudioOut: outputs, buffer queues, the `audio_out` and `audio_buf` machines, the silent sink, the guards |
| `dev.ts` | The inputs: the two clocks, the device's reported state, the ring header |
| `mix.ts` | PCM16 to stereo f32, volume, downmix, the mix of up to 8 outputs, the resampler, the pacing against the device |
| `stream.ts` | SDK 21's OutputStream on an output of the host's own |
| `rsink.ts` | The audio renderer's sink: block pool, pacing, catch-up queue, DeviceSink capture, 3:2 upsampler, the service's work buffer budget |
| `opus.ts` | The Opus decoder manager (`opus_req` machine) and the forwards of the synchronous decoders to the SDK |
| `defs/*.json` | The three machines (diagrams: `docs/machines/audio_out.md`, `audio_buf.md`, `opus_req.md`) |
| `src/glue/audio_host.ts` | Instantiation, imports, the argument block of a call. No browser or Node API |
| `src/glue/audio_device.ts` | The device, runtime side (usually a Worker): transports of the ring, device reports |
| `src/glue/audio_device_main.ts` | The device, page side: AudioContext, AudioWorkletNode, gesture, visibility |
| `src/glue/audio_worklet.ts` | The AudioWorklet processor (source text for `addModule`) |
| `src/glue/audio_opus_webcodecs.ts` | An Opus decoder for the manager on WebCodecs' AudioDecoder |

```
npm run audio:test [-- <filter>]     # Node, no device: a fake device the tests drive (55 tests)
npm run audio:browser [-- <filter>]  # headless Chromium (Playwright): real AudioContext and AudioWorklet (10 tests, about 50 s)
npm run audio:build                  # build/audio/audio.wasm with a memory of its own
npm run audio:names                  # regenerate names.ts from the nxnative clone
npm run kit:test                     # includes test/audio/audio.machine.test.mts
```

## API (the module's exports)

**Setup.** `audio_init(arenaBase, arenaLen)` once: the arena holds OutputStream blocks (2 x capacity per stream),
Opus managers ((I/O buffers + 16) x 17.7 KB each) and software decoder states. `audio_static_end()` for the embedder's
range check. `audio_scratch()`: 1024 bytes the embedder may use for a name or an argument block.

**Take-overs.** `audio_lookup(namePtr)` gives the id (1..118) of a mangled name, 0 for any other. Every name of the
three nxnative files resolves. `audio_call(fnId, argsPtr)` makes the call. The block, 144 bytes:

| Offset | |
|---|---|
| +0 | x0..x7 as the guest passed them |
| +64 | the low 64 bits of v0..v7 (a `float` argument is the low 32 bits of its register) |
| +128 | x8 (functions that return a struct in memory: the two `...Statistics`) |
| +136 | x30, the call site, for the log (0: unknown) |

The result says where the function's result is: `0` none, `1` x0 (written to +0), `3` x0 and x1 (+0, +8:
`GetInputStreamFormat` returns 12 bytes in registers), `4` a float in v0 (bits at +64: the three volume / gain getters).
The first 8 words are the layout the runtime already builds for NVN calls (`rt_nvn_args`). A call never blocks and
never answers "pending": a guest thread that waits for a buffer waits on its event in the kernel.

**Time.** `audio_tick(guestNs, hostNs)` is the module's only notion of time: the silent sinks consume up to `guestNs`
(the guest clock), the device watchdog and the retry timers run on `hostNs` (any monotonic host clock), the mixer
fills the device ring. It must be called before an `audio_call` whenever time has moved, and at least every 100 ms of
host time while a device is attached (every slice is better: the ring's lead covers the longest gap between two
ticks). `audio_next_deadline()` is the guest time at which a silent sink releases its next buffer: an embedder with a
deterministic clock ends its slice there. `audio_set_catchup_limit(ns)` is for an embedder whose guest clock is a wall
clock (see "Silent sink").

**Device.** `audio_device_attach(rate, targetFrames)`, `audio_device_state(0 idle | 1 starting | 2 running | 3 failed |
4 lost)`, `audio_ring_ptr() / audio_ring_data() / audio_ring_cap()`, `audio_suspend(1 | 0)` for a hidden / visible
page. See "The device".

**Audio renderer sink.** `audio_rs_*`, see "Audio renderer". **Opus.** `audio_opus_backend`, `audio_opus_out`,
`audio_opus_complete`, see "Opus".

**Report and tests.** `audio_fn_count / audio_fn_name / audio_fn_is_stub`, `audio_out_state(slot)`,
`audio_out_stat(slot, which)` (id, pending, released, appended, released total, taken back, signals, underruns, bytes
of silence, bytes consumed, ...), `audio_buf_state(slot, n)`, `audio_out_machine()`, `audio_mixed_frames()`,
`audio_resample(src, n, dst, rate)`, `audio_red_total()`, `audio_arena_used()`, and the kit's exports.

## Embedder imports (`env`)

| Import | What the embedder does |
|---|---|
| `log(ptr, len)` | A log line (UTF-8). Red lines start with `[RED] ` |
| `audio_event_bind(systemEvent, autoClear) -> token` | Bind the guest `nn::os::SystemEvent` at that address to a kernel event (nxnative `hle_bind_system_event`) and return a token for it, 0 on failure. `systemEvent == 0`: a bare kernel event of the host's own (the render sink's two events) |
| `audio_event_signal(token)` | `kernel_event_signal` on the event behind the token. Called from inside `audio_call` / `audio_tick`: it must not block and must not call back into the module |
| `audio_event_release(token)` | The module will not signal this token again (the output, stream, sink or manager closed) |
| `audio_dev_start()`, `audio_dev_stop()` | Ask the device to run / to stop. Both return at once; the answer comes through `audio_device_state` and the ring's callback counter |
| `audio_guest_fn(namePtr, len) -> u64` | The address of a function of the game's SDK by mangled name: the module's own code even where the name is taken over; 0 when there is none |
| `audio_guest_call(fn, argsPtr) -> u64` | Call it with x0..x7 from the block, return x0. Used for the SDK's software Opus decoders, `GetAudioRendererWorkBufferSize` and `UpsamplerManager::Allocate` |
| `audio_opus_open(dec, rate, ch)`, `audio_opus_decode(dec, req, in, len, out, cap)`, `audio_opus_reset(dec)`, `audio_opus_close(dec)` | The embedder's own Opus decoder for the manager; see "Opus" |

## The machines

### `audio_out`: who consumes an output's queue

nxnative holds this in `state` (started / stopped), `backend` (none / AudioUnit / silent sink), `start_phase` (idle /
starting / cancelled / waiting for a callback), `stalled`, `retry_ms`, `retry_at`, `hold_device` and the global
`g_suspended`. Here it is one machine per output:

| State | Consumer | Guest-visible | Carries |
|---|---|---|---|
| `Stopped` | nobody | Stopped | |
| `SilentStarting` | silent sink | Started | when the attempt began (host µs) and the backoff reached |
| `Live` | the device mixer | Started | |
| `SilentRetry` | silent sink | Started | when the next attempt is due and its backoff (1, 2, 4, 8 s) |
| `Suspended` | silent sink | Started | |

The guest-visible state (`GetAudioOutState`, OutputStream's 1 / 2) is derived: Stopped in `Stopped`, Started in
the four others. Events and the guard (`out.ts guard`, once per tick and output) that offers each:

| Event | From -> to | When |
|---|---|---|
| `Start` / `StartHidden` | Stopped -> SilentStarting / Suspended | `StartAudioOut`; the page is visible / hidden. `audio_dev_start` is called |
| `DeviceCallback` | SilentStarting -> Live | the device is running and its callback counter moved after the attempt began |
| `StartFailed` | SilentStarting -> SilentRetry | the device reported failed or lost |
| `StartTimeout` | SilentStarting -> SilentRetry | the device has been running for 1 s since the attempt and has not called back |
| `Stall` | Live -> SilentRetry | no callback for 200 ms |
| `DeviceLost` | Live -> SilentRetry | the device is no longer reported running (the browser suspended, interrupted or closed the context) |
| `RetryDue` | SilentRetry -> SilentStarting | the time the state carries has come; `audio_dev_start` again |
| `Suspend` / `Resume` | the three device states -> Suspended -> SilentStarting | `audio_suspend(1 / 0)` |
| `Stop` | any started state -> Stopped | `StopAudioOut`, Close; every pending buffer is released |

A context that waits for a user gesture reports "starting" and the output stays in `SilentStarting` for as long as
it takes (no timeout runs while the device is not running); with no device attached (Node, a browser without
AudioContext) it stays there for good. Both are the "blocked audio device start" of the reference: the game is paced
by the silent sink and never waits for the device. Reaching `Live` or `Stopped` forgets the backoff; only the first
failure of a run of failures is a red line.

The watchdog's clock is host time that does not advance over a gap of more than 200 ms between two ticks, so a
frozen page or a late tick is not taken for a device that stopped (nxnative: a late wake-up of the watchdog restarts
its count). What the guards read besides the instance (the device's state and when it was reported, when the callback
counter last moved) are observations in `dev.ts`, written in one place per tick; they are inputs, not state.

### `audio_buf`: one buffer slot

`Reclaimed` (the slot holds nothing) `-Append->` `Appended` `-Play->` `Playing` `-Finish->` `Released` `-Reclaim->`
`Reclaimed`. `Flush` leaves `Appended` and `Playing` for `Released` (a Stop or a purge returns unplayed and partly
played buffers); `Drop` is a Close with released buffers nobody took. A buffer is released exactly once because only
`Finish` and `Flush` enter `Released` and neither leaves it. An output has 128 slots: 64 pending
(`AppendAudioOutBuffer` answers false beyond) and 64 released.

One output has one pending queue and one position in its head buffer, whoever consumes. A change of consumer is a
transition of `audio_out` and touches neither, so a handover cannot lose or repeat a buffer.

### `opus_req`: one decode request

`Free -Enqueue-> Waiting -Execute-> Executing -Complete-> Completed -Dequeue-> Free`; `Cancel` (a reset or finalize of
the decoder) frees a waiting or completed request; a request an asynchronous decoder still holds is `Abandon`ed and
its slot is free again only when the decoder answers.

## Silent sink

While an output is not `Live` its buffers are consumed at exactly 48000 frames per second of the guest clock: frame
count = floor((guest time - epoch) x 48000 / 1e9), re-based by whole seconds, so there is no drift (tested: buffer
200,000 of 5 ms comes back at exactly 1000 s). A buffer is released in the tick in which its last frame is consumed;
`audio_next_deadline()` is that time to the nanosecond. nxnative's sink pulls 5 ms every 5 ms on a host thread; this
one is sample exact, which is what a deterministic clock needs and is also what the hardware does on average.

nxnative's sink does not make up more than 100 ms (the process was suspended; making it up released every buffer at
once). The guest clock here only runs with the guest, so a jump is real guest time and is made up by default. An
embedder whose guest clock is a wall clock sets `audio_set_catchup_limit(100 ms)` and gets nxnative's rule.

## The release event: nxnative's two flags, and why they are gone

nxnative releases a buffer on the audio device's real-time thread, which must not take locks, so a notifier thread
signals the guest's event; `notify_pending` and `notify_armed` make sure the notifier is not asleep with work pending
(the race of the reference entry "AudioOut release notification can sleep with pending work"). Here releases happen
on the thread that runs the guest, inside `audio_tick` or `audio_call`, and signalling a kernel event is a plain call.
So: **every entry into the module in which an output released at least one buffer signals that output's event once,
after the buffers are in the released queue, before the entry returns.** There is no window in which a release is
visible and its signal is not on its way. The property test checks it per operation (a release without a signal, or a
signal without a release, fails) and from the game's side (a game that takes buffers back only when woken never has
released buffers waiting with its event clear); nxnative's fixture, 100,000 buffers reclaimed one by one by an
event-driven game, runs on the silent sink and on the device.

## The device

One AudioContext serves all outputs (nxnative has an AudioUnit per output and lets the sound card mix): the module
mixes the `Live` outputs and writes interleaved stereo f32 at the device rate into one ring.

**Ring** (`dev.ts`): 8192 frames in the module's static memory, and a header of 8 u32: `wr`, `rd`, `cap`, `underrun`
(frames the device played as silence because the ring was empty), `callbacks`, `live` (outputs playing: with 0 an
empty ring is not an underrun), `rate`, `target`. The module writes `wr` and frames; the device side writes `rd`,
`underrun`, `callbacks`. In a build with `--enable threads` the counters are atomics.

**Pacing** (`mix.ts pump`): the ring is kept `target` frames (40 ms by default) ahead of the device, so what is mixed
per tick is what the device took since the last tick: the device's clock consumes the game's buffers, as a device
callback does in nxnative. The lead is silence written once when the first output goes Live. After a late tick the
outputs are asked only for what they have queued (a renderer keeps 20 ms in flight) and the rest follows as the game
refills, so the ring's lead absorbs the lateness, not the game's queue. Only when the ring is down to a quarter of its
lead is silence mixed for what an output lacks; that is the output's underrun and is counted on it.

**Format**: PCM16 in. The output's volume is applied to the PCM16, saturating, as the audout session does. Six
channels are downmixed with the renderer's Q15 coefficients (front 1, center 0.707, LFE 0.251, back 0.707); mono goes
to both sides. OutputStream's float frames become PCM16 blocks as in nxnative (x 32767, clamped, NaN = 0).

**Resampler**: 48 kHz to the device rate as a polyphase windowed sinc (32 taps, Kaiser beta 8.6, cutoff 0.96 of the
lower Nyquist, one filter per phase: 147 phases for 44.1 kHz), a copy at 48 kHz. Up to 640 phases are kept, which
covers every standard rate; any other is resampled at the nearest ratio with a red line.

**Glue.** An AudioContext exists only on the main thread; the runtime is in a Worker. `AudioDeviceMain` (page) owns
the context and the worklet node; `AudioDevice` (runtime side) implements `audio_dev_start/stop` and feeds the
worklet. They exchange messages tagged `{ audio: ... }` over the embedder's channel (`open`, `start`, `stop` one way;
`open` with the rate, `state`, `hidden` the other). Transports, chosen by what exists:

| Transport | When | How |
|---|---|---|
| `direct` | the process memory is a SharedArrayBuffer | the worklet reads the module's ring in place |
| `sab` | cross-origin isolated, process memory not shared (the runtime today) | a SharedArrayBuffer ring of the device's own; each tick copies what the module wrote and reads back `rd`, `underrun`, `callbacks` |
| `message` | no SharedArrayBuffer | frames go to the worklet over a MessageChannel of its own (Worker to audio thread, not through the page); the worklet reports `rd`, `callbacks`, `underrun` every second quantum |

The context is created at 48000 Hz by default (the browser resamples to the hardware; the module's resampler is then
a copy); `sampleRate: 0` takes the hardware rate and the module resamples. `resume()` is asked and "starting"
reported at once; the context runs when the browser allows it. `AudioDeviceMain` listens for `pointerdown`, `keydown`
and `touchend` and resumes a context that waits. A context that is not wanted is suspended (where autoplay is
allowed a new context runs at once). `visibilitychange` becomes `audio_suspend`.

## Audio renderer

nxnative does not implement a renderer: it switches the game's `AudioRendererParameter` to CPU rendering with manual
execution, calls the SDK's own `OpenAudioRenderer`, and drives the SDK's `ExecuteAudioRendererRendering` from a guest
thread. What the host takes over is (1) the work buffer size and the open / close, (2) a render thread paced by a PCM
output, (3) `AudioRendererImpl::` / `AudioRenderSystem::ExecuteAudioRendererRendering`, where it generates commands
under the SDK's update lock, runs `CommandListProcessor` and takes the DeviceSink's mix buffers as the output,
(4) `AudioRenderSystem::Update`, which renders a catch-up frame when none was rendered since the last update.

**Here, implemented and tested** (with a stand-in for the SDK's renderer):

- The sink (`audio_rs_*`): an output of the host's own with 4 blocks in flight, so one render per 5 ms block handed
  back; the frame of a render that produced nothing is 5 ms of silence. `audio_rs_ready` (is a block free; else wait
  on `audio_rs_event`, at most 10 ms), `audio_rs_next` (plays a queued catch-up frame in place of a render, or says
  "render now"), `audio_rs_capture(sink, dest, mix, samples, rate, idx, nIn, idxSize)` (the DeviceSink's int32 mix
  buffers to stereo PCM16: 6 -> 2 downmix, clamp, 32 kHz upsampled 3:2 with nxnative's `up_3_2`; `idxSize` 1 for SDK
  4's byte indices), `audio_rs_rendered`, `audio_rs_count_render`.
- The catch-up rule: `audio_rs_update_begin(sink, waited)` answers 0 (go on), 1 (render a catch-up frame into the
  queue), 2 (the queue of 4 is full: wait on `audio_rs_cq_event`, at most 50 ms, and ask again), 3 (still full: render
  and discard); `audio_rs_update_end`. A queued frame signals the catch-up event only, never the game's renderer event.
- Up to 4 renderers, each with its own blocks, queue and upsampler history.
- `GetAudioRendererWorkBufferSize`: the DSP service's budget through revision 15 (`ar_service_work_size`), checked
  against nxnative's fixtures from Horizon's own sizing routine; a revision or device the model does not cover goes
  to the SDK's own function with the CPU / manual copy of the parameter.
- `UpsamplerManager::Allocate`: null manager -> no upsampler; else the SDK's own.
- The device name, channel count, volume, auto-tune and notification calls.

**Not implemented: six names resolve, log one red line each and fail**: `OpenAudioRenderer` (both forms),
`CloseAudioRenderer`, the two `ExecuteAudioRendererRendering` take-overs, `AudioRenderSystem::Update`. They are the
part that runs SDK code and need things the runtime does not have yet: a guest thread started by the host whose body
is host code (the render loop), nested guest calls that may block (the SDK's update lock), `guest_sym` for a name that
is itself taken over, system events bound and re-attached (`ar_open`'s renderer event), and reading the SDK's code
(the update lock's offset, the `AudioRenderSystem` offset, the PLT). Also not ported: the command list walk that
finds the DeviceSink (`capture`'s first half: header layouts of SDK 4 to 21, the sink scan); it is pure and can be
ported with nxnative's `t_audren_layout` fixtures when the rest exists. Until then a game that uses the audio
renderer has no sound and, if it does not tolerate a failed open, does not start. None of this can be tested here:
there is no SDK module in the tree.

## Opus

The synchronous interfaces (`HardwareOpusDecoder` / `HardwareOpusMultiStreamDecoder` classes, their C interfaces)
are forwarded to the SDK's software decoders with a host-held state per game object, as nxnative does. They are
complete as far as this module goes and tested against a fake SDK (every argument of every forward); they need
`audio_guest_fn` / `audio_guest_call` and a game whose SDK carries the software decoder.

SDK 21's **decoder manager** is ported: the request machine, a FIFO per decoder, the I/O buffer count (a request
holds one from Enqueue to Dequeue), the waiting / executing / completed counts, the event, nxnative's answers
(0x3a6f for "not now", a refused packet completes as 20 ms of silence). **Decision on who decodes: a backend, two of
them, chosen per decoder** (`audio_opus_backend`: 0 automatic, 1 SDK, 2 embedder):

1. *The SDK's software `OpusDecoder`* (`DecodeOpusInterleaved` through `audio_guest_call`), inside
   `ExecuteHardwareOpusDecoderDecoding`. nxnative's choice: bit exact with what the game expects, no codec of ours.
   The automatic choice when the SDK has it. Tested here with a stand-in for the SDK function only.
2. *The embedder's decoder* (`audio_opus_*` imports), which may answer inside the call or later. Provided:
   `audio_opus_webcodecs.ts` on WebCodecs' `AudioDecoder`, asynchronous. Tested in Chromium end to end: a tone encoded
   by the browser's `AudioEncoder` goes through Enqueue / Execute / event / Dequeue and comes back at 440.00 Hz,
   44.5 dB against the original. The manager's interface is asynchronous by design (that is what the executing count
   and the event are for), so this needs no parking of a guest thread.

Not done: a C Opus decoder compiled to wasm. It would only be needed for a game that uses the *synchronous* hardware
interface and whose SDK lacks the software decoder, in a browser; no such game is known (nxnative has none either).
The synchronous interface cannot use WebCodecs without parking the calling thread, which the runtime can do
(`cpu.waitFor`) but this module does not ask for. WebCodecs caveats: it needs a secure context; the final range in
Nintendo's header is not checked; frames are assumed to be answered in the order they were given.

## Verified

`npm run audio:test`: **55 tests, 0 failed; 31 of 31 transitions of `audio_buf`, `audio_out`, `opus_req` taken by
the module** (the run fails otherwise).

- Names: `names.ts` against the three nxnative files (118 = 64 + 22 + 32); every name resolves, others do not; every
  id answers; the six stubs log red once each.
- Silent sink: 5 ms buffers back at exactly +5, +10, +15, +20 ms, nothing one nanosecond early; sample-exact times
  for odd sizes; 200,000 buffers with no drift; a late tick; the catch-up limit.
- Every transition of `audio_out` and `audio_buf` through the module with the fake device: gesture wait of 5 s, first
  callback, stall after 200 ms, retries after 1, 2, 4, 8, 8 s, a refused start, a start with no callback, the browser
  taking the device, hide / show, Start while hidden, Stop from every state.
- Handover silent -> live -> stall -> silent -> retry -> live -> hidden -> shown -> live with numbered frames: the
  device hears consecutive frames, never one twice; device frames + sink frames = bytes consumed; every buffer back
  once, in order; no underrun on either side; the stall is not noticed before 200 ms; a 30 s freeze is no stall.
- Reference scenarios, by entry: a blocked device start (Start returns, 400 buffers in 2 s, Stop / hide / show /
  Close meanwhile, a second output on its own); a device that reports success and never calls back; the notifier race
  (100,000 buffers, on the sink and on the device); a polling game across a stall; a background round trip with a
  10 s freeze; buffer count; device names, volume, the notification names and their 0x499; no audio input; no
  virtual input devices; `OpenAudioOut` without an event; OutputStream (interleaved order, clamp, free count, purge,
  states 0 / 1 / 2, 24-byte statistics with the canary intact, gain, `StartOutputStreams`, 14 open / close rounds
  leaving nothing behind).
- Resampler, a sine in and SNR out: 48 -> 44.1 kHz 113.5 / 101.7 / 100.7 / 100.3 / 98.9 / 99.4 dB at 100 / 440 / 1000
  / 5000 / 10000 / 15000 Hz; 1 kHz to 96 / 88.2 / 32 / 22.05 / 192 kHz 90.2 / 95.4 / 95.3 / 107.2 / 91.7 dB; unity
  gain; 48 kHz a copy. End to end through a 44.1 kHz device: 92.3 dB, amplitude 0.49999 of 0.5.
- Mix: bit-exact PCM16 at 48 kHz; two stereo outputs, a mono and a six-channel one together with the right levels;
  per-output volume; 8 outputs summed and limited; a starved output underruns alone; a tick 32 ms late with 20 ms
  queued leaves no gap; a game that stops appending is silent only once the ring is down to a quarter of its lead.
- Property: 400 seeded sequences of 600 random operations with the invariants after each (26,084 buffers round):
  each buffer released exactly once and in order; a signal exactly when an entry released something; the
  event-driven game is never stranded; queues, slot machines and guest-visible state agree; no refused transition.
  Tried by hand, each caught: a wake-up lost on every 7th release, a Stop that releases without a signal, a Stop of
  a stopped output that flushes. A wake-up lost on every 97th release is too rare for these sequences and is caught
  by the 100,000-buffer test ("the game sleeps for good" after 97 buffers).
- Render sink: one render per 5 ms at exact guest times; frames in order on a device; silence frames keep the pace;
  the catch-up rule with a full queue; capture (clamp, 6 -> 2, one input, byte indices); 3:2 upsampler 84.8 dB; four
  renderers with separate blocks; the work size fixtures.
- Opus: the manager with the SDK stand-in, a synchronous and an asynchronous embedder decoder (abandon on reset,
  late answers, generations); every forward of the synchronous interfaces.

`npm run audio:browser`: **10 tests** (Chromium 153, full build, headless; the worklet records what it puts out; the
figures are those of one run). With `--autoplay-policy=no-user-gesture-required`: a 440 Hz tone for 5 s, 5 ms
buffers, four in flight, refilled on the release event, over each transport (`direct` on a shared memory, `sab`,
`message` on a page without COOP / COEP) and on a 44.1 kHz context: 440.00 Hz by zero crossings, 92.2 dB against a
fitted sine over the whole 5 s (92.3 dB at 44.1 kHz), no gap, no jump beyond the tone's slope, 0 underruns of the
output and of the device, about 1009 buffers; a polling game with 10 ms buffers; the game not appending for 300 ms
(265 ms of silence, counted on the output, device underrun 0, tone again); the run loop away for 300 ms (the device
counts 261 ms of underrun, no stall, output underruns 0, no buffer lost); hidden / shown, then `ctx.suspend()` behind
the device's back (`Suspended`, `SilentRetry`, retry 1004 ms later, `Live`; 200.3 buffers per second throughout);
Opus through WebCodecs. Without the flag (the default policy; the page runs by itself because a DevTools evaluation
counts as a gesture): the context stays suspended, the output is `SilentStarting`, 300 buffers come back at 201.0
per second on the silent sink with nothing mixed; a real click, `Live` 21 ms later, 1.97 s of clean tone.
`build/audio/tone.wav` is the first run's recording.

These tests run in real time. Of four full runs on the development machine (4 cores, other test suites running
beside them) three passed 10 of 10 and one 9 of 10: in the gesture case the device ran dry for 512 frames right
after going Live (headless Chromium's device takes 512 frames every 10.7 ms, so the 40 ms lead is 29 ms at its
lowest, and the Worker's 4 ms timer came more than that late). In three more runs of that case alone, one failed on
an underrun of the test's own guest (20 ms in flight, a timer 20 ms late) while the output was on the silent sink.
The runner therefore runs a failed case once more and prints both outcomes (`SECOND ATTEMPT, the first failed: ...`,
and a count in the summary; `AUDIO_BROWSER_RETRIES=0` turns it off).

`npm run kit:test`: the three machines' tables (every transition, every refusal) in `test/audio/audio.machine.test.mts`.

## Attaching to the runtime (not done here: these are the runtime owner's)

1. Two ranges of the process memory: static data (1 MB is ample; `asc --importMemory --zeroFilledMemory --memoryBase`)
   and the arena (16 MB covers two Opus managers of 255 and 160 I/O buffers; a game without them needs a few hundred
   KB). On a shared memory add `--sharedMemory --enable threads`.
2. `audio_lookup(name)` for the names a module imports or defines; a hit is a forced take-over (nxnative's
   `HLE_FORCE`: it wins over the SDK's own definition) whose handler fills the
   argument block (x0..x7, v0..v7, x8, x30), calls `audio_tick(guest ns, host ns)` and `audio_call`, and writes x0,
   x1 or v0 back as the result says. A float result needs v0 written back, which the runtime does not do yet.
3. `audio_tick` at the end of every slice; slices and idle jumps end at `audio_next_deadline()` on the deterministic
   clock (as for the `at` of an outside wait); `audio_set_catchup_limit` on the wall clock.
4. `audio_event_bind`: nn::os system events (nxnative `hle_bind_system_event`) belong to the nn::os take-overs.
5. The page hosts `AudioDeviceMain` and passes `{ audio }` messages both ways.
6. The module is single threaded: with guest cores on several Workers its entries need one lock.

## Gaps

- The audio renderer's SDK-driving half is not implemented (above); nothing of the renderer was run with an SDK.
- Nothing here was run with a game or with the runtime: the guest in every test is the test.
- Opus with a real SDK decoder is untested; multi-stream Opus has no decoder of ours behind it (SDK forwards only).
- One device for all outputs: a stall or a loss moves every Live output to the silent sink at once. Frames that were
  in the ring at that moment (up to the lead) are played when the device comes back, before the new ones.
- Latency is the ring's lead (40 ms by default) plus the browser's own; it is the price of mixing on the run loop's
  thread and not on the audio thread. A smaller lead needs ticks closer together.
- A tick more than the lead late makes the device run dry (counted, tested); more than 200 ms of host time without a
  callback while ticks arrive is a stall. A Worker whose timers are throttled to more than 100 ms would hit both.
- Output channel counts other than 1, 2 and 6 play their first two channels (red line). Rates other than 48 kHz are
  refused at open, as in nxnative (which dies).
- nxnative's `DM_AUDIO_DUMP`, `DM_AUDIO_MUTE` and the periodic `audio #N device callbacks` log line are not ported;
  the numbers are in `audio_out_stat` and the ring header. The call site in the log is a raw address.
- Media-services reset (`dm_audio_reset`) has no browser counterpart beyond `DeviceLost`; a device change (another
  output device, another rate) is not handled: the context keeps its rate.
- `test/audio/browser.mts` runs Chromium only. Safari and Firefox differ in autoplay and in `interrupted` states.
- The browser tests depend on real time: on a machine too loaded to tick within 40 ms the gap-free checks can fail.
