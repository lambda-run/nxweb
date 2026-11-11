// More end-to-end cases of the runtime that need to wait for something (a store, the GPU): the translation cache,
// stopping and restarting processes. Shared by run.mts (Node) and web/worker.ts (browser); no Node APIs.
import { Runtime, type RuntimeOptions } from "../../src/glue/rt_runtime.ts";
import { range } from "../../src/glue/rt_layout.ts";
import { layoutFor, SPACE } from "../../src/glue/rt_process.ts";
import { makeLargeNso, type LargeNso } from "./large_nso.ts";
import type { A64CacheStore } from "../../src/glue/a64_host.ts";
import type { Env, CaseResult, CorpusGuest } from "./cases.ts";
import { bootGfx, W, H, type Gpu, type GfxProcess, type GfxBoot } from "./gfx_cases.ts";
import { RtFs } from "../../src/glue/rt_fs.ts";
import { attachHle } from "../../src/glue/hle_rt.ts";
import { MemStorage, MemDevice, FS_KIND, type FsStorage, type FsDevice } from "../../src/glue/fs_host.ts";
import { ShaderLibrary } from "../../src/shaders/library.ts";
import type { ShaderTranslator, ShaderStore, Translated, ShaderOptions } from "../../src/glue/rt_shaders.ts";

export interface MoreEnv extends Env {
  big?: CorpusGuest;                                  // the a64 owner's large generated guest (test/a64/guests/out_big), when built
  cacheStore?: (name: string) => Promise<A64CacheStore>;   // a new, empty translation cache store
  heapMb?: () => Promise<number | undefined>;
  // A new storage object over the platform's persistent saves named `name` (Node: container files in a directory;
  // browser: OPFS, opened ahead) with the test RomFS image as the rom device; reset: the saves are deleted first
  fsStorage?: (name: string, reset: boolean) => Promise<FsStorage>;
  shaderLibrary?: Uint8Array;                         // build/shaders/maxwell.nxsl (the hand-assembled Maxwell programs, translated offline), when built
  shaderWhy?: string;                                 // why it is not there
  shaderTranslator?: () => ShaderTranslator;          // the in-page translator in its Worker, when its artifacts are served (browser)
  huge?: { stored: () => Uint8Array; ro: number; data: number; bss: number; heap: number };   // RT_HUGE=1: large.c at the target size (MB), stored
  shaderStore?: (name: string) => Promise<ShaderStore>;   // a new, empty store of translations         // memory in use, when the host can tell (after a collection if it can force one)
}
function fail(msg: string): never { throw new Error(msg); }
function eq(got: unknown, want: unknown, what: string): void {
  const str = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
  if (str(got) !== str(want)) fail(`${what}:\n--- got ---\n${str(got)}\n--- want ---\n${str(want)}`);
}
function ok(c: unknown, what: string): void { if (!c) fail(what); }
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export interface MoreCase { name: string; fn: () => Promise<string[]> }
export function moreCases(env: MoreEnv, gpu: Gpu | undefined): MoreCase[] {
  const list: MoreCase[] = [];
  const D = layoutFor();   // the layout a Runtime without one gets: the cases take addresses from it (NX_MEM=64hi places it above 4 GB)
  const test = (name: string, fn: () => Promise<string[] | void>) => list.push({ name, fn: async () => (await fn()) ?? [] });

  // ---- module files larger than the fixed file staging range ----
  const MBY = 1 << 20, mb = (n: number) => (n / MBY).toFixed(1) + " MB";
  const largeOut = (l: LargeNso) => `ro: 0x${l.roSum.toString(16)}\ndata: 0x${l.dataSum.toString(16)}\nbss words not zero: 0\ndata and bss are written: 1\nSetHeapSize: rc=0x0\nheap words not zero: 0\n`;
  const zero = (rt: Runtime, lo: number, hi: number) => !new Uint32Array(rt.memory.buffer, lo, (hi - lo) >>> 2).some(v => v !== 0);
  let largeMade: Promise<LargeNso> | undefined;
  const large = () => largeMade ??= makeLargeNso(env.nso("large"));
  test("large module: a 40 MB NSO (text and data LZ4 compressed, read-only data stored, hashes checked) is staged in the guest's own regions, loaded, and runs to completion; the heap reads zero afterwards; a small program is staged as before", async () => {
    const l = await large(), fixed = range("file staging");
    ok(l.nso.length > 2 * (fixed.hi - fixed.lo) && l.stored[2] < l.dataBytes / 2 && l.stored[1] > l.roBytes, `the file: ${l.nso.length} bytes, segments stored in ${l.stored}`);
    const t0 = performance.now(), rt = new Runtime(env.mods), before = rt.memory.buffer.byteLength;
    ok(rt.loadNso([{ name: "large", bytes: l.nso }]), "load failed: " + rt.red.join(" | "));
    const t1 = performance.now(), m = rt.modules[0];
    eq([m.imageSize, rt.ld.state(m.handle), rt.ld.get(m.handle, 36 /* Info.FilePtr */)], [l.imageBytes, "Pinned", 0], "image size, loader state and file pointer after the load");
    ok(rt.logs.some(x => x.includes("staged from the heap region's base 0x" + D.heapBase.toString(16))), "the log says where the files were staged: " + rt.logs.join(" | "));
    ok(zero(rt, D.heapBase, D.heapBase + l.nso.length + 0x1000), "the heap region reads zero again before the guest runs");
    ok(zero(rt, fixed.lo, fixed.hi), "nothing of it was put in the fixed range");
    const r = rt.run();
    ok(r.stop?.kind === "exit" && r.stop.code === 9, "exit: " + JSON.stringify(r.stop) + " " + rt.red.join(" | "));
    eq(rt.stdout(), largeOut(l), "stdout");
    eq(rt.red, [], "red lines");
    // the same file, staged where the layout of a game puts its heap region, with a code region made for the image
    const layout = layoutFor({ code: 300 * MBY, heap: 512 * MBY }), plain = layoutFor(), same0 = layoutFor({ code: 100 * MBY }), big512 = layoutFor({ code: 512 * MBY });
    eq([same0.codeSize, same0.heapBase, same0.aliasSize], [plain.codeSize, plain.heapBase, plain.aliasSize], "images that fit the default code region leave the layout as it is");
    ok(big512.codeSize >= 576 * MBY && big512.fit === "profile" && big512.tlsBase === big512.codeBase + big512.codeSize && big512.heapBase === big512.tlsBase + big512.tlsSize && big512.aliasBase + big512.aliasSize <= (big512.mem64 ? 0x3_FFFF_0000 : SPACE.hi),
      "512 MB of images: the code region holds them, the other regions follow: " + JSON.stringify(big512, (_, v) => typeof v === "bigint" ? v.toString() : v));
    const rt2 = new Runtime(env.mods, { layout });
    ok(layout.heapBase > D.heapBase && rt2.loadNso([{ name: "large", bytes: l.nso }]), "load on a per-game layout failed: " + rt2.red.join(" | "));
    ok(rt2.logs.some(x => x.includes("staged from the heap region's base 0x" + layout.heapBase.toString(16))), "staged at the layout's heap region");
    const r2 = rt2.run();
    ok(r2.stop?.kind === "exit" && r2.stop.code === 9 && rt2.stdout() === largeOut(l), "on the per-game layout: " + rt2.stdout() + rt2.red.join(" | "));
    // a small program: in the fixed range, no memory grown for staging, and the range is free again after the load
    const small = new Runtime(env.mods), had = small.memory.buffer.byteLength;
    ok(small.loadNso([{ name: "hello", bytes: env.nso("hello") }]), "hello: load failed");
    ok(!small.logs.some(x => x.includes("staged from the heap region")) && had === before, "hello is staged in the fixed range");
    const s = small.run();
    ok(s.stop?.kind === "exit" && s.stop.code === 42, "hello: exit");
    return [`file ${mb(l.nso.length)} (text ${l.stored[0]} bytes LZ4, ro ${mb(l.stored[1])} stored, data ${mb(l.dataBytes)} as ${mb(l.stored[2])} LZ4), image ${mb(l.imageBytes)}: loaded in ${(t1 - t0).toFixed(0)} ms, ran in ${rt.stats.runMs.toFixed(0)} ms; memory ${mb(rt.memory.buffer.byteLength)} of address space`,
      `per-game layout: code region ${mb(layout.codeSize)}, heap region at 0x${layout.heapBase.toString(16)}`];
  });
  test("large module: files that fit no staging space, an image that does not fit the code region and a truncated large file are load faults with their reason, not a crash or a cut file", async () => {
    const l = await large(), lines: string[] = [];
    const refused = (what: string, o: RuntimeOptions, files: { name: string; bytes: Uint8Array }[], want: RegExp) => {
      const rt = new Runtime(env.mods, o);
      let got: boolean;
      try { got = rt.loadNso(files); } catch (e) { fail(`${what}: loadNso threw: ${e}`); }
      const line = rt.red.find(x => want.test(x));
      ok(got === false && rt.state === "Stopped" && rt.r.rt_stop_kind() === 3 && line, `${what}: loaded=${got}, state ${rt.state}, red: ${rt.red.join(" | ")}`);
      const lo = o.layout?.heapBase ?? D.heapBase, hi = Math.min(rt.memory.buffer.byteLength, lo + 2 * l.nso.length + 0x2000);
      ok(hi <= lo || zero(rt, lo, hi), `${what}: nothing is left in the heap region`);
      lines.push(`${what}: ${line}`);
    };
    // a layout made by hand with a gap after its heap region: 32 MB (then 64 MB) is all there is to stage in
    const gap = (heap: number) => { const y = layoutFor({ heap }); return { ...y, stackBase: y.stackBase + 2 * MBY, stackSize: y.stackSize - 2 * MBY }; };
    refused("a heap region smaller than the file, with a gap after it", { layout: gap(32 * MBY) }, [{ name: "large", bytes: l.nso }], /do not fit the file staging: \d+ bytes in 1 files \(the largest: large, \d+ bytes\)/);
    // two files that fit one by one but not together
    refused("two files that only fit one at a time", { layout: gap(64 * MBY) }, [{ name: "large", bytes: l.nso }, { name: "large2", bytes: l.nso }], /do not fit the file staging: \d+ bytes in 2 files/);
    // a game whose profile reserves a small heap region (it allocates in the alias region): the files reach past it
    const aliasy = new Runtime(env.mods, { layout: layoutFor({ heap: 32 * MBY, alias: 2048 * MBY }) });
    ok(aliasy.loadNso([{ name: "large", bytes: l.nso }]), "a 32 MB heap region followed by the stack and alias regions: " + aliasy.red.join(" | "));
    const ra = aliasy.run();
    ok(ra.stop?.kind === "exit" && ra.stop.code === 9 && /^ro: .*\ndata: .*\nbss words not zero: 0\n/.test(aliasy.stdout()), "the module runs there (its SetHeapSize of 96 MB is refused): " + aliasy.stdout());
    lines.push("a 32 MB heap region followed by the stack and alias regions: the 40 MB file is staged across them, and the module runs");
    // modules mapped from 0x16000000: 28 MB of code region are left for a 72 MB image
    refused("an image larger than the code region that is left", { codeBase: D.codeBase + 0x0E00_0000 }, [{ name: "large", bytes: l.nso }], /module large: its image of \d+ bytes does not fit the code region/);
    // the large file cut short: the loader refuses it by its header
    refused("the file cut at 20 MB", {}, [{ name: "large", bytes: l.nso.subarray(0, 20 * MBY) }], /past the end of the file/);
    // one byte of the stored 40 MB changed: the hash check sees it
    const dam = l.nso.slice(); dam[30 * MBY] ^= 1;
    refused("one bit of the read-only data flipped", {}, [{ name: "large", bytes: dam }], /does not match its SHA-256/);
    // a module file loaded at run time that does not fit the fixed range goes to host-allocated pages of the code
    // region (here 20 MB that are no module: the loader refuses them by their header, after they were staged), and
    // one that fits neither is refused with both figures
    for (const [codeBase, want] of [[undefined, /not an NSO|NRO|header|magic/i], [D.codeBase + 0x0FB0_0000, /fit neither the file staging range \(\d+ bytes free\) nor the code region \(\d+ bytes free\)/]] as [number | undefined, RegExp][]) {
      const rt = new Runtime(env.mods, { codeBase });
      ok(rt.loadNso([{ name: "hello", bytes: env.nso("hello") }]), "hello: load failed");
      let msg = "";
      try { rt.loadModule("junk", new Uint8Array(20 * MBY)); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
      ok(want.test(msg), `a 20 MB file loaded at run time${codeBase ? " with 1 MB of code region left" : ""}: ${msg || "accepted"}`);
      const r = rt.run();
      ok(r.stop?.kind === "exit" && r.stop.code === 42, "hello still runs");
      lines.push(`a 20 MB file at run time${codeBase ? ", 1 MB of code region left" : ""}: ${msg}`);
    }
    return lines;
  });
  test("code wider than the pc map's fixed range: 416 functions, one per 64 KB of a 27 MB text, all called twice; the pc map grows past its range into the code region and the program runs to completion", async () => {
    const rt = new Runtime(env.mods);
    ok(rt.loadNso([{ name: "wide", bytes: env.nso("wide") }]), "load failed: " + rt.red.join(" | "));
    const r = rt.run();
    let sum = 0; for (let round = 0; round < 2; round++) for (let i = 0; i < 416; i++) sum = (sum + (i & 0xFFF) + 1) >>> 0;
    ok(r.stop?.kind === "exit" && r.stop.code === 11, "stop: " + JSON.stringify(r.stop) + " " + rt.red.join(" | "));
    eq(rt.stdout(), `functions: 416\nsum: ${sum}\n`, "stdout");
    const fixed = range("pc map"), bytes = rt.a64.pcMapBytes;
    ok(bytes > fixed.hi - fixed.lo, `the pc map (${mb(bytes)}) did not pass its fixed range (${mb(fixed.hi - fixed.lo)})`);
    return [`pc map ${mb(bytes)}, its fixed range ${mb(fixed.hi - fixed.lo)}`];
  });
  if (env.huge) test("large module at the target size (RT_HUGE=1): a 256 MB file with a 512 MB image loads on a layout made for it and runs to completion", async () => {
    const hg = env.huge!, l = await makeLargeNso(hg.stored(), hg.ro * MBY, hg.data * MBY);
    const layout = layoutFor({ code: l.imageBytes });
    const t0 = performance.now(), rt = new Runtime(env.mods, { layout });
    ok(rt.loadNso([{ name: "huge", bytes: l.nso }]), "load failed: " + rt.red.join(" | "));
    const t1 = performance.now(), r = rt.run();
    ok(r.stop?.kind === "exit" && r.stop.code === 9, "exit: " + JSON.stringify(r.stop) + " " + rt.red.join(" | "));
    eq(rt.stdout(), largeOut(l), "stdout");
    return [`file ${mb(l.nso.length)}, image ${mb(l.imageBytes)}: code region ${mb(layout.codeSize)}, heap region ${mb(layout.heapSize)} at 0x${layout.heapBase.toString(16)} (${layout.fit}); loaded in ${(t1 - t0).toFixed(0)} ms, ran in ${(performance.now() - t1).toFixed(0)} ms`];
  });

  // ---- translation cache ----
  if (env.cacheStore) test("cache: translated units are stored by build id + load address + translator options and a second start translates nothing (NSO modules; cold and warm start of the large guest)", async () => {
    const lines: string[] = [];
    // (1) NSO modules: the key is the module's build id
    const store = await env.cacheStore!("nso"), files = ["two_main", "two_lib"].map(name => ({ name, bytes: env.nso(name) }));
    const start = async (o: object) => {
      const rt = new Runtime(env.mods, { cache: store, ...o });
      ok(rt.loadNso(files), "load failed");
      const got = await rt.cacheLoad(), r = rt.run();
      ok(r.stop?.kind === "exit" && r.stop.code === 3, "exit: " + rt.red.join(" | "));
      return { rt, got, saved: await rt.cacheSave() };
    };
    const cold = await start({}), warm = await start({}), other = await start({ guard: false }), again = await start({ guard: false });
    eq([cold.got.units, cold.rt.a64.cacheHits], [0, 0], "cold start: units from the cache, cache hits");
    ok(cold.saved > 0 && cold.rt.a64.translatedInsns > 0, "the cold start stored its units");
    ok(warm.got.ranges === 2 && warm.rt.a64.cacheHits > 0, `warm start: ${warm.got.ranges} ranges, ${warm.rt.a64.cacheHits} hits`);
    eq([warm.rt.a64.translatedInsns, warm.saved], [0, 0], "warm start: instructions translated, bytes stored");
    eq(warm.rt.stdout(), cold.rt.stdout(), "stdout of the warm start");
    eq([other.got.units, again.got.units > 0, again.rt.a64.translatedInsns], [0, true, 0], "other translator options (guard off): a miss, then its own entry");
    lines.push(`two NSO modules: cold ${cold.rt.a64.translatedInsns} instructions translated, ${cold.saved} bytes stored under 2 keys; warm ${warm.got.units} units available, ${warm.rt.a64.cacheHits} used, 0 translated; with other options a miss`);
    // (2) cold and warm start of a larger guest (a flat image: the key is its SHA-256)
    const g = env.big;
    if (!g) { lines.push("the large guest (test/a64/guests/out_big; `npm run a64:big` builds it) is not there: cold/warm times SKIPPED"); return lines; }
    const bigStore = await env.cacheStore!("big");
    const big = async () => {
      const t0 = performance.now(), rt = new Runtime(env.mods, { cache: bigStore });
      ok(rt.loadFlat(g.image, g.side), "load failed");
      const t1 = performance.now(), got = await rt.cacheLoad(), t2 = performance.now(), r = rt.run(), t3 = performance.now();
      ok(r.stop?.kind === "exit" && same(rt.stdoutBytes(), g.expected), "the large guest's output: " + rt.red.join(" | "));
      const saved = await rt.cacheSave();
      return { rt, got, saved, loadMs: t1 - t0, cacheMs: t2 - t1, runMs: t3 - t2, saveMs: performance.now() - t3, total: t3 - t0 };
    };
    const c = await big(), w = await big(), w2 = await big();
    eq([w.rt.a64.translatedInsns, w2.rt.a64.translatedInsns], [0, 0], "instructions translated on the warm starts");
    const row = (n: string, x: typeof c) => `${n}: start to exit ${x.total.toFixed(0)} ms = load ${x.loadMs.toFixed(0)} + cache read ${x.cacheMs.toFixed(0)} + run ${x.runMs.toFixed(0)} (of which translate + compile ${(x.rt.a64.translateNs / 1e6).toFixed(0)}); ` +
      `${x.rt.a64.translatedInsns} instructions translated, ${x.rt.a64.cacheHits} units from the cache` + (x.saved ? `; ${(x.saved / 1e6).toFixed(1)} MB stored in ${x.saveMs.toFixed(0)} ms` : "");
    lines.push(`large guest (${(g.image.length / 1e6).toFixed(2)} MB image, ${g.side.insn_count} instructions executed):`, "  " + row("cold", c), "  " + row("warm", w), "  " + row("warm", w2));
    return lines;
  });

  // ---- stop and start again ----
  if (env.haveGfxGuests && env.mods.gfx) test(`restart (${gpu ? "WebGPU" : "null replayer"}): the cube demo is started, stopped by the embedder and started again, 5 times; kernel threads end, graphics objects are released, memory use stays level`, async () => {
    // count the GPU objects alive through the device
    let live = 0, made = 0;
    const dev: any = gpu?.device, orig: Record<string, any> = {};
    if (dev) for (const k of ["createTexture", "createBuffer"]) {
      orig[k] = dev[k];
      dev[k] = (...a: any[]) => { const o = orig[k].apply(dev, a), d = o.destroy.bind(o); let gone = false; live++; made++; o.destroy = () => { if (!gone) { gone = true; live--; } d(); }; return o; };
    }
    const g = gpu;
    const lines: string[] = [], liveAfter: number[] = [], heap: number[] = [];
    const cycle = async (i: number) => {
      const p: GfxProcess = await bootGfx(env, [{ name: "cube", bytes: env.nso("cube") }], { frames: 0, gpu: g, clock: "wall", raf: !!gpu });
      const done = p.rt.runAsync();
      const t0 = performance.now();
      while (p.gfx.stats.frames < 20) { if (performance.now() - t0 > 20000 || p.rt.state === "Stopped") fail(`cycle ${i}: ${p.gfx.stats.frames} frames after 20 s, state ${p.rt.state}: ${p.rt.red.join(" | ")}`); await new Promise(r => setTimeout(r, 5)); }
      const liveRunning = live;
      p.rt.kill();
      const r = await done;
      eq([r.state, r.stop?.kind], ["Stopped", "killed"], `cycle ${i}: how it ended`);
      eq([Number(p.rt.k.kernel_count(1)), p.rt.k.kernel_stop_reason(), p.rt.disposed], [0, 3, true], `cycle ${i}: kernel threads alive, kernel stop reason, disposed`);
      eq(p.rt.a64.units.length, 0, `cycle ${i}: translated units left`);
      eq(p.rt.red, [], `cycle ${i}: red lines`);
      eq(p.rt.run().state, "Stopped", "run() after kill");
      liveAfter.push(live);
      if (env.heapMb) { const h = await env.heapMb(); if (h !== undefined) heap.push(h); }
      return `cycle ${i}: ${p.gfx.stats.frames} frames, ${p.rt.stats.slices} slices; GPU textures and buffers alive while running ${liveRunning}, after the stop ${live}` + (gpu ? ` (${p.gfx.disposedObjects} destroyed at the stop)` : "");
    };
    try {
      lines.push(await cycle(0) + " (warm-up, not compared)");
      for (let i = 1; i <= 5; i++) lines.push(await cycle(i));
    } finally { if (dev) for (const k of Object.keys(orig)) dev[k] = orig[k]; }
    if (gpu) ok(liveAfter.slice(1).every(n => n === liveAfter[1]) && liveAfter[1] <= liveAfter[0], "GPU objects alive after each stop: " + liveAfter.join(" "));
    if (heap.length >= 6) {
      const grow = heap[5] - heap[1];
      lines.push(`memory in use after each stop (as the host measures it; under Node a wasm memory counts with its whole address range): ${heap.map(h => h.toFixed(1)).join(", ")} MB (cycles 1 to 5: ${grow >= 0 ? "+" : ""}${grow.toFixed(1)} MB)`);
      ok(grow < 24, `memory grew by ${grow.toFixed(1)} MB over four restarts`);
    } else lines.push("this host cannot report memory in use: only the GPU object count and the kernel's counts were checked");
    return lines;
  });
  // ---- the SDK take-over table ----
  if (env.mods.hle) test("hle: a guest calls take-overs by their mangled names: nn::oe (operation mode, focus messages), nn::time, nn::account, nifm and socket offline, libc math in d0; the host's shutdown ends it through the lifecycle path", async () => {
    const FIXED = 1_700_000_000;   // 2023-11-14 22:13:20 UTC
    const boot = (handheld: boolean) => {
      const rt = new Runtime(env.mods);
      const host = attachHle(rt, env.mods.hle!, { config: { opmode: handheld ? 0 : 1, fixedTime: FIXED, nick: "Tester", lang: "en-US" } });
      ok(rt.loadNso([{ name: "hleg", bytes: env.nso("hleg") }]), "load failed: " + rt.red.join(" | "));
      return { rt, host };
    };
    const { rt, host } = boot(false);
    const done = rt.runAsync();
    const until = async (what: string, f: () => boolean) => { const t0 = performance.now(); while (!f()) { if (performance.now() - t0 > 10000 || rt.state === "Stopped") fail(`timed out waiting for ${what}; state ${rt.state}\n${rt.stdout()}\n${rt.red.join("\n")}`); await new Promise(r => setTimeout(r, 2)); } };
    await until("the message loop", () => rt.stdout().includes("waiting for notification messages"));
    host.focusSet(3);                                   // out of focus
    await until("the first focus message", () => rt.stdout().includes("oe: message 15, focus 3"));
    host.focusSet(1);                                   // in focus again
    await until("the second focus message", () => (rt.stdout().match(/oe: message 15/g) ?? []).length === 2);
    eq(host.shutdown(), true, "the shutdown started the exit");
    const r = await done;
    eq([r.state, r.stop?.kind, r.stop?.code, host.exit.state, host.exit.reason], ["Stopped", "exit", 0, "Exited", "hostShutdown"], "how it ended");
    const sin = Math.trunc(Math.fround(Math.fround(Math.sin(0.5)) * 1000000)), sq = Math.trunc(Math.fround(Math.fround(Math.sqrt(2)) * 1000000));
    const out = rt.stdout().split("\n");
    eq(out[0], "oe: operation mode 1, performance mode 1, focus 1", "oe");
    eq(out[1], `time: posix ${FIXED} = 2023-11-14 22:13:20 UTC`, "time");
    eq(out[2], 'account: rc 0x0, 1 user, uid set, nickname "Tester"', "account");
    eq(out[3], "network: available 0, socket() = -1, errno set", "network");
    ok(new RegExp(`^libc: sinf\\(0\\.5\\) \\* 1e6 = ${String(sin).slice(0, 5)}\\d, pow\\(2, 10\\) = 1024, strtod\\("3\\.25"\\) \\* 100 = 325, sqrtf\\(2\\) \\* 1e6 = ${String(sq).slice(0, 5)}\\d\\d$`).test(out[4]), "libc results through d0: " + out[4]);
    eq(out.slice(5), ["oe: messages waiting before the loop: 0", "oe: waiting for notification messages", "oe: message 15, focus 3", "oe: message 15, focus 1", ""], "the message loop");
    eq(rt.red, [], "red lines");
    const summary = rt.logs.find(l => /force: \d+ entries hit, \d+ not referenced by this game/.test(l)) ?? fail("no summary line for the forced names nobody refers to: " + rt.logs.slice(0, 5).join(" | "));
    // handheld: the operation mode the guest sees, and what the npad take-overs follow
    const h = boot(true), hd = h.rt.runAsync();
    const t0 = performance.now(); while (!h.rt.stdout().includes("waiting for notification")) { if (performance.now() - t0 > 10000) fail("handheld run: " + h.rt.stdout()); await new Promise(r => setTimeout(r, 2)); }
    eq(h.rt.stdout().split("\n")[0], "oe: operation mode 0, performance mode 0, focus 1", "handheld");
    h.rt.kill(); await hd;
    return [out[4], summary.replace(/^.*force: /, "loader: force: "), `${host.entries().filter(e => !e.internal && !e.shadowed && !e.duplicate).length} names registered (${host.entries().filter(e => e.forced).length} forced); the guest imports 22 of them`];
  });

  // ---- the file system ----
  if (env.mods.fs) test("fs: a guest mounts its RomFS and reads a file, mounts its save data, writes and commits; the next run reads what was committed; a run killed between write and commit leaves the committed version", async () => {
    const blob = env.file("romfs_blob.bin");
    let h = 0xcbf29ce484222325n; for (const b of blob) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
    const head = `MountRom: 0x0\nopen a file that is not there: 0x202\nrom:/data/blob.bin: ${blob.length} bytes of ${blob.length}, fnv64 0x${h.toString(16)}\nEnsureSaveData: 0x0\nMountSaveData: 0x0\n`;
    const first = head + "save:/counter.bin is not there yet\nCreateFile: 0x0\nwrote 1: rc=0x0\nCommit: 0x0\n";
    const next = (was: number, commit: boolean) => head + `save:/counter.bin holds ${was}\nwrote ${was + 1}: rc=0x0\n` + (commit ? "Commit: 0x0\n" : "");
    const run = async (storage: FsStorage, mode: number) => {
      const rt = new Runtime(env.mods), fs = new RtFs(rt, env.mods.fs!, storage);
      let written!: () => void; const w = new Promise<void>(r => { written = r; });
      rt.register({ name: "test_mode", fn: () => mode }); rt.register({ name: "test_written", fn: () => { written(); } });
      ok(rt.loadNso([{ name: "fsg", bytes: env.nso("fsg") }]), "load failed: " + rt.red.join(" | "));
      const done = rt.runAsync();
      if (mode === 1) { await Promise.race([w, done]); rt.kill(); }
      const r = await done;
      eq(rt.red, [], "red lines");
      const commits = Number(fs.x.fs_commit_count());
      rt.dispose();   // the storage's handles go with the process
      return { rt, fs, r, commits };
    };
    const lines: string[] = [];
    const series = async (what: string, storage: (reset: boolean) => Promise<FsStorage>) => {
      const a = await run(await storage(true), 0);
      eq([a.r.stop?.kind, a.r.stop?.code, a.rt.stdout()], ["exit", 0, first], `${what}, run 1`);
      const b = await run(await storage(false), 0);
      eq([b.r.stop?.kind, b.rt.stdout()], ["exit", next(1, true)], `${what}, run 2: it reads what run 1 committed`);
      const c = await run(await storage(false), 1);
      eq([c.r.stop?.kind, c.rt.stdout(), c.commits], ["killed", next(2, false), 0], `${what}, run 3: killed after the write, before the commit`);
      const d = await run(await storage(false), 0);
      eq([d.r.stop?.kind, d.rt.stdout()], ["exit", next(2, true)], `${what}, run 4: the committed version (2), not the killed run's write (3)`);
      const e = await run(await storage(false), 0);
      eq(e.rt.stdout(), next(3, true), `${what}, run 5`);
      lines.push(`${what}: runs 1, 2, 4, 5 committed 1, 2, 3, 4; run 3 wrote 3 and was killed before its commit, run 4 found 2; ${a.fs.stats.calls} nn::fs calls a run through ${a.fs.stats.names} names, ${a.fs.stats.pended + b.fs.stats.pended} parked on storage, ${a.fs.stats.retried} retried`);
      return a;
    };
    if (env.fsStorage) await series("the platform's storage", reset => env.fsStorage!("fsg", reset));
    else lines.push("this host gave no persistent storage: only the in-memory series ran");
    // storage that answers later (every open, every image read, every flush): the calls park the guest thread
    const mem = new MemStorage();
    const later = (reset: boolean): Promise<FsStorage> => {
      if (reset) mem.saves.clear();
      mem.setImage(FS_KIND.ROM, 0, new MemDevice(env.file("romfs.img")));
      const wrap = (d: FsDevice | number, image: boolean): FsDevice | number => typeof d === "number" ? d : {
        size: () => d.size(), readSync: image ? undefined : (off, dst) => d.readSync!(off, dst), write: (off, src) => d.write!(off, src), close: () => d.close?.(),
        readAsync: async (off, len) => { const b = new Uint8Array(len); await new Promise(r => setTimeout(r, 0)); if (d.readSync!(off, b)) throw new Error("read"); return b; },
        flush: async () => { await new Promise(r => setTimeout(r, 0)); return d.flush ? await d.flush() : 0; },
      };
      return Promise.resolve({ open: async (k, i) => { await new Promise(r => setTimeout(r, 0)); return wrap(await mem.open(k, i), k < FS_KIND.SAVE); }, remove: async (k, i) => mem.remove(k, i) });
    };
    const slow = await series("storage that answers later (in memory)", later);
    ok(slow.fs.stats.pended >= 4, `calls parked on the slow storage: ${slow.fs.stats.pended}`);
    return lines;
  });

  // ---- shaders: library first, then the in-page chain ----
  const where = gpu ? "WebGPU" : "null replayer";
  const BG = [13, 18, 31], TINT = [1, 0.5, 0.25], PALETTE = [[230, 80, 60], [250, 200, 70], [70, 170, 240], [90, 210, 130], [245, 245, 245]].map(c => c.map((v, i) => Math.round(v * TINT[i])));
  const near = (a: ArrayLike<number>, o: number, b: number[], tol = 3) => b.every((v, i) => Math.abs(a[o + i] - v) <= tol);
  const hash = (d: Uint8Array) => { let h = 0x811c9dc5; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); };
  // runs the Maxwell guest until `until` holds, pauses it, checks the picture (left half: the texture's colours times
  // the tint; right half: the background), then stops it
  const mx = async (file: string, shaders: ShaderOptions, until: (p: GfxProcess) => boolean, picture: "quad" | "empty" | "none") => {
    const p = await bootGfx(env, [{ name: file, bytes: env.nso(file) }], { frames: 0, gpu, clock: "wall", raf: !!gpu, shaders, noDemoShaders: true } as GfxBoot);
    let done = p.rt.runAsync();
    const t0 = performance.now();
    while (!until(p)) {
      if (performance.now() - t0 > 60000 || p.rt.state === "Stopped") { p.rt.kill(); fail(`${file}: gave up after ${((performance.now() - t0) / 1000).toFixed(0)} s in state ${p.rt.state}, ${p.gfx.stats.frames} frames, shader stats ${JSON.stringify(p.shaders!.stats)}: ${p.rt.logs.filter(l => /shader|RED/.test(l)).join(" | ")}`); }
      await new Promise(r => setTimeout(r, 5));
    }
    let pixels = "";
    if (gpu && picture !== "none") {
      p.rt.requestPause();
      eq((await done).state, "Paused", "paused for the readback");
      await gpu.device.queue.onSubmittedWorkDone();
      const img = await p.gfx.host.readTexture(p.gfx.host.lastPresented), d: Uint8Array = img.data;
      eq([img.width, img.height], [W, H], "presented image");
      let bad = 0; const used = new Set<number>();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, left = x < W / 2;
        if (x === W / 2 - 1 || x === W / 2) continue;   // the edge column
        if (!left || picture === "empty") { if (!near(d, o, BG)) bad++; continue; }
        const k = PALETTE.findIndex(c => near(d, o, c));
        if (k < 0) bad++; else used.add(k);
      }
      if (bad) fail(`${file}: ${bad} pixels are not what the shaders must produce (left half: the texture's colours times the tint ${TINT}; right half: background); pixel (10,10) = ${Array.from(d.subarray((10 * W + 10) * 4, (10 * W + 10) * 4 + 4))}`);
      if (picture === "quad") eq(used.size, 5, "texture colours seen in the left half");
      pixels = hash(d);
      done = p.rt.runAsync();
    }
    p.rt.kill();
    eq((await done).stop?.kind, "killed", "how it ended");
    return { p, pixels, info: p.rt.logs.filter(l => /^shader [0-9a-f]{16} /.test(l)), red: p.rt.red.filter(l => !l.includes("forced take-over entry with no reference")) };
  };
  const draws = (p: GfxProcess) => ({ issued: p.gfx.x.gfx_stat(1) >>> 0, skipped: p.gfx.x.gfx_stat(2) >>> 0 });
  const KEYS = ["6ab809ed2aec5e2b", "b4cb3d1f49adb63e"];   // vs_quad_ubo, ps_tex_tint (tools/shaders/maxwell_asm.py prints them)
  if (env.haveGfxGuests && env.mods.gfx) test(`shaders (${where}): a guest with real Maxwell shader stages: the library first; on a miss a translator, with its results stored; a stage nothing translates is one red line`, async () => {
    if (!env.shaderLibrary) return [`SKIPPED: build/shaders/maxwell.nxsl is not there (${env.shaderWhy || "npm run shaders:asm, shaders:xlate, shaders:lib build it; they need dotnet and the nxnative checkout"})`];
    const lib = new ShaderLibrary(env.shaderLibrary), lines: string[] = [];
    for (const k of KEYS) ok(lib.has(k), `the library has no entry for ${k}: is it stale?`);
    // (1) the library has both stages: nothing else is asked, no draw is skipped
    const a = await mx("mx", { library: lib }, p => p.gfx.stats.frames >= 6, "quad");
    eq([a.p.shaders!.stats.fromLibrary, a.p.shaders!.stats.translated, a.info.length, a.red.length], [2, 0, 0, 0], "from the library, translated, shader log lines, red lines: " + a.red.join(" | "));
    ok(draws(a.p).issued >= 6 && draws(a.p).skipped === 0, "draws: " + JSON.stringify(draws(a.p)));
    lines.push(`library: 2 stages registered from it, ${draws(a.p).issued} draws, none skipped` + (a.pixels ? `, pixel hash ${a.pixels}` : ""));
    // (2) no library: a stand-in translator (it answers from the library's entries, but only once the test opens the
    // gate) shows what happens while a stage is on its way, and the store what a second run does
    const mem = new Map<string, Translated>(), store: ShaderStore = { get: async id => mem.get(id) ?? null, put: async (id, t) => { mem.set(id, t); } };
    let open!: () => void, asked = 0; const gate = new Promise<void>(r => { open = r; });
    const wanted = new Set<string>();
    const standIn: ShaderTranslator = { chain: "stand-in-1", prioritize: k => { wanted.add(k); }, translate: async b => { asked++; await gate; const e = lib.get(b.key); if (!e) throw new Error("the stand-in translator has no such stage"); return { wgsl: e.wgsl, reflection: e.reflection }; } };
    let opened = false;
    const b = await mx("mx", { translator: standIn, store }, p => {
      const d = draws(p);
      if (!opened && d.skipped >= 3) { opened = true; eq(d.issued, 0, "draws issued before the stages arrived"); open(); }
      return opened && p.shaders!.stats.translated === 2 && d.issued >= 3;
    }, "quad");
    eq([asked, b.p.shaders!.stats.translated, mem.size, b.red.length], [2, 2, 2, 0], "translator calls, translated, stored, red lines");
    // the presents while the draws were skipped told the translator which keys they wait on (src/gfx/shader.ts waited, RtShaders.waited)
    eq([...wanted].sort(), [...mem.keys()].map(id => id.split("/")[0]).sort(), "keys the skipped draws waited on, handed to the translator's prioritize");
    eq(b.info.filter(l => l.includes("draws that use it are skipped until it is there")).length, 2, "one informational line a stage: " + b.info.join(" | "));
    if (a.pixels) eq(b.pixels, a.pixels, "the picture with translated stages against the library's");
    lines.push(`translator (stand-in): ${draws(b.p).skipped} draws skipped while the stages were on their way, then ${draws(b.p).issued} drawn; one informational line a stage, no red line; both keys handed to prioritize by the presents`, "  " + b.info[0]);
    const c = await mx("mx", { translator: standIn, store }, p => p.shaders!.stats.fromStore === 2 && draws(p).issued >= 3, "quad");
    eq([asked, c.p.shaders!.stats.fromStore, c.p.shaders!.stats.translated], [2, 2, 0], "second run: translator calls in all, from the store, translated");
    lines.push(`second run: both stages from the store, the translator was not asked`);
    // the two ways in that reach the recorder's SetShaders inside src/gfx: NVN2's builder and SetShadersExt
    for (const m of ["mx_builder", "mx_ext"]) {
      const r = await mx(m, { translator: standIn }, p => p.shaders!.stats.translated === 2 && draws(p).issued >= 3, "quad");
      eq([r.p.shaders!.stats.translated, r.red.length], [2, 0], `${m}: translated, red lines: ` + r.red.join(" | "));
      lines.push(`${m}: both stages translated in the page, ${draws(r.p).issued} drawn`);
    }
    // (3) a stage that cannot be translated: one red line with its key; the other stage is fine; the process goes on
    const d = await mx("mx_bad", { library: lib, translator: standIn, store }, p => p.shaders!.stats.failed === 1 && p.gfx.stats.frames >= 6, "empty");
    eq(d.red.length, 1, "red lines: " + d.red.join(" | "));
    ok(/^\[RED\] shader [0-9a-f]{16}: translation failed: .*; its draws are skipped$/.test(d.red[0]), d.red[0]);
    ok(draws(d.p).issued === 0 && draws(d.p).skipped >= 6, "draws: " + JSON.stringify(draws(d.p)));
    lines.push(d.red[0]);
    // (4) nothing attached but the recorder: its own report of the missing key comes through
    const e = await mx("mx", {}, p => p.gfx.stats.frames >= 4, "empty");
    ok(e.red.length >= 1 && e.red.every(l => / is not in the shader map$/.test(l)), "red lines: " + e.red.join(" | "));
    lines.push(`without library or translator: ${e.red[0]}`);
    return lines;
  });
  if (env.haveGfxGuests && env.mods.gfx && gpu) test("shaders in the page: the Maxwell stages are translated by the Ryujinx translator, the SPIR-V pass and naga in a Worker, stored in the Cache API, and draw the same picture as the offline library", async () => {
    if (!env.shaderTranslator || !env.shaderStore) return [`SKIPPED: the in-page translator's files (build/shaders/xlate_wasm, nx_naga.wasm) are not there (${env.shaderWhy || "npm run shaders:xlate-wasm and shaders:naga build them; they need dotnet, cargo and the nxnative checkout"})`];
    const lines: string[] = [], store = await env.shaderStore("page"), tr = env.shaderTranslator();
    try {
      const t0 = performance.now();
      const a = await mx("mx", { translator: tr, store }, p => p.shaders!.stats.translated === 2 && draws(p).issued >= 3, "quad");
      eq(a.red, [], "red lines");
      eq(a.info.filter(l => l.includes("draws that use it are skipped until it is there")).length, 2, "informational lines");
      lines.push(`first run: 2 stages translated in the page in ${(performance.now() - t0).toFixed(0)} ms (translator start included), ${draws(a.p).skipped} draws skipped meanwhile, then ${draws(a.p).issued} drawn; pixel hash ${a.pixels}`, ...a.info.filter(l => l.includes("arrived")).map(l => "  " + l));
      if (env.shaderLibrary) {
        const l = await mx("mx", { library: env.shaderLibrary }, p => p.gfx.stats.frames >= 4, "quad");
        eq(a.pixels, l.pixels, "the picture against the offline library's");
        lines.push("the same pixels as with the offline library");
      }
      const t1 = performance.now();
      const b = await mx("mx", { translator: tr, store }, p => p.shaders!.stats.fromStore === 2 && draws(p).issued >= 3, "quad");
      eq([b.p.shaders!.stats.translated, b.pixels], [0, a.pixels], "second run: translated, pixels");
      lines.push(`second run: both stages from the Cache API in ${(performance.now() - t1).toFixed(0)} ms, nothing translated`);
      const c = await mx("mx_bad", { translator: tr, store }, p => p.shaders!.stats.failed === 1 && p.shaders!.stats.registered === 1 && p.gfx.stats.frames >= 4, "empty");
      eq(c.red.length, 1, "red lines: " + c.red.join(" | "));
      ok(/^\[RED\] shader [0-9a-f]{16}: translation failed: /.test(c.red[0]), c.red[0]);
      lines.push(c.red[0]);
    } finally { tr.close?.(); }
    return lines;
  });
  return list;
}

export async function runMoreCases(env: MoreEnv, gpu: Gpu | undefined, only: string | undefined, report: (r: CaseResult) => void): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of moreCases(env, gpu)) {
    if (only && !c.name.includes(only)) continue;
    const t0 = performance.now();
    let r: CaseResult;
    try { const info = await c.fn(); r = { name: c.name, ok: true, why: "", info, ms: performance.now() - t0 }; }
    catch (e) { r = { name: c.name, ok: false, why: e instanceof Error ? (e.stack ?? e.message) : String(e), info: [], ms: performance.now() - t0 }; }
    out.push(r); report(r);
  }
  return out;
}
