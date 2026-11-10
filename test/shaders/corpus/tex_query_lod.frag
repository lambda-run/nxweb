#version 450
layout(set = 1, binding = 64) uniform sampler2D t0;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(textureQueryLod(t0, v.xy), 0, 1); }
