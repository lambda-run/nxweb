// nxem test: the generated HLE table and thunks (tools/gen_hle.py). A fake context block is filled the way translated
// guest code leaves it at a host call, an entry is looked up by name, its thunk is called and the block is checked.
// Entries come from nxnative files compiled unedited (hle_account.c, hle_friends.c, hle_audren.c, hle_table.c) and
// from t_marshal.c (the rare argument shapes). Built and run by hle/test/run.sh.
#define NX_HLE_NO_NXNATIVE 1
#include "nx_hle.h"
#include <stdio.h>
#include <stdlib.h>

static _Alignas(16) uint64_t ctx[NX_CTX_SIZE / 8];
static uint64_t stack[64];
static int n_ok, n_bad;
#define CHECK(c) do { if (c) n_ok++; else { n_bad++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); } } while (0)

static void reset(void) {
    for (unsigned i = 0; i < NX_CTX_SIZE / 8; i++) ctx[i] = 0xDEAD0000DEAD0000ull + i;   // registers the call does not set hold garbage
    for (unsigned i = 0; i < 64; i++) stack[i] = 0xBAD0000000000000ull + i;
    ctx[NX_CTX_SP / 8] = (uint64_t)(uintptr_t)&stack[16];
}
static void set_s(unsigned n, float f) { uint8_t *v = (uint8_t *)ctx + NX_CTX_V + 16 * n; memset(v, 0xEE, 16); memcpy(v, &f, 4); }
static void set_d(unsigned n, double d) { uint8_t *v = (uint8_t *)ctx + NX_CTX_V + 16 * n; memset(v, 0xEE, 16); memcpy(v, &d, 8); }
static float get_s(void) { float f; memcpy(&f, (uint8_t *)ctx + NX_CTX_V, 4); return f; }
static double get_d(void) { double d; memcpy(&d, (uint8_t *)ctx + NX_CTX_V, 8); return d; }
static int v0_high_clear(unsigned from) { const uint8_t *v = (const uint8_t *)ctx + NX_CTX_V; for (unsigned i = from; i < 16; i++) if (v[i]) return 0; return 1; }
static void stk_d(unsigned slot, double d) { memcpy(&stack[16 + slot], &d, 8); }
static void stk_s(unsigned slot, float f) { stack[16 + slot] = 0xEEEEEEEE00000000ull; memcpy(&stack[16 + slot], &f, 4); }
static const nx_hle_ent *call(const char *name) {
    const nx_hle_ent *e = nx_hle_find(name);
    if (!e) { n_bad++; printf("FAIL no entry: %s\n", name); return NULL; }
    e->thunk(ctx); return e;
}
#define P(x) ((uint64_t)(uintptr_t)(x))

int main(void) {
    // the table
    for (unsigned i = 1; i < nx_hle_count; i++) CHECK(strcmp(nx_hle_table[i - 1].name, nx_hle_table[i].name) <= 0);
    for (unsigned i = 0; i < nx_hle_count; i++) CHECK(nx_hle_find(nx_hle_table[i].name) != NULL && nx_hle_table[i].thunk != NULL);
    CHECK(nx_hle_find("_ZN2nn7account99NoSuchEv") == NULL); CHECK(nx_hle_find("") == NULL); CHECK(nx_hle_find("zzzz") == NULL);

    // hle_account.c
    { reset(); int n = -1; uint64_t uid[2] = {0, 0};
      ctx[0] = P(&n); ctx[1] = P(uid); ctx[2] = 0xFFFFFFFF00000004ull;   // int max = 4 with garbage above w2
      const nx_hle_ent *e = call("_ZN2nn7account12ListAllUsersEPiPNS0_3UidEi");
      CHECK(e && (e->flags & NX_HLE_FORCE) && !(e->flags & NX_HLE_HAND)); CHECK(ctx[0] == 0); CHECK(n == 1);
      CHECK(uid[0] == 0x78626c0000000001ull && uid[1] == 0x53574e4154495645ull);
      CHECK(ctx[1] == P(uid));                                            // only x0 is written
      uint64_t h[3] = {0, 0, 0}, out[2] = {0, 0};
      reset(); ctx[0] = P(h); ctx[1] = P(uid); call("_ZN2nn7account8OpenUserEPNS0_10UserHandleERKNS0_3UidE"); CHECK(ctx[0] == 0 && h[2] == 0x55534552484e444cull);
      reset(); ctx[0] = P(out); ctx[1] = P(h); call("_ZN2nn7account9GetUserIdEPNS0_3UidERKNS0_10UserHandleE"); CHECK(ctx[0] == 0 && out[0] == uid[0] && out[1] == uid[1]);
      reset(); ctx[0] = P(h); call("_ZN2nn7account22TryOpenPreselectedUserEPNS0_10UserHandleE"); CHECK(ctx[0] == 1); }
    // hle_friends.c
    { reset(); int count = 5; ctx[0] = P(&count); ctx[1] = 0; ctx[2] = 0; ctx[3] = 10; ctx[4] = 0;
      call("_ZN2nn7friends13GetFriendListEPiPNS0_6FriendEiiRKNS0_12FriendFilterE"); CHECK(ctx[0] == 0x2A2 && count == 0);
      reset(); count = 5; ctx[0] = P(&count); ctx[3] = 10;
      call("_ZN2nn7friends18GetBlockedUserListEPiPNS_7account23NetworkServiceAccountIdEii"); CHECK(ctx[0] == 0 && count == 0);
      reset(); call("_ZNK2nn7friends12AsyncContext9GetResultEv"); CHECK(ctx[0] == 0x2A2); }
    // hle_audren.c: a float argument (v0, although it is the second parameter) and a float result
    { reset(); ctx[0] = 0; call("_ZN2nn5audio26GetAudioDeviceOutputVolumeEPKNS0_15AudioDeviceNameE"); CHECK(get_s() == 1.0f); CHECK(v0_high_clear(4));
      reset(); ctx[0] = 0; set_s(0, 0.25f); set_s(1, 9.0f); call("_ZN2nn5audio26SetAudioDeviceOutputVolumeEPKNS0_15AudioDeviceNameEf");
      reset(); ctx[0] = 0; call("_ZN2nn5audio26GetAudioDeviceOutputVolumeEPKNS0_15AudioDeviceNameE"); CHECK(get_s() == 0.25f); }
    // hle_table.c: the C library passed through
    { char buf[16] = "0123456789"; char *end = NULL; float ip = 0;
      reset(); ctx[0] = P("hello"); const nx_hle_ent *e = call("strlen"); CHECK(ctx[0] == 5); CHECK(e && (e->flags & NX_HLE_LIBC) && (e->flags & NX_HLE_IMPORT));
      reset(); ctx[0] = P(buf + 1); ctx[1] = P(buf); ctx[2] = 4; call("memmove"); CHECK(ctx[0] == P(buf + 1) && !memcmp(buf, "00123", 5));
      reset(); ctx[0] = P("-42x"); ctx[1] = P(&end); ctx[2] = 10; call("strtol"); CHECK((int64_t)ctx[0] == -42 && end && *end == 'x');
      reset(); set_d(0, 2.0); set_d(1, 10.0); call("pow"); CHECK(get_d() == 1024.0); CHECK(v0_high_clear(8));
      reset(); set_s(0, 3.5f); ctx[0] = P(&ip); call("modff"); CHECK(get_s() == 0.5f && ip == 3.0f);
      reset(); set_d(0, 0.75); ctx[0] = 0xAAAAAAAA00000004ull; call("ldexp"); CHECK(get_d() == 12.0);
      reset(); ctx[0] = P("2.5"); call("atof"); CHECK(get_d() == 2.5);
      reset(); set_s(0, 2.5f); call("lroundf"); CHECK(ctx[0] == 3); }
    // t_marshal.c
    { reset(); for (unsigned i = 0; i < 8; i++) ctx[i] = i + 1; stack[16] = 9; stack[17] = 10;
      call("t_sum10"); CHECK(ctx[0] == 1 + 4 + 9 + 16 + 25 + 36 + 49 + 64 + 81 + 100);
      reset(); ctx[0] = 0xFFFFFFFF00000003ull; set_s(0, 0.5f); ctx[1] = 16; set_d(1, 0.25); ctx[2] = 0xFFFFFFFF00000100ull;
      call("t_mix"); CHECK(get_d() == 3 + 0.5 + 16 + 0.25 + 256);
      reset(); for (unsigned i = 0; i < 8; i++) set_s(i, 1.0f); stk_s(0, 2.0f); ctx[0] = 5; call("t_f9"); CHECK(get_s() == 8.0f + 200.0f + 5.0f); CHECK(v0_high_clear(4));
      reset(); stack[16] = 0xFFFFFFFF00000007ull; stk_d(1, 0.5); stack[18] = 0xFFFFFFFF00000002ull; call("t_stackmix"); CHECK(get_d() == 7000.0 + 0.5 + 2.0);
      reset(); ctx[0] = 0xFFFFFFFFFFFFFF11ull; ctx[1] = 0xFFFFFFFFFFFF2233ull; ctx[2] = 0xFFFFFFFFFFFFFF00ull; ctx[3] = 0x1111111111118000ull; ctx[4] = 0xFFFFFFFF00000007ull;
      call("t_narrow"); CHECK(ctx[0] == (0x11u + (0x2233u << 8) + (0u << 24) + (1u << 25) + (1u << 26)));
      reset(); ctx[2] = 0x100; ctx[0] = ctx[1] = ctx[3] = ctx[4] = 0; call("t_narrow"); CHECK(ctx[0] == 0);          // bool: only the low 8 bits
      reset(); ctx[2] = 0x101; ctx[0] = ctx[1] = ctx[3] = ctx[4] = 0; call("t_narrow"); CHECK(ctx[0] == 1u << 24);
      reset(); call("t_neg"); CHECK((int32_t)ctx[0] == -2 && (int64_t)ctx[0] == -2);
      reset(); call("t_u32"); CHECK(ctx[0] == 0xFFFFFFF0ull);
      reset(); ctx[0] = P("yes"); call("t_bool"); CHECK(ctx[0] == 1); reset(); ctx[0] = P("no"); call("t_bool"); CHECK(ctx[0] == 0);
      reset(); ctx[0] = 0x1000; ctx[1] = 0; ctx[2] = 0x2000; call("t_cb"); CHECK(ctx[0] == 5);
      reset(); ctx[0] = 0xFFFFFFFF00000028ull; const nx_hle_ent *s = call("t_set_int"); CHECK(s && (s->flags & NX_HLE_FORCE)); CHECK(ctx[0] == 0xFFFFFFFF00000028ull);   // void: x0 untouched
      reset(); const nx_hle_ent *g = call("t_get3"); CHECK(ctx[0] == 43); CHECK(g && g->flags == NX_HLE_IMPORT);
      CHECK(nx_hle_find_kind("t_get3", NX_HLE_FORCE) == NULL && nx_hle_find_kind("t_get3", NX_HLE_IMPORT) == g);
      static const char *hand[] = {"t_pair", "t_pairarg", "t_va", "t_i128", "t_ld"};
      for (unsigned i = 0; i < 5; i++) { const nx_hle_ent *e = nx_hle_find(hand[i]); CHECK(e && (e->flags & NX_HLE_HAND)); } }
    printf("t_thunks: %u table entries, %d checks passed, %d failed\n", nx_hle_count, n_ok, n_bad);
    return n_bad ? 1 : 0;
}
