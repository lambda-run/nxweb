// (4) Two threads: the main thread renders, a second thread computes the uniform data. Each frame the renderer
// signals `go`, the updater writes the matrix under a mutex and signals `ready`, and the renderer records and submits
// with the mutex held. What is drawn in frame n depends only on n.
#include "gfx.h"
u32 mutex_slow;
static u8 stack[0x8000] __attribute__((aligned(16)));
static Thread updater;
static Handle go_w, go_r, ready_w, ready_r;
static Mutex um; static volatile u32 frame_no, quit, updates;

static void update_fn(void *arg) {
  for (;;) {
    s32 idx;
    svcWaitSynchronization(&idx, &go_r, 1, -1); svcResetSignal(go_r);
    if (quit) return;
    mutex_lock(&um);
    cube_matrix(g_cube_mvp, frame_no * 0.07f, 0.4f + frame_no * 0.02f);
    updates++;
    mutex_unlock(&um);
    svcSignalEvent(ready_w);
  }
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  gfx_init(CUBE_W, CUBE_H);
  cube_init();
  input_init(); input_read(); input_read();
  svcCreateEvent(&go_w, &go_r); svcCreateEvent(&ready_w, &ready_r);
  thread_start(&updater, update_fn, 0, stack + sizeof stack, 44, 1);
  u32 frames = demo_frames();
  for (u32 f = 0; !frames || f < frames; f++) {
    s32 idx;
    frame_no = f;
    svcSignalEvent(go_w);
    svcWaitSynchronization(&idx, &ready_r, 1, -1); svcResetSignal(ready_r);
    mutex_lock(&um);
    int i = frame_begin(1, g_bg, CUBE_W, CUBE_H);
    cube_draw();
    frame_end(i);
    mutex_unlock(&um);
  }
  quit = 1; svcSignalEvent(go_w);
  thread_join(&updater);
  nvnQueueFinish(&g_queue);
  Line l; l.n = 0;
  l_s(&l, "cube2: "); l_u(&l, frame_no + 1); l_s(&l, " frames, "); l_u(&l, updates); l_s(&l, " uniform updates by the second thread"); l_out(&l);
  return 0;
}
