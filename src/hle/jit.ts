// nn::jit (code generation at run time): port of nxnative dm/host/hle_jit.c. On Horizon the jit service loads the
// game's JIT plugin, an NRO the game reads from its own files, into a process of its own, maps the code memory the
// game gave it read-write there and read + execute in the game, and calls the plugin's entry points for GenerateCode
// and Control. Super Mario 64 (Super Mario 3D All-Stars) translates the N64 code its precompiled NRO lacks this way.
// There is no service process here either, so the whole API is taken over: the plugin is loaded on its own through
// the embedder's loader (ro.ts hle_ro_load with alone = 1: on Horizon it is not linked with the game), its entry
// points run on the calling guest thread, and its state lives in the transfer memory the game gives it (the work
// buffer's last part), as on Horizon. The code memory comes from the embedder:
//   hle_jit_memory(rxSize, roSize, out) -> 0 ok    out = { u64 code memory, u64 data memory }: two guest-addressable
//                                                  blocks; the game jumps into the first, so the translator must
//                                                  take code from it (one address for the plugin and the game)
//   hle_jit_code_written(rx, offset, size)         the plugin wrote code there: translations of that range are stale
//                                                  (nxnative: sys_icache_invalidate)
//   hle_jit_free(rx, rxSize, ro, roSize)
// The plugin looks its helpers up by name through a resolver the service hands it (memcpy, memmove, memset,
// PanicForPlugin, AbortImpl, UnexpectedDefaultImpl): here host stubs of this table (internal ids, hle_stub_addr).
// GenerateCode has twelve arguments: the last four come from the guest stack (import hle_stack_arg), and the plugin's
// entry takes thirteen (hle_guest_call with more than eight: the embedder puts the rest on the guest stack).
//
// The SDK's environment (the handle is the object itself): +0 the service object, +8 code memory address, +0x10 its
// size, +0x18 data memory address, +0x20 its size; GetJitEnvironmentInfo copies +8..+0x28. The handle here points to
// the same layout in this module's memory, then the plugin's configuration (JITConfiguration: the game's code and
// data memory, the transfer memory, the service's own mappings of the first two; here one mapping, as nxnative).
// Not ported: the capture and serving of generated code (DM_JIT_CAPTURE / DM_JIT_SERVE: nxnative's way to run on iOS,
// which executes no code made at run time; a browser runs it through the translator).
// nxnative ends the process where the SDK would abort (bad sizes, no plugin, a failing wrapper); here those are red
// lines and a failing result, except the plugin's own panic and abort, which end the process as an abort does.
import { Inst } from "../kit/machine";
import { JIT_ENV, JitEnvS, JitEnvE, HleExitReason } from "../kit/gen/tables";
import { X, P, X8, stackArg, stubAddr, guestCall0, guestCall1, guestCall2, guestCallN, noReturn, RES_FAIL, ls, ps, pc, pi, pu, px, pz, le, red, zero, copy, zeq } from "./base";
import { COUNT } from "./gen/table";
import { sha256 } from "./sha256";
import { roLoadAlone, roLookupIn, roRunCalls, roUnloadToken } from "./ro";
import { exitRequest } from "./lifecycle";

// @ts-ignore: decorator
@external("env", "hle_jit_memory")
declare function envMemory(rxSize: u64, roSize: u64, out: usize): i32;
// @ts-ignore: decorator
@external("env", "hle_jit_code_written")
declare function envCodeWritten(rx: u64, offset: u64, size: u64): void;
// @ts-ignore: decorator
@external("env", "hle_jit_free")
declare function envFree(rx: u64, rxSize: u64, ro: u64, roSize: u64): void;

// The internal take-overs the plugin reaches through stubs (ids COUNT + these; misc.ts internalCall dispatches)
export const INT_JIT_RESOLVE = 4, INT_JIT_PANIC = 5, INT_JIT_ABORT = 6, INT_JIT_UNEXPECTED = 7, INT_JIT_MEMCPY = 8, INT_JIT_MEMMOVE = 9, INT_JIT_MEMSET = 10;
const NRO0: u32 = 0x304F524E;
const ENVS: i32 = 4, E_SIZE: usize = 0x120;
const E_CFG: usize = 0x28, E_TOKEN: usize = 0x78, E_GEN: usize = 0x80, E_CTL: usize = 0x88, E_NCALLS: usize = 0x90, E_NBYTES: usize = 0xD0, E_INST: usize = 0x110;
const TAB: usize = memory.data(1152, 16);   // ENVS * E_SIZE
const SHA: usize = memory.data(32), MEM: usize = memory.data(16, 8), RES: usize = memory.data(8, 8), FLAGS: usize = memory.data(8, 8), RET: usize = memory.data(8, 8);
const D32: usize = memory.data(32, 8), O0: usize = memory.data(16, 8), O1: usize = memory.data(16, 8), CALL: usize = memory.data(104, 8);

// @ts-ignore: decorator
@inline function env(i: i32): usize { return TAB + <usize>i * E_SIZE; }
// @ts-ignore: decorator
@inline function inst(e: usize): Inst { return Inst.at(e + E_INST); }
export function jitInit(): void { zero(TAB, 1152); for (let i = 0; i < ENVS; i++) inst(env(i)).init(JIT_ENV, <u32>i); }
export function jitEnvCount(): i32 { let n = 0; for (let i = 0; i < ENVS; i++) if (inst(env(i)).state == JitEnvS.Ready) n++; return n; }
// The environment a handle names, 0 when it names none
function envOf(h: usize): usize {
  for (let i = 0; i < ENVS; i++) if (h == env(i) && inst(h).state == JitEnvS.Ready) return h;
  return 0;
}
function hex8(sha: usize): void { for (let k = 0; k < 8; k++) { const b = <u32>load<u8>(sha + <usize>k); pc((b >> 4) < 10 ? 48 + (b >> 4) : 87 + (b >> 4)); pc((b & 15) < 10 ? 48 + (b & 15) : 87 + (b & 15)); } }

// ---------- the plugin's helpers ----------
// What the plugin's resolver answers: the address of a host stub, 0 for a name the host does not provide
export function jitResolve(name: usize): u64 {
  let k = -1;
  if (name) {
    if (zeq(name, "memcpy")) k = INT_JIT_MEMCPY; else if (zeq(name, "memmove")) k = INT_JIT_MEMMOVE; else if (zeq(name, "memset")) k = INT_JIT_MEMSET;
    else if (zeq(name, "PanicForPlugin")) k = INT_JIT_PANIC; else if (zeq(name, "_ZN2nn4diag6detail9AbortImplEPKcS3_S3_i")) k = INT_JIT_ABORT;
    else if (zeq(name, "_ZN2nn6detail21UnexpectedDefaultImplEPKcS2_i")) k = INT_JIT_UNEXPECTED;
  }
  if (k < 0) { ls(); ps("[RED] JIT plugin asks for "); pz(name); ps(", which the host does not provide"); le(); return 0; }
  return stubAddr(COUNT + k);
}
function fatal(): u64 { exitRequest(HleExitReason.abort, 0, 0, 0); return noReturn(); }
export function jitPanic(a: usize): u64 { ls(); ps("[RED] JIT plugin PanicForPlugin: "); pz(P(a, 0)); le(); return fatal(); }
export function jitAbort(a: usize): u64 {
  ls(); ps("[RED] JIT plugin abort: "); if (P(a, 0)) pz(P(a, 0)); ps(" in "); if (P(a, 1)) pz(P(a, 1)); ps(" ("); if (P(a, 2)) pz(P(a, 2)); ps(":"); pi(load<i32>(a + 24)); ps(")"); le();
  return fatal();
}
export function jitUnexpected(a: usize): u64 {
  ls(); ps("[RED] JIT plugin unexpected default: "); if (P(a, 0)) pz(P(a, 0)); ps(" ("); if (P(a, 1)) pz(P(a, 1)); ps(":"); pi(load<i32>(a + 16)); ps(")"); le();
  return fatal();
}

// ---------- the API ----------
function createFail(why: string): u64 { ls(); ps("[RED] jit::CreateJitEnvironment: "); ps(why); ps(" (the SDK aborts; here the call fails)"); le(); return RES_FAIL; }
// CreateJitEnvironment(&handle, config, plugin, work, work_size): config = { code memory size, data memory size },
// plugin = { NRR buffer, its size, NRO buffer, its size, transfer memory size } (sizes are 2 MB multiples, as the SDK
// checks), work = code memory | data memory | transfer memory (2 MB aligned)
export function h_jit_Create(a: usize): u64 {
  const out = P(a, 0), cfg = P(a, 1), plug = P(a, 2), work = X(a, 3), workSize = X(a, 4);
  const rxSize = load<u64>(cfg), roSize = load<u64>(cfg, 8), tmemSize = load<u64>(plug, 32);
  if (((work | rxSize | roSize | tmemSize) & 0x1fffff) || rxSize + roSize + tmemSize > workSize) return createFail("sizes or the work buffer are not what the SDK takes");
  // the NRO is one of the two buffers (the NRR the other; Super Mario 64 passes the NRR first)
  let nro: usize = 0, nroSize: u64 = 0;
  for (let k = 0; k < 2; k++) { const b = <usize>load<u64>(plug + (<usize>k << 4)), sz = load<u64>(plug + (<usize>k << 4), 8); if (b && sz >= 0x80 && load<u32>(b, 0x10) == NRO0) { nro = b; nroSize = sz; } }
  if (!nro) return createFail("no NRO among the plugin buffers");
  let e: usize = 0;
  for (let i = 0; i < ENVS; i++) if (inst(env(i)).state == JitEnvS.None) { e = env(i); break; }
  if (!e) return createFail("more than 4 environments");
  let n = load<u32>(nro, 0x18); if (<u64>n > nroSize) n = <u32>nroSize;
  sha256(nro, n, SHA);
  const token = roLoadAlone(nro, n, SHA);
  if (!token) return createFail("the loader could not map the plugin NRO");
  if (envMemory(rxSize, roSize, MEM)) { roUnloadToken(token); return createFail("no code memory"); }
  const rx = load<u64>(MEM), ro = load<u64>(MEM, 8);
  zero(e, E_INST);
  store<u64>(e, rx, 8); store<u64>(e, rxSize, 16); store<u64>(e, ro, 24); store<u64>(e, roSize, 32);
  // On Horizon the work buffer's code and data parts become code memory the game no longer reaches, and the
  // transfer memory part the plugin's state
  const c = e + E_CFG;
  store<u64>(c, rx); store<u64>(c, rxSize, 8); store<u64>(c, ro, 16); store<u64>(c, roSize, 24);
  store<u64>(c, work + rxSize + roSize, 32); store<u64>(c, tmemSize, 40);
  store<u64>(c, rx, 48); store<u64>(c, rxSize, 56); store<u64>(c, ro, 64); store<u64>(c, roSize, 72);
  store<u64>(e, token, E_TOKEN);
  inst(e).step(JitEnvE.Create);
  // as the service loads a plugin: its _init, GetVersion (1), ResolveBasicSymbols, SetupDiagnostics (off), Configure, OnPrepared
  const gv = roLookupIn(token, "nnjitpluginGetVersion"), rb = roLookupIn(token, "nnjitpluginResolveBasicSymbols"), sd = roLookupIn(token, "nnjitpluginSetupDiagnostics"),
    cf = roLookupIn(token, "nnjitpluginConfigure"), op = roLookupIn(token, "nnjitpluginOnPrepared");
  const gen = roLookupIn(token, "nnjitpluginGenerateCode"), ctl = roLookupIn(token, "nnjitpluginControl");
  store<u64>(e, gen, E_GEN); store<u64>(e, ctl, E_CTL);
  let bad = !gv || !cf || !gen || !op;
  if (!bad) {
    roRunCalls(token, 0);
    const ver = guestCall0(gv);
    if (ver != 1) { bad = true; ls(); ps("[RED] jit: the plugin is version "); pu(ver); ps(", the service takes 1"); le(); }
  }
  if (bad) {
    roUnloadToken(token); envFree(rx, rxSize, ro, roSize); inst(e).step(JitEnvE.Fail);
    return createFail("the NRO lacks the plugin entry points (GetVersion, Configure, GenerateCode, OnPrepared) or is not version 1");
  }
  const resolver = stubAddr(COUNT + INT_JIT_RESOLVE);
  if (!resolver) red("jit: the embedder makes no stub for the plugin's resolver (hle_stub_addr): the plugin gets none of its helpers");
  if (rb) guestCall1(rb, resolver);
  store<u64>(RES, resolver);
  if (sd) guestCall2(sd, 0, <u64>RES);
  store<u64>(FLAGS, 0);
  guestCall1(cf, <u64>FLAGS);
  guestCall1(op, <u64>c);
  inst(e).step(JitEnvE.Prepared);
  store<u64>(out, <u64>e);
  ls(); ps("jit::CreateJitEnvironment: plugin (SHA-256 "); hex8(SHA); ps("..., "); pu(n); ps(" bytes) loaded; code memory "); px(rx); ps(" + "); px(rxSize); ps(", data memory "); px(ro); ps(" + "); px(roSize);
  ps(", plugin state "); px(work + rxSize + roSize); ps(" + "); px(tmemSize); ps(" (the work buffer's last part)"); le();
  return 0;
}
export function h_jit_Destroy(a: usize): u64 {
  const e = envOf(P(a, 0));
  if (!e) { if (P(a, 0)) red("jit::DestroyJitEnvironment: not an environment of this host"); return 0; }
  ls(); ps("jit::DestroyJitEnvironment: GenerateCode"); for (let c = 1; c <= 4; c++) { ps(c == 1 ? " " : " / "); pu(load<u64>(e + E_NCALLS + (<usize>c << 3))); } ps(" calls (commands 1-4)"); le();
  const token = load<u64>(e, E_TOKEN);
  roRunCalls(token, 1);
  roUnloadToken(token);
  envFree(load<u64>(e, 8), load<u64>(e, 16), load<u64>(e, 24), load<u64>(e, 32));
  inst(e).step(JitEnvE.Destroy);
  zero(e, E_INST);
  return 0;
}
// Where the code and data memory are mapped in the game: { rx, rx size, ro, ro size } by value (32 bytes: through x8)
export function h_jit_Info(a: usize): u64 {
  const e = envOf(P(a, 0)), out = X8(a);
  if (!out) return 0;
  if (!e) { red("jit::GetJitEnvironmentInfo: not an environment of this host"); zero(out, 32); return 0; }
  copy(out, e + 8, 32);
  return 0;
}
// Control(handle, command, in, in_size, out, out_size): the plugin's return value
export function h_jit_Control(a: usize): u64 {
  const e = envOf(P(a, 0)), cmd = X(a, 1);
  if (!e) { red("jit::Control: not an environment of this host"); return <u64><u32>-1; }
  const ctl = load<u64>(e, E_CTL);
  if (!ctl) { red("jit::Control: the plugin has no nnjitpluginControl (the SDK aborts; here the call fails)"); return <u64><u32>-1; }
  store<i32>(RET, -1);
  store<u64>(CALL, <u64>RET); store<u64>(CALL, <u64>(e + E_CFG), 8); store<u64>(CALL, cmd, 16); store<u64>(CALL, X(a, 2), 24); store<u64>(CALL, X(a, 3), 32); store<u64>(CALL, X(a, 4), 40); store<u64>(CALL, X(a, 5), 48);
  const w = guestCallN(ctl, CALL, 7), ret = load<i32>(RET);
  ls(); ps("jit::Control command "); pu(cmd); ps(": "); pi(ret); if (w) ps(" (the plugin's wrapper failed)"); le();
  if (w) red("jit::Control: the plugin's wrapper failed (the SDK aborts; here the call returns the plugin's value)");
  return <u64><u32>ret;
}
function rangeOk(r: usize, size: u64): bool { return load<u64>(r) <= size && load<u64>(r, 8) <= size - load<u64>(r); }
// GenerateCode(&code_out, &data_out, handle, command, in, in_size, code_in, data_in, data, data_size, out, out_size):
// the ranges are offsets in the code and data memory; data (at most 32 bytes) goes to the plugin zero-padded to 32,
// as the SDK sends it
export function h_jit_Generate(a: usize): u64 {
  const c0out = P(a, 0), c1out = P(a, 1), e = envOf(P(a, 2)), cmd = X(a, 3);
  const data = <usize>stackArg(0), dataSize = stackArg(1), out = stackArg(2), outSize = stackArg(3);
  if (!e) { red("jit::GenerateCode: not an environment of this host"); return <u64><u32>-1; }
  zero(D32, 32); if (data) copy(D32, data, dataSize < 32 ? <usize>dataSize : 32);
  zero(O0, 16); zero(O1, 16); store<i32>(RET, -1);
  store<u64>(CALL, <u64>RET); store<u64>(CALL, <u64>O0, 8); store<u64>(CALL, <u64>O1, 16); store<u64>(CALL, <u64>(e + E_CFG), 24); store<u64>(CALL, cmd, 32);
  store<u64>(CALL, X(a, 4), 40); store<u64>(CALL, X(a, 5), 48); store<u64>(CALL, X(a, 6), 56); store<u64>(CALL, X(a, 7), 64);
  store<u64>(CALL, <u64>D32, 72); store<u64>(CALL, dataSize, 80); store<u64>(CALL, out, 88); store<u64>(CALL, outSize, 96);
  const w = guestCallN(load<u64>(e, E_GEN), CALL, 13), ret = load<i32>(RET);
  if (!w && !ret && load<u64>(O0, 8)) {
    if (!rangeOk(O0, load<u64>(e, 16))) { ls(); ps("[RED] jit::GenerateCode: the plugin returned code range "); px(load<u64>(O0)); ps(" + "); px(load<u64>(O0, 8)); ps(" beyond the code memory"); le(); }
    else envCodeWritten(load<u64>(e, 8), load<u64>(O0), load<u64>(O0, 8));
  }
  const c: usize = cmd < 8 ? <usize>cmd : 0, k = load<u64>(e + E_NCALLS + (c << 3)) + 1;
  store<u64>(e + E_NCALLS + (c << 3), k); store<u64>(e + E_NBYTES + (c << 3), load<u64>(e + E_NBYTES + (c << 3)) + load<u64>(O0, 8));
  if (k <= 16 || !(k & (k - 1))) {
    ls(); ps("jit::GenerateCode #"); pu(k); ps(" command "); pu(cmd); ps(": "); pi(ret); ps(", code "); px(load<u64>(O0)); ps(" + "); px(load<u64>(O0, 8)); ps(", data "); px(load<u64>(O1)); ps(" + "); px(load<u64>(O1, 8)); le();
  }
  if (w) { ls(); ps("[RED] jit::GenerateCode: the plugin's wrapper failed (command "); pu(cmd); ps("; the SDK aborts, here the call returns the plugin's value)"); le(); }
  if (ret) { ls(); ps("[RED] jit::GenerateCode command "); pu(cmd); ps(": the plugin returned "); pi(ret); ps(" (the service fails the request)"); le(); }
  if (c0out) copy(c0out, O0, 16);
  if (c1out) copy(c1out, O1, 16);
  return <u64><u32>ret;
}
