// Textures the CPU keeps writing (profile keys tex_flush_upload and tex_dirty_upload; nxnative hle_nvn.c ft_add,
// ft_flush, nvn_ft_written, nvn_ft_poll).
//
// nxnative registers every texture that can hold data the CPU writes in place: one with storage in a pool the CPU can
// reach, block-linear, without a packaged layout, not a buffer texture (ft_add). The same textures are registered
// here, when the game's profile has tex_flush_upload.
//
// tex_flush_upload. nvnMemoryPoolFlushMappedRange / nvnBufferFlushMappedRange over any part of a registered
// texture's storage is the game publishing what it wrote there. The texture is marked (it stays marked until its
// next use, however many submissions later, and however many ranges were flushed) and at that use:
//   Uploaded  the full hash is taken, and the texture is uploaded again when it differs
//   GpuOwned  the storage is compared with what it held when the GPU took the texture over (the full hash kept
//             then): different, the CPU's content replaces the GPU's (CpuWrite, then the upload); the same, the
//             flush was about something else in the range and the GPU's content stays
// Without the key a flush is only remembered until the next submission, for 16 ranges, and never reaches a texture
// the GPU wrote (texcontent.ts).
//
// tex_dirty_upload. A registered texture the CPU rewrites with no NVN call at all. nxnative write-protects the
// texture's pages and asks the fault log; a WebAssembly memory has no page protection. Two substitutes were weighed:
//   a write barrier in translated code (a card mark per guest store, the guard's place in src/a64): it sees only the
//     stores the translator emits. The take-overs that write guest memory in the host (memcpy and friends in
//     src/hle/libc.ts, nn::fs reads straight into a pool, the kernel's copies) would each have to mark too, or a
//     texture a file is read into is missed: not sound without instrumenting every host writer, and every guest store
//     of every game would pay for it;
//   hashing the storage: sees every writer, costs only for registered textures of a game with the key.
// Hashing it is. Measured (Node 22, this machine): 3.5 to 4.0 GB/s for the full hash (64 KB to 128 MB), so the
// SCAN_BUDGET of 4 MB a submission is about 1 ms. At a registered texture's first use in a submission, after the
// sampled hash (16 probes, as for every texture) found nothing:
//   one texture at a time is being scanned: its storage is hashed from where the scan stopped, as far as the
//   submission's budget goes; when the scan reaches the end, the hash is compared with the one taken at the upload;
//   then the next registered texture that is used takes the scanner. A texture that is not used again gives it up.
// So a rewrite that no probe sees is found within two rounds of the scanner over the registered textures in use:
// one submission while they are under 4 MB together, ceil(their bytes / 4 MB) submissions a round otherwise (a
// write behind the scan's position waits for the next round). gfx_stat 17 and 18 count the bytes and the scans.
// Only an Uploaded texture is scanned: one the GPU wrote stays the GPU's until a flush says otherwise, as nxnative
// leaves an uncompressed texture whose storage the GPU wrote (mtl_tex_cpu_rewritten, MTL_REWRITE_GPU_NOW).
import * as L from "./log";
import * as O from "./obj";
import { arenaAlloc } from "./arena";
import { texEntry, TE_size, TE_full, TE_last_full } from "./tables";
import { profileHas, P_TEX_FLUSH, P_TEX_DIRTY } from "./profile";

const F_REG: u8 = 1, F_FLUSHED: u8 = 2;
const REG_CAP: u32 = 16384;                 // registered textures at a time
const RG_mem: usize = 0, RG_serial: usize = 8, RG_SIZE: usize = 16;
let FLAGS: usize = 0, REGS: usize = 0;
let nReg: u32 = 0, maxSize: u64 = 0, fullRed = false;
export function watchInit(): void { FLAGS = arenaAlloc(65536); REGS = arenaAlloc(<usize>REG_CAP * RG_SIZE); }
// @ts-ignore: decorator
@inline function flagPtr(serial: u64): usize { return FLAGS + <usize>(serial & 0xffff); }
// @ts-ignore: decorator
@inline function reg(i: u32): usize { return REGS + <usize>i * RG_SIZE; }
// the first entry whose storage starts at or after mem
function lower(mem: u64): u32 {
  let lo: u32 = 0, hi = nReg;
  while (lo < hi) { const mid = lo + (hi - lo) / 2; if (load<u64>(reg(mid), RG_mem) < mem) lo = mid + 1; else hi = mid; }
  return lo;
}
// entries of textures that are gone leave the list
function compact(): void {
  let k: u32 = 0;
  for (let i: u32 = 0; i < nReg; i++) { if (!texEntry(load<u64>(reg(i), RG_serial))) continue; if (k != i) memory.copy(reg(k), reg(i), RG_SIZE); k++; }
  nReg = k;
}
// nvnTextureInitialize made texture `tex` (its serial and storage are set): registered when the profile asks and the
// texture can hold what the CPU writes in place (nxnative ft_add)
export function watchRegister(serial: u64, tex: usize): void {
  store<u8>(flagPtr(serial), 0);
  if (!profileHas(P_TEX_FLUSH)) return;
  const mem = load<u64>(tex, O.TEX_mem), pool = <usize>load<u64>(tex, O.TEX_pool), size = load<u64>(tex, O.TEX_L + O.TL_size);
  if (!mem || !pool || !size || load<u8>(tex, O.TEX_has_layout) || load<i32>(tex, O.TEX_d + O.TD_target) == 10) return;
  if (load<u32>(pool, O.POOL_flags) & <u32>(O.POOLF_CPU_NO_ACCESS | O.POOLF_VIRTUAL)) return;
  if (load<i32>(tex, O.TEX_d + O.TD_flags) & 0x50) return;                   // LINEAR, LINEAR_RENDER_TARGET
  if (nReg == REG_CAP) compact();
  if (nReg == REG_CAP) { if (!fullRed) { fullRed = true; L.redLine("more than 16384 textures the CPU can write are live: the others are tracked as without tex_flush_upload"); } return; }
  const at = lower(mem);
  memory.copy(reg(at + 1), reg(at), <usize>(nReg - at) * RG_SIZE);
  store<u64>(reg(at), mem, RG_mem); store<u64>(reg(at), serial, RG_serial); nReg++;
  if (size > maxSize) maxSize = size;
  store<u8>(flagPtr(serial), F_REG);
}
export function watchRegistered(serial: u64): bool { return (load<u8>(flagPtr(serial)) & F_REG) != 0; }
export function watchCount(): u32 { return nReg; }
// A pool flush over [lo, lo + n): every registered texture whose storage it touches is published
let nPublished: u32 = 0;
export function watchFlush(lo: u64, n: u64): void {
  if (!nReg || !n || !profileHas(P_TEX_FLUSH)) return;
  const hi = lo + n;
  for (let i = lower(lo > maxSize ? lo - maxSize : 0); i < nReg; i++) {
    const r = reg(i), mem = load<u64>(r, RG_mem);
    if (mem >= hi) break;
    const serial = load<u64>(r, RG_serial), e = texEntry(serial);
    if (!e || mem + load<u64>(e, TE_size) <= lo) continue;
    const f = flagPtr(serial);
    if (!(load<u8>(f) & F_FLUSHED)) { store<u8>(f, load<u8>(f) | F_FLUSHED); nPublished++; }
  }
}
// Whether the texture was published since this was last asked (the mark is taken)
export function watchTake(serial: u64): bool {
  const f = flagPtr(serial), v = load<u8>(f);
  if (!(v & F_FLUSHED)) return false;
  store<u8>(f, v & ~F_FLUSHED);
  return true;
}

// ---- the scanner (tex_dirty_upload) ----
const SCAN_BUDGET: usize = 4 << 20;
let scanSerial: u64 = 0, scanOff: usize = 0, scanH: u64 = 0, scanStamp: u32 = 0, scanLeft: usize = SCAN_BUDGET;
let nScanBytes: u64 = 0, nScans: u32 = 0, nScanHits: u32 = 0, scanBytesLast: usize = 0;
// 0 KB hashed by the scanner, 1 scans completed, 2 scans that found a rewrite, 3 textures published by a flush, 4 registered textures, 5 bytes hashed in the last submission
export function watchStat(i: i32): u32 { return i == 0 ? <u32>(nScanBytes >> 10) : i == 1 ? nScans : i == 2 ? nScanHits : i == 3 ? nPublished : i == 4 ? nReg : i == 5 ? <u32>scanBytesLast : 0; }
export function watchSubmitDone(): void { scanBytesLast = SCAN_BUDGET - scanLeft; scanLeft = SCAN_BUDGET; }
// texcontent.ts hashFull, in pieces: the same value when the pieces but the last are whole words
// @ts-ignore: decorator
@inline function mix(h: u64, w: u64): u64 { h = (h ^ w) * 0x9E3779B97F4A7C15; return h ^ (h >> 29); }
function hashWords(h: u64, p: usize, n: usize): u64 { for (let i: usize = 0; i < n; i += 8) h = mix(h, load<u64>(p + i)); return h; }
// An Uploaded, registered texture at its first use in submission `submitNo`, its sampled hash unchanged. True when a
// scan of its whole storage ended now and its hash is not the one taken when it was uploaded
export function watchScan(e: usize, serial: u64, mem: usize, size: usize, submitNo: u32): bool {
  if (!profileHas(P_TEX_DIRTY) || !(load<u8>(flagPtr(serial)) & F_REG)) return false;
  if (scanSerial && scanSerial != serial) {
    if (scanStamp + 1 >= submitNo) return false;         // another texture has the scanner
    scanSerial = 0;                                      // which was not used in the last submission: it gives the scanner up
  }
  if (!scanSerial) {
    if (load<u32>(e, TE_last_full) == submitNo) return false;       // hashed in full in this submission already
    scanSerial = serial; scanOff = 0; scanH = 0x9E3779B97F4A7C15 ^ <u64>size;
  }
  scanStamp = submitNo;
  const rest = size - scanOff, last = rest <= scanLeft, n = last ? rest & ~<usize>7 : scanLeft & ~<usize>7;
  scanH = hashWords(scanH, mem + scanOff, n); scanOff += n; scanLeft -= n; nScanBytes += n;
  if (!last) return false;
  for (; scanOff < size; scanOff++) scanH = mix(scanH, load<u8>(mem + scanOff));
  scanSerial = 0; nScans++;
  store<u32>(e, submitNo, TE_last_full);
  if (scanH == load<u64>(e, TE_full)) return false;
  nScanHits++;
  return true;
}
// The texture is gone or was uploaded anew: a scan of it under way means nothing any more
export function watchForget(serial: u64): void { if (scanSerial == serial) scanSerial = 0; }
