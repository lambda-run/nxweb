#version 450
// infinite and NaN float constants, scalar and in vectors, in main and in a function it calls: no WGSL constant may hold one
layout(location = 0) in vec4 v;
layout(location = 0) out vec4 o;
float belowInf(float x) { return min(x, 1.0 / 0.0); }
void main() {
  o = max(min(v, vec4(1.0 / 0.0)), vec4(-1.0 / 0.0, -1.0 / 0.0, 0.0 / 0.0, -1.0 / 0.0)) + belowInf(v.x);
}
