#version 450
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { double d = double(v.x) * double(v.y); o = vec4(float(d)); }
