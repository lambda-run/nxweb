#version 450
// Fragment uniform slot 0 (group 0, binding 16): data[0] = tint, data[1].x = alpha below which the pixel is discarded.
// Texture slot 0, a combined sampler (group 1, binding 64; the chain puts its sampler at 65).
layout(set = 0, binding = 16) uniform C3 { vec4 data[4096]; } fp_c3;
layout(set = 1, binding = 64) uniform sampler2D fp_t0;
layout(location = 0) in vec4 i0;
layout(location = 0) out vec4 o0;
void main() {
  vec4 c = texture(fp_t0, i0.xy) * fp_c3.data[0];
  if (c.w < fp_c3.data[1].x) discard;
  o0 = c;
}
