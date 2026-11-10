// A small game's graphics layer on NVN, for the runtime's graphics test guests. It includes nxnative's real nvn.h
// (found by the build through -I; the header is not in this repository), gets its entry points the way a game does
// (nvnBootstrapLoader for the first ones, then nvnDeviceGetProcAddress by name), and keeps every NVN object at the
// size the header reserves. Also the nn::vi and nn::hid calls a simple game makes, by their SDK symbol names.
#pragma once
#include "rt.h"
#include <nvn.h>

// ---- SDK imports the host takes over ----
IMPORT PFNNVNGENERICFUNCPTRPROC nvnBootstrapLoader(const char *name);
IMPORT void nn_vi_Initialize(void) __asm__("_ZN2nn2vi10InitializeEv");
IMPORT Result nn_vi_OpenDefaultDisplay(void **display) __asm__("_ZN2nn2vi18OpenDefaultDisplayEPPNS0_7DisplayE");
IMPORT Result nn_vi_CreateLayer(void **layer, void *display) __asm__("_ZN2nn2vi11CreateLayerEPPNS0_5LayerEPNS0_7DisplayE");
IMPORT Result nn_vi_GetNativeWindow(void **window, void *layer) __asm__("_ZN2nn2vi15GetNativeWindowEPPvPNS0_5LayerE");
typedef struct { s64 sampling; u64 buttons; s32 lx, ly, rx, ry; u32 attributes, pad; } NpadState;   // nn::hid::NpadFullKeyState
IMPORT void nn_hid_InitializeNpad(void) __asm__("_ZN2nn3hid14InitializeNpadEv");
IMPORT void nn_hid_SetSupportedNpadStyleSet(u32 styles) __asm__("_ZN2nn3hid24SetSupportedNpadStyleSetENS_4util10BitFlagSetILi32ENS0_12NpadStyleTagEEE");
IMPORT void nn_hid_SetSupportedNpadIdType(const u32 *ids, u64 n) __asm__("_ZN2nn3hid22SetSupportedNpadIdTypeEPKjm");
IMPORT u32 nn_hid_GetNpadStyleSet(const u32 *id) __asm__("_ZN2nn3hid15GetNpadStyleSetERKj");
IMPORT void nn_hid_GetNpadStateFullKey(NpadState *s, const u32 *id) __asm__("_ZN2nn3hid12GetNpadStateEPNS0_16NpadFullKeyStateERKj");
IMPORT void nn_hid_GetNpadStateHandheld(NpadState *s, const u32 *id) __asm__("_ZN2nn3hid12GetNpadStateEPNS0_17NpadHandheldStateERKj");
IMPORT int nn_hid_GetNpadStatesFullKey(NpadState *s, int n, const u32 *id) __asm__("_ZN2nn3hid13GetNpadStatesEPNS0_16NpadFullKeyStateEiRKj");
IMPORT int nn_hid_GetNpadStatesHandheld(NpadState *s, int n, const u32 *id) __asm__("_ZN2nn3hid13GetNpadStatesEPNS0_17NpadHandheldStateEiRKj");
// test control: how many frames to render (0: until stopped), given by the embedder
IMPORT u32 demo_frames(void);

// ---- the NVN entry points this game uses ----
#define NVN_FUNCS(X) \
  X(DeviceBuilderSetDefaults, PFNNVNDEVICEBUILDERSETDEFAULTSPROC) \
  X(DeviceBuilderSetFlags, PFNNVNDEVICEBUILDERSETFLAGSPROC) \
  X(DeviceInitialize, PFNNVNDEVICEINITIALIZEPROC) \
  X(DeviceGetProcAddress, PFNNVNDEVICEGETPROCADDRESSPROC) \
  X(DeviceSetWindowOriginMode, PFNNVNDEVICESETWINDOWORIGINMODEPROC) \
  X(DeviceSetDepthMode, PFNNVNDEVICESETDEPTHMODEPROC) \
  X(DeviceGetTextureHandle, PFNNVNDEVICEGETTEXTUREHANDLEPROC) \
  X(QueueBuilderSetDevice, PFNNVNQUEUEBUILDERSETDEVICEPROC) \
  X(QueueBuilderSetDefaults, PFNNVNQUEUEBUILDERSETDEFAULTSPROC) \
  X(QueueBuilderGetQueueMemorySize, PFNNVNQUEUEBUILDERGETQUEUEMEMORYSIZEPROC) \
  X(QueueBuilderSetQueueMemory, PFNNVNQUEUEBUILDERSETQUEUEMEMORYPROC) \
  X(QueueInitialize, PFNNVNQUEUEINITIALIZEPROC) \
  X(QueueSubmitCommands, PFNNVNQUEUESUBMITCOMMANDSPROC) \
  X(QueuePresentTexture, PFNNVNQUEUEPRESENTTEXTUREPROC) \
  X(QueueFinish, PFNNVNQUEUEFINISHPROC) \
  X(QueueFenceSync, PFNNVNQUEUEFENCESYNCPROC) \
  X(QueueFlush, PFNNVNQUEUEFLUSHPROC) \
  X(MemoryPoolBuilderSetDefaults, PFNNVNMEMORYPOOLBUILDERSETDEFAULTSPROC) \
  X(MemoryPoolBuilderSetDevice, PFNNVNMEMORYPOOLBUILDERSETDEVICEPROC) \
  X(MemoryPoolBuilderSetStorage, PFNNVNMEMORYPOOLBUILDERSETSTORAGEPROC) \
  X(MemoryPoolBuilderSetFlags, PFNNVNMEMORYPOOLBUILDERSETFLAGSPROC) \
  X(MemoryPoolInitialize, PFNNVNMEMORYPOOLINITIALIZEPROC) \
  X(MemoryPoolGetBufferAddress, PFNNVNMEMORYPOOLGETBUFFERADDRESSPROC) \
  X(MemoryPoolFlushMappedRange, PFNNVNMEMORYPOOLFLUSHMAPPEDRANGEPROC) \
  X(CommandBufferInitialize, PFNNVNCOMMANDBUFFERINITIALIZEPROC) \
  X(CommandBufferAddCommandMemory, PFNNVNCOMMANDBUFFERADDCOMMANDMEMORYPROC) \
  X(CommandBufferAddControlMemory, PFNNVNCOMMANDBUFFERADDCONTROLMEMORYPROC) \
  X(CommandBufferBeginRecording, PFNNVNCOMMANDBUFFERBEGINRECORDINGPROC) \
  X(CommandBufferEndRecording, PFNNVNCOMMANDBUFFERENDRECORDINGPROC) \
  X(CommandBufferSetRenderTargets, PFNNVNCOMMANDBUFFERSETRENDERTARGETSPROC) \
  X(CommandBufferClearColor, PFNNVNCOMMANDBUFFERCLEARCOLORPROC) \
  X(CommandBufferClearDepthStencil, PFNNVNCOMMANDBUFFERCLEARDEPTHSTENCILPROC) \
  X(CommandBufferSetViewport, PFNNVNCOMMANDBUFFERSETVIEWPORTPROC) \
  X(CommandBufferSetScissor, PFNNVNCOMMANDBUFFERSETSCISSORPROC) \
  X(CommandBufferBindBlendState, PFNNVNCOMMANDBUFFERBINDBLENDSTATEPROC) \
  X(CommandBufferBindColorState, PFNNVNCOMMANDBUFFERBINDCOLORSTATEPROC) \
  X(CommandBufferBindChannelMaskState, PFNNVNCOMMANDBUFFERBINDCHANNELMASKSTATEPROC) \
  X(CommandBufferBindMultisampleState, PFNNVNCOMMANDBUFFERBINDMULTISAMPLESTATEPROC) \
  X(CommandBufferBindPolygonState, PFNNVNCOMMANDBUFFERBINDPOLYGONSTATEPROC) \
  X(CommandBufferBindDepthStencilState, PFNNVNCOMMANDBUFFERBINDDEPTHSTENCILSTATEPROC) \
  X(CommandBufferBindVertexAttribState, PFNNVNCOMMANDBUFFERBINDVERTEXATTRIBSTATEPROC) \
  X(CommandBufferBindVertexStreamState, PFNNVNCOMMANDBUFFERBINDVERTEXSTREAMSTATEPROC) \
  X(CommandBufferBindVertexBuffer, PFNNVNCOMMANDBUFFERBINDVERTEXBUFFERPROC) \
  X(CommandBufferBindProgram, PFNNVNCOMMANDBUFFERBINDPROGRAMPROC) \
  X(CommandBufferBindUniformBuffer, PFNNVNCOMMANDBUFFERBINDUNIFORMBUFFERPROC) \
  X(CommandBufferBindTexture, PFNNVNCOMMANDBUFFERBINDTEXTUREPROC) \
  X(CommandBufferDrawArrays, PFNNVNCOMMANDBUFFERDRAWARRAYSPROC) \
  X(CommandBufferDrawElements, PFNNVNCOMMANDBUFFERDRAWELEMENTSPROC) \
  X(BlendStateSetDefaults, PFNNVNBLENDSTATESETDEFAULTSPROC) \
  X(ColorStateSetDefaults, PFNNVNCOLORSTATESETDEFAULTSPROC) \
  X(ChannelMaskStateSetDefaults, PFNNVNCHANNELMASKSTATESETDEFAULTSPROC) \
  X(MultisampleStateSetDefaults, PFNNVNMULTISAMPLESTATESETDEFAULTSPROC) \
  X(PolygonStateSetDefaults, PFNNVNPOLYGONSTATESETDEFAULTSPROC) \
  X(DepthStencilStateSetDefaults, PFNNVNDEPTHSTENCILSTATESETDEFAULTSPROC) \
  X(DepthStencilStateSetDepthTestEnable, PFNNVNDEPTHSTENCILSTATESETDEPTHTESTENABLEPROC) \
  X(DepthStencilStateSetDepthWriteEnable, PFNNVNDEPTHSTENCILSTATESETDEPTHWRITEENABLEPROC) \
  X(DepthStencilStateSetDepthFunc, PFNNVNDEPTHSTENCILSTATESETDEPTHFUNCPROC) \
  X(VertexAttribStateSetDefaults, PFNNVNVERTEXATTRIBSTATESETDEFAULTSPROC) \
  X(VertexAttribStateSetFormat, PFNNVNVERTEXATTRIBSTATESETFORMATPROC) \
  X(VertexAttribStateSetStreamIndex, PFNNVNVERTEXATTRIBSTATESETSTREAMINDEXPROC) \
  X(VertexStreamStateSetDefaults, PFNNVNVERTEXSTREAMSTATESETDEFAULTSPROC) \
  X(VertexStreamStateSetStride, PFNNVNVERTEXSTREAMSTATESETSTRIDEPROC) \
  X(TextureBuilderSetDevice, PFNNVNTEXTUREBUILDERSETDEVICEPROC) \
  X(TextureBuilderSetDefaults, PFNNVNTEXTUREBUILDERSETDEFAULTSPROC) \
  X(TextureBuilderSetTarget, PFNNVNTEXTUREBUILDERSETTARGETPROC) \
  X(TextureBuilderSetFormat, PFNNVNTEXTUREBUILDERSETFORMATPROC) \
  X(TextureBuilderSetSize2D, PFNNVNTEXTUREBUILDERSETSIZE2DPROC) \
  X(TextureBuilderSetLevels, PFNNVNTEXTUREBUILDERSETLEVELSPROC) \
  X(TextureBuilderSetFlags, PFNNVNTEXTUREBUILDERSETFLAGSPROC) \
  X(TextureBuilderGetStorageSize, PFNNVNTEXTUREBUILDERGETSTORAGESIZEPROC) \
  X(TextureBuilderGetStorageAlignment, PFNNVNTEXTUREBUILDERGETSTORAGEALIGNMENTPROC) \
  X(TextureBuilderSetStorage, PFNNVNTEXTUREBUILDERSETSTORAGEPROC) \
  X(TextureInitialize, PFNNVNTEXTUREINITIALIZEPROC) \
  X(TexturePoolInitialize, PFNNVNTEXTUREPOOLINITIALIZEPROC) \
  X(SamplerPoolInitialize, PFNNVNSAMPLERPOOLINITIALIZEPROC) \
  X(TexturePoolRegisterTexture, PFNNVNTEXTUREPOOLREGISTERTEXTUREPROC) \
  X(SamplerPoolRegisterSampler, PFNNVNSAMPLERPOOLREGISTERSAMPLERPROC) \
  X(CommandBufferSetTexturePool, PFNNVNCOMMANDBUFFERSETTEXTUREPOOLPROC) \
  X(CommandBufferSetSamplerPool, PFNNVNCOMMANDBUFFERSETSAMPLERPOOLPROC) \
  X(SamplerBuilderSetDevice, PFNNVNSAMPLERBUILDERSETDEVICEPROC) \
  X(SamplerBuilderSetDefaults, PFNNVNSAMPLERBUILDERSETDEFAULTSPROC) \
  X(SamplerBuilderSetMinMagFilter, PFNNVNSAMPLERBUILDERSETMINMAGFILTERPROC) \
  X(SamplerBuilderSetWrapMode, PFNNVNSAMPLERBUILDERSETWRAPMODEPROC) \
  X(SamplerInitialize, PFNNVNSAMPLERINITIALIZEPROC) \
  X(ProgramInitialize, PFNNVNPROGRAMINITIALIZEPROC) \
  X(ProgramSetShaders, PFNNVNPROGRAMSETSHADERSPROC) \
  X(WindowBuilderSetDevice, PFNNVNWINDOWBUILDERSETDEVICEPROC) \
  X(WindowBuilderSetDefaults, PFNNVNWINDOWBUILDERSETDEFAULTSPROC) \
  X(WindowBuilderSetNativeWindow, PFNNVNWINDOWBUILDERSETNATIVEWINDOWPROC) \
  X(WindowBuilderSetTextures, PFNNVNWINDOWBUILDERSETTEXTURESPROC) \
  X(WindowInitialize, PFNNVNWINDOWINITIALIZEPROC) \
  X(WindowAcquireTexture, PFNNVNWINDOWACQUIRETEXTUREPROC) \
  X(WindowSetPresentInterval, PFNNVNWINDOWSETPRESENTINTERVALPROC) \
  X(SyncInitialize, PFNNVNSYNCINITIALIZEPROC) \
  X(SyncWait, PFNNVNSYNCWAITPROC)
#define X(name, type) static type nvn##name;
NVN_FUNCS(X)
#undef X

static u32 nvn_missing;
static void nvn_load(NVNdevice *dev, int early) {
  // before a device exists only the bootstrap loader can be asked; afterwards the device is, as games do
#define X(name, type) if (!nvn##name) { nvn##name = early ? (type)nvnBootstrapLoader("nvn" #name) : (type)nvnDeviceGetProcAddress(dev, "nvn" #name); if (!early && !nvn##name) nvn_missing++; }
  if (early) {
    nvnDeviceGetProcAddress = (PFNNVNDEVICEGETPROCADDRESSPROC)nvnBootstrapLoader("nvnDeviceGetProcAddress");
    nvnDeviceBuilderSetDefaults = (PFNNVNDEVICEBUILDERSETDEFAULTSPROC)nvnBootstrapLoader("nvnDeviceBuilderSetDefaults");
    nvnDeviceBuilderSetFlags = (PFNNVNDEVICEBUILDERSETFLAGSPROC)nvnBootstrapLoader("nvnDeviceBuilderSetFlags");
    nvnDeviceInitialize = (PFNNVNDEVICEINITIALIZEPROC)nvnBootstrapLoader("nvnDeviceInitialize");
  } else { NVN_FUNCS(X) }
#undef X
}

// ---- memory: one static block, bump-allocated ----
static u8 g_mem[12 << 20] __attribute__((aligned(4096)));
static u64 g_top;
static void *galloc(u64 n, u64 align) { g_top = (g_top + align - 1) & ~(align - 1); void *p = g_mem + g_top; g_top += n; return p; }
static void *memcpy_(void *d, const void *s, u64 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }

typedef struct { NVNmemoryPool obj; u8 *mem; u64 size, used; } Pool;
static NVNdevice g_dev; static NVNqueue g_queue; static NVNcommandBuffer g_cmd; static NVNwindow g_win;
static NVNtexturePool g_texpool; static NVNsamplerPool g_samppool;
static NVNtexture g_wtex[2], g_depth; static const NVNtexture *g_wtexp[2];
static Pool g_cmdpool, g_data, g_texstore, g_desc;
static NVNsync g_sync;

static void pool_init(Pool *p, u64 size, int flags) {
  NVNmemoryPoolBuilder b;
  p->mem = galloc(size, 4096); p->size = size; p->used = 0;
  nvnMemoryPoolBuilderSetDefaults(&b); nvnMemoryPoolBuilderSetDevice(&b, &g_dev); nvnMemoryPoolBuilderSetStorage(&b, p->mem, size); nvnMemoryPoolBuilderSetFlags(&b, flags);
  if (!nvnMemoryPoolInitialize(&p->obj, &b)) say("[guest] MemoryPoolInitialize failed");
}
// bytes in the data pool: the GPU address a game passes to NVN
static NVNbufferAddress data_put(const void *src, u64 n, void **cpu) {
  u64 off = (g_data.used + 255) & ~255ul; g_data.used = off + n;
  if (src) memcpy_(g_data.mem + off, src, n);
  if (cpu) *cpu = g_data.mem + off;
  return nvnMemoryPoolGetBufferAddress(&g_data.obj) + off;
}
static void texture_init(NVNtexture *t, int w, int h, NVNformat fmt, int flags, u8 **storage, u64 *size) {
  NVNtextureBuilder b;
  nvnTextureBuilderSetDevice(&b, &g_dev); nvnTextureBuilderSetDefaults(&b);
  nvnTextureBuilderSetTarget(&b, NVN_TEXTURE_TARGET_2D); nvnTextureBuilderSetFormat(&b, fmt); nvnTextureBuilderSetSize2D(&b, w, h);
  nvnTextureBuilderSetLevels(&b, 1); nvnTextureBuilderSetFlags(&b, flags);
  u64 sz = nvnTextureBuilderGetStorageSize(&b), al = nvnTextureBuilderGetStorageAlignment(&b), off = (g_texstore.used + al - 1) & ~(al - 1);
  g_texstore.used = off + sz;
  if (g_texstore.used > g_texstore.size) say("[guest] texture storage pool full");
  nvnTextureBuilderSetStorage(&b, &g_texstore.obj, off);
  if (!nvnTextureInitialize(t, &b)) say("[guest] TextureInitialize failed");
  if (storage) *storage = g_texstore.mem + off;
  if (size) *size = sz;
}
// A precompiled shader stage as a game ships it: a control section (0x880 bytes, the code length at +0x704) and code
// in pool memory. The bytes are a function of the name; the test computes the same bytes, hashes them as the
// recorder does, and registers hand-written WGSL under that key (there is no shader translator here).
static NVNshaderData shader_blob(const char *name) {
  u32 nl = 0; while (name[nl]) nl++;
  u8 *control = galloc(0x880, 16), code[128]; u32 clen = 96 + nl;
  for (u32 i = 0; i < 0x880; i++) control[i] = (u8)(i * 31 + name[i % nl]);
  for (u32 i = 0; i < clen; i++) code[i] = (u8)(i * 7 + name[i % nl] * 3);
  *(u32 *)(control + 0x20) = 0; *(u32 *)(control + 0x704) = clen;
  NVNshaderData d; d.data = data_put(code, clen, 0); d.control = control;
  return d;
}
static void program_init(NVNprogram *p, const char *vs, const char *fs) {
  NVNshaderData sd[2] = { shader_blob(vs), shader_blob(fs) };
  if (!nvnProgramInitialize(p, &g_dev) || !nvnProgramSetShaders(p, 2, sd)) say("[guest] program failed");
}

// Device, queue, pools, command buffer, descriptor pools, a window of two images through nn::vi: what every game sets up
static void gfx_init(int w, int h) {
  void *display = 0, *layer = 0, *native = 0;
  nn_vi_Initialize();
  if (nn_vi_OpenDefaultDisplay(&display) || nn_vi_CreateLayer(&layer, display) || nn_vi_GetNativeWindow(&native, layer)) say("[guest] nn::vi failed");
  nvn_load(0, 1);
  NVNdeviceBuilder db;
  nvnDeviceBuilderSetDefaults(&db); nvnDeviceBuilderSetFlags(&db, 0);
  if (!nvnDeviceInitialize(&g_dev, &db)) say("[guest] DeviceInitialize failed");
  nvn_load(&g_dev, 0);
  if (nvn_missing) say_u("[guest] NVN functions missing: ", nvn_missing);
  nvnDeviceSetWindowOriginMode(&g_dev, NVN_WINDOW_ORIGIN_MODE_UPPER_LEFT); nvnDeviceSetDepthMode(&g_dev, NVN_DEPTH_MODE_NEAR_IS_ZERO);
  NVNqueueBuilder qb;
  nvnQueueBuilderSetDevice(&qb, &g_dev); nvnQueueBuilderSetDefaults(&qb);
  u64 qmem = nvnQueueBuilderGetQueueMemorySize(&qb);
  nvnQueueBuilderSetQueueMemory(&qb, galloc(qmem, 4096), qmem);
  if (!nvnQueueInitialize(&g_queue, &qb)) say("[guest] QueueInitialize failed");
  int rw = NVN_MEMORY_POOL_FLAGS_CPU_CACHED | NVN_MEMORY_POOL_FLAGS_GPU_CACHED;
  pool_init(&g_cmdpool, 1 << 20, rw); pool_init(&g_data, 1 << 20, rw); pool_init(&g_texstore, 6 << 20, rw); pool_init(&g_desc, 1 << 20, rw);
  if (!nvnCommandBufferInitialize(&g_cmd, &g_dev)) say("[guest] CommandBufferInitialize failed");
  nvnCommandBufferAddCommandMemory(&g_cmd, &g_cmdpool.obj, 0, g_cmdpool.size);
  nvnCommandBufferAddControlMemory(&g_cmd, galloc(4096, 16), 4096);
  nvnTexturePoolInitialize(&g_texpool, &g_desc.obj, 0, 2048); nvnSamplerPoolInitialize(&g_samppool, &g_desc.obj, 2048 * 32, 2048);
  for (int i = 0; i < 2; i++) { texture_init(&g_wtex[i], w, h, NVN_FORMAT_RGBA8, NVN_TEXTURE_FLAGS_DISPLAY, 0, 0); g_wtexp[i] = &g_wtex[i]; }
  texture_init(&g_depth, w, h, NVN_FORMAT_DEPTH24_STENCIL8, 0, 0, 0);
  NVNwindowBuilder wb;
  nvnWindowBuilderSetDevice(&wb, &g_dev); nvnWindowBuilderSetDefaults(&wb); nvnWindowBuilderSetNativeWindow(&wb, native);
  nvnWindowBuilderSetTextures(&wb, 2, (NVNtexture *const *)g_wtexp);
  if (!nvnWindowInitialize(&g_win, &wb)) say("[guest] WindowInitialize failed");
  nvnSyncInitialize(&g_sync, &g_dev);
}

// ---- a frame ----
typedef struct { NVNblendState bl; NVNcolorState co; NVNchannelMaskState cm; NVNmultisampleState ms; NVNpolygonState po; NVNdepthStencilState ds; } States;
static int frame_begin(int depth_test, const float *clear, int w, int h) {
  int idx = -1;
  nvnWindowAcquireTexture(&g_win, &g_sync, &idx);            // parks this thread until the next display frame
  nvnSyncWait(&g_sync, 1000000000ull);                       // and until the image is the game's
  // command and control memory for this frame: the two halves of the pool in turn, as a double-buffered game does
  static u32 flip; static u8 *control;
  if (!control) control = galloc(2 * 4096, 16);
  flip ^= 1;
  nvnCommandBufferAddCommandMemory(&g_cmd, &g_cmdpool.obj, flip * (g_cmdpool.size / 2), g_cmdpool.size / 2);
  nvnCommandBufferAddControlMemory(&g_cmd, control + flip * 4096, 4096);
  nvnCommandBufferBeginRecording(&g_cmd);
  nvnCommandBufferSetTexturePool(&g_cmd, &g_texpool); nvnCommandBufferSetSamplerPool(&g_cmd, &g_samppool);
  const NVNtexture *target = &g_wtex[idx];
  nvnCommandBufferSetRenderTargets(&g_cmd, 1, &target, 0, &g_depth, 0);
  States st;
  nvnBlendStateSetDefaults(&st.bl); nvnColorStateSetDefaults(&st.co); nvnChannelMaskStateSetDefaults(&st.cm); nvnMultisampleStateSetDefaults(&st.ms);
  nvnPolygonStateSetDefaults(&st.po); nvnDepthStencilStateSetDefaults(&st.ds);
  if (depth_test) { nvnDepthStencilStateSetDepthTestEnable(&st.ds, 1); nvnDepthStencilStateSetDepthWriteEnable(&st.ds, 1); nvnDepthStencilStateSetDepthFunc(&st.ds, NVN_DEPTH_FUNC_LESS); }
  nvnCommandBufferBindBlendState(&g_cmd, &st.bl); nvnCommandBufferBindColorState(&g_cmd, &st.co); nvnCommandBufferBindChannelMaskState(&g_cmd, &st.cm);
  nvnCommandBufferBindMultisampleState(&g_cmd, &st.ms); nvnCommandBufferBindPolygonState(&g_cmd, &st.po); nvnCommandBufferBindDepthStencilState(&g_cmd, &st.ds);
  nvnCommandBufferClearColor(&g_cmd, 0, clear, NVN_CLEAR_COLOR_MASK_RGBA);
  nvnCommandBufferClearDepthStencil(&g_cmd, 1.0f, 1, 0, 0);
  nvnCommandBufferSetViewport(&g_cmd, 0, 0, w, h); nvnCommandBufferSetScissor(&g_cmd, 0, 0, w, h);
  return idx;
}
static void frame_end(int idx) {
  NVNcommandHandle hnd = nvnCommandBufferEndRecording(&g_cmd);
  nvnQueueSubmitCommands(&g_queue, 1, &hnd);
  nvnQueuePresentTexture(&g_queue, &g_win, idx);
}
static void vertex_layout(const NVNformat *fmt, const int *off, int n, int stride) {
  NVNvertexAttribState a[4]; NVNvertexStreamState s;
  for (int i = 0; i < n; i++) { nvnVertexAttribStateSetDefaults(&a[i]); nvnVertexAttribStateSetFormat(&a[i], fmt[i], off[i]); nvnVertexAttribStateSetStreamIndex(&a[i], 0); }
  nvnVertexStreamStateSetDefaults(&s); nvnVertexStreamStateSetStride(&s, stride);
  nvnCommandBufferBindVertexAttribState(&g_cmd, n, a); nvnCommandBufferBindVertexStreamState(&g_cmd, 1, &s);
}

// ---- 4x4 matrices, column-major, and the sine a freestanding program has to bring ----
typedef struct { float m[16]; } Mat;
static float sinf_(float x) {
  const float PI = 3.14159265f;
  while (x > PI) x -= 2 * PI;
  while (x < -PI) x += 2 * PI;
  float x2 = x * x;
  return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110)))));
}
static float cosf_(float x) { return sinf_(x + 1.57079633f); }
static Mat mul(Mat a, Mat b) { Mat o; for (int c = 0; c < 4; c++) for (int r = 0; r < 4; r++) { float s = 0; for (int k = 0; k < 4; k++) s += a.m[k * 4 + r] * b.m[c * 4 + k]; o.m[c * 4 + r] = s; } return o; }
static Mat perspective(float t /* 1 / tan(fov / 2) */, float aspect, float n, float f) { Mat o = {{ t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, f / (n - f), -1, 0, 0, n * f / (n - f), 0 }}; return o; }
static Mat translate(float x, float y, float z) { Mat o = {{ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1 }}; return o; }
static Mat rot_y(float a) { float c = cosf_(a), s = sinf_(a); Mat o = {{ c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1 }}; return o; }
static Mat rot_x(float a) { float c = cosf_(a), s = sinf_(a); Mat o = {{ 1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1 }}; return o; }

// ---- the cube: geometry, a texture supplied as a game supplies one, and the model-view-projection ----
#define CUBE_W 480
#define CUBE_H 270
static NVNprogram g_cube_prog; static NVNbufferAddress g_cube_vb, g_cube_ib, g_cube_ubo; static float *g_cube_mvp;
static NVNtexture g_cube_tex; static NVNsampler g_cube_samp; static NVNtextureHandle g_cube_handle;
static const float g_bg[4] = { 0.05f, 0.07f, 0.12f, 1.0f };
static void cube_texture_init(void);
static void cube_init(void) {
  static const signed char faces[6][3][3] = { {{1,0,0},{0,0,-1},{0,1,0}}, {{-1,0,0},{0,0,1},{0,1,0}}, {{0,1,0},{1,0,0},{0,0,-1}}, {{0,-1,0},{1,0,0},{0,0,1}}, {{0,0,1},{1,0,0},{0,1,0}}, {{0,0,-1},{-1,0,0},{0,1,0}} };
  static const signed char corner[4][2] = { {-1,-1}, {1,-1}, {-1,1}, {1,1} };
  float v[24 * 5]; unsigned short idx[36];
  for (int f = 0; f < 6; f++) {
    for (int k = 0; k < 4; k++) {
      float a = corner[k][0], b = corner[k][1], *p = v + (f * 4 + k) * 5;
      for (int c = 0; c < 3; c++) p[c] = faces[f][0][c] + a * faces[f][1][c] + b * faces[f][2][c];
      p[3] = (a + 1) / 2; p[4] = (1 - b) / 2;
    }
    unsigned short *q = idx + f * 6, o = (unsigned short)(f * 4);
    q[0] = o; q[1] = o + 1; q[2] = o + 2; q[3] = o + 2; q[4] = o + 1; q[5] = o + 3;
  }
  g_cube_vb = data_put(v, sizeof v, 0); g_cube_ib = data_put(idx, sizeof idx, 0);
  g_cube_ubo = data_put(0, 64, (void **)&g_cube_mvp);
  program_init(&g_cube_prog, "vs_cube", "fs_tex");
  cube_texture_init();
}
static void cube_texture_init(void) {
  // 8x8 RGBA8 texels (four colours, a light border), written into the texture's storage in the pool in the Switch's
  // block-linear order, as a packaged texture arrives: byte (x, y) of a 64 x 8 byte block is at
  // (x/32)*256 + (y/2)*64 + ((x/16)&1)*32 + (y&1)*16 + (x&15)
  static const u8 cols[4][3] = { {230, 80, 60}, {250, 200, 70}, {70, 170, 240}, {90, 210, 130} };
  u8 *storage; u64 size;
  texture_init(&g_cube_tex, 8, 8, NVN_FORMAT_RGBA8, 0, &storage, &size);
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
    int edge = x == 0 || y == 0 || x == 7 || y == 7;
    const u8 *c = cols[((x >> 1) + (y >> 1) * 2 + ((x ^ y) & 1) * 2) & 3];
    for (int ch = 0; ch < 4; ch++) {
      int bx = x * 4 + ch;
      storage[(bx / 32) * 256 + (y / 2) * 64 + ((bx / 16) & 1) * 32 + (y & 1) * 16 + (bx & 15)] = ch == 3 ? 255 : edge ? 245 : c[ch];
    }
  }
  nvnMemoryPoolFlushMappedRange(&g_texstore.obj, storage - g_texstore.mem, size);
  NVNsamplerBuilder sb;
  nvnSamplerBuilderSetDevice(&sb, &g_dev); nvnSamplerBuilderSetDefaults(&sb);
  nvnSamplerBuilderSetMinMagFilter(&sb, NVN_MIN_FILTER_NEAREST, NVN_MAG_FILTER_NEAREST);
  nvnSamplerBuilderSetWrapMode(&sb, NVN_WRAP_MODE_CLAMP_TO_EDGE, NVN_WRAP_MODE_CLAMP_TO_EDGE, NVN_WRAP_MODE_CLAMP_TO_EDGE);
  if (!nvnSamplerInitialize(&g_cube_samp, &sb)) say("[guest] SamplerInitialize failed");
  nvnTexturePoolRegisterTexture(&g_texpool, 256, &g_cube_tex, 0); nvnSamplerPoolRegisterSampler(&g_samppool, 256, &g_cube_samp);
  g_cube_handle = nvnDeviceGetTextureHandle(&g_dev, 256, 256);
}
static void cube_matrix(float *out, float ay, float ax) {
  Mat m = mul(perspective(2.41421356f, (float)CUBE_W / CUBE_H, 0.1f, 50.0f), mul(translate(0, 0, -5.5f), mul(rot_y(ay), rot_x(ax))));
  for (int i = 0; i < 16; i++) out[i] = m.m[i];
}
static void cube_draw(void) {
  static const NVNformat fmt[2] = { NVN_FORMAT_RGB32F, NVN_FORMAT_RG32F }; static const int off[2] = { 0, 12 };
  vertex_layout(fmt, off, 2, 20);
  nvnCommandBufferBindVertexBuffer(&g_cmd, 0, g_cube_vb, 24 * 20);
  nvnCommandBufferBindProgram(&g_cmd, &g_cube_prog, NVN_SHADER_STAGE_VERTEX_BIT | NVN_SHADER_STAGE_FRAGMENT_BIT);
  nvnCommandBufferBindUniformBuffer(&g_cmd, NVN_SHADER_STAGE_VERTEX, 0, g_cube_ubo, 64);
  nvnCommandBufferBindTexture(&g_cmd, NVN_SHADER_STAGE_FRAGMENT, 0, g_cube_handle);
  nvnCommandBufferDrawElements(&g_cmd, NVN_DRAW_PRIMITIVE_TRIANGLES, NVN_INDEX_TYPE_UNSIGNED_SHORT, 36, g_cube_ib);
}

// ---- input: player 1's pad turns the cube ----
static float g_turn_y, g_turn_x; static u64 g_pressed; static u32 g_reads;
static void input_init(void) {
  static const u32 ids[2] = { 0 /* No1 */, 0x20 /* Handheld */ };
  nn_hid_InitializeNpad();
  nn_hid_SetSupportedNpadStyleSet(3 /* FullKey | Handheld */);
  nn_hid_SetSupportedNpadIdType(ids, 2);
  NpadState h[2];
  if (nn_hid_GetNpadStatesHandheld(h, 2, &ids[1]) != 2 || h[0].attributes) say("[guest] docked: the handheld npad should report two entries of a controller that is not there");
}
static void input_read(void) {
  static const u32 no1 = 0, handheld = 0x20;
  NpadState s; s.buttons = 0; s.lx = s.ly = 0;
  u32 style = nn_hid_GetNpadStyleSet(&no1);
  if ((style & 1) && (g_reads & 1)) {   // odd frames read the history, as many games do: the newest entry is first
    NpadState hist[4];
    if (nn_hid_GetNpadStatesFullKey(hist, 4, &no1) != 4 || hist[1].sampling != hist[0].sampling - 1 || hist[3].buttons != hist[0].buttons) say("[guest] npad history is not consecutive");
    s = hist[0];
  } else if (style & 1) nn_hid_GetNpadStateFullKey(&s, &no1);
  else if (nn_hid_GetNpadStyleSet(&handheld) & 2) nn_hid_GetNpadStateHandheld(&s, &handheld);
  g_reads++; g_pressed |= s.buttons;
  g_turn_y += (float)s.lx / 32767.0f * 0.08f; g_turn_x -= (float)s.ly / 32767.0f * 0.08f;
  if (s.buttons & (1u << 12)) g_turn_y -= 0.08f;   // Left
  if (s.buttons & (1u << 14)) g_turn_y += 0.08f;   // Right
  if (s.buttons & (1u << 13)) g_turn_x -= 0.08f;   // Up
  if (s.buttons & (1u << 15)) g_turn_x += 0.08f;   // Down
}
