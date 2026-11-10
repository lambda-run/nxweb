#version 450
layout(location = 0) in vec4 a0; layout(location = 1) in ivec4 a1; layout(location = 2) in uvec4 a2;
layout(location = 0) out vec4 o0; layout(location = 1) flat out ivec4 o1; layout(location = 2) noperspective out vec4 o2;
void main() { gl_Position = a0 + vec4(float(gl_VertexIndex), float(gl_InstanceIndex), 0, 0); o0 = intBitsToFloat(a1); o1 = ivec4(a2); o2 = a0; }
