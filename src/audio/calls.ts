// audio_lookup and audio_call: every nn::audio / nn::codec name nxnative takes over (names.ts), and what each does.
// Arguments come as the guest passed them; see index.ts for the block's layout and the result convention.
import { Fn, FN_COUNT, NAMES } from "./names";
import { AudioOutS } from "../kit/gen/tables";
import { red, end, puts, putx, putu, fillName, eventBind, guestFn, guestCall, gp, RES_OK, RES_FAIL, RATE } from "./base";
import * as out from "./out";
import { Out } from "./out";
import * as stream from "./stream";
import * as rsink from "./rsink";
import * as opus from "./opus";
import * as ren from "./ren";

export const RET_VOID: i32 = 0, RET_X0: i32 = 1, RET_X0X1: i32 = 3, RET_V0: i32 = 4;

let args: usize = 0;
// @ts-ignore: decorator
@inline function X(i: i32): u64 { return load<u64>(args + (<usize>i << 3)); }
// @ts-ignore: decorator
@inline function P(i: i32): usize { return gp(X(i)); }
// @ts-ignore: decorator
@inline function K(i: i32): u64 { return X(i); }   // a guest object's address as the key of the host's record of it: the whole register
// @ts-ignore: decorator
@inline function I(i: i32): i32 { return <i32>X(i); }
// @ts-ignore: decorator
@inline function F(i: i32): f32 { return load<f32>(args + 64 + (<usize>i << 3)); }
// @ts-ignore: decorator
@inline function lr(): u64 { return load<u64>(args, 136); }
function ret(v: u64): i32 { store<u64>(args, v); return RET_X0; }
function retF(v: f32): i32 { store<u64>(args, 0, 64); store<f32>(args, v, 64); return RET_V0; }

// ---- lookup ----
// The id (1..FN_COUNT) of a mangled name (NUL-terminated in linear memory), 0 when the module does not take it over
export function lookup(name: usize): u32 {
  let len = 0;
  while (load<u8>(name + len)) len++;
  for (let i: u32 = 0; i < FN_COUNT; i++) {
    const s = unchecked(NAMES[i]);
    if (s.length != len) continue;
    let j = 0;
    while (j < len && <u8>s.charCodeAt(j) == load<u8>(name + j)) j++;
    if (j == len) return i + 1;
  }
  return 0;
}

// ---- red lines, once per function ----
const ONCE: usize = memory.data(256);
function once(fn: u32): bool { if (load<u8>(ONCE + fn)) return false; store<u8>(ONCE + fn, 1); return true; }
// A name that resolves and is not implemented: one red line, then `value` every time
function stub(fn: u32, value: u64, why: string): i32 {
  if (once(fn)) { red(); puts("audio: "); puts(unchecked(NAMES[fn - 1])); puts(" is not implemented ("); puts(why); puts(")"); end(); }
  return ret(value);
}
function noObject(fn: u32, what: string, key: u64): void {
  if (!once(fn)) return;
  red(); puts("audio: "); puts(unchecked(NAMES[fn - 1])); puts(" on "); puts(what); puts(" "); putx(key); puts(" the host did not open"); end();
}
// No name is a stub any more (the audio renderer's six were until the renderer was driven; see ren.ts)
export function isStub(fn: u32): bool { return false; }
// A renderer take-over: it either ends at once (its result goes where every call's result goes) or goes on with a
// request to the embedder (ren.RET_CO; see ren.ts)
function co(kind: i32): i32 { if (kind == 1) store<u64>(args, load<u64>(ren.reqPtr(), 8)); return kind; }

// ---- AudioOut ----
// The front of the guest AudioOut as the SDK's OpenAudioOut fills it (sample rate, channel count, sample format,
// state): code outside the SDK reads these fields too (nxnative: Luigi's Mansion 3)
function info(g: usize, ch: u32, state: u32): void { store<u32>(g, RATE); store<u32>(g, ch, 4); store<u32>(g, out.FMT_PCM16, 8); store<u32>(g, state, 12); }

function openAt(g: usize, ev: usize, name: usize, param: usize): u32 {
  let ch = <u32>load<u16>(param, 4);
  const rate = load<i32>(param);
  if (!ch) ch = 2;
  if (rate && rate != <i32>RATE) { red(); puts("AudioOut sample rate "); putu(<u32>rate); puts(" not supported (48 kHz only): the open fails"); end(); return RES_FAIL; }
  const old = out.outOfKey(g);
  if (old != null) out.close(old, lr());   // opened again without a close
  const o = out.open(g, out.KIND_GUEST, ev ? eventBind(ev, 1) : 0, ch, name, lr());
  if (o == null) return RES_FAIL;
  info(g, ch, out.STATE_STOPPED);
  return RES_OK;
}
function ao(fn: u32, i: i32): Out | null {
  const o = out.outOfKey(K(i));
  if (o == null) noObject(fn, "AudioOut", X(i));
  return o;
}
const DEVICE_OUT: usize = memory.data<u8>([68, 101, 118, 105, 99, 101, 79, 117, 116, 0]);   // "DeviceOut"

// ---- device notifications: bound, never signalled; the SDK keeps a flag per process ----
let notifyOut = false, notifyIn = false;
let devVol: f32 = 1.0, autoTune: u32 = 0;
function devName(p: usize): void { fillName(p, "AudioBuiltInSpeakerOutput", 0x100); }
function listOne(names: usize, n: i32): i32 { if (n <= 0 || !names) return 0; devName(names); return 1; }

const PARAM: usize = memory.data(64);

export function call(fn: u32, argsPtr: usize): i32 {
  args = argsPtr;
  switch (fn) {
    // ---------- hle_audio.c: AudioOut ----------
    case Fn.au_InitParam: memory.fill(P(0), 0, 8); return RET_VOID;   // 0 = system default (48 kHz / 2 channels)
    case Fn.au_List: { if (I(1) < 1) return ret(0); fillName(P(0), "DeviceOut", 256); return ret(1); }
    case Fn.au_Open: return ret(openAt(P(0), P(1), P(2), P(3)));
    case Fn.au_Open4: return ret(openAt(P(0), 0, P(1), P(2)));
    case Fn.au_OpenDef: return ret(openAt(P(0), P(1), 0, P(2)));
    case Fn.au_OpenDef0: return ret(openAt(P(0), 0, 0, P(1)));
    case Fn.au_Start: { const o = ao(fn, 0); if (o == null) return ret(RES_FAIL); out.start(o, lr()); return ret(RES_OK); }
    case Fn.au_Stop: { const o = ao(fn, 0); if (o != null) out.stop(o, lr()); return RET_VOID; }
    case Fn.au_Close: { const o = ao(fn, 0); if (o != null) { const ch = o.ch; out.close(o, lr()); info(P(0), ch, out.STATE_STOPPED); } return RET_VOID; }
    case Fn.au_State: { const o = ao(fn, 0); return ret(o != null && o.state != AudioOutS.Stopped ? out.STATE_STARTED : out.STATE_STOPPED); }
    case Fn.au_BufCount: { const o = ao(fn, 0); return ret(o == null ? 0 : o.pending); }   // appended and not yet played to the end, the one playing included
    case Fn.au_Rate: ao(fn, 0); return ret(RATE);
    case Fn.au_Ch: { const o = ao(fn, 0); return ret(o == null ? 2 : o.ch); }
    case Fn.au_Name: return ret(DEVICE_OUT);
    case Fn.au_Fmt: ao(fn, 0); return ret(out.FMT_PCM16);
    case Fn.au_SetVol: { const o = ao(fn, 0); let v = F(0); if (!(v >= 0.0)) v = 0.0; if (o != null) o.vol = v; return RET_VOID; }
    case Fn.au_GetVol: { const o = ao(fn, 0); return retF(o == null ? 1.0 : o.vol); }
    case Fn.au_SetBuf: { const b = P(0); store<u64>(b, X(1)); store<u64>(b, X(2), 8); store<u64>(b, X(3), 16); return RET_VOID; }
    case Fn.au_BufPtr: return ret(load<u64>(P(0)));
    case Fn.au_BufSize: return ret(load<u64>(P(0), 16));
    case Fn.au_Append: { const o = ao(fn, 0); return ret(o != null && P(1) && out.append(o, P(1), 0, 0, 0) ? 1 : 0); }   // false when the queue is full
    case Fn.au_Released: {
      const o = ao(fn, 0);
      if (o == null) return ret(0);
      const s = out.takeReleased(o);
      return ret(s < 0 ? 0 : load<u64>(o.slot(<u32>s), out.SLOT_GUEST));
    }
    // ---------- AudioIn: the host has no microphone ----------
    case Fn.ai_List: return ret(0);
    case Fn.ai_Open: case Fn.ai_OpenNoEv: case Fn.ai_OpenDef: case Fn.ai_Start: return ret(RES_FAIL);
    case Fn.ai_Stop: case Fn.ai_Close: return RET_VOID;
    case Fn.ai_Append: case Fn.ai_Released: return ret(0);
    case Fn.ai_Rate: return ret(RATE);
    case Fn.ai_Ch: return ret(2);
    case Fn.ai_Fmt: return ret(out.FMT_PCM16);
    // ---------- SDK 21's OutputStream ----------
    case Fn.os_DefaultDev: fillName(P(0), "AudioVirtualOutput", 0x100); return RET_VOID;
    case Fn.os_Open: return ret(stream.open(K(0), P(1), P(5), I(6), lr()));     // (stream, event, buffer, size, device, format, frames, threshold, flags)
    case Fn.os_OpenNoEv: return ret(stream.open(K(0), 0, P(4), I(5), lr()));     // (stream, buffer, size, device, format, frames, flags)
    case Fn.os_Start: { const s = stream.find(K(0)); if (s == null) { noObject(fn, "OutputStream", X(0)); return ret(RES_FAIL); } out.start(stream.outOf(s), lr()); return ret(RES_OK); }
    case Fn.os_StartN: {
      const list = P(0), n = I(1);
      for (let i = 0; i < n; i++) {
        const s = stream.find(load<u64>(list + (<usize>i << 3)));
        if (s == null) { noObject(fn, "OutputStream", load<u64>(list + (<usize>i << 3))); return ret(RES_FAIL); }
        out.start(stream.outOf(s), lr());
      }
      return ret(RES_OK);
    }
    case Fn.os_Stop: { const s = stream.find(K(0)); if (s == null) noObject(fn, "OutputStream", X(0)); else out.stop(stream.outOf(s), lr()); return RET_VOID; }
    case Fn.os_Purge: { const s = stream.find(K(0)); if (s == null) noObject(fn, "OutputStream", X(0)); else stream.purge(s); return RET_VOID; }
    case Fn.os_Close: stream.close(K(0), lr()); return RET_VOID;
    case Fn.os_State: return ret(stream.state(K(0)));   // 0 not open, 1 stopped, 2 started
    case Fn.os_Free: { const s = stream.find(K(0)); if (s == null) { noObject(fn, "OutputStream", X(0)); return ret(0); } return ret(<u64>stream.free(s)); }
    case Fn.os_Write: { const s = stream.find(K(0)); if (s == null) { noObject(fn, "OutputStream", X(0)); return ret(0); } return ret(<u64>stream.write(s, P(1), I(2))); }
    case Fn.os_Gain: { const s = stream.find(K(0)); let v = F(0); if (!(v >= 0.0)) v = 0.0; if (s == null) noObject(fn, "OutputStream", X(0)); else stream.outOf(s).vol = v; return RET_VOID; }   // no fade
    case Fn.os_Filled: { const s = stream.find(K(0)); if (s == null) { noObject(fn, "OutputStream", X(0)); return ret(0); } return ret(<u64>stream.filled(s)); }
    // The statistics come back through x8, 24 bytes and not one more: Star Fox keeps its stack canary right behind them
    case Fn.os_Stats: case Fn.is_Stats: { const r = gp(load<u64>(args, 128)); if (r) memory.fill(r, 0, 24); return RET_VOID; }
    // ---------- SDK 21's input streams: no device ----------
    case Fn.is_List: return ret(0);
    case Fn.is_Props: case Fn.is_Open: case Fn.is_Start: return ret(RES_FAIL);
    case Fn.is_Close: case Fn.is_Stop: case Fn.is_Purge: case Fn.is_SetGain: return RET_VOID;
    case Fn.is_Read: case Fn.is_Filled: case Fn.is_State: case Fn.is_Free: case Fn.is_Capacity: return ret(0);
    case Fn.is_Format: store<u64>(args, <u64>stream.OS_PCM16 | (<u64>1 << 32)); store<u64>(args, <u64>RATE, 8); return RET_X0X1;   // StreamFormat { format, channels, rate }: 12 bytes in x0, x1
    case Fn.is_GetGain: return retF(1.0);

    // ---------- hle_audren.c ----------
    case Fn.ar_WorkSize: {
      // The game asked for the DSP service: it gets the service's budget, whatever the local CPU renderer needs
      const p = P(0);
      memory.copy(PARAM, p, 0x40);
      const service = load<i32>(p, 0x2c) == 0 ? rsink.serviceWorkSize(PARAM) : 0;
      if (service) return ret(service);
      const orig = guestFn(unchecked(NAMES[fn - 1]));
      if (!orig) return stub(fn, 0, "a renderer revision or device the service model does not cover, and the SDK's own function is not reachable");
      store<i32>(PARAM, 1, 0x2c); store<i32>(PARAM, 1, 0x30);   // rendering device = CPU, execution mode = manual
      return ret(guestCall(orig, PARAM));
    }
    case Fn.ar_Open: return co(ren.open(X(0), X(1), X(2), X(3), X(4), lr()));    // (handle, event, parameter, work buffer, size)
    case Fn.ar_Open0: return co(ren.open(X(0), 0, X(1), X(2), X(3), lr()));      // (handle, parameter, work buffer, size)
    case Fn.ar_Close: return co(ren.close(X(0), X(1), lr()));                    // the handle by value: (renderer, client state)
    case Fn.ar_ImplExec: return co(ren.implExec(X(0), lr()));
    case Fn.ars_Exec: return co(ren.exec(X(0), lr()));
    case Fn.ars_Update: return co(ren.update(args, lr()));
    case Fn.up_Allocate: {   // an upsampler for a DeviceSink below 48 kHz: none with CPU rendering (no manager); the sink resamples
      if (!X(0)) return ret(0);
      const orig = guestFn(unchecked(NAMES[fn - 1]));
      if (!orig) return stub(fn, 0, "the SDK's own UpsamplerManager::Allocate is not reachable");
      return ret(guestCall(orig, X(0)));
    }
    case Fn.ad_List: case Fn.ad_List12: return ret(<u64>listOne(P(0), I(1)));
    case Fn.ad_Active: case Fn.ad_Active12: devName(P(0)); return RET_VOID;
    case Fn.ad_Channels: case Fn.ad_Channels7: return ret(2);
    case Fn.ad_SetVol: devVol = F(0); return RET_VOID;   // kept for the getter, not applied
    case Fn.ad_GetVol: return retF(devVol);
    case Fn.ad_SetAutoTune: autoTune = <u32>K(0) & 1; return RET_VOID;
    case Fn.ad_AutoTune: return ret(autoTune);
    case Fn.ad_Notify: case Fn.ad_Notify21: { if (notifyOut) return ret(0x499); notifyOut = true; eventBind(P(0), 0); return ret(RES_OK); }
    case Fn.ad_NotifyIn: { if (notifyIn) return ret(0x499); notifyIn = true; eventBind(P(0), 0); return ret(RES_OK); }
    case Fn.ad_Notify7: eventBind(P(0), 0); return RET_VOID;

    // ---------- hle_codec.c: the synchronous interfaces, forwarded to the SDK's software decoders ----------
    case Fn.codec_HwOpusCtor: { const f = opus.sdk(opus.S.Ctor); if (f) guestCall(f, X(0)); return RET_VOID; }
    case Fn.codec_HwOpusWorkSize: case Fn.codec_HwOpusWorkSize2: { const f = opus.sdk(opus.S.WorkSize); return ret(f ? guestCall(f, X(0), X(1)) : 0); }
    case Fn.codec_HwOpusInit: {
      const f = opus.sdk(opus.S.Init), s = f ? opus.softMake(K(0)) : 0;
      return ret(s ? guestCall(f, s, X(1), X(2), X(3), X(4)) : RES_FAIL);
    }
    case Fn.codec_HwOpusFini: {
      if (opus.decFini(K(0))) return RET_VOID;
      const s = opus.softDel(K(0));
      if (s) { const f = opus.sdk(opus.S.Fini); if (f) guestCall(f, s); opus.softFree(s); }
      return RET_VOID;
    }
    case Fn.codec_HwOpusRate: case Fn.codec_HwOpusCh: {
      const d = opus.decFind(K(0));
      if (d != null) return ret(<u64>(fn == Fn.codec_HwOpusRate ? opus.decRate(d) : opus.decCh(d)));
      const s = opus.softOf(K(0)), f = s ? opus.sdk(fn == Fn.codec_HwOpusRate ? opus.S.Rate : opus.S.Ch) : 0;
      return ret(f ? guestCall(f, s) : 0);
    }
    case Fn.codec_HwOpusReset: {
      if (opus.decReset(K(0))) return RET_VOID;
      const s = opus.softOf(K(0)), f = s ? opus.sdk(opus.S.Reset) : 0;
      if (f) guestCall(f, s);
      return RET_VOID;
    }
    case Fn.codec_HwOpusDecode: {
      const s = opus.softOf(K(0)), f = s ? opus.sdk(opus.S.Decode) : 0;
      return ret(f ? guestCall(f, s, X(1), X(2), X(3), X(4), X(5), X(6)) : RES_FAIL);
    }
    case Fn.codec_HwOpusMsCtor: { const f = opus.sdk(opus.S.MsCtor); if (f) guestCall(f, X(0)); return RET_VOID; }
    case Fn.codec_HwOpusMsWorkSize: case Fn.codec_HwOpusMsWorkSize5: { const f = opus.sdk(opus.S.MsWorkSize); return ret(f ? guestCall(f, X(0), X(1), X(2), X(3)) : 0); }
    case Fn.codec_HwOpusMsInit: {
      const f = opus.sdk(opus.S.MsInit), s = f ? opus.softMake(K(0)) : 0;
      return ret(s ? guestCall(f, s, X(1), X(2), X(3), X(4), X(5), X(6), X(7)) : RES_FAIL);
    }
    case Fn.codec_HwOpusMsFini: {
      const s = opus.softDel(K(0));
      if (s) { const f = opus.sdk(opus.S.MsFini); if (f) guestCall(f, s); opus.softFree(s); }
      return RET_VOID;
    }
    case Fn.codec_HwOpusMsRate: case Fn.codec_HwOpusMsCh: case Fn.codec_HwOpusMsTotal: case Fn.codec_HwOpusMsStereo: {
      const s = opus.softOf(K(0));
      const f = s ? opus.sdk(fn == Fn.codec_HwOpusMsRate ? opus.S.MsRate : fn == Fn.codec_HwOpusMsCh ? opus.S.MsCh : fn == Fn.codec_HwOpusMsTotal ? opus.S.MsTotal : opus.S.MsStereo) : 0;
      return ret(f ? guestCall(f, s) : 0);
    }
    case Fn.codec_HwOpusMsReset: { const s = opus.softOf(K(0)), f = s ? opus.sdk(opus.S.MsReset) : 0; if (f) guestCall(f, s); return RET_VOID; }
    case Fn.codec_HwOpusMsDecode: {
      const s = opus.softOf(K(0)), f = s ? opus.sdk(opus.S.MsDecode) : 0;
      return ret(f ? guestCall(f, s, X(1), X(2), X(3), X(4), X(5), X(6)) : RES_FAIL);
    }
    case Fn.codec_HwOpusMsTime: return ret(0);   // nn::TimeSpan: no hardware decode time
    // ---------- SDK 21's decoder manager ----------
    case Fn.codec_HwOpusMgrWorkSize: return ret(opus.mgrWorkSize());
    case Fn.codec_HwOpusMgrInit: return ret(opus.mgrInit(P(0), P(1), I(5), I(6)));   // (manager, event, rate, channels, frame, decoders, I/O buffers, buffer, size)
    case Fn.codec_HwOpusMgrFini: opus.mgrFini(P(0)); return RET_VOID;
    case Fn.codec_HwOpusMgrFreeIo: return ret(<u64>opus.mgrFreeIo(P(0)));
    case Fn.codec_HwOpusMgrDecInit: return ret(opus.decInit(K(0), I(1), I(2), P(4)));   // (decoder, rate, channels, frame, manager)
    case Fn.codec_HwOpusEnqueue: return ret(opus.enqueue(K(0), P(1), P(2), X(3)));
    case Fn.codec_HwOpusExecute: return ret(opus.execute(P(0)));
    case Fn.codec_HwOpusDequeue: return ret(opus.dequeue(K(0), P(1), P(2), X(3)));
    case Fn.codec_HwOpusWaiting: return ret(<u64>opus.count(K(0), 0));
    case Fn.codec_HwOpusExecuting: return ret(<u64>opus.count(K(0), 1));
    case Fn.codec_HwOpusCompleted: return ret(<u64>opus.count(K(0), 2));
  }
  red(); puts("audio: audio_call with function id "); putu(fn); puts(", which audio_lookup never gave out"); end();
  return ret(0);
}
// Every id has a case above: checked by the tests, which call each one
export function fnCount(): u32 { return FN_COUNT; }
