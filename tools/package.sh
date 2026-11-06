#!/usr/bin/env bash
# Build reproducible release artifacts from the working tree.
#
#   bash tools/package.sh            -> dist/awake-screen-<version>.crx and .zip
#
# Stages a clean copy (never the working tree), so the signing key can never end
# up inside the package, then packs with Chrome's own packer and verifies the
# result with tools/verify-crx.py. Exits non-zero if any check fails.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STAGE=${STAGE:-/tmp/awake-dist}
OUT="$ROOT/dist"
KEY=${KEY:-$ROOT/key.pem}
VERSION=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$ROOT/manifest.json")

if [ ! -f "$KEY" ]; then
  echo "missing signing key: $KEY" >&2
  echo "generate one with: openssl genrsa -out key.pem 2048" >&2
  exit 1
fi

CHROME=${CHROME:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}
if [ -z "$CHROME" ]; then
  CHROME=$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)
fi
if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then
  echo "no Chromium binary found; set CHROME=/path/to/chrome" >&2
  exit 1
fi

echo "version $VERSION"
echo "chrome  $CHROME"

rm -rf "$STAGE" "$STAGE.crx" "$STAGE.profile" "$OUT"
mkdir -p "$OUT"

# Everything that has no business in a shipped extension: the signing key, the
# dev-only harness, docs and VCS metadata.
rsync -a \
  --exclude 'key.pem' --exclude '*.pem' --exclude '.git' --exclude '.gitignore' \
  --exclude 'dist' --exclude 'docs' --exclude 'test' --exclude 'tools' \
  --exclude 'SPEC.md' --exclude 'CHANGELOG.md' \
  "$ROOT/" "$STAGE/"
echo "staged  $(find "$STAGE" -type f | wc -l) files in $STAGE"

# --pack-extension-key means Chrome writes no new .pem and keeps the pinned ID.
"$CHROME" --headless=new --no-sandbox --disable-gpu \
  --user-data-dir="$STAGE.profile" \
  --pack-extension="$STAGE" --pack-extension-key="$KEY" >/dev/null 2>&1 || true
if [ ! -f "$STAGE.crx" ]; then
  echo "chrome produced no $STAGE.crx" >&2
  exit 1
fi
rm -rf "$STAGE.profile"
mv "$STAGE.crx" "$OUT/awake-screen-$VERSION.crx"

python3 - "$STAGE" "$OUT/awake-screen-$VERSION.zip" <<'PY'
import os, sys, zipfile
stage, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(stage):
        for name in sorted(files):
            path = os.path.join(root, name)
            z.write(path, os.path.relpath(path, stage))
print(f"zipped  {len(zipfile.ZipFile(target).namelist())} files -> {target}")
PY

python3 "$ROOT/tools/verify-crx.py" "$OUT/awake-screen-$VERSION.crx" \
  --source "$STAGE" --manifest "$ROOT/manifest.json"
echo
ls -l "$OUT"
sha256sum "$OUT"/*
