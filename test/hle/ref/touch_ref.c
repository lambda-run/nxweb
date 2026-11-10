// Reference for j_touch.test.mts: nxnative's own hle_touch.c over the operations on stdin. The test copies hle_touch.c
// next to two small headers that stand for dm.h and front.h (it needs LOG and dm_touch from them) and compiles this
// file with it. Floats travel as their bit patterns.
//   t <n> { <id> <x> <y> }     dm_touch_set: the whole set of touch points
//   f <max> <now ns>           touch_fill_n: prints "F <count> <hex of the 0x10 + 0x28 * max bytes>" (guard bytes 0xEE around)
//   g <n> <now ns>             gesture_fill: prints "G <count> <hex of the count * 0x60 bytes>"
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
typedef struct { uint32_t id; float x, y; } dm_touch;
void dm_touch_set(const dm_touch *t, int n);
int touch_fill_n(void *out, int max, uint64_t now_ns);
int gesture_fill(void *out, int n, uint64_t now_ns);

int main(void) {
    char op; static uint8_t buf[16 + 0x60 * 32 + 16];
    while (scanf(" %c", &op) == 1) {
        if (op == 't') {
            int n; dm_touch t[32]; if (scanf("%d", &n) != 1 || n > 32) return 2;
            for (int i = 0; i < n; i++) { uint32_t x, y; if (scanf("%u %x %x", &t[i].id, &x, &y) != 3) return 2; memcpy(&t[i].x, &x, 4); memcpy(&t[i].y, &y, 4); }
            dm_touch_set(n ? t : NULL, n);
        } else if (op == 'f') {
            int max; unsigned long long now; if (scanf("%d %llu", &max, &now) != 2) return 2;
            int size = 0x10 + 0x28 * (max < 1 ? 1 : max > 16 ? 16 : max);
            memset(buf, 0xEE, sizeof buf);
            int k = touch_fill_n(buf + 16, max, now);
            for (int i = 0; i < 16; i++) if (buf[i] != 0xEE || buf[16 + size + i] != 0xEE) return 3;
            printf("F %d ", k); for (int i = 0; i < size; i++) printf("%02x", buf[16 + i]); printf("\n");
        } else if (op == 'g') {
            int n; unsigned long long now; if (scanf("%d %llu", &n, &now) != 2 || n > 32) return 2;
            memset(buf, 0xEE, sizeof buf);
            int k = gesture_fill(buf + 16, n, now);
            for (int i = 0; i < 16; i++) if (buf[i] != 0xEE || buf[16 + 0x60 * (k > 0 ? k : 0) + i] != 0xEE) return 3;
            printf("G %d ", k); for (int i = 0; i < 0x60 * k; i++) printf("%02x", buf[16 + i]); printf("\n");
        } else return 2;
    }
    return 0;
}
