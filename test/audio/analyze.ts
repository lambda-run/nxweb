// What a recording of the device's output says about a tone that should be in it. Shared by the page (which
// analyses in place) and Node.
export interface ToneReport {
  frames: number; first: number; last: number;      // the recording, and where sound starts and ends in it
  freq: number;                                      // from zero crossings over the sounding part
  snr: number; amp: number;                          // a least-squares fit of a sine of the expected frequency over all of it
  gaps: number; longestGap: number;                  // runs of 16 or more exact zeros inside the sounding part
  maxStep: number;                                   // the largest jump between neighbouring samples
}
export function fitSine(x: ArrayLike<number>, from: number, to: number, freq: number, rate: number): { amp: number; snr: number } {
  let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0, xx = 0;
  const w = 2 * Math.PI * freq / rate;
  for (let i = from; i < to; i++) { const s = Math.sin(w * i), c = Math.cos(w * i), v = x[i]; ss += s * s; cc += c * c; sc += s * c; xs += v * s; xc += v * c; xx += v * v; }
  const det = ss * cc - sc * sc, a = (xs * cc - xc * sc) / det, b = (xc * ss - xs * sc) / det;
  const sig = a * a * ss + b * b * cc + 2 * a * b * sc, res = Math.max(xx - sig, 1e-30);
  return { amp: Math.hypot(a, b), snr: 10 * Math.log10(Math.max(sig, 1e-30) / res) };
}
// x: one channel. from/to limit the part looked at (frames).
export function analyzeTone(x: ArrayLike<number>, freq: number, rate: number, from = 0, to = x.length): ToneReport {
  let first = from; while (first < to && x[first] === 0) first++;
  let last = to; while (last > first && x[last - 1] === 0) last--;
  let crossings = 0, gaps = 0, longestGap = 0, run = 0, maxStep = 0, c0 = -1, c1 = -1;
  for (let i = first + 1; i < last; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) { crossings++; if (c0 < 0) c0 = i; c1 = i; }
    const step = Math.abs(x[i] - x[i - 1]); if (step > maxStep) maxStep = step;
    if (x[i] === 0) { run++; if (run === 16) gaps++; if (run > longestGap) longestGap = run; } else run = 0;
  }
  const f = last - first > 64 ? fitSine(x, first, last, freq, rate) : { amp: 0, snr: -99 };
  return { frames: to - from, first, last, freq: crossings > 1 ? (crossings - 1) * rate / (c1 - c0) : 0, snr: f.snr, amp: f.amp, gaps, longestGap: longestGap >= 16 ? longestGap : 0, maxStep };
}
