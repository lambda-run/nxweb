// `npm test` at the root: every area's fast tests, one after the other, with one summary.
//   kit, loader, kernel   their own runners
//   a64                   Gate 2 (the guest programs; the instruction fuzz is `npm run a64:fuzz`, a separate CI job).
//                         Programs listed in A64_EXPECTED_FAILURES may fail without failing the run: they are reported.
//   runtime               the end-to-end tests under Node (`npm run rt:browser` needs Playwright and is not part of this)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The three programs the translator's README lists as failing (NaN payloads, FPCR rounding modes, reciprocal estimates)
export const A64_EXPECTED_FAILURES = ["fp_nan_bits", "fpcr_modes", "neon_estimate"];

interface Step { name: string; ok: boolean; note: string; ms: number }
const steps: Step[] = [];
function npm(script: string): { code: number; out: string } {
  const r = spawnSync("npm", ["run", "-s", script], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  process.stdout.write(out.split("\n").filter(l => !/MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module|To eliminate this warning|--trace-warnings/.test(l)).join("\n"));
  return { code: r.status ?? 1, out };
}
function step(name: string, fn: () => { ok: boolean; note: string }): void {
  console.log(`\n===== ${name} =====`);
  const t0 = Date.now();
  let r: { ok: boolean; note: string };
  try { r = fn(); } catch (e) { r = { ok: false, note: String(e) }; }
  steps.push({ name, ...r, ms: Date.now() - t0 });
}
const last = (out: string, re: RegExp) => out.split("\n").filter(l => re.test(l)).at(-1)?.trim() ?? "";

const corpus = join(ROOT, "test", "guests", "out");
if (!existsSync(corpus) || !readdirSync(corpus).some(f => f.endsWith(".json"))) {
  step("guests:build (test/guests/out is not in the repository)", () => { const r = npm("guests:build"); return { ok: r.code === 0, note: "" }; });
}
step("kit:test", () => { const r = npm("kit:test"); return { ok: r.code === 0, note: last(r.out, /^kit:test:/) }; });
step("loader:test", () => { const r = npm("loader:test"); return { ok: r.code === 0, note: last(r.out, /^loader:test:/) }; });
step("kernel:test", () => { const r = npm("kernel:test"); return { ok: r.code === 0, note: last(r.out, /^kernel:test:/) }; });
step("a64:guests", () => {
  const r = npm("a64:guests");
  const failed = [...r.out.matchAll(/^\[RED\] FAIL (\S+)/gm)].map(m => m[1]);
  const expected = failed.filter(n => A64_EXPECTED_FAILURES.includes(n.split(".")[0])), real = failed.filter(n => !expected.includes(n));
  const totals = r.out.split("\n").filter(l => /^guests: \d+ passed/.test(l));
  // without a totals line per configuration the runner did not get that far: not a pass
  const ran = totals.length >= 3;
  let note = totals.join(" | ");
  if (expected.length) note += `; expected failures: ${[...new Set(expected)].join(", ")}`;
  if (real.length) note += `; [RED] unexpected failures: ${[...new Set(real)].join(", ")}`;
  if (ran && !failed.length) note += `; no failures (the expected-failure list ${A64_EXPECTED_FAILURES.join(", ")} is not needed any more)`;
  return { ok: ran && real.length === 0 && (r.code === 0 || expected.length > 0), note };
});
step("rt:test", () => { const r = npm("rt:test"); return { ok: r.code === 0, note: last(r.out, /^rt:test/) }; });

console.log("\n===== summary =====");
for (const s of steps) console.log(`${s.ok ? "ok  " : "[RED] FAIL"} ${s.name.padEnd(12)} ${(s.ms / 1000).toFixed(1).padStart(6)} s  ${s.note}`);
const bad = steps.filter(s => !s.ok).length;
console.log(`\nnpm test: ${steps.length} areas, ${bad} failed`);
process.exit(bad ? 1 : 0);
