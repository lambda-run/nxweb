#!/bin/sh
# Installs Emscripten 4.0.22 (python/JS only) under /ctl/emsdk, using Alpine's own clang 22 / lld and an extracted binaryen apk.
set -e
V=4.0.22
cd /ctl/emsdk
[ -x binaryen/usr/bin/wasm-opt ] || { mkdir -p apk binaryen; apk fetch -q binaryen -o apk; tar -xzf apk/binaryen-*.apk -C binaryen 2>/dev/null; }
if [ ! -f emscripten/emcc.py ]; then
  wget -q -O em.tgz https://github.com/emscripten-core/emscripten/archive/refs/tags/$V.tar.gz
  rm -rf emscripten && mkdir emscripten
  tar -xzf em.tgz -C emscripten --strip-components=1 --exclude='*/test/*' --exclude='*/site/*'
  rm em.tgz
fi
cd emscripten
[ -f emar ] || python3 tools/maint/create_entry_points.py >/dev/null 2>&1 || true   # fails at the end on test/runner (not unpacked); the tool launchers are written before that
[ -d node_modules/acorn ] || npm install --omit=dev --no-audit --no-fund --ignore-scripts >/dev/null 2>&1 || echo "npm install failed"
cat > /ctl/emsdk/emscripten.cfg <<EOC
LLVM_ROOT = '/usr/bin'
BINARYEN_ROOT = '/ctl/emsdk/binaryen/usr'
NODE_JS = '/usr/bin/node'
CACHE = '/ctl/emsdk/cache'
EOC
cat > /ctl/emsdk/env.sh <<EOC
export EM_CONFIG=/ctl/emsdk/emscripten.cfg
export PATH=/ctl/emsdk/emscripten:\$PATH
EOC
. /ctl/emsdk/env.sh
du -sh /ctl/emsdk/emscripten | tail -1
python3 emcc.py --version 2>&1 | head -3
echo INSTALL_DONE
