#version 450
#extension GL_KHR_shader_subgroup_shuffle : require
#extension GL_KHR_shader_subgroup_shuffle_relative : require
// Maxwell SHFL's four modes: IDX (shuffle), UP, DOWN, BFLY (xor)
layout(location = 0) in vec4 v;
layout(location = 0) out vec4 o;
void main() {
  uint lane = gl_SubgroupInvocationID;
  o = vec4(subgroupShuffle(v.x, (lane + 1u) & 3u), subgroupShuffleUp(v.y, 1u), subgroupShuffleDown(v.z, 1u), subgroupShuffleXor(v.w, 1u));
}
