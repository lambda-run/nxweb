// node em/tools/movie_trace.mjs <console.txt>: per owner report (10 s), the AV1 packets in, the presents so far and the nn::fs
// entries: when the movie plays, when it ends, when file reads pick up; and the keys the runner pressed.
import { readFileSync } from "node:fs";
const t = readFileSync(process.argv[2], "utf8").split("\n"), seen = new Set(), out = []; let at = 0, keys = 0;
for (const l of t) { if (l.startsWith("[em_run] key")) { keys++; continue; } const i = l.indexOf("[owner] time, last"); if (i < 0 || seen.has(l)) continue; seen.add(l); let o; try { o = JSON.parse(l.slice(l.indexOf("{"))); } catch { continue; }
  at += o.wallMs / 1000; let fs = 0; for (const [k, v] of Object.entries(o.sections)) if (k.startsWith("fs")) fs += v.n;
  out.push(`${Math.round(at)}s:${o.video.packetsIn}pk/${o.presents}pr/${fs}fs`); }
console.log(`${process.argv[2].split("/").pop()} (${keys} keys; seconds since the first report: AV1 packets in / presents so far / fs entries): ` + out.join(" "));
