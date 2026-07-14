#!/usr/bin/env bash
# Minifies the committed production ES modules in place, or verifies that
# they already equal pinned Terser output. The site deploys web/ as-is, so CI
# uses --check to prevent a readable source edit from shipping unminified.
set -euo pipefail

cd "$(dirname "$0")/.."

mode=${1:-write}
if [[ "$mode" != "write" && "$mode" != "--check" ]]; then
    echo "usage: ./scripts/minify-js.sh [--check]" >&2
    exit 2
fi

terser_version=${TERSER_VERSION:-5.49.0}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
stale=0

for source in web/js/*.js; do
    current="$tmp/$(basename "$source").current"
    output="$tmp/$(basename "$source").output"
    cp "$source" "$current"
    for _ in 1 2 3 4 5; do
        npx --yes "terser@${terser_version}" "$current" --compress --mangle --output "$output"
        if cmp -s "$current" "$output"; then
            break
        fi
        mv "$output" "$current"
    done
    if ! cmp -s "$current" "$output"; then
        echo "Terser output did not stabilize for $source" >&2
        exit 1
    fi
    if [[ "$mode" == "--check" ]]; then
        if ! cmp -s "$source" "$current"; then
            echo "not minified: $source" >&2
            stale=1
        fi
    else
        mv "$current" "$source"
        echo "minified $source"
    fi
done

if (( stale )); then
    echo "run ./scripts/minify-js.sh and commit the result" >&2
    exit 1
fi

if [[ "$mode" == "--check" ]]; then
    echo "all production JS modules match Terser ${terser_version} output"
fi
