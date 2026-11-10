#version 450
layout(set = 1, binding = 64) uniform sampler2D t0;
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() {
  vec2 uv = mix(v.xy, vec2(0.0), isnan(v.xy));
  o = texture(t0, uv) + textureLod(t0, uv, v.z) + textureGrad(t0, uv, dFdx(uv), dFdy(uv)) + texture(t0, uv, 1.5) + textureOffset(t0, uv, ivec2(1, -1))
    + texelFetch(t0, ivec2(uv * 4.0), 0) + vec4(textureSize(t0, 0), textureQueryLevels(t0), 0) + textureGather(t0, uv, 2) + textureProj(t0, v.xyw);
}
