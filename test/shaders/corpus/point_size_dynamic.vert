#version 450
layout(location = 0) in vec4 a0;
void main() { gl_Position = a0; gl_PointSize = a0.w * 4.0; }
