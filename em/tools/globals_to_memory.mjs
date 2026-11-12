// globals_to_memory.mjs: move a wasm module's mutable globals into its linear memory.
//
// Why: an AssemblyScript module of nxweb (the NVN recorder, the file system) keeps its tables and statics in the linear
// memory already; the only state that belongs to one INSTANCE is its mutable wasm globals. With those at fixed
// addresses of the (shared) memory instead, every thread can instantiate the module and they all are the same module:
// a guest thread calls it directly under a lock, with no hand-over to an owner thread.
//
// What it does (binary to binary, no dependency; runs in Node and in a page):
//   - every mutable global the module DEFINES (imported and exported ones are left alone, and so is any index in
//     `keep`) gets a slot of 16 bytes at base + 16 * k;
//   - in every function body `global.get g` becomes `<addr>.const; <type>.load` and `global.set g` becomes
//     `local.set tmp; <addr>.const; local.get tmp; <type>.store`, tmp being one new local per value type the function
//     needs (appended after its own locals);
//   - the globals stay declared (unused). Their initial values are NOT written by the module: they are returned
//     (`globals[k].init`, little-endian bytes) for the embedder to write ONCE, before the first instance runs.
//   - `secondary: true` gives the build for every instance after the first: the same code without the start
//     function, the data segments and the data count (the first instance ran the one and wrote the others; a second
//     run would reset what the module has changed since). A module that uses memory.init or data.drop has no such
//     build (it would not validate).
// Refused: a mutable global whose initialiser is not a constant; anything the decoder does not know (it stops with
// the opcode and the function).
//
// CLI: node globals_to_memory.mjs <in.wasm> <out.wasm> <base (decimal or 0x..)> [--secondary]   -> out.wasm and out.wasm.globals.json
// API: globalsToMemory(bytes, { base, keep?: number[], secondary?: boolean }) -> { wasm, globals: [{ index, type, addr, init }], size, gets, sets, functions }

const VT = { 0x7F: "i32", 0x7E: "i64", 0x7D: "f32", 0x7C: "f64", 0x7B: "v128" };
const LOAD = { i32: [0x28, 2], i64: [0x29, 3], f32: [0x2A, 2], f64: [0x2B, 3], v128: [0xFD, 0x00, 4] };
const STORE = { i32: [0x36, 2], i64: [0x37, 3], f32: [0x38, 2], f64: [0x39, 3], v128: [0xFD, 0x0B, 4] };

function uleb(n) { const o = []; n = BigInt(n); do { let b = Number(n & 0x7Fn); n >>= 7n; if (n) b |= 0x80; o.push(b); } while (n); return o; }
function sleb(n) { const o = []; n = BigInt(n); for (;;) { const b = Number(n & 0x7Fn); n >>= 7n; if ((n === 0n && !(b & 0x40)) || (n === -1n && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } }

class R {
  constructor(b, p = 0) { this.b = b; this.p = p; }
  u8() { return this.b[this.p++]; }
  uleb() { let v = 0n, s = 0n, c; do { c = this.b[this.p++]; v |= BigInt(c & 0x7F) << s; s += 7n; } while (c & 0x80); return Number(v); }
  skipLeb() { while (this.b[this.p++] & 0x80); }
  name() { const n = this.uleb(), s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
  limits() { const f = this.u8(); this.skipLeb(); if (f & 1) this.skipLeb(); return f; }
}

// one instruction's immediates are skipped; returns nothing (r.p is after it). op was read already
function skipImm(r, op, where) {
  const memarg = () => { const a = r.uleb(); if (a & 0x40) r.skipLeb(); r.skipLeb(); };
  const blocktype = () => { const c = r.b[r.p]; if (c === 0x40 || VT[c] || c === 0x70 || c === 0x6F) r.p++; else r.skipLeb(); };
  if (op === 0x02 || op === 0x03 || op === 0x04) return blocktype();
  if (op === 0x0C || op === 0x0D) return r.skipLeb();                       // br, br_if
  if (op === 0x0E) { const n = r.uleb(); for (let i = 0; i <= n; i++) r.skipLeb(); return; }   // br_table
  if (op === 0x10 || op === 0x12) return r.skipLeb();                       // call, return_call
  if (op === 0x11 || op === 0x13) { r.skipLeb(); r.skipLeb(); return; }     // call_indirect, return_call_indirect
  if (op === 0x1C) { const n = r.uleb(); r.p += n; return; }                // select t*
  if (op >= 0x20 && op <= 0x24) return r.skipLeb();                         // local.get/set/tee, global.get/set
  if (op === 0x25 || op === 0x26) return r.skipLeb();                       // table.get/set
  if (op >= 0x28 && op <= 0x3E) return memarg();
  if (op === 0x3F || op === 0x40) { r.p++; return; }                        // memory.size / grow
  if (op === 0x41 || op === 0x42) return r.skipLeb();
  if (op === 0x43) { r.p += 4; return; }
  if (op === 0x44) { r.p += 8; return; }
  if (op === 0xD0) { r.skipLeb(); return; }                                 // ref.null t
  if (op === 0xD2) return r.skipLeb();                                      // ref.func
  if (op === 0xFC) {
    const s = r.uleb();
    if (s <= 7) return;
    if (s === 8) { r.skipLeb(); r.p++; return; }                            // memory.init
    if (s === 9) return r.skipLeb();                                        // data.drop
    if (s === 10) { r.p += 2; return; }                                     // memory.copy
    if (s === 11) { r.p++; return; }                                        // memory.fill
    if (s === 12 || s === 14) { r.skipLeb(); r.skipLeb(); return; }         // table.init, table.copy
    if (s === 13 || (s >= 15 && s <= 17)) return r.skipLeb();
    throw new Error(`globals_to_memory: unknown 0xFC ${s} in ${where}`);
  }
  if (op === 0xFD) {
    const s = r.uleb();
    if (s <= 11 || s === 92 || s === 93) return memarg();                   // loads, store, load32/64_zero
    if (s === 12 || s === 13) { r.p += 16; return; }                        // v128.const, i8x16.shuffle
    if (s >= 21 && s <= 34) { r.p++; return; }                              // extract / replace lane
    if (s >= 84 && s <= 91) { memarg(); r.p++; return; }                    // load/store lane
    return;                                                                 // everything else: no immediate
  }
  if (op === 0xFE) {
    const s = r.uleb();
    if (s === 3) { r.p++; return; }                                         // atomic.fence
    return memarg();
  }
  if ((op >= 0x45 && op <= 0xC4) || op === 0x00 || op === 0x01 || op === 0x05 || op === 0x0B || op === 0x0F || op === 0x1A || op === 0x1B || op === 0xD1) return;
  throw new Error(`globals_to_memory: unknown opcode 0x${op.toString(16)} in ${where}`);
}

export function globalsToMemory(bytes, o) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), base = Number(o.base), keep = new Set(o.keep ?? []);
  if (b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6D) throw new Error("globals_to_memory: not a wasm binary");
  const secs = []; { const r = new R(b, 8); while (r.p < b.length) { const start = r.p, id = r.u8(), size = r.uleb(), body = r.p; secs.push({ id, start, body, end: body + size }); r.p = body + size; } }
  const sec = id => secs.find(s => s.id === id);
  // types (parameter counts), imports (function / global counts, the memory's index type), functions, globals, exports
  const params = []; if (sec(1)) { const r = new R(b, sec(1).body), n = r.uleb(); for (let i = 0; i < n; i++) { if (r.u8() !== 0x60) throw new Error("globals_to_memory: a type that is not a function type (GC types are not handled)"); const np = r.uleb(); r.p += np; const nr = r.uleb(); r.p += nr; params.push(np); } }
  let impFuncs = 0, impGlobals = 0, mem64 = null;
  if (sec(2)) { const r = new R(b, sec(2).body), n = r.uleb(); for (let i = 0; i < n; i++) { r.name(); r.name(); const k = r.u8();
    if (k === 0) { r.skipLeb(); impFuncs++; } else if (k === 1) { r.p++; r.limits(); } else if (k === 2) { const f = r.limits(); if (mem64 === null) mem64 = !!(f & 4); } else if (k === 3) { r.p += 2; impGlobals++; } else throw new Error("globals_to_memory: import kind " + k); } }
  if (mem64 === null && sec(5)) { const r = new R(b, sec(5).body); if (r.uleb()) mem64 = !!(r.b[r.p] & 4); }
  if (mem64 === null) throw new Error("globals_to_memory: the module has no memory");
  const ftype = []; if (sec(3)) { const r = new R(b, sec(3).body), n = r.uleb(); for (let i = 0; i < n; i++) ftype.push(r.uleb()); }
  const exported = new Set(); if (sec(7)) { const r = new R(b, sec(7).body), n = r.uleb(); for (let i = 0; i < n; i++) { r.name(); const k = r.u8(), ix = r.uleb(); if (k === 3) exported.add(ix); } }
  const globals = [], slot = new Map();   // global index -> { type, addr }
  if (sec(6)) { const r = new R(b, sec(6).body), n = r.uleb();
    for (let i = 0; i < n; i++) {
      const index = impGlobals + i, t = VT[r.u8()], mut = r.u8(), at = r.p, op = r.u8(); let init = null;
      if (op === 0x41 && t === "i32") { const s = r.p; r.skipLeb(); init = constBytes(b, s, 4); }
      else if (op === 0x42 && t === "i64") { const s = r.p; r.skipLeb(); init = constBytes(b, s, 8); }
      else if (op === 0x43) { init = b.slice(r.p, r.p + 4); r.p += 4; }
      else if (op === 0x44) { init = b.slice(r.p, r.p + 8); r.p += 8; }
      else if (op === 0xFD && r.b[r.p] === 12) { r.p++; init = b.slice(r.p, r.p + 16); r.p += 16; }
      else { r.p = at; while (r.b[r.p] !== 0x0B) { const x = r.u8(); skipImm(r, x, "a global's initialiser"); } }
      if (r.u8() !== 0x0B) throw new Error(`globals_to_memory: global ${index}: its initialiser is not one constant`);
      if (!mut || exported.has(index) || keep.has(index)) continue;
      if (!t) throw new Error(`globals_to_memory: global ${index} has a type that is not a number or v128`);
      if (!init) throw new Error(`globals_to_memory: mutable global ${index} is not initialised with a constant`);
      const g = { index, type: t, addr: base + 16 * globals.length, init }; globals.push(g); slot.set(index, g);
    } }
  // the code section, function by function
  const code = sec(10); let gets = 0, sets = 0; const bodies = [];
  if (code) { const r = new R(b, code.body), n = r.uleb();
    for (let f = 0; f < n; f++) {
      const size = r.uleb(), start = r.p, end = start + size, where = `function ${impFuncs + f}`;
      const ngroups = r.uleb(); let nlocals = params[ftype[f]];
      for (let i = 0; i < ngroups; i++) { nlocals += r.uleb(); r.p++; }
      const localsEnd = r.p, out = [], tmp = {};   // tmp: value type -> the new local's index
      const addr = a => mem64 ? [0x42, ...sleb(a)] : [0x41, ...sleb(a | 0)];
      let copied = r.p;
      while (r.p < end) {
        const at = r.p, op = r.u8();
        if (op === 0x23 || op === 0x24) {
          const gi = r.uleb(), g = slot.get(gi);
          if (!g) continue;
          for (let i = copied; i < at; i++) out.push(b[i]);
          const [o1, o2, o3] = (op === 0x23 ? LOAD : STORE)[g.type], opc = o3 === undefined ? [o1] : [o1, o2], align = o3 === undefined ? o2 : o3;
          if (op === 0x23) { out.push(...addr(g.addr), ...opc, align, 0); gets++; }
          else { if (tmp[g.type] === undefined) tmp[g.type] = nlocals + Object.keys(tmp).length; out.push(0x21, ...uleb(tmp[g.type]), ...addr(g.addr), 0x20, ...uleb(tmp[g.type]), ...opc, align, 0); sets++; }
          copied = r.p;
        } else skipImm(r, op, where);
      }
      if (r.p !== end) throw new Error(`globals_to_memory: ${where}: decoding ran past its end`);
      for (let i = copied; i < end; i++) out.push(b[i]);
      const extra = Object.keys(tmp), head = [...uleb(ngroups + extra.length), ...b.subarray(start + lebLen(b, start), localsEnd)];
      for (const t of extra) head.push(1, Number(Object.keys(VT).find(k => VT[k] === t)));
      bodies.push(Uint8Array.from([...uleb(head.length + out.length), ...head, ...out]));
    } }
  // put the module together again
  const parts = [b.subarray(0, 8)];
  for (const s of secs) {
    if (o.secondary && (s.id === 8 || s.id === 11 || s.id === 12)) continue;
    if (s.id !== 10) { parts.push(b.subarray(s.start, s.end)); continue; }
    const count = uleb(bodies.length), size = count.length + bodies.reduce((n, x) => n + x.length, 0);
    parts.push(Uint8Array.from([10, ...uleb(size), ...count]), ...bodies);
  }
  const wasm = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of parts) { wasm.set(x, at); at += x.length; }
  return { wasm, globals, size: 16 * globals.length, gets, sets, functions: bodies.length, mem64 };
}
function lebLen(b, p) { let n = 1; while (b[p++] & 0x80) n++; return n; }
// the value of a signed LEB constant as `bytes` little-endian bytes
function constBytes(b, p, bytes) {
  let v = 0n, s = 0n, c; do { c = b[p++]; v |= BigInt(c & 0x7F) << s; s += 7n; } while (c & 0x80);
  if (c & 0x40) v |= -1n << s;
  const out = new Uint8Array(bytes); for (let i = 0; i < bytes; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xFFn);
  return out;
}
// Write the initial values (once, before the first instance runs)
export function writeGlobalInits(memory, globals) { const u8 = new Uint8Array(memory.buffer); for (const g of globals) { u8.fill(0, g.addr, g.addr + 16); u8.set(g.init, g.addr); } }

if (typeof process !== "undefined" && process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const [inp, outp, base] = process.argv.slice(2).filter(a => a !== "--secondary"), secondary = process.argv.includes("--secondary");
  if (!inp || !outp || base === undefined) { console.error("usage: node globals_to_memory.mjs <in.wasm> <out.wasm> <base>"); process.exit(2); }
  const r = globalsToMemory(readFileSync(inp), { base: Number(base), secondary });
  writeFileSync(outp, r.wasm);
  writeFileSync(outp + ".globals.json", JSON.stringify(r.globals.map(g => ({ index: g.index, type: g.type, addr: g.addr, init: Buffer.from(g.init).toString("hex") }))));
  console.log(`globals_to_memory: ${r.globals.length} mutable globals moved to 0x${Number(base).toString(16)} (+${r.size} bytes), ${r.gets} global.get and ${r.sets} global.set rewritten in ${r.functions} functions; ${r.wasm.length} bytes (was ${readFileSync(inp).length})`);
}
