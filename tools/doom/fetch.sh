#!/bin/sh
# Fetches the Doom engine the Doom guest is built from: doomgeneric (https://github.com/ozkl/doomgeneric, GPL-2),
# at the commit the platform layer in test/doom/guest was written against. The engine is not part of this
# repository: it goes into build/third_party/doomgeneric (git-ignored), or nothing is fetched when DOOMGENERIC
# already names a checkout. The game data (a WAD file) is never fetched: DOOM_WAD names it.
#   tools/doom/fetch.sh            clone into build/third_party/doomgeneric
#   DOOMGENERIC=/path tools/doom/fetch.sh    only check that /path is a checkout of the engine
set -e
COMMIT=e257a09527062bfb986b6e5e0780839b6cbd5b71
URL=https://github.com/ozkl/doomgeneric
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=${DOOMGENERIC:-$ROOT/build/third_party/doomgeneric}
if [ -f "$DIR/doomgeneric/doomgeneric.h" ]; then
  HAVE=$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo unknown)
  if [ "$HAVE" != "$COMMIT" ]; then echo "doom: $DIR is at $HAVE, the platform layer was written against $COMMIT" >&2; fi
  echo "doom: the engine is at $DIR"
  exit 0
fi
if [ -n "$DOOMGENERIC" ]; then echo "doom: DOOMGENERIC=$DOOMGENERIC is not a doomgeneric checkout (no doomgeneric/doomgeneric.h)" >&2; exit 1; fi
mkdir -p "$(dirname "$DIR")"
git clone "$URL" "$DIR"
git -C "$DIR" checkout -q "$COMMIT"
echo "doom: the engine is at $DIR ($COMMIT)"
