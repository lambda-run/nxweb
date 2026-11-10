#version 450
// An integer texture read through the filtering instruction (Maxwell TEX on an integer format returns the nearest texel)
layout(set = 1, binding = 64) uniform usampler2D t1;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(texture(t1, v.xy)); }
