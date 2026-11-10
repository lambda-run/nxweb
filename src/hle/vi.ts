// nn::vi (display, layer, native window): port of nxnative dm/gfx/hle_vi.c. On a console the vi service opens the
// display, creates a layer and hands out the native window, which goes to NVN's window builder. Here they are three
// static objects in this module's memory (the guest can address them; nothing reads them but their magic), and what
// the layer calls decide (the layer's size, its crop) is told to the embedder's present. Constant answers (HDR, VRR,
// the panel identity, the scaling mode) are compiled from the C text.
// What nxnative leaves to the SDK's own code, and so does this table: everything of nn::vi not named in hle_vi.c
// (GetDisplayResolution, GetDisplayLogicalResolution, the layer's Z order and position calls, the indirect layers'
// producer side, SetLayerVisibility ...), nvnWindowBuilderSetNativeWindow and the window itself (dm/gfx/nvn here
// src/gfx), and the SDK's display objects behind the handles. The vsync event (GetDisplayVsyncEvent) and the indirect
// layer's image memory query are in hle_sdk16.c (sdk16.ts).
import { X, I, P, guestNs, monoNs, cfg, CFG_DISPLAY_W, CFG_DISPLAY_H, CFG_SDK_OUNCE, RES_FAIL, ls, ps, pi, pu, le, zero, zeq, sput } from "./base";
import { dmOpmode } from "./oe";

// The layer was created with a size: the present shows the picture in the layer's shape (nxnative mtl_present_layer)
// @ts-ignore: decorator
@external("env", "hle_vi_layer")
declare function envLayer(w: u32, h: u32): void;
// The layer's crop changed: the present picks these texels of the window's texture (0, 0, 0, 0: none) and stretches
// them to the layer's shape, when the game sets no window crop of its own (nvnWindowSetCrop)
// @ts-ignore: decorator
@external("env", "hle_vi_crop")
declare function envCrop(x: u32, y: u32, w: u32, h: u32): void;
// The frames the game has presented so far (nxnative dm_nvn_frame_count)
// @ts-ignore: decorator
@external("env", "hle_vi_frame_count")
declare function envFrameCount(): u64;
// The present queue: out = { u64 presents queued, u64 presents handed on to the screen } (nxnative mtl_present_progress)
// @ts-ignore: decorator
@external("env", "hle_vi_present_progress")
declare function envProgress(out: usize): void;
// When present number `ticket` reached the screen, ns on the host's monotonic clock; 0 not known (yet, or headless),
// -1 dropped by the system (nxnative mtl_presented_time)
// @ts-ignore: decorator
@external("env", "hle_vi_presented_ns")
declare function envPresentedNs(ticket: u64): i64;

const DISPLAY: usize = memory.data<u32>([0x50534944, 0]);            // 'DISP'
const LAYER: usize = memory.data<u32>([0x5259414c, 0]);              // 'LAYR'
const NATIVE: usize = memory.data<u32>([0x4e49574e, 0, 0, 0]);       // 'NWIN', then the front end's layer (none here)
let layerWH: u32 = 0;     // w | h << 16 of the last sized CreateLayer, 0 = none
let crop: u64 = 0;        // x | y << 16 | w << 32 | h << 48, 0 = none
let histLogged: bool = false, maxResLogged: bool = false, extSwapLogged: bool = false;

export function viNativeWindow(): usize { return NATIVE; }
export function viLayerSize(): u32 { return layerWH; }
export function viLayerCrop(): u64 { return crop; }

export function h_vi_OpenDisp(a: usize): u64 { store<u64>(P(a, 0), <u64>DISPLAY); return 0; }
// A display returned by ListDisplays can also be opened by name: the default display's object
export function h_vi_OpenNamedDisp(a: usize): u64 {
  const name = P(a, 1);
  if (!name || !zeq(name, "Default")) return RES_FAIL;
  return h_vi_OpenDisp(a);
}
export function h_vi_CreateLayer(a: usize): u64 { store<u64>(P(a, 0), <u64>LAYER); return 0; }
function createLayerWH(out: usize, w: i32, h: i32): u64 {
  ls(); ps("vi::CreateLayer "); pi(w); ps("x"); pi(h); le();
  store<u64>(out, <u64>LAYER);
  if (w > 0 && h > 0 && w < 0x10000 && h < 0x10000) { layerWH = <u32>w | <u32>h << 16; envLayer(<u32>w, <u32>h); }
  return 0;
}
// The overload with the layer's size (SDL3's Switch video driver: 1920x1080 docked)
export function h_vi_CreateLayerWH(a: usize): u64 { return createLayerWH(P(a, 0), I(a, 2), I(a, 3)); }
// SDK 22's overload with a LayerCreationSettings, which its constructor fills as { w, h, 2 }
export function h_vi_CreateLayerSettings(a: usize): u64 { const s = P(a, 2); return createLayerWH(P(a, 0), s ? load<i32>(s) : 0, s ? load<i32>(s, 4) : 0); }
export function h_vi_GetNative(a: usize): u64 { store<u64>(P(a, 0), <u64>NATIVE); return 0; }
// The crop is kept for the present. Logged and told only when it changes
export function h_vi_SetCrop(a: usize): u64 {
  const x = I(a, 1), y = I(a, 2), w = I(a, 3), h = I(a, 4);
  const v: u64 = x < 0 || y < 0 || w <= 0 || h <= 0 || x > 0xffff || y > 0xffff || w > 0xffff || h > 0xffff ? 0 : <u64>x | <u64>y << 16 | <u64>w << 32 | <u64>h << 48;
  if (crop != v) {
    crop = v;
    ls(); ps("vi::SetLayerCrop "); pi(x); ps(","); pi(y); ps(" "); pi(w); ps("x"); pi(h); le();
    envCrop(<u32>(v & 0xffff), <u32>((v >> 16) & 0xffff), <u32>((v >> 32) & 0xffff), <u32>(v >> 48));
  }
  return 0;
}
// Unreal Engine paces its frames by the layer's frame number: the count of frames the game has presented
export function h_vi_FrameNo(a: usize): u64 { store<u64>(P(a, 0), envFrameCount()); return 0; }

// The layer's frame history: the last 8 frames presented, newest first, each with whether it reached the screen.
// Unreal Engine 5's Switch RHI takes the first one shown as its latest flip. FrameInfo is 40 bytes: status (2 shown
// with a present time, 1 queued and not shown yet), frame number (the numbering of GetLatestFrameNumber), the queue
// tick and the present tick twice. A frame is shown once the present queue has handed it on and the system did not
// drop it; its present time is the presented time when the embedder reports one, else the time it was first seen
// handed on.
const VFH: u64 = 8;
const HIST: usize = memory.data(256, 8);   // VFH entries: u64 frame, ticket, queued guest ns, first seen guest ns
const PROG: usize = memory.data(16, 8);
// The embedder, at each present the game queues: frame = the frame count with it (nxnative dm_vi_frame_queued)
export function viFrameQueued(frame: u64): void {
  envProgress(PROG);
  const e = HIST + (<usize>(frame % VFH) << 5);
  store<u64>(e, frame); store<u64>(e, load<u64>(PROG), 8); store<u64>(e, guestNs(), 16); store<u64>(e, 0, 24);
}
function ticks(ns: u64): u64 { return cfg(CFG_SDK_OUNCE) ? ns / 32 : ns * 12 / 625; }   // as the guest's system ticks
export function h_vi_FrameHist(a: usize): u64 {
  const out = P(a, 0), n = I(a, 1);
  if (!out || n <= 0) return VFH;
  envProgress(PROG);
  const d = load<u64>(PROG, 8), gnow = guestNs(), hnow = monoNs(), latest = envFrameCount();
  let k = 0;
  for (let f = latest; f > 0 && latest - f < VFH && k < n; f--) {
    const e = HIST + (<usize>(f % VFH) << 5); if (load<u64>(e) != f) continue;
    const o = out + 40 * <usize>k; k++;
    let shown: u64 = 0;
    const ticket = load<u64>(e, 8), pt: i64 = ticket <= d ? envPresentedNs(ticket) : -1;
    if (pt > 0) { const ago: u64 = hnow > <u64>pt ? hnow - <u64>pt : 0; shown = gnow > ago ? gnow - ago : 1; }
    else if (pt == 0) { if (!load<u64>(e, 24)) store<u64>(e, gnow, 24); shown = load<u64>(e, 24); }
    store<u64>(o, shown ? 2 : 1); store<u64>(o, f, 8); store<u64>(o, ticks(load<u64>(e, 16)), 16);
    store<u64>(o, shown ? ticks(shown) : 0, 24); store<u64>(o, shown ? ticks(shown) : 0, 32);
  }
  if (k && !histLogged) { histLogged = true; ls(); ps("vi::ListFrameHistory: "); pi(k); ps(" of the last 8 presents returned (up to frame "); pu(latest); ps(", the present queue at "); pu(d); ps(")"); le(); }
  return <u64>k;
}
// DisplayInfo is 0x60 bytes: name[0x40], bool has a layer limit at +0x40, then u64 layer count limit, largest layer
// width and height. One display, "Default", as Horizon lists for an application
export function h_vi_ListDisp(a: usize): u64 {
  const p = P(a, 0), n = I(a, 1);
  if (n <= 0 || !p) return 0;
  zero(p, 0x60); sput(p, "Default");
  store<u8>(p, 1, 0x40); store<u64>(p, 1, 0x48); store<u64>(p, 1920, 0x50); store<u64>(p, 1080, 0x58);
  return 1;
}
// The largest display buffer. BufferMaxResolution is 0 1280x720, 1 1920x1080, 2 2560x1440, 3 3840x2160. Answered as a
// Switch 2 would: in handheld mode its own 1920x1080 screen; docked, the largest of the four the display it is shown
// on holds (CFG_DISPLAY_W / _H), 1920x1080 when that is not known
const RESK: usize = memory.data<i32>([1280, 720, 1920, 1080, 2560, 1440, 3840, 2160]);
export function h_vi_BufMaxRes(a: usize): u64 {
  const out = P(a, 0);
  let r: u32 = 1, w = <i32>cfg(CFG_DISPLAY_W), h = <i32>cfg(CFG_DISPLAY_H);
  if (dmOpmode() == 1 && w > 0 && h > 0) {
    if (w < h) { const t = w; w = h; h = t; }
    r = 0; for (let i: u32 = 0; i < 4; i++) if (w >= load<i32>(RESK + (<usize>i << 3)) && h >= load<i32>(RESK + (<usize>i << 3), 4)) r = i;
  } else { w = 0; h = 0; }
  if (!maxResLogged) {
    maxResLogged = true;
    ls(); ps("vi::QueryDisplayBufferMaxResolution: "); pi(load<i32>(RESK + (<usize>r << 3))); ps("x"); pi(load<i32>(RESK + (<usize>r << 3), 4));
    ps(dmOpmode() == 1 ? " (docked, display " : " (handheld, display "); pi(w); ps("x"); pi(h); ps(")"); le();
  }
  if (out) store<u32>(out, r);
  return 0;
}
// The extended swap interval asks for a presentation rate between whole vsync intervals (VRR); without VRR the swap
// interval NVN sets stays in effect
export function h_vi_ExtSwap(a: usize): u64 {
  if (!extSwapLogged) { extSwapLogged = true; ls(); ps("vi::SetLayerExtendedSwapInterval "); pi(I(a, 1)); ps(" "); pi(I(a, 2)); ps(": no VRR on the host, the NVN swap interval stays"); le(); }
  return 0;
}
export function viInit(): void { layerWH = 0; crop = 0; histLogged = false; maxResLogged = false; extSwapLogged = false; zero(HIST, 256); }
