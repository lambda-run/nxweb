"""Give the "?" entries of tools/audit64.allow the class a person decided after reading each (this file is the record
of that review; run once after `node tools/audit64.mjs --update`)."""
import re, sys
RULES = [
 # (file regex, text regex, class, reason for class A)
 (r"src/audio/base\.ts", r"^& 0xFFFFFFFF", "W", ""),
 (r"src/fs/base\.ts", r"^<u32>p$", "W", ""),
 (r"src/audio/base\.ts", r".", "O", ""),
 (r"src/audio/opus\.ts", r"^<u32>r$", "C", ""),
 (r"src/audio/rsink\.ts", r"^<u32>p$", "A", "the PCM block inside a Sink record; Sink records are the module's static data (SINKS), in the host area"),
 (r"src/audio/stream\.ts", r"^<i32>p$", "O", ""),
 (r"src/fs/base\.ts", r".", "H", ""),
 (r"src/fs/fs\.ts", r"load<u32>\(p, 24\)|<u32>snap", "H", ""),
 (r"src/fs/fs\.ts", r".", "C", ""),
 (r"src/fs/romfs\.ts", r".", "O", ""),
 (r"src/fs/save\.ts", r".", "H", ""),
 (r"src/gfx/(astc|fmt)\.ts", r".", "C", ""),
 (r"src/gfx/dispatch\.ts", r".", "C", ""),
 (r"src/gfx/cmd\.ts", r"<u32>m|load<u32>\(s", "H", ""),
 (r"src/gfx/cmd\.ts", r".", "C", ""),
 (r"src/gfx/lower\.ts", r"<u32>load<u64>\((VBUF|WR|b)", "A", "the size of a buffer range (the address beside it is 8 bytes in the record): host records carry sizes as u32, and a WebGPU buffer binding is far below 4 GB"),
 (r"src/gfx/lower\.ts", r".", "C", ""),
 (r"src/gfx/pipeline\.ts", r".", "H", ""),
 (r"src/gfx/texcontent\.ts", r".", "C", ""),
 (r"src/glue/audio_host\.ts", r"ringHeader", "S", ""),
 (r"src/glue/fs_romfs_one\.ts", r".", "S", ""),
 (r"src/glue/gfx_host\.ts", r"usage & ~0x08", "B", ""),
 (r"src/glue/gfx_host\.ts", r"new Uint32Array\(this\.memory\.buffer, addr", "A", "an index buffer in guest memory viewed in place: the typed array's byte offset is a number (exact above 4 GB), its elements are the indices"),
 (r"src/glue/gfx_host\.ts", r".", "S", ""),
 (r"src/glue/hle_host\.ts", r"size >>> 0", "B", ""),
 (r"src/glue/rt_runtime\.ts", r"& ~15n", "B", ""),
 (r"src/glue/rt_runtime\.ts", r"image\.length & ~3", "S", ""),
 (r"src/hle/index\.ts", r".", "O", ""),
 (r"src/hle/os\.ts", r".", "H", ""),
 (r"src/hle/ro\.ts", r".", "O", ""),
 (r"src/hle/", r".", "C", ""),
 (r"src/kernel/", r".", "C", ""),
 (r"src/loader/host/loader\.mts", r"Uint32Array", "A", "the image offsets ld_code_entries writes (u32 by design: an image is below 4 GB whatever its address); the module's base is added as a number"),
 (r"src/loader/module\.ts", r"load<u32>\((hostRec\(id\)|r)\)", "O", ""),
 (r"src/loader/module\.ts", r"\(v - base\)|\(copy - arena\)|arenaTop - arena", "O", ""),
 (r"src/loader/lz4\.ts", r"d - dst", "O", ""),
 (r"src/kernel/base\.ts", r"^store<u32>\(<usize>addr, v\)", "D", ""),
 # everything else the wide-name rule asked about was read in the lists of the phase 2 review (audio, fs, kernel,
 # loader, gfx, hle): counts, indices, ids, handles, sizes and differences of two addresses inside one block
 (r".", r"^store<", "D", ""),
 (r".", r"^<usize>\s*load<", "O", ""),
 (r".", r".", "C", ""),
]
p = "tools/audit64.allow"
out, left = [], 0
for line in open(p).read().split("\n"):
    f = line.split("\t")
    if len(f) >= 4 and f[1] == "?":
        for fr, tr, cls, why in RULES:
            if re.search(fr, f[0]) and re.search(tr, f[3]):
                f[1] = cls
                f = f[:4] + ([why] if why else [])
                break
        else:
            left += 1
            print("no rule:", line)
        line = "\t".join(f)
    out.append(line)
open(p, "w").write("\n".join(out))
print("left unreviewed:", left)
