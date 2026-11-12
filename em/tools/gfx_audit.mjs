// gfx_audit.mjs <gfx64.wasm> <names.txt>: which NVN entry points of nxweb's recorder write module-level state.
// For kernel/nx_gfx.c's lock-free path: an entry point may be called without the recorder's lock only if nothing it can
// reach writes a wasm global (those are in the shared memory now: tools/globals_to_memory.mjs) or calls an import.
// Method (static, from the binary as built): the dispatch function is the one with the big br_table (switch (fn));
// the code of case k is what follows the end of the block its label targets, up to the next such end (cases that fall
// through take the next region's too). Per region and per function: the globals set and the functions called; then
// the closure over calls. NOT covered: writes to static MEMORY (scratch buffers at fixed addresses), which a global
// does not show. Output: one line per candidate name (nvnCommandBuffer*, nvn*BuilderSet*): "free" or what it reaches.
import { R, skipImm } from "./globals_to_memory.mjs";
// The audit of a recorder binary (as built, before globals_to_memory): cases = how many ids the switch covers;
// reach(id) = { g: the globals anything the case reaches sets, imps: the imports it reaches } or null (no such case)
export function auditRecorder(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const secs = {}; { const r = new R(b, 8); while (r.p < b.length) { const id = r.u8(), n = r.uleb(); secs[id] = { p: r.p, end: r.p + n }; r.p += n; } }
  let impF = 0, impNames = []; { const r = new R(b, secs[2].p), n = r.uleb(); for (let i = 0; i < n; i++) { r.name(); const nm = r.name(), k = r.u8(); if (k === 0) { r.skipLeb(); impNames.push(nm); impF++; } else if (k === 1) { r.p++; r.limits(); } else if (k === 2) r.limits(); else r.p += 2; } }
  const fns = [];   // per defined function: { gsets:Set, calls:Set, regions?: Map }
  { const r = new R(b, secs[10].p), n = r.uleb();
    for (let f = 0; f < n; f++) {
      const size = r.uleb(), end = r.p + size, ng = r.uleb(); for (let i = 0; i < ng; i++) { r.skipLeb(); r.p++; }
      const F = { gsets: new Set(), calls: new Set(), regions: null }; fns.push(F);
      // find the largest br_table first (a pre-scan), then walk with regions if it is the dispatch
      const start = r.p; let big = 0;
      while (r.p < end) { const op = r.u8(); if (op === 0x0E) { const save = r.p, c = r.uleb(); if (c > big) big = c; r.p = save; } skipImm(r, op, "f" + f); }
      r.p = start;
      let depth = 0, D0 = -1, nest = -1, labels = null, cur = null, seen = false, lastTerm = false;
      const reg = new Map();   // depth index k -> { gsets, calls, falls }
      while (r.p < end) {
        const op = r.u8(); let term = false;
        if (op === 0x02 || op === 0x03 || op === 0x04) depth++;
        if (op === 0x0B) {
          if (seen && depth === nest && depth >= 1) { nest--;   // (only an end of the switch's own nest: a block inside a case's code is deeper than what is left of it)
          if (cur) cur.falls = !lastTerm; cur = { gsets: new Set(), calls: new Set(), edges: new Set(), falls: false, k: depth }; reg.set(depth, cur); }
          depth--;
        }
        if (op === 0x0E && big >= 300 && !seen) { const save = r.p, c = r.uleb(); if (c === big) { labels = []; for (let i = 0; i <= c; i++) labels.push(r.uleb()); D0 = depth; nest = depth; seen = true; } r.p = save; }
        if (op === 0x23 || op === 0x24 || op === 0x10) { const save = r.p, ix = r.uleb(); r.p = save; const T = cur ?? F; if (op === 0x24) T.gsets.add(ix); if (op === 0x10) T.calls.add(ix); }
        // a branch out of a case's code to another block of the switch's nest goes on in that block's region (shared tails)
      if (cur && (op === 0x0C || op === 0x0D)) { const save = r.p, l = r.uleb(); r.p = save; const t = depth - l; if (t >= 1 && t <= nest) cur.edges.add(t); }
      if (cur && op === 0x0E) { const save = r.p, c = r.uleb(); for (let i = 0; i <= c; i++) { const t = depth - r.uleb(); if (t >= 1 && t <= nest) cur.edges.add(t); } r.p = save; }
      if (op === 0x0C || op === 0x0F || op === 0x00) term = true;
        skipImm(r, op, "f" + f); lastTerm = term;
      }
      if (seen) F.regions = { labels, D0, reg };
    } }
  const closure = (g0, c0) => { const g = new Set(g0), imps = new Set(), seenF = new Set(), st = [...c0];
    while (st.length) { const f = st.pop(); if (seenF.has(f)) continue; seenF.add(f); if (f < impF) { imps.add(impNames[f]); continue; } const F = fns[f - impF]; for (const x of F.gsets) g.add(x); for (const c of F.calls) st.push(c); }
    return { g, imps, nfuncs: seenF.size }; };
  const D = fns.find(f => f.regions); if (!D) throw new Error("gfx_audit: no dispatch function (a switch of 300 cases or more) in this module");
  const { labels, D0, reg } = D.regions, ks = [...reg.keys()].sort((a, b) => b - a);   // regions in code order: the innermost block ends first
  const regionOf = k0 => { const g = new Set(), c = new Set(), seenK = new Set(), st = [k0];
    while (st.length) { const k = st.pop(); if (seenK.has(k) || !reg.has(k)) continue; seenK.add(k); const r = reg.get(k);
      for (const x of r.gsets) g.add(x); for (const x of r.calls) c.add(x); for (const e of r.edges) st.push(e);
      if (r.falls) { const i = ks.indexOf(k); if (i + 1 < ks.length) st.push(ks[i + 1]); } }
    return closure(g, c); };
  
  return { cases: labels.length - 1, before: D.gsets, reach: id => { if (id < 0 || id >= labels.length - 1) return null; const k = D0 - labels[id]; return reg.has(k) ? regionOf(k) : null; } };
}
// What the port may call without the recorder's lock (owner/owner.ts): by id, 1 = free (reaches no global write and no
// import), 3 = free while its command buffer has room (it reaches only what the reference recording command reaches:
// the slow path of the record allocator, which kernel/nx_gfx.c keeps out with its room check), 0 = under the lock.
const NOT = /^nvnCommandBuffer(Initialize|Finalize|AddCommandMemory|AddControlMemory|BeginRecording|EndRecording|CallCommands|CopyCommands|SetMemoryCallback|SetMemoryCallbackData|SetDebugLabel|Get|Is|PushDebugGroup|PopDebugGroup|InsertDebugMarker)/;
export function lockFreeTable(bytes, nameOf, count) {
  const a = auditRecorder(bytes), names = []; for (let id = 0; id < count; id++) names.push(nameOf(id));
  const ref = a.reach(names.indexOf("nvnCommandBufferSetScissor")), out = new Uint8Array(count), okImp = new Set(["log", "gfx_guest_call"]);
  const refOk = ref && ref.g.size <= 12 && [...ref.imps].every(i => okImp.has(i));
  let free = 0, room = 0;
  for (let id = 0; id < count; id++) { const n = names[id], isCmd = /^nvnCommandBuffer/.test(n);
    if (!(isCmd || /BuilderSet/.test(n)) || NOT.test(n)) continue;
    const r = a.reach(id); if (!r) continue;
    if (r.g.size === 0 && r.imps.size === 0) { out[id] = 1; free++; }
    else if (isCmd && refOk && [...r.g].every(g => ref.g.has(g)) && [...r.imps].every(i => okImp.has(i))) { out[id] = 3; room++; } }
  return { table: out, free, room, cases: a.cases, refGlobals: ref ? [...ref.g] : [] };
}
if (typeof process !== "undefined" && process.argv && /gfx_audit\.mjs$/.test(process.argv[1] ?? "")) import(["node", "fs"].join(":")).then(({ readFileSync }) => {
  const bytes = new Uint8Array(readFileSync(process.argv[2])), names = readFileSync(process.argv[3], "utf8").split("\n").filter(x => x);
  const t = lockFreeTable(bytes, id => names[id] ?? "", names.length), a = auditRecorder(bytes);
  console.log(`gfx_audit: the dispatch switch has ${t.cases} cases (names.txt: ${names.length}); the reference recording command reaches globals {${t.refGlobals.sort((x, y) => x - y)}}`);
  names.forEach((n, id) => { if (!/^nvnCommandBuffer|BuilderSet/.test(n)) return; const r = a.reach(id);
    console.log(`${["LOCK ", "free ", "", "room "][t.table[id]]} ${n}${t.table[id] === 1 || !r ? "" : `: sets globals {${[...r.g].sort((x, y) => x - y)}}${r.imps.size ? ", imports " + [...r.imps].join(" ") : ""}`}`); });
  console.log(`gfx_audit: ${t.free} free, ${t.room} free while the command buffer has room, the rest under the lock`);
});
