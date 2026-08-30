#!/usr/bin/env bash
# Generate the Cirqle Android upload/release keystore (one time).
#
# The keystore is your app's signing identity: every future update MUST be
# signed with the SAME keystore or Android refuses to install it over the
# existing app. Keep the .keystore file and its passwords backed up somewhere
# safe (a password manager) — losing them means users must uninstall/reinstall.
#
# Output: mobile/cirqle-release.keystore  (gitignored)
# Also writes mobile/keystore.properties (gitignored) so build-android.sh can
# sign automatically.
set -euo pipefail
cd "$(dirname "$0")/.."   # -> mobile/

KEYSTORE="cirqle-release.keystore"
ALIAS="cirqle"

if [ -f "$KEYSTORE" ]; then
  echo "✗ $KEYSTORE already exists — refusing to overwrite your signing key."
  echo "  Delete it manually only if you are certain you have a backup."
  exit 1
fi

read -r -s -p "Choose a keystore password (min 6 chars): " STORE_PW; echo
read -r -s -p "Confirm keystore password: " STORE_PW2; echo
[ "$STORE_PW" = "$STORE_PW2" ] || { echo "✗ passwords do not match"; exit 1; }

keytool -genkeypair -v \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$STORE_PW" -keypass "$STORE_PW" \
  -dname "CN=Cirqle, OU=Cirqle, O=Cirqle, L=, ST=, C=IN"

cat > keystore.properties <<EOF
# Gitignored — consumed by scripts/build-android.sh. Do NOT commit.
KEYSTORE_PATH="$(pwd)/$KEYSTORE"
KEYSTORE_PASSWORD="$STORE_PW"
KEY_ALIAS="$ALIAS"
KEY_PASSWORD="$STORE_PW"
EOF

echo
echo "✓ Created $KEYSTORE and keystore.properties (both gitignored)."
echo "  Back up BOTH now. For CI, base64-encode the keystore:"
echo "    base64 -i mobile/$KEYSTORE | pbcopy"
echo "  and add the 4 secrets from docs/DISTRIBUTION.md to GitHub."
