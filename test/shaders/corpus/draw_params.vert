#version 460
// gl_BaseVertex, gl_BaseInstance, gl_DrawID: SPIR-V BaseVertex / BaseInstance / DrawIndex, which WGSL has no builtin for
layout(location = 0) in vec4 pos;
layout(location = 0) flat out ivec3 drawParams;
void main() {
  gl_Position = pos + vec4(float(gl_InstanceIndex - gl_BaseInstance), float(gl_VertexIndex - gl_BaseVertex), 0.0, 0.0);
  drawParams = ivec3(gl_BaseVertex, gl_BaseInstance, gl_DrawID);
}
