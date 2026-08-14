# Cirqle Mobile (Capacitor)

Native **Android + iOS** apps that wrap the live Cirqle web app
(`https://app.cirqle.work`) in a real native shell. These are genuine
installable apps — a native icon, splash screen, and no browser chrome —
**not** an "add to home screen" PWA.

Everything below is **free**. No Apple Developer or Google Play account is
required to install on your own devices.

- **App name:** Cirqle
- **App ID:** `work.cirqle.app`
- **Loads:** `https://app.cirqle.work` (change in `capacitor.config.json`)

---

## 0. One-time clean-up (do this first)

This folder was scaffolded inside a sandbox whose filesystem could not delete
files, so the generated `android/` and `ios/` folders are inconsistent. Delete
them and let Capacitor regenerate them correctly on your machine:

```bash
cd mobile
rm -rf android ios android/_probe.txt
npm install
```

---

## 1. Prerequisites (all free)

**Android (any OS — Windows / Mac / Linux):**
- Node.js 22+ (Capacitor 8's CLI requires it)
- JDK 21 (Capacitor 8 compiles against Java 21)
- [Android Studio](https://developer.android.com/studio) (free) — installs the
  Android SDK and includes a JDK.

Capacitor 8 generates the project against **compileSdk/targetSdk 36
(Android 16)**, which Google Play requires for uploads from 31 August 2026,
and raises **minSdk to 24 (Android 7.0)** — Android 5.x and 6.x devices can no
longer install the app.

**iOS (Mac only):**
- Xcode from the Mac App Store (free)
- CocoaPods: `sudo gem install cocoapods`
- A free Apple ID (a paid $99/yr account is only needed to keep the app
  installed longer than 7 days — see below).

---

## 2. Build & install on Android (free, no account)

```bash
cd mobile
npx cap add android          # regenerates the native project
npx cap sync android
```

Then either build from the command line:

```bash
cd android
./gradlew assembleDebug
# APK output: android/app/build/outputs/apk/debug/app-debug.apk
```

…or open it in Android Studio (`npx cap open android`) and press **Run**.

**Install the APK on a phone:**
1. Copy `app-debug.apk` to the phone (USB, email, or a download link).
2. On the phone, enable *Settings → Apps → Special access → Install unknown apps*
   for the app you're opening the file with.
3. Tap the APK to install. Done — installs on as many devices as you like.

---

## 3. Build & install on iOS (free Apple ID)

```bash
cd mobile
npx cap add ios
npx cap sync ios
npx cap open ios            # opens Xcode
```

In Xcode:
1. Select the **App** target → **Signing & Capabilities**.
2. **Team:** add your Apple ID (Xcode → Settings → Accounts) and select it.
   A free personal team works.
3. Change the **Bundle Identifier** if `work.cirqle.app` is taken (e.g.
   `work.cirqle.app.<yourname>`).
4. Plug in your iPhone, select it as the run target, press **Run** (▶).
5. On the phone: *Settings → General → VPN & Device Management* → trust your
   developer certificate.

**Free-account limitation:** the app **expires after 7 days** and must be
re-run from Xcode to refresh it. A paid Apple Developer account ($99/yr) makes
signed builds last 1 year and enables ad-hoc / TestFlight distribution without
the App Store.

---

## 4. Updating the app

Because the app loads the live Cirqle site, **most updates need no rebuild** —
whatever you deploy to `app.cirqle.work` shows up instantly. Rebuild only when
you change native config (app name, icon, splash, plugins, target URL).

---

## 5. Notes & next steps

- **Auth / Supabase:** works as-is since the app loads your real hosted site;
  the user logs in exactly as they do in the browser.
- **Push notifications:** the current setup uses your existing web-push. For
  true native push (APNs / FCM) later, add `@capacitor/push-notifications` and
  register the device token from the web app. Not required to ship.
- **App icon & splash:** drop a 1024×1024 PNG in and run
  `npx @capacitor/assets generate` to produce all sizes.
- **Target URL:** edit `server.url` in `capacitor.config.json`, then
  `npx cap sync`.
