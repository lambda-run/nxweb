// nn::ndve, the movie enhancement network: no SDK take-over (nxnative has none either). It is a Nintendo library linked into the game's main
// (nn::ndve::RouleauArchiveIO reads Movie/Ndve/Ndve-Nvn2-vid_seq5.dat) that runs its network as the game's own NVN compute dispatches, 14 a movie
// frame. These are the model's shader keys in dispatch order (nxnative dm/gfx/nvn/nvn_ndve.inc k_ndve_keys). They are tied to the library's model,
// not to one game: any game that ships it runs these keys. Here they only name the shaders in the log; the dispatches run as translated
export const NDVE_KEYS = ["49dff010b9832251", "ba079f68ae288dba", "a8b4fb48fee0ccf8", "e2eebd7ba18fe35f", "e6be82d835fbe4d3", "9442573ee4ace011",
  "0a56002cdc7e1fce", "0a56002cdc7e1fce", "d15370a382630d4e", "e6be82d835fbe4d3", "7f7ff0f36b54d90f", "a8b4fb48fee0ccf8", "5a7d69b067a7f011", "4f41ccf24f163e0d"];

// what a key does in the network, or null when it is not one of the model's
export function ndveRole(key: string): string | null {
  const i = NDVE_KEYS.indexOf(key);
  if (i < 0) return null;
  const at = NDVE_KEYS.reduce((a, k, j) => k === key ? [...a, j + 1] : a, [] as number[]).join(" and ");
  const what = i === 0 ? "the colour conversion (NV12 to RGBA8)" : i === 12 ? "the U-Net's last convolution, added to the picture, into an RGB10A2 image"
    : i === 13 ? "the resampler (4/3, to 2560x1440)" : "a U-Net layer (HMMA.16816.F16 convolutions over the picture packed 2x2 at 960x540)";
  return `nn::ndve's movie network, dispatch ${at} of 14: ${what}`;
}

// ?ndve=bypass (off by default), a diagnostic stand-in: when the network's dispatches cannot run (a shader not yet translated, failed, or a pipeline
// that did not build; nxweb has no HMMA lowering), the movie picture is resampled bilinearly into the image the network's last dispatch (the resampler)
// writes, so the rest of the frame (HUD, present) has a picture. It is not the network's picture: nxnative runs the network as host kernels
// (docs/ndve.md). The bindings are the model's, as nxnative's nvn_ndve.inc reads them: the first U-Net layer reads the picture at compute texture slot 1,
// the last convolution adds the picture at slot 4, the resampler writes image slot 1 and flips rows when push constant word 19 is set (row base: word 18)
export const NDVE_PICTURE_SLOT = 1, NDVE_ADDED_SLOT = 4, NDVE_OUTPUT_IMAGE = 1, NDVE_FLIP_ON = 19, NDVE_FLIP_BASE = 18;
export class NdveBypass {
  readonly keys: readonly string[];
  pic = 0;          // serial of this frame's picture (the network's input), 0 none seen yet
  rgb = 0;                // serial of the one colour texture the colour conversion reads when the host's decoder hands it an RGB picture, 0 none
  luma = 0; chroma = 0;   // serials of the decoder's NV12 planes the colour conversion (dispatch 1) reads, 0 not seen: the host sets them
  broken = 0;       // dispatches of this frame's network before the resampler that could not run
  frames = 0;       // frames the stand-in wrote
  converted = false; // this frame's colour conversion ran: the picture holds the movie frame (else the stand-in converts the planes itself)
  constructor(keys: readonly string[] = NDVE_KEYS) { this.keys = keys; }
  // the dispatch's place in the model (by key: the colour conversion, the first and last convolutions and the resampler are keys of their own), -1 not the model's
  pos(key: string): number { return this.keys.indexOf(key); }
  // there is something to resample: the picture, or (when the colour conversion did not run) the decoder's two planes
  source(): boolean { return this.pic > 0 || this.rgb > 0 || this.luma > 0 && this.chroma > 0; }
  // the resampler (pos) is about to run: true when this frame's network did not run, so the stand-in writes its output instead
  replaces(pos: number): boolean {
    if (pos !== this.keys.length - 1 || !this.broken || !this.source()) return false;
    this.broken = 0; return true;
  }
  // a dispatch of the model went by (ran: it ran; tex: the serial bound at a texture slot). True when the stand-in writes the output now (the resampler could not run)
  saw(pos: number, ran: boolean, tex: (slot: number) => number): boolean {
    const last = this.keys.length - 1;
    if (pos === 0) { this.pic = 0; this.broken = ran ? 0 : 1; this.converted = ran; return false; }
    if (pos === 1) this.pic = tex(NDVE_PICTURE_SLOT) || this.pic;
    else if (pos === last - 1 && !this.pic) this.pic = tex(NDVE_ADDED_SLOT);
    if (pos < last) { if (!ran) this.broken++; return false; }
    const take = !ran && this.source();
    this.broken = 0; return take;
  }
}
