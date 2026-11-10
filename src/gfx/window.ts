// NVN windows: a swap chain of up to four guest textures. They are ordinary textures; presenting one blits it to the
// canvas (lower.ts present, H_PRESENT). Each image has a kit instance (gfx_image) inside the guest's NVNwindow.
import * as L from "./log";
import { Inst } from "../kit/machine";
import { GFX_IMAGE, GfxImageE, GfxImageS } from "../kit/gen/tables";
import * as O from "./obj";
import { fenceLast } from "./tables";
import { syncFence } from "./sync";
import { present } from "./lower";
import { profileHas, P_PRESENT_DISPLAY } from "./profile";

let winSeq: u32 = 0;
// @ts-ignore: decorator
@inline function image(w: usize, i: i32): Inst { return Inst.at(w + O.WIN_image + <usize>i * Inst.SIZE); }
function active(w: usize): i32 { const n = load<i32>(w, O.WIN_ntex), a = load<i32>(w, O.WIN_nactive); return a > 0 && a < n ? a : n; }

export function windowInitialize(w: usize, b: usize): u64 {
  memory.fill(w, 0, O.WIN_SIZE);
  store<u32>(w, O.MAGIC_WIN); store<u64>(w, load<u64>(b, O.WB_native), O.WIN_native);
  store<i32>(w, load<i32>(b, O.WB_ntex), O.WIN_ntex); store<i32>(w, load<i32>(b, O.WB_interval), O.WIN_interval); store<i32>(w, load<i32>(b, O.WB_nactive), O.WIN_nactive);
  memory.copy(w + O.WIN_tex, b + O.WB_tex, 32);
  winSeq++;
  for (let i = 0; i < 4; i++) image(w, i).init(GFX_IMAGE, winSeq * 4 + i);
  return 1;
}
// nvnWindowAcquireTexture: the next image in turn (nxnative: next++ % active). NVN_WINDOW_ACQUIRE_TEXTURE_RESULT_SUCCESS
export function windowAcquire(w: usize, sync: usize, idxOut: usize): u64 {
  const n = active(w);
  const next = load<i32>(w, O.WIN_next), idx = n ? next % n : 0;
  store<i32>(w, next + 1, O.WIN_next);
  store<i32>(idxOut, idx);
  if (n) image(w, idx).step(GfxImageE.Acquire);       // refused (red) when the game still holds it
  // The image is the game's once everything committed so far has completed
  if (sync) syncFence(sync, fenceLast(), true);
  return 0;
}
export function windowPresent(w: usize, idx: i32): void {
  store<u64>(w, load<u64>(w, O.WIN_presents) + 1, O.WIN_presents);
  if (idx < 0 || idx >= load<i32>(w, O.WIN_ntex) || idx >= 4) { L.red("QueuePresentTexture index "); L.i(idx); L.end(); return; }
  const t = <usize>load<u64>(w + O.WIN_tex + (<usize>idx << 3));
  if (!t || load<u32>(t) != O.MAGIC_TEX) { L.redLine("QueuePresentTexture: the window texture is not a live texture"); return; }
  if (!image(w, idx).step(GfxImageE.Present)) return;  // refused (red): presented without being acquired
  present(t, w + O.WIN_crop, w, idx);
}
// The replayer's reports for image idx of the window at w: 0 the blit is submitted, 1 it is done on the GPU
export function imageEvent(w: usize, idx: i32, what: i32): void {
  if (load<u32>(w) != O.MAGIC_WIN || idx < 0 || idx >= 4) return;
  const m = image(w, idx);
  if (what == 0) { m.step(GfxImageE.HostQueued); return; }
  if (!m.can(GfxImageE.Shown)) return;                 // taken again by the game in the meantime
  for (let i = 0; i < 4; i++) if (i != idx && image(w, i).state == GfxImageS.OnScreen) image(w, i).step(GfxImageE.Retire);
  m.step(GfxImageE.Shown);
}
export function imageState(w: usize, idx: i32): i32 { return image(w, idx).state; }
export function windowGetCrop(w: usize, r: usize): void {
  if (load<i32>(w, O.WIN_crop + 8) > 0 && load<i32>(w, O.WIN_crop + 12) > 0) { memory.copy(r, w + O.WIN_crop, 16); return; }
  const t = load<i32>(w, O.WIN_ntex) ? <usize>load<u64>(w, O.WIN_tex) : 0;
  store<i32>(r, 0); store<i32>(r, 0, 4);
  store<i32>(r, t ? load<i32>(t, O.TEX_d + O.TD_width) : 0, 8); store<i32>(r, t ? load<i32>(t, O.TEX_d + O.TD_height) : 0, 12);
}

// ---- the present interval the host decides (nxnative hle_nvn.c present_cfg, present_itv, window_interval) ----
// On the Switch the next acquire is held for as many vertical syncs as the window's present interval, and games whose
// logic counts frames rely on it. That is the default here too (nxnative's interval mode "game"). Two things replace
// the game's interval:
//   a present cap in frames a second (gfxPresentCap): the interval is 60 / cap whatever the game set. nxnative applies
//     the profile's fps_target as that cap only while the host also writes it into the game's own frame limiter
//     (hle_fpslock.c) or steps the game through its frame-step stubs, because a game presented at a rate it does not
//     step by runs fast or slow. Neither is ported, so nothing sets the cap yet (docs/PORTING-STATUS.md);
//   the profile's present_interval display: one frame a display tick, whatever the game set (a cut nxnative makes
//     for games checked with it: their logic does not count frames).
let presentCap: i32 = 0;
export function presentCapSet(fps: i32): void { presentCap = fps == 30 || fps == 60 ? fps : 0; }
// The vertical syncs (1/60 s) a frame of window w stays on screen, which the embedder holds the next acquire for
export function presentInterval(w: usize): i32 {
  if (presentCap) return 60 / presentCap;
  if (profileHas(P_PRESENT_DISPLAY)) return 1;
  const i = load<i32>(w, O.WIN_interval);
  return i > 0 ? i : 1;
}
// nvnWindowGetPresentInterval: the game's own, except in display mode, where a game that paces itself by what it reads
// back would hold itself to the interval it asked for (nxnative: Luigi's Mansion 3 slept a vsync per interval)
export function windowInterval(w: usize): i32 { return profileHas(P_PRESENT_DISPLAY) ? presentInterval(w) : load<i32>(w, O.WIN_interval); }
