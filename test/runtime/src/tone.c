// nn::audio through the runtime: opens an AudioOut with a buffer-released SystemEvent, keeps four buffers of a
// generated 440 Hz tone in flight, appends the next one each time one comes back (driven by the event), and exits
// after tone_buffers() buffers. The nn::os SystemEvent side is this guest's own tiny nn::os: the take-over table binds
// the event by calling the "SDK's" CreateSystemEvent, as nxnative does.
#include "rt.h"
u32 mutex_slow;

// ---- what an SDK's nn::os provides (the layout of SystemEventType is the SDK's business) ----
typedef struct { Handle readable, writable; u32 auto_clear, created; } SystemEventType;
EXPORT Result nn_os_CreateSystemEvent(SystemEventType *e, int clear_mode, int inter_process) __asm__("_ZN2nn2os17CreateSystemEventEPNS0_15SystemEventTypeENS0_14EventClearModeEb");
EXPORT Handle nn_os_GetWritableHandleOfSystemEvent(const SystemEventType *e) __asm__("_ZN2nn2os30GetWritableHandleOfSystemEventEPKNS0_15SystemEventTypeE");
Result nn_os_CreateSystemEvent(SystemEventType *e, int clear_mode, int inter_process) {
  Result rc = svcCreateEvent(&e->writable, &e->readable);
  e->auto_clear = clear_mode == 1; e->created = rc == 0;
  return rc;
}
Handle nn_os_GetWritableHandleOfSystemEvent(const SystemEventType *e) { return e->writable; }
static void wait_event(SystemEventType *e) {
  s32 idx = -1;
  svcWaitSynchronization(&idx, &e->readable, 1, -1);
  if (e->auto_clear) svcResetSignal(e->readable);
}

// ---- nn::audio ----
typedef struct { u8 b[0x100]; } AudioOut;
typedef struct { void *data; u64 size, data_size; u8 rest[0x28]; } AudioOutBuffer;
typedef struct { s32 rate; unsigned short channels, reserved; } AudioOutParameter;
IMPORT void au_InitParam(AudioOutParameter *p) __asm__("_ZN2nn5audio27InitializeAudioOutParameterEPNS0_17AudioOutParameterE");
IMPORT Result au_OpenDefault(AudioOut *o, SystemEventType *ev, const AudioOutParameter *p) __asm__("_ZN2nn5audio19OpenDefaultAudioOutEPNS0_8AudioOutEPNS_2os11SystemEventERKNS0_17AudioOutParameterE");
IMPORT Result au_Start(AudioOut *o) __asm__("_ZN2nn5audio13StartAudioOutEPNS0_8AudioOutE");
IMPORT void au_Stop(AudioOut *o) __asm__("_ZN2nn5audio12StopAudioOutEPNS0_8AudioOutE");
IMPORT void au_Close(AudioOut *o) __asm__("_ZN2nn5audio13CloseAudioOutEPNS0_8AudioOutE");
IMPORT void au_SetBuf(AudioOutBuffer *b, void *data, u64 size, u64 data_size) __asm__("_ZN2nn5audio21SetAudioOutBufferInfoEPNS0_14AudioOutBufferEPvmm");
IMPORT int au_Append(AudioOut *o, AudioOutBuffer *b) __asm__("_ZN2nn5audio20AppendAudioOutBufferEPNS0_8AudioOutEPNS0_14AudioOutBufferE");
IMPORT AudioOutBuffer *au_Released(AudioOut *o) __asm__("_ZN2nn5audio25GetReleasedAudioOutBufferEPNS0_8AudioOutE");
IMPORT int au_Rate(const AudioOut *o) __asm__("_ZN2nn5audio21GetAudioOutSampleRateEPKNS0_8AudioOutE");
IMPORT int au_Channels(const AudioOut *o) __asm__("_ZN2nn5audio23GetAudioOutChannelCountEPKNS0_8AudioOutE");
IMPORT float au_GetVolume(const AudioOut *o) __asm__("_ZN2nn5audio17GetAudioOutVolumeEPKNS0_8AudioOutE");
IMPORT const char *au_Name(const AudioOut *o) __asm__("_ZN2nn5audio15GetAudioOutNameEPKNS0_8AudioOutE");
struct tm_ { int sec, min, hour, mday, mon, year, wday, yday, isdst; };
IMPORT struct tm_ *localtime(const s64 *t);
IMPORT u32 tone_buffers(void);    // the test: how many buffers to play

#define FRAMES 240                 // 5 ms at 48 kHz
#define INFLIGHT 4
static short pcm[INFLIGHT][FRAMES * 2] __attribute__((aligned(0x1000)));
static AudioOutBuffer bufs[INFLIGHT];
static AudioOut out;
static SystemEventType released;
// a 440 Hz sine by its recurrence s[n] = 2 cos(w) s[n-1] - s[n-2], amplitude 0.5: the same samples whoever runs it
static double s1, s2; static const double K = 2.0 * 0.9983418166140283 /* cos(2 pi 440 / 48000) */;
static void fill(short *p) {
  for (int i = 0; i < FRAMES; i++) {
    double s = K * s1 - s2; s2 = s1; s1 = s;
    short v = (short)(s * 32767.0);   /* amplitude 0.5 of full scale */
    p[2 * i] = v; p[2 * i + 1] = v;
  }
}

int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  u32 total = tone_buffers(), appended = 0, back = 0, wakes = 0;
  s2 = -0.5 * 0.057564026959567284 /* sin(2 pi 440 / 48000) */; s1 = 0.0;   // s[-1] = -A sin(w), s[0] = 0
  AudioOutParameter p; au_InitParam(&p);
  Result rc = au_OpenDefault(&out, &released, &p);
  Line l; l.n = 0;
  l_s(&l, "OpenDefaultAudioOut rc "); l_x(&l, rc); l_s(&l, ", "); l_u(&l, (u64)au_Rate(&out)); l_s(&l, " Hz, "); l_u(&l, (u64)au_Channels(&out)); l_s(&l, " channels, volume x1000 ");
  l_u(&l, (u64)(au_GetVolume(&out) * 1000.0f)); l_s(&l, released.created ? ", the event was created by this module's nn::os" : ", no event"); l_out(&l);
  if (rc) return 1;
  // pointers the host hands out into its own static data (the device's name, localtime's struct tm): readable by the
  // guest although they lie in the host area
  const char *name = au_Name(&out); s64 when = 86400 * 400;
  l_s(&l, "the output's name: "); l_s(&l, name); l_s(&l, "; localtime of day 400: year "); l_d(&l, 1900 + localtime(&when)->year); l_out(&l);
  for (int i = 0; i < INFLIGHT && appended < total; i++) { fill(pcm[i]); au_SetBuf(&bufs[i], pcm[i], sizeof pcm[i], sizeof pcm[i]); if (au_Append(&out, &bufs[i])) appended++; }
  say_x("StartAudioOut rc ", au_Start(&out));
  u64 t0 = svcGetSystemTick(), last = t0, worst = 0;
  while (back < total) {
    wait_event(&released);
    wakes++;
    AudioOutBuffer *b;
    while ((b = au_Released(&out)) != 0) {
      back++;
      u64 now = svcGetSystemTick(); if (now - last > worst) worst = now - last; last = now;
      if (appended < total) { fill((short *)b->data); au_Append(&out, b); appended++; }
    }
  }
  u64 ticks = svcGetSystemTick() - t0;
  au_Stop(&out); au_Close(&out);
  l_s(&l, "tone: "); l_u(&l, back); l_s(&l, " buffers came back in "); l_u(&l, wakes); l_s(&l, " wake-ups, "); l_u(&l, ticks * 625 / 12 / 1000); l_s(&l, " us of guest time, the longest gap ");
  l_u(&l, worst * 625 / 12 / 1000); l_s(&l, " us"); l_out(&l);
  return 0;
}
