// node web/cache_dump.mjs [list|dump]: nxweb's translation cache (Cache API "nxweb-a64" of http://localhost:8080 in the
// headless profile) listed, or copied to /ctl/nxweb-em/em/build/web/put/ through web/serve.mjs (which must be running).
// Reads the profile through a browser; writes nothing into it. Do not run while another headless run uses the profile.
import { launch, evaluate } from "/ctl/headless/cdp.mjs";
const mode = process.argv[2] ?? "list";
const { child, cdp } = await launch({ profile: process.env.PROFILE ?? "/ctl/headless/profile", port: 9445, log: "/ctl/nxweb-em/em/logs/cache-chromium.log" });
try {
  const { targetId } = await cdp.send("Target.createTarget", { url: "http://localhost:8080/favicon.ico" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await new Promise(r => setTimeout(r, 1500));
  const out = await evaluate(cdp, sessionId, `(async () => {
    const names = await caches.keys(), rows = [];
    for (const name of names) { if (name !== "nxweb-a64") { rows.push({ cache: name, entries: (await (await caches.open(name)).keys()).length }); continue; }
      const c = await caches.open(name);
      for (const req of await c.keys()) {
        const key = decodeURIComponent(new URL(req.url).pathname), r = await c.match(req), b = await r.blob();
        const row = { cache: name, key, bytes: b.size };
        if (${JSON.stringify(mode)} === "dump" && name === "nxweb-a64" && true) {
          row.file = "tc" + rows.length + ".bin";
          const p = await fetch("http://localhost:8091/put/" + row.file, { method: "POST", body: b });
          row.put = p.status;
        }
        rows.push(row);
      }
    }
    return rows;
  })()`);
  for (const r of out) console.log(JSON.stringify(r));
} finally { cdp.close(); child.kill("SIGKILL"); }
