// dump_text.mts <exefs file (NSO)> <out>: the module's image as nxweb's loader lays it out at base 0x0800_0000
// (decompressed, relocated), for a disassembler: objdump -D -b binary -m aarch64 --adjust-vma=0 (offsets = module offsets).
import { readFileSync, writeFileSync } from "node:fs";
import { Loader } from "../../src/loader/host/loader.mts";
import { instantiate } from "../../src/glue/wasm_abi.ts";
import { STUBS, range } from "../../src/glue/rt_layout.ts";
const [inp, out] = process.argv.slice(2), file = readFileSync(inp), BASE = 0x08000000, FILE = 0x14000000;
const memory = new WebAssembly.Memory({ initial: 6400 }), pages = 6400;
const env = { memory, memory_size: () => pages, memory_grow: (n: number) => n ? -1 : pages, debug_string: () => {}, abort: () => { throw new Error("abort in the loader"); },
  log: (p: number, n: number) => console.log("[loader] " + new TextDecoder().decode(new Uint8Array(memory.buffer, p, n))) };
const lx: any = instantiate(new WebAssembly.Module(readFileSync(process.env.NX_LOADER ?? "/mnt/build/web/wasm/loader.wasm")), { env }, { name: "loader.wasm" });
if (!lx.memory) lx.memory = memory;
const arena = range("loader arena"), ld = new Loader(lx, { arena: arena.lo, arenaLen: arena.hi - arena.lo, stubBase: STUBS.base, stubCap: STUBS.cap });
new Uint8Array(memory.buffer).set(file, FILE);
const set = ld.loadSet([{ name: "main", ptr: FILE, len: file.length }], () => BASE, { verifyHash: false });
const m = set.modules[0];
console.log(`${m.name}: base 0x${m.base.toString(16)}, image 0x${m.imageSize.toString(16)}, text 0x${m.text.size.toString(16)}`);
writeFileSync(out, new Uint8Array(memory.buffer, m.base, m.text.size));
