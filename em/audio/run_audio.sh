#!/bin/sh
# run_audio.sh [seconds] [rate] (in the VM): the boot harness (node) with the audio test's consumer thread in place of a
# sound card (audio/nx_audio.c). Build first: NXEM_P4=/ctl/nxweb-em/em/build/p4a python3 build.py p4
# A game-scale job: start it as  /ctl/heavy.sh audio sh audio/run_audio.sh 200  (one at a time in the VM).
# Log: logs/audio.log; the sound: logs/audio_title.wav (NX_AUDIO_TEST_SECS seconds from the first sample that is not silence)
E=/ctl/nxweb-em/em
cd $E/build/p4a && NX_AUDIO_LOG=1 NX_AUDIO_TEST=${WAV-$E/logs/audio_title.wav} NX_AUDIO_RATE=${2:-48000} NX_AUDIO_TEST_SECS=${SECS-5} NX_CACHE=${NX_CACHE-$E/cache} \
  timeout $(( ${1:-120} + 60 )) node $NX_NODE_FLAGS p4.js $E/build/game/exefs translator.shared.wasm helpers.shared.wasm loader64.wasm ${1:-120} > $E/logs/${LOG-audio}.log 2>&1; echo "rc=$?" >> $E/logs/${LOG-audio}.log
