// npm run shaders:sweep -- <game.nup | game folder> [--out DIR] [--jobs N] [--timeout S] [--only KEY,...] [--version N]
//                          [--keep-binaries] [--fresh]
// Every shader stage of a game through the page's chain, one stage at a time in worker processes: the files the Prepare
// page's Shaders stage scans (exefs/main and the RomFS and add-on RomFS of the chosen version), found by
// src/prepare/host/shader_scan.ts the same way (BNSH, GLSLC, SARC, Yaz0, zstd, NVN2 control sections, NDSR and NDVE
// packs), each distinct key translated once: jobFor, the translator (build/shaders/xlate_wasm), fixForWgsl, naga.
// A failure, a crash of the process or a stage over --timeout seconds is a result; the sweep goes on.
// DIR/results.json and DIR/summary.md hold keys, stages, the places in the game's files, timings and errors, and no
// byte of the game; DIR/records/ (control, code, SPIR-V, WGSL of each stage) is written only with --keep-binaries.
// A .nup is read in place (src/prepare/host/nup_node.ts): the TOC, then the files the scan reads, one at a time.
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { NupTree } from "../../src/prepare/host/nup.ts";
import { nodeBytes } from "../../src/prepare/host/nup_node.ts";
import { NodeTree } from "../../src/prepare/host/tree_node.ts";
import { isJunk, type PrepTree } from "../../src/prepare/host/tree.ts";
import { detectLayout, pickVersion } from "../../src/prepare/host/detect.ts";
import { reasonOf, threadSource, type ScanFile } from "../../src/prepare/host/shader_prewarm.ts";
import type { FoundStage, ShaderStage } from "../../src/prepare/host/shader_scan.ts";
import { SHADER_CHAIN } from "../../src/glue/rt_shaders.ts";
import type { Phase, SweepJob, SweepReply } from "./sweep_worker.mts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const SWEEP_FORMAT = 1;
export type Status = "ok" | "failed" | "crash" | "timeout";
export interface SweepRecord {
  key: string; stage: ShaderStage; where: string; seen: number;    // seen: places the same key was found (where is the first)
  status: Status; phase?: Phase; error?: string; category?: string;
  translateMs: number; fixMs: number; nagaMs: number;
  runtime?: string;                // an ok stage the runtime would still refuse (a compute stage, a binding src/gfx lacks)
  controlBytes: number; codeBytes: number;
}
export interface SweepResults {
  format: number; tool: string; chain: string; input: string; version: number;
  options: { jobs: number; timeoutS: number; only: string[] | null; keepBinaries: boolean; fresh: boolean };
  scan: { files: number; bytes: number; unreadable: { reason: string; where: string }[]; notRead: { reason: string; where: string }[];
    containers: Record<string, number> };
  counts: Record<Status, number>;
  categories: { category: string; count: number; examples: string[] }[];
  shaders: SweepRecord[];
  finished: boolean; seconds: number;
}

const USAGE = "npm run shaders:sweep -- <game.nup | game folder> [--out DIR] [--jobs N] [--timeout S] [--only KEY,...] [--version N] [--keep-binaries] [--fresh]";
function fail(msg: string): never { process.stderr.write(`shaders:sweep: ${msg}\n`); process.exit(2); }

function args(argv: string[]) {
  const o = { input: "", out: "shader-sweep", jobs: Math.max(1, Math.min(8, availableParallelism() - 1)), timeout: 60, only: null as string[] | null,
    version: undefined as number | undefined, keep: false, fresh: false,
    framework: join(ROOT, "build/shaders/xlate_wasm/_framework"), naga: join(ROOT, "build/shaders/nx_naga.wasm"), prepare: join(ROOT, "build/prepare/prepare.wasm") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) fail(`${a} needs a value\n${USAGE}`); return argv[++i]; };
    const num = (s: string, min: number) => { const n = Number(s); if (!Number.isFinite(n) || n < min) fail(`${a} ${s}: not a number >= ${min}`); return n; };
    if (a === "--out") o.out = v();
    else if (a === "--jobs") o.jobs = Math.floor(num(v(), 1));
    else if (a === "--timeout") o.timeout = num(v(), 0.1);
    else if (a === "--only") o.only = v().split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    else if (a === "--version") o.version = Math.floor(num(v(), 0));
    else if (a === "--keep-binaries") o.keep = true;
    else if (a === "--fresh") o.fresh = true;
    else if (a === "--framework") o.framework = resolve(v());
    else if (a === "--naga") o.naga = resolve(v());
    else if (a === "-h" || a === "--help") { process.stdout.write(USAGE + "\n"); process.exit(0); }
    else if (a.startsWith("--")) fail(`unknown option ${a}\n${USAGE}`);
    else if (!o.input) o.input = a;
    else fail(`one game at a time (${a})\n${USAGE}`);
  }
  if (!o.input) fail(USAGE);
  return o;
}

// The first line of an error, with long hexadecimal runs (instruction words, addresses) masked so no code byte travels
export const firstLine = (s: string) => {
  const l = (s.split(/\r?\n/).find(x => x.trim()) ?? "").trim().replace(/\b(0x)?[0-9a-fA-F]{17,}\b/g, "<hex>");
  return l.length > 300 ? l.slice(0, 297) + "..." : l;
};
// One category for errors that differ only in numbers: reasonOf (keys, translator file names, exit codes), then numbers
export const categoryOf = (phase: string, msg: string) =>
  `${phase}: ${reasonOf(firstLine(msg)).replace(/\b0x[0-9a-fA-F]+\b/g, "0x#").replace(/\b\d+(\.\d+)?\b/g, "#")}`;

interface Worker { child: ChildProcess; ready: Promise<void>; tail: string[]; exited: { code: number | null; signal: string | null } | null }
function startWorker(o: ReturnType<typeof args>): Worker {
  const child = fork(join(ROOT, "tools/shaders/sweep_worker.mts"), [], {
    serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, SWEEP_FRAMEWORK: o.framework, SWEEP_NAGA: o.naga },
  });
  const w: Worker = { child, tail: [], exited: null, ready: null! };
  child.stderr!.setEncoding("utf8");
  let part = "";
  child.stderr!.on("data", (s: string) => {
    const ls = (part + s).split("\n"); part = ls.pop()!;
    for (const l of ls) if (l.trim()) { w.tail.push(l.trim()); if (w.tail.length > 40) w.tail.shift(); }
  });
  w.ready = new Promise((res, rej) => {
    const onMsg = (m: any) => { if (m?.ready) { child.off("message", onMsg); res(); } };
    child.on("message", onMsg);
    child.once("exit", (code, signal) => { w.exited = { code, signal }; rej(new Error(`the worker stopped while starting (${signal ?? `exit ${code}`}): ${w.tail.slice(-3).join(" | ")}`)); });
  });
  w.ready.catch(() => {});
  return w;
}
function stopWorker(w: Worker) { if (!w.exited) { try { w.child.kill("SIGKILL"); } catch {} } }

// One stage on a worker: its reply, or a timeout (the worker is killed), or a crash (the worker died)
function runOn(w: Worker, job: SweepJob, timeoutMs: number): Promise<{ reply?: SweepReply; status?: "timeout" | "crash"; error?: string; ms: number }> {
  return new Promise(res => {
    const t0 = performance.now();
    const done = (r: { reply?: SweepReply; status?: "timeout" | "crash"; error?: string }) => {
      clearTimeout(timer); w.child.off("message", onMsg); w.child.off("exit", onExit); res({ ...r, ms: performance.now() - t0 });
    };
    const onMsg = (m: any) => { if (m?.key === job.key) done({ reply: m }); };
    const onExit = (code: number | null, signal: string | null) => {
      w.exited = { code, signal };
      const why = w.tail.filter(l => !/^at |^#\d|^\d+: /.test(l) && /error|exception|abort|fatal|out of memory/i.test(l)).slice(-1)[0];
      done({ status: "crash", error: `the worker process died (${signal ?? `exit ${code}`})${why ? `: ${why}` : ""}` });
    };
    const timer = setTimeout(() => { w.child.off("exit", onExit); stopWorker(w); w.exited ??= { code: null, signal: "SIGKILL" }; done({ status: "timeout", error: `over ${timeoutMs / 1000} s` }); }, timeoutMs);
    w.child.on("message", onMsg);
    w.child.once("exit", onExit);
    w.child.send(job);
  });
}

async function openTree(input: string, w: PrepWasm): Promise<{ tree: PrepTree; close(): void }> {
  if (!existsSync(input)) fail(`${input}: no such file or folder`);
  if (statSync(input).isDirectory()) return { tree: new NodeTree(input), close() {} };
  const bytes = nodeBytes(input);
  try { return { tree: await NupTree.open(bytes, basename(input), { sha256: b => w.sha256(b) }), close: () => bytes.close() }; }
  catch (e) { bytes.close(); fail(`${basename(input)}: not a NUP container this page reads (${(e as Error).message})`); }
}

function writeAtomic(path: string, data: string | Uint8Array) { writeFileSync(path + ".tmp", data); renameSync(path + ".tmp", path); }

export function summarise(r: SweepResults): string {
  const ms = (n: number) => n.toFixed(1);
  const out = [`# Shader sweep: ${r.input}`, "",
    `${r.shaders.length} distinct stages, chain \`${r.chain}\`, version ${r.version}, ${r.scan.files} files scanned (${(r.scan.bytes / 2 ** 20).toFixed(1)} MiB), ${r.seconds.toFixed(1)} s${r.finished ? "" : " (not finished)"}.`,
    `Options: --jobs ${r.options.jobs} --timeout ${r.options.timeoutS}${r.options.only ? ` --only ${r.options.only.join(",")}` : ""}${r.options.fresh ? " --fresh" : ""}${r.options.keepBinaries ? " --keep-binaries" : ""}.`, "",
    "| status | stages |", "|---|---:|", ...(["ok", "failed", "crash", "timeout"] as Status[]).map(s => `| ${s} | ${r.counts[s]} |`), ""];
  const stages = new Map<string, Record<Status, number>>();
  for (const s of r.shaders) { const c = stages.get(s.stage) ?? { ok: 0, failed: 0, crash: 0, timeout: 0 }; c[s.status]++; stages.set(s.stage, c); }
  out.push("| stage | ok | failed | crash | timeout |", "|---|---:|---:|---:|---:|", ...[...stages].sort().map(([k, c]) => `| ${k} | ${c.ok} | ${c.failed} | ${c.crash} | ${c.timeout} |`), "");
  out.push("## Errors by category", "");
  if (!r.categories.length) out.push("None.", "");
  else out.push("| count | category | examples |", "|---:|---|---|", ...r.categories.map(c => `| ${c.count} | ${c.category.replace(/\|/g, "\\|")} | ${c.examples.join(" ")} |`), "");
  const refused = new Map<string, number>();
  for (const s of r.shaders) if (s.runtime) refused.set(s.runtime, (refused.get(s.runtime) ?? 0) + 1);
  if (refused.size) out.push("## Translated, but the runtime refuses", "", "| count | reason |", "|---:|---|", ...[...refused].sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${n} | ${k} |`), "");
  const total = (s: SweepRecord) => s.translateMs + s.fixMs + s.nagaMs;
  out.push("## Slowest 20", "", "| key | stage | status | translate ms | fix ms | naga ms | where |", "|---|---|---|---:|---:|---:|---|",
    ...[...r.shaders].sort((a, b) => total(b) - total(a)).slice(0, 20).map(s => `| ${s.key} | ${s.stage} | ${s.status} | ${ms(s.translateMs)} | ${ms(s.fixMs)} | ${ms(s.nagaMs)} | ${s.where} |`), "");
  if (r.scan.unreadable.length || r.scan.notRead.length) {
    out.push("## Not scanned", "", ...[...r.scan.unreadable, ...r.scan.notRead].slice(0, 50).map(u => `- ${u.reason}: ${u.where}`));
    if (r.scan.unreadable.length + r.scan.notRead.length > 50) out.push(`- ... ${r.scan.unreadable.length + r.scan.notRead.length - 50} more in results.json`);
    out.push("");
  }
  return out.join("\n");
}

async function main() {
  const o = args(process.argv.slice(2));
  for (const [p, how] of [[o.prepare, "npm run prepare:build"], [o.naga, "npm run shaders:naga"], [join(o.framework, "dotnet.js"), "npm run shaders:xlate-wasm"]])
    if (!existsSync(p)) fail(`${p} is missing: run "${how}" (or "npm run shaders:sweep:setup" for all three; tools/shaders/README.md)`);
  const t0 = performance.now();
  const pw = new PrepWasm(new WebAssembly.Module(readFileSync(o.prepare)));
  const { tree, close } = await openTree(resolve(o.input), pw);

  // The files the Prepare page's Shaders stage scans (prepare.ts): exefs/main as a module, the RomFS and add-on RomFS
  const l = await tree.list(), layout = detectLayout(l);
  let ver;
  try { ver = pickVersion(layout, o.version); } catch (e) { fail((e as Error).message); }
  const exefs = ver.root + "exefs/", roots = [ver.root + "romfs/", ...layout.dlc.flatMap(d => d.roms.map(r => r + "/"))];
  const files: ScanFile[] = [...l.files.filter(f => f.path === exefs + "main").map(f => ({ path: f.path, size: f.size, module: true })),
    ...l.files.filter(f => roots.some(r => f.path.startsWith(r)) && !isJunk(f.path)).map(f => ({ path: f.path, size: f.size, module: false }))];
  const source = threadSource(pw, (p, size) => tree.read(p, 0, size))(files);

  const out = resolve(o.out), recs = join(out, "records");
  mkdirSync(out, { recursive: true });
  if (o.keep) mkdirSync(recs, { recursive: true });
  const only = o.only ? new Set(o.only) : null;
  const results: SweepResults = {
    format: SWEEP_FORMAT, tool: "nxweb shaders:sweep", chain: SHADER_CHAIN, input: basename(resolve(o.input)), version: ver.version,
    options: { jobs: o.jobs, timeoutS: o.timeout, only: o.only, keepBinaries: o.keep, fresh: o.fresh },
    scan: { files: 0, bytes: 0, unreadable: [], notRead: [], containers: { bnsh: 0, glslc: 0, sarc: 0, yaz0: 0, zstd: 0 } },
    counts: { ok: 0, failed: 0, crash: 0, timeout: 0 }, categories: [], shaders: [], finished: false, seconds: 0,
  };
  const byKey = new Map<string, SweepRecord>();
  const flush = () => {
    results.seconds = (performance.now() - t0) / 1000;
    results.shaders.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const cats = new Map<string, { category: string; count: number; examples: string[] }>();
    for (const s of results.shaders) if (s.category) {
      const c = cats.get(s.category) ?? { category: s.category, count: 0, examples: [] };
      c.count++; if (c.examples.length < 5) c.examples.push(s.key); cats.set(s.category, c);
    }
    results.categories = [...cats.values()].sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1));
    writeAtomic(join(out, "results.json"), JSON.stringify(results, null, 1) + "\n");
  };

  // The queue between the scan (this thread) and the workers, bounded so a large game's stages are not all held at once
  const queue: FoundStage[] = [], cap = o.jobs * 4, idle: (() => void)[] = [];
  const wake = () => { for (const f of idle.splice(0)) f(); };
  let scanned = false, room: (() => void) | null = null, done = 0;
  const progress = () => { if (process.stderr.isTTY) process.stderr.write(`\r${results.scan.files}/${files.length} files, ${byKey.size} stages, ${done} swept (${results.counts.failed} failed, ${results.counts.crash} crash, ${results.counts.timeout} timeout)  `); };
  const tick = setInterval(() => { progress(); flush(); }, 10_000);

  const scan = (async () => {
    for (let i = 0; i < files.length; i++) {
      const f = await source.scan(i);
      results.scan.files++; results.scan.bytes += f.bytes;
      results.scan.unreadable.push(...f.unreadable);
      results.scan.notRead.push(...f.notRead.map(reason => ({ reason, where: f.path })));
      for (const [k, n] of Object.entries(f.containers)) results.scan.containers[k] = (results.scan.containers[k] ?? 0) + n;
      for (const s of f.stages) {
        const seen = byKey.get(s.key);
        if (seen) { seen.seen++; continue; }
        if (only && !only.has(s.key)) continue;
        const r: SweepRecord = { key: s.key, stage: s.stage, where: s.where, seen: 1, status: "failed", translateMs: 0, fixMs: 0, nagaMs: 0, controlBytes: s.control.length, codeBytes: s.code.length };
        byKey.set(s.key, r); results.shaders.push(r);
        if (o.keep) { writeFileSync(join(recs, `${s.key}.${s.stage}.ctl`), s.control); writeFileSync(join(recs, `${s.key}.${s.stage}.code`), s.code); }
        queue.push(s); wake();
        while (queue.length >= cap) await new Promise<void>(r => (room = r));
      }
      progress();
    }
    scanned = true; wake();
  })();

  const lane = async () => {
    let w: Worker | null = null;
    try {
      for (;;) {
        const s = queue.shift();
        if (!s) { if (scanned) break; await new Promise<void>(r => idle.push(r)); continue; }
        room?.(); room = null;
        const r = byKey.get(s.key)!;
        for (let attempt = 0; ; attempt++) {
          if (!w || w.exited) w = startWorker(o);
          try { await w.ready; break; } catch (e) { w = null; if (attempt >= 2) throw e; }
        }
        const got = await runOn(w, { key: s.key, control: s.control, code: s.code, keep: o.keep }, o.timeout * 1000);
        if (got.reply) {
          const p = got.reply;
          r.translateMs = p.translateMs; r.fixMs = p.fixMs; r.nagaMs = p.nagaMs;
          if (p.ok) { r.status = "ok"; if (p.refused) r.runtime = p.refused; }
          else { r.status = "failed"; r.phase = p.phase; r.error = firstLine(p.error ?? ""); r.category = categoryOf(p.phase ?? "translate", p.error ?? ""); }
          if (o.keep && p.spv) writeFileSync(join(recs, `${s.key}.${s.stage}.spv`), p.spv);
          if (o.keep && p.wgsl) writeFileSync(join(recs, `${s.key}.${s.stage}.wgsl`), p.wgsl);
          if (p.restart || o.fresh) { stopWorker(w); w = null; }
        } else {
          r.status = got.status!; r.phase = "translate"; r.translateMs = got.ms; r.error = firstLine(got.error ?? "");
          r.category = got.status === "timeout" ? `timeout: over ${o.timeout} s` : categoryOf("crash", (got.error ?? "").replace(/\(exit -?\d+\)/, "(exit)"));
          w = null;
        }
        results.counts[r.status]++; done++;
      }
    } finally { if (w) stopWorker(w); }
  };
  try {
    await Promise.all([scan, ...Array.from({ length: o.jobs }, lane)]);
  } finally { clearInterval(tick); close(); }
  results.finished = true;
  flush();
  writeAtomic(join(out, "summary.md"), summarise(results) + "\n");
  if (process.stderr.isTTY) process.stderr.write("\n");
  const c = results.counts;
  process.stdout.write(`shaders:sweep: ${results.shaders.length} stages: ${c.ok} ok, ${c.failed} failed, ${c.crash} crash, ${c.timeout} timeout; ${results.scan.unreadable.length + results.scan.notRead.length} places not scanned\n` +
    `  ${join(out, "results.json")}\n  ${join(out, "summary.md")}${o.keep ? `\n  ${recs}/ (shader bytes: keep private)` : ""}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
