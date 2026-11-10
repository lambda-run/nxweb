// npm run doom:test [-- <filter>]. The Doom guest (the doomgeneric engine on this repository's platform layer and C
// library) under Node, on the null replayer and the deterministic guest clock. The engine and the data file are not
// in this repository: DOOMGENERIC (or build/third_party/doomgeneric, tools/doom/fetch.sh) and DOOM_WAD name them, and
// without them the tests are skipped (exit code 0).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, build, loadEnv } from "../runtime/harness.mts";
import { buildDoom, doomSkip, doomWad, doomReference, DOOM_OUT } from "./harness.mts";
import { bootDoom, wadStorage, fnv, colours, type DoomFrame, type DoomBoot, type DoomProcess } from "./boot.ts";

process.chdir(ROOT);
const why = doomSkip(true);
if (why) { console.log(`doom:test: SKIPPED, ${why}`); process.exit(0); }
try { build(); } catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] doom:test: the runtime build failed"); process.exit(1); }
const nsoPath = buildDoom(l => console.log(l))!;
const env = loadEnv(), nso = new Uint8Array(readFileSync(nsoPath)), wad = new Uint8Array(readFileSync(doomWad()!));

function ok(c: unknown, what: string): void { if (!c) throw new Error(what); }
function eq(got: unknown, want: unknown, what: string): void { const s = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v); if (s(got) !== s(want)) throw new Error(`${what}:\n--- got ---\n${s(got)}\n--- want ---\n${s(want)}`); }
// The model of the guest clock for these runs: 20 ns per budget unit, about what a unit takes here (measured below),
// so that the engine's 35 Hz ticker sees a machine that is fast enough for it
const NS_PER_UNIT = 20;
interface Run { p: DoomProcess; wallMs: number; firstFrameMs: number }
async function run(o: DoomBoot, exit = 0): Promise<Run> {
  const t0 = performance.now(); let first = 0;
  const p = await bootDoom(env, nso, wad, { nsPerUnit: NS_PER_UNIT, ...o, onFrame: f => { if (!first) first = performance.now() - t0; return o.onFrame?.(f); } });
  const r = await p.rt.runAsync();
  if (r.state !== "Stopped" || r.stop?.kind !== "exit" || r.stop.code !== exit) throw new Error(`expected Stopped(exit ${exit}), got ${r.state} ${r.stop?.kind} ${r.stop?.code} ${r.stop?.fault?.detail ?? ""}\n${p.rt.stdout().split("\n").slice(-12).join("\n")}\n${p.rt.red.join("\n")}`);
  eq(p.rt.red, [], "red lines");
  return { p, wallMs: performance.now() - t0, firstFrameMs: first };
}
const fingerprint = (p: DoomProcess) => `${p.rt.stats.slices}/${p.rt.stats.svcs}/${p.rt.units}/${p.rt.guestNs()}/${p.gfx.stats.nvnCalls}/${p.fs.stats.calls}`;
const mb = (n: number) => (n / 2 ** 20).toFixed(1) + " MB";

const tests: { name: string; fn: () => Promise<string[]> }[] = [];
const test = (name: string, fn: () => Promise<string[]>) => tests.push({ name, fn });

test("doom boot: the engine starts with the shareware data file, shows the title and then plays its attract demo by itself; two runs are identical", async () => {
  // checksums of the first frame at or after each of these game tics (the title is up for 170 tics, then demo1 runs)
  const AT = [30, 150, 260, 400, 520], END = 560;
  const once = async () => {
    const marks: string[] = [], seen: DoomFrame[] = []; let next = 0;
    const r = await run({ onFrame: f => {
      if (next < AT.length && f.gametic >= AT[next]) { marks.push(`tic ${f.gametic}: ${fnv(f.pixels)} (${colours(f.pixels)} colours, ${f.gamestate === 3 ? "title" : f.demo ? "demo, map " + f.map : "level"})`); seen.push({ ...f, pixels: f.pixels.slice() }); next++; }
      return f.gametic >= END;
    } });
    return { r, marks, seen };
  };
  const a = await once(), b = await once();
  eq(b.marks, a.marks, "frame checksums of a second run");
  eq(fingerprint(b.r.p), fingerprint(a.r.p), "slices/SVCs/units/guest ns/NVN calls/fs calls of a second run");
  const out = a.r.p.rt.stdout();
  ok(out.includes("DOOM Shareware") && out.includes("adding rom:/doom1.wad"), "the engine's start-up text:\n" + out);
  const [t1, t2, d1, d2, d3] = a.seen;
  ok(t1.gamestate === 3 && t2.gamestate === 3 && fnv(t1.pixels) === fnv(t2.pixels) && colours(t1.pixels) > 150, "the title picture stands for the first 170 tics, with many colours");
  ok([d1, d2, d3].every(f => f.gamestate === 0 && f.demo && !f.usergame && f.map === 5 && colours(f.pixels) > 60), "then the attract demo plays (a level, demo playback, the shareware's demo1 is on map 5): " + a.marks.join("; "));
  ok(new Set([t1, d1, d2, d3].map(f => fnv(f.pixels))).size === 4 && (d1.x !== d3.x || d1.y !== d3.y), "the demo's frames differ and its player moves");
  const p = a.r.p, s = p.gfx.stats;
  ok(s.frames === p.frames - 1 || s.frames === p.frames, `every frame the engine drew was presented (${s.frames} of ${p.frames})`);
  // the picture of the last checked frame, for a look (build/doom/node-frame.ppm)
  mkdirSync(DOOM_OUT, { recursive: true });
  const ppm = new Uint8Array(15 + 640 * 400 * 3); ppm.set(new TextEncoder().encode("P6\n640 400\n255\n"));
  d3.pixels.forEach((v, i) => { ppm[15 + i * 3] = v >> 16; ppm[16 + i * 3] = v >> 8; ppm[17 + i * 3] = v; });
  writeFileSync(join(DOOM_OUT, "node-frame.ppm"), ppm);
  return [`first frame after ${a.r.firstFrameMs.toFixed(0)} ms of wall time (second run ${b.r.firstFrameMs.toFixed(0)} ms); ${p.frames} frames, ${END} tics in ${a.r.wallMs.toFixed(0)} ms: ${(a.r.wallMs / p.frames).toFixed(2)} ms per frame, guest clock at the end ${(Number(p.rt.guestNs()) / 1e9).toFixed(2)} s`,
    ...a.marks.map(m => "  " + m),
    `identical on a second run: slices/SVCs/units/guest ns/NVN calls/fs calls = ${fingerprint(p)}`,
    `${p.rt.stats.svcs} SVCs, ${p.rt.stats.hostCalls} host calls (${s.nvnCalls} NVN, ${p.fs.stats.calls} nn::fs), ${p.input.publishes} input snapshots`];
});

test("doom input: scripted pad input opens the menu, starts a new game, walks, fires and turns", async () => {
  // Plus four times: the menu, New Game, the episode, the skill. Then forward (the stick), fire (A), turn (the d-pad).
  const script = "40:Plus~3,55:Plus~3,70:Plus~3,85:Plus~3,170:L0/100~60,250:A~4,280:Right~25";
  const at = new Map<number, DoomFrame>(), keep = [30, 50, 150, 168, 232, 248, 278, 310];
  const r = await run({ script, onFrame: f => { if (keep.includes(f.n)) at.set(f.n, { ...f, pixels: f.pixels.slice() }); return f.n >= 320; } });
  const [title, menu, start, before, walked, calm, fired, turned] = keep.map(n => at.get(n)!);
  ok(title.gamestate === 3 && !title.menu, "frame 30: the title");
  ok(menu.menu && fnv(menu.pixels) !== fnv(title.pixels), "frame 50: the menu is up after Plus and the picture changed");
  ok(start.gamestate === 0 && start.usergame && !start.demo && !start.menu && start.map === 1 && start.health === 100 && start.bullets === 50,
    `frame 150: a new game on map 1 with 100 health and 50 bullets (${JSON.stringify({ ...start, pixels: undefined })})`);
  eq([before.x, before.y, before.angle], [start.x, start.y, start.angle], "nothing moves without input");
  const dist = Math.hypot(walked.x - before.x, walked.y - before.y);
  ok(dist > 200, `the player walked forward while the stick was held (${dist.toFixed(0)} map units)`);
  ok(calm.bullets === 50 && fired.bullets < 50, `A fires: bullets ${calm.bullets} -> ${fired.bullets}`);
  ok(turned.angle !== fired.angle && fnv(turned.pixels) !== fnv(fired.pixels), "Right turns the player and the view");
  ok(colours(turned.pixels) > 60, "the level's picture has many colours");
  const again = await run({ script, onFrame: f => f.n >= 320 });
  eq(fingerprint(again.p), fingerprint(r.p), "slices/SVCs/units/guest ns/NVN calls/fs calls of a second run");
  return [`new game at frame ${[...at.keys()].find(n => at.get(n)!.usergame)} or before; walked ${dist.toFixed(0)} map units from (${before.x}, ${before.y}) to (${walked.x}, ${walked.y}); bullets ${calm.bullets} -> ${fired.bullets}; angle 0x${fired.angle.toString(16)} -> 0x${turned.angle.toString(16)}`,
    `checksums: title ${fnv(title.pixels)}, menu ${fnv(menu.pixels)}, level start ${fnv(start.pixels)}, after walking ${fnv(walked.pixels)}, after firing ${fnv(fired.pixels)}, after turning ${fnv(turned.pixels)}`,
    `${r.p.input.publishes} input snapshots; identical on a second run: ${fingerprint(r.p)}`];
});

test("doom saves: a game saved from the menu is a file of the save data, committed; the next process on the same storage loads it", async () => {
  // a new game, a walk, then Minus (the menu), down to Save Game, Plus, Plus (the first slot: its name is typed), Y
  // (the letter the pad can type), Plus. The engine writes temp.dsg, removes the old file and renames.
  const storage = wadStorage(wad), at = new Map<number, DoomFrame>();
  const a = await run({ storage, script: "40:Plus~3,55:Plus~3,70:Plus~3,85:Plus~3,170:L0/100~40,260:Minus~3,270:Down~3,280:Down~3,290:Down~3,300:Plus~3,310:Plus~3,320:Y~3,330:Plus~3",
    onFrame: f => { if (f.n === 305 || f.n === 355) at.set(f.n, { ...f, pixels: f.pixels.slice() }); return f.n >= 360; } });
  const saved = at.get(305)!;   // the player has come to rest and the menu is up
  ok(saved.usergame && saved.map === 1 && (saved.x !== 1056 || saved.y !== -3616), "the game to save: a level, the player away from the start");
  ok(saved.menu && !at.get(355)!.menu, "the save menu was up and closed after the save");
  const commits = a.p.fs.x.fs_commit_count();
  ok(commits >= 2n, "the save data was committed (the file, the rename): " + commits);
  // the second process: Plus (the menu), down to Load Game, Plus, Plus (the first slot)
  let loaded: DoomFrame | undefined, before: DoomFrame | undefined;
  const b = await run({ storage, script: "40:Plus~3,50:Down~3,60:Down~3,70:Plus~3,80:Plus~3", onFrame: f => { if (f.n === 75) before = { ...f, pixels: f.pixels.slice() }; if (f.n === 140) loaded = { ...f, pixels: f.pixels.slice() }; return f.n >= 140; } });
  ok(before!.gamestate === 3 && before!.menu, "the second process is at the title with the load menu up");
  ok(loaded!.usergame && loaded!.gamestate === 0 && loaded!.map === 1, "the saved game was loaded");
  eq([loaded!.x, loaded!.y, loaded!.angle, loaded!.health, loaded!.bullets], [saved.x, saved.y, saved.angle, saved.health, saved.bullets], "the player of the loaded game");
  return [`saved at (${saved.x}, ${saved.y}) after ${commits} commits and ${a.p.fs.stats.calls} nn::fs calls; loaded by a second process (${b.p.fs.stats.calls} nn::fs calls) at the same place`];
});

test("doom reference: every 50th frame of the whole of demo3 (2134 tics under -timedemo) is the frame the same engine draws when built for this machine", async () => {
  const ref = doomReference(["-timedemo", "demo3"], l => console.log(l));
  if (ref === null) return ["SKIPPED: no reference build on this machine"];
  const want = ref.split("\n").filter(l => l.startsWith("REF ")).map(l => l.slice(4));
  ok(want.length >= 40, "the reference printed its frames: " + want.length);
  const got: string[] = []; let lastTic = -1, end: DoomFrame | undefined;
  const r = await run({ args: "-timedemo demo3", onFrame: f => {
    end = { ...f, pixels: f.pixels.subarray(0, 0) };
    if (f.gametic !== lastTic && f.gametic % 50 === 0) { lastTic = f.gametic; got.push(`${f.gametic} ${fnv(f.pixels)} ${f.map} ${f.health} ${f.bullets} ${f.x} ${f.y}`); }
  } }, -1);   // the engine ends a -timedemo through its error exit: exit(-1)
  eq(got, want, "tic, frame checksum, map, health, bullets, x, y of every 50th tic (guest, then the reference)");
  ok(r.p.rt.stdout().includes("timed 2134 gametics"), "the engine's own count at the end: " + r.p.rt.stdout().split("\n").slice(-3).join(" / "));
  return [`${got.length} frames compared, all equal; the last: ${got.at(-1)}`, `the recording ends at tic ${end!.gametic} with the player at (${end!.x}, ${end!.y}), health ${end!.health}; ${r.p.frames} frames in ${r.wallMs.toFixed(0)} ms`];
});

test("doom cache and exit: a second start takes every translation from the cache and draws the same frames; Quit Game from the menu ends the process with exit code 0", async () => {
  ok(env.cacheStore, "the environment has a cache store");
  const store = await env.cacheStore!("doom");
  const once = async () => {
    let mark = "", p!: DoomProcess;
    const t0 = performance.now(); let first = 0;
    p = await bootDoom(env, nso, wad, { nsPerUnit: NS_PER_UNIT, cache: store, onFrame: f => { if (!first) first = performance.now() - t0; if (f.gametic >= 300) { mark = `${f.gametic}:${fnv(f.pixels)}`; return true; } } });
    const got = await p.rt.cacheLoad(), r = await p.rt.runAsync(), saved = await p.rt.cacheSave();
    ok(r.state === "Stopped" && r.stop?.kind === "exit", "the run ended: " + r.state);
    eq(p.rt.red, [], "red lines");
    return { p, got, saved, mark, first };
  };
  const cold = await once(), warm = await once();
  ok(cold.got.units === 0 && cold.saved > 1 << 20, `the first start stored its translations (${cold.saved} bytes)`);
  ok(warm.got.units === cold.p.rt.a64.units.length && warm.p.rt.a64.translatedInsns === 0 && warm.saved === 0, `the second start translated nothing (${warm.p.rt.a64.translatedInsns} instructions, ${warm.got.units} units from the cache)`);
  eq([warm.mark, fingerprint(warm.p)], [cold.mark, fingerprint(cold.p)], "the frame at tic 300 and slices/SVCs/units/guest ns/NVN calls/fs calls, from the cache");
  // Plus (the menu), Up (from New Game round to Quit Game), Plus, then Y to the question
  const quit = await run({ script: "40:Plus~3,50:Up~3,60:Plus~3,75:Y~3", onFrame: f => { if (f.n > 300) throw new Error("the game did not quit"); } });
  return [`cache: ${cold.saved} bytes stored for ${cold.p.rt.a64.translatedInsns} instructions in ${cold.got.units === 0 ? cold.p.rt.a64.units.length : 0} units; first frame after ${cold.first.toFixed(0)} ms cold, ${warm.first.toFixed(0)} ms from the cache`,
    `quit: exit code 0 after ${quit.p.frames} frames`];
});

test("doom speed: instructions per second and time per frame over 500 tics of the engine's own -timedemo", async () => {
  // -timedemo runs one tic per frame whatever the clock says: the same work in every run, so the same stretch can be
  // counted in instructions (one instruction per budget unit) and timed
  const FROM = 100, TO = 600;
  const stretch = async (o: DoomBoot) => {
    let u0 = 0, t0 = 0, u1 = 0, t1 = 0, f0 = 0, f1 = 0, host0 = 0, host1 = 0, mark = "", p!: DoomProcess;
    const r = await run({ args: "-timedemo demo1", ...o, setup: q => { p = q as DoomProcess; }, onFrame: f => {
      if (!t0 && f.gametic >= FROM) { u0 = p.rt.units; t0 = performance.now(); f0 = f.n; host0 = p.rt.times.hostMs; }
      if (f.gametic >= TO) { u1 = p.rt.units; t1 = performance.now(); f1 = f.n; host1 = p.rt.times.hostMs; mark = `${f.gametic}:${fnv(f.pixels)}`; return true; }
    } });
    return { r, units: u1 - u0, ms: t1 - t0, frames: f1 - f0, hostMs: host1 - host0, mark };
  };
  const cold = await stretch({}), warm = await stretch({}), slowClock = await stretch({ nsPerUnit: 400 });
  eq(warm.mark, cold.mark, "the frame at the end of the stretch, second run");
  eq(slowClock.mark, cold.mark, "the frame at the end of the stretch on a clock twenty times slower");
  eq([warm.frames, slowClock.frames], [cold.frames, cold.frames], "frames in the stretch");
  const one = await stretch({ maxInsns: 1, budget: 1 << 20 });
  eq(one.mark, cold.mark, "the frame at the end of the stretch with one instruction per unit");
  const insns = one.units, best = Math.min(cold.ms, warm.ms), p = cold.r.p, a = p.rt.a64;
  const lines = [`tics ${FROM}..${TO} of demo1: ${cold.frames} frames, ${(insns / 1e6).toFixed(1)} M guest instructions (±1 M: counted in slices), ${(insns / cold.frames / 1e3).toFixed(0)} k per frame, ${cold.units} budget units (${(insns / cold.units).toFixed(1)} instructions per unit)`,
    `wall time ${cold.ms.toFixed(0)} ms and ${warm.ms.toFixed(0)} ms: ${(best / cold.frames).toFixed(2)} ms per frame (${(1000 * cold.frames / best).toFixed(0)} frames per second unpaced), ${(insns / best / 1e3).toFixed(0)} M guest instructions per second; of it ${warm.hostMs.toFixed(0)} ms in host calls (NVN recording, null replayer)`,
    `one instruction per unit (the count): ${one.ms.toFixed(0)} ms`,
    `translated: ${a.translatedInsns} guest instructions in ${a.units.length} units, ${mb(a.moduleBytes)} of WebAssembly (largest module ${mb(a.maxModuleBytes)}); pc map ${mb(a.pcMapBytes)}; linear memory ${mb(p.rt.memory.buffer.byteLength)}; process RSS ${env.rssMb?.().toFixed(0)} MB`,
    `the module file: ${nso.length} bytes (LZ4)`];
  writeFileSync(join(DOOM_OUT, "measure.json"), JSON.stringify({ instructionsPerUnit: insns / cold.units, instructionsPerFrame: insns / cold.frames, msPerFrame: best / cold.frames, instructionsPerSecond: insns / best * 1000 }));
  return lines;
});

const only = process.argv[2];
let failed = 0, ran = 0;
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  ran++;
  const t0 = performance.now();
  try { const info = await t.fn(); console.log(`ok   ${t.name} (${(performance.now() - t0).toFixed(0)} ms)`); for (const l of info) console.log("       " + l); }
  catch (e) { failed++; console.log(`[RED] FAIL ${t.name}\n${e instanceof Error ? e.message : e}`); }
}
console.log(`\ndoom:test (node ${process.version}): ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
