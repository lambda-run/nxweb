// npm run doom:browser: the page (web/index.html) runs Doom in headless Chromium with WebGPU on SwiftShader, driven as
// a person would: the Doom button, the keyboard, and once more with the data file chosen in the page instead of
// taken from the build. Skipped (exit code 0) without the engine or the data file (DOOMGENERIC, DOOM_WAD).
// The picture of the running game is saved as build/doom/doom.png and copied to docs/images/doom-demo.png.
import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { ROOT } from "../runtime/harness.mts";
import { doomSkip, doomWad, DOOM_OUT } from "./harness.mts";

process.chdir(ROOT);
const why = doomSkip(true);
if (why) { console.log(`doom:browser: SKIPPED, ${why}`); process.exit(0); }
const { buildWeb } = await import("../../web/build.mts"), { serve } = await import("../../web/serve.mts");
try { await buildWeb(); } catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] doom:browser: the build failed"); process.exit(1); }
mkdirSync(DOOM_OUT, { recursive: true });

// The pixels of a PNG as Playwright writes them (8 bits per channel, RGB or RGBA, not interlaced)
function decodePng(png: Buffer): { width: number; height: number; channels: number; data: Uint8Array } {
  let at = 8, width = 0, height = 0, channels = 0; const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at), type = png.toString("ascii", at + 4, at + 8), body = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0; if (body[8] !== 8 || !channels || body[12]) throw new Error("png: not 8-bit RGB(A), or interlaced"); }
    if (type === "IDAT") idat.push(body);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[dst + x - channels] : 0, b = y ? data[dst + x - stride] : 0, c = x >= channels && y ? data[dst + x - stride - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      data[dst + x] = raw[src + x] + (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
  }
  return { width, height, channels, data };
}
interface Picture { colours: number; black: number; hash: string; png: Buffer; width: number; height: number; middle: number; side: number }

const { chromium } = createRequire(import.meta.url)("playwright");
const channel = process.env.RT_BROWSER_CHANNEL ?? "chromium";
const GPU_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-vulkan=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }), args: GPU_ARGS });
const web = await serve(0);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let failed = 0, ran = 0;

async function session(name: string, fn: (q: any, h: { text: (id: string) => Promise<string>; until: (what: string, f: () => Promise<boolean>, tries?: number) => Promise<void>; frames: () => Promise<number>; picture: () => Promise<Picture>; key: (k: string, ms?: number) => Promise<void> }) => Promise<string[]>) {
  ran++;
  const t0 = Date.now(), q = await browser.newPage({ viewport: { width: 1180, height: 1000 } }), errors: string[] = [];
  q.on("pageerror", (e: Error) => errors.push(e.message));
  const text = (id: string) => q.textContent("#" + id) as Promise<string>;
  const until = async (what: string, f: () => Promise<boolean>, tries = 300) => { for (let i = 0; i < tries; i++) { if (await f()) return; await sleep(100); } throw new Error("timed out waiting for " + what + "; state " + await text("state") + ", frames " + await text("frames") + ", log: " + (await text("log")).slice(-1500)); };
  const frames = async () => Number((await text("frames")).split(",")[0]) || 0;
  const picture = async (): Promise<Picture> => {
    const png: Buffer = await q.locator("#canvas").screenshot(), img = decodePng(png), seen = new Set<number>();
    let black = 0, h = 0x811c9dc5, middle = 0, side = 0;
    for (let i = 0, n = 0; i < img.data.length; i += img.channels, n++) {
      const v = img.data[i] << 16 | img.data[i + 1] << 8 | img.data[i + 2];
      seen.add(v); if (!v) black++; h = Math.imul(h ^ v, 0x01000193);
      const x = n % img.width;
      if (v) { if (x < img.width * 0.11 || x >= img.width * 0.89) side++; else if (x > img.width * 0.14 && x < img.width * 0.86) middle++; }
    }
    return { colours: seen.size, black, hash: (h >>> 0).toString(16), png, width: img.width, height: img.height, middle, side };
  };
  const key = async (k: string, ms = 120) => { await q.keyboard.down(k); await sleep(ms); await q.keyboard.up(k); await sleep(250); };
  try {
    const info = await fn(q, { text, until, frames, picture, key });
    const red = await q.locator("#log .red").allTextContents();
    if (red.length) throw new Error("red lines: " + red.join(" | "));
    if (errors.length) throw new Error("page errors: " + errors.join(" | "));
    console.log(`ok   ${name} (${Date.now() - t0} ms)`); for (const l of info) console.log("       " + l);
  } catch (e) {
    failed++; console.log(`[RED] FAIL ${name}\n${e instanceof Error ? e.message : e}`);
    try { await q.screenshot({ path: join(DOOM_OUT, "failed.png") }); } catch { /* the page is gone */ }
  } finally { await q.close(); }
}

try {
  await session("doom page: the Doom button runs the game on the WebGPU canvas; title, menu and a new game by keyboard; frames advance at the game's rate; no red line", async (q, { text, until, frames, picture, key }) => {
    await q.goto(web.url);
    await until("the Doom button", async () => !(await q.isDisabled("#demodoom")), 100);
    if (!/data file is in this build/.test(await text("doomnote"))) throw new Error("the note under the buttons: " + await text("doomnote"));
    const t0 = Date.now();
    await q.click("#demodoom");
    await until("the first frame", async () => await frames() >= 1);
    const boot = Date.now() - t0;
    await until("Running with 15 frames", async () => await text("state") === "Running" && await frames() >= 15);
    const title = await picture();
    if (title.width < 900) throw new Error(`the canvas is ${title.width} px wide: the page did not give the game the full width`);
    if (title.colours < 150) throw new Error(`the title picture has ${title.colours} colours`);
    if (title.side > title.middle / 200) throw new Error(`the picture is not a 4:3 rectangle in the middle (${title.side} lit pixels in the side bars, ${title.middle} in the middle)`);
    // The rate while the title stands (tics 1 to 170; the wipe after it draws frames without tics): the game's clock
    // is 35 tics per second whatever the machine does, and it draws one frame per tic on a machine that keeps up.
    // This machine is shared with other jobs and SwiftShader draws on the CPU, so only a floor is asked of the frames.
    // The page's figures are a quarter of a second old when they are read: the bounds allow for that.
    const tic = async () => Number(/tic (\d+)/.exec(await text("doomstate"))?.[1] ?? NaN);
    await until("the game's tic count", async () => await tic() > 0);
    const f0 = await frames(), c0 = await tic(), w0 = Date.now();
    await until("tic 150", async () => await tic() >= 150);
    const secs = (Date.now() - w0) / 1000, fps = (await frames() - f0) / secs, tps = (await tic() - c0) / secs, split = await text("split"), ips = await text("ips");
    if (!(tps > 27 && tps < 43)) throw new Error(`${tps.toFixed(1)} tics per second over ${secs.toFixed(1)} s from tic ${c0}: the game's clock runs at 35`);
    if (fps < 8 || fps > 43) throw new Error(`${fps.toFixed(1)} frames per second (${tps.toFixed(1)} tics per second): the game draws one frame per tic when the machine keeps up`);
    // what the game says of itself (the guest reports it with every frame; the page shows it)
    const game = async () => { const t = await text("doomstate"), m = /tic (\d+): (\w[\w ]*?)(?:, map (\d+), health (-?\d+), bullets (\d+), at (-?\d+)\/(-?\d+), angle (\d+))?(, menu up)?$/.exec(t); if (!m) throw new Error("the Doom line of the page: " + t); return { what: m[2], map: Number(m[3]), health: Number(m[4]), bullets: Number(m[5]), x: Number(m[6]), y: Number(m[7]), angle: Number(m[8]), menu: !!m[9], text: t }; };
    // Enter: the menu comes up over the title or the attract demo. Pressed and released inside one task, as the
    // quickest tap: both key events reach the game, and the press is latched for its next read of the pad
    await q.evaluate(() => { for (const type of ["keydown", "keyup"]) window.dispatchEvent(new KeyboardEvent(type, { code: "Enter", key: "Enter", bubbles: true })); });
    await until("the menu", async () => (await game()).menu, 200);   // after the wipe from the title to the demo, when the key fell into it
    const menu = await picture();
    if (menu.hash === title.hash) throw new Error("the picture did not change after Enter (the menu)");
    // New Game, the episode, the skill
    await key("Enter"); await key("Enter"); await key("Enter");
    await until("a new game on map 1", async () => { const g = await game(); return g.what === "game" && g.map === 1 && !g.menu; }, 200);
    await sleep(1500);   // the screen melts into the level
    const start = await game(), level = await picture();
    if (start.health !== 100 || start.bullets !== 50) throw new Error("the new game: " + start.text);
    if (level.hash === menu.hash || level.hash === title.hash || level.colours < 60) throw new Error(`no level picture after starting a new game (${level.colours} colours)`);
    await q.keyboard.down("ArrowUp"); await sleep(900); await q.keyboard.up("ArrowUp");
    await sleep(600);
    const walked = await game(), dist = Math.hypot(walked.x - start.x, walked.y - start.y);
    if (dist < 100) throw new Error(`ArrowUp did not walk the player forward: ${start.text} -> ${walked.text}`);
    await key("KeyZ", 200);
    await until("a shot", async () => (await game()).bullets < 50, 100);
    await q.keyboard.down("ArrowRight"); await sleep(350); await q.keyboard.up("ArrowRight");
    await sleep(400);
    const turned = await game(), moved = await picture();
    if (turned.angle === walked.angle) throw new Error(`ArrowRight did not turn the player: ${walked.text} -> ${turned.text}`);
    if (moved.hash === level.hash) throw new Error("the picture did not change after walking, firing and turning");
    writeFileSync(join(DOOM_OUT, "doom.png"), moved.png);
    writeFileSync(join(DOOM_OUT, "title.png"), title.png);
    await q.screenshot({ path: join(DOOM_OUT, "page.png") });
    mkdirSync(join(ROOT, "docs", "images"), { recursive: true });
    copyFileSync(join(DOOM_OUT, "doom.png"), join(ROOT, "docs", "images", "doom-demo.png"));
    const more = await text("more"), state = await text("state"), f1 = await frames();
    if (state !== "Running") throw new Error("the process is " + state);
    await q.click("#stop");
    await until("Stopped", async () => await text("state") === "Stopped");
    return [`first frame ${boot} ms after the click (modules fetched, translated on first use); ${fps.toFixed(1)} frames and ${tps.toFixed(1)} tics per second; ${f1} frames in all`,
      `per frame: ${split}`, `guest instructions per second: ${ips}`,
      `new game by keyboard: ${start.text}; walked ${dist.toFixed(0)} map units, fired (bullets ${turned.bullets}), turned to ${turned.angle} degrees`,
      `canvas picture ${title.width}x${title.height}: title ${title.colours} colours, menu ${menu.colours}, level ${level.colours}, after walking, firing and turning ${moved.colours}; saved as build/doom/doom.png (and docs/images/doom-demo.png)`,
      more];
  });
  await session("doom page: a build without the data file asks for it; the file chosen in the page becomes the guest's RomFS", async (q, { text, until, frames, picture }) => {
    // the same build, told that it has no data file
    await q.route("**/demo/doom.json", (r: any) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ present: true, wad: false }) }));
    await q.route("**/demo/doom1.wad", (r: any) => r.fulfill({ status: 404, body: "not found" }));
    await q.goto(web.url);
    await until("the Doom button", async () => !(await q.isDisabled("#demodoom")), 100);
    if (!/choose doom1\.wad/.test(await text("doomnote"))) throw new Error("the note under the buttons: " + await text("doomnote"));
    const chooser = q.waitForEvent("filechooser");
    await q.click("#demodoom");                    // no data file: the button opens the file dialog
    await (await chooser).setFiles(doomWad()!);    // choosing the file starts the game
    await until("Running with 40 frames", async () => await text("state") === "Running" && await frames() >= 40);
    const title = await picture();
    if (title.colours < 150) throw new Error(`the title picture has ${title.colours} colours`);
    const more = await text("more");
    if (!/rom device \d+ bytes/.test(more)) throw new Error("the file-system note: " + more);
    return [`title picture with ${title.colours} colours from the chosen file; ${more.split("; ").filter((s: string) => /rom device|saves/.test(s)).join("; ")}`];
  });
} finally {
  await browser.close();
  web.server.close();
}
console.log(`\ndoom:browser: ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
