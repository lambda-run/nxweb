// Smoke test: output SVC, printf formats, tick SVC, normal return from main.
#include "rt.h"

int main(void)
{
    puts("hello from the guest");
    printf("int %d %i %u %x %X\n", -42, 42, 4000000000u, 0xbeef, 0xBEEF);
    printf("long %ld %lu %lx\n", -1234567890123L, 12345678901234567890UL, 0xdeadbeefcafebabeUL);
    printf("pad [%5d] [%-5d] [%05d] [%08lx] [%-6s] [%6s] [%.2s]\n", 42, 42, -42, 0xabcUL, "ab", "cd", "xyz");
    printf("char %c%c%c pct %% str %s\n", 'a', 'b', 'c', "ok");
    printf("float %f %.3f %.0f %10.4f %f\n", 3.14159265, -2.5, 2.5, 1234.56789, 1e-7);
    uint64_t t0 = svc_tick(), t1 = svc_tick(), t2 = svc_tick();
    printf("ticks %lu %lu %lu\n", t0, t1, t2);
    putchar('!');
    putchar('\n');
    return 0;
}
