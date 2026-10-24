#!/bin/sh
# Builds the WebAssembly package and the static site into web/dist.
set -eu
cd "$(dirname "$0")/.."
(cd wasm && wasm-pack build --target web --release --out-dir ../web/pkg)
cd web
npm ci
npm run build
echo "built web/dist"
