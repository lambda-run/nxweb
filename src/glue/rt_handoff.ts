// nxweb runtime glue: what the prepare step hands over (src/prepare/host/prepare.ts HandOffMessage) turned into the
// options of a process: the address-space layout and kernel settings from the profile, the take-over table's
// configuration, the main thread's stack size from the NPDM, and per module a hash of the code cuts that were
// applied to it (a cut module keeps its build id: the hash is part of the translation cache key).
import { settingsFor, type ProcessSettings } from "./rt_process.ts";

export interface HandoffLike {
  titleId: string; programId: string; name: string; displayVersion: string | null;
  profile: { id: string | null; provisional: boolean; apply: Record<string, string>; needs: { key: string; value: string; what: string }[];
    space?: { heap_region?: number; alias_region?: number; stack_region?: number } | null };
  npdm: { stackSize?: number } | null | undefined;
  modules: { name: string; buildId: string; cuts: number }[];
  cuts: { module: string; [k: string]: unknown }[];
}
export interface HandoffOptions extends ProcessSettings { programId: bigint; cutsKey: Record<string, string>; notes: string[] }
const fnv = (s: string) => { let h = 0xcbf29ce484222325n; for (let i = 0; i < s.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(s.charCodeAt(i))) * 0x100000001b3n); return h.toString(16).padStart(16, "0"); };
export function handoffOptions(m: HandoffLike): HandoffOptions {
  // the profile's reserved address space: its `space` record; a hand-off without one carries the regions only when
  // they do not fit, as "heap 0x... alias 0x..." (and stack) in its address_space need
  const need = m.profile.needs.find(n => n.key === "address_space")?.value ?? "";
  const part = (k: string) => { const x = new RegExp(k + " (0x[0-9a-fA-F]+|\\d+)").exec(need); return x ? Number(x[1]) : undefined; };
  const space = m.profile.space ?? (need ? { heap_region: part("heap"), alias_region: part("alias"), stack_region: part("stack") } : undefined);
  const s = settingsFor(m.profile.apply, { space, stackSize: m.npdm?.stackSize, displayVersion: m.displayVersion, programId: m.programId });
  const cutsKey: Record<string, string> = {};
  for (const mod of m.modules) {
    const mine = m.cuts.filter(c => c.module === mod.name);
    if (mine.length) cutsKey[mod.name] = fnv(JSON.stringify(mine));
  }
  const notes = [`profile ${m.profile.id ?? "none"}${m.profile.provisional ? " (provisional)" : ""}: layout ${s.layout.fit}` + (s.layout.note ? ": " + s.layout.note : ""),
    ...m.profile.needs.filter(n => n.key !== "address_space").map(n => `the profile also asks for ${n.key} = ${n.value}, which nxweb does not have: ${n.what}`)];
  return { ...s, programId: /^[0-9a-fA-F]{1,16}$/.test(m.programId) ? BigInt("0x" + m.programId) : 0n, cutsKey, notes };
}
