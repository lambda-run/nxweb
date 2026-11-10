// npm run audit64: no address goes through 32 bits (docs/CONTRACT.md, "Addresses").
//
// Both memory modes are built from one source, and a wasm64 build does not widen what the source narrows: an address
// cast to u32, kept in a 4-byte slot, or passed through one of JavaScript's 32-bit operators is cut silently above
// 4 GB. This lists every place in src/ and web/ where that could happen:
//   AssemblyScript   <u32> / <i32> casts, load<u32> / load<i32> / store<u32> / store<i32> (a pointer read back from a
//                    4-byte slot, <usize>load<u32>(..), is a site of its own), `& 0xFFFFFFFF`
//   TypeScript glue  >>> >> << & | ^ ~ on numbers, Uint32Array / Int32Array, DataView get/setUint32 / Int32
// and compares the list with tools/audit64.allow, the reviewed sites. A site is its file and the expression (the cast
// with its operand, the call with its arguments), not its line number, so moving code does not disturb the list;
// writing a new cast, or changing the operand of a reviewed one, does. The run fails on any site that is not on the
// list, and on a list entry of class "?" (found by --update, not yet reviewed).
//
//   node tools/audit64.mjs            check; prints the totals per area and class
//   node tools/audit64.mjs --list     every site with its class
//   node tools/audit64.mjs --update   add the unknown sites to the list with the class the rules below suggest
//                                     ("?" where they see an address-like operand: those must be reviewed by a
//                                     person and given a class and, for class A, the reason) and drop stale entries
//
// Classes (the second column of the list; the reason of a class is its line in CLASSES):
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOW = join(ROOT, "tools", "audit64.allow");
export const CLASSES = {
  D: "32-bit data at an address: a field the format or the Switch ABI fixes at 4 bytes is read or written; the value is not an address",
  C: "a value that is not an address is cast: a count, index, id, handle, flag, character, colour, enum, or a size the format bounds below 4 GB",
  H: "a pointer into the host area (a module's static data, or its arena when that is a range of the layout table): below 0x0800_0000 in both memory modes",
  O: "an offset inside one file, image, record or arena (bounded by its size, below 4 GB), added to a usize base",
  W: "the documented wrap: memory32 wraps a guest register to 32 bits, and this site does it only in that build (the wasm64 build takes the other branch)",
  B: "glue: a bit operation on a value that is not an address (flags, pixels, hashes, instruction words, BigInt arithmetic, a count)",
  V: "glue: 32-bit data read or written at an address (DataView / typed array over a field that is 4 bytes); the value is not an address",
  S: "glue: an index or size inside the host area or inside one small buffer (below 2 GB by the layout table)",
  A: "reviewed one by one: the reason is on the entry",
  "?": "NOT REVIEWED: found by --update where the rules see an address-like operand",
};
// Whole trees that are not audited site by site, with the reason
export const OUT_OF_SCOPE = [
  ["src/a64/", "the translator, done in phase 1: instruction words and immediates are 32 bits by the architecture; its own gates run it with code and data above 4 GB (npm run a64:guests, a64:fuzz)"],
  ["src/prepare/", "the prepare step's module has a memory of its own (wasm32, below 4 GB by construction) and never holds a guest address of the running process"],
  ["src/kit/", "the state machine kit: ids, table offsets and trace records in a module's static data"],
  ["src/shaders/", "SPIR-V words"],
  ["/gen/", "generated tables"],
  ["/names.ts", "generated name tables"],
  ["src/glue/wasm_abi.ts", "the one place where addresses are converted: its >>> 0 is the wasm32 build's result of an address"],
  ["src/glue/a64_host.ts", "the translator's glue, done in phase 1 (mem64 throughout; its 32-bit operations are on instruction words, table indices and the memory32 pc map)"],
];

const AS_DIRS = ["src/kernel", "src/loader", "src/runtime", "src/hle", "src/fs", "src/audio", "src/gfx"];
const TS_DIRS = ["src/glue", "src/loader/host", "src/hle/host", "src/gfx/host", "src/runtime/host", "web"];

function files(dir, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const f of readdirSync(abs).sort()) {
    const p = join(dir, f), st = statSync(join(ROOT, p));
    if (st.isDirectory()) { if (f !== "defs" && f !== "node_modules") files(p, out); }
    else if (/\.(ts|mts)$/.test(f) && !/\.d\.ts$/.test(f)) out.push(p);
  }
  return out;
}
const skipped = p => OUT_OF_SCOPE.find(([s]) => p.includes(s));
// the source without comments and string contents (same length, so positions hold)
function strip(src) {
  let out = "", i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") { out += " "; i++; } }
    else if (c === "/" && d === "*") { while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; } out += "  "; i += 2; }
    else if (c === '"' || c === "'" || c === "`") {
      out += c; i++;
      while (i < n && src[i] !== c) { if (src[i] === "\\") { out += "  "; i += 2; continue; } out += src[i] === "\n" ? "\n" : c === "`" && src[i] === "$" && src[i + 1] === "{" ? "$" : " "; i++; }
      out += c; i++;
    } else { out += c; i++; }
  }
  return out;
}
// the expression that starts at `at`: up to its closing bracket, or to the next separator at depth 0 (at most 96 characters)
function expr(s, at) {
  let depth = 0, i = at, seenOpen = false;
  for (; i < s.length && i - at < 96; i++) {
    const c = s[i];
    if (c === "(" || c === "[") { depth++; seenOpen = true; }
    else if (c === ")" || c === "]") { if (depth === 0) break; depth--; if (depth === 0 && seenOpen && /[\s,;)\]]|$/.test(s[i + 1] ?? "")) { i++; break; } }
    else if (depth === 0 && (c === "," || c === ";" || c === "\n" || c === "{" || c === "}")) break;
  }
  return s.slice(at, i).replace(/\s+/g, " ").trim();
}
const AS_RE = /<usize>\s*load<[ui]32>\(|changetype<\w+>\(\s*load<[ui]32>\(|<[ui]32>|\b(?:load|store)<[ui]32>\(|&\s*0x[fF]{8}\b/g;
const TS_RE = />>>=?|>>=?|<<=?|(?<![&|])&(?![&=|])|(?<![|&])\|(?![|=&])|\^|~|\b(?:Ui|I)nt32Array\b|\b[gs]et(?:Ui|I)nt32\b/g;

// The names of a file that hold 64 bits: declared usize or u64 (a parameter, a local, a field), or initialized from
// something that gives a register, a pointer or an 8-byte load. Not scope-aware: one such declaration anywhere in the
// file makes every use of the name a 64-bit one, which errs on the side of asking for a review.
function wideNames(s) {
  const names = new Set();
  for (const m of s.matchAll(/\b([A-Za-z_]\w*)\s*:\s*(?:usize|u64|i64|isize)\b/g)) names.add(m[1]);
  for (const m of s.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:(?:P|X|X8|gp|LR|arenaAlloc|alloc|changetype<usize>|load<[ui]64>)\(|<(?:usize|u64)>)/g)) names.add(m[1]);
  return names;
}
function scanAS(path, src) {
  const s = strip(src), sites = [], wide = wideNames(s);
  for (const m of s.matchAll(AS_RE)) sites.push({ file: path, line: s.slice(0, m.index).split("\n").length, text: expr(s, m.index), kind: "as", wide });
  return sites;
}
function scanTS(path, src) {
  const s = strip(src), sites = [], lines = s.split("\n");
  // one site per line and operator kind: the line, trimmed (the glue's lines are statements)
  lines.forEach((l, i) => {
    const t = l.replace(/=>/g, "  ");   // an arrow is not a comparison or a shift
    // `|` and `&` between types (unions, intersections) are not operators on values: lines of an interface or a type
    if (/^\s*(?:export\s+)?(?:type|interface)\b/.test(t)) return;
    const typeish = t.replace(/:\s*[\w<>\[\]., |&"'`?()=]+?(?=[,;)={]|$)/g, m => m.replace(/[|&]/g, " ")).replace(/\bas\s+[\w<>\[\]., |&]+/g, m => m.replace(/[|&]/g, " ")).replace(/<[\w\s,|&\[\]"'.]+>(?=\()/g, m => m.replace(/[|&]/g, " "));
    const ops = [...new Set([...typeish.matchAll(TS_RE)].map(m => m[0]))];
    if (ops.length) sites.push({ file: path, line: i + 1, text: l.replace(/\s+/g, " ").trim().slice(0, 160), kind: "ts", ops });
  });
  return sites;
}
// Whether an expression may carry 64 bits: it names a register or pointer accessor, an 8-byte load or a widening
// cast, or a name that is 64 bits somewhere in the file. Calls of anything else (and loads of 1, 2 or 4 bytes) count
// as what they return, not as their arguments; of `a.b.c` only the last name counts (the field, not the record).
const WIDE_CALL = /\b(?:P|X|X8|gp|LR|arenaAlloc|changetype<usize>|load<[ui]64>|<usize>|<u64>|<i64>)\s*\(?/;
function mayBeWide(op, wide) {
  let e = op;
  for (let k = 0; k < 12; k++) {
    const next = e.replace(/\b([A-Za-z_][\w.]*(?:<[^<>()]*>)?)\(([^()]*)\)/g, (all, callee) => /^(?:P|X|X8|gp|LR|arenaAlloc|changetype<usize>|load<[ui]64>)$/.test(callee) ? " WIDE " : " 0 ");
    if (next === e) break;
    e = next;
  }
  if (/\bWIDE\b|<usize>|<u64>|<i64>|__heap_base/.test(e)) return true;
  for (const m of e.matchAll(/(?<![.\w])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?!\s*[(<\w])/g)) { const last = m[1].split(".").pop(); if (wide.has(last)) return true; }
  return false;
}
// the arguments of a call whose text starts after its "(": split at the commas of depth 0, up to the closing bracket
function topLevelArgs(s) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") { if (depth === 0) { out.push(s.slice(from, i)); return out; } depth--; }
    else if (c === "," && depth === 0) { out.push(s.slice(from, i)); from = i + 1; }
  }
  out.push(s.slice(from));   // the expression was cut at 96 characters
  return out;
}
// the class the rules suggest for a site nobody reviewed: "?" wherever an address may be involved
function suggest(site) {
  const t = site.text;
  if (site.kind === "as") {
    if (/^&\s*0x[fF]{8}/.test(t)) return "?";
    if (/^<usize>\s*load<[ui]32>\(|^changetype<\w+>\(\s*load<[ui]32>\(/.test(t)) return "?";   // a pointer kept in a 4-byte slot
    if (/^(?:load)<[ui]32>\(/.test(t)) return "D";
    if (/^store<[ui]32>\(/.test(t)) {
      // what is stored: the second argument. A 64-bit name or a narrowed 64-bit value in it is for a person to look at
      const args = topLevelArgs(t.slice(t.indexOf("(") + 1));
      return args.length < 2 || mayBeWide(args[1], site.wide) ? "?" : "D";
    }
    // a cast: of what? Anything that is, or is computed from, a 64-bit name, a register or an 8-byte load is for a
    // person to look at; a cast of a narrower load, a literal or a name that is 32 bits everywhere in the file is not
    const op = t.replace(/^<[ui]32>\s*/, "");
    return mayBeWide(op, site.wide) ? "?" : "C";
  }
  if (site.ops.some(o => /Array|et(?:Ui|I)nt32/.test(o))) return /Array/.test(t) && /addr|ptr|entries|pcs|base/.test(t) ? "?" : "V";
  if (/>>> 0|\| 0|& ~|& 0x[fF]{4,}/.test(t) && /(?:ptr|addr|base|top|end|lo|hi|size|\bp\b|\bq\b|\ba\b|sp|pc|out|off)\s*(?:>>> 0|\| 0)|& ~0x[fF]|& ~\(|& ~[0-9]/.test(t)) return "?";
  return "B";
}

function readAllow() {
  const map = new Map();
  if (!existsSync(ALLOW)) return map;
  for (const line of readFileSync(ALLOW, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [file, cls, count, text, why] = line.split("\t");
    map.set(file + "\t" + text, { file, cls, count: Number(count), text, why: why ?? "" });
  }
  return map;
}
function writeAllow(map) {
  const head = ["# tools/audit64.allow: the reviewed sites of tools/audit64.mjs (docs/CONTRACT.md, \"Addresses\"). Tab-separated:",
    "# file, class, how many times the expression occurs in the file, the expression, and for class A the reason.", "# Classes:",
    ...Object.entries(CLASSES).map(([k, v]) => `#   ${k}  ${v}`), "# Trees not audited site by site:", ...OUT_OF_SCOPE.map(([p, why]) => `#   ${p}  ${why}`), ""];
  const rows = [...map.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0)
    .map(e => [e.file, e.cls, e.count, e.text, e.why].join("\t").replace(/\t$/, ""));
  writeFileSync(ALLOW, head.join("\n") + rows.join("\n") + "\n");
}

export function audit(o = {}) {
  const sites = [];
  for (const d of AS_DIRS) for (const f of files(d)) { if (skipped(f) || /\/host\//.test(f)) continue; sites.push(...scanAS(f, readFileSync(join(ROOT, f), "utf8"))); }
  for (const d of TS_DIRS) for (const f of files(d)) { if (skipped(f)) continue; if (AS_DIRS.some(a => f.startsWith(a + "/")) && !/\/host\//.test(f)) continue; sites.push(...scanTS(f, readFileSync(join(ROOT, f), "utf8"))); }
  const found = new Map();
  for (const s of sites) { const k = s.file + "\t" + s.text; const e = found.get(k); if (e) { e.count++; e.lines.push(s.line); } else found.set(k, { site: s, count: 1, lines: [s.line] }); }
  const allow = readAllow(), unknown = [], more = [], stale = [], unreviewed = [];
  for (const [k, f] of found) {
    const a = allow.get(k);
    if (!a) unknown.push(f);
    else { if (f.count > a.count) more.push({ ...f, allowed: a.count }); if (a.cls === "?" || !CLASSES[a.cls] || (a.cls === "A" && !a.why)) unreviewed.push({ ...f, entry: a }); }
  }
  for (const [k, a] of allow) if (!found.has(k)) stale.push(a);
  if (o.update) {
    for (const f of unknown) allow.set(f.site.file + "\t" + f.site.text, { file: f.site.file, cls: suggest(f.site), count: f.count, text: f.site.text, why: "" });
    for (const f of more) allow.get(f.site.file + "\t" + f.site.text).count = f.count;
    for (const [k, a] of allow) { const f = found.get(k); if (!f) allow.delete(k); else a.count = f.count; }
    writeAllow(allow);
  }
  return { sites, found, allow, unknown, more, stale, unreviewed };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const update = process.argv.includes("--update"), list = process.argv.includes("--list");
  let r = audit({ update });
  if (update) r = audit();
  if (list) for (const [k, f] of r.found) console.log(`${r.allow.get(k)?.cls ?? "!"}\t${f.site.file}:${f.lines.join(",")}\t${f.site.text}`);
  const area = f => f.startsWith("web/") ? "web" : f.split("/").slice(0, 2).join("/");
  const per = new Map();
  for (const [k, f] of r.found) { const a = area(f.site.file), c = r.allow.get(k)?.cls ?? "!"; const row = per.get(a) ?? {}; row[c] = (row[c] ?? 0) + f.count; per.set(a, row); }
  for (const [a, row] of [...per].sort()) console.log(`${a.padEnd(18)} ${Object.entries(row).sort().map(([c, n]) => `${c} ${n}`).join("  ")}`);
  const total = r.sites.length, entries = r.allow.size, byClass = {};
  for (const a of r.allow.values()) byClass[a.cls] = (byClass[a.cls] ?? 0) + 1;
  for (const f of r.unknown) console.error(`[RED] audit64: not on the reviewed list: ${f.site.file}:${f.lines.join(",")}: ${f.site.text}`);
  for (const f of r.more) console.error(`[RED] audit64: ${f.count} times now, ${f.allowed} reviewed: ${f.site.file}:${f.lines.join(",")}: ${f.site.text}`);
  for (const f of r.unreviewed) console.error(`[RED] audit64: on the list but not reviewed (class ${f.entry.cls}${f.entry.cls === "A" ? " without a reason" : ""}): ${f.site.file}:${f.lines.join(",")}: ${f.site.text}`);
  const bad = r.unknown.length + r.more.length + r.unreviewed.length;
  console.log(`audit64: ${total} sites in ${new Set(r.sites.map(s => s.file)).size} files, ${entries} entries on the reviewed list (${Object.entries(byClass).sort().map(([c, n]) => `${c} ${n}`).join(", ")}); ` +
    `${bad} not reviewed${r.stale.length ? `; ${r.stale.length} entries no longer match a site (--update drops them)` : ""}`);
  process.exit(bad ? 1 : 0);
}
