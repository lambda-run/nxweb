#version 450
layout(location = 0) in vec4 a; layout(location = 1) flat in vec4 b; layout(location = 2) noperspective in vec4 c; layout(location = 3) centroid in vec4 d; layout(location = 4) sample in vec4 e;
layout(location = 0) out vec4 o;
void main() { o = a + b + c + d + e + vec4(interpolateAtCentroid(a.x)); }
