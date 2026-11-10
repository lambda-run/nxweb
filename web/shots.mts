// `npm run web:shots`: screenshots of the page as a person first sees it, in headless Chromium (launched as the
// browser tests launch it) at deviceScaleFactor 2, into build/web-shots/:
//   landing.png          the page as it opens
//   verdict-memory.png   after choosing a synthetic .nup whose title has a profile that does not fit a tab's memory
//   landing-phone.png, verdict-phone.png   the same at phone width (390 px)
// The .nup is written here (test/prepare/nup_synth.mts: the runtime's test guest as its code; nothing from a game).
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "../src/prepare/host/build.mts";
import { buildWeb } from "./build.mts";
import { serve } from "./serve.mts";
import { version } from "../test/prepare/synth.mts";
import { writeNup, tlv, nacp, KIND, T } from "../test/prepare/nup_synth.mts";

process.chdir(ROOT);
const OUT = join(ROOT, "build", "web-shots");
mkdirSync(OUT, { recursive: true });
if (!process.argv.includes("--no-build")) await buildWeb();
// a title whose converted profile reserves a 9 GB pool (src/prepare/profiles/report.json, address_space "short")
const SHORT = 0x0400A3A01EE4C000n;
const v = version({ programId: SHORT });
const parts = (prefix: string) => Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith(prefix)).map(([k, x]) => [k.slice(prefix.length), x]));
// the container's icon: a 64x64 PNG written here (a disc on a dark ground)
const png = (() => {
  const { deflateSync, crc32 } = createRequire(import.meta.url)("node:zlib");
  const W = 64, raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3, d = Math.hypot(x - 32, y - 32) < 20; raw[o] = d ? 0x6c : 0x1f; raw[o + 1] = d ? 0xb6 : 0x29; raw[o + 2] = d ? 0xff : 0x3d; }
  const chunk = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, "latin1"); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)) >>> 0, 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
})();
const nupPath = join(OUT, "Synthetic Test Game.nup");
writeFileSync(nupPath, writeNup([{ kind: KIND.base, titleId: SHORT, exefs: parts("exefs/"), romfs: parts("romfs/"), meta: tlv([[T.NACP, nacp("Synthetic Test Game", "", "1.0.0", "nxweb tests")], [T.ICON, png]]) }]).bytes);

const { chromium } = createRequire(import.meta.url)("playwright");
const channel = process.env.RT_BROWSER_CHANNEL ?? "chromium";
const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }), args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-vulkan=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const web = await serve(0);
let failed = false;
try {
  for (const [tag, viewport] of [["", { width: 1180, height: 900 }], ["-phone", { width: 390, height: 844 }]] as const) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 }), page = await ctx.newPage();
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(web.url);
    const fr = page.frameLocator("#prepare");
    await fr.locator("#pickfile").waitFor({ state: "visible" });
    await page.waitForFunction(() => (document.getElementById("prepare") as HTMLIFrameElement).contentWindow && (document.getElementById("prepare") as any).contentWindow.nxwebPrepareReady === true);
    await page.waitForTimeout(400);
    const landing = join(OUT, `landing${tag}.png`);
    await page.screenshot({ path: landing, fullPage: tag !== "" });
    await fr.locator("#fileinput").setInputFiles(nupPath);
    await fr.locator('#verdict[data-level="no"]').waitFor({ state: "visible", timeout: 60000 });
    await fr.locator("#gameicon").waitFor({ state: "visible" });
    await fr.locator("#play:not([disabled])").waitFor({ timeout: 60000 });
    await page.waitForTimeout(400);
    const verdict = join(OUT, tag ? "verdict-phone.png" : "verdict-memory.png");
    await page.screenshot({ path: verdict, fullPage: tag !== "" });
    const scroll = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    const text = (await fr.locator("#verdictline").textContent())!.trim();
    console.log(`${viewport.width}x${viewport.height}: ${landing}, ${verdict}\n   verdict: ${JSON.stringify(text)}; page scroll width ${scroll.w} of ${scroll.c}${scroll.w > scroll.c ? " [RED] horizontal scroll" : ""}${errors.length ? " [RED] page errors: " + errors.join(" | ") : ""}`);
    if (scroll.w > scroll.c || errors.length) failed = true;
    await ctx.close();
  }
} finally { await browser.close(); web.server.close(); rmSync(nupPath, { force: true }); }
process.exit(failed ? 1 : 0);
