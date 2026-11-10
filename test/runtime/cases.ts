// The runtime's end-to-end tests, written once for Node (run.mts) and the browser Worker (web/worker.ts): no Node APIs.
// Each case builds its own Runtime (translator + loader + kernel + runtime core on one linear memory), loads real NSO
// files built from test/runtime/src and checks what the guest printed and how the process ended.
import { Runtime, type RuntimeModules, type RuntimeOptions, type RunResult, type HostCpu } from "../../src/glue/rt_runtime.ts";
import { RANGES, HOST_END, PCMAP, STUBS, GUEST } from "../../src/glue/rt_layout.ts";

export interface CorpusGuest { name: string; side: any; image: Uint8Array; expected: Uint8Array }
export interface Env {
  mods: RuntimeModules;
  nso(name: string): Uint8Array;        // build/runtime/guests/<name>.nso
  corpus: CorpusGuest[];                // test/guests/out
  rssMb?: () => number;                 // resident memory of the process, when the host can tell
}
export interface Case { name: string; fn: () => string[] }   // returns lines to print under the test; throws on failure
export interface CaseResult { name: string; ok: boolean; why: string; info: string[]; ms: number }

// Corpus programs the translator is known not to pass: reported as expected failures, not failed
export const CORPUS_KNOWN_FAILING: string[] = [];   // was fp_nan_bits, fpcr_modes, neon_estimate until the translator learned them

function fail(msg: string): never { throw new Error(msg); }
function eq(got: unknown, want: unknown, what: string): void {
  const str = (v: unknown) => typeof v === "string" ? v : typeof v === "bigint" ? hex(v) : JSON.stringify(v);
  const g = str(got), w = str(want);
  if (g !== w) fail(`${what}:\n--- got ---\n${g}\n--- want ---\n${w}`);
}
function ok(cond: unknown, what: string): void { if (!cond) fail(what); }
const hex = (n: number | bigint) => "0x" + n.toString(16);

export function cases(env: Env): Case[] {
  const list: Case[] = [];
  const test = (name: string, fn: () => string[] | void) => list.push({ name, fn: () => fn() ?? [] });
  const boot = (files: string[], o: RuntimeOptions = {}, setup?: (rt: Runtime) => void): Runtime => {
    const rt = new Runtime(env.mods, o);
    setup?.(rt);
    ok(rt.loadNso(files.map(name => ({ name, bytes: env.nso(name) }))), `load failed: ${rt.red.join(" | ")}`);
    eq(rt.state, "Ready", "state after load");
    return rt;
  };
  const exited = (r: RunResult, code: number, rt: Runtime) => {
    if (r.state !== "Stopped" || r.stop?.kind !== "exit" || r.stop.code !== code)
      fail(`expected Stopped(exit ${code}), got ${r.state} ${JSON.stringify(r.stop, (_, v) => typeof v === "bigint" ? hex(v) : v)}\nstdout so far:\n${rt.stdout()}\nred: ${rt.red.join("\n")}`);
  };
  const noRed = (rt: Runtime) => eq(rt.red, [], "red lines");

  // ---- memory layout ----
  test("layout: the host ranges tile 0..0x08000000 and every module's static data ends inside its range", () => {
    const rt = new Runtime(env.mods);
    const ends: Record<string, number> = { rt: rt.r.rt_static_end() >>> 0, loader: rt.ld.x.ld_heap_base() >>> 0, kernel: rt.k.kernel_static_end() >>> 0 };
    const lines = RANGES.map(g => {
      const end = g.module ? ends[g.module] : 0;
      if (g.module) ok(end > g.lo && end <= g.hi, `${g.name}: static end ${hex(end)} outside ${hex(g.lo)}..${hex(g.hi)}`);
      return `${g.name.padEnd(14)} ${hex(g.lo).padStart(10)} .. ${hex(g.hi).padStart(10)}${g.module ? `  static data ends at ${hex(end)} (${((end - g.lo) / 1024).toFixed(0)} KiB of ${((g.hi - g.lo) / 1024).toFixed(0)})` : ""}`;
    });
    eq(RANGES[0].lo, 0, "first range"); eq(RANGES.at(-1)!.hi, HOST_END, "last range");
    eq(rt.memory.buffer.byteLength, HOST_END, "initial memory is the host area only");
    eq(rt.state, "Empty", "state");
    noRed(rt);
    return lines;
  });
  test("layout: a table with an overlap, a hole or an empty range is refused with a red line; so is static data outside its range", () => {
    const rt = new Runtime(env.mods), p = rt.r.rt_scratch_ptr() >>> 0;
    const check = (rs: [number, number][], end: number) => {
      const dv = rt.dv();
      rs.forEach(([lo, hi], i) => { dv.setBigUint64(p + 16 * i, BigInt(lo), true); dv.setBigUint64(p + 16 * i + 8, BigInt(hi), true); });
      return rt.r.rt_ranges_check(p, rs.length, BigInt(end));
    };
    eq(check([[0, 0x1000], [0x1000, 0x3000]], 0x3000), 0, "a sound table");
    eq(check([[0, 0x2000], [0x1000, 0x3000]], 0x3000), 2, "overlap");
    eq(check([[0, 0x1000], [0x2000, 0x3000]], 0x3000), 2, "hole");
    eq(check([[0, 0x1000], [0x1000, 0x1000]], 0x1000), 2, "empty");
    eq(check([[0, 0x1000]], 0x2000), 2, "short");
    eq(rt.r.rt_static_check(1, 0x1000n, 0x2000n, 0x2001n), 1, "static data past its range");
    eq(rt.red.length, 5, "one red line each");
    ok(rt.red[0].includes("overlaps the range before it"), rt.red[0]);
    return rt.red;
  });

  // ---- (a) ----
  test("a hello: OutputDebugString and the exit code", () => {
    const rt = boot(["hello"]);
    const r = rt.run();
    exited(r, 42, rt);
    eq(rt.stdout(), "hello from an NSO\nx0=0 main thread handle=0x1001\n", "stdout");
    noRed(rt);
    return [`memory grown on demand to ${(rt.memory.buffer.byteLength / 2 ** 20).toFixed(0)} MiB of address space in ${rt.stats.grows} grows` + (env.rssMb ? `; process RSS ${env.rssMb().toFixed(0)} MB` : "")];
  });

  // ---- (b) ----
  const TWO = `lib: DT_INIT\nlib: init_array[0]\nlib: init_array[1]\nmain: DT_INIT\nmain: init_array[0]\nmain: init_array[1]\n` +
    `main: entry, inits=912, library says "two_lib"\nlib_add(40, 2) = 42\nlib_table[1] + lib_table[3] = 60\n` +
    `lib_counter (set by the library's init functions) = 13\nlib_get_counter() after main wrote through the GOT and a data pointer = 1113\n` +
    `lib_op(6, 7) through the library's function pointer = 42\n`;
  test("b two modules: calls and data across modules, init order (dependency first, DT_INIT then init_array)", () => {
    const rt = boot(["two_main", "two_lib"]);
    eq(rt.modules.map(m => m.name), ["two_main", "two_lib"], "modules");
    exited(rt.run(), 3, rt);
    eq(rt.stdout(), TWO, "stdout");
    eq(rt.modules.map(m => rt.ld.state(m.handle)), ["Pinned", "Pinned"], "loader states after the init calls");
    noRed(rt);
    return rt.modules.map(m => `${m.name}: ${hex(m.base)} + ${hex(m.imageSize)}, DT_INIT ${hex(m.init)}, ${m.initArray.length} init_array entries`);
  });

  test("b two modules mapped beyond the pc map's reach: every indirect transfer goes through the translate callback, same output", () => {
    const codeBase = PCMAP.codeLo + PCMAP.size + 0x10000;
    const rt = boot(["two_main", "two_lib"], { codeBase });
    eq(rt.modules[0].base, codeBase, "base");
    exited(rt.run(), 3, rt);
    eq(rt.stdout(), TWO, "stdout");
    noRed(rt);
    return [`modules at ${hex(codeBase)}; the pc map covers ${hex(PCMAP.codeLo)}..${hex(PCMAP.codeLo + PCMAP.size)}`];
  });

  // ---- (c) ----
  const THREADS = `0 compute: 0x1fd3dba0d3209a5f\n1 mutex: counter=800 of 800, lock word=0x0, ArbitrateLock used: yes\n` +
    `2 condvar: produced=200 consumed=200 sum in=309900 out=309900 left=0\n` +
    `3 event: wait 1 ms on an unsignaled event: rc=0xea01, at least 19200 ticks passed: yes\n` +
    `3 event: signaled by another thread: rc=0x0 index=1\n3 event: ResetSignal rc=0x0, again rc=0xfa01, poll rc=0xea01\n` +
    `4 sleep: wake order 1 2 0 (sleeps of 3, 1 and 2 ms)\n5 join: wait on an exited thread rc=0x0 index=0, it left 77\nthreads done\n`;
  const threads = (o: RuntimeOptions) => {
    const rt = boot(["threads"], o);
    exited(rt.run(), 7, rt);
    eq(rt.stdout(), THREADS, `stdout with ${JSON.stringify(o)}`);
    noRed(rt);
    eq(Number(rt.k.kernel_count(1)), 0, "threads alive at the end");
    return rt;
  };
  test("c threads: 4 cores, SDK mutex and condition variable, events with timeout, sleep, exit and join", () => {
    const rt = threads({});
    return [`${rt.stats.slices} slices, ${rt.stats.svcs} SVCs, ${rt.units} budget units, guest clock at the end ${(Number(rt.guestNs()) / 1e6).toFixed(3)} ms`];
  });
  test("c threads: identical output across 20 runs", () => {
    const ends = new Set<string>();
    for (let i = 0; i < 20; i++) { const rt = threads({}); ends.add(`${rt.stats.slices}/${rt.stats.svcs}/${rt.units}/${rt.guestNs()}`); }
    eq(ends.size, 1, "slices/SVCs/units/guest ns differ between runs: " + [...ends].join(" "));
    return [`all 20: slices/SVCs/units/guest ns = ${[...ends][0]}`];
  });
  test("c threads: identical output with budgets 50, 1000, 20000 and 2^24, and on the wall clock", () => {
    const lines: string[] = [];
    for (const budget of [50, 1000, 20000, 1 << 24]) { const rt = threads({ budget }); lines.push(`budget ${String(budget).padStart(8)}: ${rt.stats.slices} slices, ${rt.stats.svcs} SVCs`); }
    const rt = threads({ clock: "wall" });
    lines.push(`wall clock: ${rt.stats.slices} slices, guest clock at the end ${(Number(rt.guestNs()) / 1e6).toFixed(3)} ms`);
    return lines;
  });
  test("c race: schedule-dependent output is identical run to run with the same budget, and differs between budgets", () => {
    const lines: string[] = [], distinct = new Set<string>();
    for (const budget of [40, 333, 100000]) {
      let first = "";
      for (let i = 0; i < 20; i++) {
        const rt = boot(["race"], { budget });
        exited(rt.run(), 0, rt);
        noRed(rt);
        if (i === 0) first = rt.stdout(); else eq(rt.stdout(), first, `budget ${budget}, run ${i}`);
      }
      distinct.add(first);
      lines.push(`budget ${String(budget).padStart(6)} x20: ${first.trim().replace(/\n/g, " | ")}`);
    }
    ok(distinct.size > 1, "the output did not depend on the budget: the program does not test determinism");
    return lines;
  });
  test("c threads: pause at slice limits and resume: Running <-> Paused, same output", () => {
    const rt = boot(["threads"], { budget: 5000 });
    let r = rt.run({ slices: 7 }), pauses = 0;
    eq(r.state, "Paused", "state after the slice limit");
    while (r.state === "Paused") { pauses++; r = rt.run({ slices: 50 }); }
    exited(r, 7, rt);
    eq(rt.stdout(), THREADS, "stdout");
    rt.requestPause();
    eq(rt.run().state, "Stopped", "run() after the end");
    noRed(rt);
    return [`${pauses} pauses`];
  });

  // ---- (d) ----
  test("d heap: SetHeapSize, an allocator, and a QueryMemory walk that shows the modules, heap, stack and thread-local region", () => {
    const rt = boot(["heap"]);
    exited(rt.run(), 0, rt);
    noRed(rt);
    const out = rt.stdout(), lines = out.trimEnd().split("\n");
    eq(lines[0], "SetHeapSize(4 MB): rc=0x0 base=0x18000000", "line 1");
    ok(/^allocator: 3 rounds of 200 blocks, corrupted=0 failed=0 blocks=\d+ bytes in use=\d+$/.test(lines[1]), lines[1]);
    eq(lines[2], "SetHeapSize(8 MB): rc=0x0 same base: yes, first allocation intact: yes", "line 3");
    eq(lines[3], "address space 0x8000000 + 0xf7ff0000", "line 4");
    ok(/^walk: \d+ segments, contiguous and complete: yes$/.test(lines.at(-1)!), lines.at(-1)!);
    const segs = lines.filter(l => l.startsWith("  ")).map(l => { const m = /^  (0x[0-9a-f]+) \+ (0x[0-9a-f]+) state=(0x[0-9a-f]+) perm=(...)$/.exec(l)!; return { lo: Number(m[1]), size: Number(m[2]), state: Number(m[3]), perm: m[4] }; });
    const at = (lo: number) => segs.find(s => s.lo === lo) ?? fail(`no segment starts at ${hex(lo)}\n${out}`);
    const m = rt.modules[0];
    eq(at(m.base), { lo: m.base, size: m.ro.addr - m.base, state: 3, perm: "r-x" }, "the module's text");
    eq(at(m.ro.addr), { lo: m.ro.addr, size: m.data.addr - m.ro.addr, state: 3, perm: "r--" }, "the module's read-only data");
    eq(at(m.data.addr), { lo: m.data.addr, size: m.base + m.imageSize - m.data.addr, state: 4, perm: "rw-" }, "the module's data and bss");
    eq(at(0x17C00000), { lo: 0x17C00000, size: 0x400000, state: 0xC, perm: "rw-" }, "thread-local region");
    eq(at(0x18000000), { lo: 0x18000000, size: 0x800000, state: 5, perm: "rw-" }, "heap");
    eq(at(GUEST.stackRegion), { lo: GUEST.stackRegion, size: GUEST.mainStackSize, state: 0xB, perm: "rw-" }, "the main thread's stack");
    eq(segs.filter(s => s.state !== 0).length, 6, "mapped segments");
    for (const s of segs) if (s.state === 0) eq(s.perm, "---", `free segment at ${hex(s.lo)}`);
    return lines.slice(3);
  });

  // ---- (e) ----
  test("e host calls: forced and weak take-overs, an unresolved import (red once, returns 0), guest memory access, a blocking host function", () => {
    let token: bigint | null = null, ev = { r: 0, w: 0 }, hostLines: string[] = [], waits = 0;
    const rt = boot(["host_main", "host_lib"], {}, rt => {
      rt.register({ name: "forced_fn", forced: true, fn: cpu => cpu.w(0) * 2 + 1000 });
      rt.register({ name: "weak_fn", fn: cpu => cpu.w(0) * 101 });
      rt.register({ name: "lib_wins", fn: () => 0xBAD });
      rt.register({ name: "host_log", fn: cpu => { hostLines.push(cpu.cstr(cpu.x(0))); cpu.log("guest: " + cpu.cstr(cpu.x(0))); } });
      rt.register({ name: "host_fill", fn: cpu => { const n = cpu.w(1), seed = cpu.w(2); cpu.write(cpu.x(0), Uint8Array.from({ length: n }, (_, i) => (i * seed + 1) & 0xFF)); } });
      rt.register({ name: "host_sum", fn: cpu => cpu.read(cpu.x(0), cpu.w(1)).reduce((a, b) => a + b, 0) });
      rt.register({ name: "host_post", fn: cpu => { token = BigInt.asIntN(64, cpu.x(0)); cpu.rt.k.kernel_event_signal(ev.w); } });
      rt.register({ name: "host_wait", fn: (cpu: HostCpu) => {
        if (!ev.r) ev = newEvent(cpu.rt);
        waits++;
        return cpu.block(ev.r, BigInt.asIntN(64, cpu.x(0)), (how, cpu) => {
          if (how !== "signaled") return -1n;
          cpu.rt.k.kernel_event_clear(ev.w);
          const v = token!; token = null;
          return v;
        });
      } });
    });
    exited(rt.run(), 0, rt);
    const sum = Array.from({ length: 64 }, (_, i) => (i * 3 + 1) & 0xFF).reduce((a, b) => a + b, 0);
    eq(rt.stdout(), `forced_fn(5) = 1010\nlib_calls_forced(5) = 1011\nweak_fn(3) = 303\nlib_wins(3) = 2003\nmissing_fn(9) = 0\nmissing_fn(10) = 0\n` +
      `host_fill wrote, guest sums ${sum}, host_sum reads ${sum}\nhost_wait(1 ms) with nobody posting = -1\nhost_wait() = 77, blocked at least 2 ms: yes\nhost calls done\n`, "stdout");
    eq(hostLines, ["a line from the guest through host_log"], "host_log");
    eq(waits, 2, "host_wait calls");
    const calls = rt.red.filter(l => l.startsWith("[RED] call to unresolved import"));
    eq(calls.length, 1, "red lines for the unresolved call");
    ok(/^\[RED\] call to unresolved import missing_fn from 0x8[0-9a-f]{6}$/.test(calls[0]), calls[0]);
    eq(rt.set!.unresolved.map(u => `${u.module}:${u.name}`), ["host_main:missing_fn"], "what the loader reported unresolved");
    const fns = rt.ld.hostFunctions().map(f => `${f.name}:${["weak", "forced", "unresolved"][f.kind]}:${f.refs ? "used" : "unused"}`);
    ok(fns.includes("forced_fn:forced:used") && fns.includes("lib_wins:weak:unused") && fns.includes("missing_fn:unresolved:used"), fns.join(" "));
    return [...rt.red, `${rt.stats.hostCalls} host calls (stub table: ${fns.join(", ")})`];
  });

  // ---- (f) ----
  const faultCase = (file: string, what: string, kind: string, before: string, check: (rt: Runtime, r: RunResult) => void) =>
    test(`f fault: ${what} ends in Stopped(fault ${kind}) with a red line`, () => {
      const rt = boot([file]);
      let r!: RunResult;
      try { r = rt.run(); } catch (e) { fail(`run() threw instead of stopping: ${e}`); }
      eq(r.state, "Stopped", "state"); eq(rt.state, "Stopped", "machine state");
      eq(r.stop?.kind, "fault", "stop kind"); eq(r.stop?.fault?.kind, kind, `fault kind (${rt.red.join(" | ")})`);
      eq(rt.stdout(), before, "stdout before the fault");
      const red = rt.red;
      ok(red.length >= 2 && red.at(-2)!.startsWith("[RED] fault: ") && /in thread 0x10\d\d \(#\d\) at pc=0x[0-9a-f]+/.test(red.at(-2)!), "red line naming thread and pc: " + red.join(" | "));
      ok(/^\[RED\]   x0=0x[0-9a-f]+ x1=.* x29=0x[0-9a-f]+ x30=0x[0-9a-f]+ sp=0x[0-9a-f]+ nzcv=/.test(red.at(-1)!), "register dump: " + red.at(-1));
      check(rt, r);
      eq(rt.run().state, "Stopped", "run() again stays Stopped");
      return red.slice(-2);
    });
  faultCase("fault_jump", "a jump to an unmapped address", "jump", "jumping to 0x60000000, which is not mapped\n", (rt, r) => {
    eq(r.stop!.fault!.pc, 0x60000000n, "pc"); eq(r.stop!.fault!.thread, 0x1001, "thread");
  });
  faultCase("fault_undef", "an undefined instruction", "unimplemented", "executing an undefined instruction\n", (rt, r) => {
    eq(r.stop!.fault!.aux, 0xdeadn, "the instruction word");
    const pc = Number(r.stop!.fault!.pc), t = rt.modules[0].text;
    ok(pc >= t.addr && pc < t.addr + t.size, "pc in the module's text: " + hex(pc));
    eq(rt.dv().getUint32(pc, true), 0xdead, "the word at the reported pc");
  });
  faultCase("fault_load", "a load beyond the end of memory, in a second thread", "trap", "worker: loading from 0xf0000000, beyond the end of the linear memory\n", (rt, r) => {
    eq(r.stop!.fault!.thread, 0x1002, "the faulting thread is the worker");
    ok(r.stop!.fault!.detail.includes("out of bounds"), r.stop!.fault!.detail);
    ok(rt.memory.buffer.byteLength <= 0xF0000000, "the memory did not reach the address");
  });
  faultCase("fault_stack", "guest stack overflow by runaway recursion", "stack", "recursing without end\n", (rt, r) => {
    ok(Number(r.stop!.fault!.aux) < GUEST.stackRegion, "sp below the stack: " + hex(r.stop!.fault!.aux));
  });
  test("f fault: a damaged NSO ends in Stopped(fault load), and a deadlock is reported", () => {
    const rt = new Runtime(env.mods), bytes = env.nso("hello").slice();
    bytes[bytes.length - 9] ^= 0x40;
    eq(rt.loadNso([{ name: "hello", bytes }]), false, "load result");
    eq(rt.state, "Stopped", "state");
    const r = rt.run();
    eq(r.stop?.fault?.kind, "load", "fault kind");
    const lines = rt.red.slice(-1);
    // every thread waits forever: the main thread waits for an event nobody signals
    const rt2 = boot(["host_main", "host_lib"], {}, rt => {
      for (const name of ["forced_fn", "weak_fn", "host_log", "host_fill", "host_sum", "host_post"]) rt.register({ name, forced: name === "forced_fn", fn: () => 0 });
      rt.register({ name: "host_wait", fn: cpu => cpu.block(newEvent(cpu.rt).r, -1n, () => 0) });
    });
    const r2 = rt2.run();
    eq(r2.stop?.fault?.kind, "deadlock", "fault kind: " + rt2.red.join(" | "));
    return [...lines, ...rt2.red.slice(-2)];
  });

  test("f break: a fatal svcBreak ends in Stopped(break)", () => {
    const rt = boot(["break"]);
    const r = rt.run();
    eq(r.state, "Stopped", "state"); eq(r.stop?.kind, "break", "stop kind");
    eq(rt.stdout(), "calling svcBreak\n", "stdout");
    ok(rt.red.some(l => /^\[RED\] Break#1 reason=0x0 Result=0x1234/.test(l)), rt.red.join(" | "));
    return rt.red;
  });

  // ---- memory: reserve or grow ----
  test("memory: growing on demand against reserving 4 GB up front", () => {
    const lines: string[] = [];
    for (const reserve4g of [false, true]) {
      const before = env.rssMb?.() ?? 0, t0 = performance.now();
      const rt = boot(["hello"], { reserve4g });
      const made = performance.now() - t0;
      exited(rt.run(), 42, rt);
      lines.push(`${reserve4g ? "4 GB up front " : "grow on demand"}: memory ${(rt.memory.buffer.byteLength / 2 ** 20).toFixed(0)} MiB, ${rt.stats.grows} grows, runtime created and loaded in ${made.toFixed(1)} ms` +
        (env.rssMb ? `, process RSS ${before.toFixed(0)} -> ${env.rssMb().toFixed(0)} MB` : ""));
    }
    return lines;
  });

  // ---- (g) ----
  test(`g corpus: the ${new Set(env.corpus.map(g => g.name.split(".")[0])).size} flat test guests (${env.corpus.length} images) through this run loop as single-thread processes, budgets 100000 and 50`, () => {
    const lines: string[] = [], bad: string[] = [], known: string[] = [], surprise: string[] = [];
    let insns = 0, runMs = 0, trMs = 0;
    for (const budget of [100000, 50]) {
      let pass = 0;
      for (const g of env.corpus) {
        const rt = new Runtime(env.mods, { budget });
        ok(rt.loadFlat(g.image, g.side), `${g.name}: load failed`);
        const r = rt.run();
        let why = "";
        const got = rt.stdoutBytes();
        if (r.stop?.kind !== "exit") why = `stopped with ${r.stop?.kind} ${r.stop?.fault?.kind ?? ""}: ${rt.red.at(-2) ?? ""}`;
        else if (got.length !== g.expected.length || got.some((b, i) => b !== g.expected[i])) why = "stdout differs";
        else if (g.side.exit_code !== undefined && r.stop.code !== g.side.exit_code) why = `exit code ${r.stop.code}, expected ${g.side.exit_code}`;
        const isKnown = CORPUS_KNOWN_FAILING.includes(g.name.split(".")[0]);
        if (!why) { pass++; if (isKnown) surprise.push(g.name); }
        else if (isKnown) { if (budget !== 50) known.push(`${g.name} (${why.slice(0, 60)})`); }
        else bad.push(`${g.name} [budget ${budget}]: ${why}`);
        if (budget !== 50 && !why) { insns += g.side.insn_count ?? 0; runMs += rt.stats.runMs - rt.a64.translateNs / 1e6; trMs += rt.a64.translateNs / 1e6; }
      }
      lines.push(`budget ${budget}: ${pass} of ${env.corpus.length} images pass`);
    }
    lines.push(`expected failures (known translator gaps, src/a64/README.md): ${known.length ? known.join(", ") : "none"}`);
    if (surprise.length) lines.push(`known-failing programs that PASSED (update CORPUS_KNOWN_FAILING): ${[...new Set(surprise)].join(", ")}`);
    lines.push(`speed (budget 100000, passing images): ${insns} guest instructions in ${runMs.toFixed(0)} ms of run time = ${(insns / runMs / 1000).toFixed(1)} M insn/s (translation ${trMs.toFixed(0)} ms not included)`);
    if (bad.length) fail(bad.join("\n"));
    return lines;
  });

  // ---- speed of (c) ----
  test("c threads: guest instructions per second", () => {
    // one function per instruction makes a budget unit one guest instruction: that run counts them
    const counted = threads({ maxInsns: 1, budget: 1 << 20, nsPerUnit: 1 });
    const insns = counted.units;
    let best = Infinity, tr = 0;
    for (let i = 0; i < 5; i++) { const rt = threads({}); const ms = rt.stats.runMs - rt.a64.translateNs / 1e6; if (ms < best) { best = ms; tr = rt.a64.translateNs / 1e6; } }
    return [`${insns} guest instructions (counted in single-instruction mode); best of 5 normal runs: ${best.toFixed(1)} ms run time = ${(insns / best / 1000).toFixed(1)} M insn/s (translation ${tr.toFixed(1)} ms not included)`];
  });
  return list;
}

function newEvent(rt: Runtime): { r: number; w: number } {
  const p = (rt.r.rt_scratch_ptr() >>> 0) + 3072;
  const r = rt.k.kernel_event_new(p);
  return { r, w: rt.dv().getUint32(p, true) };
}

export function runCases(env: Env, only: string | undefined, report: (r: CaseResult) => void): CaseResult[] {
  const out: CaseResult[] = [];
  for (const c of cases(env)) {
    if (only && !c.name.includes(only)) continue;
    const t0 = performance.now();
    let r: CaseResult;
    try { const info = c.fn(); r = { name: c.name, ok: true, why: "", info, ms: performance.now() - t0 }; }
    catch (e) { r = { name: c.name, ok: false, why: e instanceof Error ? (e.stack ?? e.message) : String(e), info: [], ms: performance.now() - t0 }; }
    out.push(r); report(r);
  }
  return out;
}
export function formatResult(r: CaseResult): string {
  return (r.ok ? `ok   ${r.name} (${r.ms.toFixed(0)} ms)` : `[RED] FAIL ${r.name}\n${r.why}`) + r.info.map(l => "\n       " + l).join("");
}
export { PCMAP, STUBS };
