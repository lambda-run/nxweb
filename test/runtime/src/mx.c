// A guest whose shader stages are real Maxwell programs (the hand-assembled ones of tools/shaders/maxwell_asm.py,
// compiled into this module by the build as maxwell_blobs.h), handed to NVN the way a game hands over its shaders:
// control section and code area. A textured quad over the left half of the window: the vertex stage places it with
// uniform slot 0, the pixel stage samples texture slot 0 and multiplies by the colour in its uniform slot 0.
// -DBAD: the pixel stage's code area is cut off after its header (nothing can translate it).
#include "gfx.h"
#include "maxwell_blobs.h"
u32 mutex_slow;
static NVNshaderData stage(const u8 *code, u32 ncode, const u8 *ctl) {
  u8 *control = galloc(0x880, 16);
  memcpy_(control, ctl, 0x880);
  *(u32 *)(control + 0x704) = ncode;
  NVNshaderData d; d.data = data_put(code, ncode, 0); d.control = control;
  return d;
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  gfx_init(CUBE_W, CUBE_H);
  cube_texture_init();
  static NVNprogram prog;
#ifdef BAD
  NVNshaderData sd[2] = { stage(mx_vs_quad_ubo_code, sizeof mx_vs_quad_ubo_code, mx_vs_quad_ubo_ctl), stage(mx_ps_tex_tint_code, 0x30, mx_ps_tex_tint_ctl) };
#else
  NVNshaderData sd[2] = { stage(mx_vs_quad_ubo_code, sizeof mx_vs_quad_ubo_code, mx_vs_quad_ubo_ctl), stage(mx_ps_tex_tint_code, sizeof mx_ps_tex_tint_code, mx_ps_tex_tint_ctl) };
#endif
  if (!nvnProgramInitialize(&prog, &g_dev) || !nvnProgramSetShaders(&prog, 2, sd)) say("[guest] program failed");
  static const float quad[] = { -1, -1, 0, 1,   1, -1, 1, 1,   -1, 1, 0, 0,   -1, 1, 0, 0,   1, -1, 1, 1,   1, 1, 1, 0 };   // x, y, u, v
  NVNbufferAddress vb = data_put(quad, sizeof quad, 0);
  static const float vs_u[8] = { 0.5f, 1.0f, -0.5f, 0.0f, 0.5f, 0, 0, 0 };     // scale.xy, offset.xy, z
  static const float ps_u[8] = { 1.0f, 0.5f, 0.25f, 1.0f, 0.5f, 0, 0, 0 };     // tint, alpha threshold
  void *vc, *pc;   // bound with 256 bytes: at least what the translated stages' uniform types cover
  NVNbufferAddress vu = data_put(0, 256, &vc), pu = data_put(0, 256, &pc);
  memcpy_(vc, vs_u, sizeof vs_u); memcpy_(pc, ps_u, sizeof ps_u);
  u32 frames = demo_frames(), f = 0;
  for (; !frames || f < frames; f++) {
    int i = frame_begin(0, g_bg, CUBE_W, CUBE_H);
    static const NVNformat fmt[2] = { NVN_FORMAT_RG32F, NVN_FORMAT_RG32F }; static const int off[2] = { 0, 8 };
    vertex_layout(fmt, off, 2, 16);
    nvnCommandBufferBindVertexBuffer(&g_cmd, 0, vb, sizeof quad);
    nvnCommandBufferBindProgram(&g_cmd, &prog, NVN_SHADER_STAGE_VERTEX_BIT | NVN_SHADER_STAGE_FRAGMENT_BIT);
    nvnCommandBufferBindUniformBuffer(&g_cmd, NVN_SHADER_STAGE_VERTEX, 0, vu, 256);
    nvnCommandBufferBindUniformBuffer(&g_cmd, NVN_SHADER_STAGE_FRAGMENT, 0, pu, 256);
    nvnCommandBufferBindTexture(&g_cmd, NVN_SHADER_STAGE_FRAGMENT, 0, g_cube_handle);
    nvnCommandBufferDrawArrays(&g_cmd, NVN_DRAW_PRIMITIVE_TRIANGLES, 0, 6);
    frame_end(i);
  }
  nvnQueueFinish(&g_queue);
  say_u("mx: frames ", f);
  return 0;
}
