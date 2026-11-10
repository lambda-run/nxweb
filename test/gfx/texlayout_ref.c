// Reference values for src/gfx/texlayout.ts: nxnative's nvn_tex.c over the shapes given on stdin, one per line:
//   target format flags samples width height depth levels stride pkg_block_h
// Prints: size layer_size align layers tileH tileD offset(level 1) offset(last level)
#include <stdio.h>
#include "nvn_tex.h"
int main(void) {
    nvn_texdesc d;
    while (scanf("%d %d %d %d %u %u %u %u %u %d", &d.target, &d.format, &d.flags, &d.samples, &d.width, &d.height, &d.depth, &d.levels, &d.stride, &d.pkg_block_h) == 10) {
        nvn_texlayout L; nvn_tex_layout(&d, &L);
        printf("%llu %llu %u %u %u %u %llu %llu\n", (unsigned long long)L.size, (unsigned long long)L.layer_size, L.align, L.layers, L.tileH, L.tileD,
               (unsigned long long)nvn_tex_level_offset(&d, 1), (unsigned long long)nvn_tex_level_offset(&d, d.levels ? d.levels - 1 : 0));
    }
    return 0;
}
