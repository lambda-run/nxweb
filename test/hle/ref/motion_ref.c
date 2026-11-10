// Reference for k_motion.test.mts: nxnative's own motion_fusion.h (given with -I) over the operations on stdin.
// Floats travel as their bit patterns (8 hex digits), so nothing is lost in text.
//   m <spec|->                        motion_map_parse (- = NULL): prints "M ok src0 src1 src2 sign0 sign1 sign2 acc_sign det"
//   n                                 the map's acc_sign = -1 (DM_MOTION_ACC_SIGN)
//   r                                 motion_reset
//   s <19 words>                      set the state (R[9], angle[3], acc[3], gyro[3], primed)
//   u <acc 3> <rot 3> <dt> <k>        motion_update
//   p <orient> <in 3>                 motion_phone_to_switch: prints "P out0 out1 out2"
// After r, s and u: "S" and the state's 19 words, then the 18 words of motion_fill.
#include "motion_fusion.h"
#include <stdio.h>
#include <stdint.h>

static float rf(void) { uint32_t u; float f; if (scanf("%x", &u) != 1) exit(2); memcpy(&f, &u, 4); return f; }
static void pf(float f) { uint32_t u; memcpy(&u, &f, 4); printf(" %08x", u); }
static void state(const motion_state *s) {
    printf("S");
    for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) pf(s->R[i][j]);
    for (int i = 0; i < 3; i++) pf(s->angle[i]);
    for (int i = 0; i < 3; i++) pf(s->acc[i]);
    for (int i = 0; i < 3; i++) pf(s->gyro[i]);
    printf(" %08x", (unsigned)s->primed);
    float f[18]; motion_fill(s, f, f + 3, f + 6, f + 9);
    for (int i = 0; i < 18; i++) pf(f[i]);
    printf("\n");
}
int main(void) {
    motion_map m; motion_map_parse(&m, NULL);
    motion_state s; motion_reset(&s);
    char op, spec[64];
    while (scanf(" %c", &op) == 1) {
        if (op == 'm') {
            if (scanf(" %63[^\n]", spec) != 1) return 2;
            int ok = motion_map_parse(&m, spec[0] == '-' && !spec[1] ? NULL : spec);
            printf("M %d %d %d %d", ok, m.src[0], m.src[1], m.src[2]); for (int i = 0; i < 3; i++) pf(m.sign[i]); pf(m.acc_sign); pf(m.det); printf("\n");
        } else if (op == 'n') m.acc_sign = -1;
        else if (op == 'r') { motion_reset(&s); state(&s); }
        else if (op == 's') {
            for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) s.R[i][j] = rf();
            for (int i = 0; i < 3; i++) s.angle[i] = rf();
            for (int i = 0; i < 3; i++) s.acc[i] = rf();
            for (int i = 0; i < 3; i++) s.gyro[i] = rf();
            unsigned p; if (scanf("%x", &p) != 1) return 2; s.primed = (int)p;
            state(&s);
        } else if (op == 'u') {
            float a[3], w[3]; for (int i = 0; i < 3; i++) a[i] = rf(); for (int i = 0; i < 3; i++) w[i] = rf();
            float dt = rf(), k = rf();
            motion_update(&s, &m, a, w, dt, k); state(&s);
        } else if (op == 'p') {
            int o; if (scanf("%d", &o) != 1) return 2;
            float in[3], out[3]; for (int i = 0; i < 3; i++) in[i] = rf();
            motion_phone_to_switch(o, in, out); printf("P"); for (int i = 0; i < 3; i++) pf(out[i]); printf("\n");
        } else return 2;
    }
    return 0;
}
