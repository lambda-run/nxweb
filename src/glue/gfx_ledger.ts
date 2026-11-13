// What each frame drew and what it skipped, and which shader keys skipped work, in the order the frames first
// needed them: the page report's "graphics, per frame" and "shader keys" sections and the F9 capture's frame line.
// It reads the host record stream (src/gfx/hostops.ts) as the replayer sees it, with either replayer, and keeps a
// bounded amount: the last FRAMES frames, KEYS keys, TEXTURES textures' last writer. Nothing in it knows a game.

const R_DRAW = 14, R_DRAW_IDX = 15, R_BEGIN_PASS = 3, R_END_PASS = 4, R_TEX = 11, R_IMG = 29, R_BEGIN_COMPUTE = 30, R_DISPATCH = 31,
  R_COPY_B2T = 17, R_COPY_T2T = 18, R_TEX_DATA = 24, R_PRESENT = 20, R_TEX_DESTROY = 2, R_MESH_DRAW = 38, R_SKIP = 41;
export const FRAMES = 64, KEYS = 16384, TEXTURES = 4096, FRAME_TEXTURES = 256, SOURCES = 8;

// H_SKIP's reason (hostops.ts SKIP_*); a shader reason is split by the state of its keys
const SKIP_REASON = ["shader", "program lacks the stage", "pipeline failed", "unsupported state", "render condition false", "rasterizer discard", "nothing to draw (count 0)"];
const KEY_STATE = ["unknown", "pending", "failed"] as const;
export type KeyState = typeof KEY_STATE[number];

export interface KeyUse { seq: number; key: string; frame: number; t: number; ord: string; draws: number; dispatches: number; state: KeyState }
// Who wrote a texture: draw (kind 0) or dispatch (1) number `no` of pass `pass` in frame `frame`, then copied on (`via`). The text is made when it is asked for
interface Writer { frame: number; ord: number; kind: number; no: number; pass: number; via: string }
const whatOf = (w: Writer) => `${w.kind ? "dispatch" : "draw"} #${w.no} (pass ${w.pass})${w.via}`;
interface Frame {
  n: number; t: number;
  draws: number; drawSkips: Map<string, number>; dispatches: number; dispatchSkips: Map<string, number>;
  first: Map<number, Writer>;            // texture serial -> the first draw or dispatch of this frame that wrote it
  from: Map<number, Set<number>>;        // texture serial -> what it was copied or drawn from this frame
  uploads: Set<number>;
  presented: number; line: string;
}

const hex8 = (dv: DataView, p: number) => { let s = ""; for (let i = 0; i < 8; i++) s += dv.getUint8(p + i).toString(16).padStart(2, "0"); return s; };
const u64 = (dv: DataView, p: number) => dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
const sumOf = (m: Map<string, number>) => { let n = 0; for (const v of m.values()) n += v; return n; };
const listOf = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(", ");

export class FrameLedger {
  frames: string[] = [];                 // the last FRAMES frame lines (identical consecutive frames folded into one)
  framesSeen = 0;
  keysDropped = 0;                       // keys past KEYS: counted, not listed
  firstDrawn = "";                       // the first frame whose presented image had a draw or dispatch in its chain
  private keys = new Map<string, KeyUse>();
  private last = new Map<number, Writer>();
  private f!: Frame;
  private pass: number[] = [];           // colour targets of the open render pass
  private sampled = new Set<number>();   // textures bound since the pass or the last dispatch began
  private imgW = new Set<number>();      // images a dispatch writes
  private ord = 0;                       // draws (issued or skipped) of this frame so far
  private dord = 0;                      // dispatches of this frame so far
  private passNo = 0;
  // A pass's targets and the textures sampled so far change with other records than draws, so a draw (thousands a frame) does only what changed since
  // the draw before it: the first writers once per pass, the links when a texture was bound, and the last writer of the targets is one object per
  // pass whose draw number moves on
  private passFirst = false;             // the pass's targets have their first writer of this frame (or the table is full)
  private passLast: Writer | null = null;
  private linkDirty = true;              // a texture was bound since the targets were last linked to what is sampled
  private passReset(): void { this.passFirst = false; this.passLast = null; this.linkDirty = true; }
  private t0 = -1;
  private fold: { line: string; from: number; to: number; t0: number; t1: number } | null = null;
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; this.f = this.newFrame(); }

  private at(): number { return (this.now() - this.t0) / 1000; }   // seconds since the ledger began
  private newFrame(): Frame {
    if (this.t0 < 0) this.t0 = this.now();
    this.ord = 0; this.dord = 0; this.passNo = 0; this.passReset();
    return { n: this.framesSeen + 1, t: 0, draws: 0, drawSkips: new Map(), dispatches: 0, dispatchSkips: new Map(), first: new Map(), from: new Map(), uploads: new Set(), presented: 0, line: "" };
  }

  // the records of one gfx_exec (the null replayer's path; the live replayer calls record() from its loop)
  walk(dv: DataView, ptr: number, len: number): void {
    for (let p = ptr, end = ptr + len; p < end;) { const size = dv.getUint32(p + 4, true); this.record(dv.getUint32(p, true), dv, p); if (!size) break; p += size; }
  }

  record(op: number, dv: DataView, p: number): void {
    const f = this.f;
    switch (op) {
      case R_BEGIN_PASS: {
        this.pass = []; this.sampled.clear(); this.passNo++; this.passReset();
        const n = Math.min(dv.getUint32(p + 8, true), 8);
        for (let i = 0; i < n; i++) { const s = u64(dv, p + 32 + i * 40); if (s) this.pass.push(s); }
        break;
      }
      case R_END_PASS: this.pass = []; this.passReset(); break;
      case R_BEGIN_COMPUTE: this.pass = []; this.sampled.clear(); this.imgW.clear(); this.passNo++; this.passReset(); break;
      case R_TEX: { const s = u64(dv, p + 16); if (s && this.sampled.size < SOURCES && !this.sampled.has(s)) { this.sampled.add(s); this.linkDirty = true; } break; }
      case R_IMG: { const s = u64(dv, p + 16); if (s && dv.getUint32(p + 24, true) & 1) this.imgW.add(s); else if (s && this.sampled.size < SOURCES && !this.sampled.has(s)) { this.sampled.add(s); this.linkDirty = true; } break; }
      case R_DRAW: case R_DRAW_IDX: case R_MESH_DRAW: this.ord++; f.draws++; this.drew(); break;
      case R_DISPATCH: this.dord++; f.dispatches++; this.passReset(); this.wrote([...this.imgW], { frame: f.n, ord: 1e9 + this.dord, kind: 1, no: this.dord, pass: this.passNo, via: "" }); this.sampled.clear(); this.imgW.clear(); break;
      case R_SKIP: this.skip(dv, p); break;
      case R_COPY_T2T: {
        const src = u64(dv, p + 8), dst = u64(dv, p + 16), w = this.last.get(src);
        this.link(dst, src); this.passReset();
        if (w && dst !== src) { this.last.delete(dst); this.last.set(dst, { ...w, via: `${w.via} -> tex#${src}` }); if (this.last.size > TEXTURES) this.last.delete(this.last.keys().next().value!); }
        break;
      }
      case R_COPY_B2T: if (f.uploads.size < FRAME_TEXTURES) f.uploads.add(u64(dv, p + 16)); break;
      case R_TEX_DATA: break;
      case R_TEX_DESTROY: this.last.delete(u64(dv, p + 8)); this.passReset(); break;
      case R_PRESENT: f.presented = u64(dv, p + 8); this.endFrame(); break;
    }
  }

  // the live replayer could not issue the draw it just counted (no pipeline yet, bindings it could not make)
  dropped(why: string, dispatch = false): void {
    const f = this.f;
    if (dispatch) { f.dispatches--; f.dispatchSkips.set(why, (f.dispatchSkips.get(why) ?? 0) + 1); return; }
    f.draws--; f.drawSkips.set(why, (f.drawSkips.get(why) ?? 0) + 1);
    for (const s of this.pass) if (f.first.get(s)?.ord === this.ord) { f.first.delete(s); this.passFirst = false; }
  }

  // a draw of the open render pass (this.ord): what wrote() does for the pass's targets, only where something changed since the pass's draw before
  private drew(): void {
    const f = this.f, targets = this.pass, ord = this.ord;
    if (!targets.length) return;
    if (!this.passFirst) { for (const s of targets) if (!f.first.has(s) && f.first.size < FRAME_TEXTURES) f.first.set(s, { frame: f.n, ord, kind: 0, no: ord, pass: this.passNo, via: "" }); this.passFirst = true; }
    if (this.linkDirty) { for (const s of targets) for (const src of this.sampled) this.link(s, src); this.linkDirty = false; }
    const w = this.passLast;
    if (w) { w.ord = ord; w.no = ord; return; }
    const nw = this.passLast = { frame: f.n, ord, kind: 0, no: ord, pass: this.passNo, via: "" };
    for (const s of targets) { this.last.delete(s); this.last.set(s, nw); if (this.last.size > TEXTURES) this.last.delete(this.last.keys().next().value!); }
  }

  private wrote(targets: number[], by: Writer): void {
    const f = this.f;
    for (const s of targets) {
      if (!f.first.has(s) && f.first.size < FRAME_TEXTURES) f.first.set(s, { ...by });
      for (const src of this.sampled) this.link(s, src);
      const w = { ...by };
      this.last.delete(s); this.last.set(s, w);
      if (this.last.size > TEXTURES) this.last.delete(this.last.keys().next().value!);
    }
  }
  private link(dst: number, src: number): void {
    if (!dst || !src || dst === src) return;
    const m = this.f.from; let set = m.get(dst);
    if (!set) { if (m.size >= FRAME_TEXTURES) return; m.set(dst, set = new Set()); }
    if (set.size < SOURCES) set.add(src);
  }

  private skip(dv: DataView, p: number): void {
    const f = this.f, reason = dv.getUint32(p + 8, true), kind = dv.getUint8(p + 12);
    const keys: { key: string; state: KeyState }[] = [];
    for (let i = 0; i < 3; i++) { const lo = dv.getUint32(p + 16 + i * 8, true), hi = dv.getUint32(p + 20 + i * 8, true); if (lo || hi) keys.push({ key: hex8(dv, p + 16 + i * 8), state: KEY_STATE[dv.getUint8(p + 13 + i)] ?? "unknown" }); }
    const why = reason === 0 && keys.length ? `shader ${keys.some(k => k.state === "failed") ? "failed" : keys.some(k => k.state === "pending") ? "pending" : "unknown"}` : SKIP_REASON[reason] ?? `reason ${reason}`;
    const dispatch = kind === 1;
    const m = dispatch ? f.dispatchSkips : f.drawSkips;
    m.set(why, (m.get(why) ?? 0) + 1);
    const ord = dispatch ? `dispatch #${++this.dord}` : `draw #${++this.ord}`;
    for (const k of keys) {
      let u = this.keys.get(k.key);
      if (!u) {
        if (this.keys.size >= KEYS) { this.keysDropped++; continue; }
        this.keys.set(k.key, u = { seq: this.keys.size, key: k.key, frame: f.n, t: this.at(), ord, draws: 0, dispatches: 0, state: k.state });
      }
      u.state = k.state;
      if (dispatch) u.dispatches++; else u.draws++;
    }
  }

  // the presented image and what was copied or drawn into it this frame, back to SOURCES levels
  private chain(f: Frame): number[] {
    const seen = new Set<number>([f.presented]), todo = [f.presented];
    for (let d = 0; d < SOURCES && todo.length; d++) for (const s of todo.splice(0)) for (const src of f.from.get(s) ?? []) if (!seen.has(src) && seen.size < FRAME_TEXTURES) { seen.add(src); todo.push(src); }
    return [...seen];
  }

  private endFrame(): void {
    const f = this.f;
    this.framesSeen++; f.t = this.at();
    let first: (Writer & { tex: number }) | null = null;
    if (f.presented) for (const s of this.chain(f)) { const w = f.first.get(s); if (w && (!first || w.ord < first.ord)) first = { ...w, tex: s }; }
    let wrote: string;
    if (first) wrote = `${whatOf(first)} -> tex#${first.tex}`;
    else {
      const prev = f.presented ? this.last.get(f.presented) : undefined;
      wrote = `none${f.presented && f.uploads.has(f.presented) ? " (uploaded)" : ""}${prev ? `; last drawn in frame ${prev.frame} by ${whatOf(prev)}` : ""}`;
    }
    if (first && !this.firstDrawn) this.firstDrawn = `frame ${f.n} (t ${f.t.toFixed(2)} s): ${wrote}`;
    const ds = sumOf(f.drawSkips), cs = sumOf(f.dispatchSkips);
    f.line = `draws ${f.draws} issued, ${ds} skipped${ds ? ` (${listOf(f.drawSkips)})` : ""}; dispatches ${f.dispatches} issued, ${cs} skipped${cs ? ` (${listOf(f.dispatchSkips)})` : ""}; ` +
      `presented ${f.presented ? `tex#${f.presented}` : "nothing"}, first non-clear write: ${wrote}`;
    this.lastLine = `frame ${f.n} (t ${f.t.toFixed(2)} s): ${f.line}`;
    const fo = this.fold;
    if (fo && fo.line === f.line && fo.to === f.n - 1) { fo.to = f.n; fo.t1 = f.t; this.frames[this.frames.length - 1] = this.foldLine(fo); }
    else {
      this.fold = { line: f.line, from: f.n, to: f.n, t0: f.t, t1: f.t };
      this.frames.push(this.foldLine(this.fold));
      if (this.frames.length > FRAMES) this.frames.shift();
    }
    this.f = this.newFrame();
  }
  private foldLine(fo: { line: string; from: number; to: number; t0: number; t1: number }): string {
    return fo.from === fo.to ? `frame ${fo.from} (t ${fo.t0.toFixed(2)} s): ${fo.line}` : `frames ${fo.from}-${fo.to} (t ${fo.t0.toFixed(2)}-${fo.t1.toFixed(2)} s): ${fo.line}`;
  }
  lastLine = "";                         // the frame that was presented last, unfolded (the F9 capture's frame line)

  // the keys that skipped work, in the order they were first needed
  keyUses(): KeyUse[] { return [...this.keys.values()]; }

  // the report's lines: one per state (and failure reason, from why()) with every key in first-use order
  keyLines(why: (key: string) => string | undefined = () => undefined, current: (key: string) => string | undefined = () => undefined): string[] {
    const groups = new Map<string, KeyUse[]>();
    for (const u of this.keys.values()) {
      const st = current(u.key) ?? u.state;
      const label = st === "ready" ? `${u.state} then, ready now` : st === "failed" && why(u.key) ? `failed: ${why(u.key)}` : st;
      let g = groups.get(label); if (!g) groups.set(label, g = []); g.push(u);
    }
    const out: string[] = [];
    for (const [label, us] of [...groups].sort((a, b) => a[1][0].seq - b[1][0].seq))
      out.push(`${label} (${us.length}): ` + us.map(u => `${u.key} (frame ${u.frame}, t ${u.t.toFixed(2)} s, ${u.ord}; skipped ${u.draws} draws, ${u.dispatches} dispatches)`).join(", "));
    if (this.keysDropped) out.push(`(${this.keysDropped} more keys past the first ${KEYS} are not listed)`);
    return out;
  }
}
