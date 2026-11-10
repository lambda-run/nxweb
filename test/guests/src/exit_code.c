// Exit through svc 0x07 from a nested call, with a non-zero code. Output that
// is printed before the exit must appear; nothing after it may.
#include "rt.h"

static __attribute__((noinline)) int level(int n)
{
    printf("level %d\n", n);
    if (n == 5) {
        puts("exiting with 42");
        exit(42);
    }
    int r = level(n + 1);
    puts("[unreachable] returned from level");
    return r + 1;
}

int main(void)
{
    level(0);
    puts("[unreachable] back in main");
    return 1;
}
