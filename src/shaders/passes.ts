// Versions of the SPIR-V pass's rewrites (src/shaders/spv.ts), so that a narrow change of one rewrite invalidates only the stored translations it touched.
// The shader chain (src/glue/rt_shaders.ts SHADER_CHAIN) versions everything else: the translator, naga, the wrappers and the pass's steps that are not here;
// a change there still bumps the chain, and with it every stored translation.
// Each rewrite here has [version, trigger]:
//   version  bump it for any change of what the rewrite writes. Stored translations of the stages it rewrote are made again; the others are kept
//   trigger  bump it too when the change makes it rewrite stages it left alone before (a wider set of opcodes, a new case): then every stage is made again,
//            since a stage it did not touch may now need it
// fixForWgsl reports the rewrites that changed a stage; convertStage stamps them into the reflection record (`passes`): { fired: name -> "v.t",
// quiet: name -> t } for every rewrite here. A translation is current when each rewrite that fired has its version and trigger, and each quiet one its
// trigger. A record with no stamp was made before these versions existed: it is current while every rewrite is at its first version.
// History: intSigns 2.2 (chain 15): it read the type of only loaded and constant operands, so most operands (other instructions' results) kept naga's
// signedness; now every operand's.
// No Node or DOM API.
export const PASSES: Record<string, [number, number]> = {
  subgroups: [1, 1], nanTests: [1, 1], nonFiniteConstants: [1, 1], mulExtended: [1, 1], intSigns: [2, 2], privatizeBoundSizes: [1, 1],
  helperInvocation: [1, 1], arrayedFetchTypes: [1, 1], sizeQueryPast: [1, 1], queryLod: [1, 1], imageAtomics: [1, 1],
  gmemUntraced: [1, 1],
};
// Rewrites added after translations were stored: a stamp without them is current when the stage could not have needed them (they are made again otherwise).
// gmemUntraced (addresses read from a table in a uniform slot; the miss log) can only change a stage that had accesses the pass could not follow
const ADDED: Record<string, (r: { gmem?: { untraced?: number } }) => boolean> = { gmemUntraced: r => !r.gmem?.untraced };
export interface PassStamp { fired: Record<string, string>; quiet: Record<string, number> }
export function passStamp(fired: Iterable<string>): PassStamp {
  const f = new Set(fired), s: PassStamp = { fired: {}, quiet: {} };
  for (const [n, [v, t]] of Object.entries(PASSES)) { if (f.has(n)) s.fired[n] = `${v}.${t}`; else s.quiet[n] = t; }
  return s;
}
const initial = () => Object.values(PASSES).every(([v, t]) => v === 1 && t === 1);
const table = () => Object.fromEntries(Object.entries(PASSES).map(([n, [v, t]]) => [n, `${v}.${t}`]));
// A failure is kept only while no rewrite changed at all (which rewrite made it fail is not known): its stamp is the whole table
export interface FailureStamp { table: Record<string, string> }
export const failureStamp = (): FailureStamp => ({ table: table() });
// a stored translation ({ wgsl, reflection } or { failed, passes }) is still what the current pass makes of its stage
export function translationCurrent(t: { reflection?: { passes?: PassStamp } | null; failed?: string; passes?: FailureStamp } | null | undefined): boolean {
  if (!t) return false;
  if (t.failed) { if (!t.passes) return initial(); const now = Object.entries(table()).filter(([n]) => n in t.passes!.table || !ADDED[n]); return now.length === Object.keys(t.passes.table).length && now.every(([n, x]) => t.passes!.table[n] === x); }
  const s = t.reflection?.passes;
  if (!s) return initial();
  for (const [n, [v, tr]] of Object.entries(PASSES)) {
    if (n in s.fired) { if (s.fired[n] !== `${v}.${tr}`) return false; }
    else if (!(n in s.quiet) && ADDED[n]) { if (!ADDED[n](t.reflection as any)) return false; }
    else if (s.quiet[n] !== tr) return false;
  }
  return true;
}
export const packEntryCurrent = translationCurrent;
// the pack's folder for a chain ("nxweb-shaders-15/page+subgroups" -> "nxweb-shaders-15_page+subgroups")
export const packDir = (chain: string) => chain.replace(/[^A-Za-z0-9.+-]/g, "_");
