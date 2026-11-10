// Networking and peripheral services as newer SDKs see them: port of nxnative dm/host/hle_offline.c. Nearly all of
// it is constants (compiled from the C text); here the few bodies with loops or layouts, the Poll / Select forms that
// share hle_net.c's event descriptors, and PlayReport::Send, which nxnative writes in assembly.
import { X, I, P, X8, zero, sput } from "./base";
import { pollArgs, select, getErrno } from "./net";

export function h_sk_Poll(a: usize): u64 { return pollArgs(a); }
export function h_sk_Select2(a: usize): u64 { return select(a); }
// nxnative answers a constant ENETDOWN here and keeps a separate per-thread store in hle_net.c; nxweb has one store
export function h_sk_Errno(a: usize): u64 { return <u64><u32>getErrno(); }
// SDK 22's PlayReport::Send returns an AsyncContext through x8, a pointer to the service's object: null, as the SDK's
// default context (its completion event is signalled, GetResult answers 0, the destructor does nothing)
export function h_prepo_Send(a: usize): u64 { const out = X8(a); if (out) store<u64>(out, 0); return X(a, 0); }
export function h_irs_Handle(a: usize): u64 { return load<u32>(P(a, 0)) & 0xFF; }
function ipCfg(a: usize): u64 { for (let i = 0; i < 5; i++) { const p = P(a, i); if (p) store<u32>(p, 0); } return 0x2A2; }
export function h_nifm_IpCfg(a: usize): u64 { return ipCfg(a); }
export function h_nifm_IpCfg10(a: usize): u64 { return ipCfg(a); }
// EnvironmentIdentifier = char[8]: the retail environment
export function h_nsd_EnvId(a: usize): u64 { const out = P(a, 0); zero(out, 8); sput(out, "lp1"); return 0; }
export function h_ngc_Check16(a: usize): u64 { const out = P(a, 1), n = X(a, 4); for (let i: u64 = 0; out && i < n; i++) store<u32>(out + (<usize>i << 2), 0); return 0; }
// 0x18 bytes per entry { application ID, play time, launch count }: never played
export function h_pdm_QueryStats(a: usize): u64 {
  const out = P(a, 0), ids = P(a, 2), n = I(a, 3);
  for (let i = 0; out && ids && i < n; i++) { const e = out + <usize>i * 24; store<u64>(e, load<u64>(ids + (<usize>i << 3))); store<u64>(e, 0, 8); store<u64>(e, 0, 16); }
  return 0;
}
export function h_album_ShareUrl(a: usize): u64 { const url = P(a, 0); if (url && X(a, 1)) store<u8>(url, 0); return 0x2A2; }
