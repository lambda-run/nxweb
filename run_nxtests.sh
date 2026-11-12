#!/bin/sh
# nxnative's own unit tests of the thread core, unchanged, against the ported hle_thread.c under Emscripten pthreads.
# Usage (in the VM): sh build_nxtests.sh        builds (build.py nxtests) and runs; results in logs/nxtests.log
R=/ctl/nxem; B=$R/build/nxtests
python3 $R/build.py nxtests || exit 1
: > $R/logs/nxtests.log
for t in t_condvar t_condvar_old t_sync_wait t_pollwait t_clockwait; do
  [ -f $B/$t.js ] || { echo "== $t: did not build" >> $R/logs/nxtests.log; continue; }
  echo "== $t" >> $R/logs/nxtests.log
  (cd $B && timeout 60 node $t.js >> $R/logs/nxtests.log 2>&1; echo "rc=$?" >> $R/logs/nxtests.log)
done
echo NXTESTS_DONE >> $R/logs/nxtests.log
