// stdin: JSON array of instruction words -> stdout: JSON array of the words the translator rejects
// (the decoder's own answer, through the scanner: src/glue/a64_scan.ts; test/a64/coverage.py names them with Capstone)
import { readFileSync } from "node:fs";
import { A64Scanner } from "../../src/glue/a64_scan.ts";
const scanner = new A64Scanner(readFileSync(new URL("../../build/a64/translator.wasm", import.meta.url)));
const words: number[] = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify(words.filter(w => !scanner.implemented(w))));
