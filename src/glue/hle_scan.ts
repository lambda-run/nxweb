// The take-over scan of the prepare step's Code stage: which SDK functions a game's modules define or import that
// nxnative replaces by name and nxweb does not answer (src/hle/gen/coverage.ts, made by tools/hle_coverage.py).
// Read from each module's dynamic symbol table before the game runs; the module, the demangled name and the
// nxnative file only. No Node or DOM API: the page and `npm run prepare:scan` share it.
import { NOT_ANSWERED, COVERAGE_KEY } from "../hle/gen/coverage.ts";

export const HLE_SCAN_FORMAT = 1;
export const HLE_SCAN_KEY = `${HLE_SCAN_FORMAT}:${COVERAGE_KEY}`;   // in the Code stage's input hash

export interface DynSymbol { name: string; defined: boolean }
export interface HleGap {
  module: string;
  name: string;          // mangled, as the module names it
  demangled: string;
  file: string;          // nxnative's, under dm/ (comma separated when several register it)
  forced: boolean;       // HLE_FORCE: nxnative replaces it even where a module defines it
  defined: boolean;      // the module defines it (else imports it)
}

const DT_HASH = 4, DT_STRTAB = 5, DT_SYMTAB = 6, DT_STRSZ = 10, DT_GNU_HASH = 0x6ffffef5;
const SYM_MAX = 1 << 20;

// The named symbols of an unpacked module image (the word at +4 leads to MOD0, MOD0 to the dynamic table); empty
// when it has none or its tables lie outside the image. The count from DT_HASH, DT_GNU_HASH, or the space between the
// symbol table and the strings, as the loader does (src/loader/module.ts).
export function dynSymbols(image: Uint8Array): DynSymbol[] {
  const n = image.length, dv = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const u32 = (o: number) => o >= 0 && o + 4 <= n ? dv.getUint32(o, true) : -1;
  if (n < 8) return [];
  const mod0 = u32(4);
  if (mod0 < 0 || u32(mod0) !== 0x30444F4D) return [];
  const dyn = mod0 + dv.getInt32(mod0 + 4, true);
  const tags = new Map<number, number>();
  for (let o = dyn; o >= 0 && o + 16 <= n; o += 16) {
    const tag = Number(dv.getBigInt64(o, true)), val = Number(dv.getBigUint64(o + 8, true));
    if (tag === 0) break;
    if (!tags.has(tag)) tags.set(tag, val);
  }
  const sym = tags.get(DT_SYMTAB), str = tags.get(DT_STRTAB);
  if (sym === undefined || str === undefined || sym >= n || str >= n) return [];
  const strEnd = Math.min(n, str + (tags.get(DT_STRSZ) ?? n));
  let count = -1;
  const hash = tags.get(DT_HASH), gnu = tags.get(DT_GNU_HASH);
  if (hash !== undefined) count = u32(hash + 4);
  else if (gnu !== undefined && u32(gnu) >= 0) {
    const nb = u32(gnu), base = u32(gnu + 4), bloom = u32(gnu + 8), buckets = gnu + 16 + 8 * bloom, chains = buckets + 4 * nb;
    let top = 0;
    for (let i = 0; i < nb; i++) top = Math.max(top, u32(buckets + 4 * i));
    if (top >= base) { while (top - base < SYM_MAX && u32(chains + 4 * (top - base)) >= 0 && !(u32(chains + 4 * (top - base)) & 1)) top++; count = top + 1; }
    else count = base;
  }
  if (count < 0) count = str > sym ? Math.floor((str - sym) / 24) : 0;
  count = Math.min(count, SYM_MAX, Math.floor((n - sym) / 24));
  const out: DynSymbol[] = [], td = new TextDecoder();
  for (let i = 1; i < count; i++) {
    const e: number = sym + 24 * i, at: number = str + dv.getUint32(e, true);
    if (at === str || at >= strEnd) continue;
    let z = at;
    while (z < strEnd && image[z] !== 0) z++;
    out.push({ name: td.decode(image.slice(at, z)), defined: dv.getUint16(e + 6, true) !== 0 });
  }
  return out;
}

let table: Map<string, readonly [string, string, string, number]> | null = null;
const notAnswered = () => table ??= new Map(NOT_ANSWERED.map(e => [e[0], e]));

// The symbols of one module that are on the list: what the Code stage keeps
export function takeOverSymbols(symbols: DynSymbol[]): DynSymbol[] {
  const t = notAnswered(), seen = new Set<string>();
  return symbols.filter(s => t.has(s.name) && !seen.has(s.name + (s.defined ? "+" : "-")) && !!seen.add(s.name + (s.defined ? "+" : "-")));
}

// The gaps of a game: an HLE_FORCE name wherever a module defines or imports it; an HLE name (and the GL / Vulkan
// tables) where a module imports it and none of the game's modules defines it, as nxnative's loader takes it over
export function hleGaps(modules: { module: string; symbols: DynSymbol[] }[]): HleGap[] {
  const t = notAnswered(), definedSomewhere = new Set<string>();
  for (const m of modules) for (const s of m.symbols) if (s.defined) definedSomewhere.add(s.name);
  const out: HleGap[] = [];
  for (const m of modules) {
    const mine = new Map<string, boolean>();
    for (const s of m.symbols) if (t.has(s.name)) mine.set(s.name, (mine.get(s.name) ?? false) || s.defined);
    for (const [name, defined] of mine) {
      const [, demangled, file, forced] = t.get(name)!;
      if (forced || (!defined && !definedSomewhere.has(name))) out.push({ module: m.module, name, demangled, file, forced: !!forced, defined });
    }
  }
  return out.sort((a, b) => a.module < b.module ? -1 : a.module > b.module ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.demangled < b.demangled ? -1 : a.demangled > b.demangled ? 1 : 0);
}

// "N SDK functions nxnative replaces are not answered here yet", or "" when there is none
export function hleHeadline(gaps: HleGap[]): string {
  const n = new Set(gaps.map(g => g.name)).size;
  return n ? `${n} SDK function${n === 1 ? "" : "s"} nxnative replaces ${n === 1 ? "is" : "are"} not answered here yet` : "";
}

// The table: module, how it has the name, the demangled name, nxnative's file; `max` rows, then a count of the rest
export function hleLines(gaps: HleGap[], max = Infinity): string[] {
  if (!gaps.length) return [];
  const wm = Math.max(6, ...gaps.map(g => g.module.length)), wf = Math.max(13, ...gaps.map(g => g.file.length + 3));
  const row = (m: string, how: string, f: string, d: string) => `${m.padEnd(wm)}  ${how.padEnd(7)}  ${f.padEnd(wf)}  ${d}`;
  const lines = [row("module", "", "nxnative file", "function")];
  for (const g of gaps.slice(0, max)) lines.push(row(g.module, g.defined ? "defines" : "imports", "dm/" + g.file.split(",").join(", dm/"), g.demangled));
  if (gaps.length > max) lines.push(`... and ${gaps.length - max} more`);
  return lines;
}
