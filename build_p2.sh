#!/bin/sh
# Proof 2 build: the ARM64 guest, nxweb's a64 host glue (bundled unchanged), and the Emscripten module.
set -e
. /ctl/emsdk/env.sh
NX=/ctl/repos/nxnative/dm; W=/mnt
M=${1:-32}   # 32 or 64: the linear memory's index type
R=/ctl/nxem; B=$R/build/p2; [ $M = 64 ] && B=$R/build/p2_64; mkdir -p $B $R/build/host $R/build/gen
# 1. guest: once with ARMv8.0 exclusives (LDAXR/STLXR), once as the Switch 2 builds are (LSE atomics, pointer authentication)
for v in v80 a78c; do
  [ $v = v80 ] && ISA="-march=armv8-a" || ISA="-mcpu=cortex-a78c -mbranch-protection=pac-ret+b-key+leaf -mno-outline-atomics"
  clang --target=aarch64-none-elf -ffreestanding -nostdlib -fno-builtin $ISA -O2 -w -c $R/guest/mt.c -o $B/mt.$v.o
  LD=$R/guest/guest.ld; [ $M = 64 ] && { sed 's/0x08000000/0x180000000/' $LD > $B/guest_hi.ld; LD=$B/guest_hi.ld; }
  ld.lld -T $LD $B/mt.$v.o -o $B/mt.$v.elf
  llvm-objcopy -O binary $B/mt.$v.elf $B/mt.$v.bin
  llvm-nm $B/mt.$v.elf | awk '/ guest_add3$/ {print $1}' > $B/mt.$v.add3
  llvm-objdump -d $B/mt.$v.elf | grep -c -E "ldaxr|stlxr|ldxr|stxr|casa?l?\s|ldadd" | sed "s/^/mt.$v: exclusive or LSE instructions: /"
done
# 2. nxweb's translator host glue and layout, bundled as they are; the translator and helpers as nxweb built them
printf 'export { A64Host } from "%s/src/glue/a64_host.ts";\nexport { A64, HOST_END } from "%s/src/glue/rt_layout.ts";\n' $W $W > $B/a64_entry.ts
$W/node_modules/.bin/esbuild $B/a64_entry.ts --bundle --format=iife --global-name=NXA64 --outfile=$B/a64_host.js --log-level=warning
X=; [ $M = 64 ] && X=64
cp $W/build/runtime/translator$X.shared.wasm $B/translator.shared.wasm; cp $W/build/runtime/helpers$X.shared.wasm $B/helpers.shared.wasm
git -C $W rev-parse --short HEAD > $B/nxweb.rev
# 3. the Emscripten module
python3 $NX/games/game.py header 0400486024DEC000 $R/build/gen/game_profile.h
python3 $R/kernel/port_thread.py $NX/host/hle_thread.c $R/build/host/hle_thread.c
# Emscripten's data, stacks and heap go above the guest: 256 MB .. 512 MB of a 32-bit memory, 7 GB .. 8 GB of a 64-bit one
MEM="-sGLOBAL_BASE=268435456 -sINITIAL_MEMORY=536870912"; [ $M = 64 ] && MEM="-sMEMORY64=1 -sGLOBAL_BASE=7516192768 -sINITIAL_MEMORY=8589934592 -sMAXIMUM_MEMORY=8589934592"
CF="-O2 -g1 -pthread -D_GNU_SOURCE -I$R/kernel/shim -I$NX/host -I$R/build/gen -Wno-int-to-pointer-cast -Wno-pointer-to-int-cast -Wno-format -Wno-unused-function"
[ $M = 64 ] && CF="$CF -sMEMORY64=1"
emcc $CF $R/build/host/hle_thread.c $R/kernel/nx_shims.c $R/kernel/nx_guest.c $R/test/p2_main.c -o $B/p2.js \
  --js-library $R/kernel/nx_guest.js --pre-js $B/a64_host.js \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=8 $MEM \
  -sEXIT_RUNTIME=1 -sNODERAWFS=1 -sENVIRONMENT=node,worker -sEXPORTED_FUNCTIONS=_main,_malloc,_free
ls -la $B/p2.js $B/p2.wasm | awk '{print $5, $9}'
echo BUILD_P2_DONE
