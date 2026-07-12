# Cirqle — Private Distribution (no App Store / no Play Store)

Cirqle's mobile apps are a **Capacitor shell around the live web app**
(`app.cirqle.work`). That architecture already solves most of "distribution":

> **Content updates ship instantly.** Anything you deploy to the website appears
> in the installed apps immediately — no rebuild, no reinstall. You only ever
> rebuild/redistribute the native app when the *shell* changes (a new plugin,
> the app icon, or the target URL).

This doc covers getting the app **installed** on iPhone, iPad, and employee
Android phones without using the public stores.

---

## Android — signed APK, sideloaded (fully supported)

### 1. Build the app

**In CI (recommended):** Actions → **Mobile Android build** → Run (set
`versionName`, optionally `apkUrl`), or push a `mobile-v*` tag. Download the
`cirqle-android` artifact → `app-release.apk` (signed if the keystore secrets
are set), `app-release.aab`, and `latest.json`.

**Locally:** `bash mobile/scripts/build-android.sh` →
`mobile/android/app/build/outputs/apk/release/app-release.apk`.

### 2. Sign it (one time)

```bash
bash mobile/scripts/gen-keystore.sh        # creates mobile/cirqle-release.keystore
```
Then for CI, add these **repository secrets** (Settings → Secrets → Actions):

| Secret | From |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i mobile/cirqle-release.keystore \| pbcopy` |
| `ANDROID_KEYSTORE_PASSWORD` | the password you chose |
| `ANDROID_KEY_ALIAS` | `cirqle` |
| `ANDROID_KEY_PASSWORD` | the password you chose |

> ⚠️ **Back up the keystore + passwords forever.** Every future update must be
> signed with the *same* keystore, or Android refuses to install it over the
> existing app.

### 3. Distribute the APK (any of these)

| Channel | How |
|---|---|
| **Direct download** | Host `app-release.apk` on any HTTPS URL; share the link. |
| **Company website** | Put a "Download for Android" button linking to the APK. |
| **Google Drive** | Upload the APK, share "anyone with the link", use the **direct-download** form `https://drive.google.com/uc?export=download&id=FILE_ID`. |
| **OneDrive** | Upload, "Copy link", append `&download=1` for a direct download. |
| **QR code** | Point a QR at the download URL. Generate with `qrencode -o cirqle.png "https://…/app-release.apk"` (brew install qrencode) or any online generator. Print/share it. |

### 4. Employees install it (one time per phone)

1. Tap the download link (or scan the QR) → the APK downloads.
2. Tap the downloaded file. Android asks to allow installs from this source:
   **Settings → "Install unknown apps" → (the browser/Files app) → Allow**.
3. Tap **Install**. The Cirqle icon appears; open it and log in normally.

### 5. Upgrades & automatic updates

- **In-place upgrade:** rebuild with a **higher `versionCode`** signed by the
  **same keystore**; installing the new APK upgrades without data loss. (CI uses
  the run number as `versionCode`, so it always increases.)
- **Auto-update prompt:** host the generated `latest.json` at
  `https://app.cirqle.work/mobile/latest.json` (or set `apkUrl` in the build and
  host both together). The app checks it on launch and, when `versionCode`
  increases, shows an in-app **"Update available → Download"** banner
  (`src/lib/native-update.ts`). Because the app loads the live site, this is
  rarely needed — only for native-shell changes.

---

## iPhone / iPad — options analysis

iOS does **not** allow unrestricted sideloading. Here is every private route,
with the trade-offs that matter for a small team.

### Option 1 — Ad Hoc Distribution
- **Needs:** Apple Developer Program ($99/yr).
- **Device limit:** 100 iPhones + 100 iPads **per year**; every device's UDID
  must be registered *before* building, and removing one doesn't free its slot
  until the annual reset.
- **Install:** build an `.ipa` against a provisioning profile containing each
  UDID; send the file; user installs.
- **Pros:** no App Review. **Cons:** collect UDIDs, rebuild the profile for every
  new device, certs/profiles expire yearly. Painful past a handful of devices.

### Option 2 — TestFlight ⭐ (best paid option)
- **Needs:** Apple Developer Program ($99/yr).
- **Internal users:** up to 100 (App Store Connect team members) — instant, no review.
- **External users:** up to 10,000 via a **public link** or email — a light Beta
  App Review on the first build, then updates flow freely.
- **Install:** tester installs the free **TestFlight** app, taps your link.
  Auto-updates. Builds expire after **90 days** (re-upload to refresh).
- **Pros:** no UDIDs, one-link onboarding, automatic updates, trivially covers
  5–50 people. **Cons:** $99/yr, requires the TestFlight app, 90-day re-upload,
  "beta" framing.

### Option 3 — Apple Business Manager (ABM) + Custom Apps / MDM
- **Needs:** ABM (free) + Apple Developer + typically an MDM.
- **Install:** distribute a private "Custom App" or push to supervised devices.
- **Pros:** managed, no 90-day expiry, silent install on company-owned devices.
- **Cons:** heavy setup; best when devices are company-owned & MDM-enrolled.
  Overkill for 5–50 personal (BYOD) phones.

### Option 4 — Apple Configurator
- **Needs:** a Mac + USB (free), **plus** a signed `.ipa` (so still an Apple
  account for anything beyond a 7-day free-team dev install).
- **Install:** cable each device to the Mac and push the app.
- **Pros:** no store. **Cons:** manual, per-device, Mac-tethered. Not practical
  for a distributed team.

### Option 5 — Enterprise Distribution (Apple Developer Enterprise Program)
- **Needs:** $299/yr **and** eligibility — Apple requires **100+ employees** and
  a strict review; it's for **internal** apps only.
- **Pros:** no device limit, no store, no UDIDs.
- **Cons:** **Not available to a 5–50 person company** (Apple won't approve it),
  and misuse revokes the cert (bricks every install). Rule this out.

### Option 6 — Progressive Web App (PWA) ✅ (already implemented, zero cost)
- **Needs:** nothing — **no Apple account, no fee.**
- **Install:** open `app.cirqle.work` in **Safari** → Share → **Add to Home
  Screen**. You get the Cirqle icon, a chromeless full-screen launch, and a
  splash — a real home-screen app.
- **Device limit:** none.
- **Pros:** free, unlimited devices, **instant updates** (loads the live app),
  nothing to rebuild. Already wired: web manifest, 180² apple-touch-icon, and
  `apple-mobile-web-app` standalone meta.
- **Cons:** must be added via **Safari** (not Chrome-iOS); native push needs
  iOS 16.4+ (supported there for home-screen PWAs); a few native APIs are
  unavailable; iOS may evict storage if the PWA sits unused for weeks (a
  regularly-used business app is fine).

### Recommendation for 5–50 employees

1. **Today, free:** ship the **PWA** — "Add to Home Screen" in Safari. It's
   implemented and works now on every iPhone/iPad with no account and instant
   updates. For a business app people use daily, this is genuinely enough.
2. **If you want a true native app** (App Store-style install, native push,
   no Safari step): pay the **$99/yr Apple Developer Program and use TestFlight**
   with an external public link. It's the only paid option proportionate to your
   size — Ad Hoc (UDID pain), Enterprise (unavailable <100 staff), and ABM+MDM
   (overkill for BYOD) are all worse fits.

---

## Mac & Windows desktop (Electron — same tech as Slack)

Cirqle already ships a **native desktop app** built with Electron (exactly what
Slack, Notion, and VS Code use). It's a real `.app` / `.exe`, not a browser tab,
with a tray icon, `cirqle://` deep links, and an update notifier.

| | State |
|---|---|
| macOS | `Cirqle Desktop-0.6.0-arm64.dmg` built. `npm run dmg:universal` (or the **Desktop macOS build** workflow) makes a **universal** DMG covering Apple Silicon **and** Intel. |
| Windows | EXE (NSIS) + MSI via the **Desktop Windows build** workflow. |

### Signing on macOS — the one gap

The DMG is currently **unsigned** (no Apple account). It runs fine, but on first
launch macOS Gatekeeper warns *"Apple could not verify…"*. Two ways to handle it:

- **Free (unsigned):** employees install it once with a right-click:
  **right-click the app → Open → Open**, or run `xattr -cr "/Applications/Cirqle Desktop.app"`.
  After that first launch it opens normally forever.
- **Clean (signed + notarized), like Slack:** needs the **same $99/yr Apple
  Developer account** (a "Developer ID Application" certificate). Add the
  `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` / `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` secrets and uncomment the
  signing env in `.github/workflows/desktop-mac.yml`. The DMG then double-clicks
  to install with no warning.

### Distribute it
Same channels as Android — host the `.dmg` (macOS) / `.exe` (Windows) on your
site, Drive, or OneDrive; share a link or QR. Like mobile, **content updates are
instant** (the desktop app loads the live site); only shell changes need a new
build.

---

## Who does what

**You (admin), one time:**
- Android: run `gen-keystore.sh`, add the 4 GitHub secrets, run the workflow,
  host the APK (+ `latest.json`) somewhere with a direct link, make a QR.
- iOS (free path): tell staff to open the site in Safari and Add to Home Screen.
- iOS (paid path): enrol in Apple Developer, generate the iOS build on a Mac
  (`npx cap add ios` → Xcode → Archive → upload to TestFlight), invite testers.

**Each employee, one time:**
- Android: open the link/QR → download → allow unknown source → Install → log in.
- iPhone/iPad (PWA): open `app.cirqle.work` in Safari → Share → Add to Home
  Screen → log in.
- iPhone/iPad (TestFlight): install TestFlight → tap your invite link → Install.

See [ANDROID_RELEASE.md](ANDROID_RELEASE.md) for the Play Store checklist (not
required for private distribution) and [MOBILE_NATIVE.md](MOBILE_NATIVE.md) for
the native capability layer.
