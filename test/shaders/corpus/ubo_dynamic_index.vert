#version 450
// A computed index (a skinning palette): the array cannot be shrunk
layout(set = 0, binding = 1) uniform C4 { vec4 data[4096]; } vp_c4;
layout(location = 0) in vec4 a0; layout(location = 2) in ivec4 bone;
void main() { int i = bone.x * 3; gl_Position = vec4(dot(a0, vp_c4.data[i]), dot(a0, vp_c4.data[i + 1]), dot(a0, vp_c4.data[i + 2]), 1.0); }
