// nvdrv (the NVIDIA driver service): port of nxnative dm/host/hle_nvdrv.c. The host takes over NVN entirely; only
// the SDK movie library's hardware decoder opens /dev/nvhost-* directly. Opening always fails (fd -1) and the other
// calls return an error (compiled from the C text), so the decoder takes its own failure path.
import { P, ls, ps, pz, le } from "./base";
let redDone: bool = false;
export function nvdrvInit(): void { redDone = false; }
export function h_nvos_Open(a: usize): u64 {
  if (!redDone) { redDone = true; ls(); ps("[RED] nvdrv: cannot open "); pz(P(a, 0)); ps(" (the host has no nvdrv; only hardware movie decoding uses it)"); le(); }
  return 0xFFFFFFFF;
}
