#version 450
#extension GL_KHR_shader_subgroup_arithmetic : require
// reductions, inclusive and exclusive scans of integers, floats and bools
layout(location = 0) flat in uvec4 a;
layout(location = 1) in vec4 v;
layout(location = 0) out uvec4 o;
layout(location = 1) out vec4 p;
void main() {
  uint x = a.x;
  o = uvec4(subgroupAdd(x) + subgroupExclusiveAdd(x) + subgroupInclusiveMul(x), subgroupMin(x) + subgroupMax(x) + subgroupExclusiveMin(x), subgroupAnd(x) | subgroupOr(x) | subgroupXor(x), subgroupInclusiveAdd(a.yz).x);
  p = vec4(subgroupAdd(v.x), subgroupExclusiveMax(v.y), subgroupMin(v.z), subgroupAnd(v.w > 0.5) ? 1.0 : 0.0);
}
