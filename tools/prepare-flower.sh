#!/usr/bin/env bash
# Turn the exported hibiscus (.glb, or a glTF .zip) into a small web asset.
# Usage: tools/prepare-flower.sh ~/Downloads/cc0-hibiscus-cv-red.zip
# Output: assets/hibiscus.glb (≈1–3 MB) and assets/hibiscus.glb.js (base64, so the page works from file://)
set -euo pipefail
ZIP=${1:?path to the downloaded .zip (or a .glb)}
DIR=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)                      # untrusted download goes in its own empty dir
trap 'rm -rf "$WORK"' EXIT

case "$ZIP" in
  *.glb) cp "$ZIP" "$WORK/in.glb"; IN="$WORK/in.glb" ;;
  *)     unzip -q "$ZIP" -d "$WORK/src"; IN=$(find "$WORK/src" -name '*.gltf' -o -name '*.glb' | head -1) ;;
esac
[ -n "$IN" ] || { echo "no .gltf/.glb found in $ZIP"; exit 1; }
echo "input: $IN"

GT="npx --yes @gltf-transform/cli@4.1.1"
$GT inspect "$IN" | head -40
# simplify the 487k-face scan, weld, cap textures at 1024px webp, meshopt-compress
$GT optimize "$IN" "$WORK/out.glb" \
  --simplify true --simplify-ratio 0.35 --simplify-error 0.0015 \
  --texture-compress webp --texture-size 1024 \
  --compress meshopt
cp "$WORK/out.glb" "$DIR/assets/hibiscus.glb"
printf 'window.HIBISCUS_GLB="%s";\n' "$(base64 < "$WORK/out.glb" | tr -d '\n')" > "$DIR/assets/hibiscus.glb.js"
ls -lh "$DIR/assets/hibiscus.glb" "$DIR/assets/hibiscus.glb.js"
