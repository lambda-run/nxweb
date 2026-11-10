#version 450
// The translator's uniform block: one array of 4096 vec4, read at constant indices, each component on its own
layout(set = 0, binding = 0) uniform C3 { vec4 data[4096]; } vp_c3;
layout(location = 0) in vec4 a0; layout(location = 1) in vec4 a1; layout(location = 0) out vec4 o0;
void main() { gl_Position.x = fma(a0.x, vp_c3.data[0].x, vp_c3.data[0].z); gl_Position.y = fma(a0.y, vp_c3.data[0].y, vp_c3.data[0].w); gl_Position.z = vp_c3.data[5].x; gl_Position.w = 1.0; o0.x = a1.x; o0.y = a1.y; o0.z = 0.0; o0.w = 1.0; gl_PointSize = 1.0; }
