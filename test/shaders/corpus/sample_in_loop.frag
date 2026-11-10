#version 450
layout(set = 1, binding = 64) uniform sampler2D t0;
layout(location = 0) in vec4 v; layout(location = 1) flat in ivec4 n; layout(location = 0) out vec4 o;
void main() { o = vec4(0.0); for (int i = 0; i < n.x; i++) { if (o.x > v.z) break; o += texture(t0, v.xy + float(i)); } }
