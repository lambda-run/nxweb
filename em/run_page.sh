#!/bin/sh
# run_page.sh [seconds] [name]  (in the VM): the page in headless Chromium with the real game (web/em_run.mjs), through
# /ctl/heavy.sh: a game-scale job, one at a time in the VM. Output: logs/<name>.out, .console.txt, .png
cd /ctl/nxweb-em/em && /ctl/heavy.sh nxem-page node web/em_run.mjs ${1:-240} ${2:-em} > logs/${2:-em}.out 2>&1
