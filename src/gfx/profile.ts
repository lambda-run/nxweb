// The per-game switches of the graphics module: what the game's profile turns on (nxnative dm/games game.tsv keys,
// converted by tools/prepare/convert_profiles.py and handed over by the runtime through gfx_set_profile). All off by
// default, as in nxnative: each changes what a game sees and is only right for games checked with it.
export const P_RENDER_COND: u32 = 1;        // render_cond on: SetRenderEnable(Conditional) evaluated when a submission is lowered; a timestamp report's counter field is 0
export const P_TEX_FLUSH: u32 = 2;          // tex_flush_upload on: a pool flush over a texture's storage publishes what the CPU wrote there
export const P_TEX_DIRTY: u32 = 4;          // tex_dirty_upload on: registered textures are checked for CPU writes nobody announced
export const P_TS_SEGMENT: u32 = 8;         // gpu_timestamps segment: a timestamp report takes the GPU start / end of the segment it lies in
export const P_PRESENT_DISPLAY: u32 = 16;   // present_interval display: one frame per display tick whatever interval the game sets
export const P_KNOWN: u32 = 31;

let bits: u32 = 0;
export function profileSet(b: u32): void { bits = b & P_KNOWN; }
export function profileBits(): u32 { return bits; }
// @ts-ignore: decorator
@inline export function profileHas(b: u32): bool { return (bits & b) != 0; }
