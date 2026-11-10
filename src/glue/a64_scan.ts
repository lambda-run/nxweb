// Static scan of a code module's text with the translator's own decoder (src/a64/scan.ts): which of its 32-bit words
// the translator has no translation for, as a histogram by kind of instruction. No Node or browser API here.
//
// The scanner is the translator binary itself (build/a64/translator.wasm) on a small memory of its own: the answer
// "implemented" comes from the function that translates, so the scan cannot say something else than the translator
// will do. A word it rejects gets a name from a table in the same binary.
//
// What counts as code. A text segment also holds literal pools, jump tables and padding. When the module has an
// unwind table (.eh_frame_hdr: the function list the prepare step reads for its function-matched cuts), the words
// inside its functions are "code": everything there is an instruction the program can reach. The words of the text
// outside every function (hand-written assembly without unwind information, pools, padding between functions) are
// scanned too and reported apart, as "outside the function table: may be data". Without a table the whole text is
// scanned as one region and said to be so. In both regions a rejected word that is no A64 instruction this scanner
// knows (UDF, unallocated encodings) is listed apart from the kinds that are instructions, and is not counted in the
// headline number.
//
// Literal pools. With a function table, the words that the functions' PC-relative loads read (LDR Xt, =value and its
// W, SW, S, D, Q forms) are data that lies in the code: they are marked in a first pass over the functions and left
// out of the second (ModuleScan.literals). Without a table nothing is left out: a data word that happens to look
// like such a load would hide other words.
import { A64 } from "./rt_layout.ts";

export const SCAN_FORMAT = 1;
export interface ScanKind {
  name: string;
  instruction: boolean;     // false: not an A64 instruction (data in text, or newer than the scanner's table)
  count: number;            // words of this kind in code (inside functions; the whole text when there is no table)
  first: number[];          // module offsets of the first few
  outside: number;          // the same in the text outside every function
  firstOutside: number[];
}
export interface ModuleScan {
  format: number;
  textWords: number;                 // 32-bit words in the text segment
  functions: number | null;          // functions of the unwind table the scan went by; null: no table, the whole text is one region
  words: number;                     // words scanned as code
  implemented: number;               // of them, words the translator translates
  wordsOutside: number; implementedOutside: number;
  kinds: ScanKind[];                 // most frequent first; instructions before non-instructions
  unsupported: number;               // kinds that are instructions and occur in code: the headline
  unsupportedWords: number;
  literals: number;                  // words left out as literal-pool data: what the PC-relative loads of the functions read
  dropped: number;                   // rejected words left out because the kind table was full (0 in practice)
}
const num = (v: number | bigint) => Number(v);

export class A64Scanner {
  private x: any;
  private mem: WebAssembly.Memory;
  private buf: number; private cap: number;
  // translator: build/a64/translator.wasm (the memory32, unshared build)
  constructor(translator: WebAssembly.Module | BufferSource) {
    const mod = translator instanceof WebAssembly.Module ? translator : new WebAssembly.Module(translator);
    // its static data and buffers lie at the layout's address; the scan's tables come after them
    this.mem = new WebAssembly.Memory({ initial: Math.ceil((A64.translatorEnd + (32 << 20)) / 65536) });
    this.x = new WebAssembly.Instance(mod, { env: { memory: this.mem, abort: () => { throw new Error("a64 scan: abort"); } } }).exports;
    if (!this.x.scanWords) throw new Error("a64 scan: this translator binary has no scanner (build it again: npm run a64:build)");
    if ((this.x.addrBits?.() ?? 32) !== 32) throw new Error("a64 scan: the memory32 translator is the one to scan with");
    this.x.init();
    this.x.scanReset();
    this.buf = num(this.x.scanBuf()); this.cap = this.x.scanBufSize();
    if (num(this.x.staticEnd()) > this.mem.buffer.byteLength) throw new Error("a64 scan: the scanner's tables do not fit its memory");
  }
  // Is this one word translated? (the same answer the scan counts by)
  implemented(word: number): boolean { return !!this.x.probe(word >>> 0); }
  // text: the bytes of the text segment; textOff: its offset in the module (offsets in the result are module
  // offsets); functions: [start, end) pairs as module offsets, sorted by start, or null when the module has no table.
  // `tick` is awaited between pieces of about 1 MB (a redraw, a Cancel: what it throws ends the scan).
  async scan(text: Uint8Array, textOff = 0, functions: ArrayLike<number> | null = null, tick?: (done: number, total: number) => Promise<void> | void): Promise<ModuleScan> {
    const x = this.x, words = text.length >>> 2;
    x.scanReset();
    const view = () => new Uint8Array(this.mem.buffer, this.buf, this.cap);
    const nfn = functions ? functions.length >> 1 : 0;
    // the text in pieces of the scanner's buffer, each split into the gaps (region 1) and the functions (region 0)
    const pass = async (each: (at: number, n: number, off: number, region: number) => void, done0: number, total: number) => {
      let fi = 0;
      for (let at = 0; at < words * 4; at += this.cap) {
        const n = Math.min(this.cap, words * 4 - at);
        view().set(text.subarray(at, at + n));
        if (!functions) each(0, n >>> 2, textOff + at, 0);
        else {
          const lo = textOff + at, hi = lo + n;
          let p = lo;
          while (p < hi) {
            while (fi < nfn && functions[2 * fi + 1] <= p) fi++;
            const fs = fi < nfn ? Math.max(functions[2 * fi], p) : hi, fe = fi < nfn ? functions[2 * fi + 1] : hi;
            if (fs > p) { const e = Math.min(fs, hi); each(p - lo, (e - p) >>> 2, p, 1); p = e; }
            if (p < hi && fi < nfn && p >= functions[2 * fi]) { const e = Math.min(fe, hi); each(p - lo, (e - p) >>> 2, p, 0); p = e; }
          }
        }
        if (tick) await tick(done0 + at + n, total);
      }
    };
    // with a function table: first what the functions' PC-relative loads read (literal pools), then the scan
    if (functions) await pass((at, n, off, region) => { if (region === 0) x.scanLiterals(at, n, off); }, 0, words * 8);
    await pass((at, n, off, region) => x.scanWords(at, n, off, region), functions ? words * 4 : 0, functions ? words * 8 : words * 4);
    const kinds: ScanKind[] = [];
    const dec = new TextDecoder();
    for (let k = 0, nk = x.scanKinds(); k < nk; k++) {
      const p = num(x.scanName(k)), name = dec.decode(new Uint8Array(this.mem.buffer, p, x.scanNameLen()).slice());
      const firsts = (r: number) => Array.from({ length: x.scanFirstCount(k, r) }, (_, i) => x.scanFirst(k, r, i) >>> 0);
      kinds.push({ name, instruction: !!x.scanIsInstruction(x.scanKind(k)), count: x.scanCount(k, 0), first: firsts(0), outside: x.scanCount(k, 1), firstOutside: firsts(1) });
    }
    kinds.sort((a, b) => Number(b.instruction) - Number(a.instruction) || b.count - a.count || b.outside - a.outside || (a.name < b.name ? -1 : 1));
    const real = kinds.filter(k => k.instruction && k.count > 0);
    return { format: SCAN_FORMAT, textWords: words, functions: functions ? nfn : null, words: x.scanTotal(0), implemented: x.scanImplemented(0),
      wordsOutside: x.scanTotal(1), implementedOutside: x.scanImplemented(1), kinds,
      unsupported: real.length, unsupportedWords: real.reduce((n, k) => n + k.count, 0), literals: x.scanLiteralWords(), dropped: x.scanDropped() };
  }
}

// ---- words about a scan ----
const hex = (n: number) => "0x" + n.toString(16);
// the line for the Code stage's row; "" when every instruction of the scanned modules is supported
export function scanHeadline(scans: { scan: ModuleScan }[]): string {
  const names = new Set<string>();
  for (const s of scans) for (const k of s.scan.kinds) if (k.instruction && k.count > 0) names.add(k.name);
  return names.size ? `${names.size} kind${names.size === 1 ? "" : "s"} of instruction in this game ${names.size === 1 ? "is" : "are"} not supported yet` : "";
}
// the table as text lines: for the verdict card's technical details, the report and the command line. Opcode
// classes, counts and module offsets only: nothing of the game's content.
export function scanLines(module: string, s: ModuleScan, max = 40): string[] {
  const out: string[] = [];
  const where = s.functions === null ? "the module has no unwind table: its whole text was scanned, literal pools and padding included"
    : `${s.words.toLocaleString("en-US")} words in the ${s.functions.toLocaleString("en-US")} function${s.functions === 1 ? "" : "s"} of its unwind table, ${s.wordsOutside.toLocaleString("en-US")} outside them`;
  out.push(`${module}: ${s.textWords.toLocaleString("en-US")} words of text scanned with the translator's decoder (${where})`);
  const code = s.kinds.filter(k => k.count > 0), inst = code.filter(k => k.instruction), other = code.filter(k => !k.instruction);
  out.push(inst.length ? `${module}: ${inst.length} kind${inst.length === 1 ? "" : "s"} of instruction not supported, ${s.unsupportedWords.toLocaleString("en-US")} words in all:`
    : `${module}: every instruction ${s.functions === null ? "in its text" : "in its functions"} is supported`);
  const row = (k: ScanKind, n: number, first: number[]) => `  ${String(n).padStart(8)}  ${k.name}  (first at ${first.map(hex).join(", ")})`;
  for (const k of inst.slice(0, max)) out.push(row(k, k.count, k.first));
  if (inst.length > max) out.push(`  ... and ${inst.length - max} more kinds`);
  for (const k of other) out.push(`${module}: ${k.count.toLocaleString("en-US")} word${k.count === 1 ? "" : "s"} ${s.functions === null ? "in its text" : "inside functions"}: ${k.name} (first at ${k.first.map(hex).join(", ")})`);
  const outside = s.kinds.filter(k => k.outside > 0 && k.instruction);
  if (outside.length) {
    out.push(`${module}: outside the function table (may be data, or assembly without unwind information): ${outside.length} kind${outside.length === 1 ? "" : "s"} of unsupported instruction:`);
    for (const k of outside.slice(0, max)) out.push(row(k, k.outside, k.firstOutside));
  }
  const junk = s.kinds.filter(k => k.outside > 0 && !k.instruction).reduce((n, k) => n + k.outside, 0);
  if (junk) out.push(`${module}: ${junk.toLocaleString("en-US")} words outside the function table are not instructions (padding, literal pools)`);
  if (s.literals) out.push(`${module}: ${s.literals.toLocaleString("en-US")} word${s.literals === 1 ? " is" : "s are"} literal-pool data (what the PC-relative loads of the functions read) and not counted`);
  if (s.dropped) out.push(`${module}: ${s.dropped} rejected words were not classified (too many kinds)`);
  return out;
}
