#version 450
layout(set = 1, binding = 64) uniform sampler1D t0;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = texture(t0, v.x); }
