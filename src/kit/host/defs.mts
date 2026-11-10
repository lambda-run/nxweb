// Machine definitions (src/kit/defs/*.json): loading, validation and the binary table layout.
// Node/TypeScript side of the kit. The AssemblyScript side (machine.ts) reads the same layout.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFS_DIR = join(KIT_DIR, "defs");

export const NONE = 0xff;       // table cell: no transition
export const DATA_ANY = 0xff;   // dataMax: the state carries a free 64-bit value
export const DIR_REC = 16;      // bytes per machine in the directory
export const MAX_STATES = 128, MAX_EVENTS = 128, MAX_MACHINES = 255;

export interface StateData { name: string; type?: string; values?: string[] }
export interface MachineDef {
  id: number;
  name: string;
  doc: string;
  states: string[];
  initial: string;
  final: string[];
  data: Record<string, StateData>;
  events: string[];
  transitions: [string, string, string][];
  file: string;
}

const IDENT = /^[A-Z][A-Za-z0-9]*$/, NAME = /^[a-z][a-z0-9_]*$/, VALUE = /^[a-z][A-Za-z0-9]*$/;

export function validate(raw: any, file: string): MachineDef {
  const fail = (m: string): never => { throw new Error(`${file}: ${m}`); };
  const known = ["id", "name", "doc", "states", "initial", "final", "data", "events", "transitions"];
  for (const k of Object.keys(raw)) if (!known.includes(k)) fail(`unknown key "${k}"`);
  if (!Number.isInteger(raw.id) || raw.id < 0 || raw.id >= MAX_MACHINES) fail(`"id" must be an integer 0..${MAX_MACHINES - 1}`);
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) fail(`"name" must be lower_snake_case`);
  if (typeof raw.doc !== "string" || !raw.doc) fail(`"doc" is required`);
  const list = (k: string, max: number): string[] => {
    const v = raw[k];
    if (!Array.isArray(v) || !v.length) fail(`"${k}" must be a non-empty list`);
    if (v.length > max) fail(`"${k}" has more than ${max} entries`);
    for (const s of v) if (typeof s !== "string" || !IDENT.test(s)) fail(`${k}: "${s}" must be PascalCase`);
    if (new Set(v).size !== v.length) fail(`"${k}" has a duplicate`);
    return v;
  };
  const states = list("states", MAX_STATES), events = list("events", MAX_EVENTS);
  if (!states.includes(raw.initial)) fail(`initial "${raw.initial}" is not a state`);
  const final: string[] = raw.final ?? [];
  for (const s of final) if (!states.includes(s)) fail(`final "${s}" is not a state`);
  const data: Record<string, StateData> = raw.data ?? {};
  for (const [s, d] of Object.entries(data)) {
    if (!states.includes(s)) fail(`data: "${s}" is not a state`);
    if (typeof d.name !== "string" || !VALUE.test(d.name)) fail(`data.${s}: "name" must be camelCase`);
    if (d.values) {
      if (!d.values.length || d.values.length >= DATA_ANY) fail(`data.${s}: 1..${DATA_ANY - 1} values`);
      for (const v of d.values) if (!VALUE.test(v)) fail(`data.${s}: value "${v}" must be camelCase`);
      if (new Set(d.values).size !== d.values.length) fail(`data.${s}: duplicate value`);
    } else if (typeof d.type !== "string") fail(`data.${s}: give "values" (an enumeration) or "type" (a free 64-bit value)`);
  }
  if (!Array.isArray(raw.transitions) || !raw.transitions.length) fail(`"transitions" must be a non-empty list`);
  const seen = new Set<string>(), used = new Set<string>(), reached = new Set<string>([raw.initial]);
  for (const t of raw.transitions) {
    if (!Array.isArray(t) || t.length !== 3) fail(`transition ${JSON.stringify(t)} must be [from, event, to]`);
    const [f, e, to] = t;
    if (!states.includes(f)) fail(`transition from "${f}": not a state`);
    if (!events.includes(e)) fail(`transition on "${e}": not an event`);
    if (!states.includes(to)) fail(`transition to "${to}": not a state`);
    if (final.includes(f)) fail(`transition out of final state "${f}"`);
    if (seen.has(`${f}/${e}`)) fail(`two transitions for (${f}, ${e})`);
    seen.add(`${f}/${e}`); used.add(e); reached.add(to);
  }
  for (const e of events) if (!used.has(e)) fail(`event "${e}" is in no transition`);
  for (const s of states) if (!reached.has(s)) fail(`state "${s}" is never entered`);
  return { id: raw.id, name: raw.name, doc: raw.doc, states, initial: raw.initial, final, data, events, transitions: raw.transitions, file };
}

// All definitions: the kit's own (src/kit/defs) first, ordered by their declared id, then every other area's
// (src/<area>/defs/*.json) ordered by area and file name. The id used in the wasm directory is the position in that
// list, so areas can add machines independently; a declared "id" outside the kit's folder is ignored. Code refers to
// machines by the generated constants, never by number.
export function loadDefs(dir = DEFS_DIR): MachineDef[] {
  const read = (d: string, f: string, id?: number): MachineDef => {
    const raw = JSON.parse(readFileSync(join(d, f), "utf8"));
    if (id !== undefined || !Number.isInteger(raw.id)) raw.id = id ?? 0;
    const def = validate(raw, f);
    if (f !== def.name + ".json") throw new Error(`${f}: the file must be named ${def.name}.json`);
    return def;
  };
  const list = (d: string) => readdirSync(d).filter(f => f.endsWith(".json")).sort();
  const defs = list(dir).map(f => read(dir, f)).sort((x, y) => x.id - y.id);
  if (dir === DEFS_DIR) {
    const src = join(KIT_DIR, "..");
    for (const area of readdirSync(src).sort()) {
      const d = join(src, area, "defs");
      if (area === "kit" || !existsSync(d)) continue;
      for (const f of list(d)) defs.push(read(d, f, defs.length));
    }
  }
  const seen = new Set<string>();
  defs.forEach((d, i) => {
    if (seen.has(d.name)) throw new Error(`${d.file}: duplicate machine name ${d.name}`);
    seen.add(d.name); d.id = i;
  });
  return defs;
}

export const pascal = (name: string) => name.split("_").map(p => p[0].toUpperCase() + p.slice(1)).join("");

// dataMax of a state: 0 = carries nothing, DATA_ANY = free value, else the argument must be 1..n
export function dataMax(d: MachineDef, state: string): number {
  const sd = d.data[state];
  return !sd ? 0 : sd.values ? sd.values.length : DATA_ANY;
}

// The transition table as the wasm has it: cell [from * nEvents + event] = to, or NONE
export function tableOf(d: MachineDef): Uint8Array {
  const t = new Uint8Array(d.states.length * d.events.length).fill(NONE);
  for (const [f, e, to] of d.transitions) t[d.states.indexOf(f) * d.events.length + d.events.indexOf(e)] = d.states.indexOf(to);
  return t;
}

export interface Blob { bytes: Uint8Array; hitsSize: number; hitsOff: number[] }

// The blob machine.ts indexes. All offsets are from the start of the blob.
//   directory, DIR_REC bytes per machine: +0 u32 table offset, +4 u32 names offset, +8 u32 offset in the hit bitmap,
//                                         +12 u8 state count, +13 u8 event count, +14 u8 initial state, +15 u8 0
//   per machine: table (states * events bytes), then dataMax (one byte per state)
//   per machine: names, each one length byte + ASCII: the machine, its states, its events
export function buildBlob(defs: MachineDef[]): Blob {
  const out: number[] = new Array(defs.length * DIR_REC).fill(0);
  const dv = (off: number, v: number) => { for (let i = 0; i < 4; i++) out[off + i] = (v >>> (8 * i)) & 0xff; };
  const hitsOff: number[] = [];
  let hits = 0;
  defs.forEach((d, i) => {
    const rec = i * DIR_REC;
    dv(rec, out.length);
    out.push(...tableOf(d), ...d.states.map(s => dataMax(d, s)));
    dv(rec + 4, out.length);
    for (const n of [d.name, ...d.states, ...d.events]) { out.push(n.length, ...Buffer.from(n, "ascii")); }
    dv(rec + 8, hits); hitsOff.push(hits);
    hits += d.states.length * d.events.length;
    out[rec + 12] = d.states.length; out[rec + 13] = d.events.length; out[rec + 14] = d.states.indexOf(d.initial);
  });
  return { bytes: Uint8Array.from(out), hitsSize: hits, hitsOff };
}
