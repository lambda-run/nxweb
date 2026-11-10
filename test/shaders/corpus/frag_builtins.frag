#version 450
layout(location = 0) in vec4 v; layout(location = 0) out vec4 o;
void main() { o = vec4(gl_FragCoord.xy, gl_FragCoord.z, gl_FragCoord.w) + (gl_FrontFacing ? vec4(1.0) : vec4(0.0)) + vec4(dFdx(v.x), dFdy(v.y), fwidth(v.z), 0.0); gl_FragDepth = v.z; }
