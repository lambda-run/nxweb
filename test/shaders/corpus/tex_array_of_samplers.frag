#version 450
// The translator's shape for handles it cannot trace to one slot
layout(set = 1, binding = 64) uniform sampler2D t[8];
layout(location = 0) in vec4 v; layout(location = 1) flat in ivec4 i; layout(location = 0) out vec4 o;
void main() { o = texture(t[i.x], v.xy); }
