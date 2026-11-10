#version 450
layout(set = 1, binding = 64) uniform isampler2D t0; layout(set = 1, binding = 66) uniform usampler2D t1;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(texelFetch(t0, ivec2(v.xy), 0)) + vec4(texelFetch(t1, ivec2(v.xy), 0)) + vec4(texture(t1, v.xy)); }
