// Services whose client a game links into its own main (nn::sf::hipc), and sessions the SDK gets from another
// service (the Switch 2's camera): port of nxnative dm/host/hle_sf.c. The host hands out sessions of its own and
// answers each request in the message buffer: success, the output zeroed, no objects or handles, for the services
// in the served list; the camera session answers as a console with none.
// Message layout (Atmosphère / libnx): HIPC header { u16 type, counts of X / A / B / W descriptors; u32 data words,
// receive list, special header flag }, the special header and descriptors, then the data words, whose CMIF part
// starts 16-byte aligned to the buffer: in a domain session the domain header first, then { "SFCI", version, command,
// token } and the arguments. The response is the same with { "SFCO", version, result, token }.
import { X, W, P, cfg, CFG_SF_TRACE, eventNew, ls, ps, pc, pz, pu, px, le, zero } from "./base";

const SF_H0: u32 = 0xd0000;   // session handles: outside the kernel handle table
const SF_MAX: u32 = 64;
const REC: usize = 32;        // +0 char name[16], +16 i32 used, +20 i32 domain, +24 u32 seen, +28 i32 answer (0 zeroed success, 1 camera)
const TAB: usize = memory.data(2048);
const NSERVED: i32 = 7;
const SERVED: usize = memory.data(56);   // 7 names of 8 bytes
let camLogged: bool = false, tableInit: bool = false;
const names: string[] = ["olsc:u", "caps:su", "caps:u", "caps:a", "caps:c", "caps:sc", "caps:ss"];
function served(k: i32): usize { return SERVED + (<usize>k << 3); }
function setup(): void {
  if (tableInit) return; tableInit = true;
  zero(SERVED, 56);
  for (let k = 0; k < NSERVED; k++) for (let i = 0; i < names[k].length; i++) store<u8>(served(k) + <usize>i, <u8>names[k].charCodeAt(i));
}
// @ts-ignore: decorator
@inline function rec(i: u32): usize { return TAB + <usize>i * REC; }
function slot(h: u32): i32 { const i = h - SF_H0; return i < SF_MAX && load<i32>(rec(i), 16) ? <i32>i : -1; }
function sfNew(name: usize, domain: i32, answer: i32): u32 {
  let i: u32 = 0; while (i < SF_MAX && load<i32>(rec(i), 16)) i++;
  if (i == SF_MAX) { ls(); ps("[RED] sf: more than 64 host service sessions: no session for "); pz(name, 15); le(); return 0; }   // nxnative stops here
  const r = rec(i);
  zero(r, 16); for (let k: usize = 0; k < 15; k++) { const c = load<u8>(name + k); if (!c) break; store<u8>(r + k, c); }
  store<i32>(r, 1, 16); store<i32>(r, domain, 20); store<u32>(r, 0, 24); store<i32>(r, answer, 28);
  return SF_H0 + i;
}
const CAMERA: usize = memory.data<u8>([0x63, 0x61, 0x6d, 0x65, 0x72, 0x61, 0]);
export function h_cam_Context(a: usize): u64 {
  const out = P(a, 0), h = sfNew(CAMERA, 0, 1);
  store<u32>(out, h);
  ls(); ps("sf: camera context -> host session "); px(h); ps(" (no camera)"); le();
  return 0;
}
export function h_sf_Connect(a: usize): u64 {
  setup();
  const out = P(a, 0), name = P(a, 1);
  for (let k = 0; k < NSERVED; k++) {
    let eq = true;   // strncmp(name, served, 8)
    for (let i: usize = 0; i < 8; i++) { const x = load<u8>(name + i), y = load<u8>(served(k) + i); if (x != y) { eq = false; break; } if (!x) break; }
    if (eq) {
      const h = sfNew(served(k), 0, 0); store<u32>(out, h);
      ls(); ps("sf: "); pz(served(k), 8); ps(" -> host session "); px(h); ps(" (every request succeeds with zeroed output)"); le();
      return 0;
    }
  }
  ls(); ps("[RED] sf: the game connects to service "); pz(name, 8); ps(" itself, which the host does not serve"); le();
  return 0xe15;   // sm ResultNotRegistered
}
function notSession(what: string, h: u32): void { ls(); ps("[RED] sf: "); ps(what); ps(" on "); px(h); ps(", not a host session"); le(); }
export function h_sf_Close(a: usize): u64 {
  const h = W(a, 0), i = slot(h);
  if (i < 0) { notSession("CloseClientSessionHandle", h); return 0; }
  store<i32>(rec(i), 0, 16);
  return 0;
}
export function h_sf_PtrBuf(a: usize): u64 {
  const h = W(a, 1);
  if (slot(h) < 0) { notSession("QueryPointerBufferSize", h); return 0x2A2; }
  store<u16>(P(a, 0), 0); return 0;
}
export function h_sf_ToDomain(a: usize): u64 {
  const h = W(a, 1), i = slot(h);
  if (i < 0) { notSession("ConvertSessionToDomain", h); return 0x2A2; }
  store<i32>(rec(i), 1, 20); store<u32>(P(a, 0), 1); return 0;
}
function dup(a: usize): u64 {
  const h = W(a, 1), i = slot(h);
  if (i < 0) { notSession("DuplicateSession", h); return 0x2A2; }
  store<u32>(P(a, 0), sfNew(rec(i), load<i32>(rec(i), 20), load<i32>(rec(i), 28))); return 0;
}
export function h_sf_Dup(a: usize): u64 { return dup(a); }
export function h_sf_DupEx(a: usize): u64 { return dup(a); }

// The camera's answers: open (3) and finalize (4) succeed, the event (21) is a kernel event that never fires, the
// rest 0x7c4 "no camera device"
let copyHandle: u32 = 0;
function cameraAnswer(cmd: u32): u32 {
  if (cmd == 3 || cmd == 4) return 0;
  if (cmd == 21) { copyHandle = eventNew(0); return 0; }
  if (cmd != 29 && !camLogged) { camLogged = true; ls(); ps("sf: camera command "); pu(cmd); ps(" answered 0x7c4 (no camera device)"); le(); }
  return 0x7c4;
}
export function h_sf_Send(a: usize): u64 {
  const h = W(a, 0), m = P(a, 1), size = X(a, 2);
  const i = slot(h);
  if (i < 0 || size < 0x40) { ls(); ps("[RED] sf: SendSyncRequest on "); px(h); ps(" ("); pu(size); ps(" bytes), not a host session"); le(); return 0xe401; }   // kernel ResultInvalidHandle
  const r = rec(i), m0 = load<u32>(m), m1 = load<u32>(m, 4);
  const type = m0 & 0xffff, nx = (m0 >> 16) & 15, nabw = ((m0 >> 20) & 15) + ((m0 >> 24) & 15) + ((m0 >> 28) & 15), ndw = m1 & 0x3ff;
  let p: usize = m + 8;
  if (m1 >> 31) { const sh = load<u32>(p); p += 4; p += <usize>((sh & 1 ? 2 : 0) + ((sh >> 1) & 15) + ((sh >> 5) & 15)) << 2; }   // special header: process ID, copy and move handles
  p += <usize>(nx * 2 + nabw * 3) << 2;
  const data: u64 = <u64>(p - m), cm: u64 = (data + 15) & ~<u64>15;
  const dom = load<i32>(r, 20) != 0 && (type == 4 || type == 6);
  const hin: u64 = cm + (dom ? 16 : 0);
  if (hin + 16 > size || data + <u64>ndw * 4 > size) { ls(); ps("[RED] sf: "); pz(r, 16); ps(": request of "); pu(ndw); ps(" data words does not fit "); pu(size); ps(" bytes"); le(); return 0xe401; }
  const dtype: u32 = dom ? load<u8>(m + <usize>cm) : 1, obj: u32 = dom ? load<u32>(m + <usize>cm, 4) : 0;
  const magic = load<u32>(m + <usize>hin), ver = load<u32>(m + <usize>hin, 4), cmd = load<u32>(m + <usize>hin, 8);
  const trace = cfg(CFG_SF_TRACE) != 0;
  if (trace) { ls(); ps("sf: "); pz(r, 16); ps(" request:"); for (let k: usize = 0; k < 0x80 && <u64>k < size; k++) { const b: u32 = load<u8>(m + k); pc(32); pc("0123456789abcdef".charCodeAt(<i32>(b >> 4))); pc("0123456789abcdef".charCodeAt(<i32>(b & 15))); } le(); }
  if (type == 2) return 0xf601;   // HIPC Close: the kernel answers the closed-session result
  if (type != 4 && type != 6) { ls(); ps("[RED] sf: "); pz(r, 16); ps(": HIPC message type "); pu(type); ps(" not served"); le(); return 0xe401; }
  if (dtype == 2) { zero(m, 16); return 0; }   // a domain object closed: nothing to answer
  if (magic != 0x49434653) { ls(); ps("[RED] sf: "); pz(r, 16); ps(": request without SFCI ("); px(magic); ps(")"); le(); return 0xe401; }
  const key = ((obj & 0xff) << 16) | (cmd & 0xffff);   // log each object / command once
  const first = load<u32>(r, 24) != key; store<u32>(r, key, 24);
  copyHandle = 0;
  const res: u32 = load<i32>(r, 28) == 1 ? cameraAnswer(cmd & 0xffff) : 0;
  const copy = copyHandle;
  if (first || trace) { ls(); ps("sf: "); pz(r, 16); ps(" object "); pu(obj); ps(" command "); pu(cmd); ps(" ("); pu(ndw); ps(" data words in): "); ps(res ? "fails" : "success, zeroed output"); if (copy) ps(", a copied handle"); le(); }
  // The response: no descriptors. Without a handle the data words start at +8; a copied handle takes a special header
  // and the handle, so they start at +0x10. The CMIF part starts at +0x10 either way
  const end: u64 = size < 0x1000 ? size : 0x1000, dw: u64 = copy ? 0x10 : 8;
  zero(m, <usize>end);
  const words = (end - dw) / 4;
  store<u32>(m, <u32>(words < 0x3ff ? words : 0x3ff), 4);
  if (copy) { store<u32>(m, load<u32>(m, 4) | 0x80000000, 4); store<u32>(m, 2, 8); store<u32>(m, copy, 12); }   // special header: 1 copy handle
  const o = m + 0x10 + (dom ? 16 : 0);
  store<u32>(o, 0x4f434653); store<u32>(o, ver, 4); store<u32>(o, res, 8); store<u32>(o, 0, 12);   // "SFCO"
  return 0;
}
export function sfInit(): void { zero(TAB, 2048); camLogged = false; }
