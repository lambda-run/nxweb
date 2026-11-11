// nxnative's shader key (dm/gfx/nvn/hle_nvn.c nvn2_ctl, nvn_ctl_lens, keys_hash), built here with OpenSSL in place of CommonCrypto.
// KEYS_HASH is the file run.mts cuts out of hle_nvn.c (from #define NVN2_KEY_CTL to prog_key). Reads "<control hex> <code hex>" lines,
// writes each one's key (16 hex digits) or "-" when keys_hash refuses it.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <openssl/sha.h>
typedef struct { uint64_t data; const void *control; } NVNshaderData;
#define CC_SHA256_DIGEST_LENGTH SHA256_DIGEST_LENGTH
#define CC_SHA256_CTX SHA256_CTX
#define CC_SHA256_Init SHA256_Init
#define CC_SHA256_Update SHA256_Update
#define CC_SHA256_Final SHA256_Final
#define DM_GAME_SHADER_KEY_SKIP_OFF 0
#define DM_GAME_SHADER_KEY_SKIP_LEN 0
static int mtl_addr_known(uint64_t a, uint32_t n) { (void)a; (void)n; return 1; }
#include KEYS_HASH
static size_t unhex(const char *s, uint8_t *out) { size_t n = 0; for (; s[0] && s[1] && s[0] != ' ' && s[0] != '\n'; s += 2) { unsigned b; sscanf(s, "%2x", &b); out[n++] = (uint8_t)b; } return n; }
int main(void) {
    static char line[1 << 22]; static uint8_t ctl[1 << 20], code[1 << 20];
    while (fgets(line, sizeof line, stdin)) {
        char *sp = strchr(line, ' '); if (!sp) continue;
        memset(ctl, 0, 0x1000); unhex(line, ctl); size_t ncode = unhex(sp + 1, code);
        NVNshaderData sd = { ncode ? (uint64_t)(uintptr_t)code : 0, ctl }; uint8_t key[8];
        if (!keys_hash(&sd, 0, key)) { puts("-"); continue; }
        for (int i = 0; i < 8; i++) printf("%02x", key[i]); putchar('\n');
    }
    return 0;
}
