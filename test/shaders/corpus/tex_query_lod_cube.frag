#version 450
layout(set = 1, binding = 64) uniform samplerCube t0;
layout(set = 1, binding = 66) uniform sampler2DArray t1;
layout(set = 1, binding = 68) uniform sampler3D t2;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(textureQueryLod(t0, v.xyz), textureQueryLod(t1, v.xy) + textureQueryLod(t2, v.xyz)); }
