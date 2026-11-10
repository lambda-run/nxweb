#version 450
// The end-to-end scene's vertex shader, written the way the translator writes one: the uniform slot as an array of vec4 read component by component.
// Uniform slot 0 (group 0, binding 0): data[0] = scale.xy, offset.xy; data[1].x = z. Attribute 0 = position, 1 = uv.
layout(set = 0, binding = 0) uniform C3 { vec4 data[4096]; } vp_c3;
layout(location = 0) in vec4 a0; layout(location = 1) in vec4 a1;
layout(location = 0) out vec4 o0;
void main() {
  gl_Position.x = fma(a0.x, vp_c3.data[0].x, vp_c3.data[0].z);
  gl_Position.y = fma(a0.y, vp_c3.data[0].y, vp_c3.data[0].w);
  gl_Position.z = vp_c3.data[1].x;
  gl_Position.w = 1.0;
  o0 = vec4(a1.x, a1.y, 0.0, 1.0);
}
