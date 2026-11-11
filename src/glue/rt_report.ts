// nxweb runtime glue: what a page (or a test) shows about a process besides its output, read from the modules and
// never from guest memory: the loaded modules (build id, sizes, unresolved imports by name), the take-overs the game
// refers to, the kit's machines (which transitions were taken, the last step of each, the live state of the main
// ones), and one text block for a bug report. No DOM and no Node APIs.
import type { Runtime } from "./rt_runtime.ts";
import { HOST_FORCE, HOST_UNRESOLVED } from "../loader/host/loader.mts";

// ---- modules ----
export interface ModuleRow { name: string; buildId: string; base: number; imageSize: number; text: number; ro: number; data: number; bss: number; symbols: number; unresolved: string[] }
export interface TakeoverSummary { forcedHit: number; forcedNotReferenced: number; weakUsed: number; unresolved: number; hitNames: string[] }
const hex = (v: number) => "0x" + v.toString(16);
export function moduleRows(rt: Runtime): ModuleRow[] {
  return rt.modules.map(m => {
    let id = Array.from(m.buildId, b => b.toString(16).padStart(2, "0")).join("").replace(/(00)+$/, "");
    if (!id) id = "(none)";
    let unresolved: string[] = [];
    try { unresolved = rt.ld.unresolved(m.handle).map(f => f.name); } catch { /* a module that is being unloaded */ }
    return { name: m.name, buildId: id, base: m.base, imageSize: m.imageSize, text: m.text.size, ro: m.ro.size, data: m.data.size, bss: m.bssSize, symbols: m.symbolCount, unresolved };
  });
}
// What of the host's functions this game's modules refer to: nxnative's "force: N entries hit, M not referenced"
export function takeovers(rt: Runtime): TakeoverSummary {
  const s: TakeoverSummary = { forcedHit: 0, forcedNotReferenced: 0, weakUsed: 0, unresolved: 0, hitNames: [] };
  for (const f of rt.ld.hostFunctions()) {
    if (f.name.startsWith("<")) continue;   // the runtime's own (<rt.start>)
    if (f.kind === HOST_UNRESOLVED) { if (f.refs) s.unresolved++; }
    else if (f.kind === HOST_FORCE) { if (f.refs) { s.forcedHit++; s.hitNames.push(f.name); } else s.forcedNotReferenced++; }
    else if (f.refs) { s.weakUsed++; s.hitNames.push(f.name); }
  }
  return s;
}

// ---- the kit's machines, as the modules of this process have them ----
export interface KitPart { memory?: WebAssembly.Memory; kit_trace_ptr(): number; kit_trace_cap(): number; kit_trace_rec(): number; kit_trace_total(): number;
  kit_refused_total(): number; kit_cover_enable(on: number): void; kit_machine_count(): number; kit_blob_ptr(): number; kit_hits_ptr(): number; kit_hits_size?(): number }
export interface MachineRow {
  name: string; modules: string;          // which modules have stepped it in this process
  states: number; transitions: number; taken: number;   // of its table; how many of them this process has taken (coverage is on)
  steps: number;                          // records of it still in the trace rings (4096 a module)
  last: string;                           // its newest step: "#instance From -Event-> To" (x: refused)
  live: string;                           // the state now, for the machines the embedder can ask (process, focus, audio out, device, ...)
}
const DIR_REC = 16, NONE = 0xff;
// parts: the modules that compile the kit in, by name. live: states the embedder reads from the modules' own exports
export function machineRows(memory: WebAssembly.Memory, parts: { name: string; x: KitPart }[], live: Record<string, string> = {}): MachineRow[] {
  if (!parts.length) return [];
  const mem = new Uint8Array(memory.buffer), dv = new DataView(memory.buffer);
  const first = parts[0].x, n = first.kit_machine_count(), blob0 = first.kit_blob_ptr();
  const rows: MachineRow[] = [], defs: { states: string[]; events: string[] }[] = [];
  for (let id = 0; id < n; id++) {
    const rec = blob0 + id * DIR_REC, nS = mem[rec + 12], nE = mem[rec + 13], tab = blob0 + dv.getUint32(rec, true);
    let p = blob0 + dv.getUint32(rec + 4, true);
    const names: string[] = [];
    for (let i = 0; i < 1 + nS + nE; i++) { names.push(String.fromCharCode(...mem.subarray(p + 1, p + 1 + mem[p]))); p += 1 + mem[p]; }
    let transitions = 0;
    for (let c = 0; c < nS * nE; c++) if (mem[tab + c] !== NONE) transitions++;
    defs.push({ states: names.slice(1, 1 + nS), events: names.slice(1 + nS) });
    rows.push({ name: names[0], modules: "", states: nS, transitions, taken: 0, steps: 0, last: "", live: live[names[0]] ?? "" });
  }
  const lastSeq = new Array<number>(n).fill(-1);
  for (const part of parts) {
    const x = part.x, blob = x.kit_blob_ptr(), hits = x.kit_hits_ptr(), used = new Set<number>();
    for (let id = 0; id < n; id++) {
      const rec = blob + id * DIR_REC, cells = mem[rec + 12] * mem[rec + 13], h = hits + dv.getUint32(rec + 8, true);
      let t = 0; for (let c = 0; c < cells; c++) if (mem[h + c]) t++;
      if (t) { rows[id].taken = Math.max(rows[id].taken, t); used.add(id); }
    }
    const total = x.kit_trace_total() >>> 0, cap = x.kit_trace_cap(), size = x.kit_trace_rec(), base = x.kit_trace_ptr();
    for (let k = Math.max(0, total - cap); k < total; k++) {
      const q = base + (k % cap) * size, id = dv.getUint16(q + 8, true);
      if (id >= n) continue;
      rows[id].steps++; used.add(id);
      // the newest record of a machine: trace sequence numbers are per module, so the later module in the list wins a tie
      const fl = mem[q + 13], d = defs[id];
      lastSeq[id] = k;
      rows[id].last = `#${dv.getUint32(q + 4, true)} ${d.states[mem[q + 10]]} ${fl & 1 ? "x" : "-"}${d.events[mem[q + 12]] ?? "?"}${fl & 1 ? " (refused)" : "-> " + d.states[mem[q + 11]]}`;
    }
    for (const id of used) rows[id].modules += (rows[id].modules ? ", " : "") + part.name;
  }
  return rows;
}
export function refusedTotal(parts: { name: string; x: KitPart }[]): number { return parts.reduce((a, p) => a + (p.x.kit_refused_total() >>> 0), 0); }

// ---- one text block for a bug report ----
export interface ReportInput {
  title: string; when: string; userAgent: string; build?: string;
  adapter: string;                         // the WebGPU adapter and device, or why there is none
  optionsKey: string;                      // the translator's options key (cache version and every code-changing option)
  options: string;                         // the process's options in words (clock, guard, ...)
  state: string; stop: string;             // the process machine's state and what Stopped carries
  fault: string[];                         // the fault's red lines, if any
  modules: ModuleRow[]; takeovers: TakeoverSummary | null;
  machines: MachineRow[];
  counters: Record<string, string | number>;
  log: string[];                           // log lines WITHOUT the guest's own output (that is guest memory)
  redTotal: number;
  fs?: string[];                           // RtFs.lines: the most called nn::fs functions, the last files opened
  hot?: string[];                          // RtRuntime.hotCode: where the guest's time goes, by function
  scan?: string[];                         // the prepare step's instruction scan (a64_scan.ts scanLines): opcode classes, counts, module offsets
}
export function reportText(r: ReportInput): string {
  const out: string[] = [];
  out.push(`${r.title}`, `build: ${r.build ?? "unknown"}`, `when: ${r.when}`, `browser: ${r.userAgent}`, `graphics: ${r.adapter}`, `translator options key: ${r.optionsKey}`, `options: ${r.options}`, "");
  out.push(`process: ${r.state}${r.stop ? " (" + r.stop + ")" : ""}`);
  out.push(r.fault.length ? "fault:" : "fault: none", ...r.fault.map(l => "  " + l), "");
  out.push("modules:");
  for (const m of r.modules) {
    out.push(`  ${m.name}: build id ${m.buildId}, at ${hex(m.base)}, image ${hex(m.imageSize)} (text ${hex(m.text)}, read-only ${hex(m.ro)}, data ${hex(m.data)}, bss ${hex(m.bss)}), ${m.symbols} symbols, ${m.unresolved.length} unresolved import${m.unresolved.length === 1 ? "" : "s"}`);
    for (const u of m.unresolved) out.push(`    unresolved: ${u}`);
  }
  if (!r.modules.length) out.push("  (none loaded)");
  if (r.takeovers) out.push(`take-overs: ${r.takeovers.forcedHit} forced names hit, ${r.takeovers.forcedNotReferenced} not referenced by this program; ${r.takeovers.weakUsed} weak ones fill an import; ${r.takeovers.unresolved} imports unresolved`);
  out.push("", "machines (name: state now | transitions taken of its table | newest step):");
  for (const m of r.machines) if (m.live || m.steps || m.taken) out.push(`  ${m.name}: ${m.live || "-"} | ${m.taken}/${m.transitions} | ${m.last || "-"}${m.modules ? " [" + m.modules + "]" : ""}`);
  out.push(`  (${r.machines.filter(m => !(m.live || m.steps || m.taken)).length} machines of ${r.machines.length} not stepped: ${r.machines.filter(m => !(m.live || m.steps || m.taken)).map(m => m.name).join(", ") || "none"})`, "");
  out.push("counters:", ...Object.entries(r.counters).map(([k, v]) => `  ${k}: ${v}`), "");
  if (r.fs?.length) out.push("nn::fs: the most called functions:", ...r.fs.map(l => "  " + l), "");
  if (r.hot?.length) out.push("where the guest's time goes (the pc each time slice ended at, by function):", ...r.hot.map(l => "  " + l), "");
  if (r.scan) out.push("instructions the translator does not have (static scan of the code modules with its own decoder; opcode classes and offsets, no game data):",
    ...(r.scan.length ? r.scan.map(l => "  " + l) : ["  (no scan: the game was not opened through the prepare step, or its translator binary has no scanner)"]), "");
  out.push(`log: the last ${r.log.length} lines (guest output left out), ${r.redTotal} red in all:`, ...r.log.map(l => "  " + l));
  return out.join("\n") + "\n";
}
