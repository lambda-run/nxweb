// A process that runs the Doom guest (build/doom/doom.nso): graphics, the take-over table, input, and a file system
// whose RomFS holds the data file as rom:/doom1.wad (saves in memory unless a storage is given). No Node APIs: the
// Node tests and the page's Worker both use it. The guest calls doom_frame(gametic, pixels) before it draws a frame.
import { bootGfx, type GfxBoot, type GfxProcess } from "../runtime/gfx_cases.ts";
import type { Env } from "../runtime/cases.ts";
import { RtFs } from "../../src/glue/rt_fs.ts";
import { MemStorage, MemDevice, FS_KIND, type FsStorage } from "../../src/glue/fs_host.ts";
import { romfsImageOfFile } from "../../src/glue/fs_romfs_one.ts";

export const DOOM_W = 640, DOOM_H = 400;
// pixels: a view of guest memory (XRGB), valid during the call. gamestate: 0 level, 1 intermission, 2 finale, 3 title
// and attract screens; x, y: the player's map position; angle: 0..2^32
export interface DoomFrame { n: number; gametic: number; pixels: Uint32Array;
  gamestate: number; menu: boolean; demo: boolean; usergame: boolean; map: number; health: number; bullets: number; x: number; y: number; angle: number }
export interface DoomBoot extends Partial<GfxBoot> {
  storage?: FsStorage;                           // default: the data file as the rom device, saves in memory
  onFrame?: (f: DoomFrame) => boolean | void;    // true: the guest leaves (exit code 0)
  args?: string;                                 // more engine arguments, separated by spaces ("-timedemo demo1")
}
export interface DoomProcess extends GfxProcess { fs: RtFs; frames: number }
export function wadStorage(wad: Uint8Array): MemStorage {
  const st = new MemStorage();
  st.setImage(FS_KIND.ROM, 0, new MemDevice(romfsImageOfFile("doom1.wad", wad)));
  return st;
}
export async function bootDoom(env: Env, nso: Uint8Array, wad: Uint8Array | null, o: DoomBoot = {}): Promise<DoomProcess> {
  let d!: DoomProcess;
  const p = await bootGfx(env, [{ name: "doom", bytes: nso }], { frames: 0, ...o, setup: q => {
    const fs = new RtFs(q.rt, env.mods.fs!, o.storage ?? (wad ? wadStorage(wad) : new MemStorage()));
    d = Object.assign(q, { fs, frames: 0 });
    q.rt.register({ name: "doom_frame", fn: cpu => {
      const pixels = new Uint32Array(q.rt.memory.buffer, Number(cpu.x(1)), DOOM_W * DOOM_H), st = new Int32Array(q.rt.memory.buffer, Number(cpu.x(2)), 10), n = d.frames++;
      return o.onFrame?.({ n, gametic: cpu.w(0), pixels, gamestate: st[0], menu: !!st[1], demo: !!st[2], usergame: !!st[3], map: st[4], health: st[5], bullets: st[6], x: st[7], y: st[8], angle: st[9] >>> 0 }) ? 1 : 0;
    } });
    q.rt.register({ name: "doom_args", fn: cpu => {
      const b = new TextEncoder().encode(o.args ?? "").subarray(0, cpu.w(1));
      cpu.write(cpu.x(0), b);
      return b.length;
    } });
    o.setup?.(q);
  } });
  return Object.assign(d, p);
}
export function fnv(px: Uint32Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) { h ^= px[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
// How many different colours a frame has
export function colours(px: Uint32Array): number { return new Set(px).size; }
