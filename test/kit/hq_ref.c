// Reference for home_quit.test.mts: runs nxnative's own home_quit.h (given with -I) over the operations on stdin
// ("s now home a b" = hq_step, "c" = hq_cancel) and prints, after each, the phase, the Home flag and hq_ring at that time.
#include "home_quit.h"
#include <stdio.h>

int main(void) {
    home_quit q = {0};
    char op; double now = 0; int home, a, b;
    while (scanf(" %c", &op) == 1) {
        if (op == 's') { if (scanf("%lf %d %d %d", &now, &home, &a, &b) != 4) return 2; hq_step(&q, now, home, a, b); }
        else if (op == 'c') hq_cancel(&q);
        else return 2;
        printf("%d %d %.17g %d\n", (int)q.phase, q.home, hq_ring(&q, now), hq_blocks_input(q.phase));
    }
    return 0;
}
