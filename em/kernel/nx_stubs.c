// nxem: stand-ins for the parts of nxnative that are not in the build yet (weak: the real file wins when it is ported).
//   - the PCM output hle_audren.c renders into (hle_audio.c: CoreAudio): a silent sink that takes each 5 ms buffer in
//     real time, so the renderer thread is paced as by a sound card. No sound.
//   - presentation and front-end hooks hle_vi.c and others call (nvn_mtl.m, front_mac.m): the counts come from nxweb's
//     recorder on the owner thread where there is one, else zero.
#include "dm.h"
#include "nx_port.h"
#include "nx_guest.h"
#include <unistd.h>

enum { PCM_Q = 64, PCM_NS = 5000000 };
typedef struct { pthread_mutex_t mu; void *q[PCM_Q]; uint64_t end[PCM_Q]; int head, n; uint64_t last_end; } pcm_t;
__attribute__((weak)) void *dm_pcmout_open(int ch) { (void)ch; pcm_t *p = calloc(1, sizeof *p); pthread_mutex_init(&p->mu, NULL); static int once; if (!once++) LOG("audio: no output device in this build: a silent sink takes the renderer's buffers in real time"); return p; }
__attribute__((weak)) void dm_pcmout_start(void *k) { pcm_t *p = k; p->last_end = now_ns(); }
__attribute__((weak)) void dm_pcmout_close(void *k) { free(k); }
__attribute__((weak)) int dm_pcmout_append(void *k, void *b) {
    pcm_t *p = k; int ok = 0;
    pthread_mutex_lock(&p->mu);
    if (p->n < PCM_Q) { uint64_t now = now_ns(), start = p->n && p->last_end > now ? p->last_end : now; int i = (p->head + p->n++) % PCM_Q; p->q[i] = b; p->end[i] = p->last_end = start + PCM_NS; ok = 1; }
    pthread_mutex_unlock(&p->mu);
    return ok;
}
__attribute__((weak)) void *dm_pcmout_released(void *k) {
    pcm_t *p = k; void *b = NULL;
    pthread_mutex_lock(&p->mu);
    if (p->n && now_ns() >= p->end[p->head]) { b = p->q[p->head]; p->head = (p->head + 1) % PCM_Q; p->n--; }
    pthread_mutex_unlock(&p->mu);
    return b;
}
__attribute__((weak)) void dm_pcmout_wait(void *k, int ms) {
    pcm_t *p = k; uint64_t now = now_ns(), until = now + (uint64_t)ms * 1000000ull;
    pthread_mutex_lock(&p->mu); if (p->n && p->end[p->head] < until) until = p->end[p->head]; pthread_mutex_unlock(&p->mu);
    if (until > now) { struct timespec ts = {0, (long)(until - now)}; if (ts.tv_nsec > 999999999) ts.tv_nsec = 999999999; nanosleep(&ts, 0); }
}
__attribute__((weak)) void dm_audio_suspend(int on) { (void)on; }
__attribute__((weak)) void dm_gfx_suspend(int on) { (void)on; }
__attribute__((weak)) void dm_backtrace(uint64_t fp) { (void)fp; }
__attribute__((weak)) void mtl_present_layer(uint32_t w, uint32_t h) { LOG("vi: layer %ux%u (not passed on to the replayer yet)", w, h); }
// presents queued / shown: nxweb's recorder counts them (owner/owner.ts); with the null replayer a present is shown at once
static uint64_t presents(void) { double os[12] = {0}; nx_owner_stats((double)(uintptr_t)os); return (uint64_t)os[7]; }
__attribute__((weak)) uint64_t dm_nvn_frame_count(void) { return presents(); }
__attribute__((weak)) void mtl_present_progress(uint64_t *queued, uint64_t *done) { uint64_t n = presents(); *queued = n; *done = n; }
__attribute__((weak)) double mtl_presented_time(uint64_t n) { (void)n; return now_ns() / 1e9; }
