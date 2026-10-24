#!/bin/sh
# Builds the chit-zcash npm package into npm/ and packs it as npm/chit-zcash-<version>.tgz.
set -eu
cd "$(dirname "$0")/.."
(cd wasm && wasm-pack build --target web --release --out-dir ../npm/pkg)
cd npm && npm pack
