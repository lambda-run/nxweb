#!/bin/sh
# run_p4.sh [seconds] (in the VM): the boot harness on the game's extracted code (tools/extract_exefs.mts first). Log: logs/p4.log
cd /ctl/nxweb-em/em/build/p4 && NX_CACHE=${NX_CACHE-/ctl/nxweb-em/em/cache} timeout $(( ${1:-120} + 60 )) node $NX_NODE_FLAGS p4.js /ctl/nxweb-em/em/build/game/exefs translator.shared.wasm helpers.shared.wasm loader64.wasm ${1:-120} > /ctl/nxweb-em/em/logs/p4.log 2>&1; echo "rc=$?" >> /ctl/nxweb-em/em/logs/p4.log
