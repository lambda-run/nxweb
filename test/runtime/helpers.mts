// npm run rt:test:helpers [-- <filter>] [--no-build]. The helper Workers of the runtime (RuntimeOptions.helpers;
// src/glue/rt_helpers.ts) under Node: each helper is a worker_threads Worker (helper_node.ts) on the shared memory.
// Runs in the shared modes only (NX_SHARED=1; tools/modes.mjs: [32s], [64s], [64his]).
import { Worker } from "node:worker_threads";
import { ROOT, build, buildModules, loadEnv, SHARED, MODE } from "./harness.mts";
import { Runtime, type RuntimeOptions, type RunResult } from "../../src/glue/rt_runtime.ts";

process.chdir(ROOT);
const args = process.argv.slice(2), only = args.find(a => !a.startsWith("--"));
if (!SHARED) { console.error("[RED] rt:test:helpers: helpers need a shared memory: run with NX_SHARED=1 (npm run rt:test:helpers)"); process.exit(1); }
if (!args.includes("--no-build")) {
  try { build(); buildModules(); } catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] rt:test:helpers: the build failed"); process.exit(1); }
}
const env = loadEnv();
const workerFails: string[] = [];
const spawn = (k: number) => {
  const w = new Worker(new URL("./helper_node.ts", import.meta.url));
  w.on("message", (m: any) => { if (m?.t === "fail") workerFails.push(`helper ${k}: ${m.text}`); });
  w.on("error", e => workerFails.push(`helper ${k}: ${e}`));
  w.unref();
  return w;
};
const fail = (m: string): never => { throw new Error(m); };
const ok = (c: unknown, m: string) => { if (!c) fail(m); };
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) fail(`${m}: got ${x}, expected ${y}`); };
const boot = (name: string, o: RuntimeOptions): Runtime => {
  const rt = new Runtime(env.mods, { clock: "wall", helperSpawn: spawn, helperCheck: true, ...o });
  ok(rt.loadNso([{ name, bytes: env.nso(name) }]), `load failed: ${rt.red.join(" | ")}`);
  return rt;
};
const pool = (rt: Runtime) => (rt as any).hp;
async function go(name: string, o: RuntimeOptions, how: "sync" | "async" = "sync"): Promise<{ rt: Runtime; r: RunResult; ms: number }> {
  const rt = boot(name, o);
  if (o.helpers) eq(await rt.helpersReady(), o.helpers, `helpers started (${rt.red.join(" | ")} ${workerFails.join(" | ")})`);
  const t0 = performance.now();
  const r = how === "sync" ? rt.run() : await rt.runAsync();
  return { rt, r, ms: performance.now() - t0 };
}
const exited = (x: { rt: Runtime; r: RunResult }, what: string) => {
  if (x.r.state !== "Stopped" || x.r.stop?.kind !== "exit" || x.r.stop.code !== 0) fail(`${what}: expected Stopped(exit 0), got ${x.r.state} ${x.r.stop?.kind} ${x.r.stop?.fault?.detail ?? ""}\nstdout:\n${x.rt.stdout()}\nred: ${x.rt.red.slice(0, 12).join("\n")}`);
  eq(x.rt.red, [], `${what}: red lines`);
  eq(workerFails, [], `${what}: helper failures`);
};
// helpers that ran a given thread, and the threads that went out at all
const outOf = (rt: Runtime) => rt.helperThreads().filter(t => t.helperMs.some(v => v > 0));

const tests: [string, () => Promise<string[]>][] = [];
const test = (name: string, fn: () => Promise<string[]>) => tests.push([name, fn]);

test("a compute: four threads on four cores give the same output with 0, 1 and 3 helpers, and with 3 each helper ran one", async () => {
  const h0 = await go("hp_compute", {}); exited(h0, "no helpers");
  ok(h0.rt.stdout().endsWith("compute done\n"), "the guest's last line");
  eq(h0.rt.helperCount, 0, "helpers without the option");
  const h1 = await go("hp_compute", { helpers: 1 }); exited(h1, "1 helper");
  const h3 = await go("hp_compute", { helpers: 3 }); exited(h3, "3 helpers");
  eq(h1.rt.stdout(), h0.rt.stdout(), "output with 1 helper"); eq(h3.rt.stdout(), h0.rt.stdout(), "output with 3 helpers");
  const out = outOf(h3.rt), used = new Set<number>();
  for (const t of out) t.helperMs.forEach((v, k) => { if (v > 0) used.add(k); });
  ok(out.length >= 3, `threads that ran on a helper: ${out.length}`);
  eq([...used].sort(), [0, 1, 2], "helpers that ran guest code");
  for (let k = 0; k < 3; k++) ok(pool(h3.rt).stats(k).busyMs > 0 && pool(h3.rt).stats(k).units > 0, `helper ${k} instantiated units and was busy`);
  const a3 = await go("hp_compute", { helpers: 3 }, "async"); exited(a3, "3 helpers, runAsync");
  eq(a3.rt.stdout(), h0.rt.stdout(), "output with 3 helpers under runAsync");
  const t = h3.rt.helperTotals();
  return [`wall time of the run: no helpers ${h0.ms.toFixed(0)} ms, 1 helper ${h1.ms.toFixed(0)} ms (x${(h0.ms / h1.ms).toFixed(2)}), 3 helpers ${h3.ms.toFixed(0)} ms (x${(h0.ms / h3.ms).toFixed(2)}), 3 helpers under runAsync ${a3.ms.toFixed(0)} ms (x${(h0.ms / a3.ms).toFixed(2)})`,
    `3 helpers: guest code here ${t.mainMs.toFixed(0)} ms, on helpers ${t.helperMs.map(v => v.toFixed(0)).join(" / ")} ms; exits ${JSON.stringify(h3.rt.helperExits())}`, ...h3.rt.helperLines().slice(0, 2)];
});

test("b locks: a mutex and condition variable ping-pong and a contended counter between a thread on a helper and one here; kernel_check after every exit", async () => {
  const h0 = await go("hp_ping", {}); exited(h0, "no helpers");
  ok(h0.rt.stdout().endsWith("ping done\n"), "the guest's last line");
  const h2 = await go("hp_ping", { helpers: 2 }); exited(h2, "2 helpers");
  eq(h2.rt.stdout(), h0.rt.stdout(), "output with helpers");
  const ex = h2.rt.helperExits(), st = h2.rt.hpStats;
  ok((ex.svc ?? 0) >= 20, `SVC exits served from helpers: ${ex.svc}`);
  ok(st.checks >= 20, `kernel_check calls: ${st.checks}`);
  ok(outOf(h2.rt).length >= 1, "a thread ran on a helper");
  const a2 = await go("hp_ping", { helpers: 2 }, "async"); exited(a2, "2 helpers, runAsync");
  eq(a2.rt.stdout(), h0.rt.stdout(), "output with helpers under runAsync");
  return [h2.rt.stdout().trim().split("\n").slice(0, 2).join("; "), `exits ${JSON.stringify(ex)}; ${st.checks} kernel checks, all 0; ${st.jobs} slices out, ${st.recalls} asked back, ${st.calledBack} called back; ${h0.ms.toFixed(0)} ms without, ${h2.ms.toFixed(0)} ms with helpers`];
});

test("c units: code first reached on a helper is translated here and published; code translated here while a helper runs reaches it", async () => {
  const o: RuntimeOptions = { maxFuncs: 2 };
  const h0 = await go("hp_units", o); exited(h0, "no helpers");
  ok(h0.rt.stdout().endsWith("units done\n"), "the guest's last line");
  const rt = boot("hp_units", { ...o, helpers: 1 });
  eq(await rt.helpersReady(), 1, "helper started");
  let whileOut = 0;
  const pub = rt.a64.onUnit!;
  rt.a64.onUnit = (u, mod) => { if (pool(rt).busyCount) whileOut++; pub(u, mod); };
  const r = rt.run(); exited({ rt, r }, "1 helper");
  eq(rt.stdout(), h0.rt.stdout(), "output with a helper");
  const ex = rt.helperExits(), q = pool(rt).stats(0);
  ok((ex["unit needed"] ?? 0) >= 4, `units a helper asked for: ${ex["unit needed"]}`);
  ok(whileOut >= 4, `units installed here while the helper ran: ${whileOut}`);
  ok(q.units >= 8, `units the helper instantiated: ${q.units}`);
  return [`${rt.a64.units.length} units in all; ${whileOut} installed while the helper ran a thread; the helper asked for ${ex["unit needed"]} and instantiated ${q.units} (${q.instMs.toFixed(1)} ms); exits ${JSON.stringify(ex)}`];
});

test("d trap: a null store on a helper gives the fault report of the same store here", async () => {
  const h0 = await go("hp_trap", {}), h1 = await go("hp_trap", { helpers: 1 });
  for (const [x, what] of [[h0, "no helpers"], [h1, "1 helper"]] as const) ok(x.r.state === "Stopped" && x.r.stop?.kind === "fault", `${what}: expected a fault, got ${x.r.state} ${x.r.stop?.kind}`);
  const f0 = h0.r.stop!.fault!, f1 = h1.r.stop!.fault!;
  eq(h1.rt.helperExits().trap, 1, "the trap was on the helper");
  eq([f1.kind, f1.threadIndex, f1.pc.toString(16), f1.detail], [f0.kind, f0.threadIndex, f0.pc.toString(16), f0.detail], "kind, thread, pc and text of the fault");
  // the whole report but what depends on time or on where a slice ended (the SVC ring's ticks, host-call ring)
  const body = (l: string[]) => { const end = l.findIndex(v => /the last \d+ of the \d+ SVCs|made no SVC/.test(v)); return l.slice(0, end < 0 ? l.length : end); };
  eq(body(f1.lines), body(f0.lines), "the report's lines (what, registers, pc and x30 placed, frames)");
  eq(workerFails, [], "helper failures");
  return [`${f1.kind} at pc ${f1.pc.toString(16)}: ${f1.detail.slice(0, 110)}`, `${body(f1.lines).length} report lines identical`];
});

test("e stop: pause, exit and kill while a helper is in a slice; a helper asked for with the deterministic clock is refused in red", async () => {
  const rt = boot("hp_spin", { helpers: 1 });
  eq(await rt.helpersReady(), 1, "helper started");
  let r = rt.run({ yieldMs: 150, async: true });
  for (let i = 0; i < 40 && !pool(rt).busyCount; i++) { await new Promise(res => setTimeout(res, 5)); r = rt.run({ yieldMs: 20, async: true }); }
  eq(pool(rt).busyCount, 1, "the spinning thread is out when run() yields");
  r = rt.run({ ms: 30 });
  eq([r.state, pool(rt).busyCount], ["Paused", 0], "paused: every thread is back");
  r = rt.run({ yieldMs: 60, async: true });
  for (let i = 0; i < 40 && !pool(rt).busyCount; i++) r = rt.run({ yieldMs: 20, async: true });
  eq(pool(rt).busyCount, 1, "out again after the pause");
  const t0 = performance.now();
  rt.kill();
  const killMs = performance.now() - t0;
  eq([rt.state, rt.stopInfo?.kind, pool(rt).busyCount, rt.disposed], ["Stopped", "killed", 0, true], "killed while the helper ran");
  ok(killMs < 2000, `kill() took ${killMs.toFixed(0)} ms`);
  eq(rt.red, [], "red lines");
  const rt2 = boot("hp_spin", { helpers: 1 });
  eq(await rt2.helpersReady(), 1, "helper started");
  rt2.run({ yieldMs: 100, async: true });
  for (let i = 0; i < 40 && !pool(rt2).busyCount; i++) rt2.run({ yieldMs: 20, async: true });
  eq(pool(rt2).busyCount, 1, "out before the exit");
  rt2.requestExit(5);
  eq([rt2.state, rt2.stopInfo?.kind, rt2.stopInfo?.code, pool(rt2).busyCount], ["Stopped", "exit", 5, 0], "exit asked for while the helper ran");
  eq(rt2.red, [], "red lines");
  const det = new Runtime(env.mods, { helpers: 2, helperSpawn: spawn });
  eq([det.helperCount, det.red.length], [0, 1], "helpers with the deterministic clock");
  ok(/helpers: 2 asked for, none started/.test(det.red[0]), det.red[0]);
  eq(workerFails, [], "helper failures");
  return [`kill() with a thread out returned in ${killMs.toFixed(1)} ms`, det.red[0]];
});

test("f scheduling: threads that queue on one core take turns through a helper (asked back at slice ends); SetThreadActivity calls its target back and keeps it here", async () => {
  const h0 = await go("hp_sched", {}); exited(h0, "no helpers");
  ok(h0.rt.stdout().endsWith("sched done\n") && /progress while paused: none, before the end: yes/.test(h0.rt.stdout()), "the guest's lines: " + h0.rt.stdout());
  const h2 = await go("hp_sched", { helpers: 2 }); exited(h2, "2 helpers");
  eq(h2.rt.stdout(), h0.rt.stdout(), "output with helpers");
  const st = h2.rt.hpStats, ex = h2.rt.helperExits(), kept = h2.rt.helperLines(99).filter(l => /kept here/.test(l));
  ok(st.recalls >= 10 && (ex["slice end"] ?? 0) >= 10, `threads asked back for a waiting thread: ${st.recalls}, slice-end exits ${ex["slice end"]}`);
  ok(st.calledBack >= 1, `threads called back for SetThreadActivity: ${st.calledBack}`);
  eq(kept.length, 1, "threads kept here as a SetThreadActivity target");
  ok(outOf(h2.rt).length >= 3, `threads that ran on a helper: ${outOf(h2.rt).length}`);
  return [h2.rt.stdout().trim().split("\n").slice(1, 3).join("; "), `${st.recalls} asked back, ${st.calledBack} called back; exits ${JSON.stringify(ex)}; ${st.checks} kernel checks, all 0`, kept[0].trim()];
});

test("g counter: cntpct_el0 read on a helper never steps back and lies between the GetSystemTick answers around it", async () => {
  const h0 = await go("hp_clock", {}); exited(h0, "no helpers");
  const want = /^counter: 3000 reads, steps back: 0, between the two GetSystemTick: yes, moved: yes, result 0x[0-9a-f]+\nclock done\n$/;
  ok(want.test(h0.rt.stdout()), "the guest's lines without helpers: " + h0.rt.stdout());
  const h1 = await go("hp_clock", { helpers: 1 }); exited(h1, "1 helper");
  eq(h1.rt.stdout(), h0.rt.stdout(), "output with a helper");
  const ex = h1.rt.helperExits(), t = h1.rt.helperTotals();
  ok(t.helperMs[0] > 0, "the thread ran on the helper");
  ok((ex["counter read"] ?? 0) < 300, `counter reads that came back here: ${ex["counter read"]} of 3000`);
  return [h1.rt.stdout().split("\n")[0], `exits ${JSON.stringify(ex)} (a counter read is answered on the helper); guest code here ${t.mainMs.toFixed(0)} ms, helper ${t.helperMs[0].toFixed(0)} ms`];
});

let failed = 0, n = 0;
for (const [name, fn] of tests) {
  if (only && !name.includes(only)) continue;
  n++;
  const t0 = performance.now();
  try { const info = await fn(); console.log(`ok   ${name} (${(performance.now() - t0).toFixed(0)} ms)` + info.map(l => "\n       " + l).join("")); }
  catch (e) { failed++; console.log(`[RED] FAIL ${name}\n${e instanceof Error ? e.stack ?? e.message : e}`); }
}
console.log(`\nrt:test:helpers [${MODE}s] (node ${process.version}): ${n} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
