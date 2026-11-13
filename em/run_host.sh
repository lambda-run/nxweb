#!/bin/sh
# run_host.sh [seconds] [name]  (in the VM): the page in the headless Chrome on the Mac (real GPU; vm/hostchrome.sh,
# DevTools at 192.168.64.1:9334) with the real game served from the VM (web/game_serve.mjs, port 8093). One job at a
# time in that browser (/ctl/host.lock) and no game-scale VM job beside it (/ctl/heavy.sh). URL: the page's Mac-side
# address; default /em-next/ with ?skipmovie=1. Output: logs/<name>.out, .console.txt, .png
cd /ctl/nxweb-em/em
i=0; while ! mkdir /ctl/host.lock 2>/dev/null; do
  # (stale after 30 minutes)
  if [ -n "$(find /ctl/host.lock -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rm -rf /ctl/host.lock; continue; fi
  i=$((i+1)); [ $i -gt 360 ] && { echo "run_host: /ctl/host.lock held by $(cat /ctl/host.lock/owner 2>/dev/null)"; exit 75; }; sleep 5; done
echo "nxem $(date -u +%H:%M:%S)" > /ctl/host.lock/owner
trap 'rm -rf /ctl/host.lock; [ -n "$GS" ] && kill $GS 2>/dev/null' EXIT INT TERM
pgrep -f game_serve.mjs > /dev/null || { node web/game_serve.mjs 8093 > logs/game_serve.log 2>&1 & GS=$!; sleep 1; }
S=${1:-240}; N=${2:-host}
CDP=http://192.168.64.1:9334 GAME_URL=${GAME_URL:-http://192.168.64.4:8093/zelda-oot.nup} URL="${URL:-http://localhost:8080/em-next/index.html?skipmovie=1&secs=$((S+600))}" \
  /ctl/heavy.sh nxem-host node web/em_run.mjs $S $N > logs/$N.out 2>&1
