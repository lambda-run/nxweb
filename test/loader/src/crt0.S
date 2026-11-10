// The start of every test module: what a Switch module has at offset 0. `b` over the header, the offset of MOD0 at +4,
// and room up to 0x80 (an NRO has its NRO0 header there; elf2nso.py --nro fills it in).
    .section .text.crt0, "ax"
    .global _start
_start:
    b       __nx_entry
    .word   __nx_mod0 - _start
    .space  0x78
__nx_entry:
    b       module_entry

// MOD0: offsets are relative to the header itself (dynamic, bss start, bss end, eh_frame_hdr start, end, module object)
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
