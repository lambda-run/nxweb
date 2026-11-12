#!/usr/bin/env python3
"""Generate build/host/hle_thread.c from nxnative's dm/host/hle_thread.c (read-only reference).

The file is taken as it is except for the edits listed in EDITS: everything else that is Apple-only
(Mach thread ports, QoS classes, vm_read_overwrite, the one-argument pthread_setname_np) is answered by the
headers in kernel/shim/. Every edit is anchored on exact text and the script fails when an anchor is gone,
so a new nxnative revision cannot be ported silently wrong.
Usage: port_thread.py <nxnative>/dm/host/hle_thread.c <out.c>
"""
import sys

src_path, out_path = sys.argv[1], sys.argv[2]
s = open(src_path, encoding="utf-8").read()
n_edits = 0

def replace_once(old, new):
    global s, n_edits
    if s.count(old) != 1:
        sys.exit(f"port_thread: anchor found {s.count(old)} times (want 1): {old[:70]!r}")
    s = s.replace(old, new); n_edits += 1

def replace_body(signature, body):
    """Replace the body of the top-level function that starts with `signature` (ending in '{')."""
    global s, n_edits
    a = s.find(signature)
    if a < 0 or s.count(signature) != 1: sys.exit(f"port_thread: function not found: {signature!r}")
    b = s.find("\n}\n", a)
    if b < 0: sys.exit("port_thread: no end of function")
    s = s[:a] + signature + "\n" + body + s[b:]; n_edits += 1

# 1. Pausing a thread that runs guest code. Natively: SIGUSR2 and the Darwin ucontext. In a browser there are no
#    signals: translated code has to stop itself at a yield point (budget check) and save its context with the
#    core's save_ctx. Not needed until a game uses SetThreadActivity on running threads (IL2CPP's collector).
replace_body("static void on_pause_sig(int sig, siginfo_t *si, void *uc_) {",
             "    (void)sig; (void)si; (void)uc_;   /* nxem: seam, see ARCHITECTURE.md \"Pausing\" */")

# 2. Calling guest code from the host. Natively a guest function is a C function pointer; here it is a guest pc
#    that the calling thread's translated-code instance has to run (kernel/nx_guest.js nx_guest_call).
replace_once("uint32_t r = create(ev, autoclear, 1);",
             "uint32_t r = (uint32_t)nx_guest_call((uint64_t)(uintptr_t)create, (uint64_t)(uintptr_t)ev, (uint64_t)autoclear, 1);")
replace_once("wh = getw(ev);",
             "wh = (uint32_t)nx_guest_call((uint64_t)(uintptr_t)getw, (uint64_t)(uintptr_t)ev, 0, 0);")

# 3. One running guest thread per virtual core (kernel/nx_cores.c): a thread gives its core up where it stops running
#    guest code. It takes one again at the end of the SVC or host call (kernel/nx_guest.c, nx_proc.c), outside G.
replace_once("    hand_leave(t);\n    struct timespec dl;", "    hand_leave(t);\n    nx_core_release();   /* nxem: blocked in the kernel */\n    struct timespec dl;")
replace_once("    if (entering) { t->native_wait++; hand_leave(t); }", "    if (entering) { t->native_wait++; hand_leave(t); nx_core_release(); /* nxem: blocked in host code */ }")
#    nxnative's own same-core handoff (the waker sleeps until the higher-priority threads it woke have blocked) needs
#    those threads to run meanwhile: the waker gives its core up for it.
replace_once("uint64_t t0 = now_ns(); int w = dm_yield_to_core_peers(g_core_preempt);", "uint64_t t0 = now_ns(); nx_core_release(); int w = dm_yield_to_core_peers(g_core_preempt);")
# 4. nxweb's wake hand-off between cores (its src/kernel/sched.ts HOLD; NX_WAKE_HANDOFF=1). nxnative holds a waker only
#    for a better thread pinned to the waker's own core. nxweb found that this game's movie library needs more with the
#    Switch 2's cores: a thread whose SVC made a thread of better priority ready on ANOTHER core stands back until that
#    thread has blocked (or a bound has passed: nxweb's four slices, here 5 ms), which keeps the order the two would have
#    on the console, where the woken thread starts at once. Without it the story movie stalled (2026-11-12).
replace_once("    if (t->prio < self->prio && t->mask == 1ull << (self->core & 63) && !(self->mask & ~t->mask)) self->yield_pending = 1;",
             "    if (t->prio < self->prio && ((t->mask == 1ull << (self->core & 63) && !(self->mask & ~t->mask)) || nx_wake_handoff())) self->yield_pending = 1;")
replace_once("    if (self->mask & ~bit) return 0;\n    for (;;) {\n        int busy = 0;",
             "    int multi = (self->mask & ~bit) != 0, xh = nx_wake_handoff(); uint64_t x0 = now_ns();\n    if (multi && !xh) return 0;\n    for (;;) {\n        int busy = 0;")
replace_once("            if (t != self && t->started && !t->exited && !t->host_owned && t->mask == bit && t->prio < self->prio && thr_runnable(t) && (all || thr_in_handoff(t, self))) busy = 1;",
             "            if (t != self && t->started && !t->exited && !t->host_owned && t->prio < self->prio && thr_runnable(t)) {\n"
             "                if (t->mask == bit && !multi && (all || thr_in_handoff(t, self))) busy = 1;\n"
             "                else if (xh && thr_in_handoff(t, self) && now_ns() - x0 < 5000000ull) { busy = 1; g_xhand_n += !waited; }   /* nxem: another core's thread this one made ready */\n"
             "            }")
replace_once("static int g_core_preempt;", "static int g_core_preempt;\nstatic uint64_t g_xhand_n;\nstatic int nx_wake_handoff(void) { static int on = -1; if (on < 0) { const char *e = getenv(\"NX_WAKE_HANDOFF\"); on = e && *e == '1'; } return on; }   /* nxem */")
s += """
// nxem (kernel/port_thread.py): what kernel/nx_cores.c reads of the calling guest thread, without G
int nx_thr_sched(int *prio, uint64_t *mask) {
    thr_t *t = pthread_getspecific(g_keythr);
    if (!t || t->host_owned) return -1;
    *prio = t->prio; *mask = t->mask;
    return t->core >= 0 ? t->core : t->mask ? __builtin_ctzll(t->mask) : 0;
}
// the threads that yield most since the last call, for the progress line: "handle 'name' N yields" x4
void nx_yield_top(char *out, size_t n) {
    thr_t *top[4] = {0}; uint64_t d[4] = {0};
    pthread_mutex_lock(&G);
    for (thr_t *t = g_all; t; t = t->all) {
        uint64_t y = t->nyield - t->nyield_seen; t->nyield_seen = t->nyield;
        for (int i = 0; i < 4; i++) if (y > d[i]) { for (int j = 3; j > i; j--) { top[j] = top[j - 1]; d[j] = d[j - 1]; } top[i] = t; d[i] = y; break; }
    }
    size_t o = 0; char nb[32]; out[0] = 0;
    for (int i = 0; i < 4 && top[i] && d[i] && o < n; i++) o += (size_t)snprintf(out + o, n - o, "%s%#x '%s' prio %d core %d x%llu", i ? ", " : "", top[i]->handle, thr_name(top[i], nb, sizeof nb), top[i]->prio, top[i]->core, (unsigned long long)d[i]);
    pthread_mutex_unlock(&G);
}
// nxem: for the stall report (kernel/nx_proc.c), one consistent picture under G. A lock's word holds its owner's tag,
// which is the owner's thread id (the TLR's +0x110, from 0x51), not its handle: every tag with its thread, and for each
// thread that waits for a lock who the owner is and what that one is doing.
void nx_lock_report(void) {
    static const char *kinds[] = {"runs (not waiting)", "waits for a lock", "waits on a condition variable", "waits on an address", "waits on a sync object"};
    char nb[32], nb2[32];
    pthread_mutex_lock(&G);
    LOG("wake hand-off between cores: %s; held %llu times so far", nx_wake_handoff() ? "on" : "off (NX_WAKE_HANDOFF=1)", (unsigned long long)g_xhand_n);
    for (thr_t *t = g_all; t; t = t->all) if (!t->exited) LOG("  tag %#llx = thread %#x '%s' prio %d core %d: %s%s", (unsigned long long)t->id, t->handle, thr_name(t, nb, sizeof nb), t->prio, t->core, kinds[t->wkind >= 0 && t->wkind <= 4 ? t->wkind : 0], t->sleeping ? " (in a timed sleep)" : t->native_wait ? " (in a host wait)" : "");
    for (thr_t *t = g_all; t; t = t->all) {
        if (t->exited || t->wkind != 1 || !t->waddr) continue;
        uint32_t w = ld32(t->waddr), tag = w & ~WAITERS_BIT; thr_t *o = NULL;
        for (thr_t *x = g_all; x; x = x->all) if ((uint32_t)x->id == tag) { o = x; break; }
        if (!o) LOG("  [RED] thread %#x '%s' waits for the lock at %#llx whose word is %#x: tag %#x is NO thread (the word is not a lock any more: freed or overwritten memory?)", t->handle, thr_name(t, nb, sizeof nb), (unsigned long long)t->waddr, w, tag);
        else LOG("  %sthread %#x '%s' waits for the lock at %#llx (word %#x): its owner is thread %#x '%s', which %s%s", o->exited || o == t ? "[RED] " : "", t->handle, thr_name(t, nb, sizeof nb), (unsigned long long)t->waddr, w, o->handle, thr_name(o, nb2, sizeof nb2),
                 o->exited ? "has EXITED" : o == t ? "is this thread itself" : kinds[o->wkind >= 0 && o->wkind <= 4 ? o->wkind : 0], !o->exited && o->wkind == 1 && o->waddr == t->waddr ? " [RED] (the SAME lock)" : "");
    }
    pthread_mutex_unlock(&G);
}
"""

header = ("// GENERATED by nxem/kernel/port_thread.py from nxnative dm/host/hle_thread.c: do not edit.\n"
          "#include \"nx_port.h\"\n")
open(out_path, "w", encoding="utf-8").write(header + s)
print(f"port_thread: {n_edits} edits, {s.count(chr(10))} lines")
