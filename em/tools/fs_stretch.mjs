// node em/tools/fs_stretch.mjs <console.txt>...: from the page's "[owner] time, last N s" lines, what nn::fs cost the owner
// thread: the fs sections' time, their longest synchronous stretch, the stretches over 8 ms, the event loop's lag; and the
// first present and the fs worker's own totals when the log has them.
import { readFileSync } from "node:fs";
for (const f of process.argv.slice(2)) {
  const t = readFileSync(f, "utf8").split("\n"); let wall = 0, ms = 0, n = 0, max = 0, longN = 0, longMs = 0, lagMax = 0, lagSum = 0, lagN = 0, seen = new Set();
  for (const l of t) { const i = l.indexOf("[owner] time, last"); if (i < 0) continue; const j = l.indexOf("{"); if (seen.has(l)) continue; seen.add(l); let o; try { o = JSON.parse(l.slice(j)); } catch { continue; }
    wall += o.wallMs; for (const [k, v] of Object.entries(o.sections)) if (k.startsWith("fs:") || k.startsWith("fs storage")) { ms += v.ms; n += v.n; if (v.maxMs > max) max = v.maxMs; }
    for (const [k, v] of Object.entries(o.synchronousStretchesOver8ms ?? {})) if (k.startsWith("fs:") || k.startsWith("fs storage")) { longN += v.n; longMs += v.ms; }
    lagN += o.eventLoopLag.probes; lagSum += o.eventLoopLag.meanMs * o.eventLoopLag.probes; if (o.eventLoopLag.maxMs > lagMax) lagMax = o.eventLoopLag.maxMs; }
  const fp = (t.find(l => l.includes("FIRST PRESENT")) ?? "").match(/([\d.]+) s after/), w = t.filter(l => l.includes("fs worker, so far")).pop();
  console.log(`${f.split("/").pop()}: first present ${fp ? fp[1] + " s" : "none"}; owner: fs sections ${n} entries, ${ms.toFixed(0)} ms of ${(wall / 1000).toFixed(0)} s (${(100 * ms / wall).toFixed(2)} %), longest ${max.toFixed(1)} ms, over 8 ms: ${longN} (${longMs.toFixed(0)} ms); event loop lag mean ${(lagSum / (lagN || 1)).toFixed(1)} ms, max ${lagMax.toFixed(0)} ms${w ? "; " + w.slice(w.indexOf("fs worker")) : ""}`);
}
