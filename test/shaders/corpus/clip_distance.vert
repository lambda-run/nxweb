#version 450
layout(location = 0) in vec4 a0;
void main() { gl_Position = a0; gl_ClipDistance[0] = a0.x; }
