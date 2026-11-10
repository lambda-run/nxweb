// The NVN calls that wait on the GPU, with a "GPU" the test holds back (sync_hold) and lets go (sync_release_in):
// nvnSyncWait with timeout 0, a finite timeout that runs out, a finite one that is met, an infinite one; QueueFinish.
// And the functions that take or return floating point values (the sampler builder's getters).
#include "gfx.h"
u32 mutex_slow;
IMPORT void sync_hold(u32 on);           // 1: nothing submitted from now on finishes until released
IMPORT void sync_release_in(u32 ms);     // everything finishes in that many milliseconds (0: now), and from then on at once
static u64 ms_since(u64 t0) { return (svcGetSystemTick() - t0) * 625 / 12 / 1000000; }

int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  gfx_init(CUBE_W, CUBE_H);
  // float arguments in d0 and float results from d0
  PFNNVNSAMPLERBUILDERSETLODBIASPROC set_bias = (PFNNVNSAMPLERBUILDERSETLODBIASPROC)nvnDeviceGetProcAddress(&g_dev, "nvnSamplerBuilderSetLodBias");
  PFNNVNSAMPLERBUILDERGETLODBIASPROC get_bias = (PFNNVNSAMPLERBUILDERGETLODBIASPROC)nvnDeviceGetProcAddress(&g_dev, "nvnSamplerBuilderGetLodBias");
  PFNNVNSAMPLERBUILDERSETMAXANISOTROPYPROC set_aniso = (PFNNVNSAMPLERBUILDERSETMAXANISOTROPYPROC)nvnDeviceGetProcAddress(&g_dev, "nvnSamplerBuilderSetMaxAnisotropy");
  PFNNVNSAMPLERBUILDERGETMAXANISOTROPYPROC get_aniso = (PFNNVNSAMPLERBUILDERGETMAXANISOTROPYPROC)nvnDeviceGetProcAddress(&g_dev, "nvnSamplerBuilderGetMaxAnisotropy");
  static NVNsamplerBuilder sb;
  nvnSamplerBuilderSetDevice(&sb, &g_dev); nvnSamplerBuilderSetDefaults(&sb);
  set_bias(&sb, 1.25f); set_aniso(&sb, 8.0f);
  Line l; l.n = 0;
  l_s(&l, "sampler builder: lod bias x1000 = "); l_d(&l, (s64)(get_bias(&sb) * 1000.0f)); l_s(&l, ", max anisotropy x1000 = "); l_d(&l, (s64)(get_aniso(&sb) * 1000.0f)); l_out(&l);

  static NVNsync s;
  nvnSyncInitialize(&s, &g_dev);
  say_u("SyncWait on a sync that was never fenced: ", nvnSyncWait(&s, 1000000000ull));
  sync_hold(1);
  nvnQueueFenceSync(&g_queue, &s, NVN_SYNC_CONDITION_ALL_GPU_COMMANDS_COMPLETE, 0); nvnQueueFlush(&g_queue);
  say_u("fence pending, timeout 0: ", nvnSyncWait(&s, 0));
  u64 t0 = svcGetSystemTick();
  NVNsyncWaitResult r = nvnSyncWait(&s, 30000000ull);
  l_s(&l, "fence pending, timeout 30 ms: "); l_u(&l, r); l_s(&l, ms_since(t0) >= 29 && ms_since(t0) < 2000 ? ", after about 30 ms" : ", at the wrong time"); l_out(&l);
  sync_release_in(15); t0 = svcGetSystemTick();
  r = nvnSyncWait(&s, 5000000000ull);
  l_s(&l, "fence completes 15 ms into a wait of 5 s: "); l_u(&l, r); l_s(&l, ms_since(t0) >= 10 && ms_since(t0) < 2000 ? ", when it completed" : ", at the wrong time"); l_out(&l);
  say_u("the same sync again, timeout 0: ", nvnSyncWait(&s, 0));
  sync_hold(1);
  nvnQueueFenceSync(&g_queue, &s, NVN_SYNC_CONDITION_ALL_GPU_COMMANDS_COMPLETE, 0); nvnQueueFlush(&g_queue);
  sync_release_in(15); t0 = svcGetSystemTick();
  r = nvnSyncWait(&s, ~0ull);
  l_s(&l, "a new fence, infinite timeout: "); l_u(&l, r); l_s(&l, ms_since(t0) >= 10 ? ", when it completed" : ", at once"); l_out(&l);
  sync_hold(1);
  nvnQueueFenceSync(&g_queue, &s, NVN_SYNC_CONDITION_ALL_GPU_COMMANDS_COMPLETE, 0);
  sync_release_in(15); t0 = svcGetSystemTick();
  nvnQueueFinish(&g_queue);
  l_s(&l, "QueueFinish returned "); l_s(&l, ms_since(t0) >= 10 ? "when the GPU had finished" : "at once"); l_s(&l, ", the fence before it: "); l_u(&l, nvnSyncWait(&s, 0)); l_out(&l);
  return 0;
}
