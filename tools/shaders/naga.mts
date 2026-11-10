// naga as WebAssembly (tools/shaders/naga_wasm, built by `npm run shaders:naga` into build/shaders/nx_naga.wasm): SPIR-V -> WGSL.
// instantiate() takes the module's bytes, so a page can use it as it is; load() is the Node convenience.
export interface Naga { spvToWgsl(spv: Uint8Array, flags?: number): string }
export async function instantiate(wasm: BufferSource): Promise<Naga> {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const x = instance.exports as any;
  return {
    spvToWgsl(spv, flags = 0) {
      const p = x.nx_alloc(spv.length);
      new Uint8Array(x.memory.buffer, p, spv.length).set(spv);
      const r = x.nx_spv_to_wgsl(p, spv.length, flags);
      x.nx_free(p, spv.length);
      const dv = new DataView(x.memory.buffer), status = dv.getUint32(r, true), len = dv.getUint32(r + 4, true);
      const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, r + 8, len).slice());
      x.nx_free(r, 8 + len);
      if (status) throw new Error(`naga ${status === 1 ? "cannot read the SPIR-V" : "rejects the module"}: ${text}`);
      return text;
    },
  };
}
export async function load(path = new URL("../../build/shaders/nx_naga.wasm", import.meta.url)): Promise<Naga> {
  const { readFile } = await import("node:fs/promises");
  return instantiate(await readFile(path));
}
