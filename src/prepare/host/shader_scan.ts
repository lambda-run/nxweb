// The Shaders stage's scan: the shader stages a game's files hold, found the way nxnative's
// dm/gfx/tools/shader_split.py finds them, for the kinds that carry most games' shaders:
//   BNSH containers (bfsha, effects, layout archives, BNSH embedded in main), read by src/prepare/bnsh.ts;
//   the wrappers they sit in: zstd (fzstd, already the container reader's decoder), Yaz0 and SARC (here, as
//   shader_split.py yaz0 / sarc_members, with its NEST bound on archives in archives);
//   GLSLC outputs (magic 0x19866891) in main and in loose files (glslc_shaders, glslc_section, glslc_program).
// Every other source kind shader_split.py reads is recognised by its magic and reported as not read (NOT_READ), so a
// game whose shaders are in one of them says so instead of reporting none. A stage's key is the one the runtime
// computes at nvnProgramSetShaders (src/gfx/shader.ts): sha256(control[0 .. ctl_len) + code area), first 8 bytes.
// No DOM or Node API: the page's scan Worker (web/prepare_shader_worker.ts) and the tests run it.
import { decompress } from "fzstd";
import type { PrepWasm } from "./wasm.ts";

export const SCAN_FORMAT = 1;
export type ShaderStage = "vs" | "hs" | "ds" | "gs" | "ps" | "cs";
export interface FoundStage { key: string; stage: ShaderStage; where: string; control: Uint8Array; code: Uint8Array }
export interface FileScan {
  path: string; bytes: number;
  stages: FoundStage[];                                  // the stages that pass shader_split.py's checks (a key may repeat)
  unreadable: { reason: string; where: string }[];       // stages or wrappers found and not readable here
  notRead: string[];                                     // container kinds this scan does not read (NOT_READ names)
  containers: Record<"bnsh" | "glslc" | "sarc" | "yaz0" | "zstd", number>;
}
export const MAX_FILE = 512 << 20;                       // a larger file is not read whole: reported, not scanned
export const NEST = 16;                                  // shader_split.py NEST

const CTL_MAGIC = 0x98761234, GFX_MAGIC = 0x12345678, CS_MAGIC = 0x12345679;
const ascii = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));
const at = (d: Uint8Array, magic: Uint8Array, o = 0) => { if (d.length < o + magic.length) return false; for (let i = 0; i < magic.length; i++) if (d[o + i] !== magic[i]) return false; return true; };
const u32 = (d: Uint8Array, o: number) => o + 4 <= d.length ? (d[o] | d[o + 1] << 8 | d[o + 2] << 16 | d[o + 3] << 24) >>> 0 : 0;
const ZSTD = Uint8Array.of(0x28, 0xB5, 0x2F, 0xFD), YAZ0 = ascii("Yaz0"), SARC = ascii("SARC"), BNSH = ascii("BNSH\0\0\0\0"), LZ4F = Uint8Array.of(0x04, 0x22, 0x4D, 0x18);

// The source kinds of shader_split.py that are not read here, by the bytes a file starts with (its header lists 27;
// those found by a magic inside a file come last). The name is what the page shows.
export const NOT_READ: { kind: string; head?: Uint8Array; off?: number; inside?: Uint8Array }[] = [
  { kind: "BAHS (agl / gsys shader archives)", head: ascii("BAHS") },
  { kind: "MSHD (MercurySteam)", head: ascii("MSHD") },
  { kind: "Unity bundles", head: ascii("UnityFS\0") },
  { kind: "NARC (Camelot)", head: ascii("NARC") },
  { kind: "CRA (Camelot)", head: ascii("CRA.") },
  { kind: "NDSR / NDVE", head: ascii("NDSR") }, { kind: "NDSR / NDVE", head: ascii("NDVE") },
  { kind: "KTGL RDB (G2S)", head: ascii("IDRK0000") }, { kind: "KTGL RDB (G2S)", head: ascii("PDRK0000") },
  { kind: "KTGL shader packages (SPKG)", head: ascii("SPKG") },
  { kind: "RE Engine PAK (SDF)", head: ascii("KPKA") },
  { kind: "PlatinumGames PKZ", head: ascii("pkzl") },
  { kind: "CRI CPK", head: ascii("CPK ") },
  { kind: "phx PDAT", head: ascii("PDAT") },
  { kind: "zip archives", head: ascii("PK\x03\x04") }, { kind: "zip archives", head: ascii("VZIP") },
  { kind: "MT Framework ARC (SPK)", head: ascii("ARC\0") },
  { kind: "Bezel Engine archives (BEA)", head: ascii("SCNE") },
  { kind: "Retro Studios RFRM", head: ascii("RFRM") },
  { kind: "Game Freak GFPAK", head: ascii("GFLXPACK") },
  { kind: "Trinity packs (Oodle)", head: ascii("ONEPACK\0") },
  { kind: "FromSoftware dvdbnd", head: ascii("BHD5") }, { kind: "FromSoftware dvdbnd", head: ascii("BDF3") },
  { kind: "Criterion Bundle 2", head: ascii("bnd2") },
  { kind: "Unreal Engine 3 shader caches", head: ascii("BMSG") },
  { kind: "MonoGame XNB", head: ascii("XNB") },
  { kind: "Snowdrop SDF", head: ascii("BERG") },
  { kind: "VBF (PhyreEngine)", head: ascii("SRYK") }, { kind: "PhyreEngine", head: ascii("RYHP") },
  { kind: "Monolith (HCPS / xbc1 / DRSM)", head: ascii("HCPS") }, { kind: "Monolith (HCPS / xbc1 / DRSM)", head: ascii("xbc1") }, { kind: "Monolith (HCPS / xbc1 / DRSM)", head: ascii("DRSM") },
  { kind: "gzip", head: Uint8Array.of(0x1F, 0x8B, 0x08) },
  { kind: "LZ4 frames", head: LZ4F },
  { kind: "HAL .cmp (size-prefixed zstd / LZ4)", head: ZSTD, off: 4 }, { kind: "HAL .cmp (size-prefixed zstd / LZ4)", head: LZ4F, off: 4 },
  { kind: "MonoGame effects (MGFX)", inside: ascii("MGFX") },
  { kind: "Next Level Games HNSH", inside: ascii("HNSHV002") },
  { kind: "Sumo (NVNsh)", inside: ascii("NVNsh\0") },
];
function find(d: Uint8Array, magic: Uint8Array, from = 0, to = d.length): number {
  const first = magic[0], end = Math.min(to, d.length) - magic.length;
  for (let i = d.indexOf(first, from); i >= 0 && i <= end; i = d.indexOf(first, i + 1)) if (at(d, magic, i)) return i;
  return -1;
}

// ---- wrappers ----
// shader_split.py yaz0: group header bits, 1 a literal byte, 0 a back-reference {length nibble, 12-bit distance}
export function yaz0(s: Uint8Array): Uint8Array {
  const n = (s[4] << 24 | s[5] << 16 | s[6] << 8 | s[7]) >>> 0, out = new Uint8Array(n);
  let si = 16, o = 0;
  while (o < n) {
    if (si >= s.length) throw new Error(`the Yaz0 stream ends at 0x${s.length.toString(16)} with 0x${o.toString(16)} of its 0x${n.toString(16)} bytes decoded`);
    let h = s[si++];
    for (let b = 0; b < 8 && o < n; b++, h <<= 1) {
      if (h & 0x80) { if (si >= s.length) throw new Error("the Yaz0 stream ends inside a literal"); out[o++] = s[si++]; continue; }
      if (si + 1 >= s.length) throw new Error("the Yaz0 stream ends inside a back-reference");
      const b1 = s[si], b2 = s[si + 1]; si += 2;
      const dist = ((b1 & 15) << 8 | b2) + 1;
      let ln = b1 >> 4;
      if (ln) ln += 2; else { if (si >= s.length) throw new Error("the Yaz0 stream ends inside a back-reference"); ln = s[si++] + 0x12; }
      const st = o - dist;
      if (st < 0) throw new Error(`a back-reference at 0x${si.toString(16)} reaches 0x${(-st).toString(16)} bytes before the start`);
      for (let k = 0; k < ln && o < n; k++) out[o++] = out[st + k];
    }
  }
  return out;
}
// shader_split.py sarc_members: (name, bytes) of each member; a member outside the data is a damaged archive
export function sarcMembers(d: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 0x14) throw new Error("the SARC header is cut short");
  const hl = dv.getUint16(4, true), doff = dv.getUint32(12, true);
  if (hl + 12 > d.length) throw new Error("the SFAT header lies outside the archive");
  const n = dv.getUint16(hl + 6, true), names = hl + 12 + 16 * n + 8;
  if (!(names <= doff && doff <= d.length)) throw new Error(`SARC data at 0x${doff.toString(16)}, its ${n} entries and the names end at 0x${names.toString(16)}, the archive at 0x${d.length.toString(16)}`);
  const out: { name: string; bytes: Uint8Array }[] = [], dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const e = hl + 12 + 16 * i, attr = dv.getUint32(e + 4, true), s = dv.getUint32(e + 8, true), t = dv.getUint32(e + 12, true);
    if (!(s <= t && t <= d.length - doff)) throw new Error(`SARC member ${i} at 0x${s.toString(16)}..0x${t.toString(16)} of the data lies outside its 0x${(d.length - doff).toString(16)} bytes`);
    let name = `#${i}`;
    if (attr >>> 24) { const o = names + (attr & 0xFFFFFF) * 4, z = d.indexOf(0, o); if (o < doff) name = dec.decode(d.subarray(o, z >= 0 ? z : d.length)); }
    out.push({ name, bytes: d.subarray(doff + s, doff + t) });
  }
  return out;
}
// A zstd frame's dictionary ID (0: none): fzstd decodes no frame that needs one
export function zstdDictId(d: Uint8Array): number {
  const fhd = d[4] ?? 0, flag = fhd & 3, single = (fhd >> 5) & 1, o = 5 + (single ? 0 : 1);
  return flag === 0 ? 0 : flag === 1 ? d[o] : flag === 2 ? d[o] | d[o + 1] << 8 : u32(d, o);
}

// ---- control sections and code areas (shader_split.py check, ctl_len, sph_stage, glslc_stage) ----
const nvn2 = (ctl: Uint8Array) => ctl.length >= 0x48 && u32(ctl, 0) === CTL_MAGIC && u32(ctl, 4) === 0xC9;
export const ctlLen = (ctl: Uint8Array) => { const n = u32(ctl, 0x20); return n >= 0x760 && n < 0x880 ? n : 0x880; };
function sphStage(code: Uint8Array): ShaderStage | null {
  if (code.length < 0x34) return null;
  const w = u32(code, 0x30), t = (w >>> 10) & 15;
  return t === 0 && (w & 0x1F) === 1 ? "vs" : ({ 1: "vs", 2: "hs", 3: "ds", 4: "gs", 5: "ps" } as Record<number, ShaderStage>)[t] ?? null;
}
function glslcStage(ctl: Uint8Array, code: Uint8Array): ShaderStage | null {
  const m = u32(code, 0), headerlessCs = m !== CS_MAGIC && m !== GFX_MAGIC && ctl.length >= 0x754 && !!u32(ctl, 0x748) && !!u32(ctl, 0x74C) && !!u32(ctl, 0x750);
  return code.length >= 4 && m === CS_MAGIC || headerlessCs ? "cs" : m === GFX_MAGIC ? sphStage(code) : null;
}
// why the pair is not one stage, or null
export function check(st: ShaderStage, ctl: Uint8Array, code: Uint8Array): string | null {
  if (u32(ctl, 0) !== CTL_MAGIC || ctl.length < 0x24 || ctl.length < ctlLen(ctl)) return "bad control section";
  if (nvn2(ctl)) return "NVN2 control section (not read)";
  const m = code.length >= 4 ? u32(code, 0) : 0;
  if (st === "cs" && (m === CS_MAGIC || m === GFX_MAGIC) && m !== CS_MAGIC || st !== "cs" && m !== GFX_MAGIC) return "code area header magic does not match the stage";
  if (u32(ctl, 0x704) !== code.length) return "control +0x704 does not match the code area length";
  return null;
}
export function stageKey(w: PrepWasm, ctl: Uint8Array, code: Uint8Array): string {
  const n = ctlLen(ctl), b = new Uint8Array(n + code.length);
  b.set(ctl.subarray(0, n)); b.set(code, n);
  return w.sha256(b).slice(0, 16);
}

// ---- GLSLC outputs (shader_split.py glslc_layout / glslc_section / glslc_program / glslc_shaders) ----
function glslcSections(d: Uint8Array, h: number, size: number): [Uint8Array, Uint8Array][] | null {
  const n = u32(d, h + 0x4C), first = 0x90, stride = 0x90, secs: [Uint8Array, Uint8Array][] = [];
  if (!(n > 0 && n <= 16) || h + first + stride * n > d.length) return null;
  for (let i = 0; i < n; i++) {
    const s = h + first + stride * i, ssz = u32(d, s), soff = u32(d, s + 4), typ = u32(d, s + 8);
    if (typ) continue;
    const co = u32(d, s + 0x30), ko = u32(d, s + 0x34), kn = u32(d, s + 0x38), cn = u32(d, s + 0x3C);
    if (soff + ssz > size || co + cn > ssz || ko + kn > ssz) return null;
    secs.push([d.subarray(h + soff + co, h + soff + co + cn), d.subarray(h + soff + ko, h + soff + ko + kn)]);
  }
  return secs;
}
type Raw = { where: string; stage: ShaderStage; control: Uint8Array; code: Uint8Array };
export function glslcShaders(d: Uint8Array, label: string, unreadable: FileScan["unreadable"]): Raw[] {
  const out: Raw[] = [], magic = Uint8Array.of(0x91, 0x68, 0x86, 0x19), ctlM = Uint8Array.of(0x34, 0x12, 0x76, 0x98);
  for (let h = find(d, magic); h >= 0; h = find(d, magic, h + 1)) {
    if (h + 0x48 > d.length) continue;
    const where = `${label}#GLSLC@0x${h.toString(16)}`;
    if (h + 0x68 <= d.length && u32(d, h + 0x30) === 0xC9 && !u32(d, h + 0x44) && u32(d, h + 0x5C) > 0 && u32(d, h + 0x5C) <= d.length - h) { unreadable.push({ reason: "NVN2 GLSLC output (not read)", where }); continue; }
    const size = h + 0x50 <= d.length ? u32(d, h + 0x44) : 0;
    const c = size > 0x760 && size <= d.length - h ? find(d, ctlM, h, h + size) : -1;
    if (c < 0) continue;
    if (find(d, ctlM, c + 4, h + size) >= 0) {   // several stages compiled together: by the section headers
      const secs = glslcSections(d, h, size) ?? [], sts = secs.map(([ctl, code]) => glslcStage(ctl, code));
      if (secs.length < 2 || new Set(sts).size < sts.length || secs.some(([ctl, code], i) => !sts[i] || check(sts[i]!, ctl, code))) continue;
      secs.forEach(([control, code], i) => out.push({ where: where + "#var", stage: sts[i]!, control, code }));
      continue;
    }
    const nctl = c + 0x708 <= h + size ? u32(d, c + 0x20) : 0, ncode = c + 0x708 <= h + size ? u32(d, c + 0x704) : 0;
    let control = d.subarray(c, c + nctl), code = d.subarray(c + nctl, c + nctl + ncode);
    let st = nctl >= 0x760 && !(nctl & 3) && c + nctl + ncode <= h + size ? glslcStage(control, code) : null;
    if (!st || check(st, control, code)) {
      const sec = glslcSections(d, h, size);
      if (!sec || sec.length !== 1) continue;
      [control, code] = sec[0]; st = glslcStage(control, code);
      if (!st || check(st, control, code)) continue;
    }
    out.push({ where, stage: st, control, code });
  }
  return out;
}

// ---- one file ----
export function emptyScan(path: string, bytes: number): FileScan { return { path, bytes, stages: [], unreadable: [], notRead: [], containers: { bnsh: 0, glslc: 0, sarc: 0, yaz0: 0, zstd: 0 } }; }
// `module`: the file is a code module (main): its segments are unpacked first (PrepWasm.cut with no cuts)
export function scanFile(w: PrepWasm, path: string, data: Uint8Array, o: { module?: boolean } = {}): FileScan {
  const r = emptyScan(path, data.length);
  let d = data;
  if (o.module) {
    const plain = w.cut(data, []);
    if (!("bytes" in plain)) { r.unreadable.push({ reason: "the module cannot be unpacked", where: path }); return r; }
    d = plain.bytes;
  }
  const raw: Raw[] = [];
  const budget = [NEST * d.length, NEST * d.length];
  blob(w, d, path, raw, r, 0, budget, !o.module);   // loose: GLSLC outputs only where nothing else is found
  // the same key from two places is one stage (shader_split.py uniq_keys)
  const seen = new Set<string>();
  for (const s of raw) {
    const key = stageKey(w, s.control, s.code);
    if (seen.has(key)) continue;
    seen.add(key);
    r.stages.push({ key, stage: s.stage, where: s.where, control: s.control.slice(), code: s.code.slice() });
  }
  r.notRead = [...new Set(r.notRead)];
  return r;
}
function blob(w: PrepWasm, d: Uint8Array, label: string, out: Raw[], r: FileScan, depth: number, left: number[], loose: boolean): void {
  if (depth > NEST) { r.unreadable.push({ reason: `archives nested more than ${NEST} deep`, where: label }); return; }
  try {
    if (at(d, ZSTD)) {
      if (zstdDictId(d)) { r.unreadable.push({ reason: "zstd frame with a dictionary (not read)", where: label }); return; }
      r.containers.zstd++;
      const z = decompress(d);
      left[1] -= z.length;
      if (left[1] < 0 && depth) throw new Error(`the members expand to more than ${NEST} times the file`);
      return blob(w, z, label, out, r, depth + 1, depth ? left : [NEST * z.length, NEST * z.length], loose);
    }
    if (at(d, YAZ0)) {
      r.containers.yaz0++;
      const n = (d[4] << 24 | d[5] << 16 | d[6] << 8 | d[7]) >>> 0;
      left[1] -= n;
      if (left[1] < 0 && depth) throw new Error(`the Yaz0 members expand to more than ${NEST} times the file`);
      const y = yaz0(d);
      return blob(w, y, label, out, r, depth + 1, depth ? left : [NEST * y.length, NEST * y.length], loose);
    }
    if (at(d, SARC)) {
      r.containers.sarc++;
      for (const m of sarcMembers(d)) {
        left[0] -= m.bytes.length;
        if (left[0] < 0) throw new Error(`the archive members add up to more than ${NEST} times the file (members that overlap)`);
        blob(w, m.bytes, `${label}/${m.name}`, out, r, depth + 1, left, true);
      }
      return;
    }
  } catch (e) { r.unreadable.push({ reason: `${e instanceof Error ? e.message : e}`.replace(/0x[0-9a-f]+/g, "…"), where: label }); return; }
  const before = out.length;
  if (find(d, BNSH) >= 0) {
    const b = w.bnsh(d);
    r.containers.bnsh += b.containers;
    if (b.dropped) r.unreadable.push({ reason: `more than 65,536 stage records in one file (${b.dropped} not read)`, where: label });
    for (const s of b.stages) {
      const where = `${label}#BNSH@0x${s.container.toString(16)}#var${s.variation}`;
      if (s.status !== "ok") { r.unreadable.push({ reason: `BNSH: ${s.status}`, where }); continue; }
      out.push({ where, stage: s.stage, control: d.subarray(s.control[0], s.control[0] + s.control[1]), code: d.subarray(s.code[0], s.code[0] + s.code[1]) });
    }
  }
  // GLSLC outputs: in main always, in a loose file when nothing else was found in it (shader_split.py scan_file_in)
  if (out.length === before || !loose) {
    const g = glslcShaders(d, label, r.unreadable);
    r.containers.glslc += g.length;
    out.push(...g);
  }
  if (out.length === before) for (const k of NOT_READ) if (k.head ? at(d, k.head, k.off ?? 0) : find(d, k.inside!) >= 0) { r.notRead.push(k.kind); break; }
}
