// The runtime's end-to-end tests, written once for Node (run.mts) and the browser Worker (web/worker.ts): no Node APIs.
// Each case builds its own Runtime (translator + loader + kernel + runtime core on one linear memory), loads real NSO
// files built from test/runtime/src and checks what the guest printed and how the process ended.
import { Runtime, type RuntimeModules, type RuntimeOptions, type RunResult, type HostCpu } from "../../src/glue/rt_runtime.ts";
import { RANGES, HOST_END, STUBS, GUEST, GUARD_BASE } from "../../src/glue/rt_layout.ts";
import { attachHle } from "../../src/glue/hle_rt.ts";
import { RtGfx } from "../../src/glue/rt_gfx.ts";
import { RtFs } from "../../src/glue/rt_fs.ts";
import { RtAudio } from "../../src/glue/rt_audio.ts";
import { MemStorage } from "../../src/glue/fs_host.ts";
import { layoutFor, settingsFor, SPACE } from "../../src/glue/rt_process.ts";
import { handoffOptions } from "../../src/glue/rt_handoff.ts";
import type { HleHost } from "../../src/glue/hle_host.ts";
import { reportText } from "../../src/glue/rt_report.ts";

export interface CorpusGuest { name: string; side: any; image: Uint8Array; expected: Uint8Array }
export interface Env {
  mods: RuntimeModules;
  nso(name: string): Uint8Array;        // build/runtime/guests/<name>.nso
  file(name: string): Uint8Array;       // build/runtime/guests/<name> (any built file, e.g. plug.nro)
  corpus: CorpusGuest[];                // test/guests/out
  rssMb?: () => number;                 // resident memory of the process, when the host can tell
  haveGfxGuests?: boolean;              // cube.nso and cube2.nso were built (they need nxnative's nvn.h)
  // nxnative's game profiles as src/prepare converted them (Node: src/prepare/profiles/*.json), for the address-space survey
  profiles?: () => { id: string; apply: Record<string, string>; space: { heap_region: number; alias_region: number; stack_region: number } }[];
  mode?: string;                        // NX_MEM: "32" (default), "64" a 64-bit memory, "64hi" every process above 4 GB (tools/modes.mjs)
  guardRounds?: number;                 // rounds of the guard's cost measurement (default 7; RT_GUARD_ROUNDS for a measurement run)
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
  // The layout a Runtime without one gets: the kernel's default, or (NX_MEM=64hi) the same regions above 4 GB. The
  // cases take addresses from it, not from constants, so that they hold wherever the process is placed.
  const D = layoutFor(), hi = env.mode === "64hi", S32 = {};

  // ---- memory layout ----
  test("layout: the host ranges tile 0..0x08000000 and every module's static data ends inside its range", () => {
    const rt = new Runtime(env.mods);
    const ends: Record<string, number> = { rt: rt.r.rt_static_end(), loader: rt.ld.x.ld_heap_base(), kernel: rt.k.kernel_static_end() };
    const lines = RANGES.map(g => {
      const end = g.module ? ends[g.module] : 0;
      if (g.module && end) ok(end > g.lo && end <= g.hi, `${g.name}: static end ${hex(end)} outside ${hex(g.lo)}..${hex(g.hi)}`);
      return `${g.name.padEnd(14)} ${hex(g.lo).padStart(10)} .. ${hex(g.hi).padStart(10)}${g.module && end ? `  static data ends at ${hex(end)} (${((end - g.lo) / 1024).toFixed(0)} KiB of ${((g.hi - g.lo) / 1024).toFixed(0)})` : ""}`;
    });
    eq(RANGES[0].lo, 0, "first range"); eq(RANGES.at(-1)!.hi, HOST_END, "last range");
    eq(rt.memory.buffer.byteLength, HOST_END, "initial memory is the host area only");
    eq(rt.state, "Empty", "state");
    noRed(rt);
    return lines;
  });
  test("layout: a table with an overlap, a hole or an empty range is refused with a red line; so is static data outside its range", () => {
    const rt = new Runtime(env.mods), p = rt.r.rt_scratch_ptr();
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

  // ---- the address space per game ----
  test("layout per game: the heap / alias / stack split is chosen from the game's profile (reserved address space against what the pool lets it commit); processes run on a heap-heavy and an alias-heavy layout", () => {
    const GB = 2 ** 30, gb = (v: number) => (v / GB).toFixed(2);
    const lines: string[] = [];
    // (1) the two big classes of nxnative's profiles, and one that cannot fit
    // (the rule for a 32-bit memory, whatever the mode of this run: S32)
    const heapy = layoutFor({ heap: 3.25 * GB, alias: 0.25 * GB, stack: 0.25 * GB }, S32), aliasy = layoutFor({ heap: 0.125 * GB, alias: 4.375 * GB, stack: 0.25 * GB, sysResource: 0x800000 }, S32);
    const big = layoutFor({ heap: 9 * GB, alias: 0.25 * GB, stack: 0.25 * GB, appPool: 0x240000000 }, S32);
    eq([heapy.fit, aliasy.fit, big.fit], ["pool", "pool", "short"], "how the three fit");
    ok(heapy.heapSize >= 0xCD500000 - 0x04000000 && heapy.aliasSize >= 0.25 * GB, `heap-heavy: heap ${gb(heapy.heapSize)} GB must hold pool - used, alias ${gb(heapy.aliasSize)}`);
    ok(aliasy.aliasSize >= 0xCD500000, `alias-heavy: the alias region (${gb(aliasy.aliasSize)} GB) must hold the whole pool`);
    for (const l of [heapy, aliasy, big, layoutFor({}, S32)]) ok(l.heapBase === SPACE.lo && l.stackBase === l.heapBase + l.heapSize && l.aliasBase === l.stackBase + l.stackSize && l.aliasBase + l.aliasSize <= SPACE.hi, "regions in order, inside the space");
    eq(layoutFor({}, S32).fit, "profile", "the default sizes fit as they are");
    for (const [name, layout] of [["heap-heavy", heapy], ["alias-heavy", aliasy], ["9 GB pool", big]] as const) {
      const rt = boot(["heap"], { layout });
      const r = rt.run();
      exited(r, 0, rt);
      ok(rt.stdout().split("\n").length > 3, "the heap guest printed its memory walk: " + rt.stdout());
      eq(rt.red.filter(l => !/^\[RED\] runtime: the profile reserves/.test(l)), [], name + ": red lines");
      eq(rt.red.length, layout.fit === "short" ? 1 : 0, name + ": one red line exactly when the pool cannot fit");
      lines.push(`${name}: heap ${gb(layout.heapSize)} GB at ${hex(layout.heapBase)}, stack region ${gb(layout.stackSize)} at ${hex(layout.stackBase)}, alias ${gb(layout.aliasSize)} at ${hex(layout.aliasBase)} (${layout.fit}); the heap guest runs on it`);
    }
    // (2) every profile nxnative has
    const profiles = env.profiles?.();
    if (!profiles) { lines.push("the profile survey needs src/prepare/profiles (Node): SKIPPED here"); return lines; }
    const n = { profile: 0, pool: 0, short: 0 }, n64 = { profile: 0, pool: 0, short: 0 }, fixed = { fits: 0 }, shortIds: string[] = [];
    let real64 = 0;
    for (const p of profiles) {
      const s = settingsFor(p.apply, { space: p.space, mem64: false });
      n[s.layout.fit]++;
      // ... and by the same rule with a 64-bit memory's room, for those that are short
      const c = settingsFor(p.apply, { space: p.space, mem64: "auto" }).choice!;
      eq(c.mem64, s.layout.fit === "short", `${p.id}: a 64-bit memory exactly when the 32-bit layout is short`);
      if (c.mem64) { n64[c.layout.fit]++; real64 = Math.max(real64, c.real); ok(c.layout.aliasBase + c.layout.aliasSize <= 0x3_FFFF_0000 && (c.layout.fit === "profile" || c.layout.heapSize + c.layout.aliasSize >= c.layout.appPool - c.layout.memUsed), `${p.id}: ${c.sentence}`); }
      if (s.layout.fit === "short") shortIds.push(`${p.id} (pool ${gb(s.layout.appPool)}+ GB, heap ${gb(p.space.heap_region)}, alias ${gb(p.space.alias_region)})`);
      if (p.space.heap_region <= 0x60000000 && p.space.alias_region <= 0x77FF0000) fixed.fits++;
    }
    lines.push(`${profiles.length} profiles: with the fixed map (heap 1.5 GB, alias 1.87 GB) ${fixed.fits} have room for what they reserve; with the split chosen per game ${n.profile} fit as reserved, ${n.pool} more fit everything their pool lets them commit, ${n.short} cannot (pool larger than the address space)`,
      `cannot fit in a 32-bit memory: ${shortIds.join("; ") || "none"}`,
      `of those ${n.short}, in a 64-bit memory (16 GB): ${n64.profile} fit as reserved, ${n64.pool} fit everything their pool lets them commit, ${n64.short} cannot; the most real memory one may come to hold: ${gb(real64)} GB`);
    eq(n64.short, 0, "every profile fits a 64-bit memory");
    eq(n.profile + n.pool + n.short, profiles.length, "every profile classified");
    return lines;
  });

  test("hand-off: a prepared game's profile becomes the process's options (layout, kernel settings, stack, the take-over table's configuration), and a module's applied cuts are part of its translation cache key", () => {
    const msg = { titleId: "0100AAAA0000B000", programId: "0100AAAA0000B000", name: "Synthetic", displayVersion: "1.2.3",
      profile: { id: "0100AAAA0000B000", provisional: false, apply: { app_pool: "0x40000000", mem_used: "0x8000000", sys_resource: "0x800000", mem_map_limit: "on", op_mode: "handheld", perf_mode: "boost", alloc_big_align: "on", game_env: "A=1 B=2", launch_param: "lang8" },
        needs: [{ key: "address_space", value: "heap 0x8000000 alias 0x118000000", what: "" }, { key: "fps_target", value: "60", what: "a frame-step patch" }] },
      npdm: { stackSize: 0x200000 }, modules: [{ name: "hello", buildId: "", cuts: 2 }, { name: "sdk", buildId: "", cuts: 0 }],
      cuts: [{ module: "hello", offset: 0x100, size: 4 }, { module: "hello", offset: 0x200, size: 8 }] };
    const o = handoffOptions(msg, { space: S32 }), l = o.layout;
    eq([l.fit, l.appPool, l.memUsed, l.sysResource, l.flags, l.programId.toString(16), o.mainStackSize], ["pool", 0x40000000, 0x8000000, 0x800000, 1, "100aaaa0000b000", 0x200000], "layout fit, pool, used, system resource, flags, program id, stack size");
    ok(l.aliasSize >= 0x40000000 && l.heapSize === 0x8000000, `regions: heap ${hex(l.heapSize)}, alias ${hex(l.aliasSize)}`);
    eq(o.hle, { opmode: 0, perfBoost: true, allocBigAlign: true, gameEnv: "A=1 B=2", launchSpec: "lang8", displayVersion: "1.2.3" }, "the take-over table's configuration");
    eq([Object.keys(o.cutsKey), o.notes.length], [["hello"], 2], "modules with cuts, notes");
    // the graphics layer's switches (src/gfx/profile.ts): none for this profile; each key its bit; tex_dirty_upload only with tex_flush_upload, as nxnative demands
    const bits = (apply: Record<string, string>) => settingsFor(apply).gfx.bits;
    eq([o.gfx.bits, bits({ render_cond: "on" }), bits({ tex_flush_upload: "on" }), bits({ tex_flush_upload: "on", tex_dirty_upload: "on" }), bits({ tex_dirty_upload: "on" }), bits({ gpu_timestamps: "segment" }), bits({ gpu_timestamps: "submission" }),
      bits({ present_interval: "display" }), bits({ present_interval: "game", render_cond: "off" }), bits({ render_cond: "on", tex_flush_upload: "on", tex_dirty_upload: "on", gpu_timestamps: "segment", present_interval: "display" })],
      [0, 1, 2, 6, 0, 8, 0, 16, 0, 31], "the profile's graphics keys as the recorder's bits");
    // the process: the kernel reports what the profile says; the cache key of the cut module differs from the uncut one's
    const keys: string[] = [];
    const store = { get: async (k: string) => { keys.push(k); return null; }, put: async () => { } };
    const rt = boot(["hello"], { layout: o.layout, mainStackSize: o.mainStackSize, cutsKey: o.cutsKey, cache: store });
    void rt.cacheLoad();
    const plain = boot(["hello"], { cache: store }); void plain.cacheLoad();
    ok(keys.length === 2 && keys[0] !== keys[1] && keys[0].includes("+cuts" + o.cutsKey.hello) && !keys[1].includes("+cuts"), "cache keys: " + keys.join(" | "));
    exited(rt.run(), 42, rt);
    const q = rt.r.rt_query_ptr();
    rt.k.kernel_query_memory(BigInt(l.stackBase), q);
    eq([Number(rt.dv().getBigUint64(q, true)), Number(rt.dv().getBigUint64(q + 8, true))], [l.stackBase, 0x200000], "the main stack: at the layout's stack region, the NPDM's size");
    noRed(rt);
    return [`layout ${l.fit}: heap ${hex(l.heapSize)}, alias ${hex(l.aliasSize)} at ${hex(l.aliasBase)}, pool ${hex(l.appPool)}; stack ${hex(o.mainStackSize!)}; cache key ${keys[0].slice(0, 20)}...${keys[0].slice(keys[0].indexOf("+cuts"))}`, ...o.notes];
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

  // ---- (sdk) ----
  test("sdk start: a program with nnosInitialize and nnMain starts in nn::init::Start's order (os first, each module's DT_INIT only, in load order, then nnMain)", () => {
    const rt = boot(["sdk_main", "two_lib"]);
    exited(rt.run(), 7, rt);
    eq(rt.stdout(), "_init_libc0 (os not up)\nnnosInitialize main thread handle=0x1001 x1=0\n_init_libc1 (os up)\nnninitInitializeSdkModule (os up)\n" +
      "nninitStartup (os up)\n_init_libc2 (os up)\nmain: DT_INIT (os up)\nlib: DT_INIT\nnnMain (os up)\nlib_counter (5 + 1 by the library's DT_INIT only) = 6\n", "stdout");
    noRed(rt);
    return ["os, libc, nninitStartup, then DT_INIT of sdk_main and two_lib, then nnMain"];
  });

  // ---- ZBIC: the segment compression of system 22.0.0 on (src/loader/zbic.ts) ----
  test("zbic: programs whose segments are ZBIC compressed (NSO flag bit 7) load with their hashes checked and run as their LZ4 builds do; the committed file of the reference codec too; a damaged one is a load fault", () => {
    const flags = (n: string) => new DataView(env.nso(n).buffer).getUint32(0x0C, true);
    for (const n of ["hello_zbic", "two_main_zbic", "two_lib_zbic", "hello_zbicfix"]) eq(flags(n) & 0xB8, 0xB8, `${n}: flag bit 7 and three hashes`);
    const lines: string[] = [];
    for (const n of ["hello_zbic", "hello_zbicfix"]) {
      const rt = boot([n]);
      exited(rt.run(), 42, rt);
      eq(rt.stdout(), "hello from an NSO\nx0=0 main thread handle=0x1001\n", `stdout of ${n}`);
      noRed(rt);
      lines.push(`${n}: ${env.nso(n).length} bytes (LZ4: ${env.nso("hello").length}), image ${hex(rt.modules[0].imageSize)}`);
    }
    const two = boot(["two_main_zbic", "two_lib_zbic"]);
    exited(two.run(), 3, two);
    eq(two.stdout(), TWO, "stdout of the two ZBIC modules");
    noRed(two);
    // one ZBIC module beside an LZ4 one
    const mixed = boot(["two_main_zbic", "two_lib"]);
    exited(mixed.run(), 3, mixed);
    eq(mixed.stdout(), TWO, "stdout of a ZBIC module with an LZ4 one");
    // every bit of one byte in the middle of each segment's stream: refused by the decoder or by the hash, never run
    const good = env.nso("hello_zbicfix"), dv = new DataView(good.buffer, good.byteOffset, good.byteLength);
    let n = 0;
    for (let i = 0; i < 3; i++) for (let bit = 0; bit < 8; bit++, n++) {
      const bad = good.slice(); bad[dv.getUint32(0x10 + 16 * i, true) + (dv.getUint32(0x60 + 4 * i, true) >> 1)] ^= 1 << bit;
      const rt = new Runtime(env.mods);
      ok(!rt.loadNso([{ name: "damaged", bytes: bad }]), `bit ${bit} of segment ${i} flipped: the module loaded`);
      ok(rt.red.some(l => /segment does not (decompress \(damaged ZBIC stream: [^)]+\)|match its SHA-256 in the header)/.test(l)), `bit ${bit} of segment ${i}: ` + rt.red.join(" | "));
    }
    lines.push(`${n} single-bit flips of hello_zbicfix: every one a load fault with the loader's reason`);
    return lines;
  });

  test("b two modules mapped high in the code region (0x16000000): the pc map reaches every code address, same output", () => {
    const codeBase = D.codeBase + 0x0E00_0000;
    const rt = boot(["two_main", "two_lib"], { codeBase });
    eq(rt.modules[0].base, codeBase, "base");
    exited(rt.run(), 3, rt);
    eq(rt.stdout(), TWO, "stdout");
    noRed(rt);
    return [`modules at ${hex(rt.modules[0].base)} and ${hex(rt.modules[1].base)}`];
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
    const hot = rt.hotCode(3);
    ok(hot.length >= 2 && /^\d+ slice ends sampled at \d+ pcs$/.test(hot[0]) && /^ *\d+\.\d% .+; hottest pc 0x[0-9a-f]+ is /.test(hot[1]), "hot code lines: " + hot.join(" | "));
    ok(hot.some(l => /^by guest thread/.test(l)) && hot.some(l => /^ +\d+\.\d% thread #\d+/.test(l)), "hot code by thread: " + hot.join(" | "));
    ok(hot.some(l => /^ +\d+% from 0x[0-9a-f]+ /.test(l)), "hot code callers: " + hot.join(" | "));
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
    eq(lines[0], `SetHeapSize(4 MB): rc=0x0 base=${hex(D.heapBase)}`, "line 1");
    ok(/^allocator: 3 rounds of 200 blocks, corrupted=0 failed=0 blocks=\d+ bytes in use=\d+$/.test(lines[1]), lines[1]);
    eq(lines[2], "SetHeapSize(8 MB): rc=0x0 same base: yes, first allocation intact: yes", "line 3");
    eq(lines[3], `address space ${hex(D.codeBase)} + ${hex(D.aliasBase + D.aliasSize - D.codeBase)}`, "line 4");
    ok(/^walk: \d+ segments, contiguous and complete: yes$/.test(lines.at(-1)!), lines.at(-1)!);
    const segs = lines.filter(l => l.startsWith("  ")).map(l => { const m = /^  (0x[0-9a-f]+) \+ (0x[0-9a-f]+) state=(0x[0-9a-f]+) perm=(...)$/.exec(l)!; return { lo: Number(m[1]), size: Number(m[2]), state: Number(m[3]), perm: m[4] }; });
    const at = (lo: number) => segs.find(s => s.lo === lo) ?? fail(`no segment starts at ${hex(lo)}\n${out}`);
    const m = rt.modules[0];
    eq(at(m.base), { lo: m.base, size: m.ro.addr - m.base, state: 3, perm: "r-x" }, "the module's text");
    eq(at(m.ro.addr), { lo: m.ro.addr, size: m.data.addr - m.ro.addr, state: 3, perm: "r--" }, "the module's read-only data");
    eq(at(m.data.addr), { lo: m.data.addr, size: m.base + m.imageSize - m.data.addr, state: 4, perm: "rw-" }, "the module's data and bss");
    eq(at(D.tlsBase), { lo: D.tlsBase, size: 0x400000, state: 0xC, perm: "rw-" }, "thread-local region");
    eq(at(D.heapBase), { lo: D.heapBase, size: 0x800000, state: 5, perm: "rw-" }, "heap");
    eq(at(D.stackBase), { lo: D.stackBase, size: GUEST.mainStackSize, state: 0xB, perm: "rw-" }, "the main thread's stack");
    eq(segs.filter(s => s.state !== 0).length, 6, "mapped segments");
    for (const s of segs) if (s.state === 0) eq(s.perm, "---", `free segment at ${hex(s.lo)}`);
    return lines.slice(3);
  });

  // ---- a process beyond 4 GB ----
  test("d a 9 GB pool (64-bit memory): the layout of a Switch 2 profile; SetHeapSize of 6.2 GB in one call; a pattern at the bottom, in the middle and at the top of the heap and in an alias mapping above 8 GB; QueryMemory", () => {
    const GB = 2 ** 30, MB = 2 ** 20;
    // the memory keys of nxnative's profile for a Switch 2 title (heap 8 GB, alias 4 GB, a 9 GB pool, map limit on)
    const apply = { app_pool: "0x240000000", mem_used: "0x4000000", sys_resource: "0x3000000", mem_map_limit: "on" }, space = { heap_region: 8 * GB, alias_region: 4 * GB, stack_region: 0.25 * GB };
    const s32 = settingsFor(apply, { space, mem64: false }), s = settingsFor(apply, { space, mem64: "auto" }), l = s.layout, c = s.choice!;
    eq([s32.layout.fit, c.mem64, l.fit, !!l.mem64], ["short", true, "profile", true], "short in 32 bits; the choice is the 64-bit layout, which fits as reserved");
    ok(/^runs in 64-bit memory mode: heap 8\.0 GB, alias 4\.0 GB, pool 9\.0 GB \(as the profile reserves them\); the tab may come to use up to 9\.\d GB of real memory$/.test(c.sentence), c.sentence);
    ok(l.aliasBase > 8 * GB && l.aliasBase + l.aliasSize <= 0x3_FFFF_0000 && l.heapBase === l.codeBase + l.codeSize + l.tlsSize && l.aliasArena === 2 * MB, `the regions: heap at ${hex(l.heapBase)}, alias at ${hex(l.aliasBase)}, page-table arena ${l.aliasArena}`);
    if (!env.mode || env.mode === "32") {
      let msg = "";
      try { new Runtime(env.mods, { layout: l }); } catch (e) { msg = String(e); }
      ok(/the process layout is one for a 64-bit memory/.test(msg), "a Runtime on a 32-bit memory refuses the layout by name: " + msg);
      return [c.sentence, "memory32: the Runtime refuses this layout by name; the process itself runs under NX_MEM=64 and NX_MEM=64hi"];
    }
    const before = env.rssMb?.() ?? 0, rt = boot(["big"], { layout: l }), t0 = performance.now();
    exited(rt.run(), 0, rt);
    noRed(rt);
    const HEAP = 0x18ce00000, m = l.aliasBase + l.aliasSize - 64 * MB, free = l.stackBase + GUEST.mainStackSize;
    eq(rt.stdout().trimEnd().split("\n"), [
      `heap region ${hex(l.heapBase)} + ${hex(l.heapSize)}, alias region ${hex(l.aliasBase)} + ${hex(l.aliasSize)}, pool 0x240000000`,
      `SetHeapSize(0x18ce00000): rc=0x0 base=${hex(l.heapBase)}`,
      "heap bottom (+0x0): 0 of 512 words wrong",
      "heap middle (+0xc6700000): 0 of 512 words wrong",
      "heap top (+0x18cdff000): 0 of 512 words wrong; 4 GB lower reads 0x0",
      `the heap's last byte: rc=0x0 ${hex(l.heapBase)} + 0x18ce00000 state=0x5 perm=0x3`,
      "MapPhysicalMemory at the alias region's end - 64 MB (above 8 GB: yes): rc=0x0",
      "alias mapping: 0 of 2048 words wrong; 4 GB lower reads 0x0",
      `the mapping: rc=0x0 ${hex(m)} + 0x4000 state=0x5 perm=0x3`,
      `below it: rc=0x0 ${hex(free)} + ${hex(m - free)} state=0x0 perm=0x0`,
      "UnmapPhysicalMemory: rc=0x0",
      "SetHeapSize(6.2 GB + 8 GB): rc=0xd001",
      "SetHeapSize(2 MB): rc=0x0",
    ], "what the guest saw");
    ok(m > 8 * GB && rt.memory.buffer.byteLength >= m + 0x4000, `the memory reaches the mapping: ${rt.memory.buffer.byteLength} bytes`);
    // the host reads the same bytes at the same addresses: the pattern the guest left at the heap's top and bottom
    const dv = rt.dv(), word = (a: number) => BigInt.asUintN(64, BigInt(a) * 0x9E3779B97F4A7C15n);
    eq([dv.getBigUint64(l.heapBase, true), dv.getBigUint64(l.heapBase + HEAP - 0x1000, true)].map(hex), [word(l.heapBase), word(l.heapBase + HEAP - 0x1000)].map(hex), "the heap's first word and the first word of its last page, read by the host");
    return [c.sentence, `layout: code ${hex(l.codeBase)}, heap ${hex(l.heapBase)} + ${(l.heapSize / GB).toFixed(1)} GB, stack region ${hex(l.stackBase)}, alias ${hex(l.aliasBase)} + ${(l.aliasSize / GB).toFixed(1)} GB (page-table arena ${l.aliasArena! / MB} MB at the top of the code region)`,
      `ran in ${(performance.now() - t0).toFixed(0)} ms; the linear memory is ${(rt.memory.buffer.byteLength / GB).toFixed(2)} GB of address space` + (env.rssMb ? `, resident memory of the process grew by ${(env.rssMb() - before).toFixed(0)} MB (seven pages of the 6.2 GB heap and the mapping were touched)` : ""),
      `${rt.k.kernel_alias_leaves(0)} leaf of the alias page table in use`];
  });

  // ---- (e) ----
  for (const budget of [100000, 50]) test(`e host calls (budget ${budget}): forced and weak take-overs, an unresolved import (red once, returns 0), guest memory access, a blocking host function, a callback into guest code`, () => {
    let token: bigint | null = null, ev = { r: 0, w: 0 }, hostLines: string[] = [], waits = 0;
    const rt = boot(["host_main", "host_lib"], { budget }, rt => {
      rt.register({ name: "forced_fn", forced: true, fn: cpu => cpu.w(0) * 2 + 1000 });
      rt.register({ name: "weak_fn", fn: cpu => cpu.w(0) * 101 });
      rt.register({ name: "lib_wins", fn: () => 0xBAD });
      rt.register({ name: "host_log", fn: cpu => { hostLines.push(cpu.cstr(cpu.x(0))); cpu.log("guest: " + cpu.cstr(cpu.x(0))); } });
      rt.register({ name: "host_fill", fn: cpu => { const n = cpu.w(1), seed = cpu.w(2); cpu.write(cpu.x(0), Uint8Array.from({ length: n }, (_, i) => (i * seed + 1) & 0xFF)); } });
      rt.register({ name: "host_sum", fn: cpu => cpu.read(cpu.x(0), cpu.w(1)).reduce((a, b) => a + b, 0) });
      rt.register({ name: "host_each", fn: cpu => { const fn = cpu.x(0), n = cpu.w(1), ctx = cpu.x(2); let sum = 0n; for (let i = 0; i < n; i++) sum += cpu.call(fn, i, ctx); return sum; } });
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
    let each = 0n;
    for (let i = 0n; i < 5n; i++) { let v = 7n; for (let k = 0n; k < 3000n; k++) v = BigInt.asUintN(64, v * 31n + i + k); each += v & 0xFFFFn; }
    const sum = Array.from({ length: 64 }, (_, i) => (i * 3 + 1) & 0xFF).reduce((a, b) => a + b, 0);
    eq(rt.stdout(), `forced_fn(5) = 1010\nlib_calls_forced(5) = 1011\nweak_fn(3) = 303\nlib_wins(3) = 2003\nmissing_fn(9) = 0\nmissing_fn(10) = 0\n` +
      `host_fill wrote, guest sums ${sum}, host_sum reads ${sum}\nhost_wait(1 ms) with nobody posting = -1\nhost_wait() = 77, blocked at least 2 ms: yes\n  a guest callback, called by the host, making an SVC\nhost_each: 5 callbacks, sum ${each}\nhost calls done\n`, `stdout (budget ${budget})`);
    eq(hostLines, ["a line from the guest through host_log"], "host_log");
    eq(waits, 2, "host_wait calls");
    const calls = rt.red.filter(l => l.startsWith("[RED] call to unresolved import"));
    eq(calls.length, 1, "red lines for the unresolved call");
    ok((hi ? /^\[RED\] call to unresolved import missing_fn from 0x18[0-9a-f]{7}$/ : /^\[RED\] call to unresolved import missing_fn from 0x8[0-9a-f]{6}$/).test(calls[0]), calls[0]);
    eq(rt.set!.unresolved.map(u => `${u.module}:${u.name}`), ["host_main:missing_fn"], "what the loader reported unresolved");
    const fns = rt.ld.hostFunctions().map(f => `${f.name}:${["weak", "forced", "unresolved"][f.kind]}:${f.refs ? "used" : "unused"}`);
    ok(fns.includes("forced_fn:forced:used") && fns.includes("lib_wins:weak:unused") && fns.includes("missing_fn:unresolved:used"), fns.join(" "));
    return [...rt.red, `${rt.stats.hostCalls} host calls (stub table: ${fns.join(", ")})`];
  });

  // ---- (f) ----
  const faultCase = (file: string, what: string, kind: string, before: string, check: (rt: Runtime, r: RunResult) => void, o: RuntimeOptions = {}) =>
    test(`f fault: ${what} ends in Stopped(fault ${kind}) with a red line`, () => {
      const rt = boot([file], o);
      let r!: RunResult;
      try { r = rt.run(); } catch (e) { fail(`run() threw instead of stopping: ${e}`); }
      eq(r.state, "Stopped", "state"); eq(rt.state, "Stopped", "machine state");
      eq(r.stop?.kind, "fault", "stop kind"); eq(r.stop?.fault?.kind, kind, `fault kind (${rt.red.join(" | ")})`);
      eq(rt.stdout(), before, "stdout before the fault");
      const red = rt.red, lines = r.stop!.fault!.lines, at = red.lastIndexOf(lines[0]);
      eq(lines, red.slice(at), "the fault's lines are the red lines from its first on");
      ok(/in thread 0x10\d\d \(#\d\) at pc=0x[0-9a-f]+/.test(lines[0]), "red line naming thread and pc: " + red.join(" | "));
      const regs = lines.slice(1, 5).join(" ").replace(/\[RED\]   /g, "");
      ok(new RegExp("^" + Array.from({ length: 31 }, (_, i) => `x${i}=0x[0-9a-f]+`).join(" ") + " sp=0x[0-9a-f]+ pc=0x[0-9a-f]+ nzcv=0x[0-9a-f]+ tpidr=0x[0-9a-f]+ tpidrro=0x[0-9a-f]+$").test(regs), "register dump, x0..x30 sp pc nzcv tpidr tpidrro: " + regs);
      ok(regs.includes(` pc=${hex(r.stop!.fault!.pc)} `), "the dump's pc is the fault's");
      ok(lines.some(l => /^\[RED\]   pc=0x[0-9a-f]+ is .*; x30=0x[0-9a-f]+ is /.test(l)), "pc and x30 placed: " + lines.join(" | "));
      ok(lines.some(l => /^\[RED\]   (the frames from x29=0x[0-9a-f]+, innermost first:|no frame record at x29=0x[0-9a-f]+)$/.test(l)), "the x29 frames' heading: " + lines.join(" | "));
      ok(lines.some(l => /^\[RED\]   the last \d+ of the \d+ SVCs of thread 0x10\d\d, oldest first:$/.test(l)), "the SVC ring's heading: " + lines.join(" | "));
      check(rt, r);
      eq(rt.run().state, "Stopped", "run() again stays Stopped");
      return lines;
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
  // (placed above 4 GB, the memory reaches past 0xF000_0000: the guest built to load from 0x3_F000_0000 is used)
  faultCase(hi ? "fault_load_hi" : "fault_load", "a load beyond the end of memory, in a second thread", "trap", `worker: loading from ${hi ? "0x3f0000000" : "0xf0000000"}, beyond the end of the linear memory\n`, (rt, r) => {
    eq(r.stop!.fault!.thread, 0x1002, "the faulting thread is the worker");
    ok(r.stop!.fault!.detail.includes("out of bounds"), r.stop!.fault!.detail);
    ok(rt.memory.buffer.byteLength <= (hi ? 0x3_F000_0000 : 0xF0000000), "the memory did not reach the address");
    // the ring is the faulting thread's: the worker's one say(), not the main thread's CreateThread / StartThread / wait
    const svcs = r.stop!.fault!.lines.filter(l => l.startsWith("[RED]     #"));
    eq(svcs.length, 1, "the worker made one SVC: " + svcs.join(" | "));
    ok(/^\[RED\]     #1 svc 0x27 OutputDebugString\(/.test(svcs[0]), svcs[0]);
    ok(r.stop!.fault!.lines.includes("[RED]   the last 1 of the 1 SVCs of thread 0x1002, oldest first:"), r.stop!.fault!.lines.join(" | "));
  });
  faultCase("fault_stack", "guest stack overflow by runaway recursion", "stack", "recursing without end\n", (rt, r) => {
    ok(Number(r.stop!.fault!.aux) < D.stackBase, "sp below the stack: " + hex(r.stop!.fault!.aux));
  });
  // the guard on the host area (the default): a guest access below GUARD_BASE traps, and the trap's pc is the instruction itself
  const isMemInsn = (rt: Runtime, pc: bigint) => ((rt.dv().getUint32(Number(pc), true) >>> 25) & 5) === 4;
  faultCase("fault_null", "by default (the host-area guard), a read through a null pointer", "trap", "reading through a null pointer\n", (rt, r) => {
    const line = r.stop!.fault!.lines[0], pc = r.stop!.fault!.pc, t = rt.modules[0].text;
    ok(Number(pc) >= t.addr && Number(pc) < t.addr + t.size && isMemInsn(rt, pc), "the pc is a load instruction in the module's text: " + hex(pc));
    ok(!line.includes("last synced pc"), "the pc is exact: " + line);
    ok(line.includes("a null or host-area pointer") && line.includes("below " + hex(GUARD_BASE)), line);
    // issue #3: pc and x30 by symbol (read_word and read_through are in the module's dynamic symbol table) and the last SVCs
    const lines = r.stop!.fault!.lines, m = rt.modules[0], ctxPc = Number(pc);
    const sym = rt.ld.symbolAt(m.handle, ctxPc)!;
    eq(sym?.name, "read_word", "the symbol of the pc");
    const place = lines.find(l => l.startsWith("[RED]   pc="))!;
    ok(place.includes(`is fault_null+${hex(ctxPc - m.base)} (read_word+${hex(ctxPc - sym.value)})`), place);
    ok(/; x30=0x[0-9a-f]+ is fault_null\+0x[0-9a-f]+ \(read_through\+0x[0-9a-f]+\)$/.test(place), place);
    ok(lines.some(l => l.includes("the registers are as last written back")), "a trap without preciseFaults 2 says its registers are not exact");
    const svcs = lines.filter(l => l.startsWith("[RED]     #"));
    const frames = lines.filter(l => l.startsWith("[RED]     frame "));
    ok(/^\[RED\]     frame 1: fp=0x[0-9a-f]+ returns to 0x[0-9a-f]+, fault_null\+0x[0-9a-f]+ \(/.test(frames[0] ?? ""), "the first frame record by x29 returns into the guest: " + frames.join(" | "));
    ok(svcs.length >= 1 && /^\[RED\]     #\d+ svc 0x27 OutputDebugString\(x0=0x[0-9a-f]+ x1=0x1f\) -> 0x0, returns to 0x8[0-9a-f]+$/.test(svcs.at(-1)!.replace(/0x18[0-9a-f]{7}$/, "0x8000000")), "the say() before the read: " + svcs.join(" | "));
    eq(rt.ld.symbolAt(m.handle, m.base), undefined, "no function symbol at the image's first byte (crt0 is hidden)");
    eq(rt.ld.symbolAt(m.handle, m.base + m.imageSize + 4096), undefined, "none outside the module");
    // the report's fault block is these lines
    const text = reportText({ title: "t", when: "-", userAgent: "-", adapter: "-", optionsKey: "-", options: "-", state: "Stopped", stop: "fault", fault: lines,
      modules: [], takeovers: null, machines: [], counters: {}, log: [], redTotal: lines.length });
    for (const l of lines) ok(text.includes("\n  " + l + "\n"), "in the report: " + l);
  });
  faultCase("fault_host", "by default (the host-area guard), a write into the kernel's static data", "trap", "writing into the host area (0x1000100, the kernel's static data)\n", (rt, r) => {
    ok(isMemInsn(rt, r.stop!.fault!.pc) && !r.stop!.fault!.lines[0].includes("last synced pc"), r.stop!.fault!.lines[0]);
    ok(rt.dv().getUint32(0x1000100, true) !== 0x55, "the word was not written");
  });
  test("f without the guard (`guard: false`, for measurements): the same null read returns zero and the same write lands in the kernel's memory", () => {
    const rt = boot(["fault_null"], { guard: false });
    exited(rt.run(), 1, rt);
    eq(rt.stdout(), "reading through a null pointer\nread 0x0\nNOT REACHED\n", "stdout");
    const rt2 = boot(["fault_host"], { guard: false });
    rt2.run();
    eq(rt2.dv().getUint32(0x1000100, true), 0x55, "the word in the kernel's static data");
    return ["a null read gave 0; 0x55 was written at 0x1000100"];
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
      for (const name of ["forced_fn", "weak_fn", "host_log", "host_fill", "host_sum", "host_post", "host_each"]) rt.register({ name, forced: name === "forced_fn", fn: () => 0 });
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

  // ---- one answer per name ----
  test("e one answer per name: registering a name twice is an error, override() replaces an answer on purpose, and an override of nothing is refused", () => {
    let seen = "";
    const rt = boot(["host_main", "host_lib"], {}, rt => {
      for (const name of ["weak_fn", "host_log", "host_fill", "host_sum", "host_post", "host_each", "host_wait"]) rt.register({ name, fn: () => 0 });
      rt.register({ name: "forced_fn", forced: true, fn: () => { seen += "first "; return 1; } });
      let err = "";
      try { rt.register({ name: "forced_fn", forced: true, fn: () => 2 }); } catch (e) { err = (e as Error).message; }
      ok(/forced_fn is registered twice/.test(err), "a second registration must throw: " + err);
      rt.override({ name: "forced_fn", forced: true, fn: () => { seen += "override "; return 700; } });
      err = "";
      try { rt.override({ name: "nobody_has_this", fn: () => 0 }); } catch (e) { err = (e as Error).message; }
      ok(/override of nobody_has_this, which is not registered/.test(err), "an override of an unregistered name must throw: " + err);
      ok(rt.registered("forced_fn") && !rt.registered("nobody_has_this"), "registered()");
    });
    rt.run({ slices: 400 });
    ok(seen.startsWith("override ") && !seen.includes("first"), "which answer the guest got: " + seen);
    // the take-over table and the file system on one process: no name is answered twice (attaching would throw)
    if (env.mods.hle && env.mods.fs && env.mods.gfx) {
      const all = new Runtime(env.mods);
      new RtGfx(all, env.mods.gfx); attachHle(all, env.mods.hle); new RtFs(all, env.mods.fs, new MemStorage());
      if (env.mods.audio) new RtAudio(all, env.mods.audio, {});
      let err = "";
      try { attachHle(all, env.mods.hle); } catch (e) { err = (e as Error).message; }
      ok(/is registered twice/.test(err), "attaching the table a second time must throw: " + err);
    }
    return [`the guest's calls of forced_fn went to the override (${seen.trim().split(" ").length} calls)`, "graphics, the take-over table, the file system and audio attach to one process without a name answered twice"];
  });
  test("e arguments beyond the eighth and generated code: a host function reads four stack arguments, the host calls a guest function with thirteen, and code the guest writes is translated again after each change", () => {
    const rt = boot(["argsg"], {}, rt => {
      rt.register({ name: "host_twelve", fn: cpu => { let s = 0n; for (let i = 0; i < 8; i++) s += BigInt(i + 1) * cpu.x(i); for (let i = 0; i < 4; i++) s += BigInt(i + 9) * cpu.stackArg(i); return s; } });
      rt.register({ name: "host_call13", fn: cpu => cpu.call(cpu.x(0), ...Array.from({ length: 13 }, (_, i) => 101 + i)) });
      rt.register({ name: "host_jit_alloc", fn: cpu => cpu.rt.jitAlloc(Number(cpu.x(0)), 0x2000)?.rx ?? 0n });
      rt.register({ name: "host_jit_written", fn: cpu => { cpu.rt.jitCodeWritten(Number(cpu.x(0)), Number(cpu.x(1)), Number(cpu.x(2))); } });
      rt.register({ name: "host_jit_free", fn: cpu => { cpu.rt.jitFree(Number(cpu.x(0)), Number(cpu.x(1)), 0, 0); } });
    });
    exited(rt.run(), 0, rt);
    let w12 = 0, w13 = 0; for (let i = 1; i <= 12; i++) w12 += i * i; for (let i = 1; i <= 13; i++) w13 += i * (100 + i);
    eq(rt.stdout(), `host_twelve(1..12), weighted by position = ${w12}\nhost_call13: sum13(101..113), weighted = ${w13}\na local of the caller after the call with stack arguments: 0x1122334455667788\n` +
      "generated code returns 41\ngenerated code returns 42\ngenerated code returns 43\nfreed code memory is handed out again\ncode in the reused block returns 7\n", "stdout");
    eq(rt.a64.codeRanges().length, 2, "code ranges at the end: the module and the code memory handed out again");
    noRed(rt);
    return [rt.stdout().split("\n")[0], rt.stdout().split("\n")[1]];
  });

  // ---- run-time modules, fini functions, the counter while the clock is frozen ----
  if (env.mods.hle) for (const budget of [100000, 50]) test(`h run-time modules (budget ${budget}): an NRO loaded through nn::ro (the take-over table's, over Runtime.loadModule), called, unloaded and loaded again three times`, () => {
    let hle!: HleHost;
    const rt = boot(["ro_main"], { budget }, rt => {
      hle = attachHle(rt, env.mods.hle!);
      rt.register({ name: "test_nro", fn: cpu => { const b = env.file("plug.nro"); if (b.length > Number(cpu.x(1))) return 0; cpu.write(cpu.x(0), b); return b.length; } });
    });
    const unitsBefore = () => rt.a64.units.length;
    exited(rt.run(), 0, rt);
    const round = (n: number) => `  plug: init function\nround ${n}: LoadModule rc=0x0 state=1\n  loading it again while loaded: rc=0x1\n  plug_counter after its init functions = 105\n` +
      `  plug_calc(7), which calls main_twice = ${14 + 105 + 1000 * n + 7}\n  plug_calc(7) again (its bss word grew) = ${14 + 105 + 1000 * n + 14}\n` +
      `  main's own import plug_bump, bound at load: ${106 + 1000 * n}\n  LookupModuleSymbol(no_such_symbol): rc=0x216\n  plug: fini function, counter ${106 + 1000 * n}\n` +
      `  unloaded: state=0, LookupSymbol rc=0x216, main's import is 0 again\n`;
    eq(rt.stdout(), `GetBufferSize of something that is no NRO: 0x816\nimage: NRO of ${env.file("plug.nro").length} bytes, GetBufferSize rc=0x0\n` +
      `LookupSymbol(plug_calc) before any load: rc=0x216\n` + round(1) + round(2) + round(3) + "ro done\n", "stdout");
    eq([hle.x.hle_ro_loaded(), hle.x.hle_call_count(hle.lookup("_ZN2nn2ro10LoadModuleEPNS0_6ModuleEPKvPvmi")), hle.x.hle_call_count(hle.lookup("_ZN2nn2ro12UnloadModuleEPNS0_6ModuleE"))], [0, 6, 3], "modules the table still holds, LoadModule and UnloadModule calls");
    eq([rt.stats.moduleLoads, rt.stats.moduleUnloads, rt.modules.length, rt.a64.codeRanges().length], [3, 3, 1, 1], "runtime: loads, unloads, modules and code ranges left");
    const main = rt.modules[0];
    ok(rt.a64.units.every(u => u.pcs.every(pc => pc === 0xFFFFFFFF || (pc >= main.base && pc < main.base + main.imageSize))), "no translated unit of the unloaded module is left");
    eq(rt.red.filter(l => !l.includes("is loaded already") && !l.includes("forced take-over entry with no reference")), ["[RED] ro::LookupSymbol cannot find plug_calc (first case)"], "red lines besides the three refused double loads");
    eq(rt.red.filter(l => l.includes("is loaded already")).length, 3, "refused double loads");
    return [`${unitsBefore()} units at the end, ${rt.a64.translatedFuncs} functions translated in all (the module's again after each load), ${rt.stats.entries} entries passed to the translator`,
      ...rt.logs.filter(l => l.startsWith("ro::LoadModule")).slice(0, 1)];
  });
  test("h fini: the main thread returns from the entry and the fini functions run (main's fini_array backwards, DT_FINI, then the library's), one of them sleeping", () => {
    const rt = boot(["fini", "two_lib"]);
    exited(rt.run(), 23, rt);
    eq(rt.stdout(), "lib: DT_INIT\nlib: init_array[0]\nlib: init_array[1]\nmain: entry returns 23\nmain: fini_array[1]\nmain: fini_array[0] (runs last of the array)\n" +
      "main: DT_FINI\nmain: DT_FINI slept\nlib: fini_array[0]\nlib: DT_FINI\n", "stdout");
    eq(rt.stats.finiCalls, 5, "fini calls");
    noRed(rt);
  });
  for (const budget of [100000, 50]) test(`h counter (budget ${budget}): a thread that reads cntpct_el0 while the clock is frozen for background parks at the read and resumes with its registers intact`, () => {
    const rt = boot(["clock"], { budget }, rt => rt.register({ name: "host_freeze", fn: cpu => { cpu.rt.freezeClock(1, cpu.w(0) !== 0); } }));
    exited(rt.run(), 0, rt);
    eq(rt.stdout(), "the reader is parked at its counter read\nthe reader went on: a + b = 42, its tick is not before the freeze\n", "stdout");
    ok(rt.stats.clockParks >= 1, "parks: " + rt.stats.clockParks);
    noRed(rt);
    return [`${rt.stats.clockParks} park${rt.stats.clockParks === 1 ? "" : "s"} at the counter read, ${rt.stats.slices} slices`];
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
        if (r.stop?.kind !== "exit") why = `stopped with ${r.stop?.kind} ${r.stop?.fault?.kind ?? ""}: ${r.stop?.fault?.lines[0] ?? ""}`;
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

  test("guard: what the trap on host-area accesses costs on the corpus (run time with `guard` on and off, interleaved)", () => {
    const rounds = env.guardRounds ?? 7, on: number[] = [], off: number[] = [];
    let insns = 0;
    const once = (guard: boolean) => {
      let ms = 0; insns = 0;
      for (const g of env.corpus) {
        const rt = new Runtime(env.mods, { guard });
        ok(rt.loadFlat(g.image, g.side), `${g.name}: load failed`);
        const r = rt.run();
        ok(r.stop?.kind === "exit", `${g.name} with guard ${guard}: ${r.stop?.fault?.lines[0] ?? r.stop?.kind}`);
        ms += rt.stats.runMs - rt.a64.translateNs / 1e6; insns += g.side.insn_count ?? 0;
      }
      return ms;
    };
    once(true); once(false);   // warm up
    // the order within a round alternates, so that neither setting always runs second
    for (let i = 0; i < rounds; i++) { if (i & 1) { off.push(once(false)); on.push(once(true)); } else { on.push(once(true)); off.push(once(false)); } }
    const stat = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return { min: s[0], med: s[s.length >> 1] }; };
    const a = stat(on), b = stat(off), pct = (x: number, y: number) => ((x / y - 1) * 100).toFixed(1);
    const d = on.map((v, i) => (v / off[i] - 1) * 100), m = d.reduce((x, y) => x + y, 0) / d.length, se = Math.sqrt(d.reduce((x, v) => x + (v - m) ** 2, 0) / Math.max(1, d.length - 1) / d.length);
    const sum = (v: number[]) => v.reduce((x, y) => x + y, 0);
    return [`${env.corpus.length} images, ${insns} guest instructions, ${rounds} interleaved rounds: guard on min ${a.min.toFixed(0)} ms / median ${a.med.toFixed(0)} ms; off min ${b.min.toFixed(0)} / median ${b.med.toFixed(0)}`,
      `cost of the guard: ${pct(a.min, b.min)} % (min), ${pct(a.med, b.med)} % (median); paired rounds: mean ${m.toFixed(2)} % +- ${se.toFixed(2)} (standard error), total time ${pct(sum(on), sum(off))} %`];
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
  const p = rt.r.rt_scratch_ptr() + 3072;
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
export { STUBS };
