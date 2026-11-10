#!/usr/bin/env python3
"""The reference for src/prepare/host/nup.ts: nxnative's own scripts/pack_nup.py (its Nup class) on a container.

  nup_reference.py <nxnative> <file.nup> [...]     one JSON line per container:
      {"error": null or "<pack_nup.Error>", "packages": [{"kind", "title_id", "version", "flags",
        "exefs": [[name, size, sha256 of what Nup.read gives]] or null, "romfs": [[path, size, sha256], ...] or null,
        "dirs": [paths of the folders under romfs], "meta": {"<TLV type>": sha256 of the payload}}]}
  Prints {"skip": "<why>"} and exits 0 when nxnative's reader cannot be used here (its zstd module is missing).

Used by test/prepare when the nxnative checkout is there; nothing of nxnative is copied here.
"""
import hashlib, importlib.util, json, os, sys


def main():
    nx, files = sys.argv[1], sys.argv[2:]
    path = os.path.join(nx, "scripts", "pack_nup.py")
    if not os.path.isfile(path):
        print(json.dumps({"skip": f"no {path}"})); return
    sys.path.insert(0, os.path.join(nx, "dm", "tools"))
    spec = importlib.util.spec_from_file_location("pack_nup", path)
    pack_nup = importlib.util.module_from_spec(spec); spec.loader.exec_module(pack_nup)
    if pack_nup.zstd is None:
        print(json.dumps({"skip": "nxnative's reader needs a zstd module here (Python 3.14's compression.zstd, or pip install backports.zstd)"})); return
    for f in files:
        out = {"error": None, "packages": []}
        try:
            with pack_nup.Nup(f) as n:
                def tree(d, prefix=""):
                    fs, ds = [], []
                    for name, isdir, i in n.children(d):
                        p = prefix + name.decode()
                        if isdir:
                            ds.append(p); a, b = tree(i, p + "/"); fs += a; ds += b
                        else: fs.append([p, n.files[i][1], hashlib.sha256(n.read(i)).hexdigest()])
                    return fs, ds
                for k in n.packages:
                    rom = tree(k.romfs) if k.romfs != pack_nup.NO_DIR else None
                    out["packages"].append({"kind": k.kind, "title_id": f"{k.title_id:016X}", "version": k.version, "flags": k.flags,
                        "exefs": sorted(tree(k.exefs)[0]) if k.exefs != pack_nup.NO_DIR else None,
                        "romfs": sorted(rom[0]) if rom else None, "dirs": sorted(rom[1]) if rom else None,
                        "meta": {str(t): hashlib.sha256(v).hexdigest() for t, v in sorted(k.meta().items())}})
        except pack_nup.Error as e: out = {"error": str(e).replace(f, "<file>"), "packages": []}
        print(json.dumps(out))


if __name__ == "__main__":
    main()
