#version 450
layout(set = 3, binding = 24, r32ui) uniform uimage2D i0;
layout(location = 0) flat in ivec4 v; layout(location = 0) out vec4 o;
void main() { uint x = imageLoad(i0, v.xy).x; imageStore(i0, v.xy, uvec4(x + 1u)); o = vec4(float(x)); }
