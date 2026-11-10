#!/bin/sh
# nxnative's shader translator (dm/gfx/tools/dmsh_xlate/Program.cs + the vendored Ryujinx projects) published for the browser: build/shaders/xlate_wasm/_framework.
# Needs the .NET 10 SDK (no workload: the assemblies are trimmed and run by the runtime's interpreter). The sources are copied first, because a build writes
# obj/ and bin/ beside every project and the nxnative checkout is not ours to write in.
set -e
NXNATIVE=${NXNATIVE:-/home/user/nxnative}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/build/shaders/xlate_wasm_src
rm -rf "$W" && mkdir -p "$W/dm/gfx/tools/xlate_wasm" "$W/dm/third_party"
cp -r "$NXNATIVE/dm/gfx/tools/dmsh_xlate" "$W/dm/gfx/tools/"
cp -r "$NXNATIVE/dm/third_party/ryujinx" "$W/dm/third_party/"
cp "$ROOT/tools/shaders/xlate_wasm.csproj" "$W/dm/gfx/tools/xlate_wasm/"
(cd "$W/dm/gfx/tools/xlate_wasm" && DOTNET_CLI_TELEMETRY_OPTOUT=1 dotnet publish -c Release -o "$W/out" -nologo -v q)
rm -rf "$ROOT/build/shaders/xlate_wasm" && mkdir -p "$ROOT/build/shaders/xlate_wasm"
cp -r "$W/out/wwwroot/_framework" "$ROOT/build/shaders/xlate_wasm/"
echo "build/shaders/xlate_wasm/_framework: $(cat "$ROOT"/build/shaders/xlate_wasm/_framework/*.wasm | wc -c) bytes of WebAssembly"
