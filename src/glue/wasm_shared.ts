// nxweb glue: the shared-memory build of a module (RuntimeOptions.shared, src/runtime/README.md "Shared memory").
//
// A module can be linked to a shared WebAssembly.Memory only when its own declaration of that memory says "shared"
// and gives a maximum the memory's maximum fits in. Nothing else of an AssemblyScript module of this repository
// depends on it (the stub runtime has no atomics of its own: `asc --sharedMemory --maximumMemory N --enable threads`
// changes exactly the limits of the memory and nothing in the code, data or address table), so the shared build of
// rt, kernel, loader, gfx, fs, hle and audio is the normal binary with those limits rewritten: `sharedBuild`, done
// where the bytes are loaded (web/worker.ts, the test harnesses). The translator and its helpers have asc-built
// shared binaries of their own (translator.shared.wasm, helpers.shared.wasm: src/a64/host/build.mts), and the core
// and the units are generated shared by the translator (`shared: true`).
//
// Both forms are rewritten: an imported memory (--importMemory: the modules of build/runtime, the wasm64 builds) and
// a memory the module defines itself (build/kernel/kernel.wasm, build/hle/hle.wasm of the 32-bit test runners).

export const SHARED_MAX_PAGES_32 = 65536;

function uleb(b: Uint8Array, p: number): [number, number] {
  let v = 0, m = 1;
  for (;;) { const c = b[p++]; v += (c & 0x7F) * m; m *= 128; if (!(c & 0x80)) return [v, p]; }
}
function lebOf(v: number): number[] {
  const out: number[] = [];
  do { let c = v % 128; v = Math.floor(v / 128); if (v) c |= 0x80; out.push(c); } while (v);
  return out;
}
// limits at p: [the same limits as shared with `maxPages` as the maximum (a larger declared one stays), the end]
function limits(b: Uint8Array, p: number, maxPages: number): [number[], number] {
  const flags = b[p++];
  if (flags & ~7) throw new Error(`wasm_shared: memory limits with flags 0x${flags.toString(16)}`);
  let initial: number, max = 0;
  [initial, p] = uleb(b, p);
  if (flags & 1) [max, p] = uleb(b, p);
  if (initial > maxPages) throw new Error(`wasm_shared: the module's memory starts at ${initial} pages, above the maximum ${maxPages}`);
  return [[flags | 3, ...lebOf(initial), ...lebOf(Math.max(max, maxPages))], p];
}

// The bytes of `wasm` with every memory it imports or defines declared shared, maximum `maxPages` (64 KiB pages:
// what the memory it will be linked to was made with, or more). A binary that is shared already comes back as it is
// when its maximum suffices.
export function sharedBuild(wasm: Uint8Array | ArrayBuffer, maxPages: number): Uint8Array {
  const b = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
  if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6D) throw new Error("wasm_shared: not a wasm binary");
  const parts: (Uint8Array | number[])[] = [b.subarray(0, 8)];
  let found = 0;
  for (let p = 8; p < b.length;) {
    const start = p, id = b[p++];
    let size: number;
    [size, p] = uleb(b, p);
    const end = p + size;
    if (id !== 2 && id !== 5) { parts.push(b.subarray(start, end)); p = end; continue; }
    const body: number[] = [];
    let n: number, q = p;
    [n, q] = uleb(b, q);
    body.push(...lebOf(n));
    for (let i = 0; i < n; i++) {
      if (id === 5) { const [l, e] = limits(b, q, maxPages); body.push(...l); q = e; found++; continue; }
      const from = q;
      for (let k = 0; k < 2; k++) { let len: number; [len, q] = uleb(b, q); q += len; }   // module and field names
      const kind = b[q++];
      if (kind === 2) { body.push(...b.subarray(from, q)); const [l, e] = limits(b, q, maxPages); body.push(...l); q = e; found++; continue; }
      if (kind === 0) [, q] = uleb(b, q);                                    // function: type index
      else if (kind === 1) {                                                 // table: element type, limits
        if (b[q] === 0x63 || b[q] === 0x64) throw new Error("wasm_shared: a table import with a typed reference");
        q++; const f = b[q++]; [, q] = uleb(b, q); if (f & 1) [, q] = uleb(b, q);
      } else if (kind === 3) {                                               // global: value type, mutability
        if (b[q] === 0x63 || b[q] === 0x64) throw new Error("wasm_shared: a global import with a typed reference");
        q += 2;
      } else if (kind === 4) { q++; [, q] = uleb(b, q); }                    // tag
      else throw new Error(`wasm_shared: import kind ${kind}`);
      body.push(...b.subarray(from, q));
    }
    if (q !== end) throw new Error("wasm_shared: section " + id + " does not end where it says");
    parts.push([id, ...lebOf(body.length)], body);
    p = end;
  }
  if (!found) throw new Error("wasm_shared: the module has no memory");
  let total = 0;
  for (const s of parts) total += s.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const s of parts) { out.set(s, o); o += s.length; }
  return out;
}

// A view the platform's APIs take everywhere: `v` itself on an ordinary buffer, a copy when it lies on a shared one
// (TextDecoder.decode, crypto.getRandomValues, Blob, Response, fetch bodies and structured clones to a
// BroadcastChannel refuse a view on a SharedArrayBuffer; WebGPU's queue writes, WebCodecs and the OPFS access
// handles are specified to take one)
export function unshared<T extends Uint8Array>(v: T): T {
  return typeof SharedArrayBuffer !== "undefined" && v.buffer instanceof SharedArrayBuffer ? v.slice() as T : v;
}
