#version 450
// Maxwell's F16 instructions: the translator packs and unpacks halves in 32-bit words
layout(location = 0) in vec4 v; layout(location = 1) flat in uvec4 b; layout(location = 0) out vec4 o;
void main() { o = vec4(unpackHalf2x16(b.x), float(packHalf2x16(v.xy)), 1.0); }
