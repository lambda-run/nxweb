// node em/tools/lf_real.mjs <console.txt> [from-present [to-present]]: from the owner's 10 s reports in a run's console log
//  - the real-call audit (?lfaudit=1): the entry points whose audited calls wrote nothing shared (as a JSON list for
//    owner/lockfree_real.ts) and the ones that did, with what (s static, g globals, a arena words; @ the first address);
//  - NVN calls by entry point between the first report at or after `from-present` presents and the last one up to
//    `to-present` (default: the whole run): the top 20 and the share that went without the lock.
import { readFileSync } from "node:fs";
const seen = new Set(), reps = [];
for (const l of readFileSync(process.argv[2], "utf8").split("\n")) { const i = l.indexOf("[owner] time, last"); if (i < 0 || seen.has(l)) continue; seen.add(l); try { reps.push(JSON.parse(l.slice(l.indexOf("{")))); } catch { /* cut */ } }
const from = Number(process.argv[3] ?? 0), to = Number(process.argv[4] ?? 1e12), withCalls = reps.filter(r => r.nvnCalls);
const last = [...reps].reverse().find(r => r.lfAudit);
if (last) { const a = last.lfAudit, names = a.clean.map(s => s.split(":")[0]);
  console.log(`real-call audit: ${a.candidates} candidates, ${a.called} called, ${a.clean.length} wrote nothing shared, ${a.dirty.length} did`);
  console.log("clean (name:audited calls, rN = N of them recorded): " + a.clean.join(" "));
  console.log("dirty: " + a.dirty.join("; "));
  console.log("names: " + JSON.stringify(names)); }
const A = withCalls.find(r => r.presents >= from), B = [...withCalls].reverse().find(r => r.presents <= to);
if (A && B && A !== B) { const m = new Map(B.nvnCalls.top.map(r => [r[0], [r[1], r[2]]])); for (const r of A.nvnCalls.top) if (m.has(r[0])) m.get(r[0])[0] -= r[1];
  const d = k => B.nvnCalls[k] - A.nvnCalls[k], free = d("onThreadWithoutLockTable"), lock = d("onThreadUnderLock"), own = d("onOwner"), all = free + lock + own;
  console.log(`NVN calls, presents ${A.presents} to ${B.presents}: ${all} (${(all / Math.max(1, B.presents - A.presents)).toFixed(0)} a present); entry points that go without the lock ${free} (${(100 * free / all).toFixed(1)} %), under the lock on the calling thread ${lock} (${(100 * lock / all).toFixed(1)} %), on the owner ${own} (${(100 * own / all).toFixed(1)} %)`);
  console.log("top 20: " + [...m].sort((a, b) => b[1][0] - a[1][0]).slice(0, 20).map(([n, [c, how]]) => `${n} ${c} (${(100 * c / all).toFixed(1)} %, ${how})`).join("; ")); }
