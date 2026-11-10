// SVC wrappers per docs/CONTRACT.md "Test guest ABI".
    .text
    .globl svc_output           // void svc_output(const char *p, size_t n)
    .type svc_output, %function
svc_output:
    svc     #0x27
    ret
    .size svc_output, . - svc_output

    .globl svc_exit             // _Noreturn void svc_exit(int code)
    .type svc_exit, %function
svc_exit:
    svc     #0x07
1:  b       1b
    .size svc_exit, . - svc_exit

    .globl svc_tick             // uint64_t svc_tick(void)
    .type svc_tick, %function
svc_tick:
    svc     #0x1E
    ret
    .size svc_tick, . - svc_tick
