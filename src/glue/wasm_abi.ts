// nxweb glue: the one place where an address crosses between JavaScript and an AssemblyScript module.
//
// The convention (docs/CONTRACT.md, "Addresses"): in the glue an address or a size of memory is a JavaScript number,
// never negative, exact up to 2^53; it is never passed through a 32-bit operator. An AssemblyScript module holds it
// as usize: i32 in the build for a 32-bit memory, i64 in the build for a 64-bit one (tools/asc64). Each binary
// carries a table of which parameters and results of its exports and imports are usize (custom section "nx.abi",
// written by tools/asc64/abi.mjs from the difference of the two builds), and `instantiate` adapts exactly those:
//   wasm64   export parameter: BigInt(n)       export result: Number(v)       import parameter: Number(v)   import result: BigInt(n)
//   wasm32   export parameter: as it is (i32)  export result: v >>> 0         import parameter: v >>> 0     import result: as it is
// A u64 of the source (a guest register, a time, a 64-bit size the ABI fixes) is a BigInt on both sides in both
// modes and is not touched here. Functions without an address in their signature are handed through unwrapped.
export interface Abi { v: number; m: 32 | 64; exports: Record<string, string>; imports: Record<string, string> }
export const ABI_SECTION = "nx.abi";

const tables = new WeakMap<WebAssembly.Module, Abi | null>();
export function abiOf(module: WebAssembly.Module): Abi | null {
  let t = tables.get(module);
  if (t === undefined) {
    const s = WebAssembly.Module.customSections(module, ABI_SECTION);
    t = s.length ? JSON.parse(new TextDecoder().decode(s[s.length - 1])) as Abi : null;
    tables.set(module, t);
  }
  return t;
}
// 32 or 64: the linear memory the binary was built for; 0 when it carries no table
export function addrBits(module: WebAssembly.Module): 0 | 32 | 64 { return abiOf(module)?.m ?? 0; }

type Fn = (...a: any[]) => any;
const same = (v: any) => v;
const toBig = (v: any) => BigInt(v ?? 0);
const toNum = (v: any) => Number(BigInt.asUintN(64, v));
const toU32 = (v: any) => v >>> 0;
function adapt(f: Fn, sig: string, cp: Fn, cr: Fn): Fn {
  const [ps, rs] = sig.split(">"), c = Array.from(ps, ch => ch === "p" ? cp : same), r = rs === "p" ? cr : same;
  if (!c.includes(cp) && r === same) return f;
  const [c0, c1, c2, c3, c4, c5] = c;
  switch (c.length) {
    case 0: return () => r(f());
    case 1: return a => r(f(c0(a)));
    case 2: return (a, b) => r(f(c0(a), c1(b)));
    case 3: return (a, b, d) => r(f(c0(a), c1(b), c2(d)));
    case 4: return (a, b, d, e) => r(f(c0(a), c1(b), c2(d), c3(e)));
    case 5: return (a, b, d, e, g) => r(f(c0(a), c1(b), c2(d), c3(e), c4(g)));
    case 6: return (a, b, d, e, g, h) => r(f(c0(a), c1(b), c2(d), c3(e), c4(g), c5(h)));
  }
  return (...a) => { for (let i = 0; i < c.length; i++) a[i] = c[i](a[i]); return r(f(...a)); };
}

// new WebAssembly.Instance(module, imports).exports with every address a number on this side. `mem64`: what the
// caller's memory is; a binary built for the other kind is refused by name.
export function instantiate<T = any>(module: WebAssembly.Module, imports: Record<string, Record<string, unknown>>, o: { mem64?: boolean; name?: string } = {}): T {
  const abi = abiOf(module);
  if (!abi) {
    if (o.mem64) throw new Error(`${o.name ?? "a module"} carries no address table (nx.abi): it was not built by tools/asc64/abi.mjs and cannot be used on a 64-bit memory`);
    return new WebAssembly.Instance(module, imports as WebAssembly.Imports).exports as T;   // a plain wasm32 binary: as before
  }
  if (o.mem64 !== undefined && (abi.m === 64) !== o.mem64)
    throw new Error(`${o.name ?? "a module"} is the build for a ${abi.m}-bit memory, the memory here is a ${o.mem64 ? 64 : 32}-bit one`);
  const m64 = abi.m === 64;
  const imp: Record<string, Record<string, unknown>> = {};
  for (const [mod, fields] of Object.entries(imports)) {
    imp[mod] = { ...fields };
    for (const [name, v] of Object.entries(fields)) {
      const sig = abi.imports[mod + "." + name];
      if (sig && typeof v === "function") imp[mod][name] = m64 ? adapt(v as Fn, sig, toNum, toBig) : adapt(v as Fn, sig, toU32, same);
    }
  }
  const raw = new WebAssembly.Instance(module, imp as WebAssembly.Imports).exports as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(raw)) {
    const sig = abi.exports[name];
    out[name] = sig && typeof v === "function" ? (m64 ? adapt(v as Fn, sig, toBig, toNum) : adapt(v as Fn, sig, same, toU32)) : v;
  }
  return out as T;
}
