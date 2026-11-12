// A few AArch64 instructions with labels, for flat test guests written in place (exit_bench.mts, more_cases.ts).
// An item is an instruction word, a label name (defined there), or a function of the label offsets and its own.
export type Item = number | string | ((at: Record<string, number>, pc: number) => number);
const rel19 = (to: number, pc: number) => (((to - pc) >> 2) & 0x7FFFF) << 5;
export const ldr = (rt: number, l: string): Item => (at, pc) => (0x58000000 | rel19(at[l], pc) | rt) >>> 0;                              // ldr xt, =literal
export const adr = (rd: number, l: string): Item => (at, pc) => (0x10000000 | (((at[l] - pc) & 3) << 29) | rel19(at[l], pc) | rd) >>> 0;
export const bne = (l: string): Item => (at, pc) => (0x54000001 | rel19(at[l], pc)) >>> 0;
export const cbnz = (rt: number, l: string): Item => (at, pc) => (0xB5000000 | rel19(at[l], pc) | rt) >>> 0;
export const b = (l: string): Item => (at, pc) => (0x14000000 | (((at[l] - pc) >> 2) & 0x3FFFFFF)) >>> 0;
export const movz = (rd: number, imm: number) => (0xD2800000 | (imm << 5) | rd) >>> 0;
export const svc = (n: number) => (0xD4000001 | (n << 5)) >>> 0;
export const dec = (r: number) => (0xF1000400 | (r << 5) | r) >>> 0;                    // subs xr, xr, #1
export const load = (rt: number, rn: number) => (0xF9400000 | (rn << 5) | rt) >>> 0;    // ldr xt, [xn]
export const store = (rt: number, rn: number) => (0xF9000000 | (rn << 5) | rt) >>> 0;   // str xt, [xn]
export const BLR20 = 0xD63F0280, MOV_W0_W1 = 0x2A0103E0;
// The image (one page): the code, then the literals (8 bytes each, by name)
export function asm(items: Item[], lits: Record<string, bigint> = {}): Uint8Array {
  const at: Record<string, number> = {};
  let pc = 0;
  for (const it of items) if (typeof it === "string") at[it] = pc; else pc += 4;
  pc = (pc + 7) & ~7;
  for (const l of Object.keys(lits)) { at[l] = pc; pc += 8; }
  const out = new Uint8Array(0x1000), dv = new DataView(out.buffer);
  pc = 0;
  for (const it of items) if (typeof it !== "string") { dv.setUint32(pc, typeof it === "number" ? it : it(at, pc), true); pc += 4; }
  for (const [l, v] of Object.entries(lits)) dv.setBigUint64(at[l], v, true);
  return out;
}
