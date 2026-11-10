// nn::account: port of nxnative dm/host/hle_account.c. A console manages users through acc:u0; the host has one
// fixed local user. Online accounts are cut (RES_FAIL); those bodies are compiled from the C text (gen/table.ts).
// Uid = 2 x u64 (16 bytes); UserHandle = 3 x u64 (24 bytes): the Uid and a magic; Nickname = char[33].
import { X, I, P, strPtr, strLen, STR_NICK, ls, ps, px, le, zero, copy } from "./base";
import { appletEnterS, appletLeave } from "./oe";
import { PROFILE_JPEG, PROFILE_JPEG_LEN } from "./data";

export const UID0: u64 = 0x78626c0000000001, UID1: u64 = 0x53574e4154495645;   // non-zero means valid
export const HANDLE_MAGIC: u64 = 0x55534552484e444c;                            // "USERHNDL"
function putUid(p: usize): void { store<u64>(p, UID0); store<u64>(p, UID1, 8); }
function putHandle(h: usize, u0: u64, u1: u64): void { store<u64>(h, u0); store<u64>(h, u1, 8); store<u64>(h, HANDLE_MAGIC, 16); }
function listOne(a: usize): u64 {
  const n = P(a, 0), out = P(a, 1), max = I(a, 2);
  store<i32>(n, 0);
  if (max > 0) { putUid(out); store<i32>(n, 1); }
  return 0;
}
export function h_acc_ListOpen(a: usize): u64 { return listOne(a); }
export function h_acc_ListAll(a: usize): u64 { return listOne(a); }
export function h_acc_ListQual(a: usize): u64 {
  const n = P(a, 0), out = P(a, 1), max = I(a, 2);
  let k = 0; if (max > 0 && out) { putUid(out); k = 1; }
  store<i32>(n, k);
  return 0;
}
export function h_acc_ShowSel(a: usize): u64 { appletEnterS("user selector"); putUid(P(a, 0)); appletLeave(); return 0; }
export function h_acc_TryOpenPre(a: usize): u64 { putHandle(P(a, 0), UID0, UID1); return 1; }
export function h_acc_OpenPre(a: usize): u64 { putHandle(P(a, 0), UID0, UID1); return 0; }
export function h_acc_LastOpened(a: usize): u64 { putUid(P(a, 0)); return 0; }
export function h_acc_OpenUser(a: usize): u64 { const uid = P(a, 1); putHandle(P(a, 0), load<u64>(uid), load<u64>(uid, 8)); return 0; }
export function h_acc_GetUserId(a: usize): u64 {
  const out = P(a, 0), h = P(a, 1);
  if (load<u64>(h, 16) != HANDLE_MAGIC) {   // nxnative stops the process here
    ls(); ps("[RED] account::GetUserId: the handle was not issued by the host ("); px(load<u64>(h, 16)); ps("): fails"); le();
    return 0x2A2;
  }
  store<u64>(out, load<u64>(h)); store<u64>(out, load<u64>(h, 8), 8);
  return 0;
}
export function h_acc_GetNick(a: usize): u64 {
  const nick = P(a, 0);
  zero(nick, 33);
  if (strLen(STR_NICK) >= 0) { const s = strPtr(STR_NICK); for (let i: usize = 0; i < 32; i++) { const c = load<u8>(s + i); if (!c) break; store<u8>(nick + i, c); } }
  else { store<u8>(nick, 0x50); store<u8>(nick, 0x6C, 1); store<u8>(nick, 0x61, 2); store<u8>(nick, 0x79, 3); store<u8>(nick, 0x65, 4); store<u8>(nick, 0x72, 5); }   // Player
  return 0;
}
export function h_acc_Exists(a: usize): u64 {
  const uid = P(a, 1);
  store<u8>(P(a, 0), load<u64>(uid) == UID0 && load<u64>(uid, 8) == UID1 ? 1 : 0);
  return 0;
}
// The size is the image's, the copy what the buffer holds
export function h_acc_LoadImage(a: usize): u64 {
  const n = P(a, 0), buf = P(a, 1), sz = X(a, 2);
  if (buf) copy(buf, PROFILE_JPEG, sz < <u64>PROFILE_JPEG_LEN ? <usize>sz : PROFILE_JPEG_LEN);
  if (n) store<u64>(n, <u64>PROFILE_JPEG_LEN);
  return 0;
}
export function h_acc_ShowCreator(a: usize): u64 { appletEnterS("user creator"); appletLeave(); return 0; }
export function h_acc_AcMove(a: usize): u64 { return X(a, 0); }
