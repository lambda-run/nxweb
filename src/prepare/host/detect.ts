// What a folder of extracted game files holds, by nxnative's rules for dump folders (scripts/pack_dump.py:
// has_code, is_version, updates, base_of, is_dump, scan, and the version choice of its main): pure functions of the
// folder's listing. No file is read here.
//
//   base/exefs/ (main, main.npdm, sdk, rtld, subsdk*), base/romfs/     base/romfs is optional when an update has one
//   updates/<version>/exefs/, updates/<version>/romfs/                 <version> = the title version in decimal
//   dlc/<DLC title ID in hex>/<n>/romfs/                               or dlc/<id>/romfs/
//   exefs/ and romfs/ directly in the folder count as base/
// An update's romfs is the whole patched tree (never laid over the base's), so one version's folder is the game.
import type { TreeListing } from "./tree.ts";
import type { FailReason } from "./wasm.ts";

export class PrepError extends Error {
  reason: FailReason;
  constructor(reason: FailReason, message: string) { super(message); this.reason = reason; }
}
export interface VersionDir {
  version: number;          // 0 = the base game
  root: string;             // "" (flat), "base/", "updates/<n>/"
  hasCode: boolean;         // exefs/main.npdm is there
  hasMain: boolean;         // exefs/main is there
  hasRom: boolean;          // romfs/ is there
}
export interface DlcDir { dir: string; titleId: string | null; roms: string[] }   // titleId: 16 hex digits, null when the folder's name is not one; roms: the romfs folders found
export interface Layout {
  kind: "base" | "flat" | "update only";
  base: VersionDir | null;
  updates: VersionDir[];    // ascending
  dlc: DlcDir[];
}

export function detectLayout(l: TreeListing): Layout {
  const files = new Set(l.files.map(f => f.path)), dirs = new Set(l.dirs);
  const ver = (root: string, version: number): VersionDir => ({ version, root, hasCode: files.has(root + "exefs/main.npdm"), hasMain: files.has(root + "exefs/main"), hasRom: dirs.has(root + "romfs") });
  const updates: VersionDir[] = [];
  for (const d of l.dirs) { const m = /^updates\/(\d+)$/.exec(d); if (m) updates.push(ver(d + "/", Number(m[1]))); }
  updates.sort((a, b) => a.version - b.version);
  const b = ver("base/", 0), flat = ver("", 0);
  const base = b.hasCode ? b : flat.hasCode && flat.hasRom ? flat : null;
  const isVersion = (v: VersionDir) => v.hasCode && v.hasRom;
  const ok = base ? base.hasRom || updates.some(u => u.hasRom) : updates.some(isVersion);
  if (!ok) throw new PrepError("layout", explain(l, files, dirs, base, updates));
  const dlc: DlcDir[] = [];
  for (const d of l.dirs) {
    const m = /^dlc\/([^/]+)$/.exec(d);
    if (!m) continue;
    const tid = /^[0-9a-fA-F]{1,16}$/.test(m[1]) ? m[1].toUpperCase().padStart(16, "0") : null;
    let roms = l.dirs.filter(x => new RegExp(`^dlc/${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]+/romfs$`).test(x)).sort();
    if (!roms.length && dirs.has(d + "/romfs")) roms = [d + "/romfs"];
    dlc.push({ dir: d, titleId: tid, roms });
  }
  return { kind: base === null ? "update only" : base.root === "" ? "flat" : "base", base, updates, dlc };
}
// Why a folder is not a game folder, as precisely as the listing allows
function explain(l: TreeListing, files: Set<string>, dirs: Set<string>, base: VersionDir | null, updates: VersionDir[]): string {
  const expected = "expected base/exefs/main.npdm with a RomFS in base/romfs or updates/<version>/romfs, or exefs/ and romfs/ directly in the folder, or updates/<version>/ with exefs and romfs";
  if (!l.files.length) return `the folder is empty; ${expected}`;
  const packed = l.files.filter(f => /\.(nsp|xci|nca|nsz|xcz|nup)$/i.test(f.path));
  if (packed.length) return `the folder holds game packages (${packed.slice(0, 3).map(f => f.path).join(", ")}${packed.length > 3 ? ", ..." : ""}): packages are not opened here (no NSP / XCI / NCA decryption, no keys); extract the game first. Then: ${expected}`;
  if (files.has("main.npdm")) return `this is an exefs folder (main.npdm is directly in it): pick the folder above it, the one that holds exefs/ and romfs/`;
  if (base && !base.hasRom) return `${base.root}exefs is there but no RomFS: neither ${base.root}romfs nor an updates/<version>/romfs`;
  if (files.has("exefs/main.npdm")) return `exefs/ is there but romfs/ is not beside it`;
  if (dirs.has("romfs") || dirs.has("base/romfs")) return `a RomFS folder is there but no exefs/main.npdm beside it`;
  if (updates.length) return `updates/ holds ${updates.map(u => u.version).join(", ")} but none has both exefs/main.npdm and romfs/, and there is no base game`;
  const one = [...dirs].filter(d => !d.includes("/"));
  for (const d of one) if (files.has(`${d}/exefs/main.npdm`) || files.has(`${d}/base/exefs/main.npdm`)) return `the game is one folder further down, in ${d}/: pick that folder`;
  return `no game files found; ${expected}`;
}

// The version to prepare: the newest update by default (nxnative: "the newest in updates/"), 0 = the base game
export function pickVersion(layout: Layout, wanted?: number): VersionDir {
  const have = layout.updates.map(u => u.version);
  const v = wanted ?? (have.length ? Math.max(...have) : 0);
  if (v) {
    const u = layout.updates.find(u => u.version === v);
    if (!u) throw new PrepError("version", `no updates/${v} (have: ${have.join(", ") || "none"})`);
    if (!u.hasMain || !u.hasCode || !u.hasRom) throw new PrepError("version", `${u.root}: no exefs/main, exefs/main.npdm and romfs (an update's folder is the whole game: its code and its patched RomFS)`);
    return u;
  }
  if (!layout.base) throw new PrepError("version", `no base game (base/), only updates ${have.join(", ")}`);
  const b = layout.base;
  if (!b.hasMain || !b.hasCode || !b.hasRom) throw new PrepError("version", `${b.root || "the folder"}: no exefs/main, exefs/main.npdm and romfs${have.length ? ` (version 0 was asked for; the updates are ${have.join(", ")})` : ""}`);
  return b;
}
// Where the title ID is read: the base game's main.npdm, else the newest whole update's
export function identityDir(layout: Layout): VersionDir {
  if (layout.base) return layout.base;
  const whole = layout.updates.filter(u => u.hasCode && u.hasRom);
  return whole[whole.length - 1];
}
// The add-on contents of application `app`: index = DLC title ID - application ID - 0x1000 (what the game asks for)
export function checkDlc(layout: Layout, app: bigint): { titleId: string; index: number; root: string }[] {
  const out = [];
  for (const d of layout.dlc) {
    if (d.titleId === null) throw new PrepError("dlc", `${d.dir}: not a DLC title ID`);
    const hex = d.titleId, idx = BigInt("0x" + hex) - app - 0x1000n;
    if (!(idx > 0n && idx <= 2000n)) throw new PrepError("dlc", `${d.dir}: ${hex} is not a DLC of ${app.toString(16).toUpperCase().padStart(16, "0")}`);
    if (d.roms.length !== 1) throw new PrepError("dlc", `${d.dir}: expected one <n>/romfs folder, found ${d.roms.length}`);
    out.push({ titleId: hex, index: Number(idx), root: d.roms[0] + "/" });
  }
  return out.sort((a, b) => a.index - b.index);
}
// Load order on Horizon: main, the subsdks by number, sdk (nxnative profile_guess.py load_order); rtld is the loader's part
export function loadOrder(names: string[]): string[] {
  const rank = (n: string) => n === "main" ? 0 : n === "sdk" ? 1000 : /^subsdk\d+$/.test(n) ? 1 + Number(n.slice(6)) : 500;
  return names.filter(n => n !== "rtld").sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}
