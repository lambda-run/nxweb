// The Worker side of `npm run prepare:browser`: takes the prepare page's hand-off message and starts it, the way
// the page's runtime Worker will: the code modules from their Blobs, the RomFS and add-on contents as devices over
// the folder's Files (read with FileReaderSync), saves in memory. Reports what the guest printed.
import { Runtime } from "../../../src/glue/rt_runtime.ts";
import { RtFs } from "../../../src/glue/rt_fs.ts";
import { MemStorage, FS_KIND, DEV } from "../../../src/glue/fs_host.ts";
import { storageFromMessage, romFromMessage, type HandOffMessage } from "../../../src/prepare/host/prepare.ts";
import { PrepWasm } from "../../../src/prepare/host/wasm.ts";

const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
self.onmessage = async (ev: MessageEvent) => {
  try {
    const msg = ev.data.handoff as HandOffMessage;
    const mod = async (n: string) => WebAssembly.compile(await bytes(`/rtwasm/${n}.wasm`));
    const [rt, kernel, loader, translator, helpers, fs] = await Promise.all(["rt", "kernel", "loader", "translator", "helpers", "fs"].map(mod));
    const run = new Runtime({ rt, kernel, loader, translator, helpers, fs });
    // a container's files are checked with the prepare module's SHA-256 as they are read
    const lines: string[] = [];
    const pw = msg.rom?.nup || msg.aoc.some(a => a.image.nup) ? new PrepWasm(await WebAssembly.compile(await bytes("/wasm/prepare.wasm"))) : null;
    const check = { sha256: pw ? (b: Uint8Array) => pw.sha256(b) : undefined, log: (l: string) => { lines.push(l); } };
    const storage = storageFromMessage(msg, new MemStorage(), check);
    new RtFs(run, fs, storage, { programId: BigInt("0x" + msg.programId) });
    run.register({ name: "test_mode", fn: () => 0 }); run.register({ name: "test_written", fn: () => {} });
    const files = [];
    for (const m of msg.modules) files.push({ name: m.name, bytes: new Uint8Array(await m.file.arrayBuffer()) });
    if (!run.loadNso(files)) throw new Error("load failed: " + run.red.join(" | "));
    const res = await run.runAsync();
    const out = { stdout: run.stdout(), kind: res.stop?.kind, code: res.stop?.code, red: [...run.red] };
    run.dispose();
    // the add-on content devices: every file read back whole through the device, synchronously
    const aoc: { index: number; files: number; bytes: number; sum: number; sync: boolean }[] = [];
    for (const a of msg.aoc) {
      const dev = romFromMessage(a.image, check); let sum = 0, total = 0;
      for (let i = 0; i < a.image.sizes.length; i++) {
        const b = new Uint8Array(a.image.sizes[i]);
        if (dev.readSync ? dev.readSync(a.image.starts[i], b) !== DEV.OK : (b.set(await dev.readAsync(a.image.starts[i], b.length)), false)) throw new Error("add-on content read failed");
        for (const v of b) sum = (sum * 31 + v) >>> 0; total += b.length;
      }
      aoc.push({ index: a.index, files: a.image.sizes.length, bytes: total, sum, sync: !!dev.readSync });
    }
    const romDev = storage.open(FS_KIND.ROM, 0n) as any;
    (self as any).postMessage({ ok: true, ...out, aoc, romSync: !!romDev.readSync, lines, reader: romDev.src?.reader?.stats ?? null });
  } catch (e) { (self as any).postMessage({ ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }); }
};
