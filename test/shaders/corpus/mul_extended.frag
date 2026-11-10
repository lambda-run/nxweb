#version 450
// IMUL.HI / the translator's MultiplyHigh helpers
layout(location = 0) flat in ivec4 a; layout(location = 1) flat in uvec4 b; layout(location = 0) out vec4 o;
void main() { uint hi, lo; umulExtended(b.x, b.y, hi, lo); int shi, slo; imulExtended(a.x, a.y, shi, slo); o = vec4(float(hi), float(lo), float(shi), float(slo)); }
