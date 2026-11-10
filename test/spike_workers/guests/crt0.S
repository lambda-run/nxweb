// EXPERIMENTAL (spike). Flat test image (contract test ABI): entry at offset 0. The kernel starts the main thread
// with x0 = 0, x1 = its handle, x30 = the thread-exit pc; rt_entry's return value becomes the exit code.
    .section .text.start, "ax"
    .global _start
    .hidden rt_entry
_start:
    b       rt_entry
