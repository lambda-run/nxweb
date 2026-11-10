// Damaged files: cut at every length, every single bit flipped, and thousands of random mutations aimed at the header
// and at the tables the loader walks. The loader must refuse or load: never trap, never read outside the file (the file
// ends where linear memory ends, so one byte too far traps), never write outside the image, the arena and the stubs
// (bands of 0xA5 around them are checked after every run).
import { test, instantiate, file, readElf, eq, ok, rng, type Elf } from "./harness.mts";
import { Loader, LoaderError, Info, ERR_ARG, ERR_STATE, ERR_REFUSED, type LoaderExports } from "../../src/loader/host/loader.mts";

const PAGES = 64, END = PAGES << 16;                 // 4 MiB
const D_ARENA = 0x40000, D_ARENA_LEN = 0x40000, D_STUBS = 0x80000, D_STUB_CAP = 64;
const BAND_LO = 0x3F000, BAND_HI = D_STUBS + 4 * D_STUB_CAP, FILES_AT = 0x90000, MUT_AT = 0xA0000;
const REGION = 0x100000, REGION_END = 0x3F0000, SDK_BASE = 0x110000, MAIN_BASE = 0x200000;
const A5 = Buffer.alloc(REGION_END - REGION, 0xA5);

interface Rig { x: LoaderExports; logs: string[]; mem: Uint8Array; sdk: Uint8Array; stats: Map<string, number>; runs: number }
function rig(): Rig {
  const { x, logs } = instantiate(PAGES);
  ok(x.memory.buffer.byteLength === END, "memory is 4 MiB");
  ok(x.ld_heap_base() <= BAND_LO, "the loader's static memory ends before the test's bands");
  const mem = new Uint8Array(x.memory.buffer);
  mem.fill(0xA5, BAND_LO, D_ARENA); mem.fill(0xA5, BAND_HI, FILES_AT); mem.fill(0xA5, REGION, REGION_END);
  const sdk = file("sdk_raw.nso");
  mem.set(sdk, FILES_AT);
  return { x, logs, mem, sdk, stats: new Map(), runs: 0 };
}
const bandOk = (r: Rig, from: number, to: number) => from >= to || Buffer.compare(Buffer.from(r.mem.buffer, from, to - from), A5.subarray(0, to - from)) === 0;

// One damaged file through everything the loader does with a module, beside an intact sdk. atEnd: the file ends at the
// end of memory; otherwise the image does, when it is small enough. Returns what became of it.
function attempt(r: Rig, bytes: Uint8Array, verify: boolean, atEnd: boolean): string {
  const { x, mem } = r;
  r.logs.length = 0;
  const at = atEnd ? END - bytes.length : MUT_AT;
  mem.set(bytes, at);
  const ld = new Loader(x, { arena: D_ARENA, arenaLen: D_ARENA_LEN, stubBase: D_STUBS, stubCap: D_STUB_CAP });
  ld.hostAdd("host_forced", true); ld.hostAdd("host_weak_only", false);
  const sdk = ld.parse({ name: "sdk", ptr: FILES_AT, len: r.sdk.length }, { verifyHash: false });
  ld.map(sdk, SDK_BASE);
  const sdkSize = ld.get(sdk, Info.ImageSize);
  let outcome = "loaded", base = 0, size = 0, dirty = false;
  try {
    const h = x.ld_parse(at, bytes.length, verify ? 1 : 0);
    if (h < 0) throw new Error(`parse made no record: ${ld.error()}`);
    if (ld.state(h) === "Refused") throw new LoaderError(ERR_REFUSED, ld.error());
    size = ld.get(h, Info.ImageSize);
    base = atEnd || size > 0x100000 ? MAIN_BASE : END - size;
    dirty = true;
    ld.map(h, base);
    ld.relocate(sdk); ld.relocate(h);
    ld.info(h); ld.unresolved(h); ld.unresolved(sdk);
    for (const n of ["shared_fn", "sdk_add", "module_entry", "p_local", "nothing"]) { ld.lookup(n); ld.lookupIn(h, n); }
    ld.activate(h); ld.activate(sdk);
    // the guest scribbles over the module's tables, then modules come and go around it
    if ((r.runs++ >> 1) & 1) mem.fill(0xFF, base + (size >> 2), base + size);
    ld.unload(sdk);
    ld.map(sdk, SDK_BASE); ld.relocate(sdk);
    ld.unresolved(h); ld.lookupIn(h, "shared_fn");
    ld.unload(h);
    ld.map(h, base); ld.relocate(h);
    ld.unload(sdk);
    ld.checkForced();
  } catch (e) {
    if (!(e instanceof LoaderError)) throw e;      // a trap (WebAssembly.RuntimeError) or a test bug: fail
    const state = x.ld_state(x.ld_module_count() - 1);
    outcome = e.code === ERR_REFUSED ? `refused: ${ld.info(x.ld_module_count() - 1).refuseReason}` : e.code === ERR_ARG ? "not mapped: no room in memory" : `error ${e.code}`;
    if (e.code === ERR_STATE) throw new Error(`the loader got into a state it refuses itself (${state}): ${e.message}`);
    if (!e.message.startsWith("[RED] loader: ")) throw new Error(`a refusal without a red line: ${e.message}`);
  }
  eq(x.ld_faults(), 0, "an access outside an image was asked for");
  // nothing outside what the loader owns was written
  const lo = dirty ? base : REGION_END, hi = dirty ? Math.min(base + size, REGION_END) : REGION_END;
  ok(bandOk(r, BAND_LO, D_ARENA) && bandOk(r, BAND_HI, FILES_AT), "written around the arena or the stub region");
  ok(bandOk(r, REGION, SDK_BASE) && bandOk(r, SDK_BASE + sdkSize, Math.min(lo, REGION_END)) && bandOk(r, hi, REGION_END), `written outside the images (${outcome}, base 0x${base.toString(16)}, size 0x${size.toString(16)})`);
  ok(Buffer.compare(Buffer.from(mem.buffer, at, bytes.length), bytes) === 0 && Buffer.compare(Buffer.from(mem.buffer, FILES_AT, r.sdk.length), r.sdk) === 0, "a file was written to");
  mem.fill(0xA5, SDK_BASE, SDK_BASE + sdkSize);
  if (dirty) mem.fill(0xA5, lo, hi);
  if (base + size > REGION_END && base >= REGION_END) mem.fill(0, base, Math.min(END, base + size));
  r.stats.set(outcome, (r.stats.get(outcome) ?? 0) + 1);
  return outcome;
}
const summary = (r: Rig) => [...r.stats].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");

const BASES = ["main.nso", "main_raw.nso", "main_part.nso", "sdk_raw.nso", "plugin.nro", "plugin_raw.nso"];

test("damage: the undamaged files load in this rig", () => {
  const r = rig();
  for (const n of BASES) for (const atEnd of [true, false]) eq(attempt(r, file(n), true, atEnd), "loaded", n);
});

test("damage: cut at every length, every file is refused", () => {
  const r = rig();
  let n = 0;
  for (const name of ["main.nso", "main_raw.nso", "plugin.nro", "main_part.nso"]) {
    const d = file(name);
    for (let len = 0; len < d.length; len++, n++) {
      const out = attempt(r, d.slice(0, len), true, true);
      ok(out.startsWith("refused"), `${name} cut to ${len} bytes: ${out}`);
    }
  }
  console.log(`     ${n} truncations: ${summary(r)}`);
});

for (const name of ["main.nso", "main_stored.nso"]) {
  test(`damage: every single bit of ${name} flipped (hashes checked): a flip that changes a segment's bytes or a hash is always refused`, () => {
    const r = rig(), d = file(name), dv = new DataView(d.buffer, d.byteOffset, d.byteLength), elf = readElf("main.so");
    const segs = [0, 1, 2].map(i => ({ off: dv.getUint32(0x10 + 0x10 * i, true), stored: dv.getUint32(0x60 + 4 * i, true), size: dv.getUint32(0x18 + 0x10 * i, true) }));
    // An LZ4 block is not canonical: a flipped bit can give another block for the same bytes (a match at another distance
    // into a run). Whether the bytes changed is decided by decompressing the damaged block on its own.
    const sameBytes = (m: Uint8Array, i: number): boolean => {
      if (name !== "main.nso") return false;
      r.mem.set(m.subarray(segs[i].off, segs[i].off + segs[i].stored), 0xB0000);
      const got = r.x.ld_lz4(0xB0000, segs[i].stored, 0xC0000, segs[i].size);
      return got === segs[i].size && Buffer.compare(Buffer.from(r.mem.buffer, 0xC0000, got), elf.segs[i].bytes) === 0;
    };
    let n = 0, equivalent = 0;
    for (let byte = 0; byte < d.length; byte++) {
      const seg = segs.findIndex(s => byte >= s.off && byte < s.off + s.stored);
      for (let bit = 0; bit < 8; bit++, n++) {
        const m = d.slice(); m[byte] ^= 1 << bit;
        const out = attempt(r, m, true, (n & 1) === 0);
        if (seg >= 0) {
          if (sameBytes(m, seg)) { equivalent++; eq(out, "loaded", `bit ${bit} of segment byte 0x${byte.toString(16)}, which decompresses to the same bytes`); }
          else ok(out === "refused: hash" || out === "refused: decompress", `bit ${bit} of segment byte 0x${byte.toString(16)}: ${out}`);
        } else if (byte >= 0xA0 && byte < 0x100) eq(out, "refused: hash", `bit ${bit} of hash byte 0x${byte.toString(16)}`);
        else if (byte >= 0x40 && byte < 0x60) eq(out, "loaded", `bit ${bit} of the build id`);
      }
    }
    console.log(`     ${n} bit flips: ${summary(r)}${equivalent ? ` (${equivalent} of the loads are flips in an LZ4 block that give the same bytes)` : ""}`);
  });
}

test("damage: every single bit of main_raw.nso flipped (no hashes: every byte is live)", () => {
  const r = rig(), d = file("main_raw.nso");
  let n = 0;
  for (let byte = 0; byte < d.length; byte++) for (let bit = 0; bit < 8; bit++, n++) { const m = d.slice(); m[byte] ^= 1 << bit; attempt(r, m, false, (n & 1) === 0); }
  ok((r.stats.get("loaded") ?? 0) > 1000 && [...r.stats.keys()].filter(k => k.startsWith("refused")).length >= 5, `both loads and several kinds of refusal: ${summary(r)}`);
  console.log(`     ${n} bit flips: ${summary(r)}`);
});

// Where the tables the loader walks are in a stored (uncompressed) NSO: [file offset, size]
function hotRanges(nso: Uint8Array, elf: Elf): [number, number][] {
  const dv = new DataView(nso.buffer, nso.byteOffset, nso.byteLength);
  const fileOff = (addr: number) => { for (let i = 2; i >= 0; i--) { const mo = dv.getUint32(0x14 + 0x10 * i, true); if (addr >= mo) return dv.getUint32(0x10 + 0x10 * i, true) + addr - mo; } return 0; };
  const out: [number, number][] = [[0, 0x100], [fileOff(0), 8]];
  for (const s of [".dynamic", ".dynsym", ".dynstr", ".hash", ".gnu.hash", ".rela.dyn", ".relr.dyn", ".rela.plt", ".rodata"]) {
    const sec = elf.sections.get(s);
    if (sec) out.push([fileOff(sec.addr), s === ".rodata" ? 0x1C : sec.size]);
  }
  return out;
}

test("damage: 12000 random mutations (bits, bytes, words set to edge values, cuts), aimed at headers and tables", () => {
  const r = rig(), next = rng(0xC0FFEE), pick = (n: number) => next() % n;
  const bases = BASES.map(name => {
    const d = file(name), elf = readElf(name.split(/[_.]/)[0] + ".so");
    return { name, d, hot: name.includes("_raw") ? hotRanges(d, elf) : [[0, name.endsWith(".nro") ? 0x80 : 0x100] as [number, number]] };
  });
  const N = 12000;
  for (let n = 0; n < N; n++) {
    const b = bases[pick(bases.length)];
    let m = b.d.slice();
    const dv = new DataView(m.buffer);
    for (let k = 1 + pick(4); k > 0; k--) {
      let at = pick(m.length);
      if (pick(4)) { const [o, s] = b.hot[pick(b.hot.length)]; at = Math.min(m.length - 1, o + pick(Math.max(1, s))); }
      switch (pick(6)) {
        case 0: m[at] ^= 1 << pick(8); break;
        case 1: m[at] = next(); break;
        case 2: case 3: {
          if (at + 4 > m.length) break;
          at &= ~3;
          const edge = [0, 1, 0xFFFFFFFF, 0x7FFFFFFF, 0x80000000, m.length, m.length + 1, m.length - 1, 0x1000, 0xFFFFF000, dv.getUint32(at, true) + 8, dv.getUint32(at, true) - 8, next(), pick(0x4000), pick(64) * 24, 0x00FFFFFF];
          dv.setUint32(at, edge[pick(edge.length)] >>> 0, true);
          break;
        }
        case 4: if (at + 8 <= m.length) { at &= ~7; dv.setBigUint64(at, [0n, 1n, 2n ** 64n - 1n, 2n ** 63n, 0xFFFFFFFFn, 2n ** 32n, BigInt(pick(0x4000)), BigInt(pick(0x4000)) | 1n, 2n ** 64n - 8n][pick(9)], true); } break;
        case 5: if (!pick(8)) m = m.slice(0, pick(m.length + 1)); break;
      }
      if (m.buffer !== dv.buffer) break;
    }
    attempt(r, m, pick(3) !== 0, (n & 1) === 0);
  }
  const kinds = [...r.stats.keys()];
  for (const reason of ["header", "layout", "decompress", "hash", "mod0", "dynamic", "symbols", "relocs"]) ok(kinds.includes(`refused: ${reason}`), `no mutation was refused for "${reason}": ${summary(r)}`);
  ok((r.stats.get("loaded") ?? 0) > N / 20, `some still load: ${summary(r)}`);
  console.log(`     ${N} mutations: ${summary(r)}`);
});
