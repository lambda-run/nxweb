# fs: nn::fs on RomFS images and transactional save containers

The file system of the guest: the 73 `nn::fs` functions nxnative takes over in `dm/host/hle_fs.c`, with nxnative's
result values. Logic is AssemblyScript (`build/fs/fs.wasm`); storage is reached through seven imports that the
TypeScript glue implements over a Blob, the Origin Private File System, files (Node) or memory.

| File | What |
|---|---|
| `index.ts` | The exports (`fs_init`, `fs_lookup`, `fs_call`, `fs_complete`, configuration, counters) |
| `names.ts` | Generated: nxnative's names in the order of `hle_fs.c`, `Fn.<x>` = its `h_fs_<x>` (`host/gen_names.mts`) |
| `fs.ts` | Mount-name table, paths, handle tables, call contexts (pending / resume), one function per name |
| `romfs.ts` | RomFS images: tables in the arena, the complete check at load, lookups |
| `save.ts` | Save containers: working tree, extents, copy on write, the commit protocol, loading |
| `base.ts` | Result codes, the storage imports, the log line, guest pointer checks, the arena allocator |
| `defs/*.json` | The six machines (diagrams: `docs/machines/fs_*.md`) |
| `../glue/fs_host.ts` | `FsHost`: instantiates the module, implements the imports over `FsDevice` objects, completes pending calls. `MemDevice`, `BlobDevice`, `MemStorage` |
| `../glue/fs_dev_opfs.ts` | `OpfsStorage`: saves in OPFS with synchronous access handles (Worker), images as Blobs |
| `../glue/fs_dev_node.ts` | `NodeStorage`: images and save containers as files |
| `../../tools/mkromfs.py` | Builds RomFS images (from a folder, or synthetic trees) and reads them with an independent reader |

```
npm run fs:test [-- <filter>]   # Node: 66 tests, about 30 s
npm run fs:browser              # headless Chromium (Playwright), in a Worker, real OPFS
npm run kit:test                # includes test/fs/fs.machine.test.mts
```

## API toward the runtime

```
fs_init(arenaBase, arenaLen)          once; the arena holds image tables, save trees, directory snapshots
fs_lookup(namePtr) -> fnId            a mangled name (NUL-terminated, in linear memory); 0 = not an fs name
fs_call(fnId, argsPtr) -> i64         argsPtr: x0..x7 as the guest passed them
fs_complete(token, status) -> i64     called by the glue, not by the runtime
```

Guest pointers index linear memory directly (64-bit addresses are wrapped to 32 bits). Every pointer the module
writes or reads through is first checked to lie inside the memory and not be null; a bad one fails the call with
0x2A2 instead of trapping.

`fs_call` returns what the guest gets in x0 (a Result, a bool, an open mode; 0 for a void function), or one of two
values no result can have:

- `0xFFFFFFFF_<token>` **pending**: a storage call did not finish at once. Park the guest thread. When the storage
  call settles, `FsHost` calls `fs_complete(token, status)`, and when that returns a result it calls
  `options.completed(token, result)`: wake the thread with x0 = result.
- `0xFFFFFFFE_00000000` **retry**: the save or image the call needs is held by a pending call of another thread (a
  commit between its barriers, a mount that is opening, an image being loaded), or all 64 call contexts are in
  use. Nothing was done. Park the thread and make the same `fs_call` again after any `completed`.

Only mutating calls wait for a commit in flight; reads, listings and closes do not. With synchronous storage
neither value is ever returned (`Fs.callSync` in the tests asserts that). The runtime's part (not written, it is
not this area's): route the host stubs of the names `fs_lookup` knows to `fs_call`, park on the two values, and
return to the event loop when every runnable thread is parked on fs, since a promise cannot settle inside a
synchronous run loop. In a Worker with `OpfsStorage.preopen()` and `BlobDevice` (FileReaderSync) nothing pends at
all (browser test "a container opened ahead of the mount").

**Names.** All 73 `HLE` / `HLE_FORCE` names of `hle_fs.c` resolve (checked against the file when the clone is
there). 72 are implemented. One is a stub: `nn::fs::MountSystemData` logs
`[RED] _ZN2nn2fs15MountSystemDataEPKcNS_3ncm12SystemDataIdEPvm unimplemented` once and returns 0x7D402 (nxnative
has a stand-in for the MiiModel archive only, built by its Mii code). `fs_fn_is_stub(id)` tells the embedder.

**Results** (`hle.h`, `hle_fs.c`): 0 ok, 0x2A2 nxnative's generic failure, 0x202 path not found, 0x402 path exists,
0x7D402 target not found. Sizes are nxnative's constants (256 MB save / journal / free space, 0x1000 cache, 0x300
path and name lengths).

**Handles.** A guest handle is `((tag << 28) | (generation << 12) | slot) << 4`: never 0, 16-byte aligned (a
FileHandle is a heap pointer on Horizon and a game may use its low bits; they are ignored on the way in), and a
slot answers to a new value after each close. Handle 0, which a game keeps after a failed open, is answered as
nxnative answers it (quiet failure, `*out = 0`); any other value that is not open fails with a red line. 1024
files and 256 directories can be open.

**Configuration.** `fs_set_program_id` (for `IsSaveDataExisting(ApplicationId)`); `fs_set_account_save(1|0|-1)`:
whether the game imports `MountSaveData`, which decides if device save data is a save of its own (nxnative's
`dm_game_imports`); by default the module remembers whether `fs_lookup` was asked for that name.

**Shared memory.** For the runtime's one linear memory build with
`asc src/fs/index.ts --runtime stub -O2 --importMemory --zeroFilledMemory --memoryBase <lo>`: 399,420 bytes of
static data from the base (`fs_static_end()`), plus the arena given to `fs_init`. The arena needs the four RomFS
tables of every mounted image (their size in the image, about 60 to 80 bytes a file) plus one sixteenth of that
while an image is checked; a save tree is 64 bytes a node plus names. A test builds this variant and runs it on a
foreign memory.

## Storage interface

Seven imports (module `fs`), a block device in all but name. A device is a RomFS image (read only) or a save
container (one growable byte array per save backing).

| Import | |
|---|---|
| `dev_open(kind, index: i64, token) -> i32` | The device of a backing: an id >= 0x100, a negative error, or 1 = pending. `kind`: 0 game files, 1 add-on content `index`, 2 system data, 3 account save, 4 device save, 5 cache storage `index`, 6 temporary storage. A save kind is created when missing; a missing image is -1 |
| `dev_size(dev) -> i64` | Never pends |
| `dev_read(dev, off: i64, ptr, len, token) -> i32` | Exactly `len` bytes into memory at `ptr`. May pend for an image; **must be synchronous for a save device** |
| `dev_write(dev, off: i64, ptr, len) -> i32` | Extends the device. Never pends |
| `dev_flush(dev, token) -> i32` | Barrier: everything written before is durable when it completes. May pend |
| `dev_remove(kind, index, token) -> i32` | Delete a stored container (DeleteCacheStorage). May pend |
| `save_failed(errno)` | nxnative's `front_save_failed`: tell the player a save could not be written |

Status: 0 ok, 1 pending, -1 not found, -2 I/O error, -3 no space. A pending call is completed with
`fs_complete(token, status)` (for `dev_open`: the device id or the error).

The asynchronous points are therefore few, and each is an explicit phase of a call context (`fs_pend`), not a
suspended stack: opening a device, reading an image, a flush, a removal. Writes and save reads are synchronous so
that a `WriteFile` never has to be resumed half done; an environment without synchronous save access (the main
thread) would keep the container in memory and make only `flush` asynchronous. That device is not written.

`FsHost` copies the bytes of an asynchronous read into linear memory when they arrive, with a fresh view: the
memory may have grown in between.

| Backing | Browser (`OpfsStorage`, Worker) | Node (`NodeStorage`) |
|---|---|---|
| game files, add-on content | a `Blob` / `File`, read by slices (FileReaderSync, or asynchronously) | a file, positional reads |
| account / device save, cache storage `i` | `<dir>/save.nxsv`, `device.nxsv`, `cache<i>.nxsv` in OPFS, one synchronous access handle each | the same names in a directory |
| temporary storage | memory | memory |

## RomFS

The standard format: a 0x50-byte header, directory hash table, directory metadata, file hash table, file
metadata, data section. At mount the four tables are read into the arena (never the data: a multi-GB image costs
its tables) and **checked completely**, so that nothing after the mount needs a bounds check:

1. header: size 0x50; every table inside the device, 4-byte aligned, below 2 GB; the data offset inside the device;
2. both metadata tables are walked entry by entry: each entry fits, names are 1..0x300 bytes without NUL or `/`
   and are not `.` or `..`, the table ends exactly at its last entry; the entry starts go into a bitmap;
3. every parent, sibling, child, file and hash-chain reference is "none" or an entry start; every file's
   `offset + size` lies inside the device (64-bit, overflow-free);
4. the tree is walked from the root without a stack: every directory and file is reached exactly once, through a
   parent that names it (no cycle, no entry under two directories, no entry nobody lists);
5. every hash chain is walked: each entry is in the bucket of its own (parent, name), and each is in one chain.

An image that fails is refused with a red line naming the reason, leaves nothing in the arena and stays refused.
Lookups go through the hash tables; names are bytes and case-sensitive. Listings follow the child chains
(directories, then files) and need no snapshot. A read is one `dev_read` from the device into the guest's buffer,
cut at the file's end.

Paths (all mounts): the name before the first `:` is the mount; backslashes are slashes; empty components and `.`
are dropped; `..` goes up lexically and above the root is "not found" (nxnative's `norm_rest`); a component longer
than 0x300 bytes or a path of 1024 bytes or more fails with 0x2A2 (nxnative's `ENAMETOOLONG`). A name that
contains a backslash can be listed and not opened.

## Saves

One container per backing, a working tree in the arena, and four machine states that matter: `Clean` (the working
tree is the committed version), `Dirty`, `Poisoned` (a storage write failed; the next commit is refused, the
working copy is discarded and rebuilt from the committed version, the front end is told: nxnative's rule, since
games do not look at `WriteFile`'s result), `ReadOnly` (the container could not be opened or read: the mount
succeeds, writes fail, commits are no-ops, as nxnative's fallback). Two names for one backing share its tree and
its transaction. Mounts are permanent, as in nxnative: what is not committed is gone at the next session's mount.

### Container layout

```
0x0000  superblock slot A (64 bytes)      0x1000  superblock slot B (64 bytes)      0x2000 ..  extents
slot      magic "NXWSAVE1" | generation | manifest offset | manifest length | manifest checksum | node count | 0
          | checksum of these 56 bytes                                        (u64 each, FNV-1a 64)
manifest  "NXMF" | version 1 | node count | 0, then per node, parents first:
          parent position | type | name length | extent offset | extent capacity | size | name
```

A file is one extent (offset, capacity, size). The **committed version** is: the valid slot with the highest
generation, the manifest it names, the extents that manifest names.

### The commit protocol

Three rules hold between commits:

- **R1, copy on write.** A file whose extent belongs to the committed version is moved to a new extent before its
  first byte is written in a transaction (`ensure`): the old bytes are copied unless the write replaces them all.
- **R2, deferred reuse.** New extents come from the free list or from the end of the container. The free list
  never contains a byte of the committed version: an extent the committed version uses and the transaction no
  longer does (deleted, moved, the old manifest) goes to a deferred list, and at mount the free list is built as
  the gaps between the committed extents.
- **R3, the other slot.** A commit of generation g+1 writes slot `(g+1) & 1`; the committed slot is `g & 1`.

`Commit` on a Dirty save:

1. `Committing`: serialize the working tree into a manifest, write it to a fresh extent (R2).
2. **Barrier 1** (`dev_flush`): the manifest and every extent it names are durable. A failure up to here returns
   0x2A2, frees the manifest's extent and leaves the save Dirty: nothing committed was touched, the game may
   commit again.
3. `Sealing`: write the 64-byte slot of generation g+1. **This is the one atomic step.**
4. **Barrier 2**: the slot is durable.
5. `Clean`: the deferred list and the old manifest's extent become free; every file's extent now belongs to the
   committed version.

A failure in 3 or 4 leaves it unknown here which version the device holds, so the save is read back from the
device (`Recovering`), handles into the discarded copy turn `Stale`, and the call returns 0x2A2.

### Why a kill at any point leaves the old or the new version

Let V be the committed version of generation g when a transaction starts.

- *V's bytes are never written.* File data: R1 moves a file before writing it, and R2 keeps new extents off V's
  extents. V's manifest: only freed in step 5. V's slot: R3. So until step 3, whatever the process wrote and
  however it was torn, the device holds V intact, plus bytes nothing references.
- *Step 3 has two outcomes.* The slot region `(g+1) & 1` held generation g-1 (or nothing). After a killed write
  it holds the old content, a mix, or the new content. A mix fails the checksum; the old content has a lower
  generation. In both cases the highest valid generation is g: V. If the whole slot arrived, the highest is g+1,
  and by barrier 1 everything it names was durable before the slot was written.
- *After step 3 nothing V' = g+1 names is written* until the next transaction, to which the same argument applies
  with V'. Extents that only V used are reused after barrier 2 at the earliest, when V' is durably the highest
  generation, so no session can be sent back to V after its extents changed.
- *Recovery writes nothing.* The mount reads both slots, takes the highest valid generation, checks the manifest
  (checksum; every entry; extents inside the container and apart from each other) and builds the tree and the
  free list. Extents of a transaction that never committed are simply not in the manifest, hence free. So a kill
  during a mount, or during the rebuild after a refused commit, changes nothing either. The only write a mount
  ever makes is slot A of generation 0 into a container of at most 4096 bytes without a valid slot (a new one, or
  one whose first format was torn); a larger container without a valid slot is damaged and mounts read-only,
  untouched.

For a power loss, in which writes not yet flushed may be lost or torn in any combination, the same argument needs
only that `dev_flush` is a barrier: barrier 1 makes "V' complete" precede the slot, barrier 2 makes "V' is the
highest" precede the reuse of V's extents, and a commit has returned success only after barrier 2.

### What is verified

`npm run fs:test` (Node; every `[sync]`/`[async]` pair runs the same body with storage that finishes at once and
with storage whose opens, image reads, flushes and removals finish later):

- **Names and constants**: all 73 names in nxnative's order, the stub's red line, every constant answer, bad
  pointers; the `--importMemory` build on a foreign memory.
- **RomFS against the Python reader**: a generated tree (594 entries, depth 15, 360 paths with non-ASCII bytes, 51
  empty files): type, size and SHA-256 of every file, 400 random reads including across and past the end, the
  no-output `ReadFile` overloads; 7000 files in one directory and a tree of about 3700 entries; listing modes and counts; a
  5 GB and a 4 GB + 77 byte file in a sparse image (stamps at every GiB, reads around 2^32, the 64-bit size in
  listings, files stored after them); the path rules; open modes and every read-only result; handle rules.
- **Damaged images**: 6000 random mutations of header and tables, 300 cuts, 300 garbage files: 6495 refused, 105
  accepted (a changed size that still lies inside the image, a padding byte) and then walked completely; no trap,
  no read outside the device, nothing left in the arena by a refused image.
- **Saves**: create / delete / rename / directories with nxnative's result for every case, open modes, reads and
  writes at offsets, zero-filled gaps and growth, set-size, listing while the directory changes, a file deleted
  while open; commit and rollback at the next mount over 23 commits; the committed image byte-identical
  during a transaction; a container that stays the same size over 300 commits; shared and separate backings and
  `Commit` lists; poison, refused commit, rebuild, a rebuild that fails; a commit that fails at each of its four
  steps; read-only fallback (open fails, garbage, damaged manifest); temporary and cache storage; real files; the
  limits (512 names, 31-byte names, handle tables, a full arena); 4 x 400 random operations against a model in
  both storage modes; two guest threads with a commit in flight.
- **Crash safety** (`d_crash.test.mts`): the storage is killed at **every operation index** (size, read, write,
  flush) of five scenarios (first commit of a new save including the format; rewrite + patch + delete + rename +
  commit; three commits in a row; a write burst never committed; a refused commit with its rebuild), each write
  kill three ways (nothing, half, all of the write arrives) plus three power-loss outcomes per index: 518 kills.
  Then 400 random scenarios with 1600 random kills, half of them power losses. After each kill a new session must
  mount Clean, show exactly the last version whose Commit returned or the one whose Commit was in flight, and
  take one more commit. Five protocol bugs put in by hand (no copy on write, immediate reuse, no barrier 1, no
  barrier 2, one slot only) each made these tests fail; that check is not part of the suite. 1500 randomly damaged containers mount with a committed tree
  or read-only, without a write.
- **Machines**: the module itself takes all 46 transitions of its six machines in `fs:test`; `kit:test` takes each
  on its own and checks every other (state, event) pair is refused.

`npm run fs:browser` (Chromium 153, Worker, cross-origin isolated): 900 random operations and 59 commits over 9
sessions on real OPFS against the model; a second session while the first holds the container (read-only, then
read-write after the first closes); cache storages and `DeleteCacheStorage`; a container opened ahead of the
mount (no pending call); a 4.3 MB image in a Blob read through FileReaderSync and through asynchronous slices
(232 pending calls) against the Python reader's SHA-256; and **a page reload inside each of the 8 storage
operations of a transaction and its commit** (a killed write lands half): the old version up to and including
the torn superblock write, the new one after it.

Found by that test: after a reload Chromium releases the dead Worker's access handle about 2 s later, so
`OpfsStorage` retries a refused open for 5 s (`lockWaitMs`) before the mount falls back to read-only.

## Departures from nxnative, and why

| nxnative | here | why |
|---|---|---|
| Game files are a host folder or a `DMROMFS1` image; overlays (`DM_ROMFS_OVERLAY`) | One standard RomFS image; no folder, no `DMROMFS1`, no overlay | The brief; a browser has no folder. nxnative's packer writes `DMROMFS1`, so a web packer must write standard RomFS (or a reader for the 24-byte-entry format is added: it is simpler than this one) |
| A save is a folder; the working copy is an APFS clone; commit is clone + `RENAME_SWAP` | One container file, copy on write per file, a superblock slot as the atomic step | OPFS has no directory swap and no clone; every OPFS operation except read / write / flush on an open access handle is asynchronous even in a Worker, so a store with one file per guest file would make every create, delete and first write a pending call |
| Transaction encoded in `commit[0]`, `txn_root`, `ro`, an atomic `poison`; modes in `g_fmode[fd]` | `fs_save`, `fs_file`, `fs_dir`, `fs_mount`, `fs_image`, `fs_pend` | The brief |
| A write through a read-only fd fails with EBADF **and poisons the transaction** | Fails with 0x2A2, does not poison | Only a storage failure can lose data; a mode error is the game's |
| After a refused commit, handles point into the deleted work folder (red line) | They are `Stale`: every use fails until closed (red line) | The same situation made explicit |
| A commit that fails keeps the work folder in every case | Kept when it fails before the slot write; read back from the device after | See the protocol: after a failed slot write the device decides |
| Commit of an unchanged save clones and swaps | No-op (counted) | Nothing to write |
| Cache storage and temporary storage are plain folders: writes are durable at once, `Commit` skips them | Cache storage is a container that needs `Commit` (as on Horizon, where it is journaled); a `Commit` list commits each cache storage in it after checking the save data rule. Temporary storage is memory | A container is only consistent at a commit; temporary storage does not outlive the application on Horizon |
| `DeleteCacheStorage` removes the folder even while mounted | Refused (0x2A2, red) while mounted | The mounted tree would outlive its container |
| `rename(2)` works between two mounts on one volume | Fails between two backings | Two containers |
| Missing game files, a full mount table, an unset `DM_SAVE`: `die` | 0x2A2 with a red line | A module cannot exit the page |
| Null or wild guest pointers crash the host | 0x2A2 | No traps |
| Path operations on an image mount resolve against the image file's host path (mostly "not found") | Existing path: 0x2A2 (0x402 for create); missing: 0x202 (0x2A2 for create) | What the folder-backed read-only mount answers |
| `DeleteDirectoryRecursively` of a mount's root removes the work folder | Empties the root and keeps it | The mount stays usable |
| `Unmount` of a name in the SDK's own table calls the SDK's `Unmount` | Nothing (the name is not ours) | The module makes no guest calls; if a game needs it the runtime must do it |
| `.dm-case-N` names and the guest-name xattr; `save_old_names` | None | Names are bytes in the module's own tree; there are no saves from older hosts |
| `DM_FSLOG`, `DM_FS`, `DM_TEST_*` injection, save sync, write-protected texture pages, the big host stack | None | Tests inject faults in the storage; the rest belongs to other parts or to Apple's kernel |

Kept on purpose although odd: mounts are permanent and `Unmount` only releases an add-on content name; a write
past the end extends a file whatever the open mode says about appending; `Write`-less `AllowAppend` opens
write-only; opening a directory for writing is 0x2A2 and for reading 0x202; names longer than 31 bytes are cut
and then match nothing; a path of 1024 bytes fails.

## Gaps

- **Not wired into the runtime.** Dispatching host stubs to `fs_call`, parking threads on pending / retry and
  giving the module a range of `rt_layout.ts` are the runtime owner's; the shared-memory build is tested.
- **No save device for the main thread** (no synchronous access handles there). The interface allows one.
- **One writer.** A second tab mounts the save read-only.
- **Durability rests on `flush`.** The kill and reload cases are verified in Chromium; a power loss is verified
  against the model in Node only, and whether OPFS `flush()` is a barrier to the medium is the browser's.
- **No checksum on file data**, only on the slots and the manifest. If the newer slot is destroyed after its
  commit was sealed (bit rot, not a crash), the mount takes the previous generation, whose extents may have been
  reused since. A torn slot and a rotten one cannot be told apart at mount.
- **Costs.** The first partial write to a committed file copies the whole file (once per file per transaction);
  growing a file moves it when its extent is full (capacity doubles); gaps and growth are zero-filled by writes;
  the free list is first-fit without compaction and the container file is never truncated (it is reused: 300
  commits of a 20 KB save end at 121 KB).
- **A read error while an image loads** marks it refused for the session, like a damaged one.
- **Limits**: 24 save backings, 600 images, 64 concurrent pending calls, single reads below 4 GB, device offsets
  below 2^53 (they cross the glue as numbers).
- **Not tested in a browser**: an image larger than 4 GB (Node reads one from a sparse file).
- `MountSystemData` is a stub; `QueryMountSystemDataCacheSize` answers 0x1000.
