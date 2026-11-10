// The SDK's movie library (movie::Decoder, movie::Extractor): nxnative dm/host/hle_movie.c decodes VP8 / VP9 with
// libvpx, H.264 with VideoToolbox and audio with stb_vorbis / AudioToolbox. Movies are CUT here: every name of that
// file is in the table as a stub (tools/hle_names.py CUT) that logs one red line and then answers as nxnative's own
// "no decoder" path does. That path exists in nxnative: a Decoder constructed with a type or output format the host
// does not decode gets the SDK's vtable and a null implementation ("every method returns failure"), and each method
// then returns its failure code: 0x1000 (0x2002 from Start, 0x2003 from Stop). The game's player sees its decoder
// fail at Configure / Start and skips the movie; nothing waits on a decoder event, because none is registered.
// Extractor::SetDataSource answers 0x1000 ("the host does not demux, opening reports failure"): the entry nxnative
// keeps under #if 0 from the time it played no movies, which is this table's case.
// The results are op words (cut_ops in the tool); the constructors and the deleting destructor are here because they
// write the object and call the game's operator delete.
import { P, guestSym, guestCall1, red } from "./base";

let vt: u64 = 0, vtRed: bool = false, delRed: bool = false;
export function movieInit(): void { vt = 0; vtRed = false; delRed = false; }
// self[0] = the SDK's vtable of movie::Decoder, self[1] = no implementation
function ctor(a: usize): u64 {
  const self = P(a, 0);
  if (!vt) { const t = guestSym("_ZTVN5movie7DecoderE"); if (t) vt = t + 0x10; }
  if (!vt && !vtRed) { vtRed = true; red("movie: the game has no vtable of movie::Decoder (nxnative ends the process here): the decoder object keeps none"); }
  if (self) { store<u64>(self, vt); store<u64>(self, 0, 8); }
  return 0;
}
export function h_movie_Decoder(a: usize): u64 { return ctor(a); }
export function h_movie_Decoder4(a: usize): u64 { return ctor(a); }
export function h_movie_Decoder3(a: usize): u64 { return ctor(a); }
export function h_movie_Decoder_C2(a: usize): u64 { return ctor(a); }
export function h_movie_Decoder4_C2(a: usize): u64 { return ctor(a); }
export function h_movie_Decoder3_C2(a: usize): u64 { return ctor(a); }
// The deleting destructor: no host object to free; the object itself goes back through the game's operator delete
export function h_movie_DecD0(a: usize): u64 {
  const del = guestSym("_ZdlPv");
  if (del) guestCall1(del, <u64>P(a, 0));
  else if (!delRed) { delRed = true; red("movie: no operator delete in the game; the decoder object is not freed"); }
  return 0;
}
