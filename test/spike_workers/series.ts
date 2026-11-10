// EXPERIMENTAL (spike, SPIKE.md). What the Node runner and the browser page share: the expected texts and one series
// of runs of a guest in one configuration.
import type { RunResult } from "../../src/spike_workers/coord.ts";
import type { EngineOpts } from "../../src/spike_workers/engine.ts";

export type Config = "unshared" | "shared-green" | 1 | 2 | 3 | 4;
export type RunFn = (guest: string, config: Config, opts?: EngineOpts & { sharedHelpers?: boolean }) => Promise<RunResult>;

export const THREADS = `0 compute: 0x1fd3dba0d3209a5f\n1 mutex: counter=800 of 800, lock word=0x0, ArbitrateLock used: yes\n` +
  `2 condvar: produced=200 consumed=200 sum in=309900 out=309900 left=0\n` +
  `3 event: wait 1 ms on an unsignaled event: rc=0xea01, at least 19200 ticks passed: yes\n` +
  `3 event: signaled by another thread: rc=0x0 index=1\n3 event: ResetSignal rc=0x0, again rc=0xfa01, poll rc=0xea01\n` +
  `4 sleep: wake order 1 2 0 (sleeps of 3, 1 and 2 ms)\n5 join: wait on an exited thread rc=0x0 index=0, it left 77\nthreads done\n`;
export const STRESS = `1 atomics: a64=800000 of 800000, a32=2400000 of 2400000\n2 mutex: count=20000 of 20000, overlaps=0, lock word=0x0\n` +
  `3 helpers: 8 of 8 threads got the single-thread result\n4 pause: counter stood still 20 of 20, context plausible 20 of 20, ran on after resume 20 of 20\n` +
  `5 heap: a thread on core 2 wrote this at the top of a 64 MB heap\n5 heap: SetHeapSize rc=0x0, first byte of the text there: 5\nstress done\n`;
export const DEKKER = "dekker: both cores read 0 after their barrier in 0 of 200000 rounds\n";
export const EXPECT: Record<string, [text: string, exit: number]> = { threads: [THREADS, 7], stress: [STRESS, 9], dekker: [DEKKER, 0] };

export const label = (c: Config) => c === "unshared" ? "green, unshared (today)" : c === "shared-green" ? "green, shared build" : `${c} Worker${c === 1 ? "" : "s"}`;
const firstDiff = (a: string, b: string) => { const la = a.split("\n"), lb = b.split("\n"); for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) return `line ${i + 1}: got ${JSON.stringify(la[i])}, want ${JSON.stringify(lb[i])}`; return ""; };

// Three lines of the threads guest assume what only green threads guarantee:
//   line 2 "ArbitrateLock used: yes": four threads started one after the other all run before the first has finished
//          its 200 short critical sections
//   line 7 "wake order 1 2 0": sleeps of 1, 2 and 3 ms end 1 ms apart, to the tick
//   line 8 "wait on an exited thread rc=0x0 ... it left 77": a thread started on another core has run to its end
//          1 ms after StartThread
// On Workers all three depend on the host's scheduler and timers (measured: a timed Atomics.wait came back up to 2 ms
// late on the loaded test machine). modTiming masks exactly these three facts; everything else must be equal.
export function modTiming(s: string): string {
  return s.replace("ArbitrateLock used: no", "ArbitrateLock used: yes")
    .replace(/wake order (?:[012] ){3}/, m => /0/.test(m) && /1/.test(m) && /2/.test(m) ? "wake order 1 2 0 " : m)
    .replace("wait on an exited thread rc=0xea01 index=0, it left 0", "wait on an exited thread rc=0x0 index=0, it left 77");
}
export interface SeriesResult { ok: boolean; passed: number; timingOnly: number; runs: number; line: string; bad: [string, number][] }
export async function series(run: RunFn, guest: string, config: Config, runs: number, opts: EngineOpts = {}, note = ""): Promise<SeriesResult> {
  const [want, exit] = EXPECT[guest];
  let passed = 0, timingOnly = 0; const bad = new Map<string, number>(), walls: number[] = [], sigs = new Set<string>();
  const agg = { needMs: 0, recompiled: 0, recompileMs: 0, compiled: 0, compileMs: 0, ackWaits: 0, tableTraps: 0, needs: 0, bufferChanges: 0, inplaceResumes: 0, unwinds: 0, ackMs: 0 };
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) {
    let why = "";
    try {
      const r = await run(guest, config, opts);
      walls.push(r.wallMs);
      sigs.add(`${r.guestNs}/${r.stats.map(s => s.slices + ":" + s.svcs).join(",")}`);
      for (const s of r.stats) { agg.ackWaits += s.ackWaits; agg.ackMs += s.ackMs; agg.tableTraps += s.a64.tableTraps; agg.needs += s.a64.needs; agg.needMs += s.a64.needMs; agg.recompiled += s.a64.recompiled; agg.recompileMs += s.a64.recompileMs; agg.compiled += s.a64.translated; agg.compileMs += s.a64.compileMs; agg.bufferChanges += s.bufferChanges; agg.inplaceResumes += s.inplaceResumes; agg.unwinds += s.unwinds; }
      if (r.fault) why = "fault: " + r.fault.split("\n")[0];
      else if (r.out !== want) { why = firstDiff(r.out, want); if (typeof config === "number" && modTiming(r.out) === want) { timingOnly++; why = "timing only: " + r.out.split("\n").map((l, i) => l !== want.split("\n")[i] ? `line ${i + 1} ${JSON.stringify(l.replace(/^(\d \w+): .*?(used: \w+|order [0-9 ]+|rc=\w+).*$/, "$1 ... $2"))}` : "").filter(x => x).join(", "); } else why = firstDiff(modTiming(r.out), want); }
      else if (r.exitCode !== exit || r.stopReason !== 1) why = `exit code ${r.exitCode}, stop reason ${r.stopReason}`;
      else if (r.logs.some(l => l.includes("[RED]"))) why = "red line: " + r.logs.find(l => l.includes("[RED]"));
    } catch (e) { why = "run failed: " + (e instanceof Error ? e.message.split("\n")[0] : e); }
    if (why) bad.set(why, (bad.get(why) ?? 0) + 1); else passed++;
  }
  walls.sort((a, b) => a - b);
  const par = typeof config === "number";
  let ok = passed + timingOnly === runs;
  let line = `${guest.padEnd(8)} ${(label(config) + (note ? " " + note : "")).padEnd(24)} ${passed}/${runs} exact${timingOnly ? `, ${timingOnly} more differ only in the three timing-dependent lines` : ""}; run wall min/median/max ${walls[0]?.toFixed(0)}/${walls[walls.length >> 1]?.toFixed(0)}/${walls[walls.length - 1]?.toFixed(0)} ms; ` +
    (par ? `in-place resumes ${agg.inplaceResumes}, unwinds ${agg.unwinds}, pause acks ${agg.ackWaits} (${agg.ackWaits ? (agg.ackMs / agg.ackWaits).toFixed(2) : "-"} ms each), table traps ${agg.tableTraps}, units compiled ${agg.compiled} (${(agg.compileMs / Math.max(1, agg.compiled)).toFixed(2)} ms each), made again from bytes ${agg.recompiled} (${(agg.recompileMs / Math.max(1, agg.recompiled)).toFixed(2)} ms each), unit waits ${agg.needs} (${(agg.needMs / Math.max(1, agg.needs)).toFixed(2)} ms each), buffer refreshes ${agg.bufferChanges}`
         : `${sigs.size} distinct (guest ns, slices, SVCs) over the runs`) + `; ${((performance.now() - t0) / 1000).toFixed(0)} s`;
  for (const [why, n] of bad) line += `\n       ${n}x ${why}`;
  if (!par && sigs.size !== 1) { ok = false; line += "\n       [RED] green threads were not deterministic"; }
  return { ok, passed, timingOnly, runs, line: (ok ? "ok   " : "FAIL ") + line, bad: [...bad] };
}

// The two demonstrations whose differences are the point
export async function demos(run: RunFn, n: number): Promise<string[]> {
  const out: string[] = [];
  for (const config of ["unshared", 4] as Config[]) {
    const outs = new Map<string, number>();
    for (let i = 0; i < n; i++) { const r = await run("race", config); outs.set(r.out, (outs.get(r.out) ?? 0) + 1); }
    out.push(`race on ${config === "unshared" ? "green threads" : "4 Workers"}: ${outs.size} distinct output${outs.size > 1 ? "s" : ""} in ${n} runs` +
      (outs.size > 1 ? `, e.g. ${[...outs.keys()].slice(0, 2).map(o => JSON.stringify(o.split("\n")[0])).join(" and ")}` : `: ${JSON.stringify([...outs.keys()][0].split("\n")[0])}`));
  }
  let wrong = 0; const lines = new Set<string>();
  for (let i = 0; i < n; i++) { const r = await run("stress", 4, { sharedHelpers: true }); const l = r.out.split("\n")[2] ?? r.fault ?? ""; if (l !== STRESS.split("\n")[2]) { wrong++; lines.add(l); } }
  out.push(`stress on 4 Workers with ONE helpers scratch area (helpers.shared.wasm as built today): ${wrong} of ${n} runs computed FRECPE wrongly${wrong ? ", e.g. " + JSON.stringify([...lines][0]) : ""}`);
  const counts: string[] = [];
  for (let i = 0; i < n; i++) { const r = await run("dekker", 4, { noFence: true }); counts.push(/in (\d+) of/.exec(r.out)?.[1] ?? "?"); }
  out.push(`dekker on 4 Workers with DMB compiled to nothing (as on an unshared memory): both cores read 0 in ${counts.join(", ")} of 200000 rounds (${n} runs; 0 is the only correct count)`);
  return out;
}
