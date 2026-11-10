// The audio renderer's SDK-driving half (nxnative dm/host/hle_audren.c: ar_open, h_ar_Close, render_main,
// render_once, ar_exec, h_ars_Update, update_lock, impl_sys_off). nxnative has no renderer of its own: it opens the
// SDK's renderer for CPU rendering with manual execution, runs ExecuteAudioRendererRendering on a guest thread of
// the host's, and takes the DeviceSink's samples out of the command list. The same here.
//
// What is different is how the SDK's code gets run. In nxnative a take-over is a C function on the guest thread's
// own stack: it calls the SDK and the call may block (the update lock) or take as long as it takes. Here a
// take-over cannot be suspended in the middle, so each of them is a *frame* with explicit steps. A step ends in a
// request to the embedder (audio_co_req):
//   CALL   run this SDK function on the calling guest thread, as ordinary guest code that may block or be
//          preempted, and come back with x0 / x1 (audio_co_resume)
//   WAIT   let the thread wait for an event of the module's (a token), with a timeout
// or in the take-over's result. Frames are per guest thread and nest (the render thread's loop calls the SDK's
// ExecuteAudioRendererRendering, which calls the take-over of AudioRendererImpl's, which calls GenerateCommand).
// The render thread is made the way nxnative's dm_guest_thread_spawn makes it: the SDK's malloc for its stack and
// nn::os::CreateThread / StartThread, with the embedder's stub as its function; its body is threadLoop below.
// The steps of each frame are kit machines: audio_ren, audio_ren_thread, audio_render, audio_ren_update.
import { Inst } from "../kit/machine";
import { AUDIO_REN, AudioRenS, AudioRenE, AUDIO_REN_THREAD, AudioRenThreadS, AudioRenThreadE, AUDIO_RENDER, AudioRenderS, AudioRenderE,
  AUDIO_REN_UPDATE, AudioRenUpdateS, AudioRenUpdateE } from "../kit/gen/tables";
import { Fn, NAMES } from "./names";
import { red, begin, end, puts, putu, putx, puti, eventBind, eventSignal, eventRelease, guestFn, guestCall, gp, arenaAlloc, arenaFree, threadEntry, handleDup,
  RES_OK, RES_FAIL } from "./base";
import * as rsink from "./rsink";
import * as cmdlist from "./cmdlist";

export const RET_CO: i32 = 16;     // the call goes on: a request is in the request block
const REQ_DONE: u32 = 0, REQ_CALL: u32 = 2, REQ_WAIT: u32 = 3;
// The request block: +0 u32 kind; CALL: +8 the function, +24 x0..x7; WAIT: +8 the event token, +16 the timeout in
// ns; when a frame is done: +8 its result (x0), +88 the address the take-over returns to (0: to its caller, it
// never went on)
const REQ: usize = memory.data(96);
export function reqPtr(): usize { return REQ; }
const MS: u64 = 1000000;
const STACK: u64 = 0x10000, PRIO: u64 = 9;   // the render thread's, as nxnative's
const CREATE_THREAD = "_ZN2nn2os12CreateThreadEPNS0_10ThreadTypeEPFvPvES3_S3_mi", START_THREAD = "_ZN2nn2os11StartThreadEPNS0_10ThreadTypeE";
const WAIT_THREAD = "_ZN2nn2os10WaitThreadEPNS0_10ThreadTypeE", DESTROY_THREAD = "_ZN2nn2os13DestroyThreadEPNS0_10ThreadTypeE";

const P_DEVICE: usize = 0x2c, P_MODE: usize = 0x30, P_SIZE: usize = 0x40;
const WORK_PAGE: u64 = 0x1000;
const RES_NOT_MANUAL: u32 = 0x40299;   // the SDK's own answer to a manual render of a renderer that is not CPU + manual

// ---- frames ----
const K_OPEN: u8 = 1, K_PASS: u8 = 2, K_CLOSE: u8 = 3, K_THREAD: u8 = 4, K_EXEC: u8 = 5, K_UPDATE: u8 = 6;
// @ts-ignore: decorator
@unmanaged
class Frame {
  used: u8; kind: u8; dest: u8; ret: u8;   // ret: 1 the take-over returns a value
  thread: u32;
  lr: u64;
  ren: i32;
  depth: u32;
  a0: u64; a1: u64; a2: u64; a3: u64; a4: u64; a5: u64; a6: u64;
  v0: u64; v1: u64; v2: u64;
  // @ts-ignore: decorator
  @inline get render(): Inst { return Inst.at(changetype<usize>(this) + 104); }
  // @ts-ignore: decorator
  @inline get update(): Inst { return Inst.at(changetype<usize>(this) + 120); }
  // @ts-ignore: decorator
  @inline get param(): usize { return changetype<usize>(this) + 136; }   // P_SIZE bytes
}
const FRAME_SIZE: usize = 208, NFRAME: i32 = 16;
const FRAMES: usize = memory.data(3328);
// @ts-ignore: decorator
@inline function frameAt(i: i32): Frame { return changetype<Frame>(FRAMES + <usize>i * FRAME_SIZE); }
// @ts-ignore: decorator
@inline function frameIndex(f: Frame): i32 { return <i32>((changetype<usize>(f) - FRAMES) / FRAME_SIZE); }
let cur: u32 = 0;   // the calling guest thread, as the embedder names it
export function setThread(t: u32): void { cur = t; }
function top(): Frame | null {
  let best: Frame | null = null;
  for (let i = 0; i < NFRAME; i++) { const f = frameAt(i); if (f.used && f.thread == cur && (best == null || f.depth > best.depth)) best = f; }
  return best;
}
function inOpen(): bool {   // nxnative's t_in_open: this thread is inside the SDK's OpenAudioRenderer the host called
  for (let i = 0; i < NFRAME; i++) { const f = frameAt(i); if (f.used && f.thread == cur && f.kind == K_OPEN) return true; }
  return false;
}
function push(kind: u8, lr: u64, ret: u8): Frame | null {
  const t = top();
  for (let i = 0; i < NFRAME; i++) {
    const f = frameAt(i);
    if (f.used) continue;
    memory.fill(changetype<usize>(f), 0, FRAME_SIZE);
    f.used = 1; f.kind = kind; f.ret = ret; f.thread = cur; f.lr = lr; f.ren = -1; f.depth = t == null ? 0 : t.depth + 1;
    f.render.init(AUDIO_RENDER, <u32>i); f.update.init(AUDIO_REN_UPDATE, <u32>i);
    return f;
  }
  red(); puts("audren: "); putu(NFRAME); puts(" renderer calls in progress at once: this one fails"); end();
  return null;
}
export function frames(): i32 { let n = 0; for (let i = 0; i < NFRAME; i++) if (frameAt(i).used) n++; return n; }

function call(fn: u64, a0: u64 = 0, a1: u64 = 0, a2: u64 = 0, a3: u64 = 0, a4: u64 = 0, a5: u64 = 0, a6: u64 = 0): i32 {
  store<u32>(REQ, REQ_CALL); store<u64>(REQ, fn, 8);
  store<u64>(REQ, a0, 24); store<u64>(REQ, a1, 32); store<u64>(REQ, a2, 40); store<u64>(REQ, a3, 48);
  store<u64>(REQ, a4, 56); store<u64>(REQ, a5, 64); store<u64>(REQ, a6, 72); store<u64>(REQ, 0, 80);
  return RET_CO;
}
function wait(token: u32, ns: u64): i32 { store<u32>(REQ, REQ_WAIT); store<u64>(REQ, <u64>token, 8); store<u64>(REQ, ns, 16); return RET_CO; }
function done(f: Frame, v: u64): i32 {
  store<u32>(REQ, REQ_DONE); store<u64>(REQ, v, 8); store<u64>(REQ, f.lr, 88);
  const kind = f.ret ? 1 : 0;
  f.used = 0;
  return kind;
}
// A take-over that ends without ever having had a frame
function plain(v: u64, ret: bool): i32 { store<u32>(REQ, REQ_DONE); store<u64>(REQ, v, 8); store<u64>(REQ, 0, 88); return ret ? 1 : 0; }

// ---- the renderers ----
export const AR_MAX: i32 = 4;
// @ts-ignore: decorator
@unmanaged
class Ren {
  h0: u64; h1: u64;   // AudioRendererHandle (renderer object, client state)
  sys: u64;           // its AudioRenderSystem, from its first render or update (renOfSys)
  sink: i32;          // its render sink (rsink.ts), -1: none
  thread: u32;        // the render thread's ThreadType (0x200 bytes of the arena), 0: none
  stack: u64;         // what the SDK's malloc gave for its stack
  // @ts-ignore: decorator
  @inline get inst(): Inst { return Inst.at(changetype<usize>(this) + 40); }
  // @ts-ignore: decorator
  @inline get tinst(): Inst { return Inst.at(changetype<usize>(this) + 56); }
}
const REN_SIZE: usize = 72;
const RENS: usize = memory.data(288);
let rensInit = false;
function renAt(i: i32): Ren {
  if (!rensInit) {
    rensInit = true;
    for (let k = 0; k < AR_MAX; k++) { const r = changetype<Ren>(RENS + <usize>k * REN_SIZE); r.sink = -1; r.inst.init(AUDIO_REN, <u32>k); r.tinst.init(AUDIO_REN_THREAD, <u32>k); }
  }
  return changetype<Ren>(RENS + <usize>i * REN_SIZE);
}
// @ts-ignore: decorator
@inline function renIndex(r: Ren): i32 { return <i32>((changetype<usize>(r) - RENS) / REN_SIZE); }
// The renderer an AudioRenderSystem belongs to, for the SDK's calls that name only that. A system not seen yet
// belongs to the one open renderer whose system is not known: the render thread names its system at its first
// render, right after the open, and a game's first updates can come before that
function renOfSys(sys: u64): Ren | null {
  let found: Ren | null = null, unknown: Ren | null = null, nunknown = 0;
  for (let i = 0; i < AR_MAX && found == null; i++) {
    const r = renAt(i);
    if (r.inst.state < AudioRenS.StackAlloc || r.inst.state > AudioRenS.Stopping) continue;   // open: its SDK open has returned, its close has not begun
    if (r.sys == sys) found = r;
    else if (!r.sys) { unknown = r; nunknown++; }
  }
  if (found == null && nunknown == 1) { found = unknown; found!.sys = sys; }
  return found;
}
// For the embedder's report and the tests. which: 0 the audio_ren state, 1 the audio_ren_thread state, 2 the sink,
// 3 the object, 4 the AudioRenderSystem, 5 the thread's ThreadType
export function stat(i: i32, which: i32): u64 {
  if (i < 0 || i >= AR_MAX) return 0;
  const r = renAt(i);
  return which == 0 ? r.inst.state : which == 1 ? r.tinst.state : which == 2 ? <u64><i64>r.sink : which == 3 ? r.h0 : which == 4 ? r.sys : r.thread;
}

// ---- the renderer's own events (nxnative g_rev) ----
// Every SDK's DSP open keeps no pointer to the game's SystemEventType; the CPU + manual open the host substitutes
// stores the object and ExecuteAudioRendererRendering signals it after every render, so the game's object would
// have to outlive the renderer, which Horizon never asks of it (nxnative: a game passes one on its stack). The SDK
// gets one of these instead, alive until Close; it becomes a kernel event (auto-clear: a kernel event wakes every
// waiter, a local one only the first), and the game's object gets a copy of its readable handle.
const NREV: i32 = 4;
const REV: usize = memory.data(64);   // per slot: +0 u64 the renderer it belongs to (0 free, 1 taken), +8 u32 its memory, +12 u32 the binding's token
function revTake(): usize {
  for (let i = 0; i < NREV; i++) {
    const p = REV + (<usize>i << 4);
    if (load<u64>(p)) continue;
    let m = <usize>load<u32>(p, 8);
    if (!m) { m = arenaAlloc(0x80); if (!m) return 0; store<u32>(p, <u32>m, 8); }
    memory.fill(m, 0, 0x80);
    store<u64>(p, 1); store<u32>(p, 0, 12);
    return m;
  }
  return 0;
}
function revSlot(m: usize): usize { for (let i = 0; i < NREV; i++) { const p = REV + (<usize>i << 4); if (m && <usize>load<u32>(p, 8) == m) return p; } return 0; }
function revSet(m: usize, obj: u64): void { const p = revSlot(m); if (p) store<u64>(p, obj); }
function revFind(obj: u64): usize { for (let i = 0; i < NREV; i++) { const p = REV + (<usize>i << 4); if (obj > 1 && load<u64>(p) == obj) return <usize>load<u32>(p, 8); } return 0; }

// ---- work buffers the host supplies (nxnative objmap_put(handle[0], owned)) ----
const NOWNED: i32 = 8;
const OWNED: usize = memory.data(128);   // +0 u64 the renderer, +8 u32 the arena block
function ownedPut(obj: u64, raw: usize): void { for (let i = 0; i < NOWNED; i++) { const p = OWNED + (<usize>i << 4); if (!load<u32>(p, 8)) { store<u64>(p, obj); store<u32>(p, <u32>raw, 8); return; } } }
function ownedDel(obj: u64): usize { for (let i = 0; i < NOWNED; i++) { const p = OWNED + (<usize>i << 4); if (load<u32>(p, 8) && load<u64>(p) == obj) { const raw = <usize>load<u32>(p, 8); store<u32>(p, 0, 8); return raw; } } return 0; }

// ---- red lines, once each ----
const ONCE: usize = memory.data(16);
function once(k: i32): bool { if (load<u8>(ONCE + k)) return false; store<u8>(ONCE + k, 1); return true; }
function missing(k: i32, name: string): void { if (once(k)) { red(); puts("audren: missing SDK symbol "); puts(name); end(); } }

// ---- reading the SDK's code ----
// @ts-ignore: decorator
@inline function codeOk(a: usize, bytes: usize): bool { return a != 0 && (a & 3) == 0 && <u64>a + bytes <= <u64>memory.size() << 16; }
const OS_LOCK = "_ZN2nn2os9LockMutexEPNS0_9MutexTypeE", OS_UNLOCK = "_ZN2nn2os11UnlockMutexEPNS0_9MutexTypeE";
const SDK_LOCK = "_ZN2nn2os12SdkMutexType4LockEv", SDK_UNLOCK = "_ZN2nn2os12SdkMutexType6UnlockEv";
// adrp x16, page; ldr x17, [x16, #off]; ...; br x17 -> the function the GOT slot holds; else the address itself
function pltTarget(pc: u64): u64 {
  const p = gp(pc);
  if (!codeOk(p, 8)) return pc;
  const a = load<u32>(p), l = load<u32>(p, 4);
  if ((a & 0x9f00001f) != 0x90000010 || (l & 0xffc003ff) != 0xf9400211) return pc;
  const imm = <i64>(<u64>((((a >> 5) & 0x7ffff) << 2) | ((a >> 29) & 3)) << 43) >> 31;   // immhi:immlo, sign-extended, x 4 KB
  const slot = gp((pc & ~<u64>0xfff) + <u64>imm + <u64>(((l >> 10) & 0xfff) * 8));
  return codeOk(slot & ~<usize>3, 8) ? load<u64>(slot) : pc;
}
const ADD: usize = memory.data(256);   // 32 i64
let muOff: u64 = 0, osMutex = false;
// The update lock is read off the SDK's own code: Update (before SDK 19) or UpdateImpl (from SDK 19) takes it
// first. The prologue copies `this`, adds the offset into a register and moves it to x0 before the first bl, a PLT
// stub whose GOT slot the loader bound to nn::os::LockMutex or SdkMutexType::Lock (or a straight bl to it)
function lockIn(fn: string): bool {
  const f = gp(guestFn(fn));
  const lockMutex = guestFn(OS_LOCK), sdkLock = guestFn(SDK_LOCK);
  if (!codeOk(f, 96)) return false;
  let self: u32 = 1, x0: i64 = -1;
  for (let r = 0; r < 32; r++) store<i64>(ADD + (<usize>r << 3), -1);
  for (let i = 0; i < 24; i++) {
    const w = load<u32>(f + (<usize>i << 2)), rd = w & 31, rn = (w >> 5) & 31, rm = (w >> 16) & 31;
    if ((w & 0xffe0ffe0) == 0xaa0003e0) {   // mov xd, xm
      if ((self >> rm) & 1) self |= <u32>1 << rd;
      const v = load<i64>(ADD + (<usize>rm << 3));
      if (rd == 0) x0 = v; else store<i64>(ADD + (<usize>rd << 3), v);
    } else if ((w & 0xffc00000) == 0x91000000 && rn != 31 && ((self >> rn) & 1)) {   // add xd, x<this>, #imm12
      const v = <i64>((w >> 10) & 0xfff);
      store<i64>(ADD + (<usize>rd << 3), v);
      if (rd == 0) x0 = v;
    } else if ((w & 0xfc000000) == 0x94000000) {   // the first bl
      const t = pltTarget(<u64>f + <u64>(<i64>i + <i64>(<i32>(w << 6) >> 6)) * 4);
      if (x0 < 0 || !t || (t != lockMutex && t != sdkLock)) return false;
      muOff = <u64>x0; osMutex = t == lockMutex;
      return true;
    }
  }
  return false;
}
// The tests: read the update lock with `guess` as what is kept on a miss. bits 0..31 the offset, 32 nn::os::MutexType, 33 read off the code
export function probeLock(guess: u64): u64 { muOff = guess; osMutex = false; const ok = updateLock(); return muOff | (osMutex ? <u64>1 << 32 : 0) | (ok ? <u64>1 << 33 : 0); }
const UPDATE_IMPL = "_ZN2nn5audio6server17AudioRenderSystem10UpdateImplEPvmS3_mPKvm";
function updateLock(): bool {
  if (lockIn(unchecked(NAMES[Fn.ars_Update - 1])) || lockIn(UPDATE_IMPL)) return true;
  red(); puts("audren: no update lock read off AudioRenderSystem::Update or UpdateImpl: keeping +"); putx(muOff); puts(", where command generation may race the game's RequestUpdate"); end();
  return false;
}
// Where the AudioRenderSystem sits inside AudioRendererImpl, read off the SDK's own ExecuteAudioRendererRendering:
// its prologue adds the offset to `this` (x0) before the first branch. Anything not found keeps +0x60
let implOff: u64 = 0, implFound = false;
function implSysOff(): u64 {
  if (implFound) return implOff;
  implFound = true; implOff = 0x60;
  const f = gp(guestFn(unchecked(NAMES[Fn.ar_ImplExec - 1])));
  if (codeOk(f, 64)) for (let i = 0; i < 16; i++) {
    const w = load<u32>(f + (<usize>i << 2));
    if ((w & 0xffc003e0) == 0x91000000) { implOff = (w >> 10) & 0xfff; break; }   // add xd, x0, #imm12
    if ((w & 0x7c000000) == 0x14000000) break;                                      // b / bl: no offset before the first branch
  }
  begin(); puts("audren: AudioRenderSystem at +"); putx(implOff); puts(" in AudioRendererImpl"); end();
  return implOff;
}

// ---- one render (render_once) ----
// The layout of the SDK's AudioRenderSystem. SDK 16: member functions for mode / device / command buffer, and
// GenerateCommand(void*, size_t) returns the list's length. SDK 20: those are inlined (+0x48 rendering device,
// +0x4c execution mode, +0xf8 / +0x100 command buffer start / length) and GenerateCommand takes a Span<std::byte>
// and returns one (x0 start, x1 length); recognized by the presence of the Span version.
let rState: i32 = 0;   // 0 not looked up, 1 ready, -1 the SDK lacks a function
let fGen20: u64 = 0, fMode: u64 = 0, fDevice: u64 = 0, fCbuf: u64 = 0, fCbsz: u64 = 0, fGen: u64 = 0;
let fLock: u64 = 0, fUnlock: u64 = 0, fTmax: u64 = 0, fSetup: u64 = 0, fProcess: u64 = 0;
let proc: usize = 0;          // the CommandListProcessor (0x58 bytes; 0x60 in SDK 21): one, renders are serialized
let renderOwner: i32 = 0;     // the frame that is rendering, + 1 (nxnative's g_render_mu: the callers share one command buffer)
let renderEvent: u32 = 0;     // signalled when a render ends: a queued render takes its turn
function need(name: string): u64 { const f = guestFn(name); if (!f) { rState = -1; red(); puts("audren: missing SDK symbol "); puts(name); end(); } return f; }
function renderInit(): bool {
  if (rState) return rState > 0;
  rState = 1;
  fGen20 = guestFn("_ZN2nn5audio6server17AudioRenderSystem15GenerateCommandENS_4SpanISt4byteEE");
  if (!fGen20) {
    fMode = need("_ZNK2nn5audio6server17AudioRenderSystem16GetExecutionModeEv"); fDevice = need("_ZNK2nn5audio6server17AudioRenderSystem18GetRenderingDeviceEv");
    fCbuf = need("_ZNK2nn5audio6server17AudioRenderSystem26GetCommandBufferWorkBufferEv"); fCbsz = need("_ZNK2nn5audio6server17AudioRenderSystem30GetCommandBufferWorkBufferSizeEv");
    fGen = need("_ZN2nn5audio6server17AudioRenderSystem15GenerateCommandEPvm");
  }
  muOff = fGen20 ? 0x2d0 : 0x1f0; osMutex = false;
  cmdlist.setSinkId(fGen20 ? 0x14 : 0x13);
  // SdkMutexType is looked up only when the SDK uses it: SDK 3.5.1 has none
  if (updateLock() && osMutex) { fLock = need(OS_LOCK); fUnlock = need(OS_UNLOCK); }
  else { fLock = need(SDK_LOCK); fUnlock = need(SDK_UNLOCK); }
  fTmax = need("_ZN2nn5audio3dsp20CommandListProcessor17SetProcessTimeMaxEj"); fSetup = need("_ZN2nn5audio3dsp20CommandListProcessor5SetupEPKvm");
  fProcess = need("_ZN2nn5audio3dsp20CommandListProcessor7ProcessEv");
  if (rState > 0) { proc = arenaAlloc(0x80); if (!proc) { rState = -1; red(); puts("audren: no memory for the command list processor"); end(); } }
  if (rState < 0) return false;
  renderEvent = eventBind(0, 1);
  begin(); puts("audren: AudioRenderSystem in the SDK "); puts(fGen20 ? "20" : "16"); puts(" layout (update lock "); puts(osMutex ? "nn::os::MutexType" : "SdkMutexType"); puts(" at +"); putx(muOff); puts(")"); end();
  return true;
}
// Both return RET_CO while the render goes on, and -1 when it is over with its Result in f.v2. f.a0: the
// AudioRenderSystem; f.ren: the renderer; f.dest: where the frame goes (rsink.capture)
function renderLock(f: Frame): i32 { renderOwner = frameIndex(f) + 1; return call(fLock, f.a0 + muOff); }
function renderStart(f: Frame): i32 {
  if (!renderInit()) { f.v2 = RES_FAIL; return -1; }
  const sys = f.a0, s = gp(sys);
  const md = fGen20 ? load<i32>(s, 0x4c) : <i32>guestCall(fMode, sys), dv = fGen20 ? load<i32>(s, 0x48) : <i32>guestCall(fDevice, sys);
  if (md != 1 || dv != 1) { f.v2 = RES_NOT_MANUAL; return -1; }   // same as the original: manual rendering needs CPU + manual mode
  if (renderOwner) { f.render.step(AudioRenderE.Busy); return wait(renderEvent, 5 * MS); }
  f.render.step(AudioRenderE.Begin);
  return renderLock(f);
}
function renderResume(f: Frame, x0: u64, x1: u64): i32 {
  const m = f.render, sys = f.a0;
  switch (m.state) {
    case AudioRenderS.Queued: {
      if (renderOwner) { m.step(AudioRenderE.StillBusy); return wait(renderEvent, 5 * MS); }
      m.step(AudioRenderE.Turn);
      return renderLock(f);
    }
    // Command generation must exclude the game thread's RequestUpdate (AudioRenderSystem::Update holds the lock);
    // processing (the CPU DSP) stays outside the lock, as in the original
    case AudioRenderS.Locking: {
      m.step(AudioRenderE.Locked);
      if (fGen20) return call(fGen20, sys, load<u64>(gp(sys), 0xf8), load<u64>(gp(sys), 0x100));
      f.v0 = guestCall(fCbuf, sys);
      return call(fGen, sys, f.v0, guestCall(fCbsz, sys));
    }
    case AudioRenderS.Generating: {
      if (fGen20) { f.v0 = x0; f.v1 = x1; } else f.v1 = x0;
      m.step(AudioRenderE.Generated);
      return call(fUnlock, sys + muOff);
    }
    case AudioRenderS.Unlocking: {
      m.step(AudioRenderE.Unlocked);
      const r = f.ren >= 0 ? renAt(f.ren) : null;
      if (r != null) rsink.countRender(r.sink);
      memory.fill(proc, 0, 0x80);
      guestCall(fTmax, proc, 0xffffffff); guestCall(fSetup, proc, f.v0, f.v1);
      return call(fProcess, proc);
    }
    case AudioRenderS.Processing: {
      m.step(AudioRenderE.Processed);
      const r = f.ren >= 0 ? renAt(f.ren) : null;
      if (r != null && r.sink >= 0) cmdlist.capture(r.sink, f.dest, gp(f.v0), <usize>f.v1);
      renderOwner = 0;
      eventSignal(renderEvent);
      f.v2 = RES_OK;
      return -1;
    }
  }
  red(); puts("audren: a render was resumed in state "); putu(m.state); end();
  f.v2 = RES_FAIL;
  return -1;
}

// ---- OpenAudioRenderer (both forms) ----
function cpuManual(dst: usize, src: usize): void { memory.copy(dst, src, P_SIZE); store<i32>(dst, 1, P_DEVICE); store<i32>(dst, 1, P_MODE); }
// handle: where the SDK writes the AudioRendererHandle; ev: the game's SystemEvent, 0 for the form without one
export function open(handle: u64, ev: u64, param: u64, work: u64, sz: u64, lr: u64): i32 {
  const origEv = guestFn(unchecked(NAMES[Fn.ar_Open - 1])), orig = guestFn(unchecked(NAMES[Fn.ar_Open0 - 1]));
  // SDK 17.5.3's event form opens the renderer by calling the form without one through the PLT, which is bound to
  // this take-over: the inner call goes straight to the SDK with the host's copy of the parameter
  if (inOpen()) {
    if (!orig) { missing(0, unchecked(NAMES[Fn.ar_Open0 - 1])); return plain(RES_FAIL, true); }
    const f = push(K_PASS, lr, 1);
    return f == null ? plain(RES_FAIL, true) : call(orig, handle, param, work, sz);
  }
  if (ev ? !origEv : !orig) { missing(ev ? 1 : 0, unchecked(NAMES[(ev ? Fn.ar_Open : Fn.ar_Open0) - 1])); return plain(RES_FAIL, true); }
  const f = push(K_OPEN, lr, 1);
  if (f == null) return plain(RES_FAIL, true);
  const g = gp(param), p = f.param, device = load<i32>(g, P_DEVICE);
  cpuManual(p, g);
  begin(); puts("audren: OpenAudioRenderer"); puts(ev ? "" : " (no event)"); puts(" rate "); puti(load<i32>(g)); puts(" samples per frame "); puti(load<i32>(g, 4)); puts(" mix buffers "); puti(load<i32>(g, 8));
  puts(" submixes "); puti(load<i32>(g, 0xc)); puts(" voices "); puti(load<i32>(g, 0x10)); puts(" sinks "); puti(load<i32>(g, 0x14)); puts(" effects "); puti(load<i32>(g, 0x18));
  puts(" splitters "); puti(load<i32>(g, 0x24)); puts(" (original device "); puti(device); puts(" mode "); puti(load<i32>(g, P_MODE)); puts(" -> CPU / manual) work buffer "); putx(work); puts("+"); putx(sz); end();
  // The application's buffer follows the DSP service contract; the local server's larger CPU command
  // representation is a backend cost. A full-size caller buffer is kept when it fits the backend, otherwise the
  // backend storage is supplied here
  let owned: usize = 0;
  if (device == 0 && work && !(work & (WORK_PAGE - 1)) && sz >= WORK_PAGE && !(sz & (WORK_PAGE - 1))) {
    const size = guestFn(unchecked(NAMES[Fn.ar_WorkSize - 1]));
    const needed = size ? guestCall(size, p) : 0, service = rsink.serviceWorkSize(p), guestNeed = service ? service : needed;
    if (sz < guestNeed) { red(); puts("audren: work buffer "); putx(sz); puts(" is smaller than the service requirement "); putx(guestNeed); end(); f.used = 0; return plain(RES_FAIL, true); }
    if (needed > sz) {
      owned = needed < 0x40000000 ? arenaAlloc(<usize>needed + 0x1000) : 0;
      if (!owned) { red(); puts("audren: cannot allocate local renderer work buffer "); putx(needed); end(); f.used = 0; return plain(RES_FAIL, true); }
      work = (<u64>owned + WORK_PAGE - 1) & ~(WORK_PAGE - 1); sz = needed;
      begin(); puts("audren: host backs local renderer work buffer "); putx(work); puts("+"); putx(sz); end();
    }
  }
  // A game that opens a CPU renderer itself gets the SDK's contract: the SDK keeps its event, as on Horizon
  const sev = ev && device == 0 ? revTake() : 0;
  if (ev && device == 0 && !sev) { red(); puts("audren: all renderer events in use: the SDK keeps the game's event, which must then outlive the renderer"); end(); }
  for (let i = 0; i < AR_MAX; i++) if (renAt(i).inst.state == AudioRenS.Free) { f.ren = i; renAt(i).inst.step(AudioRenE.Open); break; }
  f.a0 = handle; f.a1 = ev; f.a2 = <u64>owned; f.a3 = <u64>sev; f.a4 = <u64>device;
  return ev ? call(origEv, handle, sev ? <u64>sev : ev, <u64>p, work, sz) : call(orig, handle, <u64>p, work, sz);
}
function opened(f: Frame, x0: u64): i32 {
  const r = <u32>x0, handle = gp(f.a0), ev = f.a1, owned = <usize>f.a2, sev = <usize>f.a3, device = <i32>f.a4;
  const slot = f.ren >= 0 ? renAt(f.ren) : null;
  if (r) {
    arenaFree(owned); revSet(sev, 0);
    if (slot != null) slot.inst.step(AudioRenE.OpenFailed);
    red(); puts("audren: SDK OpenAudioRenderer failed "); putx(r); end();
    return done(f, r);
  }
  const h0 = load<u64>(handle), h1 = load<u64>(handle, 8);
  if (owned) ownedPut(h0, owned);   // Close releases it only after the render thread and the SDK have finished with it
  if (ev && device == 0) {
    const destroy = guestFn("_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE");
    if (!destroy) missing(2, "nn::os::DestroySystemEvent");
    if (sev) {
      const attach = guestFn("_ZN2nn2os33AttachReadableHandleToSystemEventEPNS0_15SystemEventTypeEjbNS0_14EventClearModeE");
      const getr = guestFn("_ZN2nn2os30GetReadableHandleOfSystemEventEPKNS0_15SystemEventTypeE");
      if (!attach || !getr) missing(3, "nn::os::AttachReadableHandleToSystemEvent / GetReadableHandleOfSystemEvent");
      if (destroy) guestCall(destroy, <u64>sev);
      const p = revSlot(sev);
      if (p) store<u32>(p, eventBind(sev, 1), 12);
      // managed (the game's DestroySystemEvent closes its copy), EventClearMode_AutoClear
      if (attach && getr) guestCall(attach, ev, <u64>handleDup(<u32>guestCall(getr, <u64>sev)), 1, 1);
      revSet(sev, h0);
    } else {   // no free renderer event: the game's object must live as long as the renderer
      if (destroy) guestCall(destroy, ev);
      eventBind(gp(ev), 1);
    }
  }
  begin(); puts("audren: renderer "); puti(f.ren); puts(" opened from "); putx(f.lr); end();
  if (slot == null) { red(); puts("audren: more than "); putu(AR_MAX); puts(" renderers: this one is not rendered"); end(); return done(f, r); }
  slot.h0 = h0; slot.h1 = h1; slot.sys = 0; slot.thread = 0; slot.stack = 0;
  f.v2 = r;
  // nxnative's render thread opens the output as its first act; here the open does, so that an update that comes
  // before the thread's first slice already has the renderer's counters
  slot.sink = rsink.open();
  const fMalloc = guestFn("malloc"), fCreate = guestFn(CREATE_THREAD), fStart = guestFn(START_THREAD), entry = threadEntry();
  const tt = slot.sink >= 0 && fMalloc && fCreate && fStart && guestFn(WAIT_THREAD) && guestFn(DESTROY_THREAD) && guestFn("free") && entry ? arenaAlloc(0x200) : 0;
  if (!tt) {
    if (slot.sink >= 0) noThread(f.ren, "the SDK's malloc / free / nn::os::CreateThread / StartThread / WaitThread / DestroyThread are not all there, or the embedder has no thread entry");
    slot.inst.step(AudioRenE.NoThread);
    return done(f, r);
  }
  slot.thread = <u32>tt;
  slot.inst.step(AudioRenE.Opened);
  return call(fMalloc, STACK + 0xfff);
}
function noThread(i: i32, why: string): void {
  red(); puts("audren: the render thread of renderer "); puti(i); puts(" could not be started ("); puts(why); puts("): only the game's updates render (catch-up frames)"); end();
}
function openResume(f: Frame, x0: u64): i32 {
  const slot = f.ren >= 0 ? renAt(f.ren) : null;
  if (slot == null || slot.inst.state == AudioRenS.Opening) return opened(f, x0);
  switch (slot.inst.state) {
    case AudioRenS.StackAlloc: {
      if (!x0) { noThread(f.ren, "no memory for its stack"); arenaFree(<usize>slot.thread); slot.thread = 0; slot.inst.step(AudioRenE.NoThread); return done(f, f.v2); }
      slot.stack = x0;
      slot.inst.step(AudioRenE.Allocated);
      return call(guestFn(CREATE_THREAD), <u64>slot.thread, threadEntry(), <u64>f.ren, (x0 + 0xfff) & ~<u64>0xfff, STACK, PRIO);
    }
    case AudioRenS.ThreadCreate: {
      if (<u32>x0) {   // the stack stays allocated: the SDK may have mapped it
        noThread(f.ren, "nn::os::CreateThread failed"); arenaFree(<usize>slot.thread); slot.thread = 0; slot.inst.step(AudioRenE.NoThread);
        return done(f, f.v2);
      }
      slot.inst.step(AudioRenE.Created);
      return call(guestFn(START_THREAD), <u64>slot.thread);
    }
    case AudioRenS.ThreadStart: slot.inst.step(AudioRenE.Started); return done(f, f.v2);
  }
  red(); puts("audren: an open was resumed in state "); putu(slot.inst.state); end();
  return done(f, f.v2);
}

// ---- CloseAudioRenderer ----
function closeSink(a: Ren): void { if (a.sink >= 0) { rsink.close(a.sink); cmdlist.sinkClosed(a.sink); a.sink = -1; } }
export function close(obj: u64, state: u64, lr: u64): i32 {
  const orig = guestFn(unchecked(NAMES[Fn.ar_Close - 1]));
  if (!orig) { missing(4, unchecked(NAMES[Fn.ar_Close - 1])); return plain(0, false); }
  let a: Ren | null = null;
  for (let i = 0; i < AR_MAX && a == null; i++) if (renAt(i).inst.state == AudioRenS.Running && renAt(i).h0 == obj) a = renAt(i);
  const f = push(a == null ? K_PASS : K_CLOSE, lr, 0);
  if (f == null) return plain(0, false);
  f.a0 = obj; f.a1 = state;
  if (a == null) return call(orig, obj, state);
  f.ren = renIndex(a);
  if (!a.thread) { a.inst.step(AudioRenE.CloseNoThread); closeSink(a); return call(orig, obj, state); }
  // The render thread ends first (it looks at the renderer's state every round and at most every 10 ms while it
  // waits for the output): it may be inside the SDK's render, which uses what the SDK is about to free. nxnative
  // joins it the same way (dm_guest_thread_join: WaitThread, DestroyThread, free of its stack)
  a.inst.step(AudioRenE.Close);
  return call(guestFn(WAIT_THREAD), <u64>a.thread);
}
function closeResume(f: Frame): i32 {
  const a = renAt(f.ren);
  switch (a.inst.state) {
    case AudioRenS.Stopping: a.inst.step(AudioRenE.ThreadEnded); return call(guestFn(DESTROY_THREAD), <u64>a.thread);
    case AudioRenS.ThreadDestroy: {
      a.inst.step(AudioRenE.Destroyed);
      arenaFree(<usize>a.thread); a.thread = 0;
      return call(guestFn("free"), a.stack);
    }
    case AudioRenS.StackFree: {
      a.inst.step(AudioRenE.Freed);
      a.stack = 0;
      closeSink(a);   // a thread that never reached its loop
      return call(guestFn(unchecked(NAMES[Fn.ar_Close - 1])), f.a0, f.a1);
    }
  }
  // the SDK's Close has returned
  arenaFree(ownedDel(f.a0));
  const sev = revFind(f.a0);
  a.h0 = 0; a.h1 = 0; a.sys = 0;
  a.inst.step(AudioRenE.Closed);
  if (sev) {   // the SDK's Close does not touch the event; destroying it closes the renderer's ends, and the game's copied read end stays the game's
    const destroy = guestFn("_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE");
    if (destroy) guestCall(destroy, <u64>sev);
    const p = revSlot(sev), tok = load<u32>(p, 12);
    if (tok) eventRelease(tok);
    revSet(sev, 0);
  }
  return done(f, 0);
}

// ---- the render thread (render_main) ----
// The thread is to run: the renderer is open. A thread of higher priority than its maker runs inside StartThread.
// @ts-ignore: decorator
@inline function wanted(r: Ren): bool { return r.inst.state == AudioRenS.Running || r.inst.state == AudioRenS.ThreadStart; }
// The thread the SDK started for renderer `i` has called its function, the embedder's stub; lr: where the stub
// returns to when the loop ends (the SDK's thread function wrapper, which ends the thread)
export function threadEnter(i: i32, lr: u64): i32 {
  if (i < 0 || i >= AR_MAX) return plain(0, false);
  const r = renAt(i);
  // closed before its thread ran, or not this renderer's thread: it returns at once
  if (!wanted(r) || r.tinst.state != AudioRenThreadS.Idle || r.sink < 0) return plain(0, false);
  const exec = guestFn("_ZN2nn5audio29ExecuteAudioRendererRenderingENS0_19AudioRendererHandleE");
  if (!exec) { missing(5, "nn::audio::ExecuteAudioRendererRendering"); return plain(0, false); }
  const f = push(K_THREAD, lr, 0);
  if (f == null) return plain(0, false);
  f.ren = i; f.a0 = exec;
  r.tinst.step(AudioRenThreadE.Start);
  begin(); puts("audren: render thread "); putu(i); puts(" started (4 buffers in flight, paced by the output)"); end();
  return threadLoop(f, r);
}
function threadLoop(f: Frame, r: Ren): i32 {
  const t = r.tinst;
  for (let round = 0; round < 16; round++) {
    if (!wanted(r)) {
      t.step(AudioRenThreadE.Stop);
      // the output would otherwise keep consuming and hold one of the AudioOut slots after the renderer closes;
      // closing it also wakes an update that waits for queue space
      closeSink(r);
      return done(f, 0);
    }
    // wait for the output to hand a block back (silent sink or device, one every 5 ms): it signals each release
    if (!rsink.ready(r.sink)) { t.step(AudioRenThreadE.NoBlock); return wait(rsink.releaseEvent(r.sink), 10 * MS); }
    // SDK: generate commands -> CPU processing (the output is taken in the host's take-over) -> signal the game's renderer event
    if (rsink.next(r.sink)) { t.step(AudioRenThreadE.Render); return call(f.a0, r.h0, r.h1); }
    t.step(AudioRenThreadE.PlayQueued);   // a queued catch-up frame was played in place of a render
  }
  t.step(AudioRenThreadE.NoBlock);
  return wait(rsink.releaseEvent(r.sink), MS);
}
function threadResume(f: Frame): i32 {
  const r = renAt(f.ren), t = r.tinst;
  if (t.state == AudioRenThreadS.Rendering) { rsink.rendered(r.sink); t.step(AudioRenThreadE.Rendered); }
  else t.step(AudioRenThreadE.Wake);
  return threadLoop(f, r);
}

// ---- ExecuteAudioRendererRendering (AudioRendererImpl's, and SDK 20's AudioRenderSystem's) ----
// A render from the host's render thread names the thread's renderer and its system; a game that executes its own
// CPU renderer renders too, into nothing
export function exec(sys: u64, lr: u64): i32 {
  const t = top();
  let a: Ren | null = null, dest: u8 = 2;
  if (t != null && t.kind == K_THREAD) { a = renAt(t.ren); if (!a.sys) a.sys = sys; dest = 0; }
  else a = renOfSys(sys);
  if (a == null) { if (once(6)) { red(); puts("audren: a render of a renderer the host did not open"); end(); } return plain(RES_FAIL, true); }
  const f = push(K_EXEC, lr, 1);
  if (f == null) return plain(RES_FAIL, true);
  f.a0 = sys; f.ren = renIndex(a); f.dest = dest;
  const k = renderStart(f);
  return k >= 0 ? k : done(f, f.v2);
}
export function implExec(impl: u64, lr: u64): i32 { return exec(impl + implSysOff(), lr); }

// ---- AudioRenderSystem::Update ----
function updateSdk(f: Frame): i32 { return call(guestFn(unchecked(NAMES[Fn.ars_Update - 1])), f.a0, f.a1, f.a2, f.a3, f.a4, f.a5, f.a6); }
function updateRender(f: Frame): i32 {
  const k = renderStart(f);
  if (k >= 0) return k;
  f.update.step(AudioRenUpdateE.Rendered);
  return updateSdk(f);
}
export function update(args: usize, lr: u64): i32 {
  if (!guestFn(unchecked(NAMES[Fn.ars_Update - 1]))) { missing(7, unchecked(NAMES[Fn.ars_Update - 1])); return plain(RES_FAIL, true); }
  const f = push(K_UPDATE, lr, 1);
  if (f == null) return plain(RES_FAIL, true);
  f.a0 = load<u64>(args); f.a1 = load<u64>(args, 8); f.a2 = load<u64>(args, 16); f.a3 = load<u64>(args, 24); f.a4 = load<u64>(args, 32); f.a5 = load<u64>(args, 40); f.a6 = load<u64>(args, 48);
  const a = renOfSys(f.a0), u = f.update;
  // two renderers just opened, neither has rendered: at most one catch-up frame less
  if (a == null) { u.step(AudioRenUpdateE.Pass); return updateSdk(f); }
  f.ren = renIndex(a);
  const st = rsink.updateBegin(a.sink, 0);
  if (st == 0) { u.step(AudioRenUpdateE.Pass); return updateSdk(f); }
  if (st == 1) { u.step(AudioRenUpdateE.CatchUp); f.dest = 1; return updateRender(f); }
  // the queue is full: wait for the render thread to play one, so that catch-up frames keep real time
  u.step(AudioRenUpdateE.QueueFull);
  return wait(rsink.cqEvent(a.sink), 50 * MS);
}
function updateResume(f: Frame, x0: u64, x1: u64): i32 {
  const u = f.update, a = f.ren >= 0 ? renAt(f.ren) : null;
  switch (u.state) {
    case AudioRenUpdateS.Waiting: {
      if (a != null && rsink.updateBegin(a.sink, 1) == 1) { u.step(AudioRenUpdateE.Space); f.dest = 1; }
      else { u.step(AudioRenUpdateE.StillFull); f.dest = 2; }   // the output stopped: render anyway, the output is discarded
      return updateRender(f);
    }
    case AudioRenUpdateS.Rendering: {
      const k = renderResume(f, x0, x1);
      if (k >= 0) return k;
      u.step(AudioRenUpdateE.Rendered);
      return updateSdk(f);
    }
    case AudioRenUpdateS.Sdk: {
      u.step(AudioRenUpdateE.Done);
      if (a != null) rsink.updateEnd(a.sink);
      return done(f, x0);
    }
  }
  red(); puts("audren: an update was resumed in state "); putu(u.state); end();
  return done(f, RES_FAIL);
}

// ---- the embedder comes back: the SDK function returned (x0, x1), or the wait ended ----
export function resume(x0: u64, x1: u64): i32 {
  const f = top();
  if (f == null) { red(); puts("audren: thread "); putu(cur); puts(" came back from a call the host did not make"); end(); return plain(0, false); }
  switch (f.kind) {
    case K_OPEN: return openResume(f, x0);
    case K_PASS: return done(f, x0);
    case K_CLOSE: return closeResume(f);
    case K_THREAD: return threadResume(f);
    case K_EXEC: { const k = renderResume(f, x0, x1); return k >= 0 ? k : done(f, f.v2); }
    case K_UPDATE: return updateResume(f, x0, x1);
  }
  return done(f, 0);
}
