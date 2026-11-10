// nn::ro (modules loaded at run time, NRO): port of nxnative dm/host/hle_ro.c. On Horizon the ldr:ro service maps the
// image and the SDK relocates it through rtld's module lists, calls the module's init and binds the earlier modules'
// variables. The host plays rtld, so the whole calls are taken over: this module keeps nn::ro's bookkeeping (which
// Module object holds which loaded module, the refused hashes, the results) and the embedder's loader and translator
// do the mapping, through five imports:
//   hle_ro_load(image, size, sha, alone) -> token   map the NRO image (size bytes at the guest address image; sha: its
//                                                   SHA-256, 32 bytes) and relocate it, against the modules loaded now
//                                                   (alone = 0) or against itself only (alone = 1: a JIT plugin, which
//                                                   on Horizon is not linked with the game). No code of it runs yet.
//                                                   0: it could not (the embedder logs why)
//   hle_ro_call(token, fini, index) -> address      the index-th function to call for the module's init (fini = 0: its
//                                                   DT_INIT, or its init_array when it has none) or fini (fini = 1);
//                                                   0 ends the list. The take-over calls them on the guest thread
//   hle_ro_activate(token)                          the init functions have run: the module joins the symbol lookups
//                                                   and the imports of earlier modules it defines are bound to it
//   hle_ro_unload(token)                            out of the lookups, its translations dropped, its memory unmapped
//   hle_ro_lookup_in(token, name) -> address        a definition by name in that one module, 0 = none
// LookupSymbol is the lookup the other take-overs use (hle_guest_sym).
//
// nn::ro::Module as the SDK fills it: +0 the module object (here: the embedder's token), +8 u32 state (1 = loaded),
// +0x10 image, +0x18 buffer. Only success matters for the failures: games check IsSuccess only.
// Departures from nxnative: there the NROs were rewritten offline and mapped at start, and LoadModule finds one by
// the image's hash; here the image the game passes is what the loader maps (as src/glue/rt_ro.ts does). An image
// loaded again while it is loaded fails as there (one module per hash). Online SDKs are never loaded: by hash
// (hle_ro_refuse, nxnative's "refused" rows of nro.tsv) and by the export EOS_Platform_Create. Not ported:
// DM_NRO_CAPTURE.
import { Inst } from "../kit/machine";
import { RO_MODULE, RoModuleS, RoModuleE } from "../kit/gen/tables";
import { X, I, P, envGuestSym, guestCall0, guestSym, ls, ps, pc, pu, px, pz, le, red, zero, copy, sput } from "./base";
import { sha256 } from "./sha256";

// @ts-ignore: decorator
@external("env", "hle_ro_load")
declare function envLoad(image: u64, size: u32, sha: usize, alone: i32): u64;
// @ts-ignore: decorator
@external("env", "hle_ro_call")
declare function envCall(token: u64, fini: i32, index: i32): u64;
// @ts-ignore: decorator
@external("env", "hle_ro_activate")
declare function envActivate(token: u64): void;
// @ts-ignore: decorator
@external("env", "hle_ro_unload")
declare function envUnload(token: u64): void;
// @ts-ignore: decorator
@external("env", "hle_ro_lookup_in")
declare function envLookupIn(token: u64, name: usize): u64;

export const RO_FAIL: u64 = 22 | (1 << 9);   // a failure under ro module 22
export const RO_NOT_NRO: u64 = 0x816;        // the SDK's result for an image without NRO0
const NRO0: u32 = 0x304F524E, NRR0: u32 = 0x3052524E;
const SLOTS: i32 = 64, REC: usize = 56;      // +0 Inst (16), +16 u64 token, +24 SHA-256 (32)
const TAB: usize = memory.data(3584, 8);
const REFUSED: usize = memory.data(512);     // up to 16 hashes
const SHA: usize = memory.data(32), NAME: usize = memory.data(64);
let nRefused: i32 = 0, lookups: i32 = 0, lookupRed: bool = false, modSymLogs: i32 = 0, modSymRed: bool = false, nrrLogs: i32 = 0;

// @ts-ignore: decorator
@inline function rec(i: i32): usize { return TAB + <usize>i * REC; }
// @ts-ignore: decorator
@inline function inst(i: i32): Inst { return Inst.at(rec(i)); }
export function roInit(): void {
  zero(TAB, 3584);
  for (let i = 0; i < SLOTS; i++) inst(i).init(RO_MODULE, <u32>i);
  nRefused = 0; lookups = 0; lookupRed = false; modSymLogs = 0; modSymRed = false; nrrLogs = 0;
}
// An NRO the embedder's pack refuses by its SHA-256 (an online SDK)
export function roRefuse(sha: usize): void {
  if (nRefused >= 16) { red("ro: more than 16 refused hashes: the rest is not refused by hash"); return; }
  copy(REFUSED + (<usize>nRefused << 5), sha, 32); nRefused++;
}
function refused(sha: usize): bool {
  for (let i = 0; i < nRefused; i++) if (memory.compare(REFUSED + (<usize>i << 5), sha, 32) == 0) return true;
  return false;
}
function hex8(sha: usize): void { for (let k = 0; k < 8; k++) { const b = <u32>load<u8>(sha + <usize>k); pc((b >> 4) < 10 ? 48 + (b >> 4) : 87 + (b >> 4)); pc((b & 15) < 10 ? 48 + (b & 15) : 87 + (b & 15)); } }
function slotBySha(sha: usize): i32 {
  for (let i = 0; i < SLOTS; i++) if (inst(i).state != RoModuleS.Empty && memory.compare(rec(i) + 24, sha, 32) == 0) return i;
  return -1;
}
// The loaded module an nn::ro::Module holds: its slot, -1 when it holds none
function moduleFrom(rm: usize): i32 {
  if (!rm || load<u32>(rm, 8) != 1) return -1;
  const token = load<u64>(rm);
  for (let i = 0; i < SLOTS; i++) if (inst(i).state == RoModuleS.Loaded && load<u64>(rec(i), 16) == token) return i;
  return -1;
}
// The module's init (fini = 0) or fini functions, called on the calling guest thread; returns how many
export function roRunCalls(token: u64, fini: i32): i32 {
  let n = 0;
  for (;; n++) { const fn = envCall(token, fini, n); if (!fn) break; guestCall0(fn); }
  return n;
}
export function roLoadAlone(image: usize, size: u32, sha: usize): u64 { return envLoad(<u64>image, size, sha, 1); }
export function roLookupIn(token: u64, name: string): u64 { const n = sput(NAME, name); store<u8>(NAME + n, 0); return envLookupIn(token, NAME); }
export function roUnloadToken(token: u64): void { envUnload(token); }
export function roLoadedCount(): i32 { let n = 0; for (let i = 0; i < SLOTS; i++) if (inst(i).state == RoModuleS.Loaded) n++; return n; }

export function h_ro_LookupSymbol(a: usize): u64 {
  const out = P(a, 0), name = P(a, 1);
  const p = name ? envGuestSym(name) : 0;
  if (lookups < 40) { lookups++; ls(); ps("ro::LookupSymbol "); pz(name); ps(" -> "); px(p); le(); }
  if (!p) { if (!lookupRed) { lookupRed = true; ls(); ps("[RED] ro::LookupSymbol cannot find "); pz(name); ps(" (first case)"); le(); } return RO_FAIL; }
  if (out) store<u64>(out, p);
  return 0;
}
export function h_ro_LookupModuleSymbol(a: usize): u64 {
  const out = P(a, 0), m = moduleFrom(P(a, 1)), name = P(a, 2);
  const p = m >= 0 && name ? envLookupIn(load<u64>(rec(m), 16), name) : 0;
  // A name the loaded module does not define fails on Horizon too, and games probe for one. Only a module the host
  // does not know is wrong
  if (!p && m >= 0) { if (modSymLogs < 8) { modSymLogs++; ls(); ps("ro::LookupModuleSymbol "); pz(name); ps(": not defined in that module (failure, as on Horizon)"); le(); } return RO_FAIL; }
  if (!p) { if (!modSymRed) { modSymRed = true; ls(); ps("[RED] ro::LookupModuleSymbol "); pz(name); ps(": not a loaded module"); le(); } return RO_FAIL; }
  if (out) store<u64>(out, p);
  return 0;
}
// As the SDK computes it (no service): the bss size from the NRO header
export function h_ro_GetBufferSize(a: usize): u64 {
  const out = P(a, 0), h = P(a, 1);
  if (!h || load<u32>(h, 0x10) != NRO0) return RO_NOT_NRO;
  if (out) store<u64>(out, <u64>load<u32>(h, 0x38));
  return 0;
}
function loadModule(a: usize): u64 {
  const rm = P(a, 0), h = P(a, 1), buf = X(a, 2), size = X(a, 3), flag = I(a, 4);
  if (!h || load<u32>(h, 0x10) != NRO0) return RO_NOT_NRO;
  const n = load<u32>(h, 0x18);
  sha256(h, n, SHA);
  // Online SDKs are never loaded, whatever the game: refused, the game's EOS_Platform_Create stays a stub and it plays offline
  if (refused(SHA)) { ls(); ps("ro::LoadModule: refused "); hex8(SHA); ps("... ("); pu(n); ps(" bytes): an online SDK, not loaded; the game plays offline"); le(); return RO_FAIL; }
  if (slotBySha(SHA) >= 0) { ls(); ps("[RED] ro::LoadModule: "); hex8(SHA); ps("... is loaded already"); le(); return RO_FAIL; }
  let s = -1; for (let i = 0; i < SLOTS; i++) if (inst(i).state == RoModuleS.Empty) { s = i; break; }
  if (s < 0) { red("ro::LoadModule: more than 64 modules loaded at once"); return RO_FAIL; }
  const token = envLoad(<u64>h, n, SHA, 0);
  if (!token) { ls(); ps("[RED] ro::LoadModule: the loader could not map the NRO with SHA-256 "); hex8(SHA); ps("... ("); pu(n); ps(" bytes)"); le(); return RO_FAIL; }
  inst(s).step(RoModuleE.Map);
  store<u64>(rec(s), token, 16); copy(rec(s) + 24, SHA, 32);
  if (roLookupIn(token, "EOS_Platform_Create")) {
    envUnload(token); inst(s).step(RoModuleE.Refuse);
    ls(); ps("ro::LoadModule: refused "); hex8(SHA); ps("...: an online SDK (Epic Online Services), not loaded; the game plays offline"); le();
    return RO_FAIL;
  }
  if (rm) { store<u64>(rm, token); store<u32>(rm, 1, 8); store<u32>(rm, 0, 12); store<u64>(rm, <u64>h, 16); store<u64>(rm, buf, 24); }
  inst(s).step(RoModuleE.Ready);
  const inits = roRunCalls(token, 0);   // as RoModule::CallInit: the module's _init (registers it and runs its init_array)
  envActivate(token);
  ls(); ps("ro::LoadModule (SHA-256 "); hex8(SHA); ps("..., "); pu(n); ps(" bytes, buffer "); px(size); ps(flag & 1 ? ", bind now): " : ", bind lazy): "); pu(inits); ps(" init call(s)"); le();
  return 0;
}
export function h_ro_LoadModule(a: usize): u64 { return loadModule(a); }
// SDK 19 adds a bool after the bind flag
export function h_ro_LoadModule2(a: usize): u64 { return loadModule(a); }
export function h_ro_UnloadModule(a: usize): u64 {
  const rm = P(a, 0), s = moduleFrom(rm);
  if (s < 0) { ls(); ps("[RED] ro::UnloadModule: not a loaded module ("); px(rm); ps(")"); le(); return 0; }
  const token = load<u64>(rec(s), 16);
  inst(s).step(RoModuleE.Fini);
  roRunCalls(token, 1);   // as RoModule::CallFini
  envUnload(token);
  inst(s).step(RoModuleE.Unmap);
  store<u32>(rm, 0, 8); store<u64>(rm, 0);
  return 0;
}
// The NRRs only register hashes with the service, which checks a module's hash against them at load: nothing to check
// here. An NRR that registers only refused online SDKs fails, as every registration did before nxnative loaded NROs
export function h_ro_RegisterModuleInfo(a: usize): u64 {
  const r = P(a, 1);
  if (!r || load<u32>(r) != NRR0) return RO_FAIL;
  // version 1 (the byte at +5; the Switch 2's) has a header 0x180 bytes longer, the same fields after it
  const hdr: usize = load<u8>(r, 5) == 1 ? 0x4c0 : 0x340, off = <usize>load<u32>(r + hdr), cnt = load<u32>(r + hdr, 4);
  let nref: u32 = 0;
  for (let i: u32 = 0; i < cnt; i++) if (refused(r + off + 32 * <usize>i)) nref++;
  if (cnt && nref == cnt) { ls(); ps("ro::RegisterModuleInfo: refused an NRR that registers only online SDKs ("); pu(cnt); ps(" hashes); the game plays offline"); le(); return RO_FAIL; }
  if (nrrLogs < 20) { nrrLogs++; ls(); ps("ro::RegisterModuleInfo: NRR with "); pu(cnt); ps(" hashes"); le(); }
  return 0;
}
