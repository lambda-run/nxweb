#!/bin/sh
# naga as WebAssembly (build/shaders/nx_naga.wasm), from naga 30.0.1 with this repository's patches
# (tools/shaders/naga_wasm/patches): the crate is fetched from crates.io, checked against the checksum Cargo.lock had
# for it, unpacked into build/shaders/naga_src and patched there; tools/shaders/naga_wasm/Cargo.toml takes naga from
# that folder. Needs cargo with the wasm32-unknown-unknown target, and wget or curl.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
V=30.0.1
SUM=a616d2fb8c89516ac2723a581f69d6c18576046bed761bd6b305e5618e6ae130
W=$ROOT/build/shaders
P=$ROOT/tools/shaders/naga_wasm/patches
STAMP=$(cat "$P"/*.patch | sha256sum | cut -c1-16)
if [ "$(cat "$W/naga_src/.nxweb-patches" 2>/dev/null)" != "$STAMP" ]; then
  mkdir -p "$W"
  rm -rf "$W/naga_src" "$W/naga-$V"
  if command -v wget >/dev/null; then wget -q -O "$W/naga.crate" "https://static.crates.io/crates/naga/naga-$V.crate"; else curl -fsSL -o "$W/naga.crate" "https://static.crates.io/crates/naga/naga-$V.crate"; fi
  [ "$(sha256sum "$W/naga.crate" | cut -d' ' -f1)" = "$SUM" ] || { echo "build_naga: naga-$V.crate does not have the expected checksum" >&2; exit 1; }
  tar xzf "$W/naga.crate" -C "$W" && mv "$W/naga-$V" "$W/naga_src"
  for f in "$P"/*.patch; do patch -s -p1 -d "$W/naga_src" < "$f"; done
  echo "$STAMP" > "$W/naga_src/.nxweb-patches"
fi
cargo build --release --target wasm32-unknown-unknown --manifest-path "$ROOT/tools/shaders/naga_wasm/Cargo.toml" --target-dir "$W/naga_target"
cp "$W/naga_target/wasm32-unknown-unknown/release/nx_naga.wasm" "$W/nx_naga.wasm"
echo "build/shaders/nx_naga.wasm: $(wc -c < "$W/nx_naga.wasm") bytes (naga $V + $(ls "$P"/*.patch | wc -l) patch)"
