#version 450
// An implicit-derivative sample under a condition that is not uniform: WGSL's derivative uniformity analysis
layout(set = 1, binding = 64) uniform sampler2D t0;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(0.0); if (v.w > 0.5) o = texture(t0, v.xy); }
