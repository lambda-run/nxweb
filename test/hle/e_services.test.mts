// account, friends, mii, misc (aoc, ec, ngc, pctl, streamplay, chat), sdkinit, nvdrv, os: results and layouts
// against nxnative's C (hle_account.c, hle_friends.c, hle_mii.c, hle_misc.c, hle_sdkinit.c, hle_nvdrv.c, hle_os.c).
// Ported scenarios: nxnative dm/host/tests/t_pctl.c.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, Hle, RES_FAIL, NXNATIVE } from "./harness.mts";

const UID = [0x78626c0000000001n, 0x53574e4154495645n], MAGIC = 0x55534552484e444cn;

test("account: one fixed local user; Uid 16 bytes, UserHandle 24 bytes, Nickname 33 bytes", () => {
  const h = new Hle();
  const n = h.alloc(4, 0xEE), out = h.alloc(48, 0xEE);
  for (const name of ["_ZN2nn7account13ListOpenUsersEPiPNS0_3UidEi", "_ZN2nn7account12ListAllUsersEPiPNS0_3UidEi", "_ZN2nn7account18ListQualifiedUsersEPiPNS0_3UidEi"]) {
    h.u8.fill(0xEE, out, out + 48);
    assert.equal(h.call(name, n, out, 2).x0, 0n);
    assert.equal(h.i32(n), 1); assert.deepEqual([h.u64(out), h.u64(out + 8), h.u64(out + 16)], [...UID, 0xEEEEEEEEEEEEEEEEn], name);
    h.u8.fill(0xEE, out, out + 48); assert.equal(h.call(name, n, out, 0).x0, 0n); assert.equal(h.i32(n), 0); assert.equal(h.u64(out), 0xEEEEEEEEEEEEEEEEn, "no room: nothing written");
  }
  h.call("_ZN2nn7account12GetUserCountEPi", n); assert.equal(h.i32(n), 1);
  h.dv.setInt32(n, 7, true); h.call("_ZN2nn7account12PopOpenUsersEPiPNS0_10UserHandleEi", n, 0, 4); assert.equal(h.i32(n), 0, "users opened by the system: none");
  const hd = h.alloc(32, 0xEE);
  assert.equal(h.w0("_ZN2nn7account22TryOpenPreselectedUserEPNS0_10UserHandleE", hd), 1);
  assert.deepEqual([0, 8, 16, 24].map(o => h.u64(hd + o)), [...UID, MAGIC, 0xEEEEEEEEEEEEEEEEn]);
  h.u8.fill(0xEE, hd, hd + 32); assert.equal(h.call("_ZN2nn7account19OpenPreselectedUserEPNS0_10UserHandleE", hd).x0, 0n, "a Result 0 (SDK 6 reads it)"); assert.equal(h.u64(hd + 16), MAGIC);
  const uid = h.alloc(16); h.dv.setBigUint64(uid, 0x1111n, true); h.dv.setBigUint64(uid + 8, 0x2222n, true);
  h.call("_ZN2nn7account8OpenUserEPNS0_10UserHandleERKNS0_3UidE", hd, uid);
  assert.deepEqual([0, 8, 16].map(o => h.u64(hd + o)), [0x1111n, 0x2222n, MAGIC], "the handle holds the Uid itself");
  const back = h.alloc(24, 0xEE);
  assert.equal(h.call("_ZN2nn7account9GetUserIdEPNS0_3UidERKNS0_10UserHandleE", back, hd).x0, 0n); assert.deepEqual([0, 8, 16].map(o => h.u64(back + o)), [0x1111n, 0x2222n, 0xEEEEEEEEEEEEEEEEn]);
  h.dv.setBigUint64(hd + 16, 5n, true);
  assert.equal(h.call("_ZN2nn7account9GetUserIdEPNS0_3UidERKNS0_10UserHandleE", back, hd).x0, RES_FAIL); assert.equal(h.red.length, 1, "a handle the host did not issue: red (nxnative stops)");
  h.call("_ZN2nn7account17GetLastOpenedUserEPNS0_3UidE", back); assert.deepEqual([h.u64(back), h.u64(back + 8)], UID);
  const ex = h.alloc(2, 0xEE);
  h.call("_ZN2nn7account16GetUserExistenceEPbRKNS0_3UidE", ex, back); assert.deepEqual([...h.read(ex, 2)], [1, 0xEE]);
  h.call("_ZN2nn7account16GetUserExistenceEPbRKNS0_3UidE", ex, uid); assert.equal(h.u8[ex], 0);
  const nick = h.alloc(40, 0xEE);
  assert.equal(h.call("_ZN2nn7account11GetNicknameEPNS0_8NicknameERKNS0_3UidE", nick, back).x0, 0n);
  assert.deepEqual(h.read(nick, 40), Buffer.concat([Buffer.from("Player"), Buffer.alloc(27), Buffer.alloc(7, 0xEE)]));
  h.host.config({ nick: "A".repeat(40) }); h.call("_ZN2nn7account11GetNicknameEPNS0_8NicknameERKNS0_3UidE", nick, back);
  assert.deepEqual(h.read(nick, 40), Buffer.concat([Buffer.from("A".repeat(32)), Buffer.alloc(1), Buffer.alloc(7, 0xEE)]), "32 bytes and a terminator");
});

test("account: the profile image is nxnative's 670-byte JPEG; online accounts are cut; async contexts complete at once", () => {
  const h = new Hle();
  const c = readFileSync(join(NXNATIVE, "dm", "host", "hle_account.c"), "latin1");
  const lits = [...c.slice(c.indexOf("k_profile_jpeg[] ="), c.indexOf("HLE_FORCE(\"_ZN2nn7account16LoadProfileImage")).matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => m[1]).join("");
  const jpeg = Buffer.from(lits.replace(/\\x([0-9a-f]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))), "latin1");
  assert.equal(jpeg.length, 670);
  const n = h.alloc(8), buf = h.alloc(700, 0xEE);
  const LOAD = "_ZN2nn7account16LoadProfileImageEPmPvmRKNS0_3UidE";
  assert.equal(h.call(LOAD, n, buf, 700, 0).x0, 0n); assert.equal(h.u64(n), 670n);
  assert.deepEqual(h.read(buf, 670), jpeg); assert.equal(h.u8[buf + 670], 0xEE);
  h.u8.fill(0xEE, buf, buf + 700); h.call(LOAD, n, buf, 100, 0);
  assert.equal(h.u64(n), 670n, "the size is the image's"); assert.deepEqual(h.read(buf, 100), jpeg.subarray(0, 100)); assert.equal(h.u8[buf + 100], 0xEE, "the copy is what the buffer holds");
  h.call(LOAD, 0, 0, 0, 0);
  for (const name of ["_ZN2nn7account36EnsureNetworkServiceAccountAvailableERKNS0_10UserHandleE", "_ZN2nn7account12AsyncContext9GetResultEv",
    "_ZN2nn7account40ShowLicenseRequirementsForNetworkServiceERKNS0_10UserHandleE"]) assert.equal(h.call(name, 0).x0, RES_FAIL, name);
  h.dv.setBigUint64(n, 9n, true); assert.equal(h.call("_ZN2nn7account37LoadNetworkServiceAccountIdTokenCacheEPmPcmRKNS0_10UserHandleE", n, 0, 0, 0).x0, RES_FAIL); assert.equal(h.u64(n), 0n);
  const b = h.alloc(2, 0xEE);
  h.call("_ZN2nn7account12AsyncContext7HasDoneEPb", 0, b); assert.deepEqual([...h.read(b, 2)], [1, 0xEE]);
  h.u8[b] = 0xEE; h.call("_ZN2nn7account32IsNetworkServiceAccountAvailableEPbRKNS0_10UserHandleE", b, 0); assert.deepEqual([...h.read(b, 2)], [0, 0xEE]);
  assert.equal(h.call("_ZN2nn7account12AsyncContextaSEOS1_", 0x1234, 0x5678).x0, 0x1234n, "move assignment returns this");
  // the completion event fires immediately: bound on the spot as manual-clear, then signalled
  const ev = h.alloc(64);
  assert.equal(h.call("_ZN2nn7account12AsyncContext14GetSystemEventEPNS_2os11SystemEventE", 0, ev).x0, 0n);
  assert.ok(h.ev(h.x.hle_event_handle(ev)).signaled);
  const ev2 = h.alloc(64);
  assert.equal(h.call("_ZN2nn7friends12AsyncContext14GetSystemEventEPNS_2os11SystemEventE", 0, ev2).x0, 0n); assert.ok(h.ev(h.x.hle_event_handle(ev2)).signaled);
  assert.equal(h.x.hle_event_count(), 2);
});

test("friends: cut; the two notification events are host-owned, bound once and never signalled", () => {
  const h = new Hle();
  const count = h.alloc(4, 0xEE);
  assert.equal(h.call("_ZN2nn7friends13GetFriendListEPiPNS0_6FriendEiiRKNS0_12FriendFilterE", count, 0, 0, 8, 0).x0, RES_FAIL); assert.equal(h.i32(count), 0);
  h.dv.setInt32(count, 5, true);
  assert.equal(h.call("_ZN2nn7friends18GetBlockedUserListEPiPNS_7account23NetworkServiceAccountIdEii", count, 0, 0, 8).x0, 0n, "SDK 4's overload: an empty list and success"); assert.equal(h.i32(count), 0);
  assert.equal(h.call("_ZN2nn7friends18GetBlockedUserListEPiPNS_7account23NetworkServiceAccountIdERKNS2_3UidEii", count, 0, 0, 0, 8).x0, RES_FAIL);
  assert.equal(h.w0("_ZN2nn7friends38TryPopFriendInvitationNotificationInfoEPNS_7account3UidEPmPvm", 0, 0, 0, 0), 0);
  const a = h.call("_ZN2nn7friends17NotificationQueue14GetSystemEventEv", 0).x0, b = h.call("_ZN2nn7friends36GetFriendInvitationNotificationEventEv").x0;
  assert.ok(a !== 0n && b !== 0n && a !== b);
  assert.equal(h.call("_ZN2nn7friends17NotificationQueue14GetSystemEventEv", 0).x0, a);
  assert.equal(h.x.hle_event_count(), 2, "bound once each");
  assert.ok(!h.ev(h.x.hle_event_handle(Number(a))).signaled && !h.ev(h.x.hle_event_handle(Number(b))).signaled);
  const d = h.alloc(2, 0xEE); h.call("_ZN2nn7friends27CheckFriendListAvailabilityEPbRKNS_7account3UidE", d, 0); assert.equal(h.u8[d], 0);
});

// nn::mii::CharInfo as hle_mii.c's mii_default writes it, field by field
function charInfo(gender: number, index: number): Buffer {
  const c = Buffer.alloc(0x58);
  c.writeBigUInt64LE(0x4d49494e44454641n + BigInt(index), 0); c.writeBigUInt64LE(0x554c54444d484f53n, 8);
  c[6] = (c[6] & 0x0f) | 0x40; c[8] = (c[8] & 0x3f) | 0x80;
  Buffer.from("no name", "utf16le").copy(c, 16);
  c[39] = index * 2;                      // favorite colour
  c[40] = gender; c[41] = 64; c[42] = 64; // gender, height, build
  c[49] = 33; c[50] = 1;                  // hair
  c.set([2, 8, 4, 3, 4, 2, 12], 52);      // eye: type colour scale aspect rotate x y
  c.set([6, 1, 4, 3, 6, 2, 10], 59);      // eyebrow
  c.set([1, 4, 9], 66);                   // nose
  c.set([23, 19, 4, 3, 13], 69);          // mouth
  c[74] = 8; c[77] = 4; c[78] = 10;       // beard colour, mustache scale, y
  c[80] = 8; c[81] = 4; c[82] = 10;       // glasses
  c[84] = 4; c[85] = 2; c[86] = 20;       // mole
  return c;
}
test("mii: the six default Miis, CharInfo 0x58 bytes and CharInfoElement 0x5C, byte for byte", () => {
  const h = new Hle();
  const out = h.alloc(4, 0xEE), buf = h.alloc(8 * 0x5c, 0xEE);
  assert.equal(h.call("_ZN2nn3mii8Database3GetEPiPNS0_8CharInfoEii", 0, out, buf, 8, 2).x0, 0n);
  assert.equal(h.i32(out), 6);
  for (let k = 0; k < 6; k++) assert.deepEqual(h.read(buf + 0x58 * k, 0x58), charInfo(k >= 3 ? 1 : 0, k), `default Mii ${k}`);
  assert.equal(h.u8[buf + 6 * 0x58], 0xEE, "nothing past the six");
  h.u8.fill(0xEE, buf, buf + 8 * 0x5c);
  h.call("_ZN2nn3mii8Database3GetEPiPNS0_15CharInfoElementEii", 0, out, buf, 2, 3);
  assert.equal(h.i32(out), 2);
  for (let k = 0; k < 2; k++) assert.deepEqual(h.read(buf + 0x5c * k, 0x5c), Buffer.concat([charInfo(0, k), Buffer.from([1, 0, 0, 0])]), "the CharInfo and its source (1 = default)");
  assert.equal(h.u8[buf + 2 * 0x5c], 0xEE);
  h.call("_ZN2nn3mii8Database3GetEPiPNS0_8CharInfoEii", 0, out, buf, 8, 1); assert.equal(h.i32(out), 0, "the console's own database is empty");
  assert.equal(h.w0("_ZNK2nn3mii8Database8GetCountEi", 0, 2), 6); assert.equal(h.w0("_ZNK2nn3mii8Database8GetCountEi", 0, 1), 0);
  const one = h.alloc(0x60, 0xEE);
  h.call("_ZNK2nn3mii8Database12BuildDefaultEPNS0_8CharInfoEi", 0, one, 4); assert.deepEqual(h.read(one, 0x60), Buffer.concat([charInfo(1, 4), Buffer.alloc(8, 0xEE)]));
  h.call("_ZNK2nn3mii8Database12BuildDefaultEPNS0_8CharInfoEi", 0, one, 9); assert.deepEqual(h.read(one, 0x58), charInfo(1, 0), "out of range: Mii 0 (the gender still follows the index, as nxnative's)");
  h.call("_ZNK2nn3mii8Database12BuildDefaultEPNS0_8CharInfoEi", 0, one, -1); assert.deepEqual(h.read(one, 0x58), charInfo(0, 0));
  // a random Mii: the default one of the asked gender with a fresh UUID version 4 as its create id
  const desc = h.alloc(12); h.dv.setInt32(desc + 4, 1, true);
  h.call("_ZN2nn3mii8Database11BuildRandomEPNS0_8CharInfoERKNS0_10RandomDescE", 0, one, desc);
  const r = h.read(one, 0x58), want = charInfo(1, 0); want[39] = 0;
  assert.deepEqual(r.subarray(16), want.subarray(16), "everything but the create id");
  assert.equal(r[6] >> 4, 4); assert.equal(r[8] >> 6, 2);
  h.call("_ZN2nn3mii8Database11BuildRandomEPNS0_8CharInfoERKNS0_10RandomDescE", 0, buf, 0);
  assert.notDeepEqual(h.read(buf, 16), r.subarray(0, 16), "a fresh id each time"); assert.equal(h.u8[buf + 40], 0, "no description: male");
  const idx = h.alloc(4);
  assert.equal(h.call("_ZNK2nn3mii8Database8GetIndexEPiRKNS0_8CharInfoE", 0, idx, one).x0, 0x87En); assert.equal(h.i32(idx), -1);
  assert.equal(h.call("_ZN2nn3mii8Database6ImportEPKvm", 0, 0, 100).x0, 0x1987En); assert.equal(h.call("_ZNK2nn3mii8Database6ExportEPvm", 0, 0, 0).x0, 0x1987En);
  assert.equal(h.red.length, 2);
  assert.equal(h.call("_ZN2nn3mii9AppendMiiEPi", idx).x0, 0xE7En, "the editor: cancelled"); assert.equal(h.call("_ZN2nn3mii11ShowMiiEditEv").x0, 0n);
  assert.equal(h.w0("_ZNK2nn3mii8Database11IsAvailableEv", 0), 1);
});

test("mii: the deterministic entropy stream is nxnative's splitmix64; the MiiModel stand-in files", () => {
  const h = new Hle(); h.host.config({ deterministicEntropy: true });
  // splitmix64 from the seed 0x5357444554524e47, as dm_entropy64 with DM_DETCLOCK
  let s = 0x5357444554524e47n; const M = (1n << 64n) - 1n;
  const next = () => { s = (s + 0x9E3779B97F4A7C15n) & M; let z = s; z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M; z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M; return z ^ (z >> 31n); };
  const a = next(), b = next();
  const p = h.alloc(24, 0xEE);
  assert.equal(h.w0("getentropy", p, 12), 0);
  const want = Buffer.alloc(16); want.writeBigUInt64LE(a, 0); want.writeBigUInt64LE(b, 8);
  assert.deepEqual(h.read(p, 12), want.subarray(0, 12)); assert.equal(h.u8[p + 12], 0xEE, "exactly the bytes asked");
  h.call("_ZN2nn6crypto36GenerateCryptographicallyRandomBytesEPvm", p, 8); assert.equal(h.u64(p), next(), "the csrng take-over continues the same stream");
  assert.equal(BigInt.asUintN(64, h.x.hle_entropy64()), next());
  const g = new Hle(), gp = g.alloc(8); g.call("getentropy", gp, 8); assert.deepEqual([...g.read(gp, 8)], [1, 2, 3, 4, 5, 6, 7, 8], "otherwise the embedder's random bytes");
  // stand-in files: sizes and the non-zero words as mii_write / mii_shapes write them
  assert.equal(h.x.hle_mii_standin(0, 0, 0), 0x2428); assert.equal(h.x.hle_mii_standin(1, 0, 0), 0x14de0 + 43);
  const t = h.alloc(0x2428 + 16, 0xEE); h.x.hle_mii_standin(0, t, 0x2428);
  const tex = h.read(t, 0x2428), wt = Buffer.alloc(0x2428); for (let i = 0; i < 22; i++) wt.writeUInt32LE(0x1000, 0xc + 4 * i);
  assert.deepEqual(tex, wt); assert.equal(h.u8[t + 0x2428], 0xEE);
  const sh = h.alloc(0x14de0 + 64, 0xEE); h.x.hle_mii_standin(1, sh, 0x14de0 + 43);
  const ws = Buffer.alloc(0x14de0 + 43); for (let i = 0; i < 24; i++) ws.writeUInt32LE(0x1000, 0xc + 4 * i);
  for (let i = 0; i < 857; i++) { const e = 0x6c + 0x58 * i; ws.writeUInt32LE(0x14de0, e); ws.writeUInt32LE(0x20, e + 4); ws.writeUInt32LE(43, e + 8); ws.writeUInt32LE(8, e + 36); ws.writeUInt32LE(0x10, e + 56); ws.writeUInt32LE(6, e + 60); }
  ws.set([0x78, 0x01, 0x01, 0x20, 0, 0xDF, 0xff], 0x14de0); ws.set([0x00, 0x20, 0x00, 0x01], 0x14de0 + 39);
  assert.deepEqual(h.read(sh, 0x14de0 + 43), ws); assert.equal(h.u8[sh + 0x14de0 + 43], 0xEE);
});

test("misc (t_pctl): parental controls deny communication whatever the bool's upper bits; GameChat camera storage", () => {
  const h = new Hle();
  const check = "_ZN2nn4pctl32CheckFreeCommunicationPermissionEb", begin = "_ZN2nn4pctl25TryBeginFreeCommunicationEb", avail = "_ZN2nn4pctl28IsFreeCommunicationAvailableEv",
    end = "_ZN2nn4pctl20EndFreeCommunicationEv", stereo = "_ZN2nn4pctl27CheckStereoVisionPermissionEb";
  const uid = h.alloc(16); assert.equal(h.w0("_ZN2nn4pctl33CheckAgcPermissionUnderMinimumAgeERKNS_7account3UidE", uid), 0);
  assert.equal(h.w0(avail), 0);
  for (const a of [0, 1, 0x100, 0x101, 0xFFFFFFFF]) {
    assert.equal(h.w0(check, a), 0); assert.equal(h.w0(begin, a), 0); assert.equal(h.w0(stereo, a), 0);
    h.call(end); assert.equal(h.w0(check, a), 0); assert.equal(h.w0(avail), 0);
  }
  const LI = "_ZN2nn4chat33InitializeLocalCameraVideoStorageEPNS0_20LocalCameraVideoTypeEiiiPvm", LIMG = "_ZN2nn4chat25GetLocalCameraImageHandleEPKNS0_20LocalCameraVideoTypeEi",
    LF = "_ZN2nn4chat31FinalizeLocalCameraVideoStorageEPNS0_20LocalCameraVideoTypeE", RI = "_ZN2nn4chat34InitializeRemoteCameraVideoStorageEPNS0_21RemoteCameraVideoTypeEiiiPvm",
    RIMG = "_ZN2nn4chat26GetRemoteCameraImageHandleEPKNS0_21RemoteCameraVideoTypeEi", RF = "_ZN2nn4chat32FinalizeRemoteCameraVideoStorageEPNS0_21RemoteCameraVideoTypeE";
  const local = h.alloc(0xe0 + 16, 0xCC), remote = h.alloc(0xe0, 0xCC);
  const n = h.call("_ZN2nn4chat35CalculateLocalCameraVideoBufferSizeEiii", 384, 216, 3).x0;
  assert.ok(n > 0n && n % 0x1000n === 0n, "the buffer size is page-aligned, as the SDK checks");
  assert.equal(h.call("_ZN2nn4chat36CalculateRemoteCameraVideoBufferSizeEiii", 1, 1, 1).x0, 0x1000n);
  h.call(LI, local, 384, 216, 3, 0, n);
  const liveN = () => h.images.length - h.freed.length;
  assert.equal(liveN(), 3); assert.deepEqual(h.images, [384 << 16 | 216, 384 << 16 | 216, 384 << 16 | 216], "three blank images of the size");
  const img = (name: string, p: number, i: number) => h.w0(name, p, i);
  assert.ok(img(LIMG, local, 0) && img(LIMG, local, 2) && img(LIMG, local, 0) !== img(LIMG, local, 2) && !img(LIMG, local, 3) && !img(LIMG, local, -1));
  assert.equal(h.u8[local + 0xe0], 0xCC, "nothing written past the 0xe0-byte type");
  const want = Buffer.alloc(0xe0); want.writeUInt32LE(0x6d436d44, 0); want.writeUInt32LE(3, 4); want.writeUInt32LE(0x100, 8); want.writeUInt32LE(0x101, 12); want.writeUInt32LE(0x102, 16);
  assert.deepEqual(h.read(local, 0xe0), want, "{ magic, count, image[4] } in a zeroed type");
  h.call(RI, remote, 32, 32, 4, 0, 0x1000);
  assert.equal(liveN(), 7); assert.ok(img(RIMG, remote, 3) && img(RIMG, remote, 3) !== img(LIMG, local, 0));
  h.call(LF, local); h.call(RF, remote);
  assert.equal(liveN(), 0); assert.ok(!img(LIMG, local, 0) && !img(RIMG, remote, 0)); assert.ok(h.read(local, 0xe0).every(b => b === 0));
  h.call(LI, local, 4000, 216, 3, 0, n);
  assert.equal(liveN(), 0); assert.ok(!img(LIMG, local, 0)); assert.equal(h.red.length, 1, "a size out of the SDK's range makes no image");
  const r = h.call("_ZN2nn4chat14GetChattingUidEv"); assert.deepEqual([r.x0, r.x1], [0n, 0n], "a zero Uid in two registers");
  assert.equal(h.call("_ZN2nn4chat11GetRoomInfoEPNS0_8RoomInfoE", 0).x0, RES_FAIL);
  const ev = h.alloc(64); assert.equal(h.call("_ZN2nn4chat28AttachToRoomInfoChangedEventEPNS_2os11SystemEventE", ev).x0, 0n); assert.ok(!h.ev(h.x.hle_event_handle(ev)).signaled, "bound, never signalled");
});

test("misc: add-on content, the shop, streamplay, the error applet", () => {
  const h = new Hle();
  assert.equal(h.w0("_ZN2nn3aoc17CountAddOnContentEv"), 0, "no list given: none");
  h.host.aocSet([7, 2, 1999, 2, 0, 2001, 30]);
  assert.equal(h.w0("_ZN2nn3aoc17CountAddOnContentEv"), 4, "ascending, duplicates and out-of-range indices dropped");
  const out = h.alloc(24, 0xEE), list = (off: number, n: number) => { h.u8.fill(0xEE, out, out + 24); const w = h.w0("_ZN2nn3aoc16ListAddOnContentEPiii", out, off, n); return [w, ...[0, 4, 8, 12, 16].map(o => h.i32(out + o))]; };
  const E = -286331154;
  assert.deepEqual(list(0, 5), [4, 2, 7, 30, 1999, E]); assert.deepEqual(list(1, 2), [2, 7, 30, E, E, E]); assert.deepEqual(list(-3, 1), [1, 2, E, E, E, E]); assert.deepEqual(list(9, 4), [0, E, E, E, E, E]);
  const ev = h.alloc(64); h.call("_ZN2nn3aoc31GetAddOnContentListChangedEventEPNS_2os11SystemEventE", ev); assert.ok(h.x.hle_event_handle(ev) !== 0);
  const pe = h.call("_ZN2nn2ec17GetPurchasedEventEv").x0; assert.ok(pe !== 0n); assert.equal(h.call("_ZN2nn2ec17GetPurchasedEventEv").x0, pe);
  assert.equal(h.w0("_ZN2nn2ec20PopPurchasedItemInfoEPNS0_17PurchasedItemInfoE", 0), 0);
  assert.equal(h.call("_ZN2nn2ec19ShopServiceAccessor10InitializeERKNS0_11ShopServiceE", 0, 0).x0, RES_FAIL); assert.equal(h.w0("_ZN2nn2ec19ShopServiceAccessor13AsyncResponse7TryWaitEv", 0), 1);
  const sz = h.alloc(8, 0xEE); assert.equal(h.call("_ZN2nn2ec19ShopServiceAccessor13AsyncResponse7GetSizeEPm", 0, sz).x0, RES_FAIL); assert.equal(h.u64(sz), 0n);
  // a shop page is an applet: the game is out of focus for the call
  const msg = h.alloc(4);
  h.call("_ZN2nn2ec24ShowShopAddOnContentListEv");
  assert.equal(h.w0("_ZN2nn2oe25TryPopNotificationMessageEPj", msg), 1); assert.equal(h.u32(msg), 15); assert.equal(h.x.hle_focus_seen(), 1);
  assert.equal(h.w0("_ZN2nn10streamplay21GetRequiredMemorySizeENS0_14StreamPlayTypeENS0_13StreamingModeEi", 0, 0, 0), 0x1000);
  h.call("_ZN2nn10streamplay29SetSupportedGuestNpadStyleSetENS_4util10BitFlagSetILi32ENS_3hid12NpadStyleTagEEE", 0x1F); assert.equal(h.w0("_ZN2nn10streamplay29GetSupportedGuestNpadStyleSetEv"), 0x1F);
  h.call("_ZN2nn10streamplay23SetGuestNpadJoyHoldTypeENS_3hid15NpadJoyHoldTypeE", 1); assert.equal(h.w0("_ZN2nn10streamplay23GetGuestNpadJoyHoldTypeEv"), 1);
  const cs = h.alloc(8, 0xEE); h.call("_ZN2nn10streamplay18GetConnectionStateEPNS0_15ConnectionStateE", cs); assert.deepEqual([h.u32(cs), h.u32(cs + 4)], [0, 0xEEEEEEEE]);
  const vi = h.alloc(16, 0xEE); h.call("_ZN2nn10streamplay27GetGuestVibrationDeviceInfoEPNS_3hid19VibrationDeviceInfoERKNS0_26GuestVibrationDeviceHandleE", vi, 0); assert.deepEqual([h.u64(vi), h.u64(vi + 8)], [0n, 0xEEEEEEEEEEEEEEEEn]);
  const se = h.call("_ZN2nn10streamplay30GetConnectionStateChangedEventEv").x0; assert.ok(h.x.hle_event_handle(Number(se)) !== 0);
});

test("misc: the profanity filter gets a host vtable matched to the SDK's by address", () => {
  const h = new Hle();
  const self = h.alloc(16, 0xEE);
  h.call("_ZN2nn3ngc15ProfanityFilterC1Ev", self);
  assert.equal(h.red.length, 1, "no vtable symbol in the guest: red, the object keeps none"); assert.equal(h.u64(self), 0xEEEEEEEEEEEEEEEEn);
  const g = new Hle(), C = "_ZN2nn3ngc15ProfanityFilter";
  g.modules = [{ lo: 0x0900_0000n, hi: 0x0A00_0000n }, { lo: 0x0B00_0000n, hi: 0x0C00_0000n }];   // the sdk and another module
  const sdk = g.alloc(16 * 8);
  g.modules[0] = { lo: BigInt(sdk), hi: BigInt(sdk) + 0x2000n };   // the vtable and the class's methods are in "the sdk"
  const A = (k: number) => BigInt(sdk) + 0x1000n + 0x10n * BigInt(k);
  g.modules.unshift({ lo: 0x0B00_0000n, hi: 0x0C00_0000n });
  g.syms.set("_ZTVN2nn3ngc15ProfanityFilterE", BigInt(sdk));
  g.syms.set(C + "D1Ev", A(0)); g.syms.set(C + "D0Ev", A(1)); g.syms.set(C + "19CheckProfanityWordsEPjjPPKcm", A(2)); g.syms.set(C + "24MaskProfanityWordsInTextEPiPDsj", A(3));
  const stub = (k: number) => 0x07FC_0000n + 4n * BigInt(g.x.hle_count() + k);
  const HOSTSTUB = 0x07FC_0100n;   // a slot the loader bound to a forced take-over: neither module, kept
  [0n, 0x7777n, A(0), A(1), HOSTSTUB, A(2), A(9), A(3), 1n, A(0)].forEach((v, i) => g.dv.setBigUint64(sdk + 8 * i, v, true));
  const obj = g.alloc(16, 0xEE);
  g.call(C + "C1Ev", obj);
  const vt = Number(g.u64(obj));
  assert.ok(vt !== 0 && g.u64(obj + 8) === 0xEEEEEEEEEEEEEEEEn, "the vtable pointer, 8 bytes");
  assert.deepEqual([g.u64(vt - 16), g.u64(vt - 8)], [0n, 0x7777n], "offset to top and type info copied");
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => g.u64(vt + 8 * i)), [stub(1), stub(1), HOSTSTUB, stub(2), stub(0), stub(3)], "destructors: nothing; the bound slot stays; check; an unnamed method: zero; mask");
  assert.ok(g.logs.some(l => l === "ngc: ProfanityFilter host vtable of 6 slots (4 matched to the class's methods)"), "the table ends at the first value that is not code");
  // the host's versions through their stubs
  const ids = g.host.entries().filter(e => e.internal).map(e => e.id);
  const masks = g.alloc(16, 0xEE), masked = g.alloc(8, 0xEE);
  assert.equal(g.callRegs(ids[2], { x: [obj, masks, 0, 0, 3] }).x0, 0n); assert.deepEqual([0, 4, 8, 12].map(o => g.u32(masks + o)), [0, 0, 0, 0xEEEEEEEE]);
  assert.equal(g.callRegs(ids[3], { x: [obj, masked, 0, 0] }).x0, 0n); assert.deepEqual([g.i32(masked), g.u32(masked + 4)], [0, 0xEEEEEEEE]);
  assert.equal(g.callRegs(ids[0], {}).x0, 0n);
  // by name
  g.u8.fill(0xEE, masks, masks + 16);
  assert.equal(g.call(C + "19CheckProfanityWordsEPjjPPKcm", obj, masks, 0, 0, 2).x0, 0n); assert.deepEqual([0, 4, 8].map(o => g.u32(masks + o)), [0, 0, 0xEEEEEEEE]);
  for (const n of ["24MaskProfanityWordsInTextEPiPcj", "24MaskProfanityWordsInTextEPiPtj", "24MaskProfanityWordsInTextEPiPDsj"]) { g.dv.setInt32(masked, 9, true); assert.equal(g.call(C + n, obj, masked, 0, 0).x0, 0n); assert.equal(g.i32(masked), 0); }
  assert.equal(g.red.length, 0);
});

test("sdkinit, nvdrv, getenv, the allocator hook", () => {
  const h = new Hle();
  for (const n of ["nndiagStartup", "_ZN2nn2oe10InitializeEv", "_ZN2nn3aoc10InitializeEv", "_ZN2nn3err26InitializeContextWriterApiEv", "_ZN2nn2fs24InitializeForApplicationEv", "_ZN2nn4pctl10InitializeEv",
    "_ZN2nn4diag34InitializeApplicationAbortObserverEv"]) assert.equal(h.call(n).x0, 0n);
  assert.equal(h.logs.filter(l => l.startsWith("init takeover: ") && l.endsWith(" (no-op)")).length, 7);
  const path = h.str("/dev/nvhost-ctrl");
  assert.equal(h.w0("NvOsDrvOpen", path), 0xFFFFFFFF); assert.equal(h.w0("NvOsDrvOpen", 0), 0xFFFFFFFF);
  assert.deepEqual(h.red, ["[RED] nvdrv: cannot open /dev/nvhost-ctrl (the host has no nvdrv; only hardware movie decoding uses it)"]);
  for (const n of ["NvOsDrvIoctl", "NvOsDrvIoctl2", "NvOsDrvIoctl3", "NvOsDrvMapSharedMem", "_Z17NvOsDrvQueryEventijPN2nn2os15SystemEventTypeE"]) assert.equal(h.w0(n, 0, 0, 0, 0), 3, n);
  // getenv: the profile's game_env answers its names, the SDK's own getenv the rest
  const g = new Hle(); g.host.config({ gameEnv: "DOTNET_GCRegionRange=0x40000000 bogus  A=b" });
  const ge = (name: string | null) => g.call("getenv", name === null ? 0 : g.str(name)).x0;
  assert.equal(g.cstr(Number(ge("DOTNET_GCRegionRange"))), "0x40000000"); assert.equal(g.cstr(Number(ge("A"))), "b");
  assert.equal(ge("DOTNET"), 0n, "a prefix is not the name"); assert.equal(ge("bogus"), 0n); assert.equal(ge(null), 0n); assert.equal(ge(""), 0n);
  const asked: bigint[] = []; g.fn(p => { asked.push(p); return 0x4242; }, "getenv");
  const g2 = new Hle(); g2.fn(p => { asked.push(p); return 0x4242; }, "getenv"); g2.host.config({ gameEnv: "A=b" });
  const nm = g2.str("HOME"); assert.equal(g2.call("getenv", nm).x0, 0x4242n, "another name goes to the SDK's own getenv"); assert.deepEqual(asked, [BigInt(nm)]);
  assert.equal(g2.cstr(Number(g2.call("getenv", g2.str("A")).x0)), "b");
  // StandardAllocator::Allocate(size): to the SDK; with alloc_big_align, 64 KB or more through Allocate(size, 0x10000)
  const SA = "_ZN2nn3mem17StandardAllocator8AllocateEm";
  assert.equal(h.call(SA, 1, 64).x0, 0n); assert.equal(h.red.length, 2, "no SDK allocator in the guest: red (nxnative stops)");
  for (const big of [false, true]) {
    const a = new Hle(); const calls: string[] = [];
    a.fn((self, size) => { calls.push(`plain ${self} ${size}`); return 0x1000; }, SA); a.fn((self, size, al) => { calls.push(`aligned ${self} ${size} ${al}`); return 0x20000; }, "_ZN2nn3mem17StandardAllocator8AllocateEmm");
    a.host.config({ allocBigAlign: big });
    assert.equal(a.call(SA, 5, 0xFFFF).x0, 0x1000n); assert.equal(a.call(SA, 5, 0x10000).x0, big ? 0x20000n : 0x1000n);
    assert.deepEqual(calls, ["plain 5 65535", big ? "aligned 5 65536 65536" : "plain 5 65536"]);
  }
});
