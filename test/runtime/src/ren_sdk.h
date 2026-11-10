// A stand-in for the parts of a game's SDK that the host's audio renderer take-overs drive (src/audio/ren.ts, port
// of nxnative dm/host/hle_audren.c). nxnative has no renderer of its own: it opens the SDK's renderer for CPU
// rendering with manual execution and runs it. There is no SDK in this repository, so the test guest brings this:
// a small renderer with the SDK's entry points, calling conventions and the command list's SDK 16 wire layout as
// the host reads it, and behind them the least that makes sound (PCM16 voices with a wave buffer queue, pitch by
// sample stepping, a volume per output channel, a mix into two buffers, a DeviceSink). Nothing here is a port of
// SDK code; the mangled names are the ones the host looks up.
//   host -> SDK  OpenAudioRenderer (both forms), CloseAudioRenderer, GetAudioRendererWorkBufferSize,
//                ExecuteAudioRendererRendering, AudioRenderSystem::{GetExecutionMode, GetRenderingDevice,
//                GetCommandBufferWorkBuffer, GetCommandBufferWorkBufferSize, GenerateCommand, Update},
//                CommandListProcessor::{SetProcessTimeMax, Setup, Process}, SdkMutexType::{Lock, Unlock},
//                nn::os SystemEvent and Thread functions, malloc, free
//   SDK -> host  through the PLT, where the loader binds the host's take-over: OpenAudioRenderer (the event form
//                opens through the form without one, as SDK 17 does), AudioRendererImpl::ExecuteAudioRendererRendering,
//                AudioRenderSystem::Update
#include "rt.h"

// ---- nn::os: system events ----
typedef struct { Handle readable, writable; u32 auto_clear, created, managed; } SystemEventType;
EXPORT Result os_CreateSystemEvent(SystemEventType *e, int clear_mode, int inter_process) __asm__("_ZN2nn2os17CreateSystemEventEPNS0_15SystemEventTypeENS0_14EventClearModeEb");
EXPORT void os_DestroySystemEvent(SystemEventType *e) __asm__("_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE");
EXPORT Handle os_GetWritableHandle(const SystemEventType *e) __asm__("_ZN2nn2os30GetWritableHandleOfSystemEventEPKNS0_15SystemEventTypeE");
EXPORT Handle os_GetReadableHandle(const SystemEventType *e) __asm__("_ZN2nn2os30GetReadableHandleOfSystemEventEPKNS0_15SystemEventTypeE");
EXPORT void os_AttachReadableHandle(SystemEventType *e, Handle h, int managed, int clear_mode) __asm__("_ZN2nn2os33AttachReadableHandleToSystemEventEPNS0_15SystemEventTypeEjbNS0_14EventClearModeE");
EXPORT void os_SignalSystemEvent(SystemEventType *e) __asm__("_ZN2nn2os17SignalSystemEventEPNS0_15SystemEventTypeE");
u32 os_events_created, os_events_destroyed;
Result os_CreateSystemEvent(SystemEventType *e, int clear_mode, int inter_process) {
  Result rc = svcCreateEvent(&e->writable, &e->readable);
  e->auto_clear = clear_mode == 1; e->created = rc == 0; e->managed = 1;
  if (!rc) os_events_created++;
  return rc;
}
void os_DestroySystemEvent(SystemEventType *e) {
  if (!e->created) return;
  if (e->writable) svcCloseHandle(e->writable);
  if (e->readable && e->managed) svcCloseHandle(e->readable);
  e->readable = e->writable = 0; e->created = 0;
  os_events_destroyed++;
}
Handle os_GetWritableHandle(const SystemEventType *e) { return e->writable; }
Handle os_GetReadableHandle(const SystemEventType *e) { return e->readable; }
void os_AttachReadableHandle(SystemEventType *e, Handle h, int managed, int clear_mode) { e->readable = h; e->writable = 0; e->managed = (u32)managed; e->auto_clear = clear_mode == 1; e->created = 1; }
void os_SignalSystemEvent(SystemEventType *e) { svcSignalEvent(e->writable); }
static void os_wait_event(SystemEventType *e) {
  s32 idx = -1;
  svcWaitSynchronization(&idx, &e->readable, 1, -1);
  if (e->auto_clear) svcResetSignal(e->readable);
}

// ---- nn::os: the SDK's mutex (the audio renderer's update lock is one) ----
EXPORT void os_SdkMutexLock(Mutex *m) __asm__("_ZN2nn2os12SdkMutexType4LockEv");
EXPORT void os_SdkMutexUnlock(Mutex *m) __asm__("_ZN2nn2os12SdkMutexType6UnlockEv");
u32 os_lock_calls;
void os_SdkMutexLock(Mutex *m) { os_lock_calls++; mutex_lock(m); }
void os_SdkMutexUnlock(Mutex *m) { mutex_unlock(m); }

// ---- nn::os: threads, and the allocator the host takes a thread's stack from ----
typedef struct { Handle h; void (*fn)(void *); void *arg; u32 started, ended; } ThreadType;
EXPORT Result os_CreateThread(ThreadType *t, void (*fn)(void *), void *arg, void *stack, u64 stack_size, int prio) __asm__("_ZN2nn2os12CreateThreadEPNS0_10ThreadTypeEPFvPvES3_S3_mi");
EXPORT void os_StartThread(ThreadType *t) __asm__("_ZN2nn2os11StartThreadEPNS0_10ThreadTypeE");
EXPORT void os_WaitThread(ThreadType *t) __asm__("_ZN2nn2os10WaitThreadEPNS0_10ThreadTypeE");
EXPORT void os_DestroyThread(ThreadType *t) __asm__("_ZN2nn2os13DestroyThreadEPNS0_10ThreadTypeE");
EXPORT void *malloc(u64 n);
EXPORT void free(void *p);
u32 os_threads_created, os_threads_destroyed, os_thread_prio;
static void os_thread_main(void *p) { ThreadType *t = p; set_self_handle(t->h); t->fn(t->arg); t->ended = 1; svcExitThread(); }
Result os_CreateThread(ThreadType *t, void (*fn)(void *), void *arg, void *stack, u64 stack_size, int prio) {
  t->fn = fn; t->arg = arg; t->started = t->ended = 0;
  os_thread_prio = (u32)prio;
  Result rc = svcCreateThread(&t->h, os_thread_main, t, (u8 *)stack + stack_size, prio, -2);
  if (!rc) os_threads_created++;
  return rc;
}
void os_StartThread(ThreadType *t) { t->started = 1; svcStartThread(t->h); }
void os_WaitThread(ThreadType *t) { s32 idx = -1; svcWaitSynchronization(&idx, &t->h, 1, -1); }
void os_DestroyThread(ThreadType *t) { svcCloseHandle(t->h); t->h = 0; os_threads_destroyed++; }
#define HEAP_BLOCK 0x11000
static u8 heap_pool[4][HEAP_BLOCK] __attribute__((aligned(0x1000)));
static u8 heap_used[4];
u32 heap_allocs, heap_frees;
void *malloc(u64 n) {
  if (n > HEAP_BLOCK) return 0;
  for (int i = 0; i < 4; i++) if (!heap_used[i]) { heap_used[i] = 1; heap_allocs++; return heap_pool[i]; }
  return 0;
}
void free(void *p) { for (int i = 0; i < 4; i++) if (p == heap_pool[i] && heap_used[i]) { heap_used[i] = 0; heap_frees++; } }

// ---- nn::audio: the renderer ----
typedef struct {
  s32 rate, sample_count, mix_buffers, submixes, voices, sinks, effects, perf;
  u8 voice_drop, pad[3];
  s32 splitters, splitter_dest, device, mode;   // +0x2c rendering device (0 DSP, 1 CPU), +0x30 execution mode (0 automatic, 1 manual)
  u32 revision, pad2[2];
} AudioRendererParameter;
_Static_assert(__builtin_offsetof(AudioRendererParameter, device) == 0x2c && __builtin_offsetof(AudioRendererParameter, revision) == 0x34 && sizeof(AudioRendererParameter) == 0x40, "the parameter's layout");

#define NVOICE 4
#define NWAVE 8
#define SCRATCH_BUFFER 2     // the mix buffer a voice is decoded into; 0 and 1 are the DeviceSink's inputs
typedef struct {
  u32 used, playing, pitch;          // pitch: source frames per output frame, Q16
  s32 vol[2];                        // Q15, per output channel
  const short *data[NWAVE]; u32 frames[NWAVE]; u32 head, count;   // the wave buffer queue
  u32 pos, frac;                     // where in the head buffer the next output frame reads
  u32 consumed;                      // wave buffers played to the end
} ServerVoice;
typedef struct {
  u8 pad0[0x48];
  s32 device, mode;                  // +0x48, +0x4c
  u8 *command_buffer; u64 command_size;
  s32 *mix; s32 rate, samples, mix_buffers;
  u32 started, renders, updates, generated;
  u8 pad1[0x1d8 - 0x84];
  Mutex update_lock;                 // +0x1d8: the host reads the offset off Update's first instructions
  u32 pad2;
  ServerVoice voice[NVOICE];
} AudioRenderSystem;
_Static_assert(__builtin_offsetof(AudioRenderSystem, update_lock) == 0x1d8, "the update lock's offset");
typedef struct { u8 head[0x60]; AudioRenderSystem sys; } AudioRendererImpl;   // the system sits at +0x60, read off ExecuteAudioRendererRendering
// what the client keeps and RequestUpdate sends: the voices' parameters and the wave buffers appended since
typedef struct { const short *data; u64 size; } WaveBuffer;                  // size in bytes
typedef struct { u32 used, playing, pitch; s32 vol[2]; u32 nnew; const short *data[NWAVE]; u32 frames[NWAVE]; } VoiceIn;
typedef struct { u32 nvoices, started; VoiceIn v[NVOICE]; } UpdateIn;
typedef struct { u32 consumed[NVOICE]; } UpdateOut;
typedef struct {
  SystemEventType *event; AudioRendererImpl *impl; u32 started;
  VoiceIn v[NVOICE];
  const WaveBuffer *queued[NVOICE][NWAVE]; u32 qhead[NVOICE], qcount[NVOICE], released[NVOICE], seen[NVOICE];
} ClientState;
typedef struct { AudioRendererImpl *impl; ClientState *state; } AudioRendererHandle;   // two words: passed in x0 and x1

#define COMMAND_BYTES 0x2000
#define CMD_MAGIC 0xcafebabeu
enum { CMD_CLEAR = 1, CMD_PCM16 = 2, CMD_MIX = 3, CMD_DEVICE_SINK = 0x13 };
#define RESULT_NOT_MANUAL 0x40299u
#define RESULT_BAD_PARAM 0x499u

EXPORT u64 ar_WorkBufferSize(const AudioRendererParameter *p) __asm__("_ZN2nn5audio30GetAudioRendererWorkBufferSizeERKNS0_22AudioRendererParameterE");
EXPORT Result ar_OpenEv(AudioRendererHandle *h, SystemEventType *ev, const AudioRendererParameter *p, void *work, u64 size) __asm__("_ZN2nn5audio17OpenAudioRendererEPNS0_19AudioRendererHandleEPNS_2os11SystemEventERKNS0_22AudioRendererParameterEPvm");
EXPORT Result ar_Open(AudioRendererHandle *h, const AudioRendererParameter *p, void *work, u64 size) __asm__("_ZN2nn5audio17OpenAudioRendererEPNS0_19AudioRendererHandleERKNS0_22AudioRendererParameterEPvm");
EXPORT void ar_Close(AudioRendererHandle h) __asm__("_ZN2nn5audio18CloseAudioRendererENS0_19AudioRendererHandleE");
EXPORT Result ar_Execute(AudioRendererHandle h) __asm__("_ZN2nn5audio29ExecuteAudioRendererRenderingENS0_19AudioRendererHandleE");
EXPORT Result ar_ImplExecute(AudioRendererImpl *impl) __asm__("_ZN2nn5audio6server24AudioRendererManagerImpl17AudioRendererImpl29ExecuteAudioRendererRenderingEv");
EXPORT s32 ars_GetExecutionMode(const AudioRenderSystem *s) __asm__("_ZNK2nn5audio6server17AudioRenderSystem16GetExecutionModeEv");
EXPORT s32 ars_GetRenderingDevice(const AudioRenderSystem *s) __asm__("_ZNK2nn5audio6server17AudioRenderSystem18GetRenderingDeviceEv");
EXPORT u8 *ars_GetCommandBuffer(const AudioRenderSystem *s) __asm__("_ZNK2nn5audio6server17AudioRenderSystem26GetCommandBufferWorkBufferEv");
EXPORT u64 ars_GetCommandBufferSize(const AudioRenderSystem *s) __asm__("_ZNK2nn5audio6server17AudioRenderSystem30GetCommandBufferWorkBufferSizeEv");
EXPORT u64 ars_GenerateCommand(AudioRenderSystem *s, u8 *buf, u64 size) __asm__("_ZN2nn5audio6server17AudioRenderSystem15GenerateCommandEPvm");
EXPORT Result ars_Update(AudioRenderSystem *s, void *out, u64 out_size, void *perf, u64 perf_size, const void *in, u64 in_size) __asm__("_ZN2nn5audio6server17AudioRenderSystem6UpdateEPvmS3_mPKvm");
typedef struct { const u8 *list; u64 size; u32 time_max, processed; } CommandListProcessor;
EXPORT void clp_SetProcessTimeMax(CommandListProcessor *c, u32 t) __asm__("_ZN2nn5audio3dsp20CommandListProcessor17SetProcessTimeMaxEj");
EXPORT void clp_Setup(CommandListProcessor *c, const void *list, u64 size) __asm__("_ZN2nn5audio3dsp20CommandListProcessor5SetupEPKvm");
EXPORT void clp_Process(CommandListProcessor *c) __asm__("_ZN2nn5audio3dsp20CommandListProcessor7ProcessEv");

static u64 ar_mix_bytes(const AudioRendererParameter *p) { return (u64)p->mix_buffers * (u64)p->sample_count * 4; }
static u64 ar_work_bytes(const AudioRendererParameter *p) { return (sizeof(AudioRendererImpl) + sizeof(ClientState) + ar_mix_bytes(p) + COMMAND_BYTES + 0xfff) & ~0xfffull; }
u64 ar_WorkBufferSize(const AudioRendererParameter *p) { return ar_work_bytes(p); }
u32 ar_open_calls, ar_open_device, ar_open_mode;
SystemEventType *ar_event_seen;
// The form without an event does the work. This stand-in has only the CPU renderer with manual execution: an open
// for the DSP (what a game asks for) fails here, as a sign that the host did not ask for what it runs
Result ar_Open(AudioRendererHandle *h, const AudioRendererParameter *p, void *work, u64 size) {
  ar_open_calls++; ar_open_device = (u32)p->device; ar_open_mode = (u32)p->mode;
  if (p->device != 1 || p->mode != 1 || p->mix_buffers <= SCRATCH_BUFFER || p->sample_count <= 0 || p->sample_count > 1024) return RESULT_BAD_PARAM;
  if (!work || size < ar_work_bytes(p)) return RESULT_BAD_PARAM;
  u8 *w = work;
  for (u64 i = 0, n = ar_work_bytes(p); i < n; i++) w[i] = 0;
  AudioRendererImpl *impl = (AudioRendererImpl *)w; w += sizeof *impl;
  ClientState *st = (ClientState *)w; w += sizeof *st;
  AudioRenderSystem *s = &impl->sys;
  s->device = p->device; s->mode = p->mode; s->rate = p->rate; s->samples = p->sample_count; s->mix_buffers = p->mix_buffers;
  s->mix = (s32 *)w; w += ar_mix_bytes(p);
  s->command_buffer = w; s->command_size = COMMAND_BYTES;
  st->impl = impl;
  h->impl = impl; h->state = st;
  return 0;
}
// The event form opens through the other one's PLT entry (the host's take-over, which must pass the inner call on)
// and then makes the renderer's event, a local one: it keeps the pointer and signals it after every render
Result ar_OpenEv(AudioRendererHandle *h, SystemEventType *ev, const AudioRendererParameter *p, void *work, u64 size) {
  Result rc = ar_Open(h, p, work, size);
  if (rc) return rc;
  rc = os_CreateSystemEvent(ev, 1, 0);
  h->state->event = ev; ar_event_seen = ev;
  return rc;
}
u32 ar_close_calls;
void ar_Close(AudioRendererHandle h) { ar_close_calls++; h.impl->sys.started = 0; h.state->impl = 0; }   // the event is not touched
// ExecuteAudioRendererRendering: render one frame (the AudioRendererImpl's function, through the PLT), then signal
Result ar_Execute(AudioRendererHandle h) {
  Result rc = ar_ImplExecute(h.impl);
  if (h.state->event) os_SignalSystemEvent(h.state->event);
  return rc;
}
// The SDK's own AudioRendererImpl::ExecuteAudioRendererRendering: `this` + 0x60 and on to the system's. The host
// takes the name over and reads the 0x60 off this code; the code itself never runs
Result NOINLINE __attribute__((used)) ars_not_reached(AudioRenderSystem *s) { return RESULT_NOT_MANUAL; }
__asm__(".text\n.balign 4\n.global _ZN2nn5audio6server24AudioRendererManagerImpl17AudioRendererImpl29ExecuteAudioRendererRenderingEv\n"
        ".type _ZN2nn5audio6server24AudioRendererManagerImpl17AudioRendererImpl29ExecuteAudioRendererRenderingEv, %function\n"
        "_ZN2nn5audio6server24AudioRendererManagerImpl17AudioRendererImpl29ExecuteAudioRendererRenderingEv:\n"
        "  add x0, x0, #0x60\n  b ars_not_reached\n");
s32 ars_GetExecutionMode(const AudioRenderSystem *s) { return s->mode; }
s32 ars_GetRenderingDevice(const AudioRenderSystem *s) { return s->device; }
u8 *ars_GetCommandBuffer(const AudioRenderSystem *s) { return s->command_buffer; }
u64 ars_GetCommandBufferSize(const AudioRenderSystem *s) { return s->command_size; }

// ---- command generation: the wire layout of SDK 8 to 20 ----
// list: +0x04 command count, +0x08 mix buffers, +0x10 buffer count, +0x14 samples per frame, +0x18 sample rate, commands from +0x20
// command: +0 magic, +4 enabled (u8), +5 command ID (u8), +6 size (s16); the body from +8
static u8 *cmd_put(u8 *q, int id, int size) {
  for (int i = 0; i < size; i++) q[i] = 0;
  *(u32 *)q = CMD_MAGIC; q[4] = 1; q[5] = (u8)id; *(short *)(q + 6) = (short)size;
  return q + size;
}
u64 ars_GenerateCommand(AudioRenderSystem *s, u8 *buf, u64 size) {
  for (int i = 0; i < 0x20; i++) buf[i] = 0;
  u32 n = 0; u8 *q = buf + 0x20, *c;
  c = q; q = cmd_put(q, CMD_CLEAR, 0x10); n++; (void)c;
  for (u32 v = 0; s->started && v < NVOICE; v++) {
    ServerVoice *sv = &s->voice[v];
    if (!sv->used || !sv->playing) continue;
    c = q; q = cmd_put(q, CMD_PCM16, 0x18); *(ServerVoice **)(c + 8) = sv; *(u32 *)(c + 0x10) = SCRATCH_BUFFER; n++;
    for (u32 ch = 0; ch < 2; ch++) { c = q; q = cmd_put(q, CMD_MIX, 0x18); *(u32 *)(c + 8) = SCRATCH_BUFFER; *(u32 *)(c + 0xc) = ch; *(s32 *)(c + 0x10) = sv->vol[ch]; n++; }
  }
  // DeviceSink: 0x148 bytes, +0x20 the device's name, +0x130 input count, +0x134 input indices (s16)
  c = q; q = cmd_put(q, CMD_DEVICE_SINK, 0x148); n++;
  const char *name = "MainAudioOut"; for (int i = 0; name[i]; i++) c[0x20 + i] = (u8)name[i];
  *(u32 *)(c + 0x130) = 2; *(short *)(c + 0x134) = 0; *(short *)(c + 0x136) = 1;
  *(u32 *)(buf + 4) = n; *(s32 **)(buf + 8) = s->mix; *(u32 *)(buf + 0x10) = (u32)s->mix_buffers; *(u32 *)(buf + 0x14) = (u32)s->samples; *(u32 *)(buf + 0x18) = (u32)s->rate;
  s->generated++;
  return (u64)(q - buf);
}
// ---- the CPU "DSP" ----
void clp_SetProcessTimeMax(CommandListProcessor *c, u32 t) { c->time_max = t; }
void clp_Setup(CommandListProcessor *c, const void *list, u64 size) { c->list = list; c->size = size; }
void clp_Process(CommandListProcessor *c) {
  const u8 *l = c->list;
  u32 n = *(const u32 *)(l + 4), samples = *(const u32 *)(l + 0x14);
  s32 *mix = *(s32 *const *)(l + 8);
  const u8 *q = l + 0x20;
  for (u32 i = 0; i < n; i++, q += *(const short *)(q + 6)) {
    if (!q[4]) continue;
    switch (q[5]) {
      case CMD_CLEAR: for (u32 k = 0; k < 2 * samples; k++) mix[k] = 0; break;
      case CMD_PCM16: {   // one voice into its scratch buffer: the head wave buffer's samples, stepping by the pitch
        ServerVoice *sv = *(ServerVoice *const *)(q + 8); s32 *out = mix + *(const u32 *)(q + 0x10) * samples;
        for (u32 k = 0; k < samples; k++) {
          if (!sv->count) { out[k] = 0; continue; }
          out[k] = sv->data[sv->head][sv->pos];
          sv->frac += sv->pitch; sv->pos += sv->frac >> 16; sv->frac &= 0xffff;
          while (sv->count && sv->pos >= sv->frames[sv->head]) {   // played to the end: the next one, or silence
            sv->pos -= sv->frames[sv->head]; sv->head = (sv->head + 1) % NWAVE; sv->count--; sv->consumed++;
          }
          if (!sv->count) sv->pos = sv->frac = 0;
        }
        break;
      }
      case CMD_MIX: {
        const s32 *in = mix + *(const u32 *)(q + 8) * samples; s32 *out = mix + *(const u32 *)(q + 0xc) * samples, vol = *(const s32 *)(q + 0x10);
        for (u32 k = 0; k < samples; k++) out[k] += (s32)(((s64)in[k] * vol) >> 15);
        break;
      }
      default: break;   // DeviceSink: nothing for the CPU processor; the host takes its inputs
    }
  }
  c->processed++;
}
// ---- AudioRenderSystem::Update: the game's RequestUpdate, parsed under the update lock ----
Result ars_Update(AudioRenderSystem *s, void *out, u64 out_size, void *perf, u64 perf_size, const void *in, u64 in_size) {
  os_SdkMutexLock(&s->update_lock);
  const UpdateIn *ui = in; UpdateOut *uo = out;
  Result rc = in_size >= sizeof *ui && out_size >= sizeof *uo ? 0 : RESULT_BAD_PARAM;
  if (!rc) {
    s->started = ui->started; s->updates++;
    for (u32 v = 0; v < NVOICE; v++) {
      const VoiceIn *vi = &ui->v[v]; ServerVoice *sv = &s->voice[v];
      sv->used = vi->used; sv->playing = vi->playing; sv->pitch = vi->pitch; sv->vol[0] = vi->vol[0]; sv->vol[1] = vi->vol[1];
      for (u32 k = 0; k < vi->nnew && sv->count < NWAVE; k++) { u32 at = (sv->head + sv->count) % NWAVE; sv->data[at] = vi->data[k]; sv->frames[at] = vi->frames[k]; sv->count++; }
      uo->consumed[v] = sv->consumed;
    }
  }
  os_SdkMutexUnlock(&s->update_lock);
  return rc;
}

// ---- the client side: what a game calls (nn::audio's voice API in the least form; none of it is taken over) ----
static void ren_start(AudioRendererHandle h) { h.state->started = 1; }                       // StartAudioRenderer
static void ren_stop(AudioRendererHandle h) { h.state->started = 0; }                        // StopAudioRenderer
static int ren_voice_acquire(AudioRendererHandle h) {                                        // AcquireVoiceSlot (PCM16, mono)
  for (int v = 0; v < NVOICE; v++) if (!h.state->v[v].used) { VoiceIn *vi = &h.state->v[v]; vi->used = 1; vi->playing = 0; vi->pitch = 0x10000; vi->vol[0] = vi->vol[1] = 0x8000; return v; }
  return -1;
}
static void ren_voice_play(AudioRendererHandle h, int v, int on) { h.state->v[v].playing = (u32)on; }            // SetVoicePlayState
static void ren_voice_pitch(AudioRendererHandle h, int v, u32 q16) { h.state->v[v].pitch = q16; }                // SetVoicePitch
static void ren_voice_volume(AudioRendererHandle h, int v, s32 left, s32 right) { h.state->v[v].vol[0] = left; h.state->v[v].vol[1] = right; }   // SetVoiceMixVolume
static int ren_voice_append(AudioRendererHandle h, int v, const WaveBuffer *w) {             // AppendWaveBuffer
  ClientState *st = h.state; VoiceIn *vi = &st->v[v];
  if (st->qcount[v] >= NWAVE || vi->nnew >= NWAVE) return 0;
  st->queued[v][(st->qhead[v] + st->qcount[v]) % NWAVE] = w; st->qcount[v]++;
  vi->data[vi->nnew] = w->data; vi->frames[vi->nnew] = (u32)(w->size / 2); vi->nnew++;
  return 1;
}
static const WaveBuffer *ren_voice_released(AudioRendererHandle h, int v) {                  // GetReleasedWaveBuffer
  ClientState *st = h.state;
  if (!st->released[v]) return 0;
  const WaveBuffer *w = st->queued[v][st->qhead[v]];
  st->qhead[v] = (st->qhead[v] + 1) % NWAVE; st->qcount[v]--; st->released[v]--;
  return w;
}
static Result ren_request_update(AudioRendererHandle h) {                                    // RequestUpdateAudioRenderer
  ClientState *st = h.state;
  static UpdateIn in; static UpdateOut out;
  in.nvoices = NVOICE; in.started = st->started;
  for (int v = 0; v < NVOICE; v++) { const u8 *a = (const u8 *)&st->v[v]; u8 *b = (u8 *)&in.v[v]; for (u32 i = 0; i < sizeof in.v[v]; i++) b[i] = a[i]; }
  Result rc = ars_Update(&st->impl->sys, &out, sizeof out, 0, 0, &in, sizeof in);   // through the PLT: the host's take-over
  if (rc) return rc;
  for (int v = 0; v < NVOICE; v++) { st->v[v].nnew = 0; st->released[v] += out.consumed[v] - st->seen[v]; st->seen[v] = out.consumed[v]; }
  return 0;
}
