// The start of every runtime test module: what a Switch module has at offset 0 (`b` over the header, the offset of
// MOD0 at +4), then the entry. The runtime's start contract (src/runtime/README.md): the first module is entered here
// with x0 = 0, x1 = the main thread's handle, sp = the top of its stack, x30 = the thread-exit pc; the other modules'
// entries are never called.
    .section .text.crt0, "ax"
    .global _start
    .hidden rt_entry
_start:
    b       __nx_entry
    .word   __nx_mod0 - _start
    .space  0x78
__nx_entry:
    b       rt_entry

    .section .rodata.mod0, "a"
    .balign 4
    .global __nx_mod0
    .hidden __nx_mod0
    .hidden __bss_start
    .hidden __bss_end
    .hidden __eh_frame_hdr_start
    .hidden __eh_frame_hdr_end
    .hidden _DYNAMIC
__nx_mod0:
    .ascii  "MOD0"
    .word   _DYNAMIC - __nx_mod0
    .word   __bss_start - __nx_mod0
    .word   __bss_end - __nx_mod0
    .word   __eh_frame_hdr_start - __nx_mod0
    .word   __eh_frame_hdr_end - __nx_mod0
    .word   __nx_module_object - __nx_mod0

    .section .bss.module_object, "aw", %nobits
    .balign 8
    .global __nx_module_object
    .hidden __nx_module_object
__nx_module_object:
    .space  0xD0
