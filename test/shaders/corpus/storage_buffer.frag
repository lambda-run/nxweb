#version 450
layout(set = 3, binding = 20, std430) buffer S0 { uint data[]; } fp_s0;
layout(location = 0) flat in ivec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(float(fp_s0.data[v.x])); }
