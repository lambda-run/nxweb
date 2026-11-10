#version 450
// Not the translator's shape (it has no matrices), but hand-written host shaders have it
layout(set = 0, binding = 0) uniform U { mat4 mvp; vec3 tint; float k; } u;
layout(location = 0) in vec3 pos; layout(location = 0) out vec4 o0;
void main() { gl_Position = u.mvp * vec4(pos, 1.0); o0 = vec4(u.tint, u.k); }
