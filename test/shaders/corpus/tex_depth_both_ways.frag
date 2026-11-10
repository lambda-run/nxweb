#version 450
// One depth texture compared in one place and read as a number in another (two bindings in the translator's output, one slot in NVN)
layout(set = 1, binding = 64) uniform sampler2DShadow cmp; layout(set = 1, binding = 66) uniform sampler2D raw;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(texture(cmp, v.xyz), texture(raw, v.xy).x, 0, 1); }
