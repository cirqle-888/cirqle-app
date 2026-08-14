#!/usr/bin/env bash
# Build the Cirqle Android app locally: regenerate the native project, apply
# branding, stamp the version, and produce a release APK (for sideloading) and
# an AAB. Signs them if mobile/keystore.properties exists (see gen-keystore.sh);
# otherwise builds unsigned and warns.
#
# Requirements: Node 22+, a JDK 21, and the Android SDK (ANDROID_HOME / an
# installed Android Studio). Capacitor 8 compiles against Java 21 and its CLI
# declares engines.node >= 22 — older toolchains fail before the build starts.
# Nothing here touches web or desktop code.
#
# Usage:  bash mobile/scripts/build-android.sh
# Output: mobile/android/app/build/outputs/apk/release/app-release.apk
#         mobile/android/app/build/outputs/bundle/release/app-release.aab
set -euo pipefail
cd "$(dirname "$0")/.."   # -> mobile/

VERSION_NAME="$(node -p "require('./app-version.json').versionName" 2>/dev/null || echo 0.6.0)"
VERSION_CODE="${VERSION_CODE:-$(node -p "require('./app-version.json').versionCode" 2>/dev/null || echo 1)}"
echo "▶ Building Cirqle Android  version=$VERSION_NAME  code=$VERSION_CODE"

echo "▶ Installing Capacitor deps…"
npm install --silent

if [ ! -d android ]; then
  echo "▶ Generating native Android project…"
  npx cap add android
else
  echo "▶ Syncing native Android project…"
  npx cap sync android
fi

echo "▶ Applying app icon + splash…"
npx @capacitor/assets generate --android

echo "▶ Stamping version (code=$VERSION_CODE name=$VERSION_NAME)…"
sed -i.bak "s/versionCode [0-9][0-9]*/versionCode $VERSION_CODE/" android/app/build.gradle
sed -i.bak "s/versionName \"[^\"]*\"/versionName \"$VERSION_NAME\"/" android/app/build.gradle
rm -f android/app/build.gradle.bak

SIGN_ARGS=()
if [ -f keystore.properties ]; then
  echo "▶ keystore.properties found — building SIGNED release."
  # shellcheck disable=SC1091
  source keystore.properties
  SIGN_ARGS=(
    -Pandroid.injected.signing.store.file="$KEYSTORE_PATH"
    -Pandroid.injected.signing.store.password="$KEYSTORE_PASSWORD"
    -Pandroid.injected.signing.key.alias="$KEY_ALIAS"
    -Pandroid.injected.signing.key.password="$KEY_PASSWORD"
  )
else
  echo "⚠ No keystore.properties — building UNSIGNED (run gen-keystore.sh to sign)."
fi

echo "▶ Gradle assembleRelease + bundleRelease…"
( cd android && chmod +x ./gradlew && ./gradlew assembleRelease bundleRelease --no-daemon "${SIGN_ARGS[@]}" )

echo
echo "✓ Done."
echo "  APK: mobile/android/app/build/outputs/apk/release/app-release.apk"
echo "  AAB: mobile/android/app/build/outputs/bundle/release/app-release.aab"
[ ${#SIGN_ARGS[@]} -eq 0 ] && echo "  (UNSIGNED — sideload will be blocked until signed.)"
