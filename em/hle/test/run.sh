#!/bin/sh
# nxem HLE thunk tests (run in the VM): sh /ctl/nxweb-em/em/hle/test/run.sh [thunks|all]
#   thunks  generate + compile + link + run t_thunks under node (4 nxnative files unedited + t_marshal.c)
#   all     generate for every nxnative HLE file and compile every generated translation unit (-c only); prints
#           which compile. The thunks' compile-time checks (NX_CHK_*) run for every entry of a file that compiles.
set -e
. /ctl/emsdk/env.sh > /dev/null 2>&1
R=/ctl/nxweb-em/em; N=${NXNATIVE:-/ctl/repos/nxnative/dm}; B=$R/build/hle
CF="-O1 -pthread -D_GNU_SOURCE -sMEMORY64=1 -I$R/hle -I$R/kernel -I$R/kernel/shim -I$R/hle/shim -I$N/host -I$R/build/gen -I$N/gfx/nvn/include -I$N/third_party/libvpx -I$N/third_party/dav1d/include -I$N/third_party/stb_vorbis -Wno-version-check -Wno-int-to-pointer-cast -Wno-pointer-to-int-cast -Wno-format -Wno-unused-function"
case "${1:-thunks}" in
thunks)
    G=$B/test/gen; mkdir -p $G
    python3 $R/tools/gen_hle.py --out $G $N/host/hle_account.c $N/host/hle_friends.c $N/host/hle_audren.c $N/host/hle_table.c $R/hle/test/t_marshal.c > $B/test/report.tsv
    for f in hle_account hle_friends hle_audren hle_table t_marshal; do emcc $CF -I$G -c $G/$f.tu.c -o $B/test/$f.o & done; wait
    emcc $CF -c $G/hle_table.c -o $B/test/nx_hle_table.o
    emcc $CF -c $R/hle/test/t_thunks.c -o $B/test/t_thunks.o
    # nxnative's other files are not linked: what these four call from them (LOG, die, events ...) stays undefined
    # and would abort if reached; the functions the test calls do not reach them
    emcc -O1 -pthread -sMEMORY64=1 -Wno-version-check -sERROR_ON_UNDEFINED_SYMBOLS=0 -sWARN_ON_UNDEFINED_SYMBOLS=0 -sENVIRONMENT=node,worker -sEXIT_RUNTIME=1 \
        $B/test/hle_account.o $B/test/hle_friends.o $B/test/hle_audren.o $B/test/hle_table.o $B/test/t_marshal.o $B/test/nx_hle_table.o $B/test/t_thunks.o -o $B/test/t_thunks.js
    node $B/test/t_thunks.js ;;
all)
    G=$B/gen; mkdir -p $G $B/obj
    python3 $R/tools/gen_hle.py --out $G $N/host/*.c $N/gfx/hle_nv.c $N/gfx/hle_vi.c $N/gfx/nvn/hle_nvn.c > $B/report_all.tsv 2> $B/report_all.summary
    ls $G/*.tu.c | xargs -P 3 -I{} sh -c 'b=$(basename {} .tu.c); if emcc '"$CF"' -ferror-limit=0 -I'$G' -c {} -o '$B'/obj/$b.o 2> '$B'/obj/$b.err; then echo "ok $b"; else echo "FAIL $b $(grep -c "error:" '$B'/obj/$b.err)"; fi' | sort > $B/tu_compile.txt
    emcc $CF -c $G/hle_table.c -o $B/obj/nx_hle_table.o && echo "ok hle_table.c (the full table)" >> $B/tu_compile.txt
    grep -c "^ok" $B/tu_compile.txt; grep "^FAIL" $B/tu_compile.txt | tr '\n' ';' ;;
esac
