// Entropy, getenv and the allocator hook: port of the table entries of nxnative dm/host/hle_os.c. The guest clock,
// its freeze reasons and the object side table of that file are the kernel's (src/kernel) and are not ported here.
import { X, P, cfg, CFG_DET_ENTROPY, CFG_ALLOC_BIG_ALIGN, hostEntropy, guestSym, guestCall1, guestCall2, guestCall3, strPtr, strLen, STR_GAME_ENV, ls, ps, pu, pz, le, red, copy, zlen } from "./base";

// One stream for every outlet: random by default (import hle_entropy), a fixed-seed splitmix64 with CFG_DET_ENTROPY
let detrng: u64 = 0x5357444554524e47, detN: u64 = 0;
const E8: usize = memory.data(8);
export function entropy64(): u64 {
  if (!cfg(CFG_DET_ENTROPY)) { hostEntropy(E8, 8); return load<u64>(E8); }
  detrng += 0x9E3779B97F4A7C15;
  let z = detrng;
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9; z = (z ^ (z >> 27)) * 0x94D049BB133111EB; z ^= z >> 31;
  detN++;
  if (detN == 1 || detN % 1000 == 0) { ls(); ps("deterministic entropy call "); pu(detN); le(); }
  return z;
}
function fill(p: usize, n: usize): void {
  if (!cfg(CFG_DET_ENTROPY)) { hostEntropy(p, n); return; }
  for (let i: usize = 0; i < n; i += 8) { store<u64>(E8, entropy64()); copy(p + i, E8, n - i < 8 ? n - i : 8); }
}
export function g_getentropy(a: usize): u64 { fill(P(a, 0), <usize>X(a, 1)); return 0; }
export function g_csrng_bytes(a: usize): u64 { fill(P(a, 0), <usize>X(a, 1)); return 0; }

// getenv: the game profile's game_env (KEY=VALUE separated by spaces) answers its names, the SDK's own getenv the rest
const ENV: usize = memory.data(1024);
const ENVP: usize = memory.data(256);   // up to 32 pointers
let envN: i32 = -1, envOrig: u64 = 0, envLooked: bool = false;
function envInit(): void {
  envN = 0;
  const n = strLen(STR_GAME_ENV); if (n <= 0) return;
  copy(ENV, strPtr(STR_GAME_ENV), <usize>n); store<u8>(ENV + <usize>n, 0);
  let p = ENV; const end = ENV + <usize>n;
  while (p < end && envN < 32) {
    while (p < end && load<u8>(p) == 0x20) p++;
    if (p >= end) break;
    const t = p; let eq = false;
    while (p < end && load<u8>(p) != 0x20) { if (load<u8>(p) == 0x3D) eq = true; p++; }
    if (p < end) { store<u8>(p, 0); p++; }
    if (eq) { store<u32>(ENVP + (<usize>envN << 2), <u32>t); envN++; }
  }
  if (envN) { ls(); ps("game environment: "); pz(strPtr(STR_GAME_ENV)); le(); }
}
export function g_getenv(a: usize): u64 {
  const name = P(a, 0);
  if (envN < 0) envInit();
  const n = name ? zlen(name) : 0;
  for (let i = 0; n && i < envN; i++) {
    const e = <usize>load<u32>(ENVP + (<usize>i << 2));
    let k: usize = 0; while (k < n && load<u8>(e + k) == load<u8>(name + k)) k++;
    if (k == n && load<u8>(e + n) == 0x3D) return <u64>(e + n + 1);
  }
  if (!envLooked) { envLooked = true; envOrig = guestSym("getenv"); }
  if (!envOrig) return 0;
  return guestCall1(envOrig, X(a, 0));
}

// nn::mem::StandardAllocator::Allocate(size): passed to the SDK; with the profile's alloc_big_align, allocations of
// 64 KB or more are 64 KB aligned (Allocate(size, 0x10000))
let saAlloc: u64 = 0, saAllocAl: u64 = 0, saLooked: bool = false;
export function h_mem_SAAllocate(a: usize): u64 {
  if (!saLooked) {
    saLooked = true;
    saAlloc = guestSym("_ZN2nn3mem17StandardAllocator8AllocateEm");
    saAllocAl = guestSym("_ZN2nn3mem17StandardAllocator8AllocateEmm");
    if (!saAlloc || !saAllocAl) red("StandardAllocator::Allocate not found in the SDK: allocations through the take-over return null");
    else if (cfg(CFG_ALLOC_BIG_ALIGN)) { ls(); ps("StandardAllocator::Allocate: allocations >= 64 KB are 64 KB aligned (game profile alloc_big_align)"); le(); }
  }
  if (!saAlloc || !saAllocAl) return 0;
  const size = X(a, 1);
  return cfg(CFG_ALLOC_BIG_ALIGN) && size >= 0x10000 ? guestCall3(saAllocAl, X(a, 0), size, 0x10000) : guestCall2(saAlloc, X(a, 0), size);
}
export function osInit(): void { detrng = 0x5357444554524e47; detN = 0; envN = -1; envOrig = 0; envLooked = false; saAlloc = 0; saAllocAl = 0; saLooked = false; }
