#version 450
#extension GL_KHR_shader_subgroup_vote : require
#extension GL_KHR_shader_subgroup_basic : require
// Maxwell VOTE.ALL / .ANY / .EQ, and elect
layout(location = 0) in vec4 v;
layout(location = 0) out vec4 o;
void main() {
  bool p = v.x > 0.5;
  o = vec4(subgroupAll(p) ? 1.0 : 0.0, subgroupAny(p) ? 1.0 : 0.0, subgroupAllEqual(p) ? 1.0 : 0.0, (subgroupElect() ? 1.0 : 0.0) + (subgroupAllEqual(v.w) ? 2.0 : 0.0));
}
