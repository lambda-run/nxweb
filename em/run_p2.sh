#!/bin/sh
# [M=64] run_p2.sh <v80|a78c> [mutex rounds] [compute rounds]   (in the VM)
D=/ctl/nxem/build/p2; [ "$M" = 64 ] && D=/ctl/nxem/build/p2_64
cd $D && timeout 270 node p2.js mt.$1.bin translator.shared.wasm helpers.shared.wasm $(cat mt.$1.add3) ${2:-200000} ${3:-300000000}
