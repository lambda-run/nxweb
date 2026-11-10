// Gate 1 runner: translate each fuzz case in single-instruction mode, run it, compare with Unicorn.
// Usage: node fuzz_run.ts [--nofma] file.bin...   -> one JSON line per file on stdout.
import { readFileSync } from "node:fs";
import { A64Host } from "../../src/glue/a64_host.ts";

const CODE_BASE = 0x100000, SLOT = 16, WIN_BASE = 0x200000, CTX = 0x330;
const SCRATCH = 0x300000, PCMAP = 0x400000, MAP_SIZE = 0x100000;
const BATCH = 512;

const args = process.argv.slice(2);
const nofma = args[0] === "--nofma";
if (nofma) args.shift();
const translator = readFileSync(new URL("../../build/a64/translator.wasm", import.meta.url));

function hex(b: Uint8Array, off: number, n: number): string {
  let s = "";
  for (let i = n - 1; i >= 0; i--) s += b[off + i].toString(16).padStart(2, "0");
  return s;
}
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
function nanEq(a: DataView, b: DataView, off: number, fp: number): boolean {
  if (fp === 32) {
    u32[0] = a.getUint32(off, true); const x = f32[0];
    u32[0] = b.getUint32(off, true); const y = f32[0];
    return (x !== x && y !== y) || a.getUint32(off, true) === b.getUint32(off, true);
  }
  u64[0] = a.getBigUint64(off, true); const x = f64[0];
  u64[0] = b.getBigUint64(off, true); const y = f64[0];
  return (x !== x && y !== y) || a.getBigUint64(off, true) === b.getBigUint64(off, true);
}

function runFile(path: string): void {
  const file = readFileSync(path);
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const ncases = dv.getUint32(8, true), fp = dv.getUint32(12, true), nameLen = dv.getUint32(16, true), winSize = dv.getUint32(20, true);
  const name = file.subarray(24, 24 + nameLen).toString().replace(/\0+$/, "");
  let off = 24 + nameLen;
  const code = file.subarray(off, off + ncases * SLOT); off += ncases * SLOT;
  const winInit = file.subarray(off, off + winSize); off += winSize;

  const memory = new WebAssembly.Memory({ initial: 0x500000 >> 16 });
  const host = new A64Host(translator, {
    memory, pcmapBase: PCMAP, codeLo: CODE_BASE, mapSize: MAP_SIZE, maxInsns: 1, maxFuncs: 1, fma: !nofma,
    imports: {
      svc: () => { throw new Error("svc"); },
      unimpl: () => { unimpl = true; },
      brk: () => { throw new Error("brk"); },
      cntpct: () => 0n,
    },
    onTranslate: () => A64Host.STOP,
  });
  let unimpl = false;
  const mem = new Uint8Array(memory.buffer);
  const mdv = new DataView(memory.buffer);
  mem.set(code, CODE_BASE);
  host.setCode(BigInt(CODE_BASE), code);
  const core = host.core;
  const failures: object[] = [];
  let fail = 0, unimplCount = 0;
  const expWin = new Uint8Array(winSize);

  for (let c0 = 0; c0 < ncases; c0 += BATCH) {
    const c1 = Math.min(ncases, c0 + BATCH);
    // peek record headers to learn the instruction counts
    const recs: number[] = [];
    let o = off;
    const entries: bigint[] = [];
    for (let c = c0; c < c1; c++) {
      recs.push(o);
      const n = dv.getUint32(o, true), nd = dv.getUint32(o + 4, true);
      for (let k = 0; k < n; k++) entries.push(BigInt(CODE_BASE + c * SLOT + 4 * k));
      o += 8 + 2 * CTX + 4 * nd;
    }
    off = o;
    host.translateUnit(entries);
    for (let c = c0; c < c1; c++) {
      const r = recs[c - c0];
      const n = dv.getUint32(r, true), nd = dv.getUint32(r + 4, true);
      const pre = file.subarray(r + 8, r + 8 + CTX), post = file.subarray(r + 8 + CTX, r + 8 + 2 * CTX);
      mem.set(winInit, WIN_BASE);
      mem.set(pre, SCRATCH);
      core.load_ctx(SCRATCH);
      (core.excl_addr as WebAssembly.Global).value = -1n;
      core.budget.value = n;
      unimpl = false;
      let trap = "";
      try { core.run(); } catch (e) { trap = String(e); }
      core.save_ctx(SCRATCH);
      const diffs: string[] = [];
      if (trap) diffs.push("trap: " + trap);
      if (unimpl) { diffs.push("unimplemented instruction"); unimplCount++; }
      const pdv = new DataView(post.buffer, post.byteOffset, CTX);
      for (let i = 0; i < 33; i++) {
        if (mdv.getBigUint64(SCRATCH + i * 8, true) !== pdv.getBigUint64(i * 8, true))
          diffs.push(`${i < 31 ? "x" + i : i === 31 ? "sp" : "pc"}: expected ${hex(post, i * 8, 8)} got ${hex(mem, SCRATCH + i * 8, 8)} (was ${hex(pre, i * 8, 8)})`);
      }
      if (mdv.getUint32(SCRATCH + 0x108, true) !== pdv.getUint32(0x108, true))
        diffs.push(`nzcv: expected ${pdv.getUint32(0x108, true).toString(2).padStart(4, "0")} got ${mdv.getUint32(SCRATCH + 0x108, true).toString(2).padStart(4, "0")} (was ${pre[0x108].toString(2).padStart(4, "0")})`);
      if (mdv.getUint32(SCRATCH + 0x10C, true) !== pdv.getUint32(0x10C, true))
        diffs.push(`fpcr: expected ${hex(post, 0x10C, 4)} got ${hex(mem, SCRATCH + 0x10C, 4)}`);
      for (const [nm, o2] of [["tpidr", 0x118], ["tpidrro", 0x120]] as [string, number][]) {
        if (mdv.getBigUint64(SCRATCH + o2, true) !== pdv.getBigUint64(o2, true))
          diffs.push(`${nm}: expected ${hex(post, o2, 8)} got ${hex(mem, SCRATCH + o2, 8)}`);
      }
      const gdv = new DataView(memory.buffer, SCRATCH, CTX);
      for (let i = 0; i < 32; i++) {
        const vo = 0x130 + i * 16;
        let same = true;
        if (fp === 0) {
          same = gdv.getBigUint64(vo, true) === pdv.getBigUint64(vo, true) && gdv.getBigUint64(vo + 8, true) === pdv.getBigUint64(vo + 8, true);
        } else {
          for (let l = 0; l < 16; l += fp / 8) if (!nanEq(gdv, pdv, vo + l, fp)) same = false;
        }
        if (!same) diffs.push(`v${i}: expected ${hex(post, vo, 16)} got ${hex(mem, SCRATCH + vo, 16)} (was ${hex(pre, vo, 16)})`);
      }
      // memory window
      expWin.set(winInit);
      for (let k = 0; k < nd; k++) expWin[dv.getUint16(r + 8 + 2 * CTX + 4 * k, true)] = dv.getUint8(r + 8 + 2 * CTX + 4 * k + 2);
      let memBad = -1;
      for (let k = 0; k < winSize; k++) if (mem[WIN_BASE + k] !== expWin[k]) { memBad = k; break; }
      if (memBad >= 0) diffs.push(`mem[win+0x${memBad.toString(16)}]: expected ${hex(expWin, memBad & ~7, 8)} got ${hex(mem, WIN_BASE + (memBad & ~7), 8)} (8 bytes at +0x${(memBad & ~7).toString(16)})`);
      if (diffs.length) {
        fail++;
        if (failures.length < 12) {
          const insns: number[] = [];
          for (let k = 0; k < n; k++) insns.push(code.readUInt32LE(c * SLOT + 4 * k));
          failures.push({ idx: c, pc: CODE_BASE + c * SLOT, insns, diffs });
        }
      }
    }
  }
  console.log(JSON.stringify({ name, fail, unimpl: unimplCount, failures }));
}

for (const p of args) runFile(p);
