/* A Switch module's layout: text at 0, then read-only data, then data and bss, each on a page. */
PHDRS
{
  text    PT_LOAD FLAGS(5);
  rodata  PT_LOAD FLAGS(4);
  data    PT_LOAD FLAGS(6);
  dynamic PT_DYNAMIC;
}
SECTIONS
{
  . = 0;
  .text : { KEEP(*(.text.crt0)) *(.text .text.*) } :text
  .plt : { *(.plt) *(.iplt) } :text
  . = ALIGN(0x1000);
  .rodata : { KEEP(*(.rodata.mod0)) *(.rodata .rodata.*) } :rodata
  .dynsym : { *(.dynsym) } :rodata
  .dynstr : { *(.dynstr) } :rodata
  .hash : { *(.hash) } :rodata
  .gnu.hash : { *(.gnu.hash) } :rodata
  .rela.dyn : { *(.rela.dyn) } :rodata
  .relr.dyn : { *(.relr.dyn) } :rodata
  .rela.plt : { *(.rela.plt) } :rodata
  .note.gnu.build-id : { *(.note.gnu.build-id) } :rodata
  __eh_frame_hdr_start = .;
  .eh_frame_hdr : { *(.eh_frame_hdr) } :rodata
  __eh_frame_hdr_end = .;
  .eh_frame : { *(.eh_frame) } :rodata
  . = ALIGN(0x1000);
  .dynamic : { *(.dynamic) } :data :dynamic
  .init_array : { KEEP(*(SORT_BY_INIT_PRIORITY(.init_array.*))) KEEP(*(.init_array)) } :data
  .fini_array : { KEEP(*(SORT_BY_INIT_PRIORITY(.fini_array.*))) KEEP(*(.fini_array)) } :data
  .got : { *(.got) } :data
  .got.plt : { *(.got.plt) } :data
  .data : { *(.data .data.*) } :data
  __bss_start = .;
  .bss : { *(.bss .bss.*) *(COMMON) } :data
  __bss_end = .;
  /DISCARD/ : { *(.comment) *(.note.GNU-stack) }
}
