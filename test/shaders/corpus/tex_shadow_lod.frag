#version 450
// QueryHostSupportsTextureShadowLod is answered true in nxnative: a shadow sample with an explicit level that is not 0
layout(set = 1, binding = 66) uniform sampler2DShadow s1;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(textureLod(s1, v.xyz, v.w)); }
