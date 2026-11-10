// Browser worker for Gate 2: fetches the translator, the helpers and every guest from the local test
// server and runs them with the same core as the Node runner. Compile is synchronous, hence a Worker.
import { runGuest, defaultOpts, type Result } from "../guest_core.ts";

async function bytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ": " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

self.onmessage = async (ev: MessageEvent) => {
  const o = { ...defaultOpts, ...ev.data.opts };
  try {
    const translator = new WebAssembly.Module(await bytes("/build/translator.wasm"));
    const helpers = new WebAssembly.Module(await bytes("/build/helpers.wasm"));
    const list: { name: string; dir: number }[] = await (await fetch("/list")).json();
    for (const g of list) {
      let r: Result;
      try {
        const side = JSON.parse(new TextDecoder().decode(await bytes(`/g/${g.dir}/${g.name}.json`)));
        const image = await bytes(`/g/${g.dir}/${side.image}`);
        const expected = await bytes(`/g/${g.dir}/${side.expected_stdout}`);
        r = runGuest(translator, helpers, g.name, side, image, expected, o);
      } catch (e) {
        r = { name: g.name, ok: false, why: "runner: " + String(e), insns: 0, runMs: 0, trMs: 0, trOnlyMs: 0, trInsns: 0, funcs: 0, bytes: 0, slices: 0, tableLen: 0 };
      }
      (self as any).postMessage({ result: r });
    }
    (self as any).postMessage({ done: true, isolated: (self as any).crossOriginIsolated });
  } catch (e) {
    (self as any).postMessage({ fatal: String(e) });
  }
};
