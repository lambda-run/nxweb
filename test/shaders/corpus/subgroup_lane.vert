#version 450
#extension GL_KHR_shader_subgroup_ballot : require
// a vertex shader's warp operations: WGSL has none in vertex shaders, so the one-invocation lowering on either path
layout(location = 0) in vec4 p;
void main() {
  uvec4 b = subgroupBallot(p.x > 0.0);
  gl_Position = p * float(subgroupBallotBitCount(b) + gl_SubgroupInvocationID + gl_SubgroupSize) + vec4(subgroupBroadcastFirst(p.y));
}
