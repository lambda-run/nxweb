// nxem shim for <CommonCrypto/CommonDigest.h>: declarations only (the types and the SHA-256 entry points nxnative
// uses). The link needs an implementation with these names (any public-domain SHA-256; not part of this shim).
#pragma once
#include <stdint.h>
#include <stddef.h>
typedef uint32_t CC_LONG;
#define CC_SHA256_DIGEST_LENGTH 32
#define CC_SHA1_DIGEST_LENGTH 20
typedef struct { uint32_t count[2]; uint32_t hash[8]; uint32_t wbuf[16]; } CC_SHA256_CTX;
int CC_SHA256_Init(CC_SHA256_CTX *c);
int CC_SHA256_Update(CC_SHA256_CTX *c, const void *data, CC_LONG len);
int CC_SHA256_Final(unsigned char *md, CC_SHA256_CTX *c);
unsigned char *CC_SHA256(const void *data, CC_LONG len, unsigned char *md);
