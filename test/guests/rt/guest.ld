/* Flat image at 0x0800_0000: text, rodata, data, then bss (not stored in the
   .bin; the loader provides zeroed memory) and a 1 MB stack after bss. */
ENTRY(_start)
SECTIONS
{
    . = 0x08000000;
    __image_start = .;
    .text : { KEEP(*(.text.start)) *(.text .text.*) }
    . = ALIGN(16);
    .rodata : { *(.rodata .rodata.*) }
    . = ALIGN(16);
    .data : { *(.data .data.*) }
    . = ALIGN(16);
    __image_end = .;
    __bss_start = .;
    .bss (NOLOAD) : { *(.bss .bss.*) *(COMMON) }
    . = ALIGN(16);
    __bss_end = .;
    __stack_bottom = .;
    . = . + 0x100000;
    __stack_top = .;
    /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) *(.ARM.*) *(.gnu*) }
}
