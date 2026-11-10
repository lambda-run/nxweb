// Networking offline (src/hle/net.ts, offline.ts; nxnative hle_net.c, hle_offline.c). The scenario of nxnative's
// dm/host/tests/t_net_eventfd.c, with its other threads (a writer, a closer) as events between a wait and its resume.
import assert from "node:assert/strict";
import { test, Hle, RES_FAIL } from "./harness.mts";

const POLLIN = 1, POLLOUT = 4, EAGAIN = 35, EBADF = 9, ENETDOWN = 50, MINUS1 = 0xFFFFFFFF;
const EVENTFD = "_ZN2nn6socket7EventFdEmNS0_12EventFdFlagsE", READ = "_ZN2nn6socket11EventFdReadEiPm", WRITE = "_ZN2nn6socket12EventFdWriteEim";
const CLOSE = "_ZN2nn6socket5CloseEi", POLL = "_ZN2nn6socket4PollEPNS0_6PollFdEmi", NPOLL = "nnsocketPoll", ERR = "_ZN2nn6socket12GetLastErrorEv";
const SELECT = "_ZN2nn6socket6SelectEiPNS0_5FdSetES2_S2_PNS0_7TimeValE";

function net() {
  const h = new Hle();
  const v = h.alloc(8), p = h.alloc(8);
  return {
    h, v, p,
    pfd: (fd: number, events: number, revents = 0) => { h.dv.setInt32(p, fd, true); h.dv.setInt16(p + 4, events, true); h.dv.setInt16(p + 6, revents, true); return p; },
    revents: () => h.dv.getInt16(p + 6, true),
    err: () => h.w0(ERR),
    read: (fd: number) => { const r = h.w0(READ, fd, v); return [r, h.u64(v)] as [number, bigint]; },
  };
}

test("net (t_net_eventfd): an event descriptor works offline; Poll waits out its timeout on the guest clock", () => {
  const t = net(), h = t.h;
  const fd = h.w0(EVENTFD, 0, 6);   // the flags gRPC creates its descriptor with: never blocks
  assert.equal(fd, 0, "the bsd service's numbers: the lowest free one, from 0");
  h.dv.setBigUint64(t.v, 99n, true);
  assert.deepEqual(t.read(fd), [MINUS1, 99n]); assert.equal(t.err(), EAGAIN);
  let r = h.call(NPOLL, t.pfd(fd, POLLIN, 0x7f), 1, 20);
  assert.ok(r.wait, "nothing written: the caller waits");
  assert.equal(r.wait!.timeoutNs, 20_000_000n, "for the 20 ms");
  h.guestNs += 20_000_000n;
  r = h.resume("timeout");
  assert.ok(!r.wait); assert.equal(r.x0, 0n); assert.equal(t.revents(), 0, "the timeout passes: 0, no events");
  assert.equal(h.w0(WRITE, fd, 2), 0); assert.equal(h.w0(WRITE, fd, 3), 0);
  assert.equal(h.w0(POLL, t.pfd(fd, POLLIN), 1, 1000), 1); assert.equal(t.revents(), POLLIN);
  assert.deepEqual(t.read(fd), [0, 5n], "the counter, whole, then empty");
  assert.equal(t.read(fd)[0], MINUS1);
  // a write from another thread ends a wait at once
  r = h.call(POLL, t.pfd(fd, POLLIN), 1, 10000);
  assert.ok(r.wait && r.wait.timeoutNs === 10_000_000_000n);
  const ev = h.ev(r.wait!.handle); assert.ok(!ev.signaled);
  h.guestNs += 20_000_000n;
  const blk = h.last!;
  assert.equal(h.w0(WRITE, fd, 1), 0); assert.ok(ev.signaled, "the write signals what the poller waits on");
  h.last = blk; r = h.resume("signaled");
  assert.equal(r.x0, 1n); assert.equal(t.revents(), POLLIN);
  assert.deepEqual(t.read(fd), [0, 1n]);
  // an endless wait comes back with 0 after 100 ms, as with nothing to wait on
  r = h.call(POLL, t.pfd(fd, POLLIN), 1, -1);
  assert.equal(r.wait!.timeoutNs, 100_000_000n);
  h.guestNs += 60_000_000n; r = h.resume("cancelled");
  assert.equal(r.wait!.timeoutNs, 40_000_000n, "woken early: the rest of the time");
  h.guestNs += 40_000_000n; r = h.resume("timeout"); assert.equal(r.x0, 0n);
  assert.equal(h.w0(POLL, t.pfd(fd, POLLOUT), 1, 0), 1); assert.equal(t.revents(), POLLOUT, "writable whenever it is open");
});

test("net (t_net_eventfd): Select is Poll over its sets; a descriptor closed during the wait is EBADF", () => {
  const t = net(), h = t.h;
  const fd = h.w0(EVENTFD, 0, 6);
  const rs = h.alloc(128), ws = h.alloc(128), tv = h.alloc(16);
  const bit = (set: number, n: number) => (h.u64(set + 8 * (n >> 6)) >> BigInt(n & 63) & 1n) === 1n;
  const setBit = (set: number, n: number) => h.dv.setBigUint64(set + 8 * (n >> 6), h.u64(set + 8 * (n >> 6)) | 1n << BigInt(n & 63), true);
  h.dv.setBigInt64(tv, 0n, true); h.dv.setBigInt64(tv + 8, 20000n, true);   // 20 ms
  setBit(rs, fd);
  let r = h.call(SELECT, fd + 1, rs, 0, 0, tv);
  assert.equal(r.wait!.timeoutNs, 20_000_000n);
  assert.ok(bit(rs, fd), "the set is the game's while it waits");
  h.guestNs += 20_000_000n; r = h.resume("timeout");
  assert.equal(r.x0, 0n); assert.ok(!bit(rs, fd), "nothing written: the set comes back empty");
  assert.equal(h.w0(WRITE, fd, 1), 0);
  setBit(rs, fd); setBit(ws, fd); setBit(ws, 40);   // with a descriptor the host never made beside it: not ready
  assert.equal(h.w0(SELECT, 41, rs, ws, 0, tv), 2);
  assert.ok(bit(rs, fd) && bit(ws, fd) && !bit(ws, 40));
  assert.deepEqual(t.read(fd), [0, 1n]);
  const only = h.alloc(128); setBit(only, 1023);   // only a descriptor the host never made: nothing ready at the timeout
  r = h.call(SELECT, 1024, only, 0, 0, tv);
  assert.ok(r.wait); h.guestNs += 20_000_000n; r = h.resume("timeout");
  assert.equal(r.x0, 0n); assert.equal(h.u64(only + 120), 0n);
  r = h.call(SELECT, 0, 0, 0, 0, tv); h.guestNs += 20_000_000n; assert.equal(h.resume("timeout").x0, 0n);
  const sem = h.w0(EVENTFD, 2, 1 | 2);   // one at a time
  assert.equal(sem, 1);
  assert.deepEqual([t.read(sem), t.read(sem), t.read(sem)[0]], [[0, 1n], [0, 1n], MINUS1]);
  assert.equal(h.w0("nnsocketClose", fd), 0); assert.equal(h.w0(EVENTFD, 0, 6), 0, "the lowest free number is taken again"); assert.equal(h.w0("nnsocketClose", 0), 0);
  const cs = h.alloc(128); setBit(cs, sem);
  h.dv.setBigInt64(tv, 5n, true); h.dv.setBigInt64(tv + 8, 0n, true);
  r = h.call(SELECT, sem + 1, cs, 0, 0, tv);
  assert.equal(r.wait!.timeoutNs, 5_000_000_000n);
  const blk = h.last!;
  assert.equal(h.w0(CLOSE, sem), 0);
  h.last = blk; r = h.resume("signaled");
  assert.equal(Number(r.x0), MINUS1); assert.equal(t.err(), EBADF, "closed during a Select: EBADF, as select");
  assert.equal(h.w0("nnsocketClose", fd), MINUS1, "closed already");
  assert.equal(h.w0(WRITE, fd, 1), MINUS1); assert.equal(t.err(), EBADF);
  assert.equal(t.read(fd)[0], MINUS1); assert.equal(t.err(), EBADF);
});

test("net (t_net_eventfd): the table is reused and bounded; what needs the network stays offline", () => {
  const t = net(), h = t.h;
  for (let i = 0; i < 64; i++) assert.equal(h.w0(EVENTFD, 0, 6), i);
  assert.equal(h.w0(EVENTFD, 0, 6), MINUS1); assert.equal(t.err(), 24, "EMFILE"); assert.equal(h.red.length, 1);
  for (let i = 0; i < 64; i++) assert.equal(h.w0(CLOSE, i), 0);
  assert.equal(h.w0("nnsocketSocket", 2, 1, 0), MINUS1); assert.equal(t.err(), ENETDOWN);
  assert.equal(h.w0(NPOLL, t.pfd(64, POLLIN), 1, 0), 0); assert.equal(t.revents(), 0, "one the host never made: nothing ready");
  let r = h.call(NPOLL, t.pfd(-1, POLLIN, 0x7f), 1, 1);
  assert.equal(r.wait!.timeoutNs, 1_000_000n); r = h.resume("timeout");
  assert.equal(r.x0, 0n); assert.equal(t.revents(), 0);
  // a blocking descriptor (no flag) that is empty: the read waits for a write
  const fd = h.w0(EVENTFD, 0, 0);
  r = h.call(READ, fd, t.v); assert.ok(r.wait);
  const blk = h.last!; h.call(WRITE, fd, 7); h.last = blk;
  r = h.resume("signaled"); assert.equal(r.x0, 0n); assert.equal(h.u64(t.v), 7n);
  // the forms of hle_offline.c and the C library's poll share the descriptors
  h.call(WRITE, fd, 1);
  for (const n of ["_ZN2nn6socket4PollEP6pollfdmi", "poll"]) { assert.equal(h.w0(n, t.pfd(fd, POLLIN), 1, 0), 1, n); assert.equal(t.revents(), POLLIN); }
  const rs = h.alloc(128); h.dv.setBigUint64(rs, 1n << BigInt(fd), true);
  assert.equal(h.w0("_ZN2nn6socket6SelectEiP6fd_setS2_S2_P7timeval", fd + 1, rs, 0, 0, 0), 1);
});

test("net: one socket error store for both files; the C interface sets and reads it", () => {
  const { h, err } = net();
  assert.equal(err(), ENETDOWN, "ENETDOWN from the start");
  h.call("nnsocketSetLastErrno", 11); assert.equal(h.w0("nnsocketGetLastErrno"), 11); assert.equal(err(), 11);
  assert.equal(h.w0("_ZN2nn6socket12GetLastErrnoEv"), 11, "hle_offline.c's GetLastErrno reads the same store (nxnative: a constant 50)");
  assert.equal(h.w0("_ZN2nn6socket6SocketENS0_6FamilyENS0_4TypeENS0_8ProtocolE", 2, 1, 6), MINUS1); assert.equal(err(), ENETDOWN, "a cut call sets ENETDOWN (compiled from sk_fail())");
  h.call("nnsocketSetLastErrno", 1);
  assert.equal(h.call("_ZN2nn6socket16GetHostEntByNameEPKc", 0).x0, 0n); assert.equal(err(), ENETDOWN, "name resolution: NULL and ENETDOWN");
  h.call("nnsocketSetLastErrno", 1);
  assert.equal(h.w0("_ZN2nn6socket6SocketEiii", 2, 1, 0), MINUS1); assert.equal(err(), 1, "hle_offline.c's forms return -1 and leave the store");
  assert.equal(BigInt.asIntN(64, h.call("_ZN2nn6socket4RecvEiPvmNS0_7MsgFlagE", 0, 0, 0, 0).x0), -1n, "a long -1 fills x0");
  assert.equal(h.call("_ZN2nn6socket6SocketEiii", 2, 1, 0).x0, 0xFFFFFFFFn, "an int -1 is w0");
  const res = h.alloc(8, 0xEE);
  assert.equal(h.w0("_ZN2nn6socket11GetAddrInfoEPKcS2_PKNS0_8AddrInfoEPPS3_", 0, 0, 0, res), 4, "EAI_FAIL"); assert.equal(h.u64(res), 0n);
  assert.equal(h.cstr(Number(h.call("nnsocketGAIStrError", 4).x0)), "network unavailable");
  assert.equal(h.cstr(Number(h.call("_ZN2nn6socket11GAIStrErrorENS0_7AiErrnoE", 4).x0)), "network unavailable");
});

test("net: the nifm request is on hold for the first query after its submission, then settled", () => {
  const h = new Hle();
  const hold = () => h.w0("_ZN2nn4nifm22IsNetworkRequestOnHoldEv"), submit = () => h.call("_ZN2nn4nifm20SubmitNetworkRequestEv"), cancel = () => h.call("_ZN2nn4nifm20CancelNetworkRequestEv");
  assert.equal(hold(), 0, "no request");
  submit(); assert.deepEqual([hold(), hold(), hold()], [1, 0, 0]);
  submit(); submit(); assert.deepEqual([hold(), hold()], [1, 0], "a second submission while on hold is one hold");
  submit(); cancel(); assert.equal(hold(), 0, "cancelled");
  cancel(); assert.equal(h.red.length, 0, "a cancel with nothing pending is nothing");
  assert.equal(h.w0("_ZN2nn4nifm18IsNetworkAvailableEv"), 0);
  assert.equal(h.w0("_ZN2nn4nifm31HandleNetworkRequestErrorResultEv"), 0);
  assert.equal(h.call("_ZN2nn4nifm10InitializeEv").x0, 0n);
  const ip = h.alloc(4, 0xEE);
  assert.equal(h.call("_ZN2nn4nifm26GetCurrentPrimaryIpAddressEPNS_6socket6InAddrE", ip).x0, RES_FAIL); assert.equal(h.u32(ip), 0);
  assert.equal(h.call("_ZN2nn4nifm26GetCurrentPrimaryIpAddressEPNS_6socket6InAddrE", 0).x0, RES_FAIL, "a null output is skipped");
  const five = Array.from({ length: 5 }, () => h.alloc(4, 0xEE));
  for (const n of ["_ZN2nn4nifm22GetCurrentIpConfigInfoEP7in_addrS2_S2_S2_S2_", "_ZN2nn4nifm22GetCurrentIpConfigInfoEPNS_6socket6InAddrES3_S3_S3_S3_"]) {
    five.forEach(p => h.dv.setUint32(p, 0xEEEEEEEE, true));
    assert.equal(h.call(n, five[0], 0, five[2], five[3], five[4]).x0, RES_FAIL);
    assert.deepEqual(five.map(p => h.u32(p)), [0, 0xEEEEEEEE, 0, 0, 0]);
  }
  const n4 = h.alloc(4, 0xEE), n6 = h.alloc(4, 0xEE);
  assert.equal(h.call("_ZN2nn4nifm18GetCurrentIpConfigEPNS0_10Ipv4ConfigEPiPNS0_10Ipv6ConfigES3_ii", 0, n4, 0, n6, 1, 1).x0, RES_FAIL); assert.deepEqual([h.i32(n4), h.i32(n6)], [0, 0]);
});

test("offline: ssl, ldn, bluetooth, irsensor, prepo, bcat, album, pdm: results and what they write", () => {
  const h = new Hle();
  const ok = (n: string, ...a: number[]) => assert.equal(h.call(n, ...a).x0, 0n, n), fail = (n: string, ...a: number[]) => assert.equal(h.call(n, ...a).x0, RES_FAIL, n);
  ok("nnsslInitialize"); ok("_ZN2nn3ssl10InitializeEv"); ok("_ZN2nn3ssl7Context6CreateENS1_10SslVersionE", 0, 0); ok("_ZN2nn3ssl7Context7DestroyEv", 0);
  fail("_ZN2nn3ssl10Connection6CreateEPNS0_7ContextE", 0, 0); fail("nnsslConnectionCreate");
  const r4 = h.alloc(8, 0xEE);
  fail("_ZN2nn3ssl10Connection12GetLastErrorEPNS_6ResultE", 0, r4); assert.equal(h.u32(r4), 0x2A2, "the Result written is the failure too"); assert.equal(h.u32(r4 + 4), 0xEEEEEEEE);
  fail("_ZN2nn3ssl7Context15ImportClientPkiEPmPKcS4_jj", 0, r4); assert.equal(h.u64(r4), 0n, "the id is cleared");
  assert.equal(h.w0("_ZN2nn3ssl10Connection4ReadEPcj", 0, 0, 0), 0xFFFFFFFF);
  fail("_ZN2nn3ldn10InitializeEv"); assert.equal(h.w0("_ZN2nn3ldn8GetStateEv"), 0);
  const n = h.alloc(4, 0xEE); fail("_ZN2nn3ldn4ScanEPNS0_11NetworkInfoEPiiRKNS0_10ScanFilterEi", 0, n, 8, 0, 0); assert.equal(h.i32(n), 0);
  const a4 = h.alloc(4, 0xEE), m4 = h.alloc(4, 0xEE); fail("_ZN2nn3ldn14GetIpv4AddressEPNS0_11Ipv4AddressEPNS0_10SubnetMaskE", a4, m4); assert.deepEqual([h.u32(a4), h.u32(m4)], [0, 0]);
  ok("_ZN2nn9bluetooth22StopBleScanSmartDeviceEv"); fail("_ZN2nn9bluetooth19ConnectToGattServerERKNS0_7AddressE", 0);
  const npad = h.alloc(4); h.dv.setUint32(npad, 0x12345620, true);
  assert.equal(h.w0("_ZN2nn8irsensor17GetIrCameraHandleERKj", npad), 0x20, "the player number in the low byte");
  assert.equal(h.w0("_ZN2nn8irsensor17GetIrCameraStatusERKNS0_14IrCameraHandleE", 0), 2, "unconnected");
  ok("_ZN2nn5prepo10PlayReport4SaveEv", 0); ok("_ZN2nn5prepo28RequestImmediateTransmissionEv");
  // SDK 22's PlayReport::Send returns an AsyncContext through x8: a null service object, x0 untouched
  const ctx = h.alloc(16, 0xEE);
  const r = h.callRegs("_ZN2nn5prepo10PlayReport4SendERKNS_7account3UidE", { x: [0x1234, 0x5678], x8: ctx });
  assert.equal(r.x0, 0x1234n); assert.deepEqual([h.u64(ctx), h.u64(ctx + 8)], [0n, 0xEEEEEEEEEEEEEEEEn], "8 bytes at [x8]");
  fail("_ZN2nn4bcat25MountDeliveryCacheStorageEv"); fail("_ZN2nn5album14ShowAlbumFilesEv");
  const url = h.alloc(8, 0xEE); fail("_ZN2nn5album21GetSharePostedLastUrlEPcmRKNS0_7ShareIdE", url, 8, 0); assert.deepEqual([...h.read(url, 2)], [0, 0xEE]);
  fail("_ZN2nn5album21GetSharePostedLastUrlEPcmRKNS0_7ShareIdE", url + 1, 0, 0); assert.equal(h.u8[url + 1], 0xEE, "no room: nothing written");
  const env = h.alloc(16, 0xEE); h.call("_ZN2nn3nsd24GetEnvironmentIdentifierEPNS0_21EnvironmentIdentifierE", env);
  assert.deepEqual(h.read(env, 16), Buffer.concat([Buffer.from("lp1\0\0\0\0\0"), Buffer.alloc(8, 0xEE)]));
  // play statistics: 0x18 bytes { application ID, play time, launch count } per asked ID
  const ids = h.alloc(16), out = h.alloc(56, 0xEE);
  h.dv.setBigUint64(ids, 0x0100ABCD00001000n, true); h.dv.setBigUint64(ids + 8, 0x0100ABCD00002000n, true);
  ok("_ZN2nn3pdm30QueryApplicationPlayStatisticsEPNS0_25ApplicationPlayStatisticsERKNS_7account3UidEPKNS_13ApplicationIdEi", out, 0, ids, 2);
  assert.deepEqual([0, 8, 16, 24, 32, 40, 48].map(o => h.u64(out + o)), [0x0100ABCD00001000n, 0n, 0n, 0x0100ABCD00002000n, 0n, 0n, 0xEEEEEEEEEEEEEEEEn]);
  const masks = h.alloc(16, 0xEE);
  ok("_ZN2nn3ngc15ProfanityFilter19CheckProfanityWordsEPjjPPKDsm", 0, masks, 0, 0, 3); assert.deepEqual([0, 4, 8, 12].map(o => h.u32(masks + o)), [0, 0, 0, 0xEEEEEEEE]);
  const b = h.alloc(2, 0xEE); ok("_ZN2nn3ngc47CheckProfanityWordsInTextForPlatformRegionChinaEPbPKc", b, 0); assert.deepEqual([...h.read(b, 2)], [0, 0xEE]);
  assert.equal(h.red.length, 0);
});
