#version 450
layout(set = 1, binding = 64) uniform sampler3D t0; layout(set = 1, binding = 66) uniform samplerCube t1; layout(set = 1, binding = 68) uniform sampler2DArray t2;
layout(set = 1, binding = 70) uniform samplerCubeArray t3; layout(set = 1, binding = 72) uniform samplerCubeShadow t4; layout(set = 1, binding = 74) uniform sampler2DArrayShadow t5;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = texture(t0, v.xyz) + texture(t1, v.xyz) + texture(t2, v.xyz) + texture(t3, v) + vec4(texture(t4, v)) + vec4(texture(t5, v)); }
