# Cirqle Android — Release & Play Store readiness

The Android app is a Capacitor shell around the live web app (`app.cirqle.work`).
The native project is generated in CI (`.github/workflows/mobile-android.yml`)
from `mobile/capacitor.config.json` — nothing native is committed.

- **App ID / package:** `work.cirqle.app`
- **App name:** Cirqle
- **Min / target SDK:** Capacitor 6 defaults (min 22, target 34)

## Build outputs

| Trigger | Output |
|---|---|
| Actions → *Mobile Android build* → Run, or push a `mobile-v*` tag | `cirqle-android` artifact |
| — debug APK | `app-debug.apk` — sideload on any device, no signing needed |
| — release AAB | `app-release.aab` — Play upload (signed if keystore configured) |

`versionCode` is set to the workflow run number (strictly increasing, as Play
requires); `versionName` comes from the workflow input (default `0.6.0`).

## Signing readiness (one-time)

Play requires the release AAB to be signed with an **upload key**. Generate one
and store it in repo secrets — the workflow signs automatically when present.

1. Create an upload keystore (keep the file + passwords safe; losing it means
   you must reset your upload key with Google):
   ```bash
   keytool -genkeypair -v -keystore upload.keystore \
     -alias cirqle-upload -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Base64-encode it for the secret:
   ```bash
   base64 -i upload.keystore | pbcopy   # macOS
   ```
3. Add these **repository secrets** (Settings → Secrets and variables → Actions):
   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | the base64 blob from step 2 |
   | `ANDROID_KEYSTORE_PASSWORD` | keystore password |
   | `ANDROID_KEY_ALIAS` | `cirqle-upload` |
   | `ANDROID_KEY_PASSWORD` | key password |

Without these secrets the workflow still builds a **debug APK** and an
**unsigned release AAB** (to validate the release build); it just can't produce
an uploadable signed bundle. Enroll in **Play App Signing** so Google manages
the final app-signing key while you keep only the upload key.

## Play Store readiness checklist

- [ ] Google Play developer account (one-time $25).
- [ ] App created in Play Console with package `work.cirqle.app`.
- [ ] Upload keystore generated + secrets set (above); Play App Signing enabled.
- [ ] App icon + splash generated: put a 1024×1024 PNG in `mobile/` and run
      `npx @capacitor/assets generate --android` (regenerate before packaging).
- [ ] Store listing: title, short + full description, feature graphic,
      phone screenshots (min 2), category.
- [ ] **Privacy policy URL** (required — the app handles business/financial data).
- [ ] **Data safety** form: declares data collected (account, financial info),
      encryption in transit, and that it's not sold.
- [ ] **Permissions justification** — permissions come from installed plugins and
      are merged by `cap sync`:
  - `INTERNET` (loads the remote app) — always.
  - `CAMERA` — @capacitor/camera (receipt/photo capture).
  - `POST_NOTIFICATIONS` — @capacitor/push + local notifications (Android 13+).
  - `USE_BIOMETRIC` / `USE_FINGERPRINT` — biometric app-lock.
  - `ACCESS_NETWORK_STATE` — @capacitor/network (offline queue).
  Remove any plugin you don't ship to drop its permission.
- [ ] Native push delivery configured (Firebase `google-services.json` + FCM
      credentials) — see [MOBILE_NATIVE.md](MOBILE_NATIVE.md). Optional to launch;
      token registration degrades gracefully without it.
- [ ] Target API level meets Play's current minimum (34 as of 2025) — Capacitor 6
      default satisfies this.
- [ ] Internal testing track: upload the AAB, add testers, verify install + login
      before promoting to production.

## iOS (blocked — needs a paid Apple Developer account)

The same Capacitor project produces an iOS app (`npx cap add ios`). Distribution
via TestFlight/App Store requires a $99/yr Apple Developer account and macOS
runners with Xcode + signing. Tracked separately; not part of this workflow.
