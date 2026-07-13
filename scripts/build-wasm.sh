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
