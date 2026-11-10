#version 450
layout(set = 0, binding = 16) uniform C3 { vec4 data[4096]; } fp_c3;
layout(location = 0) in vec4 v; layout(location = 1) flat in ivec4 n; layout(location = 0) out vec4 o;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < n.x; i++) { if (fp_c3.data[i].w < 0.0) continue; acc += fp_c3.data[i]; if (acc.x > 10.0) break; }
  switch (n.y) { case 0: acc.x += 1.0; break; case 1: acc.y += 1.0; case 2: acc.z += 1.0; break; default: acc.w += 1.0; }
  int k = 0; do { acc.x *= 0.5; k++; } while (k < n.z);
  if (acc.w < fp_c3.data[1].x) discard;
  o.x = acc.x; o.y = acc.y; o.z = acc.z; o.w = acc.w;
}
