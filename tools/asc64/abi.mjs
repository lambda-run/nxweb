// tools/asc64/abi: one AssemblyScript module built twice, for a 32-bit and for a 64-bit linear memory, and the table
// that says which parameters and results of its exported and imported functions are ADDRESSES (usize / isize).
//
// The two builds of one source differ, at the module boundary, exactly where the source says usize: i32 in the wasm32
// build, i64 in the wasm64 one. A parameter that is i64 in both is a u64 / i64 of the source (a guest register, a
// time), a parameter that is i32 in both an int. So the table is the difference of the two signatures, taken here
// at build time, and written into BOTH binaries as a custom section "nx.abi" (after everything else: the code of the
// wasm32 binary is what `asc` wrote). src/glue/wasm_abi.ts reads it when it instantiates a module and makes every
// address a JavaScript number on the glue's side, in both modes (docs/CONTRACT.md, "Addresses").
//
//   section payload (UTF-8 JSON): { "v": 1, "m": 32 | 64, "exports": { name: sig }, "imports": { "module.name": sig } }
//   sig: one character per parameter, ">" and one per result: "p" an address, "." anything else. Only functions with
//   at least one "p" are listed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const ASC = join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js");
const ASC64 = join(HERE, "asc64.mjs");
export const ABI_SECTION = "nx.abi";

function reader(u8) {
  const r = { pos: 8,
    u8: () => u8[r.pos++],
    leb: () => { let v = 0, s = 1; for (;;) { const b = u8[r.pos++]; v += (b & 0x7F) * s; if (!(b & 0x80)) return v; s *= 128; } },
    str: () => { const n = r.leb(); const s = new TextDecoder().decode(u8.subarray(r.pos, r.pos + n)); r.pos += n; return s; },
  };
  return r;
}
// the signatures of a module's function imports and exports: { exports: Map name -> { p: number[], r: number[] }, imports: Map "module.name" -> ... }
export function signatures(u8) {
  const r = reader(u8), types = [], funcs = [], imports = new Map(), exports = new Map();
  const limits = () => { const f = r.leb(); r.leb(); if (f & 1) r.leb(); };
  while (r.pos < u8.length) {
    const id = r.u8(), size = r.leb(), end = r.pos + size;
    if (id === 1) {
      for (let n = r.leb(); n > 0; n--) {
        if (r.u8() !== 0x60) throw new Error("abi: a type that is not a function type");
        const p = [], q = [];
        for (let k = r.leb(); k > 0; k--) p.push(r.u8());
        for (let k = r.leb(); k > 0; k--) q.push(r.u8());
        types.push({ p, r: q });
      }
    } else if (id === 2) {
      for (let n = r.leb(); n > 0; n--) {
        const mod = r.str(), name = r.str(), kind = r.u8();
        if (kind === 0) { const t = types[r.leb()]; funcs.push(t); imports.set(mod + "." + name, t); }
        else if (kind === 1) { r.u8(); limits(); }
        else if (kind === 2) limits();
        else if (kind === 3) { r.u8(); r.u8(); }
        else if (kind === 4) { r.u8(); r.leb(); }
      }
    } else if (id === 3) {
      for (let n = r.leb(); n > 0; n--) funcs.push(types[r.leb()]);
    } else if (id === 7) {
      for (let n = r.leb(); n > 0; n--) { const name = r.str(), kind = r.u8(), index = r.leb(); if (kind === 0) exports.set(name, funcs[index]); }
    }
    r.pos = end;
  }
  return { imports, exports };
}
const I32 = 0x7F, I64 = 0x7E;
function sigOf(name, a, b) {
  if (a.p.length !== b.p.length || a.r.length !== b.r.length) throw new Error(`abi: ${name} has another arity in the wasm64 build`);
  const one = (x, y, what) => {
    if (x === I32 && y === I64) return "p";
    if (x !== y) throw new Error(`abi: ${name}: ${what} is 0x${x.toString(16)} in the wasm32 build and 0x${y.toString(16)} in the wasm64 build`);
    return ".";
  };
  const s = a.p.map((x, i) => one(x, b.p[i], "parameter " + i)).join("") + ">" + a.r.map((x, i) => one(x, b.r[i], "result " + i)).join("");
  return s.includes("p") ? s : null;
}
// the table of one source's two builds
export function abiTable(bytes32, bytes64) {
  const a = signatures(bytes32), b = signatures(bytes64), out = { exports: {}, imports: {} };
  // tools/asc64 turns memory.size / memory.grow into two imports the wasm32 build does not have
  const only64 = new Set(["env.memory_size", "env.memory_grow"]);
  for (const kind of ["exports", "imports"]) {
    for (const [name, t] of a[kind]) {
      const u = b[kind].get(name);
      if (!u) throw new Error(`abi: ${kind.slice(0, -1)} ${name} is missing in the wasm64 build`);
      const s = sigOf(name, t, u);
      if (s) out[kind][name] = s;
    }
    for (const name of b[kind].keys()) if (!a[kind].has(name) && !(kind === "imports" && only64.has(name))) throw new Error(`abi: ${kind.slice(0, -1)} ${name} is missing in the wasm32 build`);
  }
  return out;
}
function leb(v) { const n = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; n.push(b); } while (v); return n; }
// bytes with the table as a trailing custom section (an earlier one is replaced)
export function withAbi(bytes, table, m) {
  bytes = stripAbi(bytes);
  const name = new TextEncoder().encode(ABI_SECTION), body = new TextEncoder().encode(JSON.stringify({ v: 1, m, ...table }));
  const head = [0, ...leb(leb(name.length).length + name.length + body.length), ...leb(name.length)];
  const out = new Uint8Array(bytes.length + head.length + name.length + body.length);
  out.set(bytes); out.set(head, bytes.length); out.set(name, bytes.length + head.length); out.set(body, bytes.length + head.length + name.length);
  return out;
}
export function stripAbi(bytes) {
  const r = reader(bytes), keep = [bytes.subarray(0, 8)];
  while (r.pos < bytes.length) {
    const start = r.pos, id = r.u8(), size = r.leb(), end = r.pos + size;
    if (!(id === 0 && r.str() === ABI_SECTION)) keep.push(bytes.subarray(start, end));
    r.pos = end;
  }
  const out = new Uint8Array(keep.reduce((a, k) => a + k.length, 0));
  let o = 0; for (const k of keep) { out.set(k, o); o += k.length; }
  return out;
}

export const out64Of = (out32) => out32.replace(/(\.shared)?\.wasm$/, "64$1.wasm");
// One source, both builds, both stamped with the table. `args` are asc's arguments without the source and -o (the
// same for both; args64 replaces or adds what the wasm64 build needs, e.g. --importMemory for a module whose wasm32
// build has a memory of its own). Returns the two paths.
export function buildPair(src, out32, args, o = {}) {
  const out64 = o.out64 ?? out64Of(out32), run = (tool, out, a) => execFileSync(process.execPath, [tool, src, "-o", out, ...a], { cwd: ROOT, stdio: "inherit" });
  run(ASC, out32, args);
  run(ASC64, out64, o.args64 ?? args);
  stampPair(resolve(ROOT, out32), resolve(ROOT, out64));
  return [out32, out64];
}
export function stampPair(out32, out64) {
  const b32 = new Uint8Array(readFileSync(out32)), b64 = new Uint8Array(readFileSync(out64));
  const table = abiTable(stripAbi(b32), stripAbi(b64));
  writeFileSync(out32, withAbi(b32, table, 32));
  writeFileSync(out64, withAbi(b64, table, 64));
  return table;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  // node tools/asc64/abi.mjs <src> <out32.wasm> [asc arguments] [--64 <more arguments for the wasm64 build only>]
  //                                                                  (out64 is <out32 name>64.wasm)
  // node tools/asc64/abi.mjs --show <file.wasm>
  try {
    if (process.argv[2] === "--show") {
      const m = new WebAssembly.Module(readFileSync(process.argv[3]));
      console.log(new TextDecoder().decode(WebAssembly.Module.customSections(m, ABI_SECTION)[0] ?? new Uint8Array()));
    } else {
      const rest = process.argv.slice(4), cut = rest.indexOf("--64"), common = cut < 0 ? rest : rest.slice(0, cut);
      buildPair(process.argv[2], process.argv[3], common, cut < 0 ? {} : { args64: [...common, ...rest.slice(cut + 1)] });
    }
  } catch (e) { console.error("[RED] " + (e instanceof Error ? e.message : e)); process.exit(1); }
}
