#version 450
// nxnative's local change to the translator: texel offsets read from a register are passed as Offset, not ConstOffset
layout(set = 1, binding = 64) uniform sampler2D t0;
layout(location = 0) in vec4 v; layout(location = 1) flat in ivec4 off; layout(location = 0) out vec4 o;
void main() { o = textureGatherOffset(t0, v.xy, off.xy, 3); }
