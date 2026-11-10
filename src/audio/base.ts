// Shared by the audio module's files: the embedder's imports, the log line builder, the arena, guest memory access.

// ---- imports (see README.md, "Embedder imports") ----
// @ts-ignore: decorator
@external("env", "log")
declare function envLog(ptr: usize, len: i32): void;
// Bind a guest nn::os::SystemEvent object (address in linear memory) to a kernel event and return a token for it;
// systemEvent == 0 asks for a bare kernel event of the host's own (a render sink's release event). 0 = failed.
// @ts-ignore: decorator
@external("env", "audio_event_bind")
export declare function eventBind(systemEvent: usize, autoClear: i32): u32;
// Signal the kernel event behind a token (the embedder maps it to kernel_event_signal). Never blocks.
// @ts-ignore: decorator
@external("env", "audio_event_signal")
export declare function eventSignal(token: u32): void;
// The host is done with a token it asked for with systemEvent == 0
// @ts-ignore: decorator
@external("env", "audio_event_release")
export declare function eventRelease(token: u32): void;
// Ask the device to run (AudioContext.resume()) / to stop (suspend()). Both return at once; the answer comes back
// through audio_device_state and the ring's callback counter.
// @ts-ignore: decorator
@external("env", "audio_dev_start")
export declare function devStart(): void;
// @ts-ignore: decorator
@external("env", "audio_dev_stop")
export declare function devStop(): void;
// The address of a function of the game's own SDK by its mangled name (the module's own code even where the name
// is taken over), 0 when there is none; and a call of it with x0..x7 from the block, returning x0.
// @ts-ignore: decorator
@external("env", "audio_guest_fn")
declare function envGuestFn(namePtr: usize, nameLen: i32): u64;
// @ts-ignore: decorator
@external("env", "audio_guest_call")
declare function envGuestCall(fn: u64, argsPtr: usize): u64;

// The address of the embedder's render-thread stub: the function the SDK's nn::os::CreateThread is given for an
// audio renderer's render thread. The embedder's host function behind it calls audio_co_enter(x0, x30) on that
// thread and serves the module's requests. 0: the embedder has none (no render thread: red).
// @ts-ignore: decorator
@external("env", "audio_thread_entry")
export declare function threadEntry(): u64;
// A second read end of the kernel event behind a readable handle, as a service's handle copied to its client
// (nxnative hle_dup_readable_handle); 0 if the handle is no read end
// @ts-ignore: decorator
@external("env", "audio_handle_dup")
export declare function handleDup(readable: u32): u32;

export const RES_OK: u32 = 0;
export const RES_FAIL: u32 = 0x2A2;      // nxnative's generic failure
export const RATE: u32 = 48000;
export const NS: u64 = 1000000000;
export const NEVER: u64 = u64.MAX_VALUE;

// ---- log lines, built in a static buffer ----
const LINE: usize = memory.data(512);
const LINE_CAP: i32 = 512;
let lineLen: i32 = 0;
let reds: u32 = 0;

export function putc(c: u8): void { if (lineLen < LINE_CAP) { store<u8>(LINE + <usize>lineLen, c); lineLen++; } }
export function puts(s: string): void { for (let i = 0, n = s.length; i < n; i++) putc(<u8>s.charCodeAt(i)); }
export function putu(v: u64): void { if (v >= 10) putu(v / 10); putc(<u8>(48 + v % 10)); }
export function puti(v: i64): void { if (v < 0) { putc(45); putu(<u64>-v); } else putu(<u64>v); }
export function putx(v: u64): void {
  puts("0x");
  let started = false;
  for (let s = 60; s >= 0; s -= 4) {
    const d = <u8>((v >> s) & 15);
    if (d || started || s == 0) { putc(d < 10 ? 48 + d : 87 + d); started = true; }
  }
}
// A NUL-terminated string in linear memory, at most max bytes
export function putz(p: usize, max: i32): void { for (let i = 0; i < max; i++) { const c = load<u8>(p + i); if (!c) break; putc(c); } }
export function begin(): void { lineLen = 0; }
export function red(): void { lineLen = 0; puts("[RED] "); reds++; }
export function end(): void { envLog(LINE, lineLen); lineLen = 0; }
export function note(s: string): void { begin(); puts(s); end(); }
export function redNote(s: string): void { red(); puts(s); end(); }
export function redTotal(): u32 { return reds; }

// ---- strings for the guest and for imports ----
const NAME: usize = memory.data(256);
// s as ASCII bytes in a scratch buffer (valid until the next call)
function ascii(s: string): usize {
  const n = min(s.length, 255);
  for (let i = 0; i < n; i++) store<u8>(NAME + i, <u8>s.charCodeAt(i));
  store<u8>(NAME + n, 0);
  return NAME;
}
export function guestFn(name: string): u64 { return envGuestFn(ascii(name), min(name.length, 255)); }
// Write s into a guest field of `size` bytes, zero-filled (strlcpy after memset)
export function fillName(dst: usize, s: string, size: usize): void {
  memory.fill(dst, 0, size);
  for (let i = 0, n = min(<usize>s.length, size - 1); i < <i32>n; i++) store<u8>(dst + i, <u8>s.charCodeAt(i));
}

// ---- guest calls ----
const GARGS: usize = memory.data(64);
export function guestCall(fn: u64, a0: u64 = 0, a1: u64 = 0, a2: u64 = 0, a3: u64 = 0, a4: u64 = 0, a5: u64 = 0, a6: u64 = 0, a7: u64 = 0): u64 {
  store<u64>(GARGS, a0); store<u64>(GARGS, a1, 8); store<u64>(GARGS, a2, 16); store<u64>(GARGS, a3, 24);
  store<u64>(GARGS, a4, 32); store<u64>(GARGS, a5, 40); store<u64>(GARGS, a6, 48); store<u64>(GARGS, a7, 56);
  return envGuestCall(fn, GARGS);
}

// A guest address as an index into linear memory. A 32-bit memory: the contract wraps 64-bit guest addresses to 32
// bits; a 64-bit memory: the whole value
// @ts-ignore: decorator
@inline export function gp(a: u64): usize { return sizeof<usize>() == 8 ? <usize>a : <usize>(a & 0xFFFFFFFF); }

// ---- arena: OutputStream block storage, Opus managers. First fit over a list of blocks that covers the range ----
// Block header (16 bytes): +0 u32 size with the header (a multiple of 16), +4 u32 1 = in use
let aBase: usize = 0, aEnd: usize = 0;
export function arenaInit(base: usize, len: usize): void {
  aBase = (base + 15) & ~15; aEnd = (base + len) & ~15;
  if (aEnd < aBase + 32) { aBase = aEnd = 0; return; }
  store<u32>(aBase, <u32>(aEnd - aBase)); store<u32>(aBase, 0, 4);
}
export function arenaAlloc(n: usize): usize {
  const need = (n + 31) & ~15;
  for (let p = aBase; p < aEnd; p += load<u32>(p)) {
    if (load<u32>(p, 4)) continue;
    for (let q = p + load<u32>(p); q < aEnd && !load<u32>(q, 4); q = p + load<u32>(p)) store<u32>(p, load<u32>(p) + load<u32>(q));   // merge the free blocks behind it
    const size = <usize>load<u32>(p);
    if (size < need) continue;
    if (size - need >= 32) { store<u32>(p + need, <u32>(size - need)); store<u32>(p + need, 0, 4); store<u32>(p, <u32>need); }
    store<u32>(p, 1, 4);
    memory.fill(p + 16, 0, <usize>load<u32>(p) - 16);
    return p + 16;
  }
  return 0;
}
export function arenaFree(ptr: usize): void { if (ptr) store<u32>(ptr - 16, 0, 4); }
export function arenaUsed(): usize {
  let n: usize = 0;
  for (let p = aBase; p < aEnd; p += load<u32>(p)) if (load<u32>(p, 4)) n += load<u32>(p);
  return n;
}
export function arenaSize(): usize { return aEnd - aBase; }
