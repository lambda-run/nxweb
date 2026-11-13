// The real-call audit's verdict (?lfaudit=1, tools/lf_real.mjs): NVN entry points the static audit lets through and the
// dynamic audit could not make record with made-up arguments, whose first real calls of a boot (under the lock, the
// recorder's static data, globals block and arena compared around each) wrote nothing there. They go without the
// lock as the static audit says (1, or 3: while the command buffer has room). Only for the recorder binary named by
// `key` (the SHA-256 of gfx64.wasm): another build is audited again. ?lfreal=0 leaves them under the lock.
export const REAL_AUDIT: { key: string; names: string[] } = { key: "", names: [] };
