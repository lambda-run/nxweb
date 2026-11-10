#version 450
// The translator writes no switch (its structured output has ifs and loops only); here for completeness
layout(location = 0) flat in ivec4 n; layout(location = 0) out vec4 o;
void main() { o = vec4(0.0); switch (n.y) { case 1: o.y += 1.0; case 2: o.z += 1.0; break; default: o.w += 1.0; } }
