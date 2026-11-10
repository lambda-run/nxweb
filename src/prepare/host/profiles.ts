// The converted game profiles (src/prepare/profiles/*.json, written by tools/prepare/convert_profiles.py from
// nxnative's dm/games): how the prepare step gets at them.
import type { Cut, MatchRule } from "./wasm.ts";
export interface ProfileBuild { version: number | null; tag: string; display: string; modules: Record<string, string> }
export interface ProfileNeed { key: string; value: string; what: string }
// A profile that is short in a 32-bit memory and fits a 64-bit one (rt_process.ts layoutChoice): the 64-bit layout's
// verdict and sizes, the most real memory the tab's linear memory may come to hold, and the sentence that says so
export interface Mem64Verdict { fit: "profile" | "pool"; heap: number; alias: number; stack: number; pool: number; real: number; sentence: string }
export interface ModuleCuts { module: string; cuts: Cut[] }
export interface Profile {
  source: string; title_id: string; name: string; builds: ProfileBuild[];
  apply: Record<string, string>;            // class a keys: handed to the runtime
  needs: ProfileNeed[];                     // class c keys: what will not work
  dropped: string[];                        // class b keys (names only)
  cuts: Record<string, ModuleCuts>;         // build id -> registered cuts
  match_cuts?: Record<string, MatchRule[]>; // module name -> function-matched rules, for builds with no registered cuts
  unconverted: { kind: string; [k: string]: unknown }[];
  patches?: { converted: boolean; reason: string };   // set when the patch file could not be evaluated by the converter
  // the regions the profile reserves; fit / note / layout: the verdict of the runtime's layout rule (rt_process.ts layoutFor)
  address_space?: { heap_region: number; alias_region: number; stack_region: number; fits?: boolean; fit?: "profile" | "pool" | "short"; note?: string; mem64?: Mem64Verdict; layout?: { heap: number; alias: number; stack: number; pool: number } };
  capabilities?: Record<string, string[]>;
}
export interface ProfileIndex { games: Record<string, { name: string; builds: number; needs: number; cuts: number }>; builds: Record<string, string>; sdk_builds: string[] }
export interface SdkCuts { source: string; cuts: Record<string, ModuleCuts>; match_cuts?: Record<string, MatchRule[]>; unconverted: unknown[] }
export interface ProfileSource {
  index(): Promise<ProfileIndex>;
  game(titleId: string): Promise<Profile | null>;
  sdk(): Promise<SdkCuts>;
}
// From a URL prefix (the page: "profiles/")
export function fetchProfiles(base: string): ProfileSource {
  const get = async (name: string) => { const r = await fetch(base + name); if (!r.ok) throw new Error(`${base}${name}: ${r.status}`); return r.json(); };
  let idx: Promise<ProfileIndex> | undefined;
  return {
    index: () => idx ??= get("index.json"),
    game: async id => (await (idx ??= get("index.json"))).games[id] ? get(id + ".json") : null,
    sdk: () => get("_sdk.json"),
  };
}
// From objects (tests)
export function memProfiles(games: Profile[], sdk: SdkCuts = { source: "test", cuts: {}, unconverted: [] }): ProfileSource {
  const index: ProfileIndex = { games: {}, builds: {}, sdk_builds: Object.keys(sdk.cuts) };
  for (const g of games) {
    index.games[g.title_id] = { name: g.name, builds: g.builds.length, needs: g.needs.length, cuts: Object.values(g.cuts).reduce((n, c) => n + c.cuts.length, 0) };
    for (const b of g.builds) if (b.modules.main) index.builds[b.modules.main] ??= g.title_id;
  }
  return { index: async () => index, game: async id => games.find(g => g.title_id === id) ?? null, sdk: async () => sdk };
}
