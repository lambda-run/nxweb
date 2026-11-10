// Robustness: demo_frames() frames of the textured cube; the texture's texels are rewritten in its pool storage
// every fourth frame (and flushed), the present interval changes every 100 frames (1, 2, 3), nothing is resized.
#include "gfx.h"
u32 mutex_slow;
IMPORT void stress_mark(u32 frame);
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  gfx_init(CUBE_W, CUBE_H);
  cube_init();
  u32 frames = demo_frames(), f = 0, updates = 0, changes = 0; u64 t0 = svcGetSystemTick();
  for (; f < frames; f++) {
    if (f % 100 == 0) { nvnWindowSetPresentInterval(&g_win, 1 + (int)(f / 100) % 3); changes++; }
    if (f % 4 == 0) {
      // the colour bytes move on (alpha stays): what is drawn next must be the new texels
      for (u64 i = 0; i < g_cube_storage_size; i++) if ((i & 3) != 3) g_cube_storage[i] = (u8)(g_cube_storage[i] + 7 + (i & 3));
      nvnMemoryPoolFlushMappedRange(&g_texstore.obj, g_cube_storage - g_texstore.mem, g_cube_storage_size);
      updates++;
    }
    cube_matrix(g_cube_mvp, f * 0.05f, f * 0.03f);
    int i = frame_begin(1, g_bg, CUBE_W, CUBE_H);
    cube_draw();
    frame_end(i);
    if (f == frames / 10 || f == frames - 1) stress_mark(f);
  }
  nvnQueueFinish(&g_queue);
  Line l; l.n = 0;
  l_s(&l, "frames "); l_u(&l, f); l_s(&l, ", texture updates "); l_u(&l, updates); l_s(&l, ", present interval changes "); l_u(&l, changes); l_s(&l, ", guest ms "); l_u(&l, (svcGetSystemTick() - t0) / 19200); l_out(&l);
  return 0;
}
