#version 450
layout(location = 0) flat in ivec4 a; layout(location = 1) flat in uvec4 b; layout(location = 0) out vec4 o;
void main() {
  int x = bitfieldExtract(a.x, 3, 5) + bitCount(a.y) + findMSB(a.z) + findLSB(a.w) + bitfieldReverse(a.x) + (a.x << 3) + (a.y >> 2) + bitfieldInsert(a.x, a.y, 4, 8);
  uint y = bitfieldExtract(b.x, 3, 5) + (b.y >> 7u) + (b.x ^ b.y) + (b.z & ~b.w) + uint(findMSB(b.x));
  o = vec4(float(x), float(y), intBitsToFloat(a.x), uintBitsToFloat(b.x)) + vec4(floatBitsToInt(o.x));
}
