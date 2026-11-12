#!/bin/sh
# check_all.sh: build everything with build.py and run every proof under node (in the VM). One line per result in logs/check_all.log
cd /ctl/nxweb-em/em; L=logs/check_all.log; : > $L
for t in "p1" "p2 --mem 32" "p2 --mem 64" "p2 --env web" "nxtests" "p4"; do python3 build.py $t > logs/build_$(echo $t | tr -d ' -').log 2>&1 || echo "[RED] build $t failed: $(grep -m1 -E 'error' logs/build_$(echo $t | tr -d ' -').log | cut -c1-200)" >> $L; done
(cd build/p1 && timeout 200 node p1_stress.js 8 20000 2>&1 | tail -1) >> $L
for v in v80 a78c; do sh run_p2.sh $v 1000000 100000000 0 mis 2>&1 | grep -E "^P2|RED|odd address" | sed "s/^/mem32 $v: /" >> $L; M=64 sh run_p2.sh $v 1000000 100000000 0 mis 2>&1 | grep -E "^P2|RED|odd address" | sed "s/^/mem64 $v: /" >> $L; done
sh run_nxtests.sh > /dev/null 2>&1; echo "nxnative unit tests: $(grep -c -E '^PASS|all passed' logs/nxtests.log) pass lines, $(grep -c -E 'FAIL|did not build' logs/nxtests.log) failures" >> $L
sh run_p4.sh 45; echo "boot: $(grep -c "host call #" logs/p4.log) host-call names reached, $(grep -c "^\[dm\] start [0-9]" logs/p4.log)/9 start calls, nnMain $(grep -q "entering nnMain" logs/p4.log && echo entered || echo NOT entered)" >> $L
echo CHECK_DONE >> $L
