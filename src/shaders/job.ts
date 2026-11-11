// One stage as the game passed it (control section, code area) -> the bytes of its key and the translator job.
// As nxnative: the key is hle_nvn.c keys_hash (nvn_ctl_lens), the job dmsh_build.py job_for without the per-game answer
// table (texture types, attribute and output classes are the translator's defaults). No Node or DOM API.
//   NVN (Switch 1, Maxwell): control version 1, 0x880 bytes. Key: its first 0x880 bytes (its own length at +0x20 when that
//     is 0x760..0x87f) + the code area, whose length is at +0x704. Code: a 0x30-byte header (graphics magic 0x12345678,
//     compute 0x12345679 with the instructions at +0x100), then the 0x50-byte SPH; c1 between control +0x700 and +0x704.
//   NVN2 (Switch 2, Ampere; dmsh_ampere.py): magic 0x98761234, version 0xc9. Key: the first 0x48 bytes with +0x30..+0x33 as
//     zero (BNSH files hold the section's length there, memory 0) + the code area, whose length is at +0x44. Code: no header;
//     graphics stages start with the 0x80-byte SPH (version 4); +0x38 is the instructions' length, the c1 segment lies
//     between +0x40 and +0x44. The stage: +0x56 is 5 compute, 6 task, 7 mesh, else the SPH's shader type.
export const CTL_MAGIC = 0x98761234, NVN2_VERSION = 0xc9, NVN2_KEY_CTL = 0x48;
// the NVN2 control bytes a job reads (through compute's c0 layout at +0xba); every NVN2 section seen is longer (0xd0, 0xd8)
export const NVN2_CTL_READ = 0xc0;

const u32 = (b: Uint8Array, o: number) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const u16 = (b: Uint8Array, o: number) => b[o] | b[o + 1] << 8;
export function isNvn2(c: Uint8Array): boolean { return c.length >= NVN2_KEY_CTL && u32(c, 0) === CTL_MAGIC && u32(c, 4) === NVN2_VERSION; }

// hle_nvn.c nvn_ctl_lens: how many control bytes the key takes, and the code area's length. Reads +0x20, +0x44, +0x704
export function ctlLens(c: Uint8Array): { nctl: number; ncode: number } {
  if (isNvn2(c)) return { nctl: NVN2_KEY_CTL, ncode: u32(c, 0x44) };
  const own = u32(c, 0x20);
  return { nctl: own >= 0x760 && own < 0x880 ? own : 0x880, ncode: u32(c, 0x704) };
}
// The control bytes that go into the key (hle_nvn.c keys_hash): sha256(keyControl(c) + code area)[0..8]
export function keyControl(c: Uint8Array): Uint8Array {
  const { nctl } = ctlLens(c);
  if (!isNvn2(c)) return c.subarray(0, nctl);
  const k = c.slice(0, NVN2_KEY_CTL); k.fill(0, 0x30, 0x34);
  return k;
}

export interface Job {
  key: string; stage: "vs" | "ps" | "cs"; code: string; tex: object; img: object; attr: object; fout: object; c1: string; debug: boolean; reduced: boolean;
  arch?: "sm86"; nvn2_cs?: number[]; early_fragment_tests?: boolean; local?: number[]; shared?: number;
}
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

// The job for one stage and the code the translator reads (written to the file the job names: `path`)
export function jobFor(key: string, control: Uint8Array, code: Uint8Array, path: string): { job: Job; body: Uint8Array } {
  if (control.length < 8 || u32(control, 0) !== CTL_MAGIC) throw new Error("no control section magic");
  return isNvn2(control) ? nvn2Job(key, control, code, path) : nvnJob(key, control, code, path);
}

// NVN: what the in-page translator did before NVN2 (unchanged)
function nvnJob(key: string, control: Uint8Array, code: Uint8Array, path: string): { job: Job; body: Uint8Array } {
  if (control.length < 0x708) throw new Error("no control section magic");
  if (code.length < 4) throw new Error("the code area is empty");
  const magic = u32(code, 0);
  let stage: Job["stage"], body: Uint8Array;
  if (magic === 0x12345679) { stage = "cs"; body = code.subarray(0x100); }
  else {
    if (magic !== 0x12345678) throw new Error(`the code area does not start with a Maxwell header (0x${magic.toString(16)})`);
    if (code.length < 0x30 + 0x50 + 8) throw new Error(`the code area (${code.length} bytes) holds no shader program`);
    const type = (u32(code, 0x30) >>> 10) & 15;
    if (type !== 1 && type !== 5) throw new Error(`shader type ${type} (tessellation or geometry) is not translated`);
    stage = type === 1 ? "vs" : "ps"; body = code.subarray(0x30);
  }
  const c1o = u32(control, 0x700), c1t = u32(control, 0x704), c1 = c1t > c1o && c1t <= code.length ? code.subarray(c1o, c1t) : new Uint8Array(0);
  const job: Job = { key, stage, code: path, tex: {}, img: {}, attr: {}, fout: {}, c1: hex(c1), debug: true, reduced: true };
  if (stage === "ps" && control.length > 0x71c && (u32(control, 0x718) & 1)) job.early_fragment_tests = true;
  return { job, body };
}

// NVN2: dmsh_build.py job_for's NVN2 branch, the stage as shader_split.py nvn2_stage names it, and compute's thread group
// and shared memory as shader_split.py puts them in the answer table (+0x58, +0x64)
const SPH_STAGE: Record<number, string> = { 1: "vs", 2: "hs", 3: "ds", 4: "gs", 5: "ps" };
export function nvn2Stage(control: Uint8Array, code: Uint8Array): string | null {
  if (control.length > 0x56 && control[0x56] >= 5 && control[0x56] <= 7) return ["cs", "ts", "ms"][control[0x56] - 5];
  if (code.length < 4) return null;
  const w = u32(code, 0);
  return ((w >>> 10) & 15) === 0 && (w & 0x1f) === 1 ? "vs" : SPH_STAGE[(w >>> 10) & 15] ?? null;
}
function nvn2Job(key: string, control: Uint8Array, code: Uint8Array, path: string): { job: Job; body: Uint8Array } {
  const stage = nvn2Stage(control, code);
  if (stage === null) throw new Error("an NVN2 stage whose control section and SPH name no stage");
  if (stage === "ts" || stage === "ms") throw new Error(`an NVN2 ${stage === "ts" ? "task" : "mesh"} shader: WebGPU has no mesh pipeline (nxnative runs it as compute inside a Metal mesh stage, dmsh_meshstage.py)`);
  if (stage !== "vs" && stage !== "ps" && stage !== "cs") throw new Error(`an NVN2 ${stage} shader (tessellation or geometry) is not translated`);
  const a = u32(control, 0x40), e = u32(control, 0x44), c1 = a <= e && e <= code.length ? code.subarray(a, e) : new Uint8Array(0);
  const body = code.subarray(0, u32(control, 0x38));
  const job: Job = { key, stage, code: path, tex: {}, img: {}, attr: {}, fout: {}, c1: hex(c1), arch: "sm86", debug: true, reduced: true };
  if (stage === "cs") {
    if (control.length < 0xbc) throw new Error(`an NVN2 compute control section of ${control.length} bytes: its c0 layout is at +0xa9..+0xbb`);
    // c0's layout: uniform, storage buffer and texture entries, the size, the push constants' bytes, separate textures and samplers (InstEmitAmpere.cs AMapC0)
    job.nvn2_cs = [control[0xb1], control[0xb2], control[0xb3], u16(control, 0xba), control[0xa9] * 4, control[0xb4], control[0xb5]];
    const local = [u32(control, 0x58), u32(control, 0x5c), u32(control, 0x60)];
    if (!(local[0] * local[1] * local[2])) throw new Error(`an NVN2 compute shader whose thread group (control +0x58) is ${local.join(" x ")}`);
    job.local = local; job.shared = Math.ceil(u32(control, 0x64) / 16) * 16;
  }
  // early fragment tests: control +0x5b, unless the SPH writes depth (word 19 bit 1)
  if (stage === "ps" && control.length > 0x5b && control[0x5b] !== 0 && body.length >= 0x50 && !(u32(body, 19 * 4) & 2)) job.early_fragment_tests = true;
  return { job, body };
}
