// A tiny AV1 stream for the nn::codec tests: six 64x64 temporal units (low-overhead OBUs), key frames at 0 and 3,
// BT.709 matrix, video range, each picture one flat colour (Y, U, V below). Made with libaom:
//   ffmpeg -f rawvideo -pix_fmt yuv420p -s 64x64 -r 30 -i in.yuv -c:v libaom-av1 -cpu-used 8 -g 3 -lag-in-frames 0 -crf 10
//          -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv -f ivf clip.ivf
// (in.yuv: the six flat pictures), each IVF frame one temporal unit.
export const AV1_W = 64, AV1_H = 64;
export const AV1_TUS: string[] = [
  "12000a0d00000002afff9b5f22020202083216100082800002000000001aa99a080831141fed054957",
  "1200321e300380800000468980000200002000b6c849c6e3e3f63ba280dafc3f4190",
  "1200321d300581049209468980000200002000b0cc37458ad5d15ede6aa3da0f80",
  "12000a0d00000002afff9b5f2202020208320d100083000002000000001abbb0",
  "1200321f300380800000468980000200002000bc229077b160ae00c271d99669c787e0",
  "1200321c300581049209468980000200002000b0cbc19eb8cd25c11869cd077a",
];
export const AV1_YUV: [number, number, number][] = [[81, 90, 240], [145, 54, 34], [41, 240, 110], [126, 128, 128], [81, 90, 240], [145, 54, 34]];
export const av1Packets = (): Uint8Array[] => AV1_TUS.map(h => new Uint8Array(h.match(/../g)!.map(x => parseInt(x, 16))));
