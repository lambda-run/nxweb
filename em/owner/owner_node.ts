// nxem: the owner realm under Node (the boot harness, run_p4.sh): files and SHA-256 from Node, the game container by
// positional reads, saves in a directory, the null replayer.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NodeStorage } from "../../src/glue/fs_dev_node.ts";
import { NupTree } from "../../src/prepare/host/nup.ts";
import { nodeBytes } from "../../src/prepare/host/nup_node.ts";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { startOwner, sharedBuild, type Owner, type OwnerConfig } from "./owner.ts";

export async function start(memory: WebAssembly.Memory, malloc: (n: number) => number, log: (line: string) => void, modules: OwnerConfig["modules"]): Promise<Owner> {
  const e = process.env, rt = e.NX_RUNTIME ?? "/mnt/build/runtime", nup = e.NX_NUP ?? "/game/zelda-oot.nup", pages = memory.buffer.byteLength / 65536;
  const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const mod = (n: string) => new WebAssembly.Module(sharedBuild(readFileSync(`${rt}/${n}64.wasm`), pages) as unknown as BufferSource);
  const c: OwnerConfig = {
    tree: await NupTree.open(nodeBytes(nup), nup, { sha256, log }), prep: new PrepWasm(new WebAssembly.Module(readFileSync(e.NX_PREPARE ?? "/mnt/build/prepare/prepare.wasm")), log),
    fsModule: mod("fs"), gfxModule: mod("gfx"), saves: new NodeStorage({ saveDir: e.NX_SAVES ?? "/ctl/nxweb-em/em/build/saves" }),
    programId: BigInt(e.NX_PROGRAM_ID ?? "0x0400486024DEC000"), scratch: 0x1FF00000, malloc, modules, log,
  };
  return (await startOwner(memory, c)).owner;
}
