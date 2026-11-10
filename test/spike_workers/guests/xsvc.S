// EXPERIMENTAL (spike). The two SVCs test/runtime/src/svc.S does not wrap.
    .text
    .global svcSetThreadActivity
    .hidden svcSetThreadActivity
svcSetThreadActivity:            // (Handle thread, int activity: 1 paused, 0 runnable)
    svc     #0x32
    ret
    .global svcGetThreadContext3
    .hidden svcGetThreadContext3
svcGetThreadContext3:            // (ThreadContext *out, Handle thread)
    svc     #0x33
    ret
