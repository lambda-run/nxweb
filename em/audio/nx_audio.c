// nxem audio output: the PCM sink nxnative's audio renderer plays into (hle_audren.c's render thread: dm_pcmout_*,
// 48 kHz stereo int16, 240 samples per 5 ms frame; its 5.1 DeviceSink is mixed down to stereo before it gets here).
// These definitions replace the silent sink of kernel/nx_stubs.c (weak).
//
// The samples go into ONE ring in the shared memory, in the layout nxweb's AudioWorklet reads in place
// (src/glue/audio_worklet.ts, its "direct" transport): 8 Int32 header words (0 wr, 1 rd, 2 cap, 3 underrun frames,
// 4 callbacks, 5 live outputs, 6 rate, 7 target), then float32 stereo frames; this file adds words 8.. for the page
// and its status line. Single producer (the render thread, here), single consumer (the worklet, on the browser's audio
// thread): no lock, no call to the owner thread, the indices are atomics.
//
// Pacing. The render thread renders the next frame when the sink hands a block back (dm_pcmout_released):
//   - while the device runs (the worklet's callback count moves): every 5 ms of wall time, each interval stretched or
//     shortened by 2% of what the ring holds over or under its target (40 ms), so the renderer follows the device's
//     clock without drifting and still renders at an even pace however unevenly the device takes its callbacks (a
//     sound card that asks for 512 frames takes four callbacks at once); a ring more than 10 ms under the target is
//     filled at once (after a stall), one more than 15 ms over it waits for the device;
//   - while it does not (no page, before the first user gesture, the tab hidden, a context the browser suspended):
//     every 5 ms of wall time, as the silent sink did; the ring keeps only the newest target's worth (the rest is
//     counted as discarded), so sound starts with the present when the device comes.
// Underrun: the worklet plays silence and counts the frames (word 3). Overrun (a device that takes less than it
// says): the oldest frames are dropped and counted (word 9). A device rate other than 48 kHz (a browser that refused
// a 48 kHz context): resampled here, linear.
//
// Test (node, no sound card): NX_AUDIO_TEST=<file.wav> starts a consumer thread that takes 128 frames every 2.667 ms
// as a worklet would and writes the first NX_AUDIO_TEST_SECS (5) seconds from the first sample that is not silence to
// the file; NX_AUDIO_RATE=<Hz> gives that device another rate. NX_AUDIO_LOG=1 (page: ?audiolog=1): an [audio] line
// every 5 s. NX_AUDIO_TONE=<Hz> (page: ?audiotone=<Hz>): the sink writes a sine in place of the renderer's samples, so
// that a break in what arrives (a dropped, repeated or missing stretch) can be counted exactly: x[n+1] = 2cos(w)x[n] - x[n-1].
#include "dm.h"
#include "nx_port.h"
#include <stdatomic.h>
#include <math.h>
#include <unistd.h>
#include <emscripten.h>

enum { H_WR, H_RD, H_CAP, H_UNDER, H_CB, H_LIVE, H_RATE, H_TARGET,           // nxweb's worklet reads and writes these
       H_STATE, H_OVER, H_HIDDEN, H_FRAMES, H_DISCARD, H_PEAK, H_NONSILENT, H_MODE, H_FPS100, H_FILL_MIN, H_FILL_MAX, H_OPEN, H_WORDS = 32 };
enum { CAP = 16384, QN = 16, IN_RATE = 48000, FRAME_NS = 5000000, ALIVE_NS = 100000000 };
typedef struct { _Atomic int32_t h[H_WORDS]; float d[CAP * 2]; } ring_t;
static ring_t g_ring __attribute__((aligned(64)));
static _Atomic int g_target_ms = 40, g_log = -1, g_owner, g_tone = -1;
typedef struct { void *ptr; uint64_t cap, size; } gbuf;       // as hle_audren.c's
typedef struct {
    int ch, ring;                    // ring: this sink writes the ring (the first one open; another one is paced and not heard)
    gbuf *q[QN]; int head, n;        // blocks appended and not handed back yet
    uint64_t next_ns;                // wall pacing: when the next block may be handed back
    int32_t cb_seen; uint64_t cb_ns; // the worklet's callback count, and when it last moved
    double pos; float prev[2];       // resampler: position of the next output frame in the input, the last input frame
    uint64_t st_ns, log_ns, st_frames, log_frames; int peak; uint32_t fill_min, fill_max;
    double tone_ph;
} sink_t;

EMSCRIPTEN_KEEPALIVE double nx_audio_ring(void) { return (double)(uintptr_t)&g_ring; }
EMSCRIPTEN_KEEPALIVE void nx_audio_tone(int hz) { atomic_store(&g_tone, hz > 0 && hz < 20000 ? hz : 0); }
EMSCRIPTEN_KEEPALIVE void nx_audio_config(int target_ms, int log) { if (target_ms >= 10 && target_ms <= 250) atomic_store(&g_target_ms, target_ms); if (log >= 0) atomic_store(&g_log, log); }

static int dev_rate(void) { int r = atomic_load(&g_ring.h[H_RATE]); return r >= 8000 && r <= 192000 ? r : IN_RATE; }
static uint32_t fill(void) { return (uint32_t)atomic_load(&g_ring.h[H_WR]) - (uint32_t)atomic_load(&g_ring.h[H_RD]); }
static uint32_t target(void) { uint32_t t = (uint32_t)((int64_t)atomic_load(&g_target_ms) * dev_rate() / 1000); atomic_store(&g_ring.h[H_TARGET], (int32_t)t); return t; }
static int alive(sink_t *s, uint64_t now) {
    int32_t cb = atomic_load(&g_ring.h[H_CB]);
    if (cb != s->cb_seen) { s->cb_seen = cb; s->cb_ns = now; }
    int a = s->ring && s->cb_ns && now - s->cb_ns < ALIVE_NS;
    if (s->ring) atomic_store(&g_ring.h[H_MODE], a);
    return a;
}
static void *test_consumer(void *arg);

// Who answers the nn::audio and nn::codec names the game's modules refer to (once, when the first output opens): the
// HLE files in the build, nxweb's modules on the owner thread, or nobody: a name of an nxnative file that is not built
// (hle_audio.c: AudioOut, AudioIn, OutputStream) is bound to a stub that answers 0, and kernel/nx_proc.c logs its first call in red
int dm_game_imports(const char *prefix); unsigned nx_hle_name_count(void); double nx_hle_name_at(unsigned i); int nx_hle_have(double name); int nx_owner_lookup(double name);
static void audit(void) {
    int refs = 0, built = 0, owner = 0, none = 0; char list[1500]; size_t ln = 0; list[0] = 0;
    for (unsigned i = 0, n = nx_hle_name_count(); i < n; i++) {
        const char *nm = (const char *)(uintptr_t)nx_hle_name_at(i);
        if (!strstr(nm, "2nn5audio") && !strstr(nm, "2nn5codec")) continue;
        if (strstr(nm, "2nn5codec") && (strstr(nm, "Video") || strstr(nm, "Av1") || strstr(nm, "Vp9") || strstr(nm, "H264"))) continue;   // the movie pictures: kernel/nx_video.c's side
        if (!dm_game_imports(nm)) continue;
        refs++;
        if (nx_owner_lookup((double)(uintptr_t)nm) > 0) owner++;
        else if (nx_hle_have((double)(uintptr_t)nm)) built++;
        else { none++; if (ln + strlen(nm) + 2 < sizeof list) ln += (size_t)snprintf(list + ln, sizeof list - ln, " %s", nm); }
    }
    LOG("%saudio: the game's modules refer to %d nn::audio / nn::codec (sound) names: %d answered by the HLE files in the build, %d by nxweb's modules, %d by nobody (they answer 0)%s%s",
        none ? "[RED] " : "", refs, built, owner, none, none ? ":" : "", list);
}

void *dm_pcmout_open(int ch) {
    sink_t *s = calloc(1, sizeof *s); s->ch = ch;
    int free_ = 0; s->ring = atomic_compare_exchange_strong(&g_owner, &free_, 1);
    if (atomic_load(&g_log) < 0) atomic_store(&g_log, getenv("NX_AUDIO_LOG") ? atoi(getenv("NX_AUDIO_LOG")) : 0);
    if (atomic_load(&g_tone) < 0) atomic_store(&g_tone, getenv("NX_AUDIO_TONE") ? atoi(getenv("NX_AUDIO_TONE")) : 0);
    static _Atomic int audited; if (!atomic_exchange(&audited, 1)) audit();
    if (s->ring) {
        atomic_store(&g_ring.h[H_CAP], CAP); target();
        LOG("audio: output %d channels into the shared ring at %p (%d frames, target %d ms): the page's AudioWorklet reads it in place", ch, (void *)&g_ring, CAP, atomic_load(&g_target_ms));
    } else LOG("[RED] audio: a second output while the first one has the ring: paced in real time, not heard");
    return s;
}
void dm_pcmout_start(void *k) {
    sink_t *s = k; s->next_ns = s->st_ns = s->log_ns = now_ns(); s->fill_min = ~0u;
    if (!s->ring) return;
    atomic_store(&g_ring.h[H_LIVE], 1); atomic_fetch_add(&g_ring.h[H_OPEN], 1);
    static int once; const char *t = getenv("NX_AUDIO_TEST");
    if (t && !once++) { pthread_t th; pthread_create(&th, NULL, test_consumer, strdup(t)); pthread_detach(th); }
}
void dm_pcmout_close(void *k) {
    sink_t *s = k;
    if (s->ring) { atomic_store(&g_ring.h[H_LIVE], 0); atomic_store(&g_owner, 0); }
    free(s);
}
static void put(uint32_t *wr, float l, float r) { float *d = &g_ring.d[(size_t)(*wr & (CAP - 1)) << 1]; d[0] = l; d[1] = r; (*wr)++; }
int dm_pcmout_append(void *k, void *b_) {
    sink_t *s = k; gbuf *b = b_;
    if (s->n == QN) return 0;
    int ch = s->ch == 6 ? 6 : s->ch == 1 ? 1 : 2, n = (int)(b->size / (2u * (unsigned)ch));
    uint64_t now = now_ns();
    s->q[(s->head + s->n++) % QN] = b;
    s->st_frames += (uint64_t)n; s->log_frames += (uint64_t)n;
    if (!s->ring) return 1;
    const int16_t *in = b->ptr; int rate = dev_rate(), peak = 0, loud = 0;
    uint32_t wr = (uint32_t)atomic_load(&g_ring.h[H_WR]);
    double step = (double)IN_RATE / rate; int tone = atomic_load(&g_tone);
    for (int i = 0; i < n; i++) {
        float l, r;
        if (tone > 0) { l = r = 0.25f * (float)sin(s->tone_ph); s->tone_ph += 6.283185307179586 * tone / IN_RATE; if (s->tone_ph > 6.283185307179586) s->tone_ph -= 6.283185307179586; }
        else if (ch == 2) { l = in[2 * i] / 32768.f; r = in[2 * i + 1] / 32768.f; }
        else if (ch == 1) l = r = in[i] / 32768.f;
        else {   // front-left front-right center LFE back-left back-right: the system's default downmix (hle_audren.c)
            const int16_t *p = in + 6 * i; float c = 0.707f * p[2] + 0.251f * p[3];
            l = (p[0] + c + 0.707f * p[4]) / 32768.f; r = (p[1] + c + 0.707f * p[5]) / 32768.f;
            l = l > 1 ? 1 : l < -1 ? -1 : l; r = r > 1 ? 1 : r < -1 ? -1 : r;
        }
        int a = (int)(32768.f * (l < 0 ? -l : l)), a2 = (int)(32768.f * (r < 0 ? -r : r)); if (a2 > a) a = a2;
        if (a > peak) peak = a;
        if (a > 1) loud++;
        if (rate == IN_RATE) put(&wr, l, r);
        else {   // linear: output frames at pos, pos + step, ... between the last input frame (index -1 + pos) and this one
            while (s->pos < 1.0) { float f = (float)s->pos; put(&wr, s->prev[0] + (l - s->prev[0]) * f, s->prev[1] + (r - s->prev[1]) * f); s->pos += step; }
            s->pos -= 1.0; s->prev[0] = l; s->prev[1] = r;
        }
    }
    atomic_store(&g_ring.h[H_WR], (int32_t)wr);
    atomic_fetch_add(&g_ring.h[H_FRAMES], n);
    if (loud) atomic_fetch_add(&g_ring.h[H_NONSILENT], loud);
    if (peak > s->peak) s->peak = peak;
    // the ring's level: a device that runs is given at most the ring less a margin (the oldest frames go: an overrun);
    // one that does not run keeps only the target's worth. rd is the consumer's: moved here with a compare-and-swap, and
    // a store of the consumer's that lands on top moves it back by at most one callback (the margin covers that)
    int live = alive(s, now); uint32_t tg = target(), limit = live ? CAP - 4096 : tg, f = fill();
    if (live) { if (f < s->fill_min) s->fill_min = f; if (f > s->fill_max) s->fill_max = f; }
    if (f > limit) {
        int32_t rd = atomic_load(&g_ring.h[H_RD]); uint32_t drop = wr - (uint32_t)rd - (live ? tg : limit);
        if (wr - (uint32_t)rd > limit && atomic_compare_exchange_strong(&g_ring.h[H_RD], &rd, (int32_t)((uint32_t)rd + drop))) atomic_fetch_add(&g_ring.h[live ? H_OVER : H_DISCARD], (int32_t)drop);
    }
    if (now - s->st_ns >= 1000000000ull) {
        atomic_store(&g_ring.h[H_FPS100], (int32_t)((double)s->st_frames / 240.0 * 1e11 / (double)(now - s->st_ns)));
        atomic_store(&g_ring.h[H_PEAK], s->peak); atomic_store(&g_ring.h[H_FILL_MIN], (int32_t)(s->fill_min == ~0u ? 0 : s->fill_min)); atomic_store(&g_ring.h[H_FILL_MAX], (int32_t)s->fill_max);
        s->st_ns = now; s->st_frames = 0;
    }
    if (now - s->log_ns >= 5000000000ull) {
        if (atomic_load(&g_log) > 0)
            LOG("[audio] %s %d Hz: %.1f frames/s rendered (200 is real time) · ring %.0f ms (%.0f..%.0f while the device ran) · %d underrun frames · %d dropped (overrun) · %d discarded (no device) · peak %.3f · %u frames not silent",
                live ? "device" : "no device (wall clock)", rate, (double)s->log_frames / 240.0 * 1e9 / (double)(now - s->log_ns), fill() * 1000.0 / rate, (s->fill_min == ~0u ? 0 : s->fill_min) * 1000.0 / rate, s->fill_max * 1000.0 / rate,
                atomic_load(&g_ring.h[H_UNDER]), atomic_load(&g_ring.h[H_OVER]), atomic_load(&g_ring.h[H_DISCARD]), s->peak / 32768.0, (unsigned)atomic_load(&g_ring.h[H_NONSILENT]));
        s->log_ns = now; s->log_frames = 0; s->peak = 0; s->fill_min = ~0u; s->fill_max = 0;
    }
    return 1;
}
// A block is handed back when the output wants the next frame (see Pacing above). *wait: how long until it may
static int ready(sink_t *s, uint64_t now, uint64_t *wait) {
    *wait = 0;
    if (alive(s, now)) {
        int rate = dev_rate(); int32_t err = (int32_t)(fill() - target());
        if (err < -(rate / 100)) s->next_ns = now;                                                   // more than 10 ms under: at once
        else if (err > rate * 15 / 1000) { if (s->next_ns < now) s->next_ns = now; *wait = (uint64_t)(err - rate * 15 / 1000 + 32) * 1000000000ull / (uint64_t)rate; return 0; }   // over: the device first
        else if (now < s->next_ns) { *wait = s->next_ns - now; return 0; }
        if (now - s->next_ns > 2 * FRAME_NS) s->next_ns = now;                                       // late (a stalled thread): the ring's level says what is missing, not the clock
        s->next_ns += FRAME_NS + (int64_t)err * 1000000000ll / rate / 50;
    } else {
        if (now < s->next_ns) { *wait = s->next_ns - now; return 0; }
        if (now - s->next_ns > 4 * FRAME_NS) s->next_ns = now - 4 * FRAME_NS;   // late by more than 20 ms: no burst to make up for it
        s->next_ns += FRAME_NS;
    }
    return 1;
}
void *dm_pcmout_released(void *k) {
    sink_t *s = k; uint64_t w; if (!s->n || !ready(s, now_ns(), &w)) return NULL;
    gbuf *b = s->q[s->head]; s->head = (s->head + 1) % QN; s->n--;
    return b;
}
void dm_pcmout_wait(void *k, int ms) {
    sink_t *s = k; uint64_t d = (uint64_t)ms * 1000000ull, w = 0;
    if (s->n) { uint64_t next = s->next_ns; if (ready(s, now_ns(), &w)) { s->next_ns = next; return; } }
    if (w < 200000) w = 200000;
    if (w < d) d = w;
    struct timespec ts = {0, (long)(d > 999999999 ? 999999999 : d)}; nanosleep(&ts, 0);
}

// ---- the test's consumer: what the worklet does, on a thread of this process, at the pace of a sound card
static void wav_write(const char *path, const int16_t *pcm, uint32_t frames, int rate) {
    FILE *f = fopen(path, "wb"); if (!f) { LOG("[RED] audio test: cannot write %s", path); return; }
    uint32_t bytes = frames * 4, v32; uint16_t v16;
    fwrite("RIFF", 1, 4, f); v32 = 36 + bytes; fwrite(&v32, 4, 1, f); fwrite("WAVEfmt ", 1, 8, f);
    v32 = 16; fwrite(&v32, 4, 1, f); v16 = 1; fwrite(&v16, 2, 1, f); v16 = 2; fwrite(&v16, 2, 1, f);
    v32 = (uint32_t)rate; fwrite(&v32, 4, 1, f); v32 = (uint32_t)rate * 4; fwrite(&v32, 4, 1, f); v16 = 4; fwrite(&v16, 2, 1, f); v16 = 16; fwrite(&v16, 2, 1, f);
    fwrite("data", 1, 4, f); fwrite(&bytes, 4, 1, f); fwrite(pcm, 4, frames, f); fclose(f);
}
static void *test_consumer(void *arg) {
    const char *path = arg; enum { Q = 128 };
    int rate = getenv("NX_AUDIO_RATE") ? atoi(getenv("NX_AUDIO_RATE")) : IN_RATE, secs = getenv("NX_AUDIO_TEST_SECS") ? atoi(getenv("NX_AUDIO_TEST_SECS")) : 5;
    uint32_t want = (uint32_t)(rate * secs), got = 0; int16_t *rec = malloc((size_t)want * 4); int recording = 0, written = 0;
    atomic_store(&g_ring.h[H_RATE], rate); atomic_store(&g_ring.h[H_STATE], 2);
    LOG("audio test: a consumer thread takes %d frames every %.3f ms at %d Hz; %d s from the first sound go to %s", Q, Q * 1000.0 / rate, rate, secs, path);
    uint64_t t0 = now_ns(), k = 0, rep = t0, late = 0, quanta0 = 0; int32_t under0 = 0, frames0 = 0; int32_t loud_q = 0;
    int tone = getenv("NX_AUDIO_TONE") ? atoi(getenv("NX_AUDIO_TONE")) : 0; float x1 = 0, x2 = 0, c2 = 2 * (float)cos(6.283185307179586 * tone / rate); unsigned breaks = 0, breaks_all = 0;
    for (;;) {
        uint64_t due = t0 + ++k * Q * 1000000000ull / (uint64_t)rate, now = now_ns();
        if (now < due) { struct timespec ts = {0, (long)(due - now)}; nanosleep(&ts, 0); }
        else if (now - due > 50000000ull) { late++; t0 += now - due; }   // this thread was held up (a loaded machine): not an underrun of the renderer's, the clock restarts
        uint32_t wr = (uint32_t)atomic_load(&g_ring.h[H_WR]), rd = (uint32_t)atomic_load(&g_ring.h[H_RD]), avail = wr - rd; if (avail > CAP) avail = 0;
        uint32_t n = avail < Q ? avail : Q; int loud = 0;
        for (uint32_t i = 0; i < Q; i++) {
            float l = 0, r = 0; if (i < n) { const float *d = &g_ring.d[(size_t)((rd + i) & (CAP - 1)) << 1]; l = d[0]; r = d[1]; }
            int a = (int)(l * 32767.f), c = (int)(r * 32767.f); if (a > 3 || a < -3 || c > 3 || c < -3) loud = 1;
            if (tone) { float e = l - (c2 * x1 - x2); if (e > 0.01f || e < -0.01f) breaks++; x2 = x1; x1 = l; }
            if (recording && got < want) { rec[2 * got] = (int16_t)(a > 32767 ? 32767 : a < -32768 ? -32768 : a); rec[2 * got + 1] = (int16_t)(c > 32767 ? 32767 : c < -32768 ? -32768 : c); got++; }
        }
        if (n < Q && atomic_load(&g_ring.h[H_LIVE]) > 0) atomic_fetch_add(&g_ring.h[H_UNDER], (int32_t)(Q - n));
        atomic_store(&g_ring.h[H_RD], (int32_t)(rd + n)); atomic_fetch_add(&g_ring.h[H_CB], 1);
        loud_q += loud;
        if (loud && !recording) { recording = 1; LOG("audio test: first sound %.2f s after the output started", (now_ns() - t0) / 1e9); }
        if (recording && got == want && !written) { written = 1; wav_write(path, rec, got, rate); LOG("audio test: wrote %s (%u frames, %d Hz stereo 16-bit)", path, got, rate); }
        now = now_ns();
        if (now - rep >= 10000000000ull) {
            int32_t u = atomic_load(&g_ring.h[H_UNDER]), fr = atomic_load(&g_ring.h[H_FRAMES]); char tb[160];
            LOG("audio test: last %.1f s: %.1f frames/s arrived (200 is real time) · %d underrun frames (%.1f ms) · %d of %llu callbacks with sound · ring %.0f ms · %llu times this thread ran late · overrun %d discarded %d%s",
                (now - rep) / 1e9, (double)(fr - frames0) / 240.0 * 1e9 / (double)(now - rep), u - under0, (u - under0) * 1000.0 / rate, loud_q, (unsigned long long)(k - quanta0), fill() * 1000.0 / rate,
                (unsigned long long)late, atomic_load(&g_ring.h[H_OVER]), atomic_load(&g_ring.h[H_DISCARD]), tone ? (snprintf(tb, sizeof tb, " · test tone %d Hz: %u breaks (samples that do not continue the sine), %u in all", tone, breaks, breaks_all + breaks), tb) : "");
            breaks_all += breaks; breaks = 0;
            rep = now; under0 = u; frames0 = fr; quanta0 = k; loud_q = 0; late = 0;
        }
    }
    return NULL;
}
