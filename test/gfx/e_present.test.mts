// The present interval the host decides (src/gfx/window.ts; nxnative hle_nvn.c present_itv, window_interval): what the
// acquire is held for, and what the game reads back, in each interval mode and under a present cap.
import assert from "node:assert/strict";
import { test, guest } from "./harness.mts";
import { Game } from "./nvn.mts";

const DISPLAY = 16;
test("present interval: the game's own by default (0 counts as 1); 1 with present_interval display, which the game also reads back; 60 / cap under a present cap", async () => {
  for (const display of [false, true]) {
    const g = await guest(), G = new Game(g).init(), x = g.x;
    if (display) x.gfx_set_profile(DISPLAY);
    const { win } = G.window(64, 64);
    const both = () => [x.gfx_present_interval(win), G.c("WindowGetPresentInterval", [win])];
    assert.deepEqual(both(), [1, 1], "NVN's default interval");
    const seen: number[][] = [];
    for (const itv of [2, 3, 0, 1]) { G.c("WindowSetPresentInterval", [win, itv]); seen.push(both()); }
    // [vsyncs the acquire is held for, what nvnWindowGetPresentInterval answers]
    assert.deepEqual(seen, display ? [[1, 1], [1, 1], [1, 1], [1, 1]] : [[2, 2], [3, 3], [1, 0], [1, 1]], display ? "display mode" : "game mode");
    G.c("WindowSetPresentInterval", [win, 2]);
    x.gfx_set_present_cap(30); assert.deepEqual(both(), display ? [2, 2] : [2, 2], "a cap of 30: two vsyncs a frame");
    x.gfx_set_present_cap(60); assert.deepEqual(both(), display ? [1, 1] : [1, 2], "a cap of 60: one vsync; in game mode the game still reads its own 2");
    x.gfx_set_present_cap(45); assert.deepEqual(both(), display ? [1, 1] : [2, 2], "a cap that is neither 30 nor 60 is no cap");
    x.gfx_set_present_cap(0); assert.deepEqual(both(), display ? [1, 1] : [2, 2], "no cap again");
    assert.deepEqual(g.red(), []);
  }
});
