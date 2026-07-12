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
2. Download `google-services.json` → `mobile/android/app/google-services.json`.
3. Add the FCM **server key / service account JSON** to backend env
   (`FCM_SERVICE_ACCOUNT`); wire it into `src/lib/push/send.ts` alongside VAPID.

### iOS (APNs) — blocked until an Apple Developer account exists
1. In the Apple Developer portal create an **APNs Auth Key** (`.p8`).
2. Register the App ID `work.cirqle.app` with Push Notifications enabled.
3. Upload the APNs key to Firebase (or call APNs directly) and store the key id
   + team id in backend env.

Until these are set, `registerNativePush()` still runs and stores tokens; no push
is delivered. Nothing crashes — the table write is graceful pre-migration and the
whole path no-ops on web.

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
