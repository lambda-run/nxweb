#!/bin/sh
# run_p2.sh <v80|a78c> [mutex rounds] [compute rounds]   (in the VM)
cd /ctl/nxem/build/p2 && timeout 270 node p2.js mt.$1.bin translator.shared.wasm helpers.shared.wasm $(cat mt.$1.add3) ${2:-200000} ${3:-300000000}
