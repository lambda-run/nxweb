// tools/asc64: AssemblyScript for a 64-bit linear memory (wasm64 / the memory64 proposal).
//
//   node tools/asc64/asc64.mjs <asc arguments>          as `asc`, but usize is 64 bits and the memory is an i64 memory
//   import { asc64 } from ".../tools/asc64/asc64.mjs";  await asc64([...asc arguments])
//
// AssemblyScript 0.28 has the target in its compiler (Target.Wasm64: usize = i64, loads / stores / memory.copy /
// memory.fill take i64 addresses, static data offsets are i64 constants) but its command line driver always selects
// wasm32, and three more things around the compiler are not finished. This tool closes the four without touching
// node_modules:
//   1. The driver (dist/asc.js) calls `setTarget(options, 0)`. A copy of the driver with that one call changed to
//      `setTarget(options, 2)` is written to build/asc64/ and loaded from there. (Setting the target later, from a
//      transform, is too late: the program has cached 32-bit pointer types by then.)
//   2. The compiler declares the module's memory as a 32-bit memory whatever the target (the memory64 argument of
//      BinaryenSetMemory is a constant false). A transform's afterCompile hook declares it again as an i64 memory
//      (same limits, same segments, same import) and turns the Memory64 feature on, before Binaryen validates and
//      optimizes; so the validator runs as usual and -O levels work (with the i32 memory the optimizer aborts).
//   3. `memory.size` / `memory.grow` are typed i32 by the compiler but are i64 on an i64 memory. In the copy of the
//      driver the library's two builtins become imports, `env.memory_size(): i32` and `env.memory_grow(pages: i32):
//      i32` (pages; the embedder owns the size of the one memory anyway: Memory64.imports() in src/glue/a64_host.ts
//      provides them), and the stub runtime is replaced by tools/asc64/rt.ts, the same bump allocator without
//      either and with a heap the module can place (__set_heap). `--runtime stub` is the only runtime accepted.
//      A module that still contains one of the two instructions is refused (the output is scanned).
//   4. The non-null assertion `x!` on a reference compiles to `if (result i64) <the pointer> ...`: an i64 where wasm
//      wants an i32 condition. The afterCompile hook walks every function and makes such a condition `ptr != 0`
//      (also on select and br_if, where the compiler is correct today).
// Limits that remain: static data must lie below 4 GB (--memoryBase is a u32 in the driver, and Binaryen's C API
// reports segment offsets as u32); pointers held in wasm globals, locals and memory are 64 bits, so exported
// functions take and return BigInt where the wasm32 build took numbers.
// After the compile the output is checked: its memory is an i64 memory, and where the running engine has memory64
// (Node 22.23, Chromium 133+) WebAssembly.validate accepts it.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DIST = join(ROOT, "node_modules", "assemblyscript", "dist");

let driverP = null;
function driver() {
  return driverP ??= (async () => {
    let src = readFileSync(join(DIST, "asc.js"), "utf8");
    const calls = src.match(/\.setTarget\(\w+,0\)/g);
    if (!calls || calls.length !== 1)
      throw new Error("asc64: node_modules/assemblyscript/dist/asc.js does not select its target the way 0.28.x does (expected exactly one `setTarget(options,0)`); this tool needs revisiting for this AssemblyScript version");
    src = src.replace(/\.setTarget\((\w+),0\)/, ".setTarget($1,2)");
    // the copy lives elsewhere: bare and relative specifiers become absolute
    src = src.replace(/from"binaryen"/g, "from" + JSON.stringify(import.meta.resolve("binaryen")))
             .replace(/from"assemblyscript"/g, "from" + JSON.stringify(pathToFileURL(join(DIST, "assemblyscript.js")).href))
             .replace(/import\.meta\.url/g, JSON.stringify(pathToFileURL(join(DIST, "asc.js")).href))
             .replace(/\/\/# sourceMappingURL=.*$/m, "");
    const out = join(ROOT, "build", "asc64");
    mkdirSync(out, { recursive: true });
    const file = join(out, "asc.wasm64." + createHash("sha256").update(src).digest("hex").slice(0, 12) + ".mjs");
    if (!existsSync(file)) writeFileSync(file, src);
    const [asc, binaryen] = await Promise.all([import(pathToFileURL(file).href), import("binaryen")]);
    // this private copy of the driver gets our stub runtime in place of the bundled one (its own table of library
    // sources; node_modules is not touched)
    if (typeof asc.libraryFiles?.["rt/stub"] !== "string") throw new Error("asc64: the driver has no bundled rt/stub to replace");
    asc.libraryFiles["rt/stub"] = readFileSync(join(HERE, "rt.ts"), "utf8");
    const mem = asc.libraryFiles["memory"];
    const mem2 = typeof mem !== "string" ? "" : mem
      .replace(/@builtin(\s+export declare function size\(\): i32;)/, '@external("env", "memory_size")$1')
      .replace(/@unsafe @builtin(\s+export declare function grow\(pages: i32\): i32;)/, '@unsafe @external("env", "memory_grow")$1');
    if (!mem2.includes('"memory_size"') || !mem2.includes('"memory_grow"')) throw new Error("asc64: the driver's bundled memory.ts does not declare memory.size / memory.grow the way 0.28.x does");
    asc.libraryFiles["memory"] = mem2;
    return { asc, binaryen: binaryen.default };
  })();
}

// children of the expression kinds the compiler emits, by the field names of binaryen.getExpressionInfo
const KIDS = {
  Block: ["children"], If: ["condition", "ifTrue", "ifFalse"], Loop: ["body"], Break: ["condition", "value"], Switch: ["condition", "value"],
  Call: ["operands"], CallIndirect: ["target", "operands"], LocalSet: ["value"], GlobalSet: ["value"], Load: ["ptr"], Store: ["ptr", "value"],
  Unary: ["value"], Binary: ["left", "right"], Select: ["ifTrue", "ifFalse", "condition"], Drop: ["value"], Return: ["value"], MemoryGrow: ["delta"],
  AtomicRMW: ["ptr", "value"], AtomicCmpxchg: ["ptr", "expected", "replacement"], AtomicWait: ["ptr", "expected", "timeout"], AtomicNotify: ["ptr", "notifyCount"],
  SIMDExtract: ["vec"], SIMDReplace: ["vec", "value"], SIMDShuffle: ["left", "right"], SIMDTernary: ["a", "b", "c"], SIMDShift: ["vec", "shift"],
  SIMDLoad: ["ptr"], SIMDLoadStoreLane: ["ptr", "vec"], MemoryInit: ["dest", "offset", "size"], MemoryCopy: ["dest", "source", "size"], MemoryFill: ["dest", "value", "size"],
  RefIsNull: ["value"], TableGet: ["index"], TableSet: ["index", "value"], TableGrow: ["value", "delta"], TupleMake: ["operands"], TupleExtract: ["tuple"],
  Nop: [], LocalGet: [], GlobalGet: [], Const: [], MemorySize: [], Unreachable: [], AtomicFence: [], DataDrop: [], RefNull: [], RefFunc: [], TableSize: [],
};
// an i64 where wasm wants an i32 condition (the compiler's `x!` on a 64-bit reference) becomes `!= 0`
function fixConditions(binaryen, module) {
  const kids = new Map(Object.entries(KIDS).map(([k, v]) => [binaryen[k + "Id"], v]));
  let fixed = 0;
  const cond = (e, cls) => {
    const c = cls.getCondition(e);
    if (c && binaryen.getExpressionType(c) === binaryen.i64) { cls.setCondition(e, module.i64.ne(c, module.i64.const(0n))); fixed++; }
  };
  const walk = (root) => {
    const stack = [root];
    while (stack.length) {
      const e = stack.pop();
      if (!e) continue;
      const id = binaryen.getExpressionId(e), names = kids.get(id);
      if (!names) throw new Error("asc64: an expression kind this tool does not know (binaryen id " + id + ")");
      if (id === binaryen.IfId) cond(e, binaryen.If); else if (id === binaryen.SelectId) cond(e, binaryen.Select); else if (id === binaryen.BreakId) cond(e, binaryen.Break);
      if (!names.length) continue;
      const info = binaryen.getExpressionInfo(e);
      for (const n of names) { const v = info[n]; if (Array.isArray(v)) for (const x of v) stack.push(x); else if (v) stack.push(v); }
    }
  };
  for (let i = 0; i < module.getNumFunctions(); i++) {
    const f = binaryen.getFunctionInfo(module.getFunctionByIndex(i));
    if (f.body) walk(f.body);
  }
  return fixed;
}

// the compiler's 32-bit memory declaration -> an i64 memory with the same limits, segments and import
function memory64Transform(binaryen, maxPages) {
  return {
    afterCompile(module) {
      fixConditions(binaryen, module);
      if (!module.hasMemory()) return;
      const info = module.getMemoryInfo();
      const segs = [];
      for (let i = 0; i < module.getNumDataSegments(); i++) {
        const s = module.getDataSegmentInfo(module.getDataSegmentByIndex(i));
        segs.push({ name: s.name, data: new Uint8Array(s.data), passive: s.passive, offset: s.passive ? 0 : module.i64.const(BigInt(s.offset >>> 0)) });
      }
      const exported = module.getNumExports && (() => { for (let i = 0; i < module.getNumExports(); i++) { const e = binaryen.getExportInfo(module.getExportByIndex(i)); if (e.kind === binaryen.ExternalMemory) return e.name; } return null; })();
      if (exported) module.removeExport(exported);
      module.setFeatures(module.getFeatures() | binaryen.Features.Memory64);
      module.setMemory(info.initial, maxPages ?? info.max ?? -1, exported || null, segs, info.shared, true, "0");
      if (info.module) module.addMemoryImport("0", info.module, info.base, info.shared);
    },
  };
}

// ---- checking the output: a small reader of the binary format (sections, imports, the code section's opcodes) ----
function reader(u8) {
  let p = 0;
  const r = {
    get pos() { return p; }, set pos(v) { p = v; },
    u8: () => u8[p++],
    leb: () => { let v = 0, s = 1; for (;;) { const b = u8[p++]; v += (b & 0x7F) * s; s *= 128; if (!(b & 0x80)) return v; } },
    skipLeb: () => { while (u8[p++] & 0x80); },
    str: () => { const n = r.leb(); const t = new TextDecoder().decode(u8.subarray(p, p + n)); p += n; return t; },
  };
  return r;
}
// { memories: [{ flags, imported }], usesSizeOrGrow }
export function inspect(u8) {
  const r = reader(u8);
  if (u8.length < 8 || u8[0] !== 0 || u8[1] !== 0x61 || u8[2] !== 0x73 || u8[3] !== 0x6D) throw new Error("not a wasm binary");
  r.pos = 8;
  const memories = [];
  let code = null;
  const limits = () => { const flags = r.u8(); r.skipLeb(); if (flags & 1) r.skipLeb(); return flags; };
  while (r.pos < u8.length) {
    const id = r.u8(), size = r.leb(), end = r.pos + size;
    if (id === 2) {
      for (let n = r.leb(); n > 0; n--) {
        r.str(); r.str();
        const kind = r.u8();
        if (kind === 0) r.skipLeb();
        else if (kind === 1) { r.u8(); limits(); }
        else if (kind === 2) memories.push({ flags: limits(), imported: true });
        else if (kind === 3) { r.u8(); r.u8(); }
        else if (kind === 4) { r.u8(); r.skipLeb(); }
      }
    } else if (id === 5) {
      for (let n = r.leb(); n > 0; n--) memories.push({ flags: limits(), imported: false });
    } else if (id === 10) code = [r.pos, end];
    r.pos = end;
  }
  return { memories, usesSizeOrGrow: code ? scanCode(u8, code[0], code[1]) : false };
}
// does any function body hold memory.size (0x3F) or memory.grow (0x40)? A linear decode of the instructions the
// compiler emits (MVP, sign extension, bulk memory, saturating conversions, SIMD, threads, tail calls).
function scanCode(u8, lo, hi) {
  const r = reader(u8);
  r.pos = lo;
  const memarg = () => { const a = r.leb(); if (a & 0x40) r.skipLeb(); r.skipLeb(); };
  const blockType = () => { const b = u8[r.pos]; if (b === 0x40 || (b >= 0x69 && b <= 0x7F)) r.pos++; else r.skipLeb(); };
  for (let n = r.leb(); n > 0; n--) {
    const size = r.leb(), end = r.pos + size;
    for (let g = r.leb(); g > 0; g--) { r.skipLeb(); r.u8(); }
    while (r.pos < end) {
      const op = r.u8();
      if (op === 0x3F || op === 0x40) return true;
      if (op === 0x02 || op === 0x03 || op === 0x04) blockType();
      else if (op === 0x0C || op === 0x0D || op === 0x10 || op === 0x12 || (op >= 0x20 && op <= 0x26) || op === 0xD0 || op === 0xD2) r.skipLeb();
      else if (op === 0x0E) { for (let k = r.leb() + 1; k > 0; k--) r.skipLeb(); }
      else if (op === 0x11 || op === 0x13) { r.skipLeb(); r.skipLeb(); }
      else if (op === 0x1C) { for (let k = r.leb(); k > 0; k--) r.u8(); }
      else if (op >= 0x28 && op <= 0x3E) memarg();
      else if (op === 0x41 || op === 0x42) r.skipLeb();
      else if (op === 0x43) r.pos += 4;
      else if (op === 0x44) r.pos += 8;
      else if (op === 0xFC) {
        const s = r.leb();
        if (s === 8) { r.skipLeb(); r.skipLeb(); }            // memory.init
        else if (s === 9 || s === 11 || s === 13 || (s >= 15 && s <= 17)) r.skipLeb();   // data.drop, memory.fill, elem.drop, table.grow/size/fill
        else if (s === 10 || s === 12 || s === 14) { r.skipLeb(); r.skipLeb(); }         // memory.copy, table.init, table.copy
      } else if (op === 0xFD) {
        const s = r.leb();
        if (s <= 11 || (s >= 92 && s <= 93)) memarg();
        else if (s === 12 || s === 13) r.pos += 16;
        else if (s >= 21 && s <= 34) r.u8();
        else if (s >= 84 && s <= 91) { memarg(); r.u8(); }
      } else if (op === 0xFE) {
        const s = r.leb();
        if (s === 3) r.u8(); else memarg();
      }
    }
    r.pos = end;
  }
  return false;
}

// does this engine take a module with an i64 memory?
export function engineHasMemory64() {
  try { new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0, 5, 3, 1, 0x04, 1])); return true; } catch { return false; }
}

// Compile with asc for wasm64. `args` are asc's own arguments. Throws on any failure, with the reason.
export async function asc64(args, io = {}) {
  args = [...args];
  const at = (name) => { const i = args.indexOf(name); return i >= 0 ? i : -1; };
  const rt = at("--runtime");
  if (rt < 0) args.push("--runtime", "stub");
  else if (args[rt + 1] !== "stub") throw new Error(`asc64: --runtime ${args[rt + 1]}: only the stub runtime is available (tools/asc64/rt.ts takes its place); the incremental and minimal runtimes use memory.size / memory.grow, which the compiler types as i32`);
  const base = at("--memoryBase");
  if (base >= 0 && !(Number(args[base + 1]) < 2 ** 32)) throw new Error("asc64: --memoryBase must be below 4 GB (the driver and Binaryen's segment API carry it as a u32)");
  const out = Math.max(at("-o"), at("--outFile"));
  // --maximumMemory is a page count: a 64-bit memory's may be above 65536, which the driver takes as it is
  const { asc, binaryen } = await driver();
  const res = await asc.main(args, { stdout: io.stdout ?? process.stdout, stderr: io.stderr ?? process.stderr, transforms: [memory64Transform(binaryen)] });
  if (res.error) throw new Error("asc64: " + res.error.message);
  if (out < 0) return;
  const bytes = new Uint8Array(readFileSync(args[out + 1]));
  const info = inspect(bytes);
  if (info.memories.length !== 1 || !(info.memories[0].flags & 0x04)) throw new Error(`asc64: ${args[out + 1]} does not have one i64 memory (limits flags: ${info.memories.map(m => "0x" + m.flags.toString(16)).join(", ") || "none"})`);
  if (info.usesSizeOrGrow) throw new Error(`asc64: ${args[out + 1]} contains memory.size or memory.grow, which the compiler types as i32 (an i64 memory's are i64): the source or its runtime must not use them`);
  if (engineHasMemory64() && !WebAssembly.validate(bytes)) {
    let why = ""; try { new WebAssembly.Module(bytes); } catch (e) { why = ": " + e.message; }
    throw new Error(`asc64: the engine rejects ${args[out + 1]}${why}`);
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { await asc64(process.argv.slice(2)); } catch (e) { console.error("[RED] " + (e instanceof Error ? e.message : e)); process.exit(1); }
}
