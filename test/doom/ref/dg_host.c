// The reference for the Doom guest's pictures: the same engine built for the machine the tests run on, with a
// platform layer that shows nothing. It prints the checksum of the frame of every 50th game tic and the player's
// state, as test/doom/boot.ts computes them from the guest's memory. Run with the engine's -timedemo, where one tic
// is one frame whatever the clock says:   doomref -iwad doom1.wad -timedemo demo3
// (test/doom/harness.mts builds it into build/doom/ref with the host's clang and -funsigned-char: plain char is
// unsigned on AArch64, and the comparison is of the translation, not of the two ABIs.)
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include "doomgeneric.h"
#include "doomstat.h"
#include "d_loop.h"

static uint32_t now_ms = 1;
static int last_tic = -1;

void DG_Init(void) { }
void DG_DrawFrame(void) {
  if (gametic == last_tic || gametic % 50) return;
  last_tic = gametic;
  uint32_t h = 0x811c9dc5u;
  for (int i = 0; i < DOOMGENERIC_RESX * DOOMGENERIC_RESY; i++) { h ^= DG_ScreenBuffer[i]; h *= 0x01000193u; }
  const player_t *pl = &players[consoleplayer];
  printf("REF %d %08x %d %d %d %d %d\n", gametic, h, gamemap, pl->health, pl->ammo[am_clip], pl->mo ? pl->mo->x >> 16 : 0, pl->mo ? pl->mo->y >> 16 : 0);
}
void DG_SleepMs(uint32_t ms) { now_ms += ms; }
uint32_t DG_GetTicksMs(void) { return now_ms += 7; }
int DG_GetKey(int *pressed, unsigned char *key) { return 0; }
void DG_SetWindowTitle(const char *title) { }

int main(int argc, char **argv) {
  doomgeneric_Create(argc, argv);
  for (;;) doomgeneric_Tick();
}
