// Prints the sizes and offsets of nxnative's guest objects and command records, compiled from its own nvn_obj.h
// (`npm run gfx:test` builds this with -I<nxnative>/dm/gfx/nvn{,/include} and compares the output with src/gfx/obj.ts).
// The names are those of obj.ts. Layouts on x86-64 and arm64 agree for these types (LP64, 8-byte pointers).
#include <stdio.h>
#include <stddef.h>
#include "nvn_obj.h"
typedef struct { NVNdevice *dev; const pool_t *pool; int64_t off; uint64_t size; } buf_builder_t;                 // hle_nvn.c
typedef struct { uint32_t magic; const pool_t *pool; uint8_t reserved[8]; int64_t off; uint64_t size; } buf_t;   // hle_nvn.c
#define S(n, T) printf(#n "_SIZE=%zu\n", sizeof(T))
#define O(n, T, f) printf(#n "_" #f "=%zu\n", offsetof(T, f))
#define R(n, T) printf("NVN_" #n "=%zu\n", sizeof(T))
int main(void) {
    S(DEVB, dev_builder_t); O(DEVB, dev_builder_t, flags);
    S(DEV, dev_t_); O(DEV, dev_t_, magic); O(DEV, dev_t_, flags); O(DEV, dev_t_, origin); O(DEV, dev_t_, depth_mode); O(DEV, dev_t_, dbg_cb); O(DEV, dev_t_, dbg_data);
    S(QB, queue_builder_t); O(QB, queue_builder_t, dev); O(QB, queue_builder_t, flags); O(QB, queue_builder_t, cmd_sz); O(QB, queue_builder_t, comp_sz); O(QB, queue_builder_t, ctl_sz);
    O(QB, queue_builder_t, flush); O(QB, queue_builder_t, mem); O(QB, queue_builder_t, mem_sz);
    S(QUEUE, queue_t); O(QUEUE, queue_t, magic); O(QUEUE, queue_t, dev); O(QUEUE, queue_t, submits); O(QUEUE, queue_t, origin_ll); O(QUEUE, queue_t, serial);
    S(PB, pool_builder_t); O(PB, pool_builder_t, dev); O(PB, pool_builder_t, mem); O(PB, pool_builder_t, size); O(PB, pool_builder_t, flags);
    S(POOL, pool_t); O(POOL, pool_t, magic); O(POOL, pool_t, flags); O(POOL, pool_t, mem); O(POOL, pool_t, size); O(POOL, pool_t, vp); O(POOL, pool_t, vmode);
    S(DPOOL, dpool_t); O(DPOOL, dpool_t, pool); O(DPOOL, dpool_t, off); O(DPOOL, dpool_t, n);
    S(BB, buf_builder_t); O(BB, buf_builder_t, dev); O(BB, buf_builder_t, pool); O(BB, buf_builder_t, off); O(BB, buf_builder_t, size);
    S(BUF, buf_t); O(BUF, buf_t, magic); O(BUF, buf_t, pool); O(BUF, buf_t, off); O(BUF, buf_t, size);
    S(TD, nvn_texdesc); O(TD, nvn_texdesc, target); O(TD, nvn_texdesc, format); O(TD, nvn_texdesc, flags); O(TD, nvn_texdesc, samples); O(TD, nvn_texdesc, width); O(TD, nvn_texdesc, height);
    O(TD, nvn_texdesc, depth); O(TD, nvn_texdesc, levels); O(TD, nvn_texdesc, stride); O(TD, nvn_texdesc, pkg_block_h);
    S(TL, nvn_texlayout); O(TL, nvn_texlayout, size); O(TL, nvn_texlayout, layer_size); O(TL, nvn_texlayout, align); O(TL, nvn_texlayout, layers); O(TL, nvn_texlayout, bpb);
    O(TL, nvn_texlayout, tileH); O(TL, nvn_texlayout, tileD);
    S(TB, tex_builder_t); O(TB, tex_builder_t, dev); O(TB, tex_builder_t, d); O(TB, tex_builder_t, pool); O(TB, tex_builder_t, off); O(TB, tex_builder_t, has_layout);
    O(TB, tex_builder_t, layout); O(TB, tex_builder_t, pkg_data); O(TB, tex_builder_t, swz);
    S(TEX, tex_t); O(TEX, tex_t, magic); O(TEX, tex_t, d); O(TEX, tex_t, has_layout); O(TEX, tex_t, swz); O(TEX, tex_t, L); O(TEX, tex_t, mem); O(TEX, tex_t, pool); O(TEX, tex_t, off);
    O(TEX, tex_t, layout); O(TEX, tex_t, serial);
    S(VIEW, view_t); O(VIEW, view_t, target); O(VIEW, view_t, base_level); O(VIEW, view_t, nlevels); O(VIEW, view_t, format); O(VIEW, view_t, min_layer); O(VIEW, view_t, nlayers); O(VIEW, view_t, swz);
    S(SP, samp_par); O(SP, samp_par, minf); O(SP, samp_par, magf); O(SP, samp_par, ws); O(SP, samp_par, wt); O(SP, samp_par, wr); O(SP, samp_par, cmp_mode); O(SP, samp_par, cmp_func);
    O(SP, samp_par, reduction); O(SP, samp_par, lod_min); O(SP, samp_par, lod_max); O(SP, samp_par, lod_bias); O(SP, samp_par, aniso); O(SP, samp_par, border);
    S(SB, samp_builder_t); O(SB, samp_builder_t, dev); O(SB, samp_builder_t, p);
    S(SAMP, samp_t); O(SAMP, samp_t, magic); O(SAMP, samp_t, p);
    S(PROG, prog_t); O(PROG, prog_t, magic); O(PROG, prog_t, nstage); O(PROG, prog_t, sd); O(PROG, prog_t, serial);
    S(SYNC, sync_t); O(SYNC, sync_t, magic);
    S(WB, win_builder_t); O(WB, win_builder_t, dev); O(WB, win_builder_t, native); O(WB, win_builder_t, ntex); O(WB, win_builder_t, interval); O(WB, win_builder_t, tex); O(WB, win_builder_t, nactive);
    S(WIN, win_t); O(WIN, win_t, magic); O(WIN, win_t, native); O(WIN, win_t, ntex); O(WIN, win_t, interval); O(WIN, win_t, next); O(WIN, win_t, crop); O(WIN, win_t, tex); O(WIN, win_t, presents);
    O(WIN, win_t, nactive);
    S(CMD, cmd_t); O(CMD, cmd_t, magic); O(CMD, cmd_t, cur); O(CMD, cmd_t, nvn_flag10); O(CMD, cmd_t, end); O(CMD, cmd_t, begin); O(CMD, cmd_t, cb); O(CMD, cmd_t, cb_data); O(CMD, cmd_t, dev);
    O(CMD, cmd_t, used); O(CMD, cmd_t, tex_base); O(CMD, cmd_t, samp_base); O(CMD, cmd_t, ctl_size); O(CMD, cmd_t, copy_row); O(CMD, cmd_t, copy_image); O(CMD, cmd_t, cmd_size);
    S(COLOR_ST, color_st); S(CHMASK_ST, chmask_st); S(BLEND_ST, blend_st); S(MS_ST, ms_st); S(POLY_ST, poly_st); S(DS_ST, ds_st); S(VA_ST, va_st); S(VS_ST, vs_st);
    S(P_SET_RT, p_set_rt); O(P_SET_RT, p_set_rt, n); O(P_SET_RT, p_set_rt, color); O(P_SET_RT, p_set_rt, cview); O(P_SET_RT, p_set_rt, has_cview); O(P_SET_RT, p_set_rt, depth);
    O(P_SET_RT, p_set_rt, dview); O(P_SET_RT, p_set_rt, has_dview);
    S(P_CLEAR_COLOR, p_clear_color); O(P_CLEAR_COLOR, p_clear_color, index); O(P_CLEAR_COLOR, p_clear_color, mask); O(P_CLEAR_COLOR, p_clear_color, rgba);
    S(P_CLEAR_DS, p_clear_ds); O(P_CLEAR_DS, p_clear_ds, depth); O(P_CLEAR_DS, p_clear_ds, depth_mask); O(P_CLEAR_DS, p_clear_ds, stencil); O(P_CLEAR_DS, p_clear_ds, stencil_mask);
    S(P_VIEWPORTS, p_viewports); O(P_VIEWPORTS, p_viewports, first); O(P_VIEWPORTS, p_viewports, n); O(P_VIEWPORTS, p_viewports, v);
    S(P_SCISSOR, p_scissor); S(P_DEPTH_RANGE, p_depth_range);
    S(P_BIND_PROGRAM, p_bind_program); O(P_BIND_PROGRAM, p_bind_program, prog); O(P_BIND_PROGRAM, p_bind_program, stages);
    O(P_BIND_STATE, p_bind_state, kind); O(P_BIND_STATE, p_bind_state, bytes);
    O(P_BIND_VATTR, p_bind_vattr, st); O(P_BIND_VSTREAM, p_bind_vstream, st); O(P_BIND_VBUF, p_bind_vbuf, r);
    S(P_BIND_VBUF1, p_bind_vbuf1); O(P_BIND_VBUF1, p_bind_vbuf1, index); O(P_BIND_VBUF1, p_bind_vbuf1, size); O(P_BIND_VBUF1, p_bind_vbuf1, addr);
    S(P_BIND_BUF, p_bind_buf); O(P_BIND_BUF, p_bind_buf, stage); O(P_BIND_BUF, p_bind_buf, index); O(P_BIND_BUF, p_bind_buf, addr); O(P_BIND_BUF, p_bind_buf, size);
    S(P_BIND_UBO_SMALL, p_bind_ubo_small); O(P_BIND_UBO_SMALL, p_bind_ubo_small, stage); O(P_BIND_UBO_SMALL, p_bind_ubo_small, index); O(P_BIND_UBO_SMALL, p_bind_ubo_small, size);
    O(P_BIND_UBO_SMALL, p_bind_ubo_small, addr);
    O(P_BIND_HANDLES, p_bind_handles, stage); O(P_BIND_HANDLES, p_bind_handles, first); O(P_BIND_HANDLES, p_bind_handles, n); O(P_BIND_HANDLES, p_bind_handles, defer);
    O(P_BIND_HANDLES, p_bind_handles, src); O(P_BIND_HANDLES, p_bind_handles, h);
    S(P_BIND_TEX1, p_bind_tex1); O(P_BIND_TEX1, p_bind_tex1, stage); O(P_BIND_TEX1, p_bind_tex1, slot); O(P_BIND_TEX1, p_bind_tex1, h); O(P_BIND_TEX1, p_bind_tex1, tbase); O(P_BIND_TEX1, p_bind_tex1, sbase);
    S(P_STENCIL, p_stencil); S(P_POLY_OFFSET, p_poly_offset);
    S(P_DRAW, p_draw); O(P_DRAW, p_draw, prim); O(P_DRAW, p_draw, first); O(P_DRAW, p_draw, count); O(P_DRAW, p_draw, instances); O(P_DRAW, p_draw, base_instance); O(P_DRAW, p_draw, ind);
    S(P_DRAW_IDX, p_draw_idx); O(P_DRAW_IDX, p_draw_idx, prim); O(P_DRAW_IDX, p_draw_idx, itype); O(P_DRAW_IDX, p_draw_idx, count); O(P_DRAW_IDX, p_draw_idx, base_vertex);
    O(P_DRAW_IDX, p_draw_idx, base_instance); O(P_DRAW_IDX, p_draw_idx, instances); O(P_DRAW_IDX, p_draw_idx, ibuf); O(P_DRAW_IDX, p_draw_idx, ind);
    S(P_COPY_B2T, p_copy_b2t); O(P_COPY_B2T, p_copy_b2t, src); O(P_COPY_B2T, p_copy_b2t, tex); O(P_COPY_B2T, p_copy_b2t, view); O(P_COPY_B2T, p_copy_b2t, has_view); O(P_COPY_B2T, p_copy_b2t, r);
    O(P_COPY_B2T, p_copy_b2t, flags);
    printf("COPY_STRIDES_OFF=%zu\n", (size_t)COPY_STRIDES_OFF); S(P_COPY_STRIDES, p_copy_strides);
    S(P_COPY_T2T, p_copy_t2t); O(P_COPY_T2T, p_copy_t2t, src); O(P_COPY_T2T, p_copy_t2t, dst); O(P_COPY_T2T, p_copy_t2t, sv); O(P_COPY_T2T, p_copy_t2t, dv); O(P_COPY_T2T, p_copy_t2t, has_sv);
    O(P_COPY_T2T, p_copy_t2t, has_dv); O(P_COPY_T2T, p_copy_t2t, sr); O(P_COPY_T2T, p_copy_t2t, dr); O(P_COPY_T2T, p_copy_t2t, flags);
    S(P_BLEND_COLOR, p_blend_color); S(P_SET_POOL, p_set_pool);
    printf("OP_COUNT_=%d\nOP_WAIT_SYNC=%d\nOP_BIND_TEX1=%d\nOP_DRAW_IDX=%d\nOP_COPY_T2T=%d\nOP_SET_RT=%d\nOP_BIND_VBUF1=%d\nOP_BIND_UBO_SMALL=%d\nOP_FENCE_SYNC=%d\n", OP_COUNT_, OP_WAIT_SYNC, OP_BIND_TEX1, OP_DRAW_IDX, OP_COPY_T2T, OP_SET_RT, OP_BIND_VBUF1, OP_BIND_UBO_SMALL, OP_FENCE_SYNC);
    // The sizes NVN reserves for each object (include/nvn.h): what the game allocates
    R(DEVICE, NVNdevice); R(DEVICE_BUILDER, NVNdeviceBuilder); R(QUEUE, NVNqueue); R(QUEUE_BUILDER, NVNqueueBuilder); R(MEMORY_POOL, NVNmemoryPool); R(MEMORY_POOL_BUILDER, NVNmemoryPoolBuilder);
    R(TEXTURE_POOL, NVNtexturePool); R(SAMPLER_POOL, NVNsamplerPool); R(BUFFER, NVNbuffer); R(BUFFER_BUILDER, NVNbufferBuilder); R(TEXTURE, NVNtexture); R(TEXTURE_BUILDER, NVNtextureBuilder);
    R(TEXTURE_VIEW, NVNtextureView); R(SAMPLER, NVNsampler); R(SAMPLER_BUILDER, NVNsamplerBuilder); R(PROGRAM, NVNprogram); R(SYNC, NVNsync); R(WINDOW, NVNwindow); R(WINDOW_BUILDER, NVNwindowBuilder);
    R(COMMAND_BUFFER, NVNcommandBuffer); R(BLEND_STATE, NVNblendState); R(COLOR_STATE, NVNcolorState); R(CHANNEL_MASK_STATE, NVNchannelMaskState); R(MULTISAMPLE_STATE, NVNmultisampleState);
    R(POLYGON_STATE, NVNpolygonState); R(DEPTH_STENCIL_STATE, NVNdepthStencilState); R(VERTEX_ATTRIB_STATE, NVNvertexAttribState); R(VERTEX_STREAM_STATE, NVNvertexStreamState);
    return 0;
}
