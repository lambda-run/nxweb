// A guest that calls a spread of the SDK functions the take-over table (src/hle) answers, by their real mangled
// names: nn::oe (operation mode, the focus message loop), nn::time, nn::account, nn::nifm and nn::socket (offline
// answers), libc math returning floating point, and an exit that the host starts through the lifecycle path.
#include "rt.h"
u32 mutex_slow;
typedef struct { u64 id[2]; } Uid;
typedef struct { char name[33]; } Nickname;
IMPORT void oe_Initialize(void) __asm__("_ZN2nn2oe10InitializeEv");
IMPORT int oe_GetOperationMode(void) __asm__("_ZN2nn2oe16GetOperationModeEv");
IMPORT int oe_GetPerformanceMode(void) __asm__("_ZN2nn2oe18GetPerformanceModeEv");
IMPORT int oe_GetCurrentFocusState(void) __asm__("_ZN2nn2oe20GetCurrentFocusStateEv");
IMPORT void oe_SetFocusHandlingMode(int mode) __asm__("_ZN2nn2oe20SetFocusHandlingModeENS0_17FocusHandlingModeE");
IMPORT u8 oe_TryPopNotificationMessage(u32 *out) __asm__("_ZN2nn2oe25TryPopNotificationMessageEPj");
IMPORT u32 oe_PopNotificationMessage(void) __asm__("_ZN2nn2oe22PopNotificationMessageEv");
IMPORT Result time_GetCurrentTime(s64 *posix) __asm__("_ZN2nn4time23StandardUserSystemClock14GetCurrentTimeEPNS0_9PosixTimeE");
IMPORT u64 time_ToCalendarTimeInUtc(const s64 *posix) __asm__("_ZN2nn4time19ToCalendarTimeInUtcERKNS0_9PosixTimeE");
IMPORT void account_Initialize(void) __asm__("_ZN2nn7account10InitializeEv");
IMPORT Result account_GetUserCount(int *n) __asm__("_ZN2nn7account12GetUserCountEPi");
IMPORT Result account_GetLastOpenedUser(Uid *u) __asm__("_ZN2nn7account17GetLastOpenedUserEPNS0_3UidE");
IMPORT Result account_GetNickname(Nickname *n, const Uid *u) __asm__("_ZN2nn7account11GetNicknameEPNS0_8NicknameERKNS0_3UidE");
IMPORT Result nifm_Initialize(void) __asm__("_ZN2nn4nifm10InitializeEv");
IMPORT void nifm_SubmitNetworkRequestAndWait(void) __asm__("_ZN2nn4nifm27SubmitNetworkRequestAndWaitEv");
IMPORT u8 nifm_IsNetworkAvailable(void) __asm__("_ZN2nn4nifm18IsNetworkAvailableEv");
IMPORT int socket_Socket(int domain, int type, int protocol) __asm__("_ZN2nn6socket6SocketEiii");
IMPORT int socket_GetLastErrno(void) __asm__("_ZN2nn6socket12GetLastErrnoEv");
IMPORT float sinf(float x);
IMPORT double pow(double x, double y);
IMPORT double strtod(const char *s, char **end);
IMPORT float sqrtf(float x);

int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  Line l;
  oe_Initialize();
  l.n = 0; l_s(&l, "oe: operation mode "); l_d(&l, oe_GetOperationMode()); l_s(&l, ", performance mode "); l_d(&l, oe_GetPerformanceMode()); l_s(&l, ", focus "); l_d(&l, oe_GetCurrentFocusState()); l_out(&l);
  s64 now = 0; time_GetCurrentTime(&now);
  u64 cal = time_ToCalendarTimeInUtc(&now);   // { s16 year; s8 month, day, hour, minute, second } by value
  l.n = 0; l_s(&l, "time: posix "); l_d(&l, now); l_s(&l, " = "); l_d(&l, (short)cal); l_c(&l, '-'); l_d(&l, (signed char)(cal >> 16)); l_c(&l, '-'); l_d(&l, (signed char)(cal >> 24));
  l_c(&l, ' '); l_d(&l, (signed char)(cal >> 32)); l_c(&l, ':'); l_d(&l, (signed char)(cal >> 40)); l_c(&l, ':'); l_d(&l, (signed char)(cal >> 48)); l_s(&l, " UTC"); l_out(&l);
  account_Initialize();
  int users = -1; Uid uid = { { 0, 0 } }; Nickname nick;
  Result rc = account_GetUserCount(&users) | account_GetLastOpenedUser(&uid) | account_GetNickname(&nick, &uid);
  l.n = 0; l_s(&l, "account: rc "); l_x(&l, rc); l_s(&l, ", "); l_d(&l, users); l_s(&l, " user, uid "); l_s(&l, uid.id[0] | uid.id[1] ? "set" : "ZERO"); l_s(&l, ", nickname \""); l_s(&l, nick.name); l_s(&l, "\""); l_out(&l);
  nifm_Initialize(); nifm_SubmitNetworkRequestAndWait();
  int s = socket_Socket(2, 1, 0);
  l.n = 0; l_s(&l, "network: available "); l_d(&l, nifm_IsNetworkAvailable()); l_s(&l, ", socket() = "); l_d(&l, s); l_s(&l, ", errno "); l_s(&l, socket_GetLastErrno() ? "set" : "0"); l_out(&l);
  volatile float half = 0.5f; volatile double two = 2.0;
  l.n = 0; l_s(&l, "libc: sinf(0.5) * 1e6 = "); l_d(&l, (s64)(sinf(half) * 1000000.0f)); l_s(&l, ", pow(2, 10) = "); l_d(&l, (s64)pow(two, 10.0));
  l_s(&l, ", strtod(\"3.25\") * 100 = "); l_d(&l, (s64)(strtod("3.25", 0) * 100.0)); l_s(&l, ", sqrtf(2) * 1e6 = "); l_d(&l, (s64)(sqrtf(two) * 1000000.0f)); l_out(&l);
  // the message loop: the host takes the focus away and gives it back, then asks the application to end
  oe_SetFocusHandlingMode(1);
  u32 early = 0;
  say_u("oe: messages waiting before the loop: ", oe_TryPopNotificationMessage(&early));
  say("oe: waiting for notification messages");
  for (;;) {
    u32 m = oe_PopNotificationMessage();
    l.n = 0; l_s(&l, "oe: message "); l_u(&l, m); l_s(&l, ", focus "); l_d(&l, oe_GetCurrentFocusState()); l_out(&l);
  }
}
