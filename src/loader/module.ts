// Guest code modules in memory: the role of Horizon's rtld, after nxnative's dm/host/loader.c.
//
//   parse      the file's header is validated (nso.ts); the record keeps referring to the file's bytes
//   map        the segments are written at a guest base (page aligned, in linear memory, below 4 GB), the bss is zeroed,
//              MOD0 and the dynamic section are read, every table and every relocation is validated, the exports are hashed
//   relocate   R_AARCH64_RELATIVE, ABS64, GLOB_DAT, JUMP_SLOT and DT_RELR are applied; a symbol binds as bindSym says
//   unload     the module leaves the lookups, and what pointed into it is bound again
//   map again  everything is restored from the file's bytes and the bss is zeroed
//
// The lifecycle is the kit machine `module` (defs/module.json); the state changes only through Inst.step.
// Guest memory is linear memory: a guest address is the offset. Everything read from an image goes through the
// checked accessors below (rd8..rd64, wr64), with offsets relative to the module's base; the image is untrusted even
// after validation, since guest code can write to it between a load and a later rebind.
// Nothing here uses the AssemblyScript heap: records and tables come from the arena given to init().
import { Inst } from "../kit/machine";
import { MODULE, ModuleS, ModuleE, ModuleRefuseReason } from "../kit/gen/tables";
import { Layout, parseHeader, loadSegments } from "./nso";
import { PAGE, red, info, puts, putu, putx, putn, emit, context, memBytes, inMemory, overlaps, fnv, bytesEqual } from "./util";

export const OK: i32 = 0;
export const ERR_ARG: i32 = -1;       // a bad argument (handle, base, range): nothing changed
export const ERR_STATE: i32 = -2;     // the module's state does not allow this (the kit logged the refusal)
export const ERR_REFUSED: i32 = -3;   // the module was refused: its state is Refused, the reason is its data
export const ERR_NOMEM: i32 = -4;     // the arena or the stub region is full

// Kinds of entry in the host function table
export const HOST_HLE: u32 = 0;          // fills an import no loaded module defines (nxnative HLE)
export const HOST_FORCE: u32 = 1;        // wins over every module's definition, for every reference (nxnative HLE_FORCE)
export const HOST_UNRESOLVED: u32 = 2;   // made by the loader for an import nothing provides: calling it is reported by name

export const MAX_MODULES: u32 = 4096;

// ELF
const DT_PLTRELSZ: u64 = 2, DT_HASH: u64 = 4, DT_STRTAB: u64 = 5, DT_SYMTAB: u64 = 6, DT_RELA: u64 = 7, DT_RELASZ: u64 = 8,
  DT_RELAENT: u64 = 9, DT_STRSZ: u64 = 10, DT_SYMENT: u64 = 11, DT_INIT: u64 = 12, DT_FINI: u64 = 13, DT_PLTREL: u64 = 20,
  DT_JMPREL: u64 = 23, DT_INIT_ARRAY: u64 = 25, DT_FINI_ARRAY: u64 = 26, DT_INIT_ARRAYSZ: u64 = 27, DT_FINI_ARRAYSZ: u64 = 28,
  DT_RELRSZ: u64 = 35, DT_RELR: u64 = 36, DT_RELRENT: u64 = 37, DT_GNU_HASH: u64 = 0x6ffffef5;
const R_NONE: u32 = 0, R_ABS64: u32 = 257, R_GLOB_DAT: u32 = 1025, R_JUMP_SLOT: u32 = 1026, R_RELATIVE: u32 = 1027;
const SYM: u64 = 24, RELA: u64 = 24;
const STB_LOCAL: u32 = 0, STB_GLOBAL: u32 = 1, STB_WEAK: u32 = 2;
const STV_DEFAULT: u32 = 0, STV_PROTECTED: u32 = 3;
const SHN_ABS: u32 = 0xFFF1;

// Bits of Mod.have
const HAVE_INIT: u32 = 1, HAVE_FINI: u32 = 2, HAVE_HASH: u32 = 4, HAVE_GNU_HASH: u32 = 8, HAVE_RELR: u32 = 16, HAVE_STRSZ: u32 = 32;

// One module. The Layout part is what the file's header says; `file` is the pristine copy every map reads.
// @ts-ignore: decorator
@unmanaged
class Mod extends Layout {
  inst0: u64; inst1: u64;   // the kit instance (16 bytes)
  base: usize;              // guest address of the image (anywhere in linear memory), valid from Mapped on
  symh: usize;              // the export table (in the arena): symhCap slots of u32 symbol index, 0 = empty (open addressing on fnv)
  index: u32;               // the handle
  have: u32;
  mod0: u32; dyn: u32;      // image offsets, as everything below
  bssStart: u32; bssEnd: u32;   // what MOD0 says (not used for mapping: the header's bss size is)
  symtab: u32; strtab: u32; strEnd: u32; nsym: u32;
  rela: u32; relaN: u32; jmprel: u32; jmprelN: u32; relr: u32; relrN: u32;
  init: u32; fini: u32;
  initArray: u32; initArrayN: u32; finiArray: u32; finiArrayN: u32;
  hash: u32; gnuHash: u32;
  symhCap: u32;
  mapSeq: u32; relocSeq: u32; loads: u32;
  nRelative: u32; nRelr: u32; nAbs: u32; nGlob: u32; nJump: u32; nUnsupported: u32; nWeak0: u32;
  nameLen: u32;
  name0: u64; name1: u64; name2: u64; name3: u64;

  // @ts-ignore: decorator
  @inline get inst(): Inst { return Inst.at(changetype<usize>(this) + offsetof<Mod>("inst0")); }
  // @ts-ignore: decorator
  @inline get namePtr(): usize { return changetype<usize>(this) + offsetof<Mod>("name0"); }
  // @ts-ignore: decorator
  @inline get state(): u8 { return this.inst.state; }
  // Takes part in symbol lookups
  // @ts-ignore: decorator
  @inline get mapped(): bool { const s = this.state; return s == ModuleS.Mapped || s == ModuleS.Relocated || s == ModuleS.Active || s == ModuleS.Pinned; }
  // Has had its relocations applied
  // @ts-ignore: decorator
  @inline get relocated(): bool { const s = this.state; return s == ModuleS.Relocated || s == ModuleS.Active || s == ModuleS.Pinned; }
}

// ---- global state (reset by init) ----
const MODS: usize = memory.data(32768);     // MAX_MODULES pointers to records (8 bytes each: a usize in either build)
const LOADED: usize = memory.data(16384);   // the handles of the mapped modules, in the order they were mapped: the lookup order
let nMods: u32 = 0, nLoaded: u32 = 0, seq: u32 = 0;
let arena: usize = 0, arenaTop: usize = 0, arenaEnd: usize = 0;
let stubBase: usize = 0, stubCap: u32 = 0;
let hostEnt: usize = 0, hostIdx: usize = 0, hostMask: u32 = 0, hostCount: u32 = 0, stubOverflow: u32 = 0;
let faults: u32 = 0;   // checked accessors that were asked for something outside an image: stays 0 unless this file has a bug
let ready: bool = false;

export function faultCount(): u32 { return faults; }
export function moduleCount(): u32 { return nMods; }
export function loadedCount(): u32 { return nLoaded; }
export function loadedAt(i: u32): i32 { return i < nLoaded ? <i32>load<u32>(LOADED + (<usize>i << 2)) : -1; }

function alloc(n: u64): usize {
  const p = (arenaTop + 7) & ~7;
  if (p > arenaEnd || n > <u64>(arenaEnd - p)) return 0;
  arenaTop = p + <usize>n;
  memory.fill(p, 0, <usize>n);
  return p;
}
export function arenaUsed(): u32 { return <u32>(arenaTop - arena); }

// @ts-ignore: decorator
@inline function modAt(h: u32): Mod { return changetype<Mod>(load<usize>(MODS + (<usize>h << 3))); }
function modOf(h: i32): Mod {
  if (!ready || <u32>h >= nMods) { context(0, 0); red(); puts("no module with handle "); putu(<u64><u32>h); emit(); return changetype<Mod>(<usize>0); }
  const m = modAt(<u32>h);
  context(m.namePtr, m.nameLen);
  return m;
}

// ---- host function table and the stub region ----
// Entry (32 bytes): +0 name (offset in the arena), +4 name length, +8 name hash, +12 references, +16 handle of the first module that
// referred to it (-1 none), +20 kind, +24 mark (scratch for unresolved()). Entry i owns the 4 bytes at stubBase + 4 * i.
const HOST_REC: usize = 32;
// @ts-ignore: decorator
@inline function hostRec(id: u32): usize { return hostEnt + <usize>id * HOST_REC; }

// Set up the loader: everything before is forgotten. [arenaPtr, +arenaLen) is the loader's working memory;
// [stubBase_, +4 * stubCap_) is the host stub region, a guest address range no module may be mapped over.
export function init(arenaPtr: usize, arenaLen: usize, stubBase_: usize, stubCap_: u32): i32 {
  ready = false; context(0, 0);
  if (!arenaPtr || arenaPtr < __heap_base || arenaLen > 0xFFFFFFFF || !inMemory(arenaPtr, arenaLen)) { red(); puts("init: the arena is not free linear memory"); emit(); return ERR_ARG; }
  if ((stubBase_ & 3) || stubBase_ < __heap_base || !inMemory(stubBase_, <u64>stubCap_ * 4) || overlaps(arenaPtr, arenaLen, stubBase_, <u64>stubCap_ * 4)) {
    red(); puts("init: the stub region is not free linear memory on a 4-byte boundary"); emit(); return ERR_ARG;
  }
  arena = arenaPtr; arenaTop = arena; arenaEnd = arena + arenaLen;
  stubBase = stubBase_; stubCap = stubCap_;
  nMods = 0; nLoaded = 0; seq = 0; hostCount = 0; stubOverflow = 0; faults = 0;
  let cap: u32 = 16;
  while (cap < stubCap * 2 && cap < 0x40000000) cap <<= 1;
  hostEnt = alloc(<u64>stubCap * HOST_REC);
  hostIdx = alloc(<u64>cap * 4);
  if ((stubCap && !hostEnt) || !hostIdx) { red(); puts("init: the arena is too small for "); putu(stubCap); puts(" host functions"); emit(); return ERR_NOMEM; }
  hostMask = cap - 1;
  ready = true;
  return OK;
}

function hostFind(name: usize, len: u32, h: u32): i32 {
  for (let j = h & hostMask, tries: u32 = 0; tries <= hostMask; j = (j + 1) & hostMask, tries++) {
    const v = load<u32>(hostIdx + (<usize>j << 2));
    if (!v) return -1;
    const r = hostRec(v - 1);
    if (load<u32>(r, 8) == h && load<u32>(r, 4) == len && bytesEqual(arena + <usize>load<u32>(r), name, len)) return <i32>(v - 1);
  }
  return -1;
}

// A new entry; the name is copied to the arena. -1 when the stub region or the arena is full.
function hostInsert(name: usize, len: u32, h: u32, kind: u32): i32 {
  if (hostCount >= stubCap) return -1;
  const copy = alloc(<u64>len + 1);
  if (!copy) return -1;
  memory.copy(copy, name, len);
  const id = hostCount++, r = hostRec(id);
  store<u32>(r, <u32>(copy - arena)); store<u32>(r, len, 4); store<u32>(r, h, 8); store<u32>(r, 0, 12);
  store<i32>(r, -1, 16); store<u32>(r, kind, 20); store<u32>(r, 0, 24);
  let j = h & hostMask;
  while (load<u32>(hostIdx + (<usize>j << 2))) j = (j + 1) & hostMask;
  store<u32>(hostIdx + (<usize>j << 2), id + 1);
  // The stub's 4 bytes: UDF #id, a permanently undefined instruction. The embedder dispatches on the address (stubId);
  // if the translator ever compiles this word, it reports unimpl(pc = the stub, insn = the id) when executed.
  store<u32>(stubBase + (<usize>id << 2), id & 0xFFFF);
  return <i32>id;
}

// The host implements `name`: kind HOST_FORCE or HOST_HLE. Returns the host function id (the stub is at stubAddr(id)),
// or ERR_ARG for a duplicate or a bad name, ERR_NOMEM when the stub region or the arena is full.
export function hostAdd(name: usize, len: u32, kind: u32): i32 {
  context(0, 0);
  if (!ready || !len || len > 4096 || !inMemory(name, len) || kind > HOST_FORCE) { red(); puts("host function: bad name or kind"); emit(); return ERR_ARG; }
  const h = fnv(name, len);
  if (hostFind(name, len, h) >= 0) { red(); puts("duplicate entry in the host function table: "); putn(name, len); emit(); return ERR_ARG; }
  const id = hostInsert(name, len, h, kind);
  if (id < 0) { red(); puts("the host stub region ("); putu(stubCap); puts(" entries) or the arena is full at "); putn(name, len); emit(); return ERR_NOMEM; }
  return id;
}
export function hostCountOf(): u32 { return hostCount; }
export function hostKind(id: u32): i32 { return id < hostCount ? <i32>load<u32>(hostRec(id), 20) : -1; }
export function hostNamePtr(id: u32): usize { return id < hostCount ? arena + <usize>load<u32>(hostRec(id)) : 0; }
export function hostNameLen(id: u32): u32 { return id < hostCount ? load<u32>(hostRec(id), 4) : 0; }
export function hostRefs(id: u32): u32 { return id < hostCount ? load<u32>(hostRec(id), 12) : 0; }
export function hostFirstModule(id: u32): i32 { return id < hostCount ? load<i32>(hostRec(id), 16) : -1; }
export function hostLookup(name: usize, len: u32): i32 { return ready && inMemory(name, len) ? hostFind(name, len, fnv(name, len)) : -1; }
export function stubRegionBase(): usize { return stubBase; }
export function stubRegionCap(): u32 { return stubCap; }
// Guest address of host function id's stub (0 for an id that does not exist), and back (-1 for an address that is no stub)
export function stubAddr(id: u32): usize { return id < hostCount ? stubBase + (<usize>id << 2) : 0; }
export function stubId(addr: u64): i32 {
  if (addr < <u64>stubBase || ((addr - <u64>stubBase) & 3)) return -1;
  const id = (addr - <u64>stubBase) >> 2;
  return id < <u64>hostCount ? <i32>id : -1;
}

function hostRef(id: u32, m: Mod): u64 {
  const r = hostRec(id);
  store<u32>(r, load<u32>(r, 12) + 1, 12);
  if (load<i32>(r, 16) < 0) store<i32>(r, <i32>m.index, 16);
  return <u64>stubBase + (<u64>id << 2);
}

// nxnative's force_check: forced take-overs that no module referred to. Each is logged red; returns how many.
// Forced names no module refers to. A table of take-overs serves every game, so most of its names are unreferenced
// by any one of them: as in nxnative, that is one summary line (`force: N entries hit, M not referenced by this
// game`) and a red line per name only when the embedder asked to be strict (forceStrict; nxnative DM_FORCE_STRICT,
// for the tests of a table against the one game it was written for). Returns M.
let strictForced: bool = false;
export function forceStrict(on: bool): void { strictForced = on; }
export function checkForced(): u32 {
  context(0, 0);
  let n: u32 = 0, hit: u32 = 0;
  for (let id: u32 = 0; id < hostCount; id++) {
    const r = hostRec(id);
    if (load<u32>(r, 20) != HOST_FORCE) continue;
    if (load<u32>(r, 12)) { hit++; continue; }
    if (strictForced) { red(); puts("forced take-over entry with no reference at all: "); putn(arena + <usize>load<u32>(r), load<u32>(r, 4)); emit(); }
    n++;
  }
  if (n && !strictForced) { info(); puts("force: "); putu(hit); puts(" entries hit, "); putu(n); puts(" not referenced by this game"); emit(); }
  return n;
}

// ---- checked access to an image (offsets from the module's base) ----
// @ts-ignore: decorator
@inline function inImage(m: Mod, off: u64, n: u64): bool { return off <= <u64>m.imageSize && n <= <u64>m.imageSize - off; }
function rd8(m: Mod, off: u64): u32 { if (!inImage(m, off, 1)) { faults++; return 0; } return load<u8>(m.base + <usize>off); }
function rd16(m: Mod, off: u64): u32 { if (!inImage(m, off, 2)) { faults++; return 0; } return load<u16>(m.base + <usize>off); }
function rd32(m: Mod, off: u64): u32 { if (!inImage(m, off, 4)) { faults++; return 0; } return load<u32>(m.base + <usize>off); }
function rd64(m: Mod, off: u64): u64 { if (!inImage(m, off, 8)) { faults++; return 0; } return load<u64>(m.base + <usize>off); }
function wr64(m: Mod, off: u64, v: u64): void { if (!inImage(m, off, 8)) { faults++; return; } store<u64>(m.base + <usize>off, v); }

// ---- symbols ----
// @ts-ignore: decorator
@inline function symOff(m: Mod, i: u32): u64 { return <u64>m.symtab + <u64>i * SYM; }
// @ts-ignore: decorator
@inline function symInfo(m: Mod, i: u32): u32 { return rd8(m, symOff(m, i) + 4); }
// @ts-ignore: decorator
@inline function symOther(m: Mod, i: u32): u32 { return rd8(m, symOff(m, i) + 5); }
// @ts-ignore: decorator
@inline function symShndx(m: Mod, i: u32): u32 { return rd16(m, symOff(m, i) + 6); }
function symAddr(m: Mod, i: u32): u64 {
  const v = rd64(m, symOff(m, i) + 8);
  return symShndx(m, i) == SHN_ABS ? v : <u64>m.base + v;
}

// The name of symbol i: nmPtr / nmLen. False when it does not end inside the string table.
let nmPtr: usize = 0, nmLen: u32 = 0;
function symName(m: Mod, i: u32): bool {
  const start = <u64>m.strtab + <u64>rd32(m, symOff(m, i));
  const end = <u64>m.strEnd;
  if (start >= end) return false;
  const p = m.base + <usize>start, cap = <usize>(end - start);
  for (let n: usize = 0; n < cap; n++) {
    if (!load<u8>(p + n)) { nmPtr = p; nmLen = <u32>n; return true; }
  }
  return false;
}

// Whether symbol i is something another module can bind to
function exported(m: Mod, i: u32): bool {
  if (!symShndx(m, i)) return false;
  const bind = symInfo(m, i) >> 4, vis = symOther(m, i) & 3;
  return (bind == STB_GLOBAL || bind == STB_WEAK) && (vis == STV_DEFAULT || vis == STV_PROTECTED);
}

// The export table: inserted in ascending index order and never overwritten, so a lookup gives the first exported
// symbol of that name, as a linear scan would (nxnative build_symhash)
function buildSymhash(m: Mod): bool {
  let cap: u32 = 16;
  while (cap < m.nsym * 2) cap <<= 1;
  if (!m.symh || m.symhCap != cap) {
    const p = alloc(<u64>cap * 4);
    if (!p) return false;
    m.symh = p; m.symhCap = cap;
  } else memory.fill(m.symh, 0, <usize>cap * 4);
  const mask = cap - 1, tab = m.symh;
  for (let i: u32 = 1; i < m.nsym; i++) {
    if (!exported(m, i) || !symName(m, i) || !nmLen) continue;
    const name = nmPtr, len = nmLen;
    for (let j = fnv(name, len) & mask; ; j = (j + 1) & mask) {
      const v = load<u32>(tab + (<usize>j << 2));
      if (!v) { store<u32>(tab + (<usize>j << 2), i); break; }
      if (symName(m, v) && nmLen == len && bytesEqual(nmPtr, name, len)) break;   // an earlier symbol has the name: it stays
    }
  }
  return true;
}

// Index of the exported symbol `name` of m, or 0. Every candidate is checked again: the guest may have written to the tables.
function moduleSym(m: Mod, name: usize, len: u32, h: u32): u32 {
  if (!m.symh) return 0;
  const mask = m.symhCap - 1, tab = m.symh;
  for (let j = h & mask, tries: u32 = 0; tries < m.symhCap; j = (j + 1) & mask, tries++) {
    const v = load<u32>(tab + (<usize>j << 2));
    if (!v) return 0;
    if (v < m.nsym && exported(m, v) && symName(m, v) && nmLen == len && bytesEqual(nmPtr, name, len)) return v;
  }
  return 0;
}

// The first definition of `name` in the mapped modules, in the order they were mapped: foundAddr / foundMod
let foundAddr: u64 = 0, foundMod: i32 = -1;
function loadedSym(name: usize, len: u32, h: u32): bool {
  for (let i: u32 = 0; i < nLoaded; i++) {
    const k = modAt(load<u32>(LOADED + (<usize>i << 2)));
    const s = moduleSym(k, name, len, h);
    if (s) { foundAddr = symAddr(k, s); foundMod = <i32>k.index; return true; }
  }
  foundMod = -1;
  return false;
}

// What a symbol relocation bound to
const BIND_ZERO: u32 = 0, BIND_SELF: u32 = 1, BIND_MODULE: u32 = 2, BIND_FORCE: u32 = 3, BIND_HLE: u32 = 4, BIND_WEAK0: u32 = 5, BIND_UNRESOLVED: u32 = 6;
let bindKind: u32 = 0;

// The address symbol si of module m binds to, as Horizon's rtld would with the modules mapped now (nxnative bind_sym):
//   1. a forced take-over of that name: the host's stub, whatever any module defines
//   2. a symbol the module defines: local or non-default visibility binds to itself; otherwise the first definition in
//      the mapped modules in load order (an earlier module's definition wins over the module's own)
//   3. an undefined symbol: the first definition in the mapped modules; else the host's weaker table; else 0 if it is
//      weak; else a stub of kind HOST_UNRESOLVED made for the name (reported by unresolved())
// The caller has checked that si is in the symbol table and has a valid name.
function bindSym(m: Mod, si: u32): u64 {
  if (!si || !symName(m, si)) { bindKind = BIND_ZERO; return 0; }
  const name = nmPtr, len = nmLen, h = fnv(name, len);
  let id = hostFind(name, len, h);
  if (id >= 0 && load<u32>(hostRec(id), 20) == HOST_FORCE) { bindKind = BIND_FORCE; return hostRef(id, m); }
  const bind = symInfo(m, si) >> 4;
  if (symShndx(m, si)) {
    const self = symAddr(m, si);
    bindKind = BIND_SELF;
    if (bind == STB_LOCAL || (symOther(m, si) & 3) != STV_DEFAULT) return self;
    if (loadedSym(name, len, h) && foundAddr != self) { bindKind = BIND_MODULE; return foundAddr; }
    return self;
  }
  if (loadedSym(name, len, h)) { bindKind = BIND_MODULE; return foundAddr; }
  if (id >= 0 && load<u32>(hostRec(id), 20) == HOST_HLE) { bindKind = BIND_HLE; return hostRef(id, m); }
  if (bind == STB_WEAK) { bindKind = BIND_WEAK0; return 0; }
  bindKind = BIND_UNRESOLVED;
  if (id < 0) {
    id = hostInsert(name, len, h, HOST_UNRESOLVED);
    if (id < 0) {
      if (!stubOverflow++) { red(); puts("the host stub region ("); putu(stubCap); puts(" entries) or the arena is full: "); putn(name, len); puts(" and later unresolved imports are bound to 0"); emit(); }
      return 0;
    }
    red(); puts("unresolved import "); putn(name, len); puts(" (no module defines it and the host does not implement it; stub "); putx(stubAddr(id)); puts(")"); emit();
  }
  return hostRef(<u32>id, m);
}
export function stubOverflowCount(): u32 { return stubOverflow; }

// ---- MOD0 and the dynamic section ----
function dynBad(what: string, v: u64): u64 { red(); puts("dynamic section: "); puts(what); puts(" ("); putx(v); puts(")"); emit(); return ModuleRefuseReason.dynamic; }

function parseDynamic(m: Mod): u64 {
  const size = <u64>m.imageSize;
  m.have = 0; m.symtab = 0; m.strtab = 0; m.strEnd = 0; m.nsym = 0; m.rela = 0; m.relaN = 0; m.jmprel = 0; m.jmprelN = 0; m.relr = 0; m.relrN = 0;
  m.init = 0; m.fini = 0; m.initArray = 0; m.initArrayN = 0; m.finiArray = 0; m.finiArrayN = 0; m.hash = 0; m.gnuHash = 0;
  if (size < 8) { red(); puts("no MOD0: the image is "); putx(size); puts(" bytes"); emit(); return ModuleRefuseReason.mod0; }
  const mod0 = <u64>rd32(m, 4);
  if (!inImage(m, mod0, 0x1C) || rd32(m, mod0) != 0x30444F4D) { red(); puts("no MOD0 header at the offset in the word at +4 ("); putx(mod0); puts(")"); emit(); return ModuleRefuseReason.mod0; }
  const dyn = mod0 + <u64><i64><i32>rd32(m, mod0 + 4);
  if (!inImage(m, dyn, 16)) { red(); puts("MOD0 puts the dynamic section outside the image ("); putx(dyn); puts(")"); emit(); return ModuleRefuseReason.mod0; }
  m.mod0 = <u32>mod0; m.dyn = <u32>dyn;
  m.bssStart = <u32>(mod0 + <u64><i64><i32>rd32(m, mod0 + 8)); m.bssEnd = <u32>(mod0 + <u64><i64><i32>rd32(m, mod0 + 12));

  let symtab: u64 = 0, strtab: u64 = 0, strsz: u64 = 0, rela: u64 = 0, relasz: u64 = 0, jmprel: u64 = 0, pltrelsz: u64 = 0, relr: u64 = 0, relrsz: u64 = 0;
  let init: u64 = 0, fini: u64 = 0, initArray: u64 = 0, initArraySz: u64 = 0, finiArray: u64 = 0, finiArraySz: u64 = 0, hash: u64 = 0, gnuHash: u64 = 0;
  let relaent: u64 = RELA, syment: u64 = SYM, relrent: u64 = 8, pltrel: u64 = DT_RELA;
  let haveSym = false, haveStr = false, have: u32 = 0, ended = false;
  for (let p = dyn; inImage(m, p, 16); p += 16) {
    const tag = rd64(m, p), v = rd64(m, p + 8);
    if (!tag) { ended = true; break; }
    if (tag == DT_SYMTAB) { symtab = v; haveSym = true; }
    else if (tag == DT_STRTAB) { strtab = v; haveStr = true; }
    else if (tag == DT_STRSZ) { strsz = v; have |= HAVE_STRSZ; }
    else if (tag == DT_RELA) rela = v;
    else if (tag == DT_RELASZ) relasz = v;
    else if (tag == DT_RELAENT) relaent = v;
    else if (tag == DT_SYMENT) syment = v;
    else if (tag == DT_JMPREL) jmprel = v;
    else if (tag == DT_PLTRELSZ) pltrelsz = v;
    else if (tag == DT_PLTREL) pltrel = v;
    else if (tag == DT_RELR) { relr = v; have |= HAVE_RELR; }
    else if (tag == DT_RELRSZ) relrsz = v;
    else if (tag == DT_RELRENT) relrent = v;
    else if (tag == DT_INIT) { init = v; have |= HAVE_INIT; }
    else if (tag == DT_FINI) { fini = v; have |= HAVE_FINI; }
    else if (tag == DT_INIT_ARRAY) initArray = v;
    else if (tag == DT_INIT_ARRAYSZ) initArraySz = v;
    else if (tag == DT_FINI_ARRAY) finiArray = v;
    else if (tag == DT_FINI_ARRAYSZ) finiArraySz = v;
    else if (tag == DT_HASH) { hash = v; have |= HAVE_HASH; }
    else if (tag == DT_GNU_HASH) { gnuHash = v; have |= HAVE_GNU_HASH; }
  }
  if (!ended) return dynBad("no DT_NULL before the end of the image", dyn);
  if (relaent != RELA) return dynBad("DT_RELAENT is not 24", relaent);
  if (syment != SYM) return dynBad("DT_SYMENT is not 24", syment);
  if (relrent != 8) return dynBad("DT_RELRENT is not 8", relrent);
  if (pltrel != DT_RELA) return dynBad("DT_PLTREL is not DT_RELA", pltrel);
  if (relasz % RELA || !inImage(m, rela, relasz)) return dynBad("DT_RELA table outside the image or not whole entries", rela);
  if (pltrelsz % RELA || !inImage(m, jmprel, pltrelsz)) return dynBad("DT_JMPREL table outside the image or not whole entries", jmprel);
  if (relrsz % 8 || !inImage(m, relr, relrsz)) return dynBad("DT_RELR table outside the image or not whole entries", relr);
  if (initArraySz % 8 || !inImage(m, initArray, initArraySz)) return dynBad("DT_INIT_ARRAY outside the image or not whole entries", initArray);
  if (finiArraySz % 8 || !inImage(m, finiArray, finiArraySz)) return dynBad("DT_FINI_ARRAY outside the image or not whole entries", finiArray);
  if ((have & HAVE_INIT) && init >= size) return dynBad("DT_INIT outside the image", init);
  if ((have & HAVE_FINI) && fini >= size) return dynBad("DT_FINI outside the image", fini);
  if (haveStr && !inImage(m, strtab, strsz)) return dynBad("DT_STRTAB outside the image", strtab);
  if (haveSym && !inImage(m, symtab, 0)) return dynBad("DT_SYMTAB outside the image", symtab);
  m.have = have;
  m.rela = <u32>rela; m.relaN = <u32>(relasz / RELA); m.jmprel = <u32>jmprel; m.jmprelN = <u32>(pltrelsz / RELA);
  m.relr = <u32>relr; m.relrN = <u32>(relrsz / 8);
  m.init = <u32>init; m.fini = <u32>fini;
  m.initArray = <u32>initArray; m.initArrayN = <u32>(initArraySz / 8); m.finiArray = <u32>finiArray; m.finiArrayN = <u32>(finiArraySz / 8);
  m.symtab = <u32>symtab; m.strtab = <u32>strtab;
  m.strEnd = haveStr ? ((have & HAVE_STRSZ) ? <u32>(strtab + strsz) : <u32>size) : 0;

  // How many symbols: DT_HASH says it (nchain); else DT_GNU_HASH's last chain; else the string table follows the symbols
  let nsym: u64 = 0;
  if (haveSym) {
    if (have & HAVE_HASH) {
      if (!inImage(m, hash, 8)) return dynBad("DT_HASH outside the image", hash);
      const nbucket = <u64>rd32(m, hash), nchain = <u64>rd32(m, hash + 4);
      if (!inImage(m, hash + 8, (nbucket + nchain) * 4)) return dynBad("DT_HASH tables outside the image", hash);
      nsym = nchain;
      m.hash = <u32>hash;
    }
    if (have & HAVE_GNU_HASH) {
      if (!inImage(m, gnuHash, 16)) return dynBad("DT_GNU_HASH outside the image", gnuHash);
      const nbuckets = <u64>rd32(m, gnuHash), symoffset = <u64>rd32(m, gnuHash + 4), bloomSize = <u64>rd32(m, gnuHash + 8);
      const buckets = gnuHash + 16 + bloomSize * 8;
      if (!inImage(m, buckets, nbuckets * 4)) return dynBad("DT_GNU_HASH tables outside the image", gnuHash);
      const chains = buckets + nbuckets * 4;
      let last: u64 = 0;
      for (let b: u64 = 0; b < nbuckets; b++) { const v = <u64>rd32(m, buckets + b * 4); if (v > last) last = v; }
      let n = symoffset;
      if (last >= symoffset) {
        for (let i = last; ; i++) {
          const c = chains + (i - symoffset) * 4;
          if (!inImage(m, c, 4)) return dynBad("DT_GNU_HASH chain runs out of the image", gnuHash);
          if (rd32(m, c) & 1) { n = i + 1; break; }
        }
      }
      if (!(have & HAVE_HASH)) nsym = n;
      m.gnuHash = <u32>gnuHash;
    }
    if (!(have & (HAVE_HASH | HAVE_GNU_HASH)) && haveStr && strtab > symtab) nsym = (strtab - symtab) / SYM;
    if (nsym > 0xFFFFFFFF || !inImage(m, symtab, nsym * SYM)) { red(); puts("the symbol table ("); putu(nsym); puts(" symbols at "); putx(symtab); puts(") runs out of the image"); emit(); return ModuleRefuseReason.symbols; }
  }
  m.nsym = <u32>nsym;
  return 0;
}

// ---- relocations ----
function relBad(what: string, i: u64, v: u64): u64 { red(); puts("relocation "); putu(i); puts(": "); puts(what); puts(" ("); putx(v); puts(")"); emit(); return ModuleRefuseReason.relocs; }

// DT_RELR: 8-byte entries; an even one is the offset of a slot (the cursor moves to the slot after it), an odd one is a
// bitmap whose bits 1-63 stand for the 63 slots at the cursor, which then moves on by 63 slots. Each slot gets += delta.
// apply = false only checks that every slot is in the image.
function relrWalk(m: Mod, apply: bool, delta: u64): u64 {
  let where: u64 = 0, started = false, n: u32 = 0;
  for (let i: u32 = 0; i < m.relrN; i++) {
    let v = rd64(m, <u64>m.relr + <u64>i * 8);
    if (!(v & 1)) {
      if (!inImage(m, v, 8)) { if (!apply) return relBad("DT_RELR slot outside the image", i, v); }
      else if (apply) wr64(m, v, rd64(m, v) + delta);
      where = v + 8; started = true; n++;
      continue;
    }
    if (!started) { if (!apply) return relBad("DT_RELR bitmap entry with no start before it", i, v); continue; }
    for (let b: u64 = 0; (v >>= 1) != 0; b++) {
      if (!(v & 1)) continue;
      const slot = where + b * 8;
      if (!inImage(m, slot, 8)) { if (!apply) return relBad("DT_RELR slot outside the image", i, slot); }
      else if (apply) wr64(m, slot, rd64(m, slot) + delta);
      n++;
    }
    where += 63 * 8;
  }
  if (apply) m.nRelr = n;
  return 0;
}

// @ts-ignore: decorator
@inline function symbolic(type: u32): bool { return type == R_ABS64 || type == R_GLOB_DAT || type == R_JUMP_SLOT; }

// Before anything is written: every relocation's slot is in the image and every symbol it names is in the symbol table
// with a name that ends in the string table. So a module is relocated completely or refused untouched.
function validateRelocs(m: Mod): u64 {
  const r = relrWalk(m, false, 0);
  if (r) return r;
  for (let t: u32 = 0; t < 2; t++) {
    const tab = <u64>(t ? m.jmprel : m.rela), n = <u64>(t ? m.jmprelN : m.relaN);
    for (let i: u64 = 0; i < n; i++) {
      const e = tab + i * RELA, off = rd64(m, e), inf = rd64(m, e + 8);
      const type = <u32>inf, si = inf >> 32;
      if (type == R_RELATIVE) { if (!inImage(m, off, 8)) return relBad("slot outside the image", i, off); continue; }
      if (!symbolic(type)) continue;
      if (!inImage(m, off, 8)) return relBad("slot outside the image", i, off);
      if (si >= <u64>m.nsym && si) return relBad("symbol index outside the symbol table", i, si);
      if (si && !symName(m, <u32>si)) return relBad("symbol name outside the string table", i, si);
    }
  }
  return 0;
}

function applyRelocs(m: Mod): void {
  const base = <u64>m.base;
  m.nRelative = 0; m.nRelr = 0; m.nAbs = 0; m.nGlob = 0; m.nJump = 0; m.nUnsupported = 0; m.nWeak0 = 0;
  relrWalk(m, true, base);
  let other: u32 = 0;
  for (let t: u32 = 0; t < 2; t++) {
    const tab = <u64>(t ? m.jmprel : m.rela), n = <u64>(t ? m.jmprelN : m.relaN);
    for (let i: u64 = 0; i < n; i++) {
      const e = tab + i * RELA, off = rd64(m, e), inf = rd64(m, e + 8), addend = rd64(m, e + 16);
      const type = <u32>inf, si = <u32>(inf >> 32);
      if (type == R_RELATIVE) { wr64(m, off, base + addend); m.nRelative++; continue; }
      if (!symbolic(type)) {
        if (type != R_NONE && m.nUnsupported++ < 8) { red(); puts("relocation "); putu(i); puts(" of type "); putu(type); puts(" is not supported and was left alone (slot "); putx(off); puts(")"); emit(); }
        continue;
      }
      if (si >= m.nsym && si) continue;   // validated before; the guest cannot have changed it yet
      const v = bindSym(m, si);
      if (bindKind == BIND_MODULE && symShndx(m, si)) other++;
      if (bindKind == BIND_WEAK0) m.nWeak0++;
      if (type == R_JUMP_SLOT) { wr64(m, off, v); m.nJump++; }
      else { wr64(m, off, v + addend); if (type == R_ABS64) m.nAbs++; else m.nGlob++; }
    }
  }
  info(); puts("reloc relative="); putu(m.nRelative); puts(" relr="); putu(m.nRelr); puts(" abs="); putu(m.nAbs); puts(" glob="); putu(m.nGlob);
  puts(" jump="); putu(m.nJump);
  if (m.nWeak0) { puts(", "); putu(m.nWeak0); puts(" undefined weak bound to 0"); }
  if (other) { puts(", "); putu(other); puts(" bound to an earlier module's definition"); }
  emit();
}

// Bind the symbol relocations of module k again (nxnative rebind): with load, those of undefined symbols that nm
// defines; without, those whose slot points into nm, which is leaving. Returns how many slots changed.
// k may have been running: every entry is checked again and a damaged one is skipped.
function rebind(k: Mod, nm: Mod, load_: bool): u32 {
  const lo = <u64>nm.base, hi = lo + <u64>nm.imageSize;
  let changed: u32 = 0;
  for (let t: u32 = 0; t < 2; t++) {
    const tab = <u64>(t ? k.jmprel : k.rela), n = <u64>(t ? k.jmprelN : k.relaN);
    for (let i: u64 = 0; i < n; i++) {
      const e = tab + i * RELA, off = rd64(k, e), inf = rd64(k, e + 8);
      const type = <u32>inf, si = <u32>(inf >> 32);
      if (!symbolic(type) || !inImage(k, off, 8) || !si || si >= k.nsym || !symName(k, si)) continue;
      const add = type == R_JUMP_SLOT ? 0 : rd64(k, e + 16), cur = rd64(k, off) - add;
      if (load_) { if (symShndx(k, si) || !moduleSym(nm, nmPtr, nmLen, fnv(nmPtr, nmLen))) continue; }
      else if (!(cur >= lo && cur < hi)) continue;
      const v = bindSym(k, si);
      if (v != cur) { wr64(k, off, v + add); changed++; }
    }
  }
  return changed;
}

// ---- the lifecycle ----
// Refused is final: the record lets go of the file
function refuse(m: Mod, reason: u64): i32 {
  if (m.inst.step(ModuleE.Refuse, reason)) { m.file = 0; m.fileLen = 0; }
  return ERR_REFUSED;
}

// A new module from the file [file, file + len), which must stay where it is, unchanged, until the module is pinned or
// refused: it is what every map reads. Returns the module's handle, or ERR_ARG / ERR_NOMEM when no record was made.
// The header is validated here; a file that fails is in state Refused (the handle is still returned: ask state()).
export function parse(file: usize, len: u32, opts: u32): i32 {
  context(0, 0);
  if (!ready) { red(); puts("parse before init"); emit(); return ERR_ARG; }
  if (!file || !inMemory(file, len)) { red(); puts("parse: the file is not in linear memory"); emit(); return ERR_ARG; }
  if (nMods >= MAX_MODULES) { red(); puts("parse: more than "); putu(MAX_MODULES); puts(" modules"); emit(); return ERR_NOMEM; }
  const p = alloc(offsetof<Mod>());
  if (!p) { red(); puts("parse: the arena is full"); emit(); return ERR_NOMEM; }
  const m = changetype<Mod>(p), h = nMods++;
  store<usize>(MODS + (<usize>h << 3), p);
  m.index = h;
  // default name: "module<h>"
  const nm = m.namePtr;
  store<u8>(nm, 109); store<u8>(nm, 111, 1); store<u8>(nm, 100, 2);
  let l: u32 = 3;
  if (h >= 1000) store<u8>(nm + l++, <u8>(48 + h / 1000 % 10));
  if (h >= 100) store<u8>(nm + l++, <u8>(48 + h / 100 % 10));
  if (h >= 10) store<u8>(nm + l++, <u8>(48 + h / 10 % 10));
  store<u8>(nm + l++, <u8>(48 + h % 10));
  m.nameLen = l;
  context(nm, l);
  m.inst.init(MODULE, h);
  const reason = parseHeader(m, file, len, opts);
  if (reason) refuse(m, reason);
  else m.inst.step(ModuleE.ParseOk);
  return <i32>h;
}

// The module's name in the log (at most 32 bytes are kept)
export function setName(h: i32, name: usize, len: u32): i32 {
  const m = modOf(h);
  if (!changetype<usize>(m) || !inMemory(name, len)) return ERR_ARG;
  if (len > 32) len = 32;
  memory.copy(m.namePtr, name, len);
  m.nameLen = len;
  return OK;
}

// Map the module at guest address base: Parsed -> Mapped, or again Unloaded -> Mapped. The whole image is written from
// the file (so a reload restores the data) and the bss is zero. The module joins the symbol lookups, last in the order.
// ERR_ARG (nothing changed) when base is not a free, page-aligned range of linear memory for the image.
export function map(h: i32, base: usize): i32 {
  const m = modOf(h);
  if (!changetype<usize>(m)) return ERR_ARG;
  if (!m.inst.can(ModuleE.Map)) { m.inst.step(ModuleE.Map); return ERR_STATE; }
  const size = <u64>m.imageSize;
  if (<u64>base % PAGE || base < __heap_base || !inMemory(base, size)) {
    red(); puts("map: base "); putx(base); puts(" is not a page-aligned range of "); putx(size); puts(" bytes in linear memory ("); putx(memBytes()); puts(" bytes)"); emit();
    return ERR_ARG;
  }
  let clash = overlaps(base, size, arena, arenaEnd - arena) || overlaps(base, size, stubBase, <u64>stubCap * 4);
  for (let i: u32 = 0; i < nMods && !clash; i++) {
    const k = modAt(i);
    if (k.file && overlaps(base, size, k.file, k.fileLen)) clash = true;
    if (k != m && k.mapped && overlaps(base, size, k.base, k.imageSize)) clash = true;
  }
  if (clash) { red(); puts("map: "); putx(base); puts(".."); putx(<u64>base + size); puts(" overlaps the arena, the stub region, a module's file or a mapped module"); emit(); return ERR_ARG; }
  m.base = base;
  let reason = loadSegments(m, base);
  if (!reason) reason = parseDynamic(m);
  if (!reason) reason = validateRelocs(m);
  if (!reason && !buildSymhash(m)) { red(); puts("the arena is full (export table of "); putu(m.nsym); puts(" symbols)"); emit(); reason = ModuleRefuseReason.arena; }
  if (reason) return refuse(m, reason);
  m.inst.step(ModuleE.Map);
  store<u32>(LOADED + (<usize>nLoaded << 2), m.index);
  nLoaded++;
  m.mapSeq = ++seq;
  return OK;
}

// Apply the module's relocations against the modules mapped now: Mapped -> Relocated. Then the modules relocated before
// this one was mapped get their imports that this one defines (an NRO loaded at run time). Map every module of a set
// first, then relocate each: a module relocated before its provider is mapped has those imports reported unresolved
// until the provider is relocated.
export function relocate(h: i32): i32 {
  const m = modOf(h);
  if (!changetype<usize>(m)) return ERR_ARG;
  if (!m.inst.can(ModuleE.Relocate)) { m.inst.step(ModuleE.Relocate); return ERR_STATE; }
  applyRelocs(m);
  m.inst.step(ModuleE.Relocate);
  m.relocSeq = ++seq;
  m.loads++;
  let n: u32 = 0, any = false;
  for (let i: u32 = 0; i < nLoaded; i++) {
    const k = modAt(load<u32>(LOADED + (<usize>i << 2)));
    if (k != m && k.relocated && k.relocSeq < m.mapSeq) { context(k.namePtr, k.nameLen); n += rebind(k, m, true); any = true; }
  }
  context(m.namePtr, m.nameLen);
  if (any) { info(); puts("load "); putu(m.loads); puts(": "); putu(n); puts(" imports of the modules loaded before bound to it"); emit(); }
  return OK;
}

// The embedder has run the module's init functions: Relocated -> Active
export function activate(h: i32): i32 {
  const m = modOf(h);
  if (!changetype<usize>(m)) return ERR_ARG;
  return m.inst.step(ModuleE.Activate) ? OK : ERR_STATE;
}

// The module stays for good: Active -> Pinned, or Relocated -> Pinned (a module of the process's start set, which is
// never unloaded: its file is let go of before its init functions run). The loader forgets the file, whose memory the
// embedder may now reuse.
export function pin(h: i32): i32 {
  const m = modOf(h);
  if (!changetype<usize>(m)) return ERR_ARG;
  if (!m.inst.step(ModuleE.Pin)) return ERR_STATE;
  m.file = 0; m.fileLen = 0;
  return OK;
}

// Take the module out of the lookups and bind again what pointed into it: -> Unloaded. Its memory is the embedder's again.
export function unload(h: i32): i32 {
  const m = modOf(h);
  if (!changetype<usize>(m)) return ERR_ARG;
  if (!m.inst.can(ModuleE.Unload)) { m.inst.step(ModuleE.Unload); return ERR_STATE; }
  for (let i: u32 = 0; i < nLoaded; i++) {
    if (load<u32>(LOADED + (<usize>i << 2)) == m.index) {
      memory.copy(LOADED + (<usize>i << 2), LOADED + (<usize>(i + 1) << 2), <usize>(nLoaded - i - 1) << 2);
      nLoaded--;
      break;
    }
  }
  m.inst.step(ModuleE.Unload);
  let n: u32 = 0;
  for (let i: u32 = 0; i < nLoaded; i++) {
    const k = modAt(load<u32>(LOADED + (<usize>i << 2)));
    if (k.relocated) { context(k.namePtr, k.nameLen); n += rebind(k, m, false); }
  }
  context(m.namePtr, m.nameLen);
  info(); puts("unloaded: "); putu(n); puts(" imports that pointed into it bound again"); emit();
  return OK;
}

export function state(h: i32): i32 { return ready && <u32>h < nMods ? <i32>modAt(<u32>h).state : -1; }

// ---- queries ----
// Guest address of the first exported symbol `name` in the mapped modules, in load order; 0 when there is none
// (lookupModule() then gives -1, otherwise the handle of the module that defines it). The host table is not consulted.
let lookupMod: i32 = -1;
export function lookup(name: usize, len: u32): u64 {
  lookupMod = -1;
  if (!ready || !inMemory(name, len) || !loadedSym(name, len, fnv(name, len))) return 0;
  lookupMod = foundMod;
  return foundAddr;
}
export function lookupModule(): i32 { return lookupMod; }
// The same in one module (any mapped state)
export function lookupIn(h: i32, name: usize, len: u32): u64 {
  lookupMod = -1;
  if (!ready || <u32>h >= nMods || !inMemory(name, len)) return 0;
  const m = modAt(<u32>h);
  if (!m.mapped) return 0;
  const s = moduleSym(m, name, len, fnv(name, len));
  if (!s) return 0;
  lookupMod = h;
  return symAddr(m, s);
}

// The imports of module h that are bound to an unresolved stub right now: their host function ids (each once) are
// written as u32 to out, at most cap; returns how many there are.
let markSerial: u32 = 0;
export function unresolved(h: i32, out: usize, cap: u32): i32 {
  const m = modOf(h);
  if (!changetype<usize>(m) || !inMemory(out, <u64>cap * 4)) return ERR_ARG;
  if (!m.relocated) return 0;
  const mark = ++markSerial;
  let count: u32 = 0;
  for (let t: u32 = 0; t < 2; t++) {
    const tab = <u64>(t ? m.jmprel : m.rela), n = <u64>(t ? m.jmprelN : m.relaN);
    for (let i: u64 = 0; i < n; i++) {
      const e = tab + i * RELA, off = rd64(m, e), type = <u32>rd64(m, e + 8);
      if (!symbolic(type) || !inImage(m, off, 8)) continue;
      const id = stubId(rd64(m, off) - (type == R_JUMP_SLOT ? 0 : rd64(m, e + 16)));
      if (id < 0) continue;
      const r = hostRec(<u32>id);
      if (load<u32>(r, 20) != HOST_UNRESOLVED || load<u32>(r, 24) == mark) continue;
      store<u32>(r, mark, 24);
      if (count < cap) store<u32>(out + (<usize>count << 2), <u32>id);
      count++;
    }
  }
  return <i32>count;
}

// The function entries the loader knows of a relocated module, for a translator: defined dynamic symbols of type
// FUNC, DT_INIT / DT_FINI, the init and fini arrays, and every relative relocation (RELA and RELR) whose value points
// into the text. Their offsets from the module's base (u32: an image is below 4 GB whatever its address; 4-byte aligned,
// inside the text; not deduplicated) are written to out, at most cap; returns how many there are.
// The function symbol of module h that holds addr, for a fault report: the defined function symbol with the highest
// value <= addr inside the module's text whose size reaches past addr (or that has no size). Writes to out (32 bytes):
// +0 value u64 (guest address), +8 size u64, +16 name pointer u64, +24 name length u32. Returns its index, -1 none.
export function symbolAt(h: i32, addr: u64, out: usize): i32 {
  if (<u32>h >= nMods) return -1;
  const m = modOf(h);
  if (!changetype<usize>(m) || !inMemory(out, 32) || !m.relocated) return -1;
  const lo = <u64>m.base + <u64>m.mo0, hi = lo + <u64>m.sz0;
  if (addr < lo || addr >= hi) return -1;
  let best: i32 = -1, bestV: u64 = 0;
  for (let i: u32 = 1; i < m.nsym; i++) {
    if ((symInfo(m, i) & 15) != 2 || !symShndx(m, i) || symShndx(m, i) == SHN_ABS) continue;
    const v = symAddr(m, i), size = rd64(m, symOff(m, i) + 16);
    if (v > addr || v < lo || (best >= 0 && v <= bestV)) continue;
    if (size && addr - v >= size) continue;
    best = <i32>i; bestV = v;
  }
  if (best < 0 || !symName(m, <u32>best)) return -1;
  store<u64>(out, bestV, 0); store<u64>(out, rd64(m, symOff(m, <u32>best) + 16), 8); store<u64>(out, <u64>nmPtr, 16); store<u32>(out, nmLen, 24);
  return best;
}
export function codeEntries(h: i32, out: usize, cap: u32): i32 {
  const m = modOf(h);
  if (!changetype<usize>(m) || !inMemory(out, <u64>cap * 4)) return ERR_ARG;
  if (!m.relocated) return 0;
  const base = <u64>m.base, lo = base + <u64>m.mo0, hi = lo + <u64>m.sz0;
  let count: u32 = 0;
  for (let pass: u32 = 0; pass < 5; pass++) {
    let n: u64 = 0;
    if (pass == 0) n = m.nsym; else if (pass == 1) n = m.relaN; else if (pass == 2) n = m.relrN; else if (pass == 3) n = <u64>m.initArrayN + <u64>m.finiArrayN; else n = 2;
    let where: u64 = 0, started = false;
    for (let i: u64 = 0; i < n; i++) {
      let v: u64 = 0, bits: u64 = 0;
      if (pass == 0) { if (!i || (symInfo(m, <u32>i) & 15) != 2 || !symShndx(m, <u32>i) || symShndx(m, <u32>i) == SHN_ABS) continue; v = symAddr(m, <u32>i); }
      else if (pass == 1) { const e = <u64>m.rela + i * RELA; if (<u32>rd64(m, e + 8) != R_RELATIVE) continue; v = base + rd64(m, e + 16); }
      else if (pass == 2) {
        const e = rd64(m, <u64>m.relr + i * 8);
        if (!(e & 1)) { v = rd64(m, e); where = e + 8; started = true; }
        else { if (!started) continue; bits = e; }
      }
      else if (pass == 3) v = i < <u64>m.initArrayN ? rd64(m, <u64>m.initArray + i * 8) : rd64(m, <u64>m.finiArray + (i - <u64>m.initArrayN) * 8);
      else { if (!(m.have & (i ? HAVE_FINI : HAVE_INIT))) continue; v = base + <u64>(i ? m.fini : m.init); }
      for (let b: u64 = 0; ; b++) {
        if (bits) { bits >>= 1; if (!bits) break; if (!(bits & 1)) continue; v = rd64(m, where + b * 8); }
        if (v >= lo && v < hi && !(v & 3)) { if (count < cap) store<u32>(out + (<usize>count << 2), <u32>(v - base)); count++; }
        if (!bits) break;
      }
      if (pass == 2 && (rd64(m, <u64>m.relr + i * 8) & 1) && started) where += 63 * 8;
    }
  }
  return <i32>count;
}

// Facts about a module. Addresses are guest addresses (0 when the module has no such thing or is not mapped).
export namespace Info {
  export const Kind: u32 = 0;             // 1 NSO, 2 NRO
  export const Base: u32 = 1;
  export const ImageSize: u32 = 2;        // bss included, whole pages
  export const Entry: u32 = 3;            // = Base: a module starts at its first instruction
  export const TextOff: u32 = 4; export const TextSize: u32 = 5;
  export const RoOff: u32 = 6; export const RoSize: u32 = 7;
  export const DataOff: u32 = 8; export const DataSize: u32 = 9;
  export const BssSize: u32 = 10;
  export const Flags: u32 = 11;           // the NSO header's flags
  export const BuildIdPtr: u32 = 12;      // 32 bytes in the loader's memory
  export const Mod0: u32 = 13; export const Dynamic: u32 = 14;
  export const Init: u32 = 15; export const Fini: u32 = 16;               // DT_INIT / DT_FINI
  export const InitArray: u32 = 17; export const InitArrayCount: u32 = 18;
  export const FiniArray: u32 = 19; export const FiniArrayCount: u32 = 20;
  export const SymbolCount: u32 = 21;
  export const HasHash: u32 = 22; export const HasGnuHash: u32 = 23; export const HasRelr: u32 = 24;
  export const RelRelative: u32 = 25; export const RelRelr: u32 = 26; export const RelAbs64: u32 = 27;
  export const RelGlobDat: u32 = 28; export const RelJumpSlot: u32 = 29; export const RelUnsupported: u32 = 30; export const RelWeakZero: u32 = 31;
  export const Loads: u32 = 32;           // how many times it was relocated
  export const RefuseReason: u32 = 33;    // ModuleRefuseReason, 0 when not refused
  export const NamePtr: u32 = 34; export const NameLen: u32 = 35;
  export const FilePtr: u32 = 36;         // 0 once pinned
  export const Mod0BssStart: u32 = 37; export const Mod0BssEnd: u32 = 38;   // image offsets, as MOD0 has them
}

export function get(h: i32, what: u32): usize {
  if (!ready || <u32>h >= nMods) return 0;
  const m = modAt(<u32>h), on = m.mapped, b = m.base;
  switch (what) {
    case Info.Kind: return m.kind;
    case Info.Base: return on ? b : 0;
    case Info.ImageSize: return m.imageSize;
    case Info.Entry: return on ? b : 0;
    case Info.TextOff: return m.mo0; case Info.TextSize: return m.sz0;
    case Info.RoOff: return m.mo1; case Info.RoSize: return m.sz1;
    case Info.DataOff: return m.mo2; case Info.DataSize: return m.sz2;
    case Info.BssSize: return m.bss;
    case Info.Flags: return m.flags;
    case Info.BuildIdPtr: return m.buildIdPtr();
    case Info.Mod0: return on ? b + m.mod0 : 0;
    case Info.Dynamic: return on ? b + m.dyn : 0;
    case Info.Init: return on && (m.have & HAVE_INIT) ? b + m.init : 0;
    case Info.Fini: return on && (m.have & HAVE_FINI) ? b + m.fini : 0;
    case Info.InitArray: return on && m.initArrayN ? b + m.initArray : 0;
    case Info.InitArrayCount: return on ? <usize>m.initArrayN : 0;
    case Info.FiniArray: return on && m.finiArrayN ? b + m.finiArray : 0;
    case Info.FiniArrayCount: return on ? <usize>m.finiArrayN : 0;
    case Info.SymbolCount: return on ? <usize>m.nsym : 0;
    case Info.HasHash: return on && (m.have & HAVE_HASH) ? 1 : 0;
    case Info.HasGnuHash: return on && (m.have & HAVE_GNU_HASH) ? 1 : 0;
    case Info.HasRelr: return on && (m.have & HAVE_RELR) ? 1 : 0;
    case Info.RelRelative: return m.nRelative; case Info.RelRelr: return m.nRelr; case Info.RelAbs64: return m.nAbs;
    case Info.RelGlobDat: return m.nGlob; case Info.RelJumpSlot: return m.nJump; case Info.RelUnsupported: return m.nUnsupported;
    case Info.RelWeakZero: return m.nWeak0;
    case Info.Loads: return m.loads;
    case Info.RefuseReason: return m.state == ModuleS.Refused ? <usize><u32>m.inst.data : 0;
    case Info.NamePtr: return m.namePtr; case Info.NameLen: return m.nameLen;
    case Info.FilePtr: return m.file;
    case Info.Mod0BssStart: return on ? <usize>m.bssStart : 0; case Info.Mod0BssEnd: return on ? <usize>m.bssEnd : 0;
  }
  return 0;
}
