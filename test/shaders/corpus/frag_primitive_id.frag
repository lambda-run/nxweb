#version 450
layout(location = 0) out vec4 o;
void main() { o = vec4(float(gl_PrimitiveID)); }
