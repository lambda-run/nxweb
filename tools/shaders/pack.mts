// node tools/shaders/pack.mts <dir of sh-KEY.bin ...> --out <pack root> [--jobs N] [--batch B] [--nosubgroups] [--limit N]
// The shader pack of the current chain: every stage dumped from the game (the page's ?shaderdumpkeys=all posts sh-<key>.bin: u32 control length, control,
// code) translated offline exactly as the page's translator Worker does it (src/shaders/batch.ts), one file a stage, <root>/<chain dir>/<key>.json.gz: the
// gzipped JSON of what the page's shader store holds for it (src/glue/rt_shaders.ts Translated: { wgsl, reflection } or { failed }). The page fetches
// <key>.json.gz on a store miss before it asks its translator (em/owner/owner_web.ts). Incremental: a stage whose file is there and still current
// (src/shaders/passes.ts packEntryCurrent) is not translated again, so after a narrow pass change only the stages that pass touched are.
// --jobs N processes (default: the cores), each with its own .NET runtime, B stages a run of the translator (default 8).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { cpus } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { load } from "./naga_node.mts";
import { translateBatch, type BatchReq } from "../../src/shaders/batch.ts";
import { chainFor } from "../../src/glue/rt_shaders.ts";
import { packEntryCurrent, packDir, failureStamp } from "../../src/shaders/passes.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2), opt = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv.splice(i, 2)[1]; };
const flag = (n: string) => { const i = argv.indexOf(n); return i < 0 ? false : (argv.splice(i, 1), true); };
const out = opt("--out"), jobs = +(opt("--jobs") ?? cpus().length), batchN = +(opt("--batch") ?? 8), limit = +(opt("--limit") ?? 0), child = flag("--child");
const subgroups = !flag("--nosubgroups");
const keyOf = (f: string) => basename(f).replace(/^sh-/, "").replace(/\.bin$/, "");

if (child) {
  // a worker process: the files on stdin's message, answers one line a stage
  const { dotnet } = await import(pathToFileURL(join(ROOT, "build/shaders/xlate_wasm/_framework/dotnet.js")).href);
  const lines: string[] = [];
  const rt = await dotnet.withModuleConfig({ print: (l: string) => lines.push(l), printErr: (l: string) => lines.push(l) }).create();
  rt.Module.FS.mkdir("/w");
  const env = { dotnet: rt, naga: await load(join(ROOT, "build/shaders/nx_naga.wasm")), lines };
  process.on("message", async (m: { files: string[]; dir: string }) => {
    for (let i = 0; i < m.files.length; i += batchN) {
      const reqs: BatchReq[] = m.files.slice(i, i + batchN).map((f, k) => {
        const raw = new Uint8Array(readFileSync(f)), cl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
        return { id: k, key: keyOf(f), control: raw.subarray(4, 4 + cl), code: raw.subarray(4 + cl) };
      });
      const got = new Map<number, any>();
      try { await translateBatch(env, reqs, r => { const x = r as any; got.set(x.id, x); }, { subgroups: subgroups ? "native" : "single" }); }
      catch (e) { for (const r of reqs) if (!got.has(r.id)) got.set(r.id, { error: String((e as Error)?.message ?? e) }); }
      for (const r of reqs) {
        const x = got.get(r.id) ?? { error: "no answer from the batch" };
        const t = x.error !== undefined ? { wgsl: "", reflection: null, failed: x.error, passes: failureStamp() } : { wgsl: x.wgsl, reflection: x.reflection };
        const f = join(m.dir, `${r.key}.json.gz`);
        writeFileSync(f + ".tmp", gzipSync(JSON.stringify(t), { level: 9 })); renameSync(f + ".tmp", f);
        process.send!({ key: r.key, ok: x.error === undefined });
      }
    }
    process.send!({ done: true });
  });
  process.send!({ ready: true });
} else {
  const src = argv[0];
  if (!src || !out) { console.error("usage: node tools/shaders/pack.mts <dir of sh-KEY.bin> --out <pack root> [--jobs N] [--batch B] [--nosubgroups]"); process.exit(2); }
  const chain = chainFor({ subgroups }), dir = join(out, packDir(chain));
  mkdirSync(dir, { recursive: true });
  let files = readdirSync(src).filter(f => /^sh-[0-9a-f]{16}\.bin$/.test(f)).sort().map(f => join(src, f));
  const total = files.length;
  files = files.filter(f => {
    const p = join(dir, `${keyOf(f)}.json.gz`);
    if (!existsSync(p)) return true;
    try { return !packEntryCurrent(JSON.parse(gunzipSync(readFileSync(p)).toString("utf8"))); } catch { return true; }
  });
  if (limit) files = files.slice(0, limit);
  console.log(`pack ${chain}: ${total} stages dumped, ${total - files.length} current in ${dir}, ${files.length} to translate with ${jobs} processes`);
  const t0 = Date.now(); let done = 0, ok = 0;
  const slices = Array.from({ length: Math.max(1, Math.min(jobs, files.length)) }, (_, i) => files.filter((_, k) => k % jobs === i));
  await Promise.all(slices.filter(s => s.length).map(s => new Promise<void>((res, rej) => {
    const c = fork(fileURLToPath(import.meta.url), ["--child", "--batch", String(batchN), ...(subgroups ? [] : ["--nosubgroups"])], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    c.on("message", (m: any) => {
      if (m.ready) c.send({ files: s, dir });
      else if (m.done) { c.kill(); res(); }
      else { done++; if (m.ok) ok++; if (done % 200 === 0) console.log(`  ${done} / ${files.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
    });
    c.on("exit", code => { if (code && code !== 143) rej(new Error(`a pack process exited with ${code}`)); else res(); });
  })));
  console.log(`pack ${chain}: ${done} translated (${ok} ok, ${done - ok} failed) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
