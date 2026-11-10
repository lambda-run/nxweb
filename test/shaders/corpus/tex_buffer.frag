#version 450
layout(set = 1, binding = 64) uniform samplerBuffer t0;
layout(location = 0) flat in ivec4 v; layout(location = 0) out vec4 o;
void main() { o = texelFetch(t0, v.x); }
