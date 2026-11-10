// EXPERIMENTAL (spike, see SPIKE.md). Not part of the product build.
//
// mtify: make an AssemblyScript module instantiable once per Worker over ONE shared memory.
//
// An AssemblyScript module keeps its module-level `let` variables in mutable WebAssembly globals. Globals belong to an
// instance, so two instances of kernel.wasm on the same memory would share the thread table (memory) but each have
// its own `stopReason`, `seq`, `hostNow`, `heapCur` ... (globals). This pass moves every mutable global into linear
// memory at `area` (8 bytes each), by rewriting the module's text form:
//     (global.get $g)        ->  (T.load  (i32.const addr))
//     (global.set $g <expr>) ->  (T.store (i32.const addr) <expr>)
// and it produces two binaries:
//   primary    data segments + the globals' initial values as one more data segment + the start function:
//              instantiated by exactly one Worker, first
//   secondary  the same code with no data segments and no start function: every other Worker (instantiating it
//              must not write the static data again; that would wipe the first instance's state)
// Accesses are plain loads and stores: every use is under the module's own lock (kernel: kLock; translator: the
// translate lock of a64mt.ts).
import binaryen from "binaryen";

export interface MtResult { primary: Uint8Array; secondary: Uint8Array; globals: { name: string; type: string; addr: number; init: string }[] }

export function mtify(wasm: Uint8Array, area: number, areaBytes = 4096, keep: (name: string) => boolean = () => false): MtResult {
  // the folded text form (binaryen's default printing of a parsed binary): an operator's operands follow it inside its
  // parentheses, so a global.set becomes a store by replacing its head only
  const src = binaryen.readBinary(wasm);
  src.setFeatures(binaryen.Features.All);
  const wat = src.emitText();
  src.dispose();
  const globals: MtResult["globals"] = [];
  const re = /^ \(global (\$\S+) \(mut (i32|i64|f32|f64)\) \((?:i32|i64|f32|f64)\.const ([^)]+)\)\)$/gm;
  let addr = area;
  for (let m; (m = re.exec(wat));) {
    if (keep(m[1])) continue;
    globals.push({ name: m[1], type: m[2], addr, init: m[3] });
    addr += 8;
  }
  if (addr > area + areaBytes) throw new Error(`mtify: ${globals.length} globals do not fit in ${areaBytes} bytes`);
  if (/\(global \$\S+ \(mut v128\)/.test(wat)) throw new Error("mtify: a mutable v128 global");
  const byName = new Map(globals.map(g => [g.name, g]));
  let out = wat.replace(/\(global\.get (\$[^\s)]+)\)/g, (all, n) => { const g = byName.get(n); return g ? `(${g.type}.load (i32.const ${g.addr}))` : all; });
  out = out.replace(/\(global\.set (\$[^\s)]+)/g, (all, n) => { const g = byName.get(n); return g ? `(${g.type}.store (i32.const ${g.addr})` : all; });
  // initial values: one data segment (little endian), only in the primary
  const buf = new Uint8Array(addr - area), dv = new DataView(buf.buffer);
  for (const g of globals) {
    const o = g.addr - area;
    if (g.type === "i32") dv.setInt32(o, Number(g.init) | 0, true);
    else if (g.type === "i64") dv.setBigInt64(o, BigInt.asIntN(64, BigInt(g.init)), true);
    else if (g.type === "f32") dv.setFloat32(o, Number(g.init), true);
    else dv.setFloat64(o, Number(g.init), true);
  }
  if (buf.length) {
    const esc = [...buf].map(b => "\\" + b.toString(16).padStart(2, "0")).join("");
    const at = out.search(/^ \((?:data|table|elem|export|start|func) /m);
    out = out.slice(0, at) + ` (data $mtify_globals (i32.const ${area}) "${esc}")\n` + out.slice(at);
  }
  for (let m, left = /\bglobal\.(?:get|set) (\$[^\s)]+)/g; (m = left.exec(out));) if (byName.has(m[1])) throw new Error("mtify: a use of " + m[1] + " was not rewritten (text not in folded form?)");
  const mod = binaryen.parseText(out);
  mod.setFeatures(binaryen.Features.All);
  if (!mod.validate()) throw new Error("mtify: the rewritten module does not validate");
  const primary = mod.emitBinary();
  mod.dispose();
  return { primary, secondary: stripSections(primary, new Set([8, 11, 12])), globals };
}

// Remove whole sections (by id) from a wasm binary. Used for the secondary: 8 start, 11 data, 12 data count.
export function stripSections(bin: Uint8Array, drop: Set<number>): Uint8Array {
  const parts: Uint8Array[] = [bin.subarray(0, 8)];
  let p = 8;
  while (p < bin.length) {
    const id = bin[p];
    let q = p + 1, size = 0, shift = 0;
    for (;;) { const b = bin[q++]; size |= (b & 0x7F) << shift; shift += 7; if (!(b & 0x80)) break; }
    const end = q + size;
    if (!drop.has(id)) parts.push(bin.subarray(p, end));
    p = end;
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
