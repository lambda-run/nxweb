// Translator feature tests on hand-assembled code, shared by Node (extra_run.ts) and the browser worker:
// exact fault pcs, code ranges added and removed at run time, the cntpct yield point, the translation cache,
// atomic exclusives on a shared memory. runExtraTests(mods, { mem64, high }) runs them in the memory64 mode (the
// wasm64 translator on a 64-bit memory), with `high` at addresses above 4 GB, and adds what only that mode has.
import { A64Host, makeMemory64, MEM64_MAX_PAGES, type A64Options } from "../../src/glue/a64_host.ts";
import { A64, HOST_END } from "../../src/glue/rt_layout.ts";

// for the memory64 mode, the same four built for wasm64 (translator64*.wasm, helpers64*.wasm) go in as these
export interface Mods { translator: WebAssembly.Module; helpers: WebAssembly.Module; translatorShared: WebAssembly.Module; helpersShared: WebAssembly.Module }
export interface TestResult { name: string; ok: boolean; detail: string }
export interface ExtraConfig { mem64?: boolean; high?: boolean }

// code, a second code range 240 MB further and data; with `high` all three are moved up by HIGH
const HIGH = 0x1_8000_0000;
let BASE = 0x0800_0000, FAR = 0x1700_0000, DATA = 0x0900_0000, M64 = false, LAYOUT = A64;
const RET = 0xD65F03C0;

function mk(m: Mods, o: Partial<A64Options> & { top?: number; cnt?: () => bigint } = {}) {
  const pages = Math.ceil(Math.max(o.top ?? DATA + 0x10000, HOST_END) / 65536);
  const m64 = M64 ? makeMemory64(o.shared ? { initial: pages, maximum: MEM64_MAX_PAGES, shared: true } : { initial: pages }) : null;
  const memory = m64 ? m64.memory : o.shared ? new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: true }) : new WebAssembly.Memory({ initial: pages });
  const grow = (n: number) => m64 ? m64.grow(n) : memory.grow(n);
  const host: A64Host = new A64Host(o.shared ? m.translatorShared : m.translator, o.shared ? m.helpersShared : m.helpers, {
    memory, mem64: M64, layout: LAYOUT, ...o,
    imports: { svc: () => {}, unimpl: (pc, insn) => { throw new Error(`unimpl ${insn.toString(16)} at ${pc.toString(16)}`); }, brk: () => {}, cntpct: o.cnt ?? (() => 0n) },
  });
  const put = (addr: number, words: number[]) => new Uint32Array(memory.buffer, addr, words.length).set(words);
  const c = host.core as any;
  // call a guest function: returns x0
  const call = (pc: number, args: bigint[] = []): bigint => {
    args.forEach((a, i) => { c["x" + i].value = a; });
    c.x30.value = 0xFFFFFFF0n; c.pc.value = BigInt(pc); c.budget.value = 1 << 30;
    c.run();
    return c.x0.value;
  };
  return { host, memory, put, call, c, grow };
}

export function runExtraTests(m: Mods, cfg: ExtraConfig = {}): TestResult[] {
  const out: TestResult[] = [];
  const up = cfg.high ? HIGH : 0;
  M64 = !!cfg.mem64; BASE = up + 0x0800_0000; FAR = up + 0x1700_0000; DATA = up + 0x0900_0000;
  LAYOUT = { ...A64, codeRegionLo: BASE };
  const FIXED = A64Host.pcMapFixedBytes(M64);
  const test = (name: string, fn: () => string) => {
    try { out.push({ name, ok: true, detail: fn() }); } catch (e) { out.push({ name, ok: false, detail: String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 600) }); }
  };
  const eq = (what: string, got: unknown, want: unknown) => { if (got !== want) throw new Error(`${what}: got ${typeof got === "number" || typeof got === "bigint" ? "0x" + got.toString(16) : got}, want ${typeof want === "number" || typeof want === "bigint" ? "0x" + want.toString(16) : want}`); };

  // f(): x1 = 5; bl g; x1 += 1; x2 = bad pointer; load or store through it -> trap at +0x10
  const faulty = (store: boolean) => [
    0xD28000A1,                    // 00 mov x1, #5
    0x94000005,                    // 04 bl +0x14 (g at 0x18)
    0x91000421,                    // 08 add x1, x1, #1
    0x9281FFE2,                    // 0c mov x2, #-0x1000
    store ? 0xF9000041 : 0xF9400040, // 10 str x1, [x2] / ldr x0, [x2]
    RET,                           // 14
    0x91000463, RET,               // 18 g: add x3, x3, #1; ret
  ];
  for (const store of [false, true]) {
    test(`fault pc from the trap's stack (${store ? "store" : "load"}), side table, no run-time cost`, () => {
      const t = mk(m);
      t.put(BASE, faulty(store)); t.host.addCode(BASE, 32);
      let err: unknown;
      try { t.call(BASE); } catch (e) { err = e; }
      if (!err) throw new Error("no trap");
      const f = t.host.faultFromError(err);
      if (!f) throw new Error("no fault info from: " + String((err as Error).stack).split("\n").slice(0, 3).join(" | "));
      eq("fault pc", f.pc, BASE + 0x10);
      eq("function", f.funcPc, BASE);
      return `pc=0x${f.pc.toString(16)} (module offset 0x${f.offset.toString(16)}); registers in the globals are those of the last write-back: x1=${t.c.x1.value}, pc global=0x${t.c.pc.value.toString(16)}`;
    });
  }
  test("preciseFaults=2: pc and registers are exact at the faulting instruction", () => {
    const t = mk(m, { preciseFaults: 2 });
    t.put(BASE, faulty(false)); t.host.addCode(BASE, 32);
    let err: unknown;
    try { t.call(BASE); } catch (e) { err = e; }
    if (!err) throw new Error("no trap");
    eq("fault pc", t.host.faultFromError(err)?.pc, BASE + 0x10);
    eq("x1", t.c.x1.value, 6n); eq("x2", BigInt.asUintN(64, t.c.x2.value), 0xFFFFFFFFFFFFF000n); eq("x3", t.c.x3.value, 1n);
    return "pc, x1, x2, x3 exact";
  });
  test("preciseFaults=2: registers changed between earlier accesses and in a loop are exact at a later fault", () => {
    const t = mk(m, { preciseFaults: 2 });
    t.put(BASE, [
      0xD28000A1,    // 00 mov x1, #5
      0xD2800066,    // 04 mov x6, #3
      0xF90000A1,    // 08 loop: str x1, [x5]
      0x91000421,    // 0c add x1, x1, #1
      0xF94000A9,    // 10 ldr x9, [x5]
      0xF10004C6,    // 14 subs x6, x6, #1
      0x54FFFF81,    // 18 b.ne loop
      0x91000908,    // 1c add x8, x8, #2
      0x9281FFE2,    // 20 mov x2, #-0x1000
      0xF9400040,    // 24 ldr x0, [x2]
      RET]);
    t.host.addCode(BASE, 44);
    t.c.x5.value = BigInt(DATA); t.c.x8.value = 40n;
    let err: unknown;
    try { t.call(BASE); } catch (e) { err = e; }
    if (!err) throw new Error("no trap");
    eq("fault pc", t.host.faultFromError(err)?.pc, BASE + 0x24);
    eq("x1", t.c.x1.value, 8n); eq("x9", t.c.x9.value, 7n); eq("x6", t.c.x6.value, 0n); eq("x8", t.c.x8.value, 42n);
    eq("x5", t.c.x5.value, BigInt(DATA)); eq("x2", BigInt.asUintN(64, t.c.x2.value), 0xFFFFFFFFFFFFF000n);
    return "x1, x9, x6, x8, x5, x2 exact after three loop passes";
  });
  test("preciseFaults=2: LDP whose second access faults, post-index STR with a bad base: registers as at the instruction", () => {
    const t = mk(m, { preciseFaults: 2 });
    const end = t.memory.buffer.byteLength;
    t.put(BASE, [0xD2800161, 0xD28002C2, 0xA94008A1, RET]);   // mov x1, #11; mov x2, #22; ldp x1, x2, [x5]; ret
    t.put(BASE + 0x40, [0xD28000E1, 0x9281FFE5, 0xF80084A1, RET]);   // mov x1, #7; mov x5, #-0x1000; str x1, [x5], #8; ret
    t.host.addCode(BASE, 0x50);
    let err: unknown;
    t.c.x5.value = BigInt(end - 8);
    try { t.call(BASE); } catch (e) { err = e; }
    if (!err) throw new Error("ldp: no trap");
    eq("ldp pc", t.host.faultFromError(err)?.pc, BASE + 8); eq("x1", t.c.x1.value, 11n); eq("x2", t.c.x2.value, 22n); eq("x5", t.c.x5.value, BigInt(end - 8));
    err = undefined;
    try { t.call(BASE + 0x40); } catch (e) { err = e; }
    if (!err) throw new Error("str: no trap");
    eq("str pc", t.host.faultFromError(err)?.pc, BASE + 0x48); eq("x1", t.c.x1.value, 7n); eq("x5", BigInt.asUintN(64, t.c.x5.value), 0xFFFFFFFFFFFFF000n);
    t.c.x5.value = BigInt(end - 0x100);
    t.call(BASE);
    eq("ldp near the end, in bounds", t.c.x1.value, 0n);
    return `end 0x${end.toString(16)}: ldp and post-index str exact; in bounds 256 bytes before the end`;
  });
  test("preciseFaults=2 with the guard: integer, pair, SIMD, exclusive, DC ZVA below the guard: pc and a dirty register exact", () => {
    const G = DATA + 0x1000;
    const t = mk(m, { preciseFaults: 2, guardBase: G });
    const acc = [0xF9000001, 0xF9400001, 0xA9000801, 0x3D800000, 0xFD400000, 0x4C407000, 0xC85F7C01, 0xD50B7420];
    acc.forEach((a, i) => t.put(BASE + i * 0x40, [0xD2800549, a, RET]));   // mov x9, #42; <access through x0>; ret
    t.host.addCode(BASE, acc.length * 0x40);
    acc.forEach((a, i) => {
      t.call(BASE + i * 0x40, [BigInt(G)]);
      let err: unknown;
      t.c.x9.value = 0n;
      try { t.call(BASE + i * 0x40, [BigInt(G - 16)]); } catch (e) { err = e; }
      if (!err) throw new Error(`access ${i} (0x${a.toString(16)}) below the guard base did not trap`);
      eq(`access ${i} pc`, t.host.faultFromError(err)?.pc, BASE + i * 0x40 + 4); eq(`access ${i} x9`, t.c.x9.value, 42n);
    });
    return `${acc.length} accesses: pc and x9 exact below the guard, no trap at it`;
  });
  test("preciseFaults=1: pc is exact, registers are not written", () => {
    const t = mk(m, { preciseFaults: 1 });
    t.put(BASE, faulty(true)); t.host.addCode(BASE, 32);
    try { t.call(BASE); throw new Error("no trap"); } catch (e) { if (String(e).includes("no trap")) throw e; }
    eq("pc global", t.c.pc.value, BigInt(BASE + 0x10));
    return "pc exact";
  });

  test("code ranges: two ranges 240 MB apart, unit function pcs, unload drops units and pc-map entries, reload runs the new code", () => {
    const t = mk(m, { top: FAR + 0x20000 });
    t.put(BASE, [0x52800020, RET, 0x52800140, RET]);      // a: mov w0,#1; ret   a2: mov w0,#10; ret
    t.put(FAR, [0x52800040, RET]);                        // b: mov w0,#2; ret
    t.host.addCode(BASE, 16, { entries: [BASE, BASE + 8] });
    t.host.addCode(FAR, 8);
    eq("a()", t.call(BASE), 1n); eq("b()", t.call(FAR), 2n);
    eq("ranges", t.host.codeRanges().length, 2);
    const ua = t.host.units.find(u => u.pcs.includes(BASE))!, ub = t.host.units.find(u => u.pcs.includes(FAR))!;
    if (!ua.pcs.includes(BASE + 8)) throw new Error("the entry the loader passed was not taken into the unit: " + [...ua.pcs].map(p => p.toString(16)));
    if (ua === ub) throw new Error("one unit spans two ranges");
    const mapBytes = t.host.pcMapBytes;
    if (t.host.getPcMap(FAR) === 0) throw new Error("no pc-map entry for b");
    const slot = ub.tableBase + ub.pcs.indexOf(FAR);
    t.host.removeCode(FAR, 8);
    eq("pc map entry after unload", t.host.getPcMap(FAR), 0);
    eq("table slot after unload", t.host.table.get(slot), null);
    eq("units after unload", t.host.units.includes(ub), false);
    if (t.host.pcMapBytes >= mapBytes) throw new Error("the leaf was not released");
    eq("a() still", t.call(BASE), 1n);
    t.put(FAR, [0x52800060, RET]);                        // new b: mov w0,#3; ret
    t.host.addCode(FAR, 8);
    eq("new b()", t.call(FAR), 3n);
    eq("a2()", t.call(BASE + 8), 10n);
    return `units: ${t.host.units.map(u => "[" + [...u.pcs].map(p => "0x" + p.toString(16)).join(",") + "]").join(" ")}; pc map ${t.host.pcMapBytes >> 10} KB for ${M64 ? "16" : "4"} GB of address space`;
  });

  test("cntpct as a yield point: the embedder parks at the read and resumes at the same instruction", () => {
    let parked = false, yields = 0, n = 0n;
    const t = mk(m, {
      cntYield: true,
      cnt: () => { if (!parked) { parked = true; yields++; t.c.pc.value = 0xFFFFFFE0n; return 0n; } parked = false; n += 100n; return n; },
    });
    // x1 += 1; x0 = cnt; x1 += 1; x2 = cnt; x0 = x0 + x2 + x1; ret
    t.put(BASE, [0x91000421, 0xD53BE020, 0x91000421, 0xD53BE022, 0x8B020000, 0x8B010000, RET]);
    t.host.addCode(BASE, 28);
    t.c.x1.value = 0n; t.c.x30.value = 0xFFFFFFF0n; t.c.pc.value = BigInt(BASE);
    const seen: string[] = [];
    for (let i = 0; i < 10 && t.c.pc.value !== 0xFFFFFFF0n; i++) {
      t.c.budget.value = 1 << 30;
      t.c.run();
      if (t.c.pc.value === 0xFFFFFFE0n) {
        // the registers are written back; the import was entered with pc = the mrs itself
        seen.push(`x1=${t.c.x1.value}`);
        t.c.pc.value = BigInt(BASE + (yields === 1 ? 4 : 12));
      }
    }
    eq("yields", yields, 2); eq("x0", t.c.x0.value, 100n + 200n + 2n); eq("x1", t.c.x1.value, 2n);
    eq("state at the yields", seen.join(" "), "x1=1 x1=2");
    return "2 yields, no instruction executed twice";
  });
  test("cntpct without the option: a plain call", () => {
    let n = 0n;
    const t = mk(m, { cnt: () => { n += 7n; return n; } });
    t.put(BASE, [0xD53BE020, 0xD53BE041, 0x8B010000, RET]);   // cntpct, cntvct
    t.host.addCode(BASE, 16);
    eq("x0", t.call(BASE), 21n);
    return "ok";
  });

  test("translation cache: export, import into a fresh host, no translation on the second start", () => {
    const code = [0x94000003, 0x91000400, RET, 0xD503201F, 0x91001400, RET];   // f: bl g; x0 += 1; ret (x30 lost: tail)  g: x0 += 5; ret
    // f must keep x30: use  mov x9, x30; bl g; add; br x9
    const prog = [0xAA1E03E9, 0x94000003, 0x91000400, 0xD61F0120, 0x91001400, RET];
    void code;
    const a = mk(m);
    a.host.keepBytes = true;
    a.put(BASE, prog); a.host.addCode(BASE, 24);
    eq("cold result", a.call(BASE, [1n]), 7n);
    const blob = a.host.exportCache(BASE, 24);
    const b = mk(m);
    b.put(BASE, prog); b.host.addCode(BASE, 24);
    const n = b.host.importCache(blob);
    eq("warm result", b.call(BASE, [1n]), 7n);
    eq("instructions translated on the warm start", b.host.translatedInsns, 0);
    if (b.host.cacheHits < 1) throw new Error("no cache hit");
    eq("option key differs when an option does", mk(m, { nanFix: false }).host.optionsKey() === a.host.optionsKey(), false);
    return `${n} unit(s), ${blob.length} bytes; cold translated ${a.host.translatedInsns} instructions, warm 0`;
  });

  test("shared memory: LDXR/STXR as compare-exchange, LDAR/STLR atomic", () => {
    const t = mk(m, { shared: true });
    // loop: ldxr x1,[x0]; add x1,x1,#1; stxr w2,x1,[x0]; cbnz w2,loop; ldar x3,[x0]; add x3,x3,#1; stlr x3,[x0]; mov x0,x3; ret
    t.put(BASE, [0xC85F7C01, 0x91000421, 0xC8027C01, 0x35FFFFA2, 0xC8DFFC03, 0x91000463, 0xC89FFC03, 0xAA0303E0, RET]);
    t.host.addCode(BASE, 36);
    new BigUint64Array(t.memory.buffer, DATA, 1)[0] = 40n;
    eq("result", t.call(BASE, [BigInt(DATA)]), 42n);
    eq("memory", new BigUint64Array(t.memory.buffer, DATA, 1)[0], 42n);
    if (!(t.memory.buffer instanceof SharedArrayBuffer)) throw new Error("not a shared memory");
    // a failed exchange: the value changed between the load and the store
    t.put(BASE + 0x100, [0xC85F7C01, 0xF9000004, 0xC8027C01, 0xAA0203E0, RET]);   // ldxr; str x4,[x0]; stxr w2,x1,[x0]; mov x0,x2; ret
    t.host.addCode(BASE, 0x120);
    t.c.x4.value = 99n;
    eq("stxr status when memory changed", t.call(BASE + 0x100, [BigInt(DATA)]), 1n);
    eq("memory kept the other write", new BigUint64Array(t.memory.buffer, DATA, 1)[0], 99n);
    return "ok";
  });

  test("barriers: DMB / DSB are atomic.fence on a shared memory and nothing on an unshared one; ISB is nothing", () => {
    // ldr x1,[x0]; dmb ish; add x1,x1,#1; dsb sy; str x1,[x0]; isb; mov x0,x1; ret   and the same with NOPs
    const NOP = 0xD503201F, DMB = 0xD5033BBF, DSB = 0xD5033F9F, ISB = 0xD5033FDF;
    const prog = (dmb: number, dsb: number, isb: number) => [0xF9400001, dmb, 0x91000421, dsb, 0xF9000001, isb, 0xAA0103E0, RET];
    const fences = (shared: boolean, words: number[]) => {
      const t = mk(m, { shared });
      t.host.keepBytes = true;
      t.put(BASE, words); t.host.addCode(BASE, 32);
      new BigUint64Array(t.memory.buffer, DATA, 1)[0] = 41n;
      eq(`result (${shared ? "shared" : "unshared"})`, t.call(BASE, [BigInt(DATA)]), 42n);   // translated, compiled (so validated) and run
      eq("memory", new BigUint64Array(t.memory.buffer, DATA, 1)[0], 42n);
      const blob = t.host.exportCache(BASE, 32);
      let n = 0;
      for (let i = 0; i + 2 < blob.length; i++) if (blob[i] == 0xFE && blob[i + 1] == 0x03 && blob[i + 2] == 0x00) n++;
      return { n, blob };
    };
    const plain = prog(NOP, NOP, NOP), barriers = prog(DMB, DSB, ISB);
    const s0 = fences(true, plain), s1 = fences(true, barriers), u0 = fences(false, plain), u1 = fences(false, barriers);
    eq("atomic.fence instructions on a shared memory (DMB, DSB; not ISB)", s1.n - s0.n, 2);
    eq("ISB alone on a shared memory", fences(true, prog(NOP, NOP, ISB)).n - s0.n, 0);
    eq("atomic.fence instructions on an unshared memory", u1.n - u0.n, 0);
    eq("unshared code with barriers is the code with NOPs, byte for byte", u1.blob.length == u0.blob.length && u1.blob.every((v, i) => v == u0.blob[i]), true);
    return `shared: ${s1.n - s0.n} fences, unshared: ${u1.n - u0.n}`;
  });
  test("pc map beyond its fixed range: leaves come from leafAlloc (which may grow the memory); without one, or when it gives none, the error names the pc map; freed leaves are used again", () => {
    // mov x0,#n; ret in six different 64 KB pages, with a layout whose own arena has room for two leaves
    const small = { ...LAYOUT, pcmapEnd: LAYOUT.pcmapBase + FIXED + 2 * 0x10000 };
    const fn = (n: number) => [0xD2800000 | (n << 5), RET];
    const EXTRA = DATA + 0x10000;
    const run = (leafAlloc?: (t: { memory: WebAssembly.Memory; grow: (n: number) => number }) => number) => {
      let self: ReturnType<typeof mk>;
      self = mk(m, { layout: small, leafAlloc: leafAlloc ? () => leafAlloc(self) : undefined });
      for (let i = 0; i < 6; i++) { self.put(BASE + i * 0x10000, fn(i + 1)); self.host.addCode(BASE + i * 0x10000, 8); }
      const got: bigint[] = [];
      for (let i = 0; i < 6; i++) got.push(self.call(BASE + i * 0x10000));
      return { t: self, got };
    };
    let threw = ""; try { run(); } catch (e) { threw = String(e); }
    if (!/pc map's leaf arena is full/.test(threw)) throw new Error("no allocator: " + (threw || "no error"));
    threw = ""; try { run(() => 0); } catch (e) { threw = String(e); }
    if (!/pc map's leaf arena is full.*no room left/.test(threw)) throw new Error("an allocator with nothing: " + (threw || "no error"));
    let given = 0, grown = 0;
    const r = run(t => {
      const at = EXTRA + given++ * 0x10000;
      if (t.memory.buffer.byteLength < at + 0x10000) { t.grow(Math.ceil((at + 0x10000 - t.memory.buffer.byteLength) / 65536)); grown++; }
      new Uint8Array(t.memory.buffer, at, 0x10000).fill(0xAA);   // the host zeroes what it is given
      return at;
    });
    eq("results", r.got.join(","), "1,2,3,4,5,6");
    if (given < 4 || grown < 1) throw new Error(`leaves given ${given}, memory grown ${grown} times`);
    // a range removed gives its leaf back; new code in another page takes it without asking again
    const before = given;
    r.t.host.removeCode(BASE + 5 * 0x10000, 8);
    r.t.put(BASE + 9 * 0x10000, fn(77)); r.t.host.addCode(BASE + 9 * 0x10000, 8);
    eq("code in a page that took a freed leaf", r.t.call(BASE + 9 * 0x10000), 77n);
    eq("leaves asked for after the free", given, before);
    return `${given} leaves from the allocator, the memory grew ${grown} time(s); pc map ${r.t.host.pcMapBytes >> 10} KB`;
  });
  test("single-instruction mode (maxInsns 1): the instructions after an entry share its module; one unit of budget per instruction; maxFuncs 1 keeps one module per instruction", () => {
    // f(x0): 600 times `add x0, x0, #1`, then a loop of 5 rounds over three instructions, then ret
    const N = 600;
    const code = [...new Array(N).fill(0x91000400),   // add x0, x0, #1
      0xD28000A1,                                      // mov x1, #5
      0x91000800, 0xF1000421, 0x54FFFFC1,              // loop: add x0, x0, #2; subs x1, x1, #1; b.ne loop
      RET];
    const run = (o: Partial<A64Options>) => {
      const t = mk(m, { maxInsns: 1, ...o });
      t.put(BASE, code); t.host.addCode(BASE, code.length * 4);
      const x0 = t.call(BASE, [7n]);
      eq("f(7)", x0, BigInt(7 + N + 10));
      return { modules: t.host.modules, used: (1 << 30) - t.c.budget.value };
    };
    const insns = N + 1 + 5 * 3 + 1;
    const shared = run({}), alone = run({ maxFuncs: 1 });
    eq("budget units used = instructions executed", shared.used, insns);
    eq("the same with one module per instruction", alone.used, insns);
    if (shared.modules > 4) throw new Error(`${shared.modules} modules for ${code.length} instructions: the instructions after an entry did not come along`);
    eq("modules with maxFuncs 1", alone.modules, code.length);
    return `${code.length} instructions, ${insns} executed: ${shared.modules} modules (was one per instruction: ${alone.modules} with maxFuncs 1), ${shared.used} budget units either way`;
  });

  test("guard: integer, pair, SIMD, exclusive and DC ZVA accesses below guardBase trap, at it they work", () => {
    const G = DATA + 0x1000;
    const t = mk(m, { guardBase: G });
    // each: one access through x0, then ret. str x1,[x0] / ldr x1,[x0] / stp x1,x2,[x0] / str q0,[x0] / ldr d0,[x0] / ld1 {v0.16b},[x0] / ldxr x1,[x0] / dc zva,x0
    const acc = [0xF9000001, 0xF9400001, 0xA9000801, 0x3D800000, 0xFD400000, 0x4C407000, 0xC85F7C01, 0xD50B7420];
    acc.forEach((w, i) => t.put(BASE + i * 0x40, [w, 0xD2800540, RET]));   // access; mov x0,#42; ret
    t.host.addCode(BASE, acc.length * 0x40, { entries: acc.map((_, i) => BASE + i * 0x40) });
    let trapped = 0;
    for (let i = 0; i < acc.length; i++) {
      eq(`access ${i} at the guard base`, t.call(BASE + i * 0x40, [BigInt(G)]), 42n);
      // the last byte below it (DC ZVA: the 64-byte block below it)
      let err: unknown; try { t.call(BASE + i * 0x40, [BigInt(i === 7 ? G - 64 : G - 8)]); } catch (e) { err = e; }
      if (!err) throw new Error(`access ${i} (0x${acc[i].toString(16)}) below the guard base did not trap`);
      eq(`fault pc of access ${i}`, t.host.faultFromError(err)?.pc, BASE + i * 0x40);
      trapped++;
    }
    return `${trapped} kinds of access trap below 0x${G.toString(16)} and work at it`;
  });

  test("context: save_ctx / load_ctx at a guest address, registers round-trip", () => {
    const t = mk(m);
    const CTX = DATA + 0x2000;
    t.c.x5.value = 0x1122334455667788n; t.c.sp.value = BigInt(DATA + 0x8000); t.c.pc.value = BigInt(BASE + 0x40); t.c.nf.value = 1; t.c.cf.value = 1;
    t.host.core.save_ctx(CTX);
    const dv = new DataView(t.memory.buffer);
    eq("x5 in memory", dv.getBigUint64(CTX + 5 * 8, true), 0x1122334455667788n);
    eq("sp in memory", dv.getBigUint64(CTX + 0xF8, true), BigInt(DATA + 0x8000));
    eq("nzcv in memory", dv.getUint32(CTX + 0x108, true), 0b1010);
    t.c.x5.value = 0n; t.c.sp.value = 0n; t.c.pc.value = 0n; t.c.nf.value = 0;
    t.host.core.load_ctx(CTX);
    eq("x5", t.c.x5.value, 0x1122334455667788n); eq("sp", t.c.sp.value, BigInt(DATA + 0x8000)); eq("pc", t.c.pc.value, BigInt(BASE + 0x40)); eq("N", t.c.nf.value, 1);
    return `context block at 0x${CTX.toString(16)}`;
  });

  test("the mode is part of the option key and of the cache blob", () => {
    const t = mk(m);
    t.host.keepBytes = true;
    t.put(BASE, [0x52800020, RET]); t.host.addCode(BASE, 8);
    eq("result", t.call(BASE), 1n);
    const key = t.host.optionsKey();
    if (!new RegExp(M64 ? "\\.m64\\." : "\\.m32$").test(key)) throw new Error("the option key does not name the mode: " + key);
    const blob = t.host.exportCache(BASE, 8);
    const magic = new DataView(blob.buffer).getUint32(0, true);
    eq("blob magic", magic, M64 ? 0x44343641 : 0x43343641);
    // a blob of the other mode is not taken
    const other = blob.slice(); new DataView(other.buffer).setUint32(0, M64 ? 0x43343641 : 0x44343641, true);
    eq("units taken from a blob of the other mode", mk(m).host.importCache(other), 0);
    eq("units taken from its own", mk(m).host.importCache(blob), 1);
    return `key ${key}`;
  });

  // ---- pointer authentication (ARMv8.3): the identity, with the translator's call / return protocol
  test("pointer authentication: BLRAA / BLRAAZ call through the pc map with the return-address check, RETAB / RETAA return, BRAA is a tail call", () => {
    const t = mk(m);
    const F = BASE, G = BASE + 0x24, H = BASE + 0x2C;
    t.put(BASE, [
      0xD503237F,   // 00 f: pacibsp
      0xA9BF7BFD,   // 04    stp x29, x30, [sp, #-16]!
      0xAA0003E9,   // 08    mov x9, x0
      0xD2800020,   // 0c    mov x0, #1
      0xD73F0921,   // 10    blraa x9, x1
      0x91004000,   // 14    add x0, x0, #0x10
      0xD63F093F,   // 18    blraaz x9
      0xA8C17BFD,   // 1c    ldp x29, x30, [sp], #16
      0xD65F0FFF,   // 20    retab
      0x91000800,   // 24 g: add x0, x0, #2
      0xD65F0BFF,   // 28    retaa
      0xAA0003E9,   // 2c h: mov x9, x0
      0xD28000A0,   // 30    mov x0, #5
      0xD71F0921,   // 34    braa x9, x1
    ]);
    t.host.addCode(BASE, 0x38, { entries: [F, H] });
    t.c.sp.value = BigInt(DATA + 0x8000);
    eq("f(g, modifier)", t.call(F, [BigInt(G), 0x1234_5678_9ABC_DEF0n]), 0x15n);
    eq("pc after f", t.c.pc.value, 0xFFFFFFF0n); eq("sp after f", t.c.sp.value, BigInt(DATA + 0x8000)); eq("x30 after f", t.c.x30.value, 0xFFFFFFF0n);
    if (t.host.getPcMap(G) === 0) throw new Error("g, reached only by BLRAA, has no pc-map entry");
    eq("h(g): tail call", t.call(H, [BigInt(G), 7n]), 7n);
    eq("x30 after the tail call (BRAA does not link)", t.c.x30.value, 0xFFFFFFF0n);
    // the same through preemption: every instruction its own unit of budget
    const s = mk(m, { maxInsns: 1 });
    s.put(BASE, Array.from(new Uint32Array(t.memory.buffer, BASE, 14))); s.host.addCode(BASE, 0x38);
    s.c.sp.value = BigInt(DATA + 0x8000); s.c.x0.value = BigInt(G); s.c.x1.value = 3n; s.c.x30.value = 0xFFFFFFF0n; s.c.pc.value = BigInt(F);
    let slices = 0;
    while (!s.host.isHostPc(s.c.pc.value) && slices < 100) { s.c.budget.value = 2; s.c.run(); slices++; }
    eq("f(g) run two instructions at a time", s.c.x0.value, 0x15n);
    return `f = 0x15, tail call = 7; ${slices} slices of two instructions`;
  });
  test("pointer authentication: a return to another address than the caller's (RETAB after a non-local exit) unwinds the callers", () => {
    const t = mk(m);
    t.put(BASE, [
      0xAA1E03E9,   // 00 f: mov x9, x30
      0xD63F091F,   // 04    blraaz x8          (g)
      0xD2800DE0,   // 08    mov x0, #111       (never reached)
      0xD61F0120,   // 0c    br x9
      0xAA0103FE,   // 10 g: mov x30, x1        (the non-local exit: return to k)
      0xD65F0FFF,   // 14    retab
      0xD2801BC0,   // 18 k: mov x0, #222
      0xD61F0120,   // 1c    br x9
    ]);
    t.host.addCode(BASE, 0x20);
    t.c.x8.value = BigInt(BASE + 0x10);
    eq("result", t.call(BASE, [0n, BigInt(BASE + 0x18)]), 222n);
    eq("pc", t.c.pc.value, 0xFFFFFFF0n);
    return "the frame of f was left by the pc check, k ran from the run loop";
  });
  test("pointer authentication: RETAA / RETAB end a function, a PACIBSP after one is a known entry", () => {
    const t = mk(m);
    // a: mov w0,#1; retab   b: pacibsp; mov w0,#2; retaa   c: paciasp; mov w0,#3; retab; then words that are not code
    t.put(BASE, [0x52800020, 0xD65F0FFF, 0xD503237F, 0x52800040, 0xD65F0BFF, 0xD503233F, 0x52800060, 0xD65F0FFF, 0xFFFFFFFF, 0x12345678]);
    t.host.addCode(BASE, 40);
    eq("a()", t.call(BASE), 1n);
    const u = t.host.units.find(x => x.pcs.includes(BASE))!;
    if (!u.pcs.includes(BASE + 8) || !u.pcs.includes(BASE + 20)) throw new Error("entries after RETAB / RETAA not found: " + [...u.pcs].map(p => p.toString(16)));
    eq("instructions translated (a: 2, b: 3, c: 3; nothing past a return)", u.insns, 8);
    eq("b()", t.call(BASE + 8), 2n); eq("c()", t.call(BASE + 20), 3n);
    return `unit functions: ${[...u.pcs].map(p => "+0x" + (p - BASE).toString(16)).join(" ")}`;
  });
  test("pointer authentication: LDRAA / LDRAB, with writeback; signing and authenticating leave a pointer as it is; PACGA is a fixed function", () => {
    const t = mk(m);
    t.put(BASE, [
      0xDAC10020,   // 00 pacia x0, x1
      0xDAC11020,   // 04 autia x0, x1
      0xDAC147E0,   // 08 xpacd x0
      0xF8A01C02,   // 0c ldrab x2, [x0, #8]!      (M=1 S=0 imm9=1 W=1)
      0xF87FF403,   // 10 ldraa x3, [x0, #-8]      (M=0 S=1 imm9=0x1FF W=0)
      0x9AC13004,   // 14 pacga x4, x0, x1
      RET,
    ]);
    t.host.addCode(BASE, 28);
    const q = new BigUint64Array(t.memory.buffer, DATA, 2); q[0] = 0x1111n; q[1] = 0x2222n;
    const x0 = t.call(BASE, [BigInt(DATA), 0xABCDn]);
    eq("x0 (signed, authenticated, stripped, then written back by LDRAB)", x0, BigInt(DATA + 8));
    eq("x2", t.c.x2.value, 0x2222n); eq("x3", t.c.x3.value, 0x1111n);
    const mix = (x: bigint, y: bigint) => ((BigInt.asUintN(64, (x ^ BigInt.asUintN(64, (y << 32n) | (y >> 32n))) * 0x9E3779B97F4A7C15n)) >> 32n) << 32n;
    eq("pacga", BigInt.asUintN(64, t.c.x4.value), mix(BigInt(DATA + 8), 0xABCDn));
    return "ok";
  });
  // ---- LSE atomics (ARMv8.1)
  for (const shared of [false, true]) test(`LSE atomics on ${shared ? "a shared memory (wasm atomic instructions; a 16-byte CASP under the pair lock, which is released)" : "an unshared memory (load, compute, store)"}`, () => {
    const t = mk(m, { shared });
    t.host.keepBytes = true;
    t.put(BASE, [
      0xF8E10002,   // 00 ldaddal x1, x2, [x0]
      0xD2800544,   // 04 mov x4, #42
      0xC8E4FC05,   // 08 casal x4, x5, [x0]
      0xF8E68007,   // 0c swpal x6, x7, [x0]
      0x4868FC0A,   // 10 caspal x8, x9, x10, x11, [x0]     (exchanges)
      0x4868FC0A,   // 14 caspal x8, x9, x10, x11, [x0]     (does not: x8, x9 are the old pair now)
      RET,
    ]);
    t.host.addCode(BASE, 28);
    const q = new BigUint64Array(t.memory.buffer, DATA, 2); q[0] = 40n; q[1] = 0x55n;
    t.c.x5.value = 100n; t.c.x6.value = 7n; t.c.x8.value = 7n; t.c.x9.value = 0x55n; t.c.x10.value = 0x111n; t.c.x11.value = 0x222n;
    t.call(BASE, [BigInt(DATA), 2n]);
    eq("x2 (LDADD: the value before)", t.c.x2.value, 40n); eq("x4 (CAS: the value read)", t.c.x4.value, 42n); eq("x7 (SWP)", t.c.x7.value, 100n);
    eq("x8 after the second CASP", t.c.x8.value, 0x111n); eq("x9", t.c.x9.value, 0x222n);
    eq("memory", `${q[0].toString(16)},${q[1].toString(16)}`, "111,222");
    const blob = t.host.exportCache(BASE, 28);
    let atomics = 0;
    for (let i = 0; i + 1 < blob.length; i++) if (blob[i] === 0xFE && blob[i + 1] >= 0x10 && blob[i + 1] <= 0x4E && blob[i + 2] === 3 && blob[i + 3] === 0) atomics++;
    if (shared ? atomics < 8 : atomics > 0) throw new Error(`${atomics} atomic instructions in the ${shared ? "shared" : "unshared"} code`);
    return `${atomics} wasm atomic instructions`;
  });

  // ---- DotProd (ARMv8.2): SDOT / UDOT, vector and by element, 4S and 2S
  test("DotProd: SDOT / UDOT loops (vector, by element), 2S forms clear the upper half, Rd = Rn", () => {
    const t = mk(m);
    const loop = (dot: number, ldb: number) => [0x6E201C00, 0x3CC10401, ldb, dot, 0xF1004042, 0x54FFFF81, 0x4EB1B800, 0x1E260000, RET];
    t.put(BASE, loop(0x4E829420, 0x3CC10422));            // eor v0; 1: ldr q1,[x0],#16; ldr q2,[x1],#16; sdot v0.4s, v1.16b, v2.16b; subs; b.ne 1b; addv s0, v0.4s; fmov w0, s0
    t.put(BASE + 0x40, loop(0x6FB1E820, 0x3CC10431));     // ... ldr q17,[x1],#16; udot v0.4s, v1.16b, v17.4b[3] ...
    t.put(BASE + 0x80, [0x3DC00001, 0x3DC00022, 0x6F07E7E3, 0x0FA2E023, 0x4EA11C24, 0x2E829484, 0x4E183C60, 0x4E083C61, 0x4E183C82, 0x4E083C83, RET]);
    // ldr q1,[x0]; ldr q2,[x1]; movi v3.2d,#-1; sdot v3.2s, v1.8b, v2.4b[1]; mov v4.16b, v1.16b; udot v4.2s, v4.8b, v2.8b; x0..x3 = v3.d[1], v3.d[0], v4.d[1], v4.d[0]
    t.host.addCode(BASE, 0xAC, { entries: [BASE, BASE + 0x40, BASE + 0x80] });
    const N = 256, a = new Uint8Array(t.memory.buffer, DATA, N), bb = new Uint8Array(t.memory.buffer, DATA + 0x1000, N);
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    for (let i = 0; i < N; i++) { a[i] = i < 16 ? (i & 1 ? 0x80 : 0x7F) : rnd(); bb[i] = i < 16 ? 0x80 : rnd(); }
    const s8 = (x: number) => (x << 24) >> 24;
    let want = 0;
    for (let i = 0; i < N; i++) want += s8(a[i]) * s8(bb[i]);
    eq("SDOT vector loop", t.call(BASE, [BigInt(DATA), BigInt(DATA + 0x1000), BigInt(N)]), BigInt(want >>> 0));
    want = 0;
    for (let i = 0; i < N; i++) want += a[i] * bb[(i & ~15) + 12 + (i & 3)];
    eq("UDOT by element loop", t.call(BASE + 0x40, [BigInt(DATA), BigInt(DATA + 0x1000), BigInt(N)]), BigInt(want >>> 0));
    t.call(BASE + 0x80, [BigInt(DATA), BigInt(DATA + 0x1000)]);
    const lane = (f: (k: number) => number) => [0, 1].map(j => BigInt.asUintN(32, BigInt([0, 1, 2, 3].reduce((acc, k) => acc + f(4 * j + k), 0)))).reduce((lo, hi) => lo | (hi << 32n));
    eq("SDOT 2S by element: upper half", t.c.x0.value, 0n);
    eq("SDOT 2S by element: lanes", BigInt.asUintN(64, t.c.x1.value), BigInt.asUintN(64, lane(i => (i % 4 == 0 ? -1 : 0) + s8(a[i]) * s8(bb[4 + (i & 3)])) ));
    eq("UDOT 2S vector, Rd = Rn: upper half", t.c.x2.value, 0n);
    eq("UDOT 2S vector, Rd = Rn: lanes", BigInt.asUintN(64, t.c.x3.value), lane(i => (i % 4 == 0 ? a[i + 0] | a[i + 1] << 8 | a[i + 2] << 16 | a[i + 3] * 2 ** 24 : 0) + a[i] * bb[i]));
    return `sum of ${N} byte products, signed and unsigned`;
  });

  test("an instruction outside the implemented set is reported with its word and pc when executed, not before", () => {
    const words = [0xD69F0BFF /* eretaa */, 0x04603000 /* SVE */, 0xD4000002 /* hvc */];
    const t = mk(m);
    words.forEach((w, i) => t.put(BASE + i * 0x20, [0xD503201F, w, RET]));
    t.put(BASE + 0x100, [0x52800540, RET, ...words]);     // a function that does not reach them
    t.host.addCode(BASE, 0x120, { entries: [...words.map((_, i) => BASE + i * 0x20), BASE + 0x100] });
    eq("code that does not execute them", t.call(BASE + 0x100), 42n);
    words.forEach((w, i) => {
      let msg = ""; try { t.call(BASE + i * 0x20); } catch (e) { msg = String(e); }
      eq(`report for ${w.toString(16)}`, msg, `Error: unimpl ${(w | 0).toString(16)} at ${(BASE + i * 0x20 + 4).toString(16)}`);
    });
    return `${words.length} words reported`;
  });

  if (M64) {
    test("memory64: an address beyond the memory traps (it is not wrapped to 32 bits), fault pc exact", () => {
      const t = mk(m);
      // f(x0): ldr x1,[x0]; mov x0,x1; ret        g(x0, x1): str x1,[x0]; ret
      t.put(BASE, [0xF9400001, 0xAA0103E0, RET, 0xD503201F, 0xF9000001, RET]);
      t.host.addCode(BASE, 24, { entries: [BASE, BASE + 16] });
      new BigUint64Array(t.memory.buffer, DATA, 1)[0] = 0x55n;
      eq("in range", t.call(BASE, [BigInt(DATA)]), 0x55n);
      const size = t.memory.buffer.byteLength;
      const beyond = [BigInt(DATA) + 0x1_0000_0000n, BigInt(DATA) + 0x100_0000_0000n, BigInt(size), BigInt(size - 4), 0xFFFF_FFFF_0000_0000n + BigInt(DATA % 0x1_0000_0000), -8n];
      for (const a of beyond) {
        if (a >= 0n && a + 8n <= BigInt(size)) continue;   // (with `high`, DATA + 4 GB may lie inside the memory)
        for (const [fn, what] of [[BASE, "load"], [BASE + 16, "store"]] as [number, string][]) {
          let err: unknown; try { t.call(fn, [a, 0x77n]); } catch (e) { err = e; }
          if (!err) throw new Error(`${what} at 0x${BigInt.asUintN(64, a).toString(16)} did not trap (memory is 0x${size.toString(16)} bytes)`);
          eq(`fault pc of the ${what}`, t.host.faultFromError(err)?.pc, fn);
        }
      }
      eq("the word the wrapped address would have hit", new BigUint64Array(t.memory.buffer, DATA, 1)[0], 0x55n);
      return `loads and stores at ${beyond.length} addresses beyond the ${(size / 2 ** 20).toFixed(0)} MB memory trap; the word at the same address modulo 4 GB is untouched`;
    });
    test("memory64: a pc with no code, inside the pc map's span and beyond it, reaches the embedder whole", () => {
      const asked: bigint[] = [];
      const t = mk(m, { onTranslate: (pc: bigint) => { asked.push(pc); return A64Host.STOP; } });
      t.put(BASE, [0xD61F0000]);   // br x0
      t.host.addCode(BASE, 4);
      t.host.setPcMap(BASE, t.host.translateUnit([BigInt(BASE)])[0]);
      const span = BigInt(MEM64_MAX_PAGES) * 65536n;
      const targets = [BigInt(BASE) + 0x1_0000_0000n * 2n, span - 4n, span, span + 0x1234_5678n * 4n, 0x7FFF_FFFF_FFFF_FFF0n, 0xFFFF_FFFF_0800_0000n];
      for (const target of targets) {
        t.c.x0.value = target; t.c.pc.value = BigInt(BASE); t.c.budget.value = 1 << 30;
        t.c.run();
        eq("pc after the stop", BigInt.asUintN(64, t.c.pc.value), target);
      }
      eq("pcs the embedder was asked for", asked.map(p => BigInt.asUintN(64, p).toString(16)).join(","), targets.map(p => p.toString(16)).join(","));
      eq("getPcMap beyond the span", t.host.getPcMap(Number(span) + 0x1000), 0);
      let threw = ""; try { t.host.setPcMap(Number(span), 5); } catch (e) { threw = String(e); }
      if (!/beyond the pc map/.test(threw)) throw new Error("setPcMap beyond the span: " + (threw || "no error"));
      return `${targets.length} targets, none aliased onto code at the same address modulo 4 GB or modulo the span`;
    });
    test("memory64: the embedder's pcs are the window 0xFFFF_FF00 .. 0xFFFF_FFFF; code on both sides of it runs", () => {
      const t = mk(m, { top: Math.max(DATA + 0x10000, 0x1_0002_0000) });
      const LOW = 0xFFFE_0000, ABOVE = 0x1_0000_0000;   // the last 64 KB page pair below 4 GB and the first above
      // low: mov x9,x30; bl +8; br x9 | add x0,x0,#1; ret       above (called from low through a pointer): add x0,x0,#16; ret
      t.put(LOW, [0xAA1E03E9, 0x94000002, 0xD61F0120, 0x91000400, RET]);
      t.put(ABOVE, [0x91004000, RET]);
      t.host.addCode(LOW, 20); t.host.addCode(ABOVE, 8);
      eq("a function just below the window", t.call(LOW, [1n]), 2n);
      eq("a function at 4 GB", t.call(ABOVE, [1n]), 17n);
      eq("isHostPc", [0xFFFFFEFCn, 0xFFFFFF00n, 0xFFFFFFF0n, 0xFFFFFFFFn, 0x1_0000_0000n, 0x1_FFFF_FFF0n].map(p => t.host.isHostPc(p)).join(","), "false,true,true,true,false,false");
      return "run() returns for a pc in the window only";
    });
  }
  return out;
}
