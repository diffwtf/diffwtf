#!/usr/bin/env bash
# Builds crates/diffwtf-wasm into web/pkg (gitignored) as a browser-native ES
# module. Run from anywhere; paths are resolved relative to the repo root.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v wasm-pack >/dev/null 2>&1; then
    echo "error: wasm-pack is not installed; it is required to build the wasm module" >&2
    echo "install it with: cargo install wasm-pack" >&2
    exit 1
fi

wasm-pack build crates/diffwtf-wasm --target web --release --out-dir ../../web/pkg

# Stamp the wasm URL inside the JS glue with the wasm file's content hash.
# The glue and the wasm are only correct as a pair; giving the wasm a URL
# that changes with its content means a cached copy of one version of the
# glue can never be served a different version of the wasm from a cache
# (the 2026-07-13 deploy shipped exactly that mismatch to returning
# visitors as a LinkError; DECISIONS.md D7). Static hosts ignore the query
# string, so the same file on disk serves every ?v= value.
glue=web/pkg/diffwtf_wasm.js
literal="new URL('diffwtf_wasm_bg.wasm', import.meta.url)"
if ! grep -qF "$literal" "$glue"; then
    echo "error: expected wasm URL literal not found in $glue;" >&2
    echo "wasm-bindgen changed its emitted loader, update this stamp step" >&2
    exit 1
fi
hash=$(sha256sum web/pkg/diffwtf_wasm_bg.wasm | cut -c1-16)
sed -i "s|new URL('diffwtf_wasm_bg.wasm', import.meta.url)|new URL('diffwtf_wasm_bg.wasm?v=${hash}', import.meta.url)|" "$glue"
echo "stamped wasm URL in glue: diffwtf_wasm_bg.wasm?v=${hash}"

# wasm-pack optimizes the binary in release mode but leaves readable JS glue.
# The handwritten modules are committed minified; keep the generated module
# consistent without introducing a site bundler or changing module boundaries.
terser_version=${TERSER_VERSION:-5.49.0}
npx --yes "terser@${terser_version}" "$glue" --compress --mangle --module --output "${glue}.min"
mv "${glue}.min" "$glue"
echo "minified wasm glue with terser ${terser_version}"
