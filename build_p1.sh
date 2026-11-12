#!/bin/sh
# Proof 1 build: nxnative's hle_thread.c + shims + the stress test -> build/p1/p1_stress.js (+ .wasm), node worker threads.
set -e
. /ctl/emsdk/env.sh
NX=/ctl/repos/nxnative/dm
R=/ctl/nxem; B=$R/build/p1; mkdir -p $B $R/build/host $R/build/gen
python3 $NX/games/game.py header 0400486024DEC000 $R/build/gen/game_profile.h
python3 $R/kernel/port_thread.py $NX/host/hle_thread.c $R/build/host/hle_thread.c
CF="-O2 -g1 -pthread -D_GNU_SOURCE -I$R/kernel/shim -I$NX/host -I$R/build/gen -Wno-int-to-pointer-cast -Wno-pointer-to-int-cast -Wno-format -Wno-unused-function"
emcc $CF $R/build/host/hle_thread.c $R/kernel/nx_shims.c $R/test/p1_stress.c -o $B/p1_stress.js \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=24 -sINITIAL_MEMORY=268435456 -sEXIT_RUNTIME=1 -sENVIRONMENT=node,worker
ls -la $B | tail -3
echo BUILD_P1_DONE
