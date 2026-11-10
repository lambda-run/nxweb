// doomgeneric's platform layer for an nxweb guest: the six DG_* functions and the module's entry.
//   screen   the engine's 640x400 XRGB frame lives in an NVN memory pool; every DG_DrawFrame copies it into a
//            texture (CopyBufferToTexture) and draws it as a 4:3 rectangle in the middle of a 1280x720 window
//   input    player 1's npad (nn::hid) turned into Doom key events
//   time     svcGetSystemTick (19.2 MHz) and svcSleepThread
// The engine itself is not in this repository (tools/doom/fetch.sh); this file only includes its headers.
#define GFX_MEM_MB 28
#define GFX_TEXSTORE_MB 16
#include "gfx.h"
#include "doomgeneric.h"
#include "doomkeys.h"
#include "doomstat.h"
#include "d_loop.h"
#include "m_controls.h"

// The embedder sees every frame: the game tic it shows, where its pixels are (640x400 XRGB) and a few facts of the
// game (for tests: what a frame shows is then known without reading the picture). Non-zero: leave.
typedef struct { s32 gamestate, menuactive, demoplayback, usergame, gamemap, health, bullets, x, y; u32 angle; } DoomState;
IMPORT u32 doom_frame(u32 gametic, const u32 *pixels, const DoomState *state);

#define WIN_W 1280
#define WIN_H 720
#define KEY_NEXTWEAPON KEY_PGDN
#define KEY_PREVWEAPON KEY_PGUP

static PFNNVNCOMMANDBUFFERCOPYBUFFERTOTEXTUREPROC nvnCommandBufferCopyBufferToTexture;
static Pool g_fb;                      // the frame, read by the GPU copy
static NVNtexture g_frame_tex; static NVNsampler g_frame_samp; static NVNtextureHandle g_frame_handle;
static NVNprogram g_prog; static NVNbufferAddress g_quad_vb, g_ubo;

void DG_Init(void) {
  gfx_init(WIN_W, WIN_H);
  nvnCommandBufferCopyBufferToTexture = (PFNNVNCOMMANDBUFFERCOPYBUFFERTOTEXTUREPROC)nvnDeviceGetProcAddress(&g_dev, "nvnCommandBufferCopyBufferToTexture");
  // the engine draws straight into pool memory (the buffer doomgeneric allocated is not used)
  pool_init(&g_fb, (DOOMGENERIC_RESX * DOOMGENERIC_RESY * 4 + 4095) & ~4095u, NVN_MEMORY_POOL_FLAGS_CPU_CACHED | NVN_MEMORY_POOL_FLAGS_GPU_CACHED);
  free(DG_ScreenBuffer);
  DG_ScreenBuffer = (pixel_t *)g_fb.mem;
  texture_init(&g_frame_tex, DOOMGENERIC_RESX, DOOMGENERIC_RESY, NVN_FORMAT_BGRX8, 0, 0, 0);
  NVNsamplerBuilder sb;
  nvnSamplerBuilderSetDevice(&sb, &g_dev); nvnSamplerBuilderSetDefaults(&sb);
  nvnSamplerBuilderSetMinMagFilter(&sb, NVN_MIN_FILTER_LINEAR, NVN_MAG_FILTER_LINEAR);
  nvnSamplerBuilderSetWrapMode(&sb, NVN_WRAP_MODE_CLAMP_TO_EDGE, NVN_WRAP_MODE_CLAMP_TO_EDGE, NVN_WRAP_MODE_CLAMP_TO_EDGE);
  if (!nvnSamplerInitialize(&g_frame_samp, &sb)) say("[guest] SamplerInitialize failed");
  nvnTexturePoolRegisterTexture(&g_texpool, 256, &g_frame_tex, 0); nvnSamplerPoolRegisterSampler(&g_samppool, 256, &g_frame_samp);
  g_frame_handle = nvnDeviceGetTextureHandle(&g_dev, 256, 256);
  // a 4:3 rectangle (the picture's shape on the monitors the game was drawn for) in the 16:9 window: x, y, z, u, v
  static const float X = 0.75f;
  static const float quad[] = { -X, 1, 0, 0, 0,   X, 1, 0, 1, 0,   -X, -1, 0, 0, 1,   -X, -1, 0, 0, 1,   X, 1, 0, 1, 0,   X, -1, 0, 1, 1 };
  static const float one[16] = { 1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1 };
  g_quad_vb = data_put(quad, sizeof quad, 0);
  g_ubo = data_put(one, sizeof one, 0);
  program_init(&g_prog, "vs_cube", "fs_tex");
  nvnWindowSetPresentInterval(&g_win, 0);   // the engine paces itself: one frame per 35 Hz tic, sleeping in between
  input_init();
  // weapon change on one button: the engine has the two actions and no default key for them
  key_nextweapon = KEY_NEXTWEAPON; key_prevweapon = KEY_PREVWEAPON;
}

// ---- input ----
// Pad buttons (nn::hid NpadButton bits; the sticks' directions count as the d-pad's) to Doom keys. A button has one
// key while the game runs and may have another while a menu or a question is up; the release sends what the press sent.
enum { B_A, B_B, B_X, B_Y, B_LS, B_RS, B_L, B_R, B_ZL, B_ZR, B_PLUS, B_MINUS, B_LEFT, B_UP, B_RIGHT, B_DOWN, B_COUNT };
static const unsigned char key_game[B_COUNT] = { KEY_FIRE, KEY_USE, KEY_RSHIFT, KEY_NEXTWEAPON, 0, 0, KEY_STRAFE_L, KEY_STRAFE_R, KEY_TAB, KEY_FIRE,
  KEY_ENTER, KEY_ESCAPE, KEY_LEFTARROW, KEY_UPARROW, KEY_RIGHTARROW, KEY_DOWNARROW };
static const unsigned char key_menu[B_COUNT] = { KEY_ENTER, KEY_BACKSPACE, 0, 'y', 0, 0, 0, 0, 0, 0,
  KEY_ENTER, KEY_ESCAPE, KEY_LEFTARROW, KEY_UPARROW, KEY_RIGHTARROW, KEY_DOWNARROW };
static unsigned char sent[B_COUNT];            // the key each held button sent
static unsigned short queue[64]; static u32 q_head, q_tail;   // key | pressed << 8
static u32 held;
static void pad_poll(void) {
  static const u32 no1 = 0, handheld = 0x20;
  NpadState s; s.buttons = 0; s.lx = s.ly = s.rx = 0;
  if (nn_hid_GetNpadStyleSet(&no1) & 1) nn_hid_GetNpadStateFullKey(&s, &no1);
  else if (nn_hid_GetNpadStyleSet(&handheld) & 2) nn_hid_GetNpadStateHandheld(&s, &handheld);
  u32 now = (u32)s.buttons & 0xffff;
  if (s.lx < -12000 || s.rx < -12000) now |= 1u << B_LEFT;
  if (s.lx > 12000 || s.rx > 12000) now |= 1u << B_RIGHT;
  if (s.ly > 12000) now |= 1u << B_UP;
  if (s.ly < -12000) now |= 1u << B_DOWN;
  u32 changed = now ^ held;
  for (int b = 0; b < B_COUNT && changed; b++) {
    if (!(changed >> b & 1)) continue;
    int down = now >> b & 1;
    unsigned char key = down ? (menuactive && key_menu[b] ? key_menu[b] : key_game[b]) : sent[b];
    sent[b] = down ? key : 0;
    if (key && q_head - q_tail < 64) queue[q_head++ & 63] = (unsigned short)(key | down << 8);
  }
  held = now;
}
int DG_GetKey(int *pressed, unsigned char *key) {
  static int polled;
  if (q_head == q_tail && !polled) { pad_poll(); polled = 1; }
  if (q_head == q_tail) { polled = 0; return 0; }   // the pad is read once per round of the engine's event loop
  unsigned short e = queue[q_tail++ & 63];
  *pressed = e >> 8; *key = (unsigned char)e;
  return 1;
}

void DG_DrawFrame(void) {
  static const float black[4] = { 0, 0, 0, 1 };
  static const NVNcopyRegion all = { 0, 0, 0, DOOMGENERIC_RESX, DOOMGENERIC_RESY, 1 };
  static const NVNformat fmt[2] = { NVN_FORMAT_RGB32F, NVN_FORMAT_RG32F }; static const int off[2] = { 0, 12 };
  const player_t *pl = &players[consoleplayer];
  DoomState st = { gamestate, menuactive, demoplayback, usergame, gamemap, pl->health, pl->ammo[am_clip], pl->mo ? pl->mo->x >> 16 : 0, pl->mo ? pl->mo->y >> 16 : 0, pl->mo ? pl->mo->angle : 0 };
  if (doom_frame((u32)gametic, (const u32 *)DG_ScreenBuffer, &st)) exit(0);
  pad_poll();   // also while the engine draws without asking for events (a screen wipe takes a second): a key pressed and released then is queued
  int i = frame_begin(0, black, WIN_W, WIN_H);     // parks until the next display frame
  nvnCommandBufferCopyBufferToTexture(&g_cmd, nvnMemoryPoolGetBufferAddress(&g_fb.obj), &g_frame_tex, 0, &all, 0);
  vertex_layout(fmt, off, 2, 20);
  nvnCommandBufferBindVertexBuffer(&g_cmd, 0, g_quad_vb, 6 * 20);
  nvnCommandBufferBindProgram(&g_cmd, &g_prog, NVN_SHADER_STAGE_VERTEX_BIT | NVN_SHADER_STAGE_FRAGMENT_BIT);
  nvnCommandBufferBindUniformBuffer(&g_cmd, NVN_SHADER_STAGE_VERTEX, 0, g_ubo, 64);
  nvnCommandBufferBindTexture(&g_cmd, NVN_SHADER_STAGE_FRAGMENT, 0, g_frame_handle);
  nvnCommandBufferDrawArrays(&g_cmd, NVN_DRAW_PRIMITIVE_TRIANGLES, 0, 6);
  frame_end(i);
}

// Time: milliseconds since the start, from the 19.2 MHz system tick. Never 0: the engine takes the first value it
// sees as its time base unless that is 0, so with 1 as the first value its 35 Hz tic count is tic_now() below.
static u64 tick0;
static u64 ticks(void) { u64 t = svcGetSystemTick(); if (!tick0) tick0 = t; return t - tick0; }
void DG_SleepMs(uint32_t ms) { svcSleepThread((s64)ms * 1000000); }
uint32_t DG_GetTicksMs(void) { return (uint32_t)(ticks() / 19200) + 1; }
static u32 tic_now(void) { return (u32)(ticks() / 19200) * 35 / 1000; }
// Sleeps until the engine's clock shows tic k (not at all when it already does)
static void sleep_until_tic(u32 k) {
  s64 ns = (s64)(((u64)k * 1000 + 34) / 35) * 1000000 - (s64)(ticks() * 625 / 12);
  if (ns > 0) svcSleepThread(ns);
}
void DG_SetWindowTitle(const char *title) { }

// More command line arguments from the embedder, separated by spaces ("-timedemo demo1"); returns their length
IMPORT u32 doom_args(char *buf, u32 cap);

int rt_entry(u64 x0, Handle main_thread) {
  static char *argv[16] = { "doom", "-iwad", "rom:/doom1.wad" };
  static char more[256];
  int argc = 3;
  set_self_handle(main_thread);
  u32 n = doom_args(more, sizeof more - 1);
  more[n < sizeof more ? n : sizeof more - 1] = 0;
  for (char *p = more; *p && argc < 15; ) {
    while (*p == ' ') *p++ = 0;
    if (!*p) break;
    argv[argc++] = p;
    while (*p && *p != ' ') p++;
  }
  ticks();
  doomgeneric_Create(argc, argv);
  // One round runs the tics that are due and draws a frame. Called again before the next tic is due, the engine
  // would poll in 1 ms sleeps, give up at the tic boundary and draw the same picture again before it runs the tic
  // (two frames per tic); so the thread sleeps here until the boundary: one frame per tic, one sleep per frame.
  for (;;) {
    u32 entered = tic_now();
    doomgeneric_Tick();
    if (!singletics) sleep_until_tic(entered + 1);
  }
}
