#!/usr/bin/env python3
"""The reference for src/prepare/match.ts: nxnative's own dm/tools/nso_match.py (with Capstone) on an unpacked image.

  match_reference.py <nxnative> <text end | -> <image file> [...]     one JSON line per image:
      {"functions": {"<start>": "<fingerprint>" or "!<why it has none>"}, "error": null or "<MatchError>"}
  With "-" for the text end, each image's is read from "<image file>.end".

Used by test/prepare/run.mts when the nxnative checkout and Capstone are there; nothing of nxnative is copied here.
"""
import json, os, sys


def main():
    nx, text_end, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    sys.path.insert(0, os.path.join(nx, "dm", "tools"))
    import nso_match
    for path in files:
        with open(path, "rb") as f: image = bytearray(f.read())
        # "<file>.end" holds the image's text end when the one on the command line is "-"
        end = int(open(path + ".end").read()) if text_end == "-" else int(text_end, 0)
        out = {"functions": {}, "error": None}
        try:
            m = nso_match.Image(image, end)
            for start in sorted(m.functions):
                try: out["functions"][str(start)] = m.fingerprint(start)
                except nso_match.MatchError as e: out["functions"][str(start)] = "!" + str(e)
        except nso_match.MatchError as e: out["error"] = str(e)
        print(json.dumps(out))


if __name__ == "__main__":
    main()
