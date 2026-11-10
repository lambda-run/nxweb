#version 450
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() {
  float a = fma(v.x, v.y, v.z) + min(v.x, v.y) + max(v.z, v.w) + clamp(v.x, 0.0, 1.0) + roundEven(v.x) + trunc(v.y) + inversesqrt(v.z) + exp2(v.x) + log2(v.y) + pow(v.x, v.y)
    + sign(v.z) + floor(v.x) + ceil(v.y) + fract(v.z) + abs(v.w) + sin(v.x) + cos(v.y) + sqrt(v.z) + mix(v.x, v.y, v.z > 0.0) + float(int(v.x)) + float(uint(v.y)) + mod(v.x, v.y);
  o = vec4(a, isinf(v.x) ? 1.0 : 0.0, isnan(v.y) ? 1.0 : 0.0, 1.0);
}
