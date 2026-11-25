#!/usr/bin/env bash
# Publish the built Mac installer as a public GitHub release.
#
# The installer is too large for the app's own storage (about 120 MB), and the
# repository's releases are public, free and permanent, so that is where it
# lives. The address it is published at is the one desktop/latest.json already
# names as "download" — the public /download page and the in-app update prompt
# both read that file — so this refuses to publish a build the file does not
# describe.
#
# Order for a release:
#   1. set "version" in package.json and in latest.json (and its "download")
#   2. npm run dmg                  → dist/Cirqle Desktop-<version>-arm64.dmg
#   3. bash scripts/publish-mac.sh  → the public release
#   4. commit and push latest.json  → installed apps are offered the update
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="cirqle-888/cirqle-app"
VERSION="$(node -p "require('./package.json').version")"
DMG="dist/Cirqle Desktop-$VERSION-arm64.dmg"
TAG="desktop-v$VERSION"
ASSET="Cirqle-Desktop-$VERSION-mac-arm64.dmg"
URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"

[ -f "$DMG" ] || { echo "✗ $DMG not found — build it first: npm run dmg"; exit 1; }
node -e "
  const m = require('./latest.json')
  if (m.version !== '$VERSION') { console.error('✗ latest.json says ' + m.version + ', package.json says $VERSION.'); process.exit(1) }
  if (m.download !== '$URL') { console.error('✗ latest.json \"download\" must be $URL'); process.exit(1) }
"

# The asset keeps the name it is uploaded under, so upload a copy with the
# address-friendly name (no spaces) rather than the builder's file name.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$DMG" "$STAGE/$ASSET"

echo "▶ Publishing Cirqle Desktop $VERSION to github.com/$REPO (tag $TAG)…"
gh release create "$TAG" "$STAGE/$ASSET" --repo "$REPO" \
  --title "Cirqle Desktop $VERSION" \
  --notes "Cirqle Desktop $VERSION for Mac (Apple Silicon). Install steps: https://app.cirqle.work/download"

echo "✓ Published: $URL"
echo "  Now commit and push desktop/latest.json so installed apps are offered the update."
