// Joins the shader keys of a pasted nxweb page report (or F9 capture text) with a game profile of nxnative
// (dm/games/<title id>/ of a checkout of github.com/seedds/nxnative, its README says what the files are): each key's
// place in pso_manifest.tsv (the prewarm seed list, written in the order the playtests first met the pipelines) and
// in shader_seen.tsv, so the keys of a black picture can be read in the order the game needs them. nxweb's keys are
// nxnative's (src/shaders/job.ts keyControl is keys_hash's control section); nxnative writes them as "<key>_b", the
// name of the Metal function. Nothing of the profile is kept: it is read from where it is.
//
//   node tools/shaders/firstuse.mts <report.txt> <nxnative>/dm/games/<title id> [--all]
//
// prints the report's keys in the profile's order with their places and what the report said of them (state,
// first frame, skipped work); keys the profile does not have come last. --all also lists the profile's keys before
// the last report key that the report does not mention (those were drawn, or are not needed yet).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ProfileOrder { manifest: Map<string, number>; seen: Map<string, number>; manifestKeys: string[] }
export interface Joined { key: string; manifest: number; seen: number; note: string }

const KEY = /\b([0-9a-f]{16})(?:_b\w*)?\b/g;

// the shader keys of a pso_manifest.tsv in the order they first appear: S (stage) and C (compute) rows name a key, R
// and M rows carry pipeline records whose bytes hold the "<key>_b" names
export function readProfile(dir: string): ProfileOrder {
  const manifest = new Map<string, number>(), seen = new Map<string, number>(), manifestKeys: string[] = [];
  const put = (k: string) => { if (!manifest.has(k)) { manifest.set(k, manifestKeys.length + 1); manifestKeys.push(k); } };
  const mf = join(dir, "pso_manifest.tsv"), sf = join(dir, "shader_seen.tsv");
  if (existsSync(mf)) for (const line of readFileSync(mf, "utf8").split("\n")) {
    if (!line || line[0] === "#") continue;
    const cols = line.split("\t");
    if (cols[0] === "S" || cols[0] === "C") { const m = /^([0-9a-f]{16})/.exec(cols[1] ?? ""); if (m) put(m[1]); continue; }
    for (const c of cols.slice(1)) if (/^[0-9a-f]+$/.test(c) && c.length >= 36 && !(c.length & 1))
      for (const m of Buffer.from(c, "hex").toString("latin1").matchAll(/([0-9a-f]{16})_b/g)) put(m[1]);
  }
  if (existsSync(sf)) for (const line of readFileSync(sf, "utf8").split("\n")) {
    if (!line || line[0] === "#") continue;
    const m = /^([0-9a-f]{16})/.exec(line); if (m && !seen.has(m[1])) seen.set(m[1], seen.size + 1);
  }
  return { manifest, seen, manifestKeys };
}

// a report's keys, each with the rest of its entry ("(frame 3, t 0.05 s, draw #1; skipped 9 draws, 0 dispatches)")
// and the label of its line ("pending", "failed: ...")
export function reportKeys(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(K\s+)?/, ""), colon = line.indexOf(": ");
    const label = colon > 0 ? line.slice(0, colon).replace(/ \(\d+\)$/, "") : "";
    for (const m of line.matchAll(KEY)) {
      if (out.has(m[1])) continue;
      const after = line.slice(m.index! + m[0].length), paren = /^ \(([^)]*)\)/.exec(after);
      out.set(m[1], [label, paren?.[1]].filter(Boolean).join("; "));
    }
  }
  return out;
}

export function join_(keys: Map<string, string>, p: ProfileOrder): Joined[] {
  const rows = [...keys].map(([key, note]) => ({ key, manifest: p.manifest.get(key) ?? 0, seen: p.seen.get(key) ?? 0, note }));
  const rank = (r: Joined) => r.manifest || (r.seen ? 1e9 + r.seen : 2e9);
  return rows.sort((a, b) => rank(a) - rank(b));
}

export function joinLines(keys: Map<string, string>, p: ProfileOrder, all = false): string[] {
  const rows = join_(keys, p), out: string[] = [];
  out.push(`${rows.length} report keys; the profile's manifest names ${p.manifest.size} keys, shader_seen ${p.seen.size}`);
  for (const r of rows) out.push(`${r.manifest ? `manifest #${r.manifest}` : "not in manifest"}\t${r.seen ? `seen #${r.seen}` : "not seen"}\t${r.key}\t${r.note}`);
  if (all) {
    const lastAt = Math.max(0, ...rows.map(r => r.manifest));
    const before = p.manifestKeys.slice(0, lastAt).filter(k => !keys.has(k));
    out.push(`${before.length} manifest keys before #${lastAt} that the report does not name: ${before.join(" ") || "none"}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [report, dir] = process.argv.slice(2).filter(a => !a.startsWith("--"));
  if (!report || !dir) { console.error("usage: node tools/shaders/firstuse.mts <report.txt> <nxnative>/dm/games/<title id> [--all]"); process.exit(2); }
  for (const l of joinLines(reportKeys(readFileSync(report, "utf8")), readProfile(dir), process.argv.includes("--all"))) console.log(l);
}
