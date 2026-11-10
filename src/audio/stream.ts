// SDK 21's OutputStream on a virtual output device, on top of an AudioOut of the host's own (nxnative
// dm/host/hle_audio.c, "OutputStream"). Each write becomes one 16-bit interleaved block of that output; the free
// count is the capacity less the frames still queued; the stream's event is the output's release event.
import { AudioOutS } from "../kit/gen/tables";
import { red, end, puts, puti, arenaAlloc, arenaFree, eventBind, RATE } from "./base";
import * as out from "./out";
import { Out } from "./out";

export const OS_NONE: u32 = 0, OS_STOPPED: u32 = 1, OS_STARTED: u32 = 2, OS_FLOAT: i32 = 5, OS_PCM16: i32 = 2;

// @ts-ignore: decorator
@unmanaged
class Stream {
  used: u32;
  key: u32;       // the guest's OutputStreamType
  out: u32;       // index of its output
  ch: u32; fmt: i32;
  cap: u32;       // capacity in frames
  queued: u32;    // frames written and not yet played
  nblk: u32;
  store: u32; storeSize: u32;   // block storage: 2 * cap frames, blocks allocated in a ring, freed oldest first
  first: u32; next: u32;        // offsets: the oldest live block, where the next one goes
  fHead: u32; fTail: u32;       // the live blocks' offsets, oldest first: fifo[fHead..fTail)
  // @ts-ignore: decorator
  @inline get fifo(): usize { return changetype<usize>(this) + 64; }
}
const STREAM_SIZE: usize = 64 + 64 * 4;
const STREAMS: usize = memory.data(2560);   // AOMAX * STREAM_SIZE
// @ts-ignore: decorator
@inline function at(i: i32): Stream { return changetype<Stream>(STREAMS + <usize>i * STREAM_SIZE); }
export function find(key: u32): Stream | null {
  for (let i = 0; i < out.AOMAX; i++) { const s = at(i); if (s.used && s.key == key) return s; }
  return null;
}
// @ts-ignore: decorator
@inline export function outOf(s: Stream): Out { return out.outAt(<i32>s.out); }

// The blocks the output played
function reclaim(s: Stream): void {
  const o = outOf(s);
  for (let slot = out.takeReleased(o); slot >= 0; slot = out.takeReleased(o)) {
    s.queued -= load<u32>(o.slot(<u32>slot), 28); s.nblk--; s.fHead++;
    if (s.fHead == s.fTail) { s.first = 0; s.next = 0; } else s.first = load<u32>(s.fifo + (<usize>(s.fHead & 63) << 2));
  }
}
// Total live frames never exceed cap and the store holds 2 * cap, so a block the free count allows always fits
function blockAlloc(s: Stream, n: u32): i32 {
  if (!s.nblk) { s.first = 0; s.next = n; return 0; }
  if (s.next > s.first) {                       // not wrapped: the live blocks are [first, next)
    if (s.next + n <= s.storeSize) { const p = s.next; s.next += n; return <i32>p; }
    if (n <= s.first) { s.next = n; return 0; }
    return -1;
  }
  if (s.next + n <= s.first) { const p = s.next; s.next += n; return <i32>p; }   // wrapped: free space is [next, first)
  return -1;
}

export function open(key: u32, ev: usize, fmtPtr: usize, frames: i32, lr: u64): u32 {
  const f = load<i32>(fmtPtr), ch = load<i32>(fmtPtr, 4), rate = load<i32>(fmtPtr, 8);
  if (f != OS_FLOAT && f != OS_PCM16) { red(); puts("OutputStream sample format "); puti(f); puts(": not supported, the open fails"); end(); return 0x2A2; }
  if (rate && rate != <i32>RATE) { red(); puts("OutputStream sample rate "); puti(rate); puts(": not supported (48 kHz only), the open fails"); end(); return 0x2A2; }
  if (ch <= 0 || ch > 8 || frames <= 0 || frames > 0x100000) return 0x2A2;
  let s: Stream | null = find(key);
  if (s != null) close(key, 0);   // opened twice without a close: the first one goes
  s = null;
  for (let i = 0; i < out.AOMAX && s == null; i++) if (!at(i).used) s = at(i);
  if (s == null) return 0x2A2;
  const size = <u32>frames * <u32>ch * 4;   // 2 * capacity, 16 bit
  const mem = arenaAlloc(size);
  if (!mem) { red(); puts("OutputStream: no arena memory for its blocks, the open fails"); end(); return 0x2A2; }
  const name = memory.data<u8>([79, 117, 116, 112, 117, 116, 83, 116, 114, 101, 97, 109, 0]);
  const o = out.open(0, out.KIND_STREAM, ev ? eventBind(ev, 1) : 0, <u32>ch, name, lr);
  if (o == null) { arenaFree(mem); return 0x2A2; }
  memory.fill(changetype<usize>(s), 0, STREAM_SIZE);
  s.used = 1; s.key = key; s.out = o.index; s.ch = <u32>ch; s.fmt = f; s.cap = <u32>frames; s.store = <u32>mem; s.storeSize = size;
  return 0;
}
export function state(key: u32): u32 {
  const s = find(key);
  return s == null ? OS_NONE : outOf(s).state == AudioOutS.Stopped ? OS_STOPPED : OS_STARTED;
}
export function purge(s: Stream): void {
  reclaim(s);   // the released queue then has room for every pending block
  out.releasePending(outOf(s));
  reclaim(s);
}
export function close(key: u32, lr: u64): void {
  const s = find(key);
  if (s == null) return;
  const o = outOf(s);
  out.stop(o, 0, false);   // every block the output still held comes back as released
  reclaim(s);
  out.close(o, lr);
  arenaFree(<usize>s.store);
  s.used = 0;
}
export function free(s: Stream): i32 {
  reclaim(s);
  const n = s.nblk >= out.QMAX - 1 ? 0 : <i32>s.cap - <i32>s.queued;
  return n < 0 ? 0 : n;
}
export function filled(s: Stream): i32 { reclaim(s); return <i32>s.queued; }

// frames of interleaved samples (L, R, L, R: not planar, nxnative t_output_stream) -> one PCM16 block
export function write(s: Stream, data: usize, frames: i32): i32 {
  if (frames <= 0 || !data) return 0;
  reclaim(s);
  if (s.nblk >= out.QMAX - 1 || <u32>frames > s.cap - s.queued) return 0;   // the game writes only what the free count allows
  const n = <u32>frames * s.ch, off = blockAlloc(s, n * 2);
  if (off < 0) return 0;
  const dst = <usize>s.store + <usize>off;
  if (s.fmt == OS_FLOAT) {
    for (let i: u32 = 0; i < n; i++) {
      const v = load<f32>(data + (<usize>i << 2)) * 32767.0;
      store<i16>(dst + (<usize>i << 1), <i16>(v > 32767.0 ? 32767 : v < -32768.0 ? -32768 : <i32>v));   // NaN plays as 0
    }
  } else memory.copy(dst, data, <usize>n * 2);
  if (!out.append(outOf(s), 0, <u32>dst, n * 2, <u32>frames)) { s.next = <u32>off; return 0; }
  store<u32>(s.fifo + (<usize>(s.fTail++ & 63) << 2), <u32>off);
  if (!s.nblk) s.first = <u32>off;
  s.queued += <u32>frames; s.nblk++;
  return frames;
}
