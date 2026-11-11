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
