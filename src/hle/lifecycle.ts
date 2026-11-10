// The exit path: port of nxnative dm/host/hle_lifecycle.c (dm_host_shutdown_then) as one machine with a reason.
// nxnative pauses audio, suspends graphics and calls _exit(0) itself, with a 1.5 s fallback. Here the embedder owns
// audio, graphics and the run loop: the first request tells it (import hle_exit_request) and the machine waits in
// Exiting until it reports back (export hle_exit_done). hle_lifecycle.c has no table entries of its own.
import { Inst } from "../kit/machine";
import { HLE_EXIT, HleExitS, HleExitE, HleExitReason } from "../kit/gen/tables";
import { ls, ps, pu, le } from "./base";

// reason (HleExitReason), a value (the program index of ExecuteProgram, the Result of an abort) and the bytes that go with it
// @ts-ignore: decorator
@external("env", "hle_exit_request")
declare function envExitRequest(reason: i32, value: u64, ptr: usize, len: usize): void;

const INST: usize = memory.data(16);
// @ts-ignore: decorator
@inline function m(): Inst { return Inst.at(INST); }
export function exitInit(): void { m().init(HLE_EXIT, 0); }
export function exitState(): u8 { return m().state; }
export function exitReason(): u32 { return <u32>m().data; }

// true: this request started the exit; false: one was already under way (the first wins, as dm_host_shutdown_then's once)
export function exitRequest(reason: u64, value: u64, ptr: usize, len: usize): bool {
  if (!m().can(HleExitE.Request)) return false;
  m().step(HleExitE.Request, reason);
  ls(); ps("received "); ps(reason == HleExitReason.hostShutdown ? "a host shutdown" : reason == HleExitReason.executeProgram ? "oe::ExecuteProgram" : "an abort"); ps(": graceful exit ("); pu(value); ps(")"); le();
  envExitRequest(<i32>reason, value, ptr, len);
  return true;
}
export function exitDone(): void {
  if (m().state == HleExitS.Exiting) m().step(HleExitE.Done, m().data);
}
