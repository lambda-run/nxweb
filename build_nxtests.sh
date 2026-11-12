#!/bin/sh
# nxnative's own unit tests of the thread core, unchanged, against the ported hle_thread.c under Emscripten pthreads.
# Usage (in the VM): sh build_nxtests.sh        builds and runs; results in logs/nxtests.log
. /ctl/emsdk/env.sh
NX=/ctl/repos/nxnative/dm; R=/ctl/nxem; B=$R/build/nxtests; mkdir -p $B $R/build/host/tests $R/build/gen
python3 $NX/games/game.py header 0400486024DEC000 $R/build/gen/game_profile.h
python3 $R/kernel/port_thread.py $NX/host/hle_thread.c $R/build/host/hle_thread.c >/dev/null
cp $NX/host/tests/t_condvar.c $NX/host/tests/t_sync_wait.c $NX/host/tests/t_pollwait.c $NX/host/tests/t_clockwait.c $R/build/host/tests/
CF="-O1 -pthread -D_GNU_SOURCE -I$R/kernel/shim -I$NX/host -I$NX/host/tests -I$R/build/gen -Wno-int-to-pointer-cast -Wno-pointer-to-int-cast -Wno-format -Wno-unused-function -w"
LF="-sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=8 -sINITIAL_MEMORY=134217728 -sEXIT_RUNTIME=1 -sENVIRONMENT=node,worker"
T=$R/build/host/tests; S="$R/kernel/nx_shims.c $R/test/nxtest_stub.c"
emcc $CF -DDM_TEST_HOOKS $T/t_condvar.c $R/build/host/hle_thread.c $S -o $B/t_condvar.js $LF 2>&1 | grep -E "error" | head -5
emcc $CF -DDM_TEST_HOOKS -DDM_TEST_CV_OLD_ORDER $T/t_condvar.c $R/build/host/hle_thread.c $S -o $B/t_condvar_old.js $LF 2>&1 | grep -E "error" | head -5
for t in t_sync_wait t_pollwait t_clockwait; do emcc $CF $T/$t.c $S -o $B/$t.js $LF 2>&1 | grep -E "error" | head -5; done
: > $R/logs/nxtests.log
for t in t_condvar t_condvar_old t_sync_wait t_pollwait t_clockwait; do
  [ -f $B/$t.js ] || { echo "== $t: did not build" >> $R/logs/nxtests.log; continue; }
  echo "== $t" >> $R/logs/nxtests.log
  (cd $B && timeout 60 node $t.js >> $R/logs/nxtests.log 2>&1; echo "rc=$?" >> $R/logs/nxtests.log)
done
echo NXTESTS_DONE >> $R/logs/nxtests.log
