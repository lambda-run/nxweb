// Browser worker for Gate 2: fetches the translator, the helpers and every guest from the local test
// server and runs them with the same core as the Node runner. Compile is synchronous, hence a Worker.
import { runGuest, defaultOpts, cacheKey, type Result } from "../guest_core.ts";
import { runExtraTests } from "../extra_tests.ts";
import { webCacheStore } from "../../../src/glue/a64_host.ts";

async function bytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ": " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
const mod = async (f: string) => new WebAssembly.Module(await bytes("/build/" + f));

self.onmessage = async (ev: MessageEvent) => {
  const post = (m: unknown) => (self as any).postMessage(m);
  try {
    const mods = { translator: await mod("translator.wasm"), helpers: await mod("helpers.wasm"),
                   translatorShared: await mod("translator.shared.wasm"), helpersShared: await mod("helpers.shared.wasm") };
    if (ev.data.extra) { post({ extra: runExtraTests(mods), done: true }); return; }
    const o = { ...defaultOpts, ...ev.data.opts };
    const store = ev.data.cache ? webCacheStore(ev.data.cache) : null;
    const list: { name: string; dir: number }[] = (await (await fetch("/list")).json()).filter((g: { name: string }) => !ev.data.only || new RegExp(ev.data.only).test(g.name));
    for (const g of list) {
      let r: Result;
      try {
        const side = JSON.parse(new TextDecoder().decode(await bytes(`/g/${g.dir}/${g.name}.json`)));
        const image = await bytes(`/g/${g.dir}/${side.image}`);
        const expected = await bytes(`/g/${g.dir}/${side.expected_stdout}`);
        const key = store ? await cacheKey(image, side, o) : "";
        const blob = store ? await store.get(key) : null;
        r = runGuest(o.shared ? mods.translatorShared : mods.translator, o.shared ? mods.helpersShared : mods.helpers, g.name, side, image, expected,
                     { ...o, cacheIn: blob, wantCache: !!store && !blob });
        if (store && !blob && r.cacheBlob && r.ok) await store.put(key, r.cacheBlob);
        r.cacheBlob = undefined;
      } catch (e) {
        r = { name: g.name, ok: false, why: "runner: " + String(e), insns: 0, runMs: 0, trMs: 0, trOnlyMs: 0, trInsns: 0, funcs: 0, bytes: 0, slices: 0, tableLen: 0 };
      }
      post({ result: r });
    }
    post({ done: true });
  } catch (e) {
    post({ fatal: String(e) });
  }
};
