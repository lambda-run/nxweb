// The Shaders stage's work: every file the scan reads (shader_scan.ts, in a Worker in the page) gives its stages;
// each new key goes to the in-page translator the runtime uses (src/glue/rt_shaders.ts workerTranslator) and its
// translation into the same store (webShaderStore) under the same id (`<key>/<chain>`), so the game's first bind of
// that stage is a store hit. What is found, translated, failed (by the translator's reason) and not read is counted.
// No DOM or Node API: the page gives the Workers, the tests give stand-ins.
import type { ShaderTranslator, ShaderStore, Translated } from "../../glue/rt_shaders.ts";
import { SCAN_FORMAT, scanFile, emptyScan, MAX_FILE, type FileScan, type FoundStage } from "./shader_scan.ts";
import type { PrepWasm } from "./wasm.ts";

export interface ScanFile { path: string; size: number; module: boolean }
// Where the scans come from: the page's scan Worker, or the scan on this thread (tests, a tree without Blobs)
export interface ShaderScanSource { scan(i: number): Promise<FileScan>; close(): void }
export interface ShaderPrewarm {
  key: string;                                                            // in the stage's input hash
  source(files: ScanFile[]): ShaderScanSource;
  translators: (() => ShaderTranslator[]) | null;                         // null: no in-page translator in this build (scan only)
  store: ShaderStore | null;
  queueBytes?: number;                                                    // stage bytes waiting for a translator before the scan waits (64 MB)
}
export interface Reason { reason: string; count: number; examples: string[] }
export interface PrewarmOut {
  format: number; chain: string | null;
  files: number; bytes: number;
  found: number;                                   // stages (distinct keys)
  byStage: Record<string, number>;
  translated: number;                              // translated now and stored
  cached: number;                                  // already in the store (an earlier run, or the game's)
  failed: number;
  untranslated: number;                            // found, not translated: no translator in this build
  failures: Reason[];                              // the translator's reasons (and the runtime's refusals), examples are keys
  unreadable: Reason[];                            // stage records or wrappers that do not pass the checks, examples are places
  notRead: Reason[];                               // container kinds this scan does not read, examples are files
  containers: FileScan["containers"];
}
export interface PrewarmProgress { filesDone: number; bytesDone: number; found: number; translated: number; failed: number }

const EXAMPLES = 3;
function add(m: Map<string, Reason>, reason: string, example: string): void {
  let r = m.get(reason);
  if (!r) m.set(reason, r = { reason, count: 0, examples: [] });
  r.count++;
  if (r.examples.length < EXAMPLES) r.examples.push(example);
}
const sorted = (m: Map<string, Reason>) => [...m.values()].sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
// a translator's message without what differs from stage to stage (keys, numbers in parentheses, paths of its files)
export const reasonOf = (msg: string) => msg.replace(/\b[0-9a-f]{16}\b/g, "<key>").replace(/\/w\/\S+/g, "<file>").replace(/\(exit -?\d+\)/g, "").replace(/\s+/g, " ").trim();
// What the runtime's RtShaders.register refuses, said the same way
function refused(t: Translated): string | null {
  const r = t.reflection as any;
  if (r?.stage === "compute") return "a compute stage, which src/gfx does not run";
  if (r?.extra?.length) return `bindings src/gfx does not provide: ${r.extra.map((x: any) => x.kind).join(", ")}`;
  return null;
}

export class PrewarmCancelled extends Error {}
export async function prewarm(p: ShaderPrewarm, files: ScanFile[], o: { cancelled: () => boolean; progress: (x: PrewarmProgress) => void; log?: (line: string) => void }): Promise<PrewarmOut> {
  const out: PrewarmOut = { format: SCAN_FORMAT, chain: null, files: 0, bytes: 0, found: 0, byStage: {}, translated: 0, cached: 0, failed: 0, untranslated: 0,
    failures: [], unreadable: [], notRead: [], containers: { bnsh: 0, glslc: 0, sarc: 0, yaz0: 0, zstd: 0 } };
  const failures = new Map<string, Reason>(), unreadable = new Map<string, Reason>(), notRead = new Map<string, Reason>();
  const seen = new Set<string>(), queue: FoundStage[] = [];
  const translators = p.translators?.() ?? [];
  out.chain = translators[0]?.chain ?? null;
  const idle = [...translators], running = new Set<Promise<void>>();
  let queued = 0, stop = false;
  const limit = p.queueBytes ?? 64 << 20;
  const source = p.source(files);
  // a Cancel is looked at while anything is awaited, and ends every wait at once
  let cancel!: (e: Error) => void;
  const cancelled = new Promise<never>((_, rej) => { cancel = rej; });
  cancelled.catch(() => {});
  const poll = setInterval(() => { if (o.cancelled()) { stop = true; cancel(new PrewarmCancelled()); } }, 50);
  const race = <T>(x: Promise<T>) => Promise.race([x, cancelled]);
  const report = () => o.progress({ filesDone: out.files, bytesDone: out.bytes, found: out.found, translated: out.translated + out.cached, failed: out.failed });
  const job = async (tr: ShaderTranslator, s: FoundStage) => {
    const id = `${s.key}/${tr.chain}`;
    let t: Translated | null = null;
    try { t = await p.store?.get(id) ?? null; } catch { t = null; }
    if (t) out.cached++;
    else {
      try { t = await tr.translate({ key: s.key, control: s.control, code: s.code }); }
      catch (e) { if (!stop) { out.failed++; add(failures, reasonOf(e instanceof Error ? e.message : String(e)), s.key); } return; }
      try { await p.store?.put(id, t); } catch (e) { o.log?.(`shader ${s.key}: the translation could not be stored (${e instanceof Error ? e.message : e})`); }
      out.translated++;
    }
    const why = refused(t);
    if (why) { out.failed++; add(failures, why, s.key); }
  };
  const pump = () => {
    while (!stop && idle.length && queue.length) {
      const tr = idle.pop()!, s = queue.shift()!;
      const r: Promise<void> = job(tr, s).finally(() => { queued -= s.control.length + s.code.length; idle.push(tr); running.delete(r); report(); pump(); });
      running.add(r);
    }
  };
  try {
    for (let i = 0; i < files.length; i++) {
      if (o.cancelled()) throw new PrewarmCancelled();
      while (queued > limit && running.size) await race(Promise.race(running));
      const f = await race(source.scan(i));
      out.files++; out.bytes += files[i].size;
      for (const u of f.unreadable) add(unreadable, u.reason, u.where);
      for (const k of f.notRead) add(notRead, k, f.path);
      for (const [k, v] of Object.entries(f.containers)) out.containers[k as keyof PrewarmOut["containers"]] += v;
      for (const s of f.stages) {
        if (seen.has(s.key)) continue;
        seen.add(s.key); out.found++; out.byStage[s.stage] = (out.byStage[s.stage] ?? 0) + 1;
        if (!translators.length) { out.untranslated++; continue; }
        queue.push(s); queued += s.control.length + s.code.length;
      }
      pump(); report();
    }
    while (running.size || queue.length) { pump(); if (running.size) await race(Promise.race(running)); }
  } catch (e) {
    stop = true;
    for (const t of translators) t.close?.();
    throw e;
  } finally {
    clearInterval(poll);
    source.close();
  }
  for (const t of translators) t.close?.();
  out.failures = sorted(failures); out.unreadable = sorted(unreadable); out.notRead = sorted(notRead);
  report();
  return out;
}

// The scan on this thread: a tree's reads and the prepare module's BNSH reader (tests; a tree that cannot give a
// Worker its files)
export function threadSource(w: PrepWasm, read: (path: string, size: number) => Promise<Uint8Array>): (files: ScanFile[]) => ShaderScanSource {
  return files => ({
    async scan(i) {
      const f = files[i];
      if (f.size > MAX_FILE) { const r = emptyScan(f.path, f.size); r.notRead.push(`files over ${MAX_FILE >> 20} MB (not read whole)`); return r; }
      let d: Uint8Array;
      try { d = await read(f.path, f.size); } catch (e) { const r = emptyScan(f.path, f.size); r.unreadable.push({ reason: `the file could not be read`, where: `${f.path}: ${(e as Error).message}` }); return r; }
      return scanFile(w, f.path, d, { module: f.module });
    },
    close() {},
  });
}
