#version 450
// Shader local memory (Maxwell LD / ST on l[]): a private array of words indexed at run time
layout(location = 0) flat in ivec4 v; layout(location = 0) out vec4 o;
uint mem[16];
void main() { for (int i = 0; i < 16; i++) mem[i] = uint(i * v.x); o = vec4(float(mem[v.y & 15]), uintBitsToFloat(mem[v.z & 15]), 0, 1); }
