// SVC wrappers with libnx's signatures; register conventions are Horizon's (src/kernel/svc.ts).
    .text
.macro FN name
    .global \name
    .hidden \name
    .type \name, %function
\name:
.endm
.macro PLAIN name, num
FN \name
    svc     #\num
    ret
.endm
// result in w0, one output from x1/w1 stored through the pointer that was in x0
.macro OUT64 name, num
FN \name
    str     x0, [sp, #-16]!
    svc     #\num
    ldr     x2, [sp], #16
    str     x1, [x2]
    ret
.endm
.macro OUT32 name, num
FN \name
    str     x0, [sp, #-16]!
    svc     #\num
    ldr     x2, [sp], #16
    str     w1, [x2]
    ret
.endm

OUT64 svcSetHeapSize, 0x01
FN svcQueryMemory                  // (MemoryInfo *info, u32 *pageinfo, u64 addr)
    str     x1, [sp, #-16]!
    svc     #0x06
    ldr     x2, [sp], #16
    str     w1, [x2]
    ret
PLAIN svcExitProcess, 0x07
OUT32 svcCreateThread, 0x08        // (Handle *out, entry, arg, stack_top, prio, core)
PLAIN svcStartThread, 0x09
PLAIN svcExitThread, 0x0A
PLAIN svcSleepThread, 0x0B
PLAIN svcSignalEvent, 0x11
PLAIN svcClearEvent, 0x12
PLAIN svcCloseHandle, 0x16
PLAIN svcResetSignal, 0x17
OUT32 svcWaitSynchronization, 0x18 // (s32 *index, const Handle *handles, s32 count, s64 timeout)
PLAIN svcArbitrateLock, 0x1A       // (owner handle, lock address, own handle)
PLAIN svcArbitrateUnlock, 0x1B
PLAIN svcWaitProcessWideKeyAtomic, 0x1C   // (lock address, key address, own handle, timeout)
PLAIN svcSignalProcessWideKey, 0x1D
PLAIN svcGetSystemTick, 0x1E
PLAIN svcBreak, 0x26
PLAIN svcOutputDebugString, 0x27
OUT64 svcGetInfo, 0x29             // (u64 *out, u32 id0, Handle h, u64 id1)
FN svcCreateEvent                  // (Handle *writable, Handle *readable)
    stp     x0, x1, [sp, #-16]!
    svc     #0x45
    ldp     x3, x4, [sp], #16
    str     w1, [x3]
    str     w2, [x4]
    ret
