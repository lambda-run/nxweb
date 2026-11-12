#!/bin/sh
# run_p4.sh [seconds] (in the VM): the boot harness on the game's extracted code (tools/extract_exefs.mts first). Log: logs/p4.log
cd /ctl/nxem/build/p4 && timeout $(( ${1:-120} + 60 )) node p4.js /ctl/nxem/build/game/exefs translator.shared.wasm helpers.shared.wasm loader64.wasm ${1:-120} > /ctl/nxem/logs/p4.log 2>&1; echo "rc=$?" >> /ctl/nxem/logs/p4.log
