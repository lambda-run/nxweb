// Controllers through the take-over table (src/hle): several players, the controller applet's prompt, vibration.
// The test changes the input sources inside pads_step() and this prints what the npads read afterwards.
#include "rt.h"
u32 mutex_slow;
typedef struct { s64 sampling; u64 buttons; s32 lx, ly, rx, ry; u32 attributes, pad; } NpadState;
IMPORT void nn_hid_InitializeNpad(void) __asm__("_ZN2nn3hid14InitializeNpadEv");
IMPORT void nn_hid_SetSupportedNpadStyleSet(u32 styles) __asm__("_ZN2nn3hid24SetSupportedNpadStyleSetENS_4util10BitFlagSetILi32ENS0_12NpadStyleTagEEE");
IMPORT void nn_hid_SetSupportedNpadIdType(const u32 *ids, u64 n) __asm__("_ZN2nn3hid22SetSupportedNpadIdTypeEPKjm");
IMPORT u32 nn_hid_GetNpadStyleSet(const u32 *id) __asm__("_ZN2nn3hid15GetNpadStyleSetERKj");
IMPORT void nn_hid_GetNpadState(NpadState *s, const u32 *id) __asm__("_ZN2nn3hid12GetNpadStateEPNS0_16NpadFullKeyStateERKj");
typedef struct { s32 count; s32 id; } SupportInfo;
typedef struct { signed char min, max; u8 rest[0x4A]; } SupportArg;
IMPORT Result nn_hid_ShowControllerSupport(SupportInfo *info, const SupportArg *arg) __asm__("_ZN2nn3hid21ShowControllerSupportEPNS0_27ControllerSupportResultInfoERKNS0_20ControllerSupportArgE");
IMPORT int nn_hid_GetVibrationDeviceHandles(u32 *handles, int n, const u32 *id, u32 style) __asm__("_ZN2nn3hid25GetVibrationDeviceHandlesEPNS0_21VibrationDeviceHandleEiRKjNS_4util10BitFlagSetILi32ENS0_12NpadStyleTagEEE");
IMPORT void nn_hid_InitializeVibrationDevice(const u32 *handle) __asm__("_ZN2nn3hid25InitializeVibrationDeviceERKNS0_21VibrationDeviceHandleE");
IMPORT void nn_hid_SendVibrationValue(const u32 *handle, const float *value) __asm__("_ZN2nn3hid18SendVibrationValueERKNS0_21VibrationDeviceHandleERKNS0_14VibrationValueE");
IMPORT u32 pads_step(u32 step);   // the test changes the sources; 0: no more steps

static void show(u32 step) {
  Line l; l.n = 0; l_s(&l, "step "); l_u(&l, step); l_c(&l, ':');
  for (u32 id = 0; id < 4; id++) {
    NpadState s; s.buttons = 0; s.lx = 0; s.attributes = 0;
    u32 style = nn_hid_GetNpadStyleSet(&id);
    nn_hid_GetNpadState(&s, &id);
    l_s(&l, " No"); l_u(&l, id + 1);
    if (!(style & 1)) { l_s(&l, " -"); continue; }
    l_s(&l, " buttons "); l_x(&l, s.buttons); l_s(&l, " lx "); l_d(&l, s.lx); l_s(&l, (s.attributes & 1) ? "" : " (not connected)");
  }
  l_out(&l);
}
int rt_entry(u64 x0, Handle main_thread) {
  static const u32 ids[4] = { 0, 1, 2, 3 };
  set_self_handle(main_thread);
  nn_hid_InitializeNpad();
  nn_hid_SetSupportedNpadStyleSet(1 /* FullKey */);
  nn_hid_SetSupportedNpadIdType(ids, 4);
  show(0);
  // two players wanted and one is there: the applet's prompt stays up until the test has connected controllers
  static SupportArg arg; static SupportInfo info;
  arg.min = 2; arg.max = 4;
  Result rc = nn_hid_ShowControllerSupport(&info, &arg);
  Line l; l.n = 0; l_s(&l, "controller applet: rc "); l_x(&l, rc); l_s(&l, ", players "); l_d(&l, info.count); l_out(&l);
  for (u32 step = 1; pads_step(step); step++) show(step);
  // player 2's motors
  u32 h[2] = { 0, 0 };
  int n = nn_hid_GetVibrationDeviceHandles(h, 2, &ids[1], 1);
  say_u("vibration handles of No2: ", (u64)n);
  if (n > 0) {
    static const float v[4] = { 0.5f, 160.0f, 0.25f, 320.0f };
    nn_hid_InitializeVibrationDevice(&h[0]);
    nn_hid_SendVibrationValue(&h[0], v);
  }
  pads_step(100);
  return 0;
}
