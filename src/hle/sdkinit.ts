// The service connections of nninitInitializeSdkModule: port of nxnative dm/host/hle_sdkinit.c. On a console each
// connects to a system service; the host creates no session and returns.
import { ls, ps, le } from "./base";
function once(what: string): u64 { ls(); ps("init takeover: "); ps(what); ps(" (no-op)"); le(); return 0; }
export function h_nndiagStartup(a: usize): u64 { return once("nndiagStartup"); }
export function h_oe_Initialize(a: usize): u64 { return once("oe::Initialize"); }
export function h_aoc_Initialize(a: usize): u64 { return once("aoc::Initialize"); }
export function h_err_InitCtx(a: usize): u64 { return once("err::InitializeContextWriterApi"); }
export function h_fs_InitApp(a: usize): u64 { return once("fs::InitializeForApplication"); }
export function h_pctl_Initialize(a: usize): u64 { return once("pctl::Initialize"); }
export function h_diag_AbortObs(a: usize): u64 { return once("diag::InitializeApplicationAbortObserver"); }
