// nxweb graphics glue: NVN format numbers (nxnative include/nvn.h NVNformat) to WebGPU. A table, no decisions.
// tex: GPUTextureFormat; bpb/bw/bh: bytes per block and block size in texels; kind: what a shader output or clear
// writing it must be; vtx: GPUVertexFormat when the format can describe a vertex attribute.
export interface NvnFormat { tex?: string; bpb: number; bw: number; bh: number; kind: "float" | "uint" | "sint" | "depth"; stencil?: boolean; vtx?: string }
const F = (tex: string | undefined, bpb: number, vtx?: string, kind: NvnFormat["kind"] = "float", bw = 1, bh = 1, stencil = false): NvnFormat => ({ tex, bpb, bw, bh, kind, vtx, stencil });

export const NVN_FORMATS: Record<number, NvnFormat> = {
  0x01: F("r8unorm", 1, undefined), 0x02: F("r8snorm", 1), 0x03: F("r8uint", 1, undefined, "uint"), 0x04: F("r8sint", 1, undefined, "sint"),
  0x05: F("r16float", 2), 0x08: F("r16uint", 2, undefined, "uint"), 0x09: F("r16sint", 2, undefined, "sint"),
  0x0a: F("r32float", 4, "float32"), 0x0b: F("r32uint", 4, "uint32", "uint"), 0x0c: F("r32sint", 4, "sint32", "sint"),
  0x0d: F("rg8unorm", 2, "unorm8x2"), 0x0e: F("rg8snorm", 2, "snorm8x2"), 0x0f: F("rg8uint", 2, "uint8x2", "uint"), 0x10: F("rg8sint", 2, "sint8x2", "sint"),
  0x11: F("rg16float", 4, "float16x2"), 0x12: F(undefined, 4, "unorm16x2"), 0x13: F(undefined, 4, "snorm16x2"), 0x14: F("rg16uint", 4, "uint16x2", "uint"), 0x15: F("rg16sint", 4, "sint16x2", "sint"),
  0x16: F("rg32float", 8, "float32x2"), 0x17: F("rg32uint", 8, "uint32x2", "uint"), 0x18: F("rg32sint", 8, "sint32x2", "sint"),
  0x22: F(undefined, 12, "float32x3"), 0x23: F(undefined, 12, "uint32x3", "uint"), 0x24: F(undefined, 12, "sint32x3", "sint"),
  0x25: F("rgba8unorm", 4, "unorm8x4"), 0x26: F("rgba8snorm", 4, "snorm8x4"), 0x27: F("rgba8uint", 4, "uint8x4", "uint"), 0x28: F("rgba8sint", 4, "sint8x4", "sint"),
  0x29: F("rgba16float", 8, "float16x4"), 0x2a: F(undefined, 8, "unorm16x4"), 0x2b: F(undefined, 8, "snorm16x4"), 0x2c: F("rgba16uint", 8, "uint16x4", "uint"), 0x2d: F("rgba16sint", 8, "sint16x4", "sint"),
  0x2e: F("rgba32float", 16, "float32x4"), 0x2f: F("rgba32uint", 16, "uint32x4", "uint"), 0x30: F("rgba32sint", 16, "sint32x4", "sint"),
  0x31: F("stencil8", 1, undefined, "uint", 1, 1, true),
  0x32: F("depth16unorm", 2, undefined, "depth"), 0x33: F("depth24plus", 4, undefined, "depth"), 0x34: F("depth32float", 4, undefined, "depth"),
  0x35: F("depth24plus-stencil8", 4, undefined, "depth", 1, 1, true), 0x36: F("depth32float-stencil8", 8, undefined, "depth", 1, 1, true),
  0x37: F("rgba8unorm-srgb", 4), 0x38: F("rgba8unorm-srgb", 4),
  0x3d: F("rgb10a2unorm", 4, "unorm10-10-10-2"), 0x3e: F("rgb10a2uint", 4, undefined, "uint"), 0x3f: F("rg11b10ufloat", 4), 0x40: F("rgb9e5ufloat", 4),
  0x41: F("bc1-rgba-unorm", 8, undefined, "float", 4, 4), 0x42: F("bc1-rgba-unorm", 8, undefined, "float", 4, 4), 0x43: F("bc2-rgba-unorm", 16, undefined, "float", 4, 4), 0x44: F("bc3-rgba-unorm", 16, undefined, "float", 4, 4),
  0x45: F("bc1-rgba-unorm-srgb", 8, undefined, "float", 4, 4), 0x46: F("bc1-rgba-unorm-srgb", 8, undefined, "float", 4, 4), 0x47: F("bc2-rgba-unorm-srgb", 16, undefined, "float", 4, 4), 0x48: F("bc3-rgba-unorm-srgb", 16, undefined, "float", 4, 4),
  0x49: F("bc4-r-unorm", 8, undefined, "float", 4, 4), 0x4a: F("bc4-r-snorm", 8, undefined, "float", 4, 4), 0x4b: F("bc5-rg-unorm", 16, undefined, "float", 4, 4), 0x4c: F("bc5-rg-snorm", 16, undefined, "float", 4, 4),
  0x4d: F("bc7-rgba-unorm", 16, undefined, "float", 4, 4), 0x4e: F("bc7-rgba-unorm-srgb", 16, undefined, "float", 4, 4), 0x4f: F("bc6h-rgb-float", 16, undefined, "float", 4, 4), 0x50: F("bc6h-rgb-ufloat", 16, undefined, "float", 4, 4),
  0x6d: F("rgba8unorm", 4), 0x99: F("bgra8unorm", 4), 0x9a: F("bgra8unorm", 4), 0x9b: F("bgra8unorm-srgb", 4), 0x9c: F("bgra8unorm-srgb", 4),
};

// NVN enums to WebGPU names, indexed by the NVN value
export const COMPARE = [undefined, "never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];
export const STENCIL_OP = [undefined, "keep", "zero", "replace", "increment-clamp", "decrement-clamp", "invert", "increment-wrap", "decrement-wrap"];
export const BLEND_EQ = [undefined, "add", "subtract", "reverse-subtract", "min", "max"];
export const BLEND_FUNC: Record<number, string> = {
  1: "zero", 2: "one", 3: "src", 4: "one-minus-src", 5: "src-alpha", 6: "one-minus-src-alpha", 7: "dst-alpha", 8: "one-minus-dst-alpha", 9: "dst", 10: "one-minus-dst",
  11: "src-alpha-saturated", 0x10: "src1", 0x11: "one-minus-src1", 0x12: "src1-alpha", 0x13: "one-minus-src1-alpha",
  0x61: "constant", 0x62: "one-minus-constant", 0x63: "constant", 0x64: "one-minus-constant",
};
export const TOPOLOGY: Record<number, string> = { 0: "point-list", 1: "line-list", 3: "line-strip", 4: "triangle-list", 5: "triangle-strip" };
export const WRAP = ["clamp-to-edge", "repeat", "mirror-repeat", "mirror-repeat", "mirror-repeat", "clamp-to-edge", "mirror-repeat", "clamp-to-edge"];
