// The browser side of `npm run rt:browser`: a Worker (wasm compilation and the run loop are synchronous) that fetches
// the wasm modules, the test NSOs and the guest corpus from the test server and runs the same cases as Node.
import { runCases, type Env, type CorpusGuest } from "../cases.ts";

const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

self.onmessage = async (ev: MessageEvent) => {
  try {
    const list: { nso: string[]; corpus: string[] } = await (await fetch("/list")).json();
    const mod = async (n: string) => WebAssembly.compile(await bytes(`/wasm/${n}.wasm`));
    const [rt, kernel, loader, translator, helpers] = await Promise.all(["rt", "kernel", "loader", "translator", "helpers"].map(mod));
    const nso = new Map<string, Uint8Array>();
    await Promise.all(list.nso.map(async n => { nso.set(n, await bytes(`/nso/${n}.nso`)); }));
    const corpus: CorpusGuest[] = await Promise.all(list.corpus.map(async name => {
      const side = await (await fetch(`/corpus/${name}.json`)).json();
      return { name, side, image: await bytes(`/corpus/${side.image}`), expected: await bytes(`/corpus/${side.expected_stdout}`) };
    }));
    const env: Env = { mods: { rt, kernel, loader, translator, helpers }, nso: n => nso.get(n) ?? (() => { throw new Error("no NSO " + n); })(), corpus };
    runCases(env, ev.data.only, r => (self as any).postMessage({ result: r }));
    (self as any).postMessage({ done: true, isolated: (self as any).crossOriginIsolated, sab: typeof SharedArrayBuffer !== "undefined" });
  } catch (e) {
    (self as any).postMessage({ done: true, fatal: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
};
