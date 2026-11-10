// The Prepare page's shader scan Worker (src/prepare/host/shader_scan.ts): it is given the prepare module once and
// then one file at a time (a Blob, or its bytes when the tree has no Blob for it) and answers with the file's scan.
// Off the page's thread: a game's RomFS is read whole and unwrapped here.
import { PrepWasm } from "../src/prepare/host/wasm.ts";
import { scanFile, emptyScan, MAX_FILE } from "../src/prepare/host/shader_scan.ts";

let w: PrepWasm | null = null;
self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.wasm) { w = new PrepWasm(m.wasm); return; }
  const { id, path, size, module, blob, bytes } = m as { id: number; path: string; size: number; module: boolean; blob?: Blob; bytes?: Uint8Array };
  try {
    if (!w) throw new Error("the scan Worker was not given the prepare module");
    let r;
    if (size > MAX_FILE) { r = emptyScan(path, size); r.notRead.push(`files over ${MAX_FILE >> 20} MB (not read whole)`); }
    else r = scanFile(w, path, bytes ?? new Uint8Array(await blob!.arrayBuffer()), { module });
    (self as any).postMessage({ id, scan: r }, r.stages.flatMap(s => [s.control.buffer, s.code.buffer]));
  } catch (e) {
    (self as any).postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
