// The SDK's command list after CommandListProcessor::Process: find the DeviceSink command and hand its input mix
// buffers to the render sink (nxnative dm/host/hle_audren.c: cmd_size .. cmd_walks, and capture's first half).
//
// Command list: header +0x04 command count, +0x08 mix buffer address, +0x14 samples per frame, +0x18 sample rate,
// commands from +0x20. Three header layouts and four DeviceSink layouts exist (nxnative found each with a game):
//   SDK 8-20  +0 magic 0xcafebabe, +4 enabled (u8), +5 command ID (u8), +6 size (s16). DeviceSink: ID 0x13 (0x14 in
//             SDK 20, 0x10 in SDK 8: taken from the one 0x148-byte command with 1 to 6 inputs when the expected ID
//             is absent), 0x148 bytes, +0x130 input count, +0x134 input indices (s16)
//   SDK 6     +0 magic, +4 size (s16), +6 command ID (s16), +0x10 enabled (u8). DeviceSink: ID 0x10, as above
//   SDK 4, 5  the SDK 6 header. DeviceSink: ID 0xf, 0x130 bytes (SDK 4, indices s8) or 0x138 (SDK 5, indices s16),
//             +0x120 input count, +0x124 input indices
//   SDK 21    no magic: +0 enabled (bit 0), +1 command ID (u8), +2 size (s16); every body 8 bytes earlier.
//             DeviceSink: ID 0x14, 0x140 bytes, +0x128 input count, +0x12c input indices
// The header layout is taken from the first list that walks in exactly one of them: a list generated before the
// game's first update may walk in none (a zeroed command) or in more than one, and decides nothing.
// Wire fields are read with unaligned loads (probing the wrong layout can advance by an odd size).
import { red, begin, end, puts, putu, putx, gp, RATE } from "./base";
import * as rsink from "./rsink";

let sinkId: i32 = 0x13;
let hdr6 = false, hdr21 = false, sink4 = false, sink5 = false;
let layoutDone = false, histLogged = false, malformedLogged = false, skippedLogged = false, rateLogged = false;
const SINK_LOGGED: usize = memory.data(4);   // per render sink
const HIST: usize = memory.data(256);        // 64 i32

// render_once: the DeviceSink's ID as the SDK generation gives it, before any list was seen
export function setSinkId(id: i32): void { sinkId = id; }
export function layout(): u32 { return (layoutDone ? 1 : 0) | (hdr6 ? 2 : 0) | (hdr21 ? 4 : 0) | (sink4 ? 8 : 0) | (sink5 ? 16 : 0) | (<u32>sinkId << 8); }
// A new process (the tests): nothing decided
export function reset(): void {
  sinkId = 0x13; hdr6 = hdr21 = sink4 = sink5 = false;
  layoutDone = histLogged = malformedLogged = skippedLogged = rateLogged = false;
  store<u32>(SINK_LOGGED, 0);
}
export function sinkClosed(i: i32): void { if (i >= 0 && i < 4) store<u8>(SINK_LOGGED + i, 0); }

function cmdSize(q: usize): i32 { return <i32>load<i16>(q + (hdr21 ? 2 : hdr6 ? 4 : 6)); }
function cmdId(q: usize): i32 { return hdr21 ? <i32>load<u8>(q, 1) : hdr6 ? <i32>load<i16>(q, 6) : <i32>load<u8>(q, 5); }
function cmdOn(q: usize): bool { return hdr21 ? (load<u8>(q) & 1) != 0 : hdr6 ? load<u8>(q, 0x10) != 0 : load<u8>(q, 4) != 0; }
function cmdOk(q: usize, e: usize): bool {
  const header: usize = hdr21 ? 0x10 : hdr6 ? 0x11 : 8;
  if (q > e || e - q < header) return false;
  if (!hdr21 && load<u32>(q) != 0xcafebabe) return false;
  const n = cmdSize(q);
  return n >= <i32>header && <usize>n <= e - q;
}
// @ts-ignore: decorator
@inline function sinkBody(): i32 { return hdr21 ? -8 : 0; }   // where DeviceSink's fields sit relative to SDK 8-20
function cmdWalks(cl: usize, ncmd: u32, e: usize): bool {
  let q = cl + 0x20;
  for (let i: u32 = 0; i < ncmd; i++) { if (!cmdOk(q, e)) return false; q += <usize>cmdSize(q); }
  return true;
}

// cl: the generated command list, len bytes of it, after Process. dest as rsink.capture: 0 the sink's frame,
// 1 the catch-up queue, 2 nowhere. Returns the frames captured (0: nothing, the frame is silence).
export function capture(sink: i32, dest: i32, cl: usize, len: usize): u32 {
  if (len < 0x20) return 0;
  const ncmd = load<u32>(cl, 4), samples = load<u32>(cl, 0x14), rate = load<u32>(cl, 0x18);
  const mix = gp(load<u64>(cl, 8)), cend = cl + len;
  if (!layoutDone && ncmd) {
    const w16 = cmdWalks(cl, ncmd, cend);
    hdr6 = true; const w6 = cmdWalks(cl, ncmd, cend); hdr6 = false;
    hdr21 = true; const w21 = cmdWalks(cl, ncmd, cend); hdr21 = false;
    const n = (w16 ? 1 : 0) + (w6 ? 1 : 0) + (w21 ? 1 : 0);
    if (n == 1) {
      layoutDone = true;
      if (w6) { hdr6 = true; sinkId = 0x10; begin(); puts("audren: command headers in the SDK 6 layout (+4 size, +6 command ID, +0x10 enabled), DeviceSink is ID 0x10"); end(); }
      if (w21) { hdr21 = true; begin(); puts("audren: command headers in the SDK 21 layout (no magic: +0 enabled, +1 command ID, +2 size), DeviceSink 0x140 bytes"); end(); }
    } else {
      if (!skippedLogged) {
        skippedLogged = true;
        begin(); puts("audren: command list "); putu(ncmd); puts(" commands long walks in "); puts(n ? "more than one" : "no");
        puts(" header layout (generated before the first update?): silent frame, the layout is taken from a later list"); end();
      }
      return 0;
    }
  }
  if (!layoutDone) return 0;
  // A later list can be incomplete too: every command is validated before the one-time sink scan, and no PCM
  // comes from a sink that precedes a malformed tail
  let c = cl + 0x20;
  for (let i: u32 = 0; i < ncmd; i++) {
    if (!cmdOk(c, cend)) {
      if (!malformedLogged) { malformedLogged = true; red(); puts("audren: command "); putu(i); puts(" in the command list is malformed (offset "); putx(c - cl); puts(", list "); putx(len); puts(" bytes)"); end(); }
      return 0;
    }
    c += <usize>cmdSize(c);
  }
  if (!histLogged && ncmd > 4) {   // the first full command list: commands by ID, and the sink ID check
    histLogged = true;
    memory.fill(HIST, 0, 256);
    let cand = -1, ncand = 0, cand4 = -1, ncand4 = 0;
    const sinkSz = 0x148 + sinkBody();
    let q = cl + 0x20;
    for (let i: u32 = 0; i < ncmd; i++) {
      const sz = cmdSize(q), h = HIST + (<usize>(cmdId(q) & 63) << 2);
      store<i32>(h, load<i32>(h) + 1);
      if (sz == sinkSz && load<u32>(q + <usize>(0x130 + sinkBody())) - 1 < 6) { cand = cmdId(q); ncand++; }
      if (hdr6 && (sz == 0x130 || sz == 0x138) && load<u32>(q, 0x120) - 1 < 6) { cand4 = cmdId(q); ncand4++; sink5 = sz == 0x138; }
      q += <usize>sz;
    }
    begin(); puts("audren: first-frame commands "); putu(ncmd); puts(", by command ID:");
    for (let k = 0, shown = 0; k < 64; k++) {
      const n = load<i32>(HIST + (<usize>k << 2));
      if (!n) continue;
      if (++shown > 24) { puts(" ..."); break; }   // the line is bounded (nxnative: 512 bytes)
      puts(" "); putu(k); puts("x"); putu(n);
    }
    end();
    const have = load<i32>(HIST + (<usize>(sinkId & 63) << 2)) != 0;
    if (!have && ncand == 1) {
      begin(); puts("audren: no command with ID "); putx(sinkId); puts(" in the command list; the only 0x148-byte command is ID "); putx(cand); puts(", taking it as DeviceSink"); end();
      sinkId = cand;
    } else if (!have && !ncand && ncand4 == 1) {
      begin(); puts("audren: no command with ID "); putx(sinkId); puts(" in the command list; the only "); putx(sink5 ? 0x138 : 0x130); puts("-byte command is ID "); putx(cand4);
      puts(", taking it as the SDK "); putu(sink5 ? 5 : 4); puts(" DeviceSink"); end();
      sinkId = cand4; sink4 = true;
    } else if (!have) {
      red(); puts("audren: no DeviceSink (ID "); putx(sinkId); puts(") in the command list, "); putu(ncand); puts(" commands of "); putx(sinkSz); puts(" bytes: the game will have no sound"); end();
    }
  }
  c = cl + 0x20;
  for (let i: u32 = 0; i < ncmd; i++) {
    const size = cmdSize(c);
    if (cmdId(c) == sinkId && cmdOn(c)) {
      const b = c + <usize>sinkBody();
      const nin = load<u32>(b + (sink4 ? 0x120 : 0x130));
      const idx = b + (sink4 ? 0x124 : 0x134), idxSize: u32 = sink4 && !sink5 ? 1 : 2;
      if (sink >= 0 && sink < 4 && !load<u8>(SINK_LOGGED + sink)) {
        store<u8>(SINK_LOGGED + sink, 1);
        begin(); puts("audren: DeviceSink inputs "); putu(nin); puts(" rate "); putu(rate); puts(" samples per frame "); putu(samples); puts(" mix buffer "); putx(mix);
        if (rate == 32000) puts(" (32 kHz: resampled to 48 kHz on the host)");
        end();
      }
      if (!nin || samples > (rate == RATE ? rsink.FRAME_MAX : rsink.FRAME_MAX * 2 / 3 - 1)) return 0;
      if (rate != RATE && rate != 32000) {
        if (!rateLogged) { rateLogged = true; red(); puts("audren: renderer sample rate "); putu(rate); puts(" (the SDK takes 32000 or 48000): no sound"); end(); }
        return 0;
      }
      return rsink.capture(sink, dest, mix, samples, rate, idx, nin, idxSize);
    }
    c += <usize>size;
  }
  return 0;
}
