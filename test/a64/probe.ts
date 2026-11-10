// stdin: JSON array of instruction words -> stdout: JSON array of the words the translator rejects
import { readFileSync } from "node:fs";
const tr: any = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../../build/a64/translator.wasm", import.meta.url))),
  { env: { abort: () => { throw new Error("abort"); } } }).exports;
tr.init(); tr.codeBuf(4096); tr.setCode(0x8000000n, 4096);
const words: number[] = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify(words.filter(w => !tr.probe(w))));
