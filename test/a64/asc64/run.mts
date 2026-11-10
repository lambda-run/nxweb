// `npm run a64:asc64`: the wasm64 build tool (tools/asc64) against the stock compiler. probe_std.ts is compiled for
// wasm32 with asc and for wasm64 with asc64; both run, and every export must return the same value. The wasm64
// module runs on a 64-bit memory with its heap and every raw pointer above 4 GB, so a pointer cut to 32 bits
// anywhere (the compiler, the standard library, the runtime) reads or writes around HIGH - 4 GB instead: the two
// results differ, or the canary range there is no longer zero.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeMemory64, hasMemory64 } from "../../../src/glue/a64_host.ts";
// @ts-ignore: a plain module
import { asc64, inspect } from "../../../tools/asc64/asc64.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = join("build", "a64", "asc64");
const BASE = 0x10_0000;                       // static data of both builds
const HIGH = 0x1_8000_0000;                   // the wasm64 module's heap and raw pointers
const HEAP_BYTES = 64 << 20, RAW = HIGH + HEAP_BYTES;
const LOW32 = 0x20_0000;                      // raw pointers of the wasm32 module
let bad = 0, checks = 0;
const brief = process.argv.includes("--brief");   // names only; details of the failures
const check = (name: string, ok: boolean, detail: string) => { console.log(`${ok ? "ok  " : "[RED] FAIL"} ${name}` + (brief && ok ? "" : `\n       ${detail}`)); checks++; if (!ok) bad++; };

if (!hasMemory64()) { console.log("[RED] a64 asc64: this engine has no 64-bit memories (Node 22.23 has; older: --experimental-wasm-memory64)"); process.exit(1); }
mkdirSync(join(ROOT, OUT), { recursive: true });
process.chdir(ROOT);
const common = ["test/a64/asc64/probe_std.ts", "-O2", "--runtime", "stub", "--importMemory", "--memoryBase", String(BASE)];
execFileSync(process.execPath, [join("node_modules", "assemblyscript", "bin", "asc.js"), ...common, "-o", join(OUT, "std32.wasm")], { stdio: "inherit" });
await asc64([...common, "-o", join(OUT, "std64.wasm")]);
const b32 = readFileSync(join(OUT, "std32.wasm")), b64 = readFileSync(join(OUT, "std64.wasm"));
const i32 = inspect(new Uint8Array(b32)), i64 = inspect(new Uint8Array(b64));
check("the two builds: one memory each, 32-bit and 64-bit", i32.memories.length === 1 && i32.memories[0].flags === 0 && i64.memories.length === 1 && (i64.memories[0].flags & 4) === 4 && !i64.usesSizeOrGrow,
  `std32.wasm ${b32.length} B (limits flags 0x${i32.memories[0]?.flags.toString(16)}), std64.wasm ${b64.length} B (limits flags 0x${i64.memories[0]?.flags.toString(16)}, no memory.size / memory.grow instruction)`);

const abort = () => { throw new Error("abort"); };
const m32 = new WebAssembly.Memory({ initial: 64, maximum: 1024 });
const x32: any = new WebAssembly.Instance(new WebAssembly.Module(b32), { env: { memory: m32, abort } }).exports;
const mem = makeMemory64({ initial: Math.ceil((RAW + (16 << 20)) / 65536) });
const x64: any = new WebAssembly.Instance(new WebAssembly.Module(b64), { env: { memory: mem.memory, abort, ...mem.imports() } }).exports;
check("pointer width", x32.ptrBits() === 32 && x64.ptrBits() === 64, `wasm32 usize ${x32.ptrBits()} bits, wasm64 usize ${x64.ptrBits()} bits; the 64-bit memory is ${(mem.memory.buffer.byteLength / 2 ** 30).toFixed(2)} GB`);
x64.setHeap(BigInt(HIGH), BigInt(HIGH + HEAP_BYTES));
const first = Number(x64.addressOf(1));
check("the wasm64 heap is above 4 GB", first >= HIGH && first < HIGH + HEAP_BYTES, `the first object is at 0x${first.toString(16)}`);

// [export, arguments for wasm32, arguments for wasm64]: results must be equal (BigInt against number compared by value)
const P32 = LOW32, P64 = BigInt(RAW);
const cases: [string, unknown[], unknown[]][] = [
  ["classesAndLists", [500], [500]], ["arrays", [200], [200]], ["strings", [40], [40]], ["maps", [300], [300]], ["funcRefs", [7], [7]], ["funcRefs", [8], [8]],
  ["generics", [5], [5]], ["math", [1234.5], [1234.5]], ["nullable", [5], [5]], ["nullable", [0], [0]], ["nonNull", [3], [3]],
  ["rawMemory", [P32, 4096], [P64, 4096n]], ["pointerRound", [P32 + 0x10000], [P64 + 0x10000n]], ["staticData", [], []], ["growMemory", [2], [2]],
];
const same = (a: unknown, b: unknown) => typeof a === "bigint" || typeof b === "bigint" ? BigInt.asUintN(64, BigInt(a as any)) === BigInt.asUintN(64, BigInt(b as any)) : Object.is(a, b);
for (const [name, a32, a64] of cases) {
  let r32: unknown, r64: unknown, err = "";
  try { r32 = x32[name](...a32); r64 = x64[name](...a64); } catch (e) { err = String(e); }
  check(`${name}(${a32.join(", ")})`, !err && same(r32, r64), err || `wasm32 ${r32}, wasm64 ${r64}`);
}
// the non-null assertion on null must abort in both (the i64 condition the tool repairs)
{
  let t32 = false, t64 = false;
  try { x32.nonNull(0); } catch { t32 = true; }
  try { x64.nonNull(0); } catch { t64 = true; }
  check("x! on null aborts", t32 && t64, `wasm32 ${t32 ? "aborted" : "returned"}, wasm64 ${t64 ? "aborted" : "returned"}`);
}
// where the wasm64 module put things
{
  const end = Number(x64.heapAt());
  const u8 = new Uint8Array(mem.memory.buffer);
  const used = end - HIGH;
  // a pointer cut to 32 bits would have landed 4 GB lower: [HIGH - 4 GB, RAW + 1 MB - 4 GB) must still be zero
  const lo = HIGH - 0x1_0000_0000, hi = RAW + (1 << 20) - 0x1_0000_0000;
  let dirty = -1;
  for (let a = lo; a < hi; a++) if (u8[a]) { dirty = a; break; }
  const raw = new DataView(mem.memory.buffer).getBigUint64(RAW + 2 * 4096, true);
  check("the wasm64 run allocated and wrote above 4 GB only", used > 50_000 && end <= HIGH + HEAP_BYTES && dirty < 0 && raw === 0x0123456789ABCDEFn,
    `heap 0x${HIGH.toString(16)} .. 0x${end.toString(16)} (${used} bytes of objects, strings, arrays, maps), the raw store read back from 0x${(RAW + 8192).toString(16)}; ` +
    (dirty < 0 ? `0x${lo.toString(16)} .. 0x${hi.toString(16)} (the same addresses cut to 32 bits) untouched` : `[RED] a byte at 0x${dirty.toString(16)}: a truncated pointer`));
  // the heap's end is enforced
  x64.setHeap(BigInt(HIGH), BigInt(HIGH + 4096));
  let trapped = false;
  try { x64.arrays(5000); } catch { trapped = true; }
  check("an allocation beyond the heap's end traps", trapped, trapped ? "arrays(5000) with a 4 KB heap: trap" : "no trap");
}
// what the tool refuses
for (const [what, args] of [["--runtime incremental", [...common.slice(0, 2), "--runtime", "incremental", "-o", join(OUT, "no.wasm")]], ["--memoryBase above 4 GB", [...common.slice(0, 4), "--memoryBase", String(HIGH), "-o", join(OUT, "no.wasm")]]] as [string, string[]][]) {
  let msg = "";
  try { await asc64(args, { stdout: { write: () => true }, stderr: { write: () => true } }); } catch (e) { msg = (e as Error).message; }
  check(`asc64 refuses ${what}`, msg.startsWith("asc64:"), msg.slice(0, 160) || "it compiled");
}
console.log(`a64 asc64: ${checks - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
