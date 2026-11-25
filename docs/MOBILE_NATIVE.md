# Cirqle Mobile — Native Capabilities

The mobile app is the **live web app** loaded inside a Capacitor shell
(`mobile/capacitor.config.json` → `server.url: https://app.cirqle.work`). Every
`src/` change ships to web, desktop, and both mobile platforms at once. Native
features are layered on top through runtime-injected Capacitor plugins — the web
bundle stays dependency-free (`src/lib/native.ts` reads `window.Capacitor`).

## Capability layer (all `src/lib`)

| Module | Exports | Native plugin | Web / desktop fallback |
|---|---|---|---|
| `native.ts` | `isNative`, `getPlatform`, `capPlugin` | — | `window.Capacitor` undefined → no-op |
| `native-capabilities.ts` | `shareContent`, `read/writeClipboard`, `hapticImpact/Notification`, `capturePhoto`, `scheduleLocalNotification`, `saveBase64File` | Share, Clipboard, Haptics, Camera, LocalNotifications, Filesystem | Web Share / Clipboard / `navigator.vibrate` / `<input type=file>` / download |
| `native-push.ts` | `registerNativePush`, `addPushNotificationHandlers`, `unregisterNativePush` | PushNotifications | no-op (web uses VAPID `<PushToggle>`) |
| `native-biometric.ts` | `isBiometricAvailable`, `authenticateBiometric` | BiometricAuth | no-op (returns false) |
| `deep-link.ts` | `routeForDeepLink` | — (used by `MobileShell` App listener) | pure function |

`MobileShell` (`src/components/mobile/mobile-shell.tsx`) wires the app lifecycle:
status bar theming, splash hide, Android hardware **back button**, `cirqle://`
**deep links**, and **refresh-on-resume**. All gated by `isNative()`.

Every helper is SSR-safe and never throws; off-native callers get a boolean/null
or a graceful web fallback. Import them anywhere.

## Push notifications — server setup required

The client abstraction (`native-push.ts`) requests permission, registers with
APNs/FCM, and persists the device token via the `saveNativePushToken` server
action into the `native_push_tokens` table (migration `025`). **Delivery** — the
server actually sending a push to a stored token — needs platform credentials
that only the account owner can provision:

### Android (FCM)
1. Create a Firebase project; add an Android app with id `work.cirqle.app`.
2. Download `google-services.json` → `mobile/google-services.json` (git-ignored).
   `mobile/scripts/build-android.sh` copies it into the generated `android/`
   project on every build, and refuses to build version code 4 or later
   without it.
3. Let the server prove itself to Google. Production does this **without a
   key** (the `cirqle.work` Google organisation blocks downloadable
   service-account keys): Vercel gives each function a signed identity token,
   and Google is set up to accept it — see `src/lib/push/google-auth.ts`.
   - In Google Cloud (project of the Firebase app): enable the *IAM Service
     Account Credentials API* and *Security Token Service API*; create a
     Workload Identity pool with an OIDC provider whose issuer is
     `https://oidc.vercel.com/<vercel-team-slug>` and allowed audience
     `https://vercel.com/<vercel-team-slug>`, mapping `google.subject` to
     `assertion.sub`; then give the subject
     `owner:<team-slug>:project:<project>:environment:production` the
     *Workload Identity User* role on the Firebase Admin SDK service account.
   - In Vercel (Production): `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`,
     `GCP_SERVICE_ACCOUNT_EMAIL`, `GCP_WORKLOAD_IDENTITY_POOL_ID`,
     `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`. These are identifiers, not
     secrets.
   - On a host with no identity token of its own, the fallback is the service
     account JSON (or its base64) in `FCM_SERVICE_ACCOUNT`.

   Sending is wired through `src/lib/push/native-send.ts`, called from
   `sendWebPush`, so every alert that reaches a browser also reaches the phone
   app. A refusal from Google is logged as `[push] …` in the function logs.
4. Build and hand out the new app (version code 4+). The web app registers a
   phone only when its build number is at least `PUSH_MIN_ANDROID_BUILD`
   (`src/lib/native-push.ts`): on an older build, which has no Firebase inside,
   `PushNotifications.register()` would close the app. Registration runs from
   `MobileShell` once the user is inside `/dashboard`; signing out removes the
   phone's token first.

### iOS (APNs) — blocked until an Apple Developer account exists
1. In the Apple Developer portal create an **APNs Auth Key** (`.p8`).
2. Register the App ID `work.cirqle.app` with Push Notifications enabled.
3. Upload the APNs key to Firebase (or call APNs directly) and store the key id
   + team id in backend env.

Until these are set nothing registers and no push is delivered. Nothing
crashes — older builds are skipped by build number, the table write is graceful
pre-migration and the whole path no-ops on web.

## Releasing a new Android build

Ordinary changes need no release: the app loads the live web app. A new build
is only for a change to the native shell (a plugin, the icon, Firebase).

1. Raise `versionCode` (and `versionName`) in `mobile/app-version.json`.
2. `bash mobile/scripts/build-android.sh` — the signed APK lands in
   `mobile/dist/`.
3. `node --env-file=.env.local mobile/scripts/publish-android.mjs --notes "…"` —
   uploads the APK to the public `app-releases` storage bucket and writes
   `public/mobile/latest.json`.
4. Commit `public/mobile/latest.json` and deploy. Every installed app with a
   lower build number then shows **Update available**; Download opens the APK
   in the phone's browser and it installs over the old app (same signing key).

The APK is deliberately not served from `app.cirqle.work`: the app's WebView
keeps links to its own host inside the WebView, where a download does nothing.

### Tapping a notification

A tap is handed to the web app by the push plugin and opens the notification's
page (`startNativePush` in `src/lib/native-push.ts`). There is no other window
into the phone app, so each tap leaves one `[push-tap] {…}` line in the server
log: the fields the phone handed over, the page asked for, where the app was and
where it ended up, and whether the page had to be loaded outright because the
in-app navigation did not arrive. No tap line at all after a tap means the phone
never passed the tap to the page.

## Offline queue & sync (`src/lib/offline`)

A persistent mutation queue that replays Server Actions when connectivity
returns — **without modifying any action or business logic**.

| File | Role |
|---|---|
| `engine.ts` | Pure, dependency-injected queue + sync core (unit-tested, `engine.test.ts`) |
| `storage.ts` | Durable K/V — Preferences (native) / localStorage (web) |
| `network.ts` | Connectivity — Network plugin (native) / `navigator.onLine` (web) |
| `index.ts` | Public API: `registerOfflineOp`, `runOrQueue`, `enqueueMutation`, `flushQueue`, `subscribeQueue`, `subscribeOnline` |
| `../components/mobile/offline-indicator.tsx` | Offline/sync status pill (native-only; null on web) |

**Retry contract.** A handler that *resolves* means the server responded
(success or a business rejection) → the op is dequeued, never retried. A handler
that *throws a transport error* → the op stays queued, `attempts` increments, and
a backoff retry is scheduled up to `maxAttempts` (8) before it is dead-lettered.
Ops sharing a `dedupeKey` collapse to the newest.

**Adoption recipe** (opt-in, per mutation — the action itself is untouched):

```ts
// boot (client): register once
import { registerOfflineOp } from '@/lib/offline'
import { createCashbookEntry } from '@/app/(dashboard)/dashboard/cashbook/actions'
registerOfflineOp('cashbook.create', createCashbookEntry)

// call site: replace a bare `await createCashbookEntry(args)` with
import { runOrQueue } from '@/lib/offline'
const { queued } = await runOrQueue('cashbook.create', args, { optimistic: draftRow })
if (queued) toast('Saved offline — will sync when back online')
```

Call-site adoption is intentionally left per-flow: each mutation whose result the
UI consumes needs an optimistic-state decision, so wiring is done deliberately
rather than globally. The engine, adapters, indicator, and API are production-
ready and fully tested; nothing changes behavior until a call site opts in.

## Applying migration 025

`migrations/025_native_push_tokens.sql` follows the `push_subscriptions` (021)
security shape: employees `SELECT` only their own rows; all writes go through the
service-role server action. Apply it manually with the other pending migrations.
