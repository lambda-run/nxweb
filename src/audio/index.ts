// The audio module's entry file: what the embedder calls. See README.md.
export * from "../kit/exports";
import { arenaInit, arenaUsed, arenaSize, redTotal, NEVER } from "./base";
import { FN_COUNT, NAMES } from "./names";
import { AUDIO_OUT } from "../kit/gen/tables";
import * as dev from "./dev";
import * as out from "./out";
import * as mix from "./mix";
import * as calls from "./calls";
import * as rsink from "./rsink";
import * as opus from "./opus";
import * as ren from "./ren";
import * as cmdlist from "./cmdlist";

// Give the module its arena: [base, base + len) of linear memory, for OutputStream blocks, Opus managers and
// software decoder states. Call once, before anything else.
export function audio_init(arenaBase: usize, arenaLen: usize): void { arenaInit(arenaBase, arenaLen); }
// The end of the module's static data (the embedder checks it against the range it gave the module)
export function audio_static_end(): usize { return __heap_base; }

// ---- the take-over functions ----
// The id of a mangled nn::audio / nn::codec name (NUL-terminated in linear memory), 0 when the module does not take it over
export function audio_lookup(namePtr: usize): u32 { return calls.lookup(namePtr); }
// One guest call. argsPtr: a block of 144 bytes, little endian:
//   +0    x0..x7 as the guest passed them
//   +64   the low 64 bits of v0..v7 (a float argument is the low 32 bits of its register)
//   +128  x8 (where a function that returns a struct in memory writes it)
//   +136  x30, the call site, for the log (0: unknown)
// The result says where the function's result is: 0 none (void), 1 x0 (written to +0), 3 x0 and x1 (+0, +8),
// 4 a float in v0 (its bits at +64, the upper 32 bits zero), 16 the call goes on (an audio renderer take-over that
// runs SDK code: see audio_co_req below; the embedder names the calling thread with audio_co_thread first). Nothing
// in here blocks: a call returns at once, and a guest thread that waits for a buffer waits on its event in the kernel.
// Time: audio_tick with the current clocks must come first whenever time has moved.
export function audio_call(fnId: u32, argsPtr: usize): i32 { const r = calls.call(fnId, argsPtr); out.flushSignals(); return r; }

// ---- time ----
// guestNs: the guest clock; hostNs: any monotonic host clock (performance.now() * 1e6). Consumes for the silent
// sinks up to guestNs, runs the device watchdog on hostNs, fills the device ring. At least every 100 ms of host time
// while a device is attached; the more often, the smaller the device ring's target can be.
export function audio_tick(guestNs: u64, hostNs: u64): void {
  dev.setTime(guestNs, hostNs);
  dev.observe();
  for (let i = 0; i < out.AOMAX; i++) {
    const o = out.outAt(i);
    if (!o.used) continue;
    if (out.isSilent(o.state)) out.sinkAdvance(o);
    out.guard(o);
  }
  mix.pump();
  out.flushSignals();
}
// The guest time at which a silent sink releases its next buffer (u64 max: none is due). An embedder with a
// deterministic clock ends its slice there and ticks, so the buffer comes back at exactly that time.
export function audio_next_deadline(): u64 {
  let t = NEVER;
  for (let i = 0; i < out.AOMAX; i++) { const o = out.outAt(i); if (o.used) t = min(t, out.sinkDeadline(o)); }
  return t;
}
// Only for an embedder whose guest clock is a wall clock: a jump of more than ns between two ticks is not made up
// by the silent sink (0, the default: every jump is made up, which is right for a clock that only runs with the guest)
export function audio_set_catchup_limit(ns: u64): void { out.setCatchupLimit(ns); }

// ---- the device ----
// A device exists: its sample rate and how many frames the mixer keeps ahead of it (0: 40 ms). rate 0 detaches.
export function audio_device_attach(rate: u32, targetFrames: u32): void { dev.attach(rate, targetFrames); }
// What the device reports: 0 idle, 1 starting (an AudioContext waiting for a user gesture stays here), 2 running,
// 3 the start failed, 4 lost (suspended, interrupted or closed by the browser while it ran)
export function audio_device_state(state: u32): void { dev.setState(<u8>state); }
// The ring's header (see dev.ts) and its frames: interleaved stereo f32, capacity audio_ring_cap() frames
export function audio_ring_ptr(): usize { return dev.RING; }
export function audio_ring_data(): usize { return dev.RING_DATA; }
export function audio_ring_cap(): u32 { return dev.RING_CAP; }
// The page was hidden (1) or is visible again (0)
export function audio_suspend(on: i32): void { out.suspend(on != 0); out.flushSignals(); }

// ---- the audio renderer's sink (see rsink.ts and README.md) ----
export function audio_rs_open(): i32 { const r = rsink.open(); out.flushSignals(); return r; }
export function audio_rs_close(i: i32): void { rsink.close(i); out.flushSignals(); }
export function audio_rs_event(i: i32): u32 { return rsink.releaseEvent(i); }
export function audio_rs_cq_event(i: i32): u32 { return rsink.cqEvent(i); }
export function audio_rs_ready(i: i32): i32 { return rsink.ready(i); }
export function audio_rs_next(i: i32): i32 { return rsink.next(i); }
export function audio_rs_capture(i: i32, dest: i32, mixPtr: usize, samples: u32, rate: u32, idxPtr: usize, nIn: u32, idxSize: u32): u32 { return rsink.capture(i, dest, mixPtr, samples, rate, idxPtr, nIn, idxSize); }
export function audio_rs_count_render(i: i32): void { rsink.countRender(i); }
export function audio_rs_rendered(i: i32): void { rsink.rendered(i); }
export function audio_rs_update_begin(i: i32, waited: i32): i32 { return rsink.updateBegin(i, waited); }
export function audio_rs_update_end(i: i32): void { rsink.updateEnd(i); }
export function audio_rs_stat(i: i32, which: i32): u64 { return rsink.stat(i, which); }
export function audio_rs_out(i: i32): i32 { return rsink.outIndex(i); }

// ---- the audio renderer: take-overs that run SDK code on the calling guest thread (see ren.ts and README.md) ----
// The guest thread the next audio_call / audio_co_resume / audio_co_enter is made on (any number that names it)
export function audio_co_thread(thread: u32): void { ren.setThread(thread); }
// audio_call answered 16: the call goes on. The request block (96 bytes): +0 u32 kind (2 CALL, 3 WAIT on an event
// token); CALL: +8 the SDK function, +24 x0..x7: run it on the calling thread as ordinary
// guest code and come back with its x0 and x1; WAIT: +8 the token, +16 the timeout in ns:
// come back with x0 = 0 when it was signalled, 1 otherwise.
export function audio_co_req(): usize { return ren.reqPtr(); }
// The thread came back. 16: another request. 0 / 1: the take-over is over (1: with a result, at +8 of the request
// block) and returns to the address at +88.
export function audio_co_resume(x0: u64, x1: u64): i32 { const r = ren.resume(x0, x1); out.flushSignals(); return r; }
// A render thread has called the embedder's stub (env.audio_thread_entry) with x0 = arg and x30 = lr. 16: a
// request; 0: the stub returns to its caller (the thread is not wanted, or it ran before: then +88 is 0).
export function audio_co_enter(arg: u32, lr: u64): i32 { const r = ren.threadEnter(<i32>arg, lr); out.flushSignals(); return r; }
// which: 0 the audio_ren state of renderer i (0..3), 1 its audio_ren_thread state, 2 its render sink (-1: none),
// 3 the renderer object, 4 its AudioRenderSystem, 5 its thread's ThreadType
export function audio_ren_stat(i: i32, which: i32): u64 { return ren.stat(i, which); }
export function audio_ren_frames(): i32 { return ren.frames(); }
// The DeviceSink of a command list by itself (tests): as the render does after CommandListProcessor::Process
export function audio_ren_capture(sink: i32, dest: i32, cl: usize, len: usize): u32 { return cmdlist.capture(sink, dest, cl, len); }
// bit 0 the header layout is decided, 1 SDK 6 headers, 2 SDK 21 headers, 3 SDK 4 / 5 sink, 4 SDK 5 sink; bits 8.. the sink's ID
export function audio_ren_layout(): u32 { return cmdlist.layout(); }
export function audio_ren_sink_id(id: i32): void { cmdlist.setSinkId(id); }
export function audio_ren_probe_lock(guess: u64): u64 { return ren.probeLock(guess); }
// The stereo PCM16 block the sink last gave its output (tests, a recorder): its address and frames
export function audio_rs_played_ptr(i: i32): usize { return rsink.playedPtr(i); }
export function audio_rs_played_frames(i: i32): u32 { return rsink.playedFrames(i); }

// ---- Opus: the embedder's decoder ----
// 0 automatic (the SDK's software decoder when the SDK has one, else the embedder's), 1 the SDK's, 2 the embedder's
export function audio_opus_backend(b: i32): void { opus.setBackend(b); }
// An asynchronous decode is done: where the PCM of request `req` goes (0: the request is gone, write nothing) ...
export function audio_opus_out(req: u32): usize { return opus.reqOut(req); }
// ... and then: samples per channel, <= 0 for a failure (the frame completes as 20 ms of silence)
export function audio_opus_complete(req: u32, samples: i32): void { opus.reqComplete(req, samples); }
export function audio_opus_stat(mgr: i32, which: i32): u32 { return opus.mgrStat(mgr, which); }

// ---- for the embedder's report and the tests ----
export function audio_fn_count(): u32 { return FN_COUNT; }
// The name of function id (1..audio_fn_count) as UTF-16 code units at the returned pointer; its length in audio_fn_name_len
export function audio_fn_name(id: u32): usize { return id >= 1 && id <= FN_COUNT ? changetype<usize>(unchecked(NAMES[id - 1])) : 0; }
export function audio_fn_name_len(id: u32): i32 { return id >= 1 && id <= FN_COUNT ? unchecked(NAMES[id - 1]).length : 0; }
export function audio_fn_is_stub(id: u32): i32 { return calls.isStub(id) ? 1 : 0; }
export function audio_red_total(): u32 { return redTotal(); }
export function audio_arena_used(): usize { return arenaUsed(); }
export function audio_arena_size(): usize { return arenaSize(); }
export function audio_out_max(): i32 { return out.AOMAX; }
// The kit's machine id of audio_out in this build (for reading the kit trace)
export function audio_out_machine(): u32 { return AUDIO_OUT; }
// One output by slot (0..audio_out_max): -1 when the slot is free, else its audio_out state
export function audio_out_state(i: i32): i32 { return i >= 0 && i < out.AOMAX && out.outAt(i).used ? out.outAt(i).state : -1; }
// which: 0 id, 1 pending buffers, 2 released and not taken back, 3 appended, 4 released, 5 taken back, 6 event
// signals, 7 underruns, 8 bytes of silence, 9 bytes consumed, 10 frames the sink did not make up, 11 the state's
// data, 12 channels, 13 the guest object, 14 position in the head buffer
export function audio_out_stat(i: i32, which: i32): u64 {
  if (i < 0 || i >= out.AOMAX || !out.outAt(i).used) return 0;
  const o = out.outAt(i);
  switch (which) {
    case 0: return o.id; case 1: return o.pending; case 2: return o.releasedCount; case 3: return o.appended; case 4: return o.released;
    case 5: return o.reclaimed; case 6: return o.signals; case 7: return o.underN; case 8: return o.underB; case 9: return o.consumed;
    case 10: return o.skipped; case 11: return o.inst.data; case 12: return o.ch; case 13: return o.key; case 14: return o.pos;
  }
  return 0;
}
// The state of a buffer slot of an output (the audio_buf machine)
export function audio_buf_state(i: i32, slot: u32): i32 { return i >= 0 && i < out.AOMAX && slot < 128 ? <i32>load<u8>(out.outAt(i).slot(slot)) : -1; }
export function audio_mixed_frames(): u64 { return mix.mixed(); }
// Resampler on its own (tests): n stereo f32 frames at 48 kHz from src to dst at outRate; returns the frames written
export function audio_resample(src: usize, n: u32, dst: usize, outRate: u32): u32 { return mix.resampleTest(src, n, dst, outRate); }
// 1024 bytes the embedder may use between calls: the argument block of a call it builds itself, a name for audio_lookup
const SCRATCH: usize = memory.data(1024);
export function audio_scratch(): usize { return SCRATCH; }
