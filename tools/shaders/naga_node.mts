// naga for the Node tools: the WebAssembly module from build/shaders (npm run shaders:naga builds it)
import { readFile } from "node:fs/promises";
import { instantiate, type Naga } from "./naga.mts";
export async function load(path: string | URL = new URL("../../build/shaders/nx_naga.wasm", import.meta.url)): Promise<Naga> {
  let bytes;
  try { bytes = await readFile(path); } catch { throw new Error(`${path} is missing: run "npm run shaders:naga" (cargo with the wasm32-unknown-unknown target)`); }
  return instantiate(bytes);
}
