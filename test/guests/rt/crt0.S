// Entry stub. Must be the first bytes of the flat image (entry = offset 0).
// The ABI already provides sp = stack_top, x30 = 0xFFFFFFF0 and zeroed memory,
// so nothing is set up here: call main, then ExitProcess(main's return value).
    .section .text.start, "ax"
    .globl _start
    .type _start, %function
_start:
    bl      main
    svc     #0x07
1:  b       1b
    .size _start, . - _start
