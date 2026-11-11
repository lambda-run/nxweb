#version 450
#extension GL_KHR_shader_subgroup_ballot : require
// ballot, its bit count / bit extract / find LSB, inverse ballot, broadcast first, the lane masks and builtins (Maxwell VOTE's ballot, S2R SR_LANEID / SR_LTMASK)
layout(location = 0) in vec4 v;
layout(location = 0) out vec4 o;
void main() {
  uvec4 b = subgroupBallot(v.x > 0.5);
  uint n = subgroupBallotBitCount(b), below = subgroupBallotExclusiveBitCount(b), first = subgroupBallotFindLSB(b);
  bool mine = subgroupBallotBitExtract(b, gl_SubgroupInvocationID) && subgroupInverseBallot(b);
  float lead = subgroupBroadcastFirst(v.y);
  uint lt = gl_SubgroupLtMask.x, eq = gl_SubgroupEqMask.x;
  o = vec4(float(n + below + first + bitCount(b.x & lt) + eq), mine ? 1.0 : 0.0, lead, float(gl_SubgroupSize + gl_SubgroupInvocationID));
}
