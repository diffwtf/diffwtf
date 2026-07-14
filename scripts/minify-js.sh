#!/usr/bin/env bash
# Minifies a site directory's ES modules in place with pinned Terser.
#
# The committed web/js modules are readable source; only the deploy
# artifact ships minified. CI runs this on its workspace copy of web/
# before the conformance and browser gates, so the exact minified bytes
# that deploy are the bytes every gate tested — the same artifact-only
# rule as the deploy stamp (scripts/stamp-site.mjs) and the wasm URL hash
# (scripts/build-wasm.sh). It rewrites <site-dir>/js in place: locally,
# point it at a scratch copy of web/, never at sources you mean to commit.
set -euo pipefail

cd "$(dirname "$0")/.."

dir=${1:-}
if [[ -z "$dir" || ! -d "$dir/js" ]]; then
    echo "usage: ./scripts/minify-js.sh <site-dir>   (expects <site-dir>/js/*.js)" >&2
    exit 2
fi

terser_version=${TERSER_VERSION:-5.49.0}

# Iterate to Terser's fixed point: a second pass over its own output keeps
# finding compression the first pass exposed (about 27% more on app.js).
# The fixed point is deterministic for a pinned Terser version, and five
# passes is far beyond what these modules need to stabilize (two).
for source in "$dir"/js/*.js; do
    output="${source}.min"
    for _ in 1 2 3 4 5; do
        npx --yes "terser@${terser_version}" "$source" --compress --mangle --module --output "$output"
        if cmp -s "$source" "$output"; then
            break
        fi
        mv "$output" "$source"
    done
    if ! cmp -s "$source" "$output"; then
        echo "Terser output did not stabilize for $source" >&2
        exit 1
    fi
    rm "$output"
    echo "minified $source"
done
echo "minified ${dir}/js with terser ${terser_version}"
