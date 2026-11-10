// (3) A guest that draws through NVN: frame 0 a clear, frame 1 a triangle, then a spinning textured cube whose
// rotation also follows player 1's pad. It renders demo_frames() frames (0: until the embedder stops it).
#include "gfx.h"
u32 mutex_slow;
static NVNprogram tri_prog; static NVNbufferAddress tri_vb;

int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  gfx_init(CUBE_W, CUBE_H);
  input_init();
  static const float tri[] = { 0.0f, 0.8f, 1, 0, 0,   -0.8f, -0.8f, 0, 1, 0,   0.8f, -0.8f, 0, 0, 1 };
  tri_vb = data_put(tri, sizeof tri, 0);
  program_init(&tri_prog, "vs_color", "fs_color");
  cube_init();
  u32 frames = demo_frames(), f = 0;
  static const float blue[4] = { 0.0f, 0.25f, 0.5f, 1.0f };
  for (; !frames || f < frames; f++) {
    input_read();
    if (f == 0) { int i = frame_begin(0, blue, CUBE_W, CUBE_H); frame_end(i); continue; }
    if (f == 1) {
      int i = frame_begin(0, g_bg, CUBE_W, CUBE_H);
      static const NVNformat fmt[2] = { NVN_FORMAT_RG32F, NVN_FORMAT_RGB32F }; static const int off[2] = { 0, 8 };
      vertex_layout(fmt, off, 2, 20);
      nvnCommandBufferBindVertexBuffer(&g_cmd, 0, tri_vb, sizeof tri);
      nvnCommandBufferBindProgram(&g_cmd, &tri_prog, NVN_SHADER_STAGE_VERTEX_BIT | NVN_SHADER_STAGE_FRAGMENT_BIT);
      nvnCommandBufferDrawArrays(&g_cmd, NVN_DRAW_PRIMITIVE_TRIANGLES, 0, 3);
      frame_end(i);
      continue;
    }
    if (f == 4) {
      // a fence behind everything submitted so far, and a wait for it: the thread parks until the GPU is done
      static NVNsync done;
      nvnSyncInitialize(&done, &g_dev);
      nvnQueueFenceSync(&g_queue, &done, NVN_SYNC_CONDITION_ALL_GPU_COMMANDS_COMPLETE, 0);
      nvnQueueFlush(&g_queue);
      NVNsyncWaitResult r = nvnSyncWait(&done, 1000000000ull);
      if (r == NVN_SYNC_WAIT_RESULT_TIMEOUT_EXPIRED || r == NVN_SYNC_WAIT_RESULT_FAILED) say_u("[guest] SyncWait on a fence: result ", r);
    }
    cube_matrix(g_cube_mvp, (f - 2) * 0.05f + g_turn_y, (f - 2) * 0.03f + g_turn_x);   // the uniform data, new every frame
    int i = frame_begin(1, g_bg, CUBE_W, CUBE_H);
    cube_draw();
    frame_end(i);
  }
  nvnQueueFinish(&g_queue);
  Line l; l.n = 0;
  l_s(&l, "cube: "); l_u(&l, f); l_s(&l, " frames, "); l_u(&l, g_reads); l_s(&l, " pad reads, buttons seen "); l_x(&l, g_pressed); l_out(&l);
  return 0;
}
