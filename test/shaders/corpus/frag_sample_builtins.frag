#version 450
layout(location = 0) out vec4 o;
void main() { o = vec4(float(gl_SampleID), gl_SamplePosition, float(gl_SampleMaskIn[0])); gl_SampleMask[0] = 1; }
