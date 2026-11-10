// Miscellaneous service layer: port of nxnative dm/host/hle_misc.c (add-on content, shop, error applet, profanity
// filter, parental controls, streamplay, GameChat). Most bodies are constants and are compiled from the C text; the
// ones with state or memory layouts are here.
import { X, W, I, P, setX1, guestSym, moduleOf, stubAddr, envGuestSym, ls, ps, pi, le, red, zero, sput } from "./base";
import { seBind } from "./sysevent";
import { COUNT } from "./gen/table";

// ---------- aoc: the owned add-on content indices (ascending). nxnative lists the numeric subdirectories of
// DM_AOC_DIR at the first query; here the embedder sets the list (export hle_aoc_set) ----------
const AOC_MAX: i32 = 2000;
const AOC: usize = memory.data(8000);
let naoc: i32 = 0, aocLogged: bool = false;
export function aocSet(p: usize, n: i32): void {
  naoc = 0;
  for (let i = 0; i < n && naoc < AOC_MAX; i++) {
    const v = load<i32>(p + (<usize>i << 2));
    if (v < 1 || v > 2000) continue;
    let k = naoc;   // insertion sort, duplicates dropped (a legacy directory and its image report the same DLC once)
    while (k > 0 && load<i32>(AOC + (<usize>(k - 1) << 2)) > v) k--;
    if (k > 0 && load<i32>(AOC + (<usize>(k - 1) << 2)) == v) continue;
    memory.copy(AOC + (<usize>(k + 1) << 2), AOC + (<usize>k << 2), <usize>(naoc - k) << 2);
    store<i32>(AOC + (<usize>k << 2), v); naoc++;
  }
  aocLogged = false;
}
function aocLoad(): void { if (!aocLogged) { aocLogged = true; ls(); ps("aoc: reporting "); pi(naoc); ps(" add-on contents"); le(); } }
export function h_aoc_Count(a: usize): u64 { aocLoad(); return <u64>naoc; }
// ListAddOnContent(out, start index, max count): the number written
export function h_aoc_List(a: usize): u64 {
  const out = P(a, 0), off = I(a, 1), n = I(a, 2);
  let w = 0; aocLoad();
  for (let i = off < 0 ? 0 : off; i < naoc && w < n; i++) { store<i32>(out + (<usize>w << 2), load<i32>(AOC + (<usize>i << 2))); w++; }
  return <u64>w;
}

// ---------- ec: the purchased-item event, a host-owned SystemEvent that is never signalled ----------
const EV_PURCHASE: usize = memory.data(128, 16);
export function h_ec_GetPurchased(a: usize): u64 { seBind(EV_PURCHASE, 0); return <u64>EV_PURCHASE; }

// ---------- ngc profanity filter: no word list, nothing is profanity, nothing is masked ----------
// The class is polymorphic and games call it through its vtable, so the constructor gives the object a host vtable:
// each slot of the SDK's (_ZTVN2nn3ngc15ProfanityFilterE) is matched by address with the class's methods and given
// the host's version; others return 0. The host's versions are internal take-overs (ids from COUNT up), reached
// through stubs the embedder makes (import hle_stub_addr).
export const INT_NGC_ZERO = 0, INT_NGC_NONE = 1, INT_NGC_CHECK = 2, INT_NGC_MASK = 3, INTERNAL_COUNT = 4;
function ngcCheck(masks: usize, n: u64): u64 { for (let i: u64 = 0; masks && i < n; i++) store<u32>(masks + (<usize>i << 2), 0); return 0; }
function ngcMask(masked: usize): u64 { if (masked) store<i32>(masked, 0); return 0; }
export function internalCall(k: i32, a: usize): u64 {
  switch (k) {
    case INT_NGC_CHECK: return ngcCheck(P(a, 1), X(a, 4));
    case INT_NGC_MASK: return ngcMask(P(a, 1));
    default: return 0;   // ngc_v_zero, ngc_v_none
  }
}
const NV: i32 = 40;
const VT: usize = memory.data(336, 8);   // (NV + 2) pointers
let vtBuilt: i32 = 0;
function sym2(p1: string, p2: string): u64 { const b = memory.data(256); let n = sput(b, p1); n += sput(b + n, p2); store<u8>(b + n, 0); return envGuestSym(b); }
function ngcVtable(): usize {
  if (vtBuilt) return vtBuilt > 0 ? VT + 16 : 0;
  const sdk = <usize>guestSym("_ZTVN2nn3ngc15ProfanityFilterE");
  if (!sdk) { vtBuilt = -1; red("ProfanityFilter: the SDK has no vtable symbol; objects keep none"); return 0; }
  const C = "_ZN2nn3ngc15ProfanityFilter";
  const ADDR = memory.data(72), KIND = memory.data<u8>([1, 1, 1, 2, 2, 2, 3, 3, 3]);
  store<u64>(ADDR, sym2(C, "D1Ev"), 0); store<u64>(ADDR, sym2(C, "D0Ev"), 8); store<u64>(ADDR, sym2(C, "8FinalizeEv"), 16);
  store<u64>(ADDR, sym2(C, "19CheckProfanityWordsEPjjPPKcm"), 24); store<u64>(ADDR, sym2(C, "19CheckProfanityWordsEPjjPPKDsm"), 32); store<u64>(ADDR, sym2(C, "19CheckProfanityWordsEPjjPPKtm"), 40);
  store<u64>(ADDR, sym2(C, "24MaskProfanityWordsInTextEPiPcj"), 48); store<u64>(ADDR, sym2(C, "24MaskProfanityWordsInTextEPiPDsj"), 56); store<u64>(ADDR, sym2(C, "24MaskProfanityWordsInTextEPiPtj"), 64);
  const mod = moduleOf(<u64>sdk);
  store<u64>(VT, load<u64>(sdk)); store<u64>(VT, load<u64>(sdk, 8), 8);   // offset to top, type info
  let n = 0, named = 0;
  // A slot holds SDK code, or a host stub where the loader bound the slot by name to a forced take-over: those stay.
  // The table ends at the first value that is neither
  for (; n < NV && load<u64>(sdk + 16 + (<usize>n << 3)) >= 0x10000; n++) {
    const v = load<u64>(sdk + 16 + (<usize>n << 3)), at = VT + 16 + (<usize>n << 3), m = moduleOf(v);
    if (m != mod) { if (m >= 0) break; store<u64>(at, v); continue; }
    let kind = INT_NGC_ZERO;
    for (let k = 0; k < 9; k++) if (load<u64>(ADDR + (<usize>k << 3)) && v == load<u64>(ADDR + (<usize>k << 3))) { kind = load<u8>(KIND + <usize>k); named++; break; }
    store<u64>(at, stubAddr(COUNT + kind));
  }
  vtBuilt = 1;
  ls(); ps("ngc: ProfanityFilter host vtable of "); pi(n); ps(" slots ("); pi(named); ps(" matched to the class's methods)"); le();
  return VT + 16;
}
export function h_ngc_Ctor(a: usize): u64 { const vt = ngcVtable(), self = P(a, 0); if (vt && self) store<u64>(self, <u64>vt); return 0; }
export function h_ngc_Check(a: usize): u64 { const masks = P(a, 1), n = X(a, 4); for (let i: u64 = 0; i < n; i++) store<u32>(masks + (<usize>i << 2), 0); return 0; }
export function h_ngc_Mask8(a: usize): u64 { return ngcMask(P(a, 1)); }
export function h_ngc_Mask16(a: usize): u64 { return ngcMask(P(a, 1)); }
export function h_ngc_Mask16c(a: usize): u64 { return ngcMask(P(a, 1)); }

// ---------- streamplay (Switch 2): ready, no session, no guest ----------
const EV_STPL: usize = memory.data(128, 16);
let stplStyles: u32 = 0, stplHold: u32 = 0;
export function h_stpl_ConnEv(a: usize): u64 { seBind(EV_STPL, 0); return <u64>EV_STPL; }
export function h_stpl_SetStyles(a: usize): u64 { stplStyles = W(a, 0); return 0; }
export function h_stpl_GetStyles(a: usize): u64 { return stplStyles; }
export function h_stpl_SetHold(a: usize): u64 { stplHold = W(a, 0); return 0; }
export function h_stpl_GetHold(a: usize): u64 { return stplHold; }

// ---------- chat (GameChat, Switch 2): camera video storage ----------
// The storage type is 0xe0 bytes, zeroed, then { u32 magic "DmCm", u32 count, u32 image[4] }: blank native images of
// the size, made by the graphics side (imports)
// @ts-ignore: decorator
@external("env", "hle_native_image_blank")
declare function nativeImageBlank(w: u32, h: u32): u32;
// @ts-ignore: decorator
@external("env", "hle_native_image_blank_free")
declare function nativeImageBlankFree(handle: u32): void;
const CHAT_VIDEO_MAGIC: u32 = 0x6d436d44;
function chatVideoInit(type: usize, w: i32, h: i32, n: i32): u64 {
  zero(type, 0xe0);
  if (w < 32 || w > 1920 || h < 32 || h > 1080 || n < 1 || n > 4) { ls(); ps("[RED] chat: camera video storage "); pi(w); ps("x"); pi(h); ps(" x"); pi(n); ps(" is out of the SDK's range"); le(); return 0; }
  store<u32>(type, CHAT_VIDEO_MAGIC); store<u32>(type, <u32>n, 4);
  for (let i = 0; i < n; i++) store<u32>(type + 8 + (<usize>i << 2), nativeImageBlank(<u32>w, <u32>h));
  return 0;
}
function chatVideoFini(type: usize): u64 {
  if (load<u32>(type) == CHAT_VIDEO_MAGIC) for (let i: u32 = 0, n = load<u32>(type, 4); i < n && i < 4; i++) nativeImageBlankFree(load<u32>(type + 8 + (<usize>i << 2)));
  zero(type, 0xe0);
  return 0;
}
function chatVideoImage(type: usize, i: i32): u64 { return load<u32>(type) == CHAT_VIDEO_MAGIC && i >= 0 && <u32>i < load<u32>(type, 4) && i < 4 ? load<u32>(type + 8 + (<usize>i << 2)) : 0; }
export function h_chat_LocalInit(a: usize): u64 { return chatVideoInit(P(a, 0), I(a, 1), I(a, 2), I(a, 3)); }
export function h_chat_RemoteInit(a: usize): u64 { return chatVideoInit(P(a, 0), I(a, 1), I(a, 2), I(a, 3)); }
export function h_chat_LocalFini(a: usize): u64 { return chatVideoFini(P(a, 0)); }
export function h_chat_RemoteFini(a: usize): u64 { return chatVideoFini(P(a, 0)); }
export function h_chat_LocalImage(a: usize): u64 { return chatVideoImage(P(a, 0), I(a, 1)); }
export function h_chat_RemoteImage(a: usize): u64 { return chatVideoImage(P(a, 0), I(a, 1)); }
// nn::account::Uid returned in two registers: nobody is chatting
export function h_chat_ChattingUid(a: usize): u64 { setX1(0); return 0; }

export function miscInit(): void { naoc = 0; aocLogged = false; vtBuilt = 0; stplStyles = 0; stplHold = 0; }
