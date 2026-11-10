// Guest object layouts and command record formats: the port of nxnative dm/gfx/nvn/nvn_obj.h (and buf_t of hle_nvn.c).
// Objects live in the memory the game allocated for the NVN object; games copy them by value and size heaps by record
// sizes, so every offset and size here is nxnative's (the arm64 C layout: pointers are 8 bytes) unless marked DEPARTS.
// test/gfx/layout_ref.c compiles nvn_obj.h and prints the same names; test/gfx/run.mts compares them with this file.
// Naming: <STRUCT>_<field> = offset, <STRUCT>_SIZE = sizeof. Keep one constant per line: the test reads this file.

export const MAGIC_DEV: u32 = 0x00564544;    // 'D','E','V',0
export const MAGIC_QUEUE: u32 = 0x55455551;  // 'Q','U','E','U'
export const MAGIC_POOL: u32 = 0x4c4f4f50;   // 'P','O','O','L'
export const MAGIC_TEX: u32 = 0x00584554;    // 'T','E','X',0
export const MAGIC_SAMP: u32 = 0x00504d53;   // 'S','M','P',0
export const MAGIC_PROG: u32 = 0x474f5250;   // 'P','R','O','G'
export const MAGIC_SYNC: u32 = 0x434e5953;   // 'S','Y','N','C'
export const MAGIC_WIN: u32 = 0x444e4957;    // 'W','I','N','D'
export const MAGIC_CMD: u32 = 0x42444d43;    // 'C','M','D','B'
export const MAGIC_BUF: u32 = 0x00465542;    // 'B','U','F',0

// dev_builder_t, dev_t_
export const DEVB_flags: usize = 0;
export const DEVB_SIZE: usize = 4;
export const DEV_magic: usize = 0;
export const DEV_flags: usize = 4;
export const DEV_origin: usize = 8;
export const DEV_depth_mode: usize = 12;
export const DEV_dbg_cb: usize = 16;
export const DEV_dbg_data: usize = 24;
export const DEV_SIZE: usize = 32;

// queue_builder_t, queue_t
export const QB_dev: usize = 0;
export const QB_flags: usize = 8;
export const QB_cmd_sz: usize = 16;
export const QB_comp_sz: usize = 24;
export const QB_ctl_sz: usize = 32;
export const QB_flush: usize = 40;
export const QB_mem: usize = 48;
export const QB_mem_sz: usize = 56;
export const QB_SIZE: usize = 64;
export const QUEUE_magic: usize = 0;
export const QUEUE_dev: usize = 8;
export const QUEUE_submits: usize = 16;
export const QUEUE_origin_ll: usize = 24;
export const QUEUE_serial: usize = 32;
export const QUEUE_SIZE: usize = 40;

// pool_builder_t, pool_t, dpool_t
export const PB_dev: usize = 0;
export const PB_mem: usize = 8;
export const PB_size: usize = 16;
export const PB_flags: usize = 24;
export const PB_SIZE: usize = 32;
export const POOL_magic: usize = 0;
export const POOL_flags: usize = 4;
export const POOL_mem: usize = 8;
export const POOL_size: usize = 16;
export const POOL_vp: usize = 24;
export const POOL_vmode: usize = 32;
export const POOL_SIZE: usize = 40;
export const DPOOL_pool: usize = 0;
export const DPOOL_off: usize = 8;
export const DPOOL_n: usize = 16;
export const DPOOL_SIZE: usize = 24;

// buf_builder_t, buf_t (hle_nvn.c)
export const BB_dev: usize = 0;
export const BB_pool: usize = 8;
export const BB_off: usize = 16;
export const BB_size: usize = 24;
export const BB_SIZE: usize = 32;
export const BUF_magic: usize = 0;
export const BUF_pool: usize = 8;
export const BUF_off: usize = 24;
export const BUF_size: usize = 32;
export const BUF_SIZE: usize = 40;

// nvn_texdesc, nvn_texlayout (nvn_tex.h)
export const TD_target: usize = 0;
export const TD_format: usize = 4;
export const TD_flags: usize = 8;
export const TD_samples: usize = 12;
export const TD_width: usize = 16;
export const TD_height: usize = 20;
export const TD_depth: usize = 24;
export const TD_levels: usize = 28;
export const TD_stride: usize = 32;
export const TD_pkg_block_h: usize = 36;
export const TD_SIZE: usize = 40;
export const TL_size: usize = 0;
export const TL_layer_size: usize = 8;
export const TL_align: usize = 16;
export const TL_layers: usize = 20;
export const TL_bpb: usize = 24;
export const TL_tileH: usize = 28;
export const TL_tileD: usize = 32;
export const TL_SIZE: usize = 40;

// tex_builder_t, tex_t, view_t. The bit-field byte after has_layout: bit 0 set_swz, bit 1 stencil
export const TB_dev: usize = 0;
export const TB_d: usize = 8;
export const TB_pool: usize = 48;
export const TB_off: usize = 56;
export const TB_has_layout: usize = 64;
export const TB_layout: usize = 65;
export const TB_pkg_data: usize = 80;
export const TB_bits: usize = 88;
export const TB_swz: usize = 90;
export const TB_SIZE: usize = 96;
export const TEX_magic: usize = 0;
export const TEX_d: usize = 4;
export const TEX_has_layout: usize = 44;
export const TEX_bits: usize = 45;
export const TEX_swz: usize = 46;
export const TEX_L: usize = 48;
export const TEX_mem: usize = 88;
export const TEX_pool: usize = 96;
export const TEX_off: usize = 104;
export const TEX_layout: usize = 112;
export const TEX_serial: usize = 120;
export const TEX_SIZE: usize = 128;
// view_t byte 0: bit 0 set_levels, 1 set_layers, 2 set_format, 3 set_target, 4 set_swizzle, 5 set_dsmode, 6-7 dsmode
export const VIEW_bits: usize = 0;
export const VIEW_target: usize = 1;
export const VIEW_base_level: usize = 2;
export const VIEW_nlevels: usize = 3;
export const VIEW_format: usize = 4;
export const VIEW_min_layer: usize = 6;
export const VIEW_nlayers: usize = 8;
export const VIEW_swz: usize = 10;
export const VIEW_SIZE: usize = 16;

// samp_par, samp_builder_t, samp_t
export const SP_minf: usize = 0;
export const SP_magf: usize = 1;
export const SP_ws: usize = 2;
export const SP_wt: usize = 3;
export const SP_wr: usize = 4;
export const SP_cmp_mode: usize = 5;
export const SP_cmp_func: usize = 6;
export const SP_reduction: usize = 7;
export const SP_lod_min: usize = 8;
export const SP_lod_max: usize = 12;
export const SP_lod_bias: usize = 16;
export const SP_aniso: usize = 20;
export const SP_border: usize = 24;
export const SP_SIZE: usize = 40;
export const SB_dev: usize = 0;
export const SB_p: usize = 8;
export const SB_SIZE: usize = 48;
export const SAMP_magic: usize = 0;
export const SAMP_p: usize = 8;
export const SAMP_SIZE: usize = 48;

// prog_t (NVNshaderData = { u64 data; u64 control })
export const PROG_magic: usize = 0;
export const PROG_nstage: usize = 4;
export const PROG_sd: usize = 8;
export const PROG_serial: usize = 104;
export const PROG_SIZE: usize = 112;

// sync_t. DEPARTS: nxnative keeps { magic, fenced, fence }; here the state is a kit instance (gfx_sync) at +8
export const SYNC_magic: usize = 0;
export const SYNC_inst: usize = 8;
export const SYNC_SIZE: usize = 24;

// win_builder_t, win_t. DEPARTS in win_t: the four image machines (gfx_image) take the place of avail[4], pace and
// ticket[0] (nxnative's pacing clock and present tickets, which the browser port does not have); the size is the same
export const WB_dev: usize = 0;
export const WB_native: usize = 8;
export const WB_ntex: usize = 16;
export const WB_interval: usize = 20;
export const WB_tex: usize = 24;
export const WB_nactive: usize = 56;
export const WB_SIZE: usize = 64;
export const WIN_magic: usize = 0;
export const WIN_native: usize = 8;
export const WIN_ntex: usize = 16;
export const WIN_interval: usize = 20;
export const WIN_next: usize = 24;
export const WIN_crop: usize = 28;
export const WIN_tex: usize = 48;
export const WIN_presents: usize = 80;
export const WIN_image: usize = 88;
export const WIN_nactive: usize = 160;
export const WIN_SIZE: usize = 168;

// cmd_t. DEPARTS: `recording` (+4) is not used, the recording state is a kit instance (gfx_cmdbuf) appended at +112.
// +0x10 stays the game's (its inlined NVN header code writes there)
export const CMD_magic: usize = 0;
export const CMD_cur: usize = 8;
export const CMD_nvn_flag10: usize = 16;
export const CMD_end: usize = 24;
export const CMD_begin: usize = 32;
export const CMD_cb: usize = 40;
export const CMD_cb_data: usize = 48;
export const CMD_dev: usize = 56;
export const CMD_used: usize = 64;
export const CMD_tex_base: usize = 72;
export const CMD_samp_base: usize = 76;
export const CMD_ctl_size: usize = 80;
export const CMD_copy_row: usize = 88;
export const CMD_copy_image: usize = 96;
export const CMD_cmd_size: usize = 104;
export const CMD_inst: usize = 112;
export const CMD_SIZE: usize = 128;

// State objects, the game copies them by value. Bit-fields, low bits first:
//   color_st  u32: blend_en:8 logic_op:4 alpha_func:4
//   chmask_st u32: 4 bits a target, r=1 g=2 b=4 a=8
//   blend_st  u64: target:3 src_rgb:7 dst_rgb:7 src_a:7 dst_a:7 eq_rgb:3 eq_a:3 adv:6 adv_npm:1 adv_ovl:2 adv_dst_free:1
//   ms_st     u8 enable, samples, a2c, a2c_dither, raster_samples, cov_mod, cov2color_en, cov2color_out, sl_en, sl_grid
//   poly_st   u32: cull:2 front:1 mode:2 offset_en:3
//   ds_st     u64: dt:1 dw:1 df:4 st:1 sf_f:4 sf_b:4 fail_f:4 zfail_f:4 zpass_f:4 fail_b:4 zfail_b:4 zpass_b:4
//   va_st     u32: fmt:8 offset:19 stream:5
//   vs_st     u32 stride, divisor
export const COLOR_ST_SIZE: usize = 4;
export const CHMASK_ST_SIZE: usize = 4;
export const BLEND_ST_SIZE: usize = 8;
export const MS_ST_SIZE: usize = 10;
export const POLY_ST_SIZE: usize = 4;
export const DS_ST_SIZE: usize = 8;
export const VA_ST_SIZE: usize = 4;
export const VS_ST_SIZE: usize = 8;

// ---------- Command records: { u32 op, u32 size (with the header, a multiple of 8) } + payload ----------
export const OP_END: u32 = 0;
export const OP_JUMP: u32 = 1;
export const OP_BEGIN: u32 = 2;
export const OP_CALL: u32 = 3;
export const OP_SIGNAL_EVENT: u32 = 4;
export const OP_REPORT_COUNTER: u32 = 5;
export const OP_COPY_B2B: u32 = 6;
export const OP_UPDATE_UB: u32 = 7;
export const OP_SET_RT: u32 = 8;
export const OP_CLEAR_COLOR: u32 = 9;
export const OP_CLEAR_DS: u32 = 10;
export const OP_VIEWPORTS: u32 = 11;
export const OP_SCISSOR: u32 = 12;
export const OP_DEPTH_RANGE: u32 = 13;
export const OP_BIND_PROGRAM: u32 = 14;
export const OP_BIND_STATE: u32 = 15;
export const OP_BIND_VATTR: u32 = 16;
export const OP_BIND_VSTREAM: u32 = 17;
export const OP_BIND_VBUF: u32 = 18;
export const OP_BIND_UBO: u32 = 19;
export const OP_BIND_SSBO: u32 = 20;
export const OP_BIND_TEX: u32 = 21;
export const OP_BIND_SAMP: u32 = 22;
export const OP_STENCIL: u32 = 23;
export const OP_POLY_OFFSET: u32 = 24;
export const OP_DRAW: u32 = 25;
export const OP_DRAW_IDX: u32 = 26;
export const OP_DISPATCH: u32 = 27;
export const OP_BARRIER: u32 = 28;
export const OP_SET_TEX_POOL: u32 = 29;
export const OP_SET_SAMP_POOL: u32 = 30;
export const OP_COPY_B2T: u32 = 31;
export const OP_COPY_STRIDE: u32 = 32;
export const OP_BLEND_COLOR: u32 = 33;
export const OP_COPY_T2B: u32 = 34;
export const OP_BIND_IMG: u32 = 35;
export const OP_COPY_T2T: u32 = 36;
export const OP_RESET_COUNTER: u32 = 37;
export const OP_CLEAR_TEX: u32 = 38;
export const OP_CLEAR_BUF: u32 = 39;
export const OP_DEPTH_CLAMP: u32 = 40;
export const OP_RENDER_COND: u32 = 41;
export const OP_FENCE_SYNC: u32 = 42;
export const OP_TF_BIND: u32 = 43;
export const OP_TF_STATE: u32 = 44;
export const OP_RAST_DISCARD: u32 = 45;
export const OP_VP_SWIZZLE: u32 = 46;
export const OP_BIND_TEX1: u32 = 47;
export const OP_PRIM_RESTART: u32 = 48;
export const OP_BIND_UBO_SMALL: u32 = 49;
export const OP_BIND_VBUF1: u32 = 50;
export const OP_DRAW_TEX: u32 = 51;
export const OP_ALPHA_REF: u32 = 52;
export const OP_PUSH_CONST: u32 = 53;
export const OP_DLSS: u32 = 54;
export const OP_MULTI_DRAW: u32 = 55;
export const OP_WAIT_EVENT: u32 = 56;
export const OP_WAIT_SYNC: u32 = 57;
export const OP_COUNT_: u32 = 58;

export const OP_RESERVE: u32 = 16;          // room kept for one JUMP after every record but the END
export const BIND_TEX1_NOBASE: i32 = 0x100;

// Payload layouts (the offsets are from the payload, 8 bytes after the record's start)
export const P_SET_RT_n: usize = 0;
export const P_SET_RT_color: usize = 8;
export const P_SET_RT_cview: usize = 72;
export const P_SET_RT_has_cview: usize = 200;
export const P_SET_RT_depth: usize = 208;
export const P_SET_RT_dview: usize = 216;
export const P_SET_RT_has_dview: usize = 232;
export const P_SET_RT_SIZE: usize = 240;
export const P_CLEAR_COLOR_index: usize = 0;
export const P_CLEAR_COLOR_mask: usize = 4;
export const P_CLEAR_COLOR_rgba: usize = 8;
export const P_CLEAR_COLOR_SIZE: usize = 24;
export const P_CLEAR_DS_depth: usize = 0;
export const P_CLEAR_DS_depth_mask: usize = 4;
export const P_CLEAR_DS_stencil: usize = 8;
export const P_CLEAR_DS_stencil_mask: usize = 12;
export const P_CLEAR_DS_SIZE: usize = 16;
export const P_VIEWPORTS_first: usize = 0;
export const P_VIEWPORTS_n: usize = 4;
export const P_VIEWPORTS_v: usize = 8;
export const P_VIEWPORTS_SIZE: usize = 392;
export const P_SCISSOR_SIZE: usize = 16;
export const P_DEPTH_RANGE_SIZE: usize = 8;
export const P_BIND_PROGRAM_prog: usize = 0;
export const P_BIND_PROGRAM_stages: usize = 8;
export const P_BIND_PROGRAM_SIZE: usize = 16;
export const P_BIND_STATE_kind: usize = 0;
export const P_BIND_STATE_bytes: usize = 4;
export const P_BIND_VATTR_st: usize = 8;
export const P_BIND_VSTREAM_st: usize = 8;
export const P_BIND_VBUF_r: usize = 8;
export const P_BIND_VBUF1_index: usize = 0;
export const P_BIND_VBUF1_size: usize = 4;
export const P_BIND_VBUF1_addr: usize = 8;
export const P_BIND_VBUF1_SIZE: usize = 16;
export const P_BIND_BUF_stage: usize = 0;
export const P_BIND_BUF_index: usize = 4;
export const P_BIND_BUF_addr: usize = 8;
export const P_BIND_BUF_size: usize = 16;
export const P_BIND_BUF_SIZE: usize = 24;
export const P_BIND_UBO_SMALL_stage: usize = 0;
export const P_BIND_UBO_SMALL_index: usize = 2;
export const P_BIND_UBO_SMALL_size: usize = 4;
export const P_BIND_UBO_SMALL_addr: usize = 8;
export const P_BIND_UBO_SMALL_SIZE: usize = 16;
export const P_BIND_HANDLES_stage: usize = 0;
export const P_BIND_HANDLES_first: usize = 4;
export const P_BIND_HANDLES_n: usize = 8;
export const P_BIND_HANDLES_defer: usize = 12;
export const P_BIND_HANDLES_src: usize = 16;
export const P_BIND_HANDLES_h: usize = 24;
export const P_BIND_TEX1_stage: usize = 0;
export const P_BIND_TEX1_slot: usize = 4;
export const P_BIND_TEX1_h: usize = 8;
export const P_BIND_TEX1_tbase: usize = 16;
export const P_BIND_TEX1_sbase: usize = 20;
export const P_BIND_TEX1_SIZE: usize = 24;
export const P_STENCIL_SIZE: usize = 20;
export const P_POLY_OFFSET_SIZE: usize = 12;
export const P_DRAW_prim: usize = 0;
export const P_DRAW_first: usize = 4;
export const P_DRAW_count: usize = 8;
export const P_DRAW_instances: usize = 12;
export const P_DRAW_base_instance: usize = 16;
export const P_DRAW_ind: usize = 24;
export const P_DRAW_SIZE: usize = 48;
export const P_DRAW_IDX_prim: usize = 0;
export const P_DRAW_IDX_itype: usize = 4;
export const P_DRAW_IDX_count: usize = 8;
export const P_DRAW_IDX_base_vertex: usize = 12;
export const P_DRAW_IDX_base_instance: usize = 16;
export const P_DRAW_IDX_instances: usize = 20;
export const P_DRAW_IDX_ibuf: usize = 24;
export const P_DRAW_IDX_ind: usize = 32;
export const P_DRAW_IDX_SIZE: usize = 56;
export const P_COPY_B2T_src: usize = 0;
export const P_COPY_B2T_tex: usize = 8;
export const P_COPY_B2T_view: usize = 16;
export const P_COPY_B2T_has_view: usize = 32;
export const P_COPY_B2T_r: usize = 36;
export const P_COPY_B2T_flags: usize = 60;
export const P_COPY_B2T_SIZE: usize = 64;
export const COPY_STRIDES_OFF: usize = 192;
export const P_COPY_STRIDES_SIZE: usize = 16;
export const P_COPY_T2T_src: usize = 0;
export const P_COPY_T2T_dst: usize = 8;
export const P_COPY_T2T_sv: usize = 16;
export const P_COPY_T2T_dv: usize = 32;
export const P_COPY_T2T_has_sv: usize = 48;
export const P_COPY_T2T_has_dv: usize = 49;
export const P_COPY_T2T_sr: usize = 52;
export const P_COPY_T2T_dr: usize = 76;
export const P_COPY_T2T_flags: usize = 100;
export const P_COPY_T2T_SIZE: usize = 104;
export const P_BLEND_COLOR_SIZE: usize = 16;
export const P_SET_POOL_SIZE: usize = 8;
export const P_DISPATCH_caller: usize = 16;
export const P_DISPATCH_ind: usize = 24;
export const P_DISPATCH_SIZE: usize = 32;
export const COPY_RESOLVE: i32 = 0x40000000;   // host-only bit in a texture copy's flags: a Downsample (nxnative DM_COPY_RESOLVE)

// NVN enums the module decides by (include/nvn.h)
export const TEXF_LINEAR: i32 = 0x10;
export const TEXF_LINEAR_RT: i32 = 0x40;
export const POOLF_CPU_NO_ACCESS: i32 = 0x1;
export const POOLF_VIRTUAL: i32 = 0x200;
