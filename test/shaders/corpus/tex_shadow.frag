#version 450
layout(set = 1, binding = 66) uniform sampler2DShadow s1;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(texture(s1, v.xyz), textureLod(s1, v.xyz, 0.0), textureGather(s1, v.xy, v.z).x, 1.0); }
