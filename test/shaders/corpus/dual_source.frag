#version 450
layout(location = 0) in vec4 v; layout(location = 0, index = 0) out vec4 o0; layout(location = 0, index = 1) out vec4 o1;
void main() { o0 = v; o1 = v.wzyx; }
