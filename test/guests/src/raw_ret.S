// Standalone image without crt0: checks the contract's initial state directly
// and ends by returning from the entry function to x30 (0xFFFF_FFF0) with
// w0 = 7, instead of using svc 0x07.
//
// Prints one letter per check: '.' if ok, an upper-case letter if not.
    .section .text.start, "ax"
    .globl _start
_start:
    mrs     x22, nzcv               // before anything touches the flags
    mrs     x23, fpcr
    mov     x19, x30                // keep the host return address
    adrp    x20, buf
    add     x20, x20, :lo12:buf
    mov     x21, #0                 // output length

    // x0..x18, x29 must be 0 (x19..x23 are already clobbered above)
    orr     x9, x0, x1
    orr     x9, x9, x2
    orr     x9, x9, x3
    orr     x9, x9, x4
    orr     x9, x9, x5
    orr     x9, x9, x6
    orr     x9, x9, x7
    orr     x9, x9, x8
    orr     x10, x10, x11
    orr     x10, x10, x12
    orr     x10, x10, x13
    orr     x10, x10, x14
    orr     x10, x10, x15
    orr     x10, x10, x16
    orr     x10, x10, x17
    orr     x10, x10, x18
    orr     x10, x10, x29
    orr     x9, x9, x10
    cmp     x9, #0
    mov     w10, #'.'
    mov     w11, #'R'
    csel    w12, w10, w11, eq
    strb    w12, [x20, x21]
    add     x21, x21, #1

    // NZCV and FPCR must be 0
    orr     x9, x22, x23
    cmp     x9, #0
    mov     w11, #'F'
    csel    w12, w10, w11, eq
    strb    w12, [x20, x21]
    add     x21, x21, #1

    // x30 must be 0xFFFFFFF0
    mov     x9, #0xFFF0
    movk    x9, #0xFFFF, lsl #16
    cmp     x19, x9
    mov     w11, #'L'
    csel    w12, w10, w11, eq
    strb    w12, [x20, x21]
    add     x21, x21, #1

    // sp must equal __stack_top and be 16-byte aligned
    mov     x9, sp
    ldr     x13, =__stack_top
    cmp     x9, x13
    mov     w11, #'S'
    csel    w12, w10, w11, eq
    strb    w12, [x20, x21]
    add     x21, x21, #1
    tst     x9, #15
    mov     w11, #'A'
    csel    w12, w10, w11, eq
    strb    w12, [x20, x21]
    add     x21, x21, #1

    // bss must read as zero
    adrp    x9, zeroes
    add     x9, x9, :lo12:zeroes
    ldp     x13, x14, [x9]
    orr     x13, x13, x14
    cmp     x13, #0
    mov     w11, #'B'
    csel    w12, w10, w11, eq
    strb    w12, [x20, x21]
    add     x21, x21, #1

    // the stack must be usable
    stp     x19, x20, [sp, #-16]!
    ldp     x13, x14, [sp], #16
    cmp     x13, x19
    ccmp    x14, x20, #0, eq
    mov     w11, #'K'
    csel    w12, w10, w11, eq
    strb    w12, [x20, x21]
    add     x21, x21, #1

    mov     w12, #'\n'
    strb    w12, [x20, x21]
    add     x21, x21, #1

    mov     x0, x20
    mov     x1, x21
    svc     #0x27
    adr     x0, msg
    mov     x1, #(msg_end - msg)
    svc     #0x27

    mov     w0, #7
    mov     x30, x19
    ret
    .ltorg
msg:
    .ascii  "returning to host\n"
msg_end:

    .bss
    .balign 16
zeroes:
    .skip   16
buf:
    .skip   32
