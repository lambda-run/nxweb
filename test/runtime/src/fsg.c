// A guest that uses the file system as a game does: mounts its RomFS, reads a file and prints a checksum; mounts
// its save data, reads the counter the run before committed, writes the next value and commits. test_mode() = 1:
// it stops after the write and before the commit (the embedder kills it there).
#include "rt.h"
u32 mutex_slow;
typedef struct { u64 h; } FileHandle;
typedef struct { u64 id[2]; } Uid;
typedef struct { int flags; } WriteOption;
IMPORT Result fs_QueryMountRomCacheSize(u64 *out) __asm__("_ZN2nn2fs22QueryMountRomCacheSizeEPm");
IMPORT Result fs_MountRom(const char *name, void *cache, u64 size) __asm__("_ZN2nn2fs8MountRomEPKcPvm");
IMPORT Result fs_EnsureSaveData(const Uid *u) __asm__("_ZN2nn2fs14EnsureSaveDataERKNS_7account3UidE");
IMPORT Result fs_MountSaveData(const char *name, const Uid *u) __asm__("_ZN2nn2fs13MountSaveDataEPKcRKNS_7account3UidE");
IMPORT Result fs_OpenFile(FileHandle *out, const char *path, int mode) __asm__("_ZN2nn2fs8OpenFileEPNS0_10FileHandleEPKci");
IMPORT Result fs_ReadFile(u64 *got, FileHandle h, s64 off, void *buf, u64 n) __asm__("_ZN2nn2fs8ReadFileEPmNS0_10FileHandleElPvm");
IMPORT Result fs_WriteFile(FileHandle h, s64 off, const void *buf, u64 n, const WriteOption *o) __asm__("_ZN2nn2fs9WriteFileENS0_10FileHandleElPKvmRKNS0_11WriteOptionE");
IMPORT Result fs_GetFileSize(s64 *out, FileHandle h) __asm__("_ZN2nn2fs11GetFileSizeEPlNS0_10FileHandleE");
IMPORT Result fs_FlushFile(FileHandle h) __asm__("_ZN2nn2fs9FlushFileENS0_10FileHandleE");
IMPORT void fs_CloseFile(FileHandle h) __asm__("_ZN2nn2fs9CloseFileENS0_10FileHandleE");
IMPORT Result fs_CreateFile(const char *path, s64 size) __asm__("_ZN2nn2fs10CreateFileEPKcl");
IMPORT Result fs_Commit(const char *name) __asm__("_ZN2nn2fs6CommitEPKc");
IMPORT u32 test_mode(void);
IMPORT void test_written(void);

static u8 cache[0x1000], buf[0x4000];
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  Line l; u64 n = 0; FileHandle f; s64 size = 0;
  fs_QueryMountRomCacheSize(&n);
  say_x("MountRom: ", fs_MountRom("rom", cache, n));
  say_x("open a file that is not there: ", fs_OpenFile(&f, "rom:/nothing.bin", 1));
  if (fs_OpenFile(&f, "rom:/data/blob.bin", 1) || fs_GetFileSize(&size, f)) { say("cannot open rom:/data/blob.bin"); return 1; }
  u64 sum = 0xcbf29ce484222325ul, total = 0;
  for (s64 off = 0; off < size; ) {
    u64 got = 0;
    if (fs_ReadFile(&got, f, off, buf, sizeof buf) || !got) break;
    for (u64 i = 0; i < got; i++) { sum ^= buf[i]; sum *= 0x100000001b3ul; }
    off += got; total += got;
  }
  fs_CloseFile(f);
  l.n = 0; l_s(&l, "rom:/data/blob.bin: "); l_u(&l, total); l_s(&l, " bytes of "); l_u(&l, size); l_s(&l, ", fnv64 "); l_x(&l, sum); l_out(&l);
  Uid uid = { { 0x1234, 0x5678 } };
  say_x("EnsureSaveData: ", fs_EnsureSaveData(&uid));
  say_x("MountSaveData: ", fs_MountSaveData("save", &uid));
  u64 counter = 0, got = 0;
  if (fs_OpenFile(&f, "save:/counter.bin", 1) == 0) {
    fs_ReadFile(&got, f, 0, &counter, 8); fs_CloseFile(f);
    say_u("save:/counter.bin holds ", counter);
  } else {
    say("save:/counter.bin is not there yet");
    say_x("CreateFile: ", fs_CreateFile("save:/counter.bin", 8));
  }
  counter++;
  WriteOption opt = { 0 };
  if (fs_OpenFile(&f, "save:/counter.bin", 2)) { say("cannot open the counter for writing"); return 1; }
  Result w = fs_WriteFile(f, 0, &counter, 8, &opt);
  fs_FlushFile(f); fs_CloseFile(f);
  l.n = 0; l_s(&l, "wrote "); l_u(&l, counter); l_s(&l, ": rc="); l_x(&l, w); l_out(&l);
  if (test_mode() == 1) { test_written(); for (;;) svcSleepThread(1000000); }
  say_x("Commit: ", fs_Commit("save"));
  return 0;
}
