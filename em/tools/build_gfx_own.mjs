// node em/tools/build_gfx_own.mjs: this tree's recorder (src/gfx) as em/build/gfxown/gfx64.wasm, built as
// src/gfx/host/build.mts builds it plus --debug (function names for profiles; the code is the same -O2), and copied
// beside the staged page as gfx64.own.wasm (the page's ?gfxown=1). Run `node src/gfx/host/build.mts` first when the
// NVN name table may be stale.
import { buildPair } from "../../tools/asc64/abi.mjs";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
mkdirSync("em/build/gfxown", { recursive: true });
buildPair("src/gfx/index.ts", "em/build/gfxown/gfx.wasm", ["--runtime", "stub", "-O2", "--debug", "--importMemory", "--memoryBase", "65536"]);
const dest = process.env.NXEM_SERVE ?? "/mnt/build/web/em-next";
if (existsSync(dest)) { copyFileSync("em/build/gfxown/gfx64.wasm", dest + "/gfx64.own.wasm"); console.log("gfx64.own.wasm -> " + dest); }
