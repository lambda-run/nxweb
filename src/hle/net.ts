// Networking: port of nxnative dm/host/hle_net.c. Everything is "network unavailable"; the cut calls are compiled
// from the C text. Here: the nifm request (machine nifm_request), the one socket error store, and the event
// descriptors, which are local to the bsd service and work offline, with Poll and Select over them.
// One error store for hle_net.c and hle_offline.c (nxnative keeps hle_net.c's per thread).
import { Inst } from "../kit/machine";
import { NIFM_REQUEST, NifmRequestS, NifmRequestE } from "../kit/gen/tables";
import { X, W, I, P, C, setC, wait, sleepEvent, newEventPair, eventSignal, eventClear, guestNs, resumeHow, ls, ps, pi, pu, px, le, red } from "./base";

const SK_ENETDOWN: i32 = 50, SK_EBADF: i32 = 9, SK_EAGAIN: i32 = 35, SK_EMFILE: i32 = 24;
const POLLIN: i32 = 1, POLLOUT: i32 = 4, POLLRDNORM: i32 = 0x40, POLLWRNORM: i32 = 4, POLLNVAL: i32 = 0x20;
let skerr: i32 = SK_ENETDOWN;
export function setErrno(e: i32): void { skerr = e; }
export function getErrno(): i32 { return skerr; }
function skFail(): u64 { skerr = SK_ENETDOWN; return 0xFFFFFFFF; }

// ---------- nifm: the request is on hold for the first query after its submission, then settled as unavailable ----------
const NIFM: usize = memory.data(16);
// @ts-ignore: decorator
@inline function nifm(): Inst { return Inst.at(NIFM); }
export function h_nifm_Submit(a: usize): u64 { nifm().step(NifmRequestE.Submit); return 0; }
export function h_nifm_Cancel(a: usize): u64 { if (nifm().can(NifmRequestE.Cancel)) nifm().step(NifmRequestE.Cancel); return 0; }
export function h_nifm_OnHold(a: usize): u64 {
  if (nifm().state != NifmRequestS.OnHold) return 0;
  nifm().step(NifmRequestE.Query);
  return 1;
}

// ---------- event descriptors: host counters. Numbers are the bsd service's: the lowest free one, from 0 ----------
const EFD_MAX: i32 = 64;
const EFD: usize = memory.data(1024);   // per descriptor: +0 u64 count, +8 i32 used, +12 i32 flags
let efdR: u32 = 0, efdW: u32 = 0, efdRed: bool = false, pollLogged: bool = false;
const WH: usize = memory.data(8);
// @ts-ignore: decorator
@inline function efd(fd: i32): usize { return EFD + (<usize>fd << 4); }
function efdUsed(fd: i32): bool { return fd >= 0 && fd < EFD_MAX && load<i32>(efd(fd), 8) != 0; }
function efdEvent(): u32 { if (!efdR) { efdR = newEventPair(WH); efdW = load<u32>(WH); } return efdR; }
function efdWake(): void { if (efdW) eventSignal(efdW); }
// The caller waits for a change of any descriptor (a write or a close), at most ns
function efdWait(ns: i64): u64 { const r = efdEvent(); eventClear(efdW); return wait(r, ns); }
function efdClose(fd: i32): u64 {
  if (!efdUsed(fd)) return skFail();
  store<i32>(efd(fd), 0, 8); efdWake();
  return 0;
}
export function h_sk_EventFd(a: usize): u64 {
  for (let i = 0; i < EFD_MAX; i++) if (!load<i32>(efd(i), 8)) { store<i32>(efd(i), 1, 8); store<u64>(efd(i), X(a, 0)); store<i32>(efd(i), I(a, 1), 12); return <u64>i; }
  if (!efdRed) { efdRed = true; red("net: more than 64 event descriptors"); }
  skerr = SK_EMFILE; return 0xFFFFFFFF;
}
// A descriptor with flag bit 0 reads one at a time; bits 1 and 2 never block. An empty blocking one waits
export function h_sk_EventFdRead(a: usize): u64 {
  const fd = I(a, 0), out = P(a, 1);
  if (!efdUsed(fd)) { skerr = SK_EBADF; return 0xFFFFFFFF; }
  const c = load<u64>(efd(fd)), f = load<i32>(efd(fd), 12);
  if (c) {
    let v: u64;
    if (f & 1) { v = 1; store<u64>(efd(fd), c - 1); } else { v = c; store<u64>(efd(fd), 0); }
    if (out) store<u64>(out, v);
    return 0;
  }
  if (f & 6) { skerr = SK_EAGAIN; return 0xFFFFFFFF; }
  return efdWait(100000000);
}
export function h_sk_EventFdWrite(a: usize): u64 {
  const fd = I(a, 0);
  if (!efdUsed(fd)) { skerr = SK_EBADF; return 0xFFFFFFFF; }
  store<u64>(efd(fd), load<u64>(efd(fd)) + X(a, 1)); efdWake();
  return 0;
}
export function h_sk_Close(a: usize): u64 { return efdClose(I(a, 0)); }
export function h_nsk_Close(a: usize): u64 { return efdClose(I(a, 0)); }

// pollfd = { i32 fd, i16 events, i16 revents }. Fills revents; how many descriptors have any. `open` holds the
// descriptors that were open when the wait began: one of those closed since is POLLNVAL, any other is one the host
// never made, with nothing to say
function efdReady(p: usize, n: u64, open: u64): i32 {
  let ready = 0;
  for (let i: u64 = 0; i < n; i++) {
    const e = p + (<usize>i << 3), fd = load<i32>(e), ev = <i32>load<i16>(e, 4);
    store<i16>(e, 0, 6);
    if (fd < 0 || fd >= EFD_MAX || !((open >> <u64>fd) & 1)) continue;
    if (!efdUsed(fd)) { store<i16>(e, <i16>POLLNVAL, 6); ready++; continue; }   // closed while waiting
    let r = 0;
    if (load<u64>(efd(fd))) r |= ev & (POLLIN | POLLRDNORM);
    r |= ev & (POLLOUT | POLLWRNORM);
    store<i16>(e, <i16>r, 6);
    if (r) ready++;
  }
  return ready;
}
// dm_sk_poll. Continuation slots: 0 phase (0 first entry, 1 idling out the timeout, 2 waiting on descriptors),
// 1 the guest time the wait began, 2 the open mask. Returns -2 when the caller has to wait (base.wait was called).
// With nothing of the host's to wait on the timeout passes and the answer is 0; an endless wait comes back with 0 after 100 ms
function pollCore(a: usize, p: usize, n: u64, ms: i32): i32 {
  const phase = C(a, 0);
  if (phase == 1) return 0;
  let open: u64 = 0, start: u64 = 0;
  const limit: i64 = (ms < 0 ? 100 : <i64>ms) * 1000000;
  if (phase == 0) {
    for (let i: u64 = 0; i < n; i++) {
      const fd = load<i32>(p + (<usize>i << 3));
      if (fd < 0) continue;
      if (efdUsed(fd)) { open |= <u64>1 << <u64>fd; continue; }
      if (!pollLogged) { pollLogged = true; ls(); ps("socket: Poll of "); pu(n); ps(" descriptors with one the host never made (fd "); pi(fd); ps(", events "); px(<u32><u16>load<i16>(p + (<usize>i << 3), 4)); ps("; "); pi(ms); ps(" ms): nothing ready at the timeout"); le(); }
    }
    for (let i: u64 = 0; i < n; i++) store<i16>(p + (<usize>i << 3), 0, 6);
    if (!open) {
      if (limit <= 0) return 0;
      setC(a, 0, 1); wait(sleepEvent(), limit); return -2;
    }
    start = guestNs();
    setC(a, 0, 2); setC(a, 1, start); setC(a, 2, open);
  } else { start = C(a, 1); open = C(a, 2); }
  const ready = efdReady(p, n, open);
  if (ready) return ready;
  const left = limit - <i64>(guestNs() - start);
  if (left <= 0) return 0;
  efdWait(left);
  return -2;
}
function poll(a: usize): u64 { const r = pollCore(a, P(a, 0), X(a, 1), I(a, 2)); return r == -2 ? 0 : <u64><u32>r; }
export function h_sk_Poll(a: usize): u64 { return poll(a); }
export function h_libc_Poll(a: usize): u64 { return poll(a); }
export function h_nsk_Poll(a: usize): u64 { return poll(a); }
export function pollArgs(a: usize): u64 { return poll(a); }
// Select is Poll over the descriptors in its sets (fd_set: 1024 bits; timeval: { i64 seconds, i64 microseconds }):
// the read set asks POLLIN, the write set POLLOUT, and the sets come back with the ready ones. A descriptor closed
// during the wait fails with EBADF. The sets stay as the game gave them while the caller waits, so the pollfd array
// is built again from them on each entry
const SELP: usize = memory.data(512);
export function select(a: usize): u64 {
  let nfds = I(a, 0); const r = P(a, 1), w = P(a, 2), e = P(a, 3), tv = P(a, 4);
  if (nfds > 1024) nfds = 1024;
  let np: usize = 0;
  for (let fd = 0; fd < nfds && fd < EFD_MAX; fd++) {
    let ev = 0, isIn = false;
    if (r && (load<u64>(r + (<usize>(fd >> 6) << 3)) >> <u64>(fd & 63)) & 1) { isIn = true; ev |= POLLIN; }
    if (w && (load<u64>(w + (<usize>(fd >> 6) << 3)) >> <u64>(fd & 63)) & 1) { isIn = true; ev |= POLLOUT; }
    if (e && (load<u64>(e + (<usize>(fd >> 6) << 3)) >> <u64>(fd & 63)) & 1) isIn = true;
    if (isIn) { store<i32>(SELP + (np << 3), fd); store<i16>(SELP + (np << 3), <i16>ev, 4); store<i16>(SELP + (np << 3), 0, 6); np++; }
  }
  let ms: i64 = tv ? load<i64>(tv) * 1000 + load<i64>(tv, 8) / 1000 : -1;
  if (ms > 0x7fffffff) ms = 0x7fffffff;
  if (pollCore(a, SELP, <u64>np, <i32>ms) == -2) return 0;
  for (let fd = 0; fd < nfds; fd++) {
    const m: u64 = ~(<u64>1 << <u64>(fd & 63)), o = <usize>(fd >> 6) << 3;
    if (r) store<u64>(r + o, load<u64>(r + o) & m);
    if (w) store<u64>(w + o, load<u64>(w + o) & m);
    if (e) store<u64>(e + o, load<u64>(e + o) & m);
  }
  let n = 0;
  for (let i: usize = 0; i < np; i++) {
    const fd = load<i32>(SELP + (i << 3)), rev = <i32>load<i16>(SELP + (i << 3), 6), o = <usize>(fd >> 6) << 3, bit: u64 = <u64>1 << <u64>(fd & 63);
    if (rev & POLLNVAL) { skerr = SK_EBADF; return 0xFFFFFFFF; }
    if ((rev & (POLLIN | POLLRDNORM)) && r) { store<u64>(r + o, load<u64>(r + o) | bit); n++; }
    if ((rev & POLLOUT) && w) { store<u64>(w + o, load<u64>(w + o) | bit); n++; }
  }
  return <u64>n;
}
export function h_sk_Select(a: usize): u64 { return select(a); }
export function h_sk_GetLastError(a: usize): u64 { return <u64><u32>skerr; }
export function h_nsk_GetErrno(a: usize): u64 { return <u64><u32>skerr; }
export function h_nsk_SetErrno(a: usize): u64 { skerr = I(a, 0); return 0; }

export function netInit(): void {
  skerr = SK_ENETDOWN; nifm().init(NIFM_REQUEST, 0);
  memory.fill(EFD, 0, 1024); efdR = 0; efdW = 0; efdRed = false; pollLogged = false;
}
