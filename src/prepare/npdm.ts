// main.npdm: the program's metadata. What the prepare step takes from it, as nxnative does (scripts/pack_dump.py
// program_id, dm/games/profile_guess.py npdm / aarch64): the program ID in the ACI0 section (the title ID), the
// system resource size (META +0x14: non-zero means virtual address memory), the 64-bit instruction flag (META +0xC
// bit 0), and the main thread's stack size (META +0x1C), which Horizon gives the main thread.
import { red, puts, putu, putx, emit } from "./base";

export const NPDM_OK: i32 = 0;
export const NPDM_NOT_META: i32 = 1;    // no "META" magic, or shorter than the header
export const NPDM_NO_ACI0: i32 = 2;     // the ACI0 section is not where the header says, or too short

let programId: u64 = 0;
let sysResource: u32 = 0;
let flags: u32 = 0;
let stackSize: u32 = 0;
let version: u32 = 0;
let prio: u32 = 0;
let core: u32 = 0;
const NAME: usize = memory.data(16);

export function npdmParse(d: usize, len: u32): i32 {
  programId = 0; sysResource = 0; flags = 0; stackSize = 0; version = 0;
  if (len < 0x80 || load<u32>(d) != 0x4154454D) {            // "META"
    red(); puts("main.npdm is not an NPDM ("); putu(len); puts(" bytes"); if (len >= 4) { puts(", magic "); putx(load<u32>(d)); } puts(")"); emit();
    return NPDM_NOT_META;
  }
  flags = load<u8>(d, 0x0C);
  prio = load<u8>(d, 0x0E); core = load<u8>(d, 0x0F);
  sysResource = load<u32>(d, 0x14);
  version = load<u32>(d, 0x18);
  stackSize = load<u32>(d, 0x1C);
  memory.copy(NAME, d + 0x20, 16);
  const off = load<u32>(d, 0x70), size = load<u32>(d, 0x74);
  if (<u64>off + 0x18 > <u64>len || size < 0x18 || <u64>off + <u64>size > <u64>len || load<u32>(d + off) != 0x30494341) {   // "ACI0"
    red(); puts("main.npdm has no ACI0 section at "); putx(off); puts(" ("); putx(size); puts(" bytes; the file is "); putx(len); puts(")"); emit();
    return NPDM_NO_ACI0;
  }
  programId = load<u64>(d + off, 0x10);
  return NPDM_OK;
}
export function npdmProgramId(): u64 { return programId; }
export function npdmSysResource(): u32 { return sysResource; }
export function npdmFlags(): u32 { return flags; }
export function npdmStackSize(): u32 { return stackSize; }
export function npdmVersion(): u32 { return version; }
export function npdmMainThread(): u32 { return (prio << 8) | core; }
export function npdmNamePtr(): usize { return NAME; }
