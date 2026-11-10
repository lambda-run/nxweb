// A directory as a PrepStore (Node): a blob is written beside its name and renamed into place.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PrepStore } from "./store.ts";

export class NodeStore implements PrepStore {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; mkdirSync(dir, { recursive: true }); }
  path(name: string): string { return join(this.dir, name); }
  async get(name: string): Promise<Uint8Array | null> { return existsSync(this.path(name)) ? new Uint8Array(readFileSync(this.path(name))) : null; }
  async put(name: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p + ".part", bytes); renameSync(p + ".part", p);
  }
  async remove(name: string): Promise<void> { rmSync(this.path(name), { force: true }); }
}
