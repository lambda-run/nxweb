// Builds the runtime's test modules (clang aarch64 -> ld.lld -> tools/elf2nso.py, LZ4 compressed with hashes: the
// loader's toolchain and linker script) into build/runtime/guests, and loads everything a test run needs.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, OUT, build } from "../../src/runtime/host/build.mts";
import type { Env, CorpusGuest } from "./cases.ts";

export { ROOT, OUT, build };
export const GUESTS = join(OUT, "guests");
const SRC = join(ROOT, "test", "runtime", "src");
const CFLAGS = ["--target=aarch64-none-elf", "-fPIC", "-ffreestanding", "-nostdlib", "-O2", "-mcpu=cortex-a57", "-mno-outline-atomics",
  "-fvisibility=hidden", "-fsemantic-interposition", "-fno-asynchronous-unwind-tables", "-fno-unwind-tables", "-Wall", "-Wno-unused-parameter", "-Wno-unused-function"];
const LDFLAGS = ["-shared", "-z", "max-page-size=4096", "-z", "norelro", "--build-id=sha1", "--hash-style=both", "-T", join(ROOT, "test", "loader", "src", "module.ld")];
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });

// name -> source file and extra compiler flags
export const MODULES: Record<string, [src: string, ...flags: string[]]> = {
  hello: ["hello.c"], two_main: ["two_main.c"], two_lib: ["two_lib.c"], threads: ["threads.c"], race: ["race.c"], heap: ["heap.c"],
  host_main: ["host_main.c"], host_lib: ["host_lib.c"],
  fault_jump: ["fault.c", "-DMODE=1"], fault_undef: ["fault.c", "-DMODE=2"], fault_load: ["fault.c", "-DMODE=3"], fault_stack: ["fault.c", "-DMODE=4"], break: ["fault.c", "-DMODE=5"],
};

export function buildModules(): void {
  mkdirSync(GUESTS, { recursive: true });
  const o = (n: string) => join(GUESTS, n);
  run("clang", [...CFLAGS, "-c", join(SRC, "crt0.S"), "-o", o("crt0.o")]);
  run("clang", [...CFLAGS, "-c", join(SRC, "svc.S"), "-o", o("svc.o")]);
  for (const [name, [src, ...flags]] of Object.entries(MODULES)) {
    run("clang", [...CFLAGS, ...flags, "-c", join(SRC, src), "-o", o(name + ".o")]);
    run("ld.lld", [...LDFLAGS, o("crt0.o"), o(name + ".o"), o("svc.o"), "-o", o(name + ".so")]);
    run("python3", [join(ROOT, "tools", "elf2nso.py"), o(name + ".so"), o(name + ".nso"), "--lz4"]);
  }
}

export function corpusList(): string[] {
  const dir = join(ROOT, "test", "guests", "out");
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json") && f !== "manifest.json").sort().map(f => f.replace(/\.json$/, "")) : [];
}
export function loadEnv(): Env {
  const mod = (n: string) => new WebAssembly.Module(readFileSync(join(OUT, n + ".wasm")));
  const dir = join(ROOT, "test", "guests", "out");
  const corpus: CorpusGuest[] = corpusList().map(name => {
    const side = JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
    return { name, side, image: new Uint8Array(readFileSync(join(dir, side.image))), expected: new Uint8Array(readFileSync(join(dir, side.expected_stdout))) };
  });
  return {
    mods: { rt: mod("rt"), kernel: mod("kernel"), loader: mod("loader"), translator: mod("translator"), helpers: mod("helpers") },
    nso: name => new Uint8Array(readFileSync(join(GUESTS, name + ".nso"))),
    corpus,
    rssMb: () => process.memoryUsage().rss / 1e6,
  };
}
