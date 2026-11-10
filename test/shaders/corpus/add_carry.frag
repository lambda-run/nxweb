#version 450
layout(location = 1) flat in uvec4 b; layout(location = 0) out vec4 o;
void main() { uint c, d; uint s = uaddCarry(b.x, b.y, c); uint t = usubBorrow(b.x, b.y, d); o = vec4(float(s), float(c), float(t), float(d)); }
