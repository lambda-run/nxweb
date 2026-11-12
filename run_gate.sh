#!/bin/sh
# run_gate.sh <log name> <seconds> [many threads] [mis|-] [cache blob URLs, comma separated]   (in the VM; web/serve.mjs must be up)
cd /ctl/nxem && cp web/p2.html build/web/p2/index.html
A="mt.a78c.bin,translator.shared.wasm,helpers.shared.wasm,$(cat build/web/p2/mt.a78c.add3),${MR:-300000},30000000,${3:-24},${4:--}${5:+,$5}"
timeout $(( $2 + 30 )) node web/gate.mjs "$A" $2 > logs/$1.log 2>&1; echo "rc=$?" >> logs/$1.log
