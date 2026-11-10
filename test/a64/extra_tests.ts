// Translator feature tests on hand-assembled code, shared by Node (extra_run.ts) and the browser worker:
// exact fault pcs, code ranges added and removed at run time, the cntpct yield point, the translation cache,
// atomic exclusives on a shared memory.
import { A64Host, type A64Options } from "../../src/glue/a64_host.ts";
import { A64, HOST_END } from "../../src/glue/rt_layout.ts";

export interface Mods { translator: WebAssembly.Module; helpers: WebAssembly.Module; translatorShared: WebAssembly.Module; helpersShared: WebAssembly.Module }
export interface TestResult { name: string; ok: boolean; detail: string }

const BASE = 0x0800_0000, FAR = 0x1700_0000, DATA = 0x0900_0000;
const RET = 0xD65F03C0;

function mk(m: Mods, o: Partial<A64Options> & { top?: number; cnt?: () => bigint } = {}) {
  const pages = Math.ceil(Math.max(o.top ?? DATA + 0x10000, HOST_END) / 65536);
  const memory = o.shared ? new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: true }) : new WebAssembly.Memory({ initial: pages });
  const host: A64Host = new A64Host(o.shared ? m.translatorShared : m.translator, o.shared ? m.helpersShared : m.helpers, {
    memory, layout: A64, ...o,
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
  return { host, memory, put, call, c };
}

export function runExtraTests(m: Mods): TestResult[] {
  const out: TestResult[] = [];
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
    eq("pc global", t.c.pc.value, BigInt(BASE + 0x10));
    eq("x1", t.c.x1.value, 6n); eq("x2", BigInt.asUintN(64, t.c.x2.value), 0xFFFFFFFFFFFFF000n); eq("x3", t.c.x3.value, 1n);
    eq("side table agrees", t.host.faultFromError(err)?.pc, BASE + 0x10);
    return "pc, x1, x2, x3 exact";
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
    return `units: ${t.host.units.map(u => "[" + [...u.pcs].map(p => "0x" + p.toString(16)).join(",") + "]").join(" ")}; pc map ${t.host.pcMapBytes >> 10} KB for 4 GB of address space`;
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
    const small = { ...A64, pcmapEnd: A64.pcmapBase + 0x40000 + 3 * 0x10000 };
    const fn = (n: number) => [0xD2800000 | (n << 5), RET];
    const EXTRA = DATA + 0x10000;
    const run = (leafAlloc?: (t: { memory: WebAssembly.Memory }) => number) => {
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
      if (t.memory.buffer.byteLength < at + 0x10000) { t.memory.grow(Math.ceil((at + 0x10000 - t.memory.buffer.byteLength) / 65536)); grown++; }
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
  return out;
}
