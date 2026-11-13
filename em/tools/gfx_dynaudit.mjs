// gfx_dynaudit.mjs: the dynamic audit of nxweb's NVN recorder for the lock-free recording path (kernel/nx_gfx.c).
//
// The static audit (gfx_audit.mjs) knows which entry points write a wasm global or call an import. It cannot see a
// write to static MEMORY: `const RANGE = memory.data(16)` in src/gfx/dispatch.ts is 16 bytes at one fixed address for
// every instance of the module on the shared memory, nvnCommandBufferBindVertexBuffer writes its address and size
// there and reads them back, and six threads doing that at once got each other's values (the proof test's failure).
//
// This audit runs the recorder itself, alone, on a small memory of its own (512 MB reserved, a few MB touched):
// a device, a few command buffers, and then every candidate entry point (those the static audit lets through) is
// called with made-up arguments while the module's static data, its globals block and the used part of its arena are
// compared before and after. Per entry point:
//   - nothing written there                                   -> stays as the static audit said (free / free with room);
//   - a few bytes of static data (64 at most) that are scratch -> those bytes become per instance (`statics`, for
//     tools/globals_to_memory.mjs) and the entry point stays free. Scratch is tested, not assumed: the bytes are
//     filled with two different patterns before two calls with the same arguments on two command buffers in the same
//     state; the records written and the bytes left behind must be the same both times (written before read, and
//     fully determined by the arguments);
//   - anything else (more bytes, the globals block, arena bytes that two different command buffers both touch, bytes
//     that fail the scratch test, or no argument pattern under which the call records anything) -> under the lock.
// Limits, said plainly: a write on a path the made-up arguments do not take is not seen (the static audit and the
// proof test, em/test/gfx_lockfree_test.mts, stand beside this); the arena is watched up to what the set-up used.
//
// API: dynamicAudit(raw gfx64.wasm, { sharedBuild, instantiate, range }) ->
//   { table: Uint8Array by NVN id (0 lock, 1 free, 3 free while the buffer has room), statics: [{ addr, len }],
//     names: string[], args: Map<id, bigint[]> (the arguments that recorded), report: { ... }, ms }
// CLI: node em/tools/gfx_dynaudit.mjs [dir with gfx64.wasm]   (prints what every candidate writes)
import { globalsToMemory, writeGlobalInits } from "./globals_to_memory.mjs";
import { lockFreeTable } from "./gfx_audit.mjs";

const PAGES = 8192, GLOBALS = 0x1FF10000, MEM = 64 * 1024;

export function dynamicAudit(raw, deps) {
  const t0 = performance.now();
  const plain = deps.sharedBuild(raw, PAGES);
  const memory = new WebAssembly.Memory({ initial: BigInt(PAGES), maximum: BigInt(PAGES), shared: true, address: "i64" });
  const first = globalsToMemory(plain, { base: GLOBALS });
  writeGlobalInits(memory, first.globals);
  let tables = 0x18000000, more = 0, logs = 0;
  const env = { memory, memory_size: () => PAGES, memory_grow: () => -1, abort: () => { throw new Error("abort"); }, log: () => { logs++; },
    gfx_exec: () => {}, gfx_proc_address: () => 0n, gfx_arena_more: (n) => { more++; const at = tables; tables += ((n >>> 0) + 0xFFFF) & ~0xFFFF; return at; }, gfx_guest_call: () => 0n };
  const x = deps.instantiate(new WebAssembly.Module(first.wasm), { env }, { mem64: true, name: "gfx64.wasm" });
  const arena = deps.range("gfx arena"), stat = deps.range("gfx static"), u8 = new Uint8Array(memory.buffer), u64 = new BigUint64Array(memory.buffer);
  if (!x.gfx_init(arena.lo, x.gfx_arena_bytes())) throw new Error("gfx_dynaudit: the recorder did not start");
  if (!x.kit_trace_enable) throw new Error("gfx_dynaudit: the recorder has no kit_trace_enable");
  x.kit_trace_enable(0);
  const count = x.nvn_count(), names = [], idOf = new Map();
  for (let id = 0; id < count; id++) { const p = x.nvn_name(id); let e = p; while (u8[e]) e++; const n = String.fromCharCode(...u8.subarray(p, e)); names.push(n); idOf.set(n, id); }
  const st = lockFreeTable(plain, id => names[id], count);
  // objects, by the game's calls
  let bump = 0x10000000; const alloc = (n) => { const a = bump; bump += (n + 4095) & ~4095; return a; };
  const ARGS = alloc(4096), call = (name, ...a) => { for (let i = 0; i < 8; i++) u64[ARGS / 8 + i] = BigInt(a[i] ?? 0); return x.nvn_call(idOf.get(name), ARGS); };
  const devb = alloc(64), dev = alloc(64); call("nvnDeviceBuilderSetDefaults", devb); call("nvnDeviceBuilderSetFlags", devb, 0); call("nvnDeviceInitialize", dev, devb);
  // four command buffers for every candidate (one that trapped is not used again), all made before anything is
  // watched: their command memory is one pool's, 64 KB each
  const cand = []; for (let id = 0; id < count; id++) if (st.table[id]) cand.push(id);
  const NB = 4 * cand.length, pb = alloc(64), pool = alloc(64), store = alloc(NB * MEM), bufs = [];
  call("nvnMemoryPoolBuilderSetDefaults", pb); call("nvnMemoryPoolBuilderSetDevice", pb, dev); call("nvnMemoryPoolBuilderSetStorage", pb, store, NB * MEM); call("nvnMemoryPoolBuilderSetFlags", pb, 0x22); call("nvnMemoryPoolInitialize", pool, pb);
  for (let i = 0; i < NB; i++) { const c = alloc(256), ctl = alloc(4096);
    call("nvnCommandBufferInitialize", c, dev); call("nvnCommandBufferAddCommandMemory", c, pool, i * MEM, MEM); call("nvnCommandBufferAddControlMemory", c, ctl, 4096); call("nvnCommandBufferBeginRecording", c);
    bufs.push({ c, mem: store + i * MEM }); }
  const builder = alloc(4096), builder2 = alloc(4096), scr = [alloc(4096), alloc(4096), alloc(4096)];
  // what is watched: the static data, the globals block, the arena up to what the set-up used (and a margin)
  let hw = arena.lo; { const a64 = new BigUint64Array(memory.buffer, arena.lo, (arena.hi - arena.lo) / 8); for (let i = a64.length - 1; i >= 0; i--) if (a64[i]) { hw = arena.lo + 8 * i; break; } }
  let sHi = stat.lo; { const a64 = new BigUint64Array(memory.buffer, stat.lo, (stat.hi - stat.lo) / 8); for (let i = a64.length - 1; i >= 0; i--) if (a64[i]) { sHi = stat.lo + 8 * i; break; } }
  // (the whole static range: scratch the module only reserves, memory.data(n), is zero until used and can lie past the last
  // initialized byte; a build whose data ended earlier had the BindVertexBuffer scratch outside a window cut at that byte)
  void sHi;
  const regs = [{ lo: stat.lo, hi: stat.hi, kind: "static" }, { lo: GLOBALS, hi: GLOBALS + Math.max(16, first.size), kind: "globals" }, { lo: arena.lo, hi: Math.min(arena.hi, (hw + 0x20000) & ~0xFFFF), kind: "arena" }];
  for (const r of regs) { r.live = new BigUint64Array(memory.buffer, r.lo, (r.hi - r.lo) / 8); r.shadow = r.live.slice(); }
  // the words that changed since the last look, by kind (addresses); the shadow follows
  const changed = () => { const out = { static: [], globals: [], arena: [] };
    for (const r of regs) { const l = r.live, s = r.shadow, o = out[r.kind]; for (let i = 0; i < l.length; i++) if (l[i] !== s[i]) { s[i] = l[i]; if (o.length < 4096) o.push(r.lo + 8 * i); } }
    return out; };
  const pos = (b) => Number(u64[(b.c + 8) / 8]);   // the command buffer's write position
  const PATTERNS = [   // x1..x7; S = a zeroed scratch block
    () => [1n, 2n, 3n, 4n, 5n, 6n, 7n],
    (S) => [1n, BigInt(S[0]), 3n, BigInt(S[1]), 5n, 6n, 7n],
    (S) => [0n, 1n, BigInt(S[0]), BigInt(S[1]), 4n, 0n, 0n],
    (S) => [1n, 0x10000000n, 4096n, BigInt(S[0]), 0n, 0n, 0n],
    (S) => [BigInt(S[0]), 1n, 2n, 3n, 4n, 0n, 0n],
    (S) => [BigInt(S[0]), BigInt(S[1]), 2n, 3n, 4n, 0n, 0n],
    () => [0n, 0n, 0n, 0n, 0n, 0n, 0n],
  ];
  const run = (id, x0, a) => { for (const s of scr) u8.fill(0, s, s + 4096); u64[ARGS / 8] = BigInt(x0); for (let i = 0; i < 7; i++) u64[ARGS / 8 + 1 + i] = a[i]; try { x.nvn_call(id, ARGS); return true; } catch (e) { lastTrap = String(e && e.message || e); return false; } };
  let lastTrap = "";
  const table = new Uint8Array(count), statics = [], argsOf = new Map(), locked = [], relocated = [];
  let free = 0, room = 0, exercised = 0;
  changed();
  for (let ci = 0; ci < cand.length; ci++) {
    const id = cand[ci], A = bufs[4 * ci], B = bufs[4 * ci + 1], P1 = bufs[4 * ci + 2], P2 = bufs[4 * ci + 3];
    const isCmd = /^nvnCommandBuffer/.test(names[id]), wS = new Set(), wG = new Set(); let shared = 0, recorded = !isCmd, traps = 0, ok = 0, good = null;
    for (const mk of PATTERNS) {
      const a = mk(scr), before = isCmd ? pos(A) : 0, l0 = logs;
      if (!run(id, isCmd ? A.c : builder, a)) { traps++; changed(); break; }   // (after a trap the buffer is not trusted)
      // a call the recorder answered with a red line took its error path (made-up arguments): that path writes the log's
      // line buffer and is not what is audited
      if (logs !== l0) { changed(); continue; }
      const ca = changed(), rec = isCmd && pos(A) !== before;
      if (!run(id, isCmd ? B.c : builder2, a)) { traps++; changed(); break; } const cb = changed();
      ok++; if (rec && !good) good = a; if (rec) recorded = true;
      for (const w of ca.static) wS.add(w); for (const w of cb.static) wS.add(w); for (const w of ca.globals) wG.add(w); for (const w of cb.globals) wG.add(w);
      const sb = new Set(cb.arena); for (const w of ca.arena) if (sb.has(w)) shared++;
    }
    if (ok) exercised++;
    let why = "";
    if (!ok) why = traps ? "trapped with made-up arguments (" + lastTrap + ")" : "every argument pattern took the error path";
    else if (traps) why = "trapped with made-up arguments (" + lastTrap + ")";
    else if (!recorded) why = "no argument pattern recorded anything";
    else if (wG.size) why = `writes ${wG.size} words of the globals block (global ${[...wG].map(w => first.globals[(w - GLOBALS) >> 4]?.index).join(", ")})`;
    else if (shared) why = `writes ${shared} arena words that another command buffer's call writes too`;
    else if (wS.size > 8) why = `writes ${wS.size} words of static data`;
    else if (wS.size) {   // the scratch test
      const words = [...wS].sort((p, q) => p - q), a = good ?? PATTERNS[0](scr), fill = (v) => { for (const w of words) u64[w / 8] = v; }, left = () => words.map(w => u64[w / 8]).join(",");
      const one = (buf, v) => { fill(v); const p0 = pos(buf); const okc = run(id, isCmd ? buf.c : builder, a); const p1 = pos(buf); return { okc, bytes: isCmd ? u8.slice(p0, p1).join(",") : "", left: left() }; };
      const r1 = one(P1, 0xA5A5A5A5A5A5A5A5n), r2 = one(P2, 0x5A5A5A5A5A5A5A5An); changed();
      if (!r1.okc || !r2.okc || r1.bytes !== r2.bytes || r1.left !== r2.left) why = `writes static data at ${words.map(w => "0x" + w.toString(16)).join(" ")} that is not scratch (its old content shows in the result)`;
      else { for (const w of words) if (!statics.some(s => s.addr === w)) statics.push({ addr: w, len: 8 }); relocated.push(names[id]); }
    }
    if (why) { locked.push(`${names[id]}: ${why}`); continue; }
    table[id] = st.table[id]; if (table[id] === 1) free++; else room++;
    if (good) argsOf.set(id, good);
  }
  statics.sort((p, q) => p.addr - q.addr);
  for (let i = statics.length - 1; i > 0; i--) if (statics[i - 1].addr + statics[i - 1].len === statics[i].addr) { statics[i - 1].len += statics[i].len; statics.splice(i, 1); }
  return { table, statics, names, args: argsOf, ms: performance.now() - t0, bumpEnd: bump,
    report: { candidates: st.free + st.room, exercised, free, room, relocated, locked, arenaMore: more, watched: regs.map(r => `${r.kind} 0x${r.lo.toString(16)}+${r.hi - r.lo}`).join(", ") } };
}
export function auditLine(d) {
  const r = d.report;
  return `recorder audit, dynamic (tools/gfx_dynaudit.mjs, ${d.ms.toFixed(0)} ms): of ${r.candidates} entry points the static audit lets through, ${r.free} + ${r.room} stay without the lock (the second number while the command buffer has room); ` +
    `${d.statics.length} ranges of static scratch (${d.statics.reduce((n, s) => n + s.len, 0)} bytes: ${d.statics.map(s => "0x" + s.addr.toString(16) + "+" + s.len).join(" ")}) are per thread now, used by ${r.relocated.length} of them (${r.relocated.slice(0, 6).join(", ")}${r.relocated.length > 6 ? ", ..." : ""}); ${r.locked.length} go back under the lock`;
}

if (typeof process !== "undefined" && process.argv && /gfx_dynaudit\.mjs$/.test(process.argv[1] ?? "")) (async () => {
  const { readFileSync } = await import(["node", "fs"].join(":"));
  const { sharedBuild } = await import("../../src/glue/wasm_shared.ts"), { instantiate } = await import("../../src/glue/wasm_abi.ts"), { range } = await import("../../src/glue/rt_layout.ts");
  const d = dynamicAudit(new Uint8Array(readFileSync(`${process.argv[2] ?? "/mnt/build/web/wasm"}/gfx64.wasm`)), { sharedBuild, instantiate, range });
  console.log(auditLine(d)); console.log("watched: " + d.report.watched + "; arena_more calls " + d.report.arenaMore);
  for (const l of d.report.locked) console.log("LOCK  " + l);
  console.log("per thread now, for: " + d.report.relocated.join(" "));
})();
