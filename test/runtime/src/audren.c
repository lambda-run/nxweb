// nn::audio's audio renderer through the runtime. The "game" below opens a renderer the way a game does (for the
// DSP, with an event), starts two PCM16 voices with queued wave buffers, a pitch and a volume per side each, and
// then lives on the renderer's event: one RequestUpdate per rendered frame, taking back the wave buffers the
// renderer reports as consumed. The renderer is this module's stand-in SDK (ren_sdk.h); the host switches it to
// CPU rendering with manual execution, drives it from a render thread it starts, and takes the DeviceSink's samples.
#include "ren_sdk.h"
u32 mutex_slow;
IMPORT u32 audren_frames(void);    // the test: how many renderer events to live for after the last buffer came back
IMPORT u32 audren_rounds(void);    // and how many times to open and close; + 0x100: hold the update lock for 12 ms in each round

#define REV(n) (0x00564552u | (u32)('0' + (n)) << 24)
// The two voices' samples, by an integer resonator (s[n] = (k s[n-1] >> 14) - s[n-2]): the test computes the same
#define A_FRAMES 2160              // voice A: three wave buffers of 480, 720 and 960 frames, played as they are
#define B_FRAMES 2400              // voice B: two of 1200, played at 1.5 times the pitch
static short wave_a[A_FRAMES], wave_b[B_FRAMES];
static void resonate(short *p, int n, int k, int first) { int s2 = 0, s1 = first; p[0] = 0; for (int i = 1; i < n; i++) { p[i] = (short)s1; int s = ((k * s1) >> 14) - s2; s2 = s1; s1 = s; } }
static WaveBuffer wa[3], wb[2];
static u8 work[0x80000] __attribute__((aligned(0x1000)));
static AudioRendererHandle h;

static int round_(u32 round, u32 tail, u32 hold) {
  SystemEventType ev;   // on the stack, as a game may have it: the renderer must not keep its address
  ev.created = 0;
  AudioRendererParameter p;
  for (u32 i = 0; i < sizeof p; i++) ((u8 *)&p)[i] = 0;
  p.rate = 48000; p.sample_count = 240; p.mix_buffers = 3; p.voices = NVOICE; p.sinks = 1; p.revision = REV(8);
  p.device = 0; p.mode = 0;   // the DSP, automatic: what a game asks for
  u64 need = ar_WorkBufferSize(&p);
  Line l; l.n = 0;
  if (!round) { l_s(&l, "GetAudioRendererWorkBufferSize "); l_x(&l, need); l_s(&l, " (the SDK's own for its CPU renderer: "); l_x(&l, ar_work_bytes(&p)); l_s(&l, ")"); l_out(&l); }
  if (need > sizeof work) return 2;
  Result rc = ar_OpenEv(&h, &ev, &p, work, need);
  if (!round) {
    l_s(&l, "OpenAudioRenderer rc "); l_x(&l, rc); l_s(&l, "; the SDK was opened "); l_u(&l, ar_open_calls); l_s(&l, " time with device "); l_u(&l, ar_open_device); l_s(&l, " mode "); l_u(&l, ar_open_mode);
    l_s(&l, ar_event_seen == &ev ? "; [RED] the SDK keeps the game's event" : "; the SDK keeps an event of the host's"); l_s(&l, ev.created && !ev.writable && ev.readable ? ", the game's has a read end attached" : ", [RED] the game's event is not attached");
    l_s(&l, "; render thread priority "); l_u(&l, os_thread_prio); l_out(&l);
  }
  if (rc) return 3;
  ren_start(h);
  int a = ren_voice_acquire(h), b = ren_voice_acquire(h);
  ren_voice_volume(h, a, 0x8000, 0x4000); ren_voice_pitch(h, a, 0x10000);
  ren_voice_volume(h, b, 0x2000, 0x6000); ren_voice_pitch(h, b, 0x18000);
  static const u32 alen[3] = { 480, 720, 960 };
  for (u32 i = 0, at = 0; i < 3; at += alen[i], i++) { wa[i].data = wave_a + at; wa[i].size = alen[i] * 2; if (!ren_voice_append(h, a, &wa[i])) return 4; }
  for (u32 i = 0; i < 2; i++) { wb[i].data = wave_b + 1200 * i; wb[i].size = 2400; if (!ren_voice_append(h, b, &wb[i])) return 4; }
  ren_voice_play(h, a, 1); ren_voice_play(h, b, 1);
  rc = ren_request_update(h);
  if (rc) return 5;
  // as a game's own thread inside RequestUpdate would: the render thread meets the lock held, inside the SDK's code
  if (hold) { os_SdkMutexLock(&h.impl->sys.update_lock); svcSleepThread(12000000); os_SdkMutexUnlock(&h.impl->sys.update_lock); }
  // one update per renderer event; the frame (counted from the first update) in which each wave buffer came back
  u32 frame = 0, back = 0, order_ok = 1, when[5] = { 0, 0, 0, 0, 0 }, last = 0;
  u64 t0 = svcGetSystemTick();
  while (frame < last + tail || back < 5) {
    os_wait_event(&ev);
    frame++;
    if (ren_request_update(h)) return 6;
    const WaveBuffer *w;
    while ((w = ren_voice_released(h, a)) != 0) { u32 k = (u32)(w - wa); if (k > 2 || back >= 5) return 7; when[k] = frame; back++; last = frame; if (k && !when[k - 1]) order_ok = 0; }
    while ((w = ren_voice_released(h, b)) != 0) { u32 k = (u32)(w - wb); if (k > 1 || back >= 5) return 7; when[3 + k] = frame; back++; last = frame; }
    if (frame > 400) return 8;
  }
  u64 ticks = svcGetSystemTick() - t0;
  if (!round) {
    l_s(&l, "audren: 5 wave buffers of 2 voices came back consumed, in order "); l_s(&l, order_ok ? "yes" : "[RED] no"); l_s(&l, "; at renderer events");
    for (int i = 0; i < 5; i++) { l_c(&l, ' '); l_u(&l, when[i]); }
    l_s(&l, "; "); l_u(&l, frame); l_s(&l, " events in "); l_u(&l, ticks * 625 / 12 / 1000); l_s(&l, " us of guest time"); l_out(&l);
  }
  ren_voice_play(h, a, 0); ren_voice_play(h, b, 0); ren_stop(h);
  ren_request_update(h);
  AudioRenderSystem *s = &h.impl->sys;
  u32 renders = s->generated, updates = s->updates;
  ar_Close(h);
  os_DestroySystemEvent(&ev);   // the game's copy of the read end
  if (!round) {
    l_s(&l, "CloseAudioRenderer: the SDK's close ran "); l_u(&l, ar_close_calls); l_s(&l, " time after "); l_u(&l, renders); l_s(&l, " renders and "); l_u(&l, updates); l_s(&l, " updates; render threads created ");
    l_u(&l, os_threads_created); l_s(&l, " destroyed "); l_u(&l, os_threads_destroyed); l_s(&l, ", stacks "); l_u(&l, heap_allocs); l_s(&l, " freed "); l_u(&l, heap_frees); l_out(&l);
  }
  return 0;
}

int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  resonate(wave_a, A_FRAMES, 32714, 471);    // about 440 Hz at 48 kHz, amplitude about 8200
  resonate(wave_b, B_FRAMES, 32671, 499);    // about 587 Hz, amplitude about 6500; 880 Hz as played
  u32 rounds = audren_rounds() & 0xff, hold = audren_rounds() & 0x100, tail = audren_frames();
  for (u32 r = 0; r < rounds; r++) { int rc = round_(r, tail, hold); if (rc) { say_u("audren: failed at step ", (u64)rc); return rc; } }
  Line l; l.n = 0;
  l_s(&l, "audren: "); l_u(&l, rounds); l_s(&l, " rounds; events created "); l_u(&l, os_events_created); l_s(&l, " destroyed "); l_u(&l, os_events_destroyed); l_s(&l, "; threads "); l_u(&l, os_threads_created); l_s(&l, " / "); l_u(&l, os_threads_destroyed);
  l_s(&l, "; update lock taken "); l_u(&l, os_lock_calls); l_s(&l, " times, "); l_u(&l, mutex_slow); l_s(&l, " through the kernel"); l_out(&l);
  return 0;
}
