#version 450
// A discard in a branch, then an implicit-derivative sample: WGSL demotes the fragment to a helper, the derivative stays defined
layout(set = 1, binding = 64) uniform sampler2D t0;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { if (v.w < 0.5) discard; o = texture(t0, v.xy); }
