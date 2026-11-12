#!/bin/sh
# Scale check: per-thread compile + instantiate of all translated units (plain node; see test/scale_units.mts).
# Usage (in the VM): sh build_scale.sh [functions, default 10000]
N=${1:-10000}; R=/ctl/nxweb-em/em; B=$R/build/scale; W=/ctl/nxweb-em; mkdir -p $B/gen
cp $W/test/a64/guests/mini.h $B/mini.h
python3 $W/test/a64/guests/big_gen.py $B/gen/big.c $N
clang --target=aarch64-none-elf -ffreestanding -nostdlib -mcpu=cortex-a78c -mbranch-protection=pac-ret+b-key+leaf -mno-outline-atomics -O1 -fno-math-errno -w -c $B/gen/big.c -o $B/big.o
ld.lld -T $W/test/a64/guests/guest.ld $B/big.o -o $B/big.elf
llvm-objcopy -O binary $B/big.elf $B/big.bin
node $R/test/scale_units.mts $B/big.bin
echo SCALE_DONE
