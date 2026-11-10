#version 450
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { int e; float m = frexp(v.x, e); float ip; float f = modf(v.y, ip); o = vec4(m, float(e), ldexp(f, e), ip); }
