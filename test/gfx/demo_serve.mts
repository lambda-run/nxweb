// npm run gfx:demo: builds, serves the tree on localhost and prints the demo's address (a browser with WebGPU).
import { buildWasm, ROOT } from "./harness.mts";
import { bundle, serve } from "./browser.mts";
process.chdir(ROOT);
buildWasm(); bundle();
const { url } = await serve(Number(process.env.PORT ?? 8787));
console.log(`gfx:demo: open ${url}/test/gfx/demo.html   (scenes: ${url}/test/gfx/test.html)   Ctrl-C to stop`);
