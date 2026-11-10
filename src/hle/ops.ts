// The interpreter of the bodies tools/hle_names.py compiles from nxnative's C text: take-overs that only store
// constants through their pointer arguments, bind or signal a SystemEvent, hold the game out of focus as a library
// applet does, and return a constant.
import { X, P, red, ls, ps, pz, le } from "./base";
import { OPS, STRINGS } from "./gen/table";
import { seBind, seSignal } from "./sysevent";
import { appletEnter, appletLeave } from "./oe";
import { setErrno } from "./net";

const SEEN: usize = memory.data(1024);   // one byte per entry: its red line was logged
export function opsInit(): void { memory.fill(SEEN, 0, 1024); }

export function runOps(id: i32, off: u32, a: usize): u64 {
  let p = OPS + (<usize>off << 2);
  let applets = 0;
  for (;;) {
    const op = load<u32>(p);
    switch (op) {
      case 1: {   // store: [arg | size << 8 | nullcheck << 16, lo, hi]
        const w = load<u32>(p, 4), ptr = P(a, w & 0xFF), size = (w >> 8) & 0xFF;
        const v = <u64>load<u32>(p, 8) | (<u64>load<u32>(p, 12) << 32);
        if (ptr || !(w >> 16)) {
          if (size == 1) store<u8>(ptr, <u8>v); else if (size == 2) store<u16>(ptr, <u16>v); else if (size == 4) store<u32>(ptr, <u32>v); else store<u64>(ptr, v);
        }
        p += 16; break;
      }
      case 2: memory.fill(P(a, load<u32>(p, 4)), 0, load<u32>(p, 8)); p += 12; break;
      case 3: appletEnter(STRINGS + load<u32>(p, 4)); applets++; p += 8; break;
      case 4: {
        if (id < 1024 && !load<u8>(SEEN + <usize>id)) { store<u8>(SEEN + <usize>id, 1); ls(); pz(STRINGS + load<u32>(p, 4)); le(); }
        p += 8; break;
      }
      case 5: setErrno(<i32>load<u32>(p, 4)); p += 8; break;
      case 6: seBind(P(a, load<u32>(p, 4)), <i32>load<u32>(p, 8)); p += 12; break;
      case 7: seSignal(P(a, load<u32>(p, 4))); p += 8; break;
      case 8: {
        while (applets--) appletLeave();
        return <u64>load<u32>(p, 4) | (<u64>load<u32>(p, 8) << 32);
      }
      case 9: {
        while (applets--) appletLeave();
        return <u64>(STRINGS + load<u32>(p, 4));
      }
      default: red("hle: bad op word"); return 0;
    }
  }
  return 0;
}
