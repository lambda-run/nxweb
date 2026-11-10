#version 450
layout(early_fragment_tests) in;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = v; }
