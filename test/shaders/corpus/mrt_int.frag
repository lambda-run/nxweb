#version 450
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o0; layout(location = 1) out ivec4 o1; layout(location = 2) out uvec4 o2;
void main() { o0 = v; o1 = floatBitsToInt(v); o2 = floatBitsToUint(v); }
