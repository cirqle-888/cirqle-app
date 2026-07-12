/**
 * Native app-update check for the sideloaded Android app (no Play Store).
 *
 * The mobile app loads the live web app remotely, so ordinary changes ship
 * instantly on web deploy — NO reinstall. This checker only covers the rare
 * case where the *native shell* changes (new plugin, icon, or target URL): it
 * fetches a small `latest.json` you host, compares its versionCode to the
 * installed build, and — if newer — surfaces an "update available" prompt that
 * opens the APK download URL.
 *
 * Off-native every export is a graceful no-op. Nothing here adds a build-time
 * `@capacitor/*` dependency (App plugin comes from the runtime-injected globals).
 */
import { capPlugin, isNative } from '@/lib/native'

/** Where the update manifest is hosted. Override per deployment if needed. */
export const DEFAULT_UPDATE_MANIFEST_URL = 'https://app.cirqle.work/mobile/latest.json'

export interface UpdateManifest {
  /** Android versionCode of the latest published build (monotonic integer). */
  versionCode: number
  /** Human-facing version, e.g. "0.6.1". */
  versionName?: string
  /** Direct download URL of the signed APK. */
  url?: string
  /** Optional release note shown in the prompt. */
  notes?: string
}

export interface UpdateInfo {
  available: boolean
  currentVersion?: string
  latestVersion?: string
  url?: string
  notes?: string
}

interface AppInfoPlugin {
  getInfo: () => Promise<{ name: string; id: string; build: string; version: string }>
}

/**
 * Pure comparison: is `latestCode` a newer build than the installed `currentBuild`?
 * `currentBuild` is Android's versionCode (a stringified integer from App.getInfo).
 * Non-numeric or missing inputs are treated conservatively as "no update".
 */
export function isNewerBuild(currentBuild: string | number | undefined, latestCode: number | undefined): boolean {
  const cur = typeof currentBuild === 'number' ? currentBuild : parseInt(String(currentBuild ?? ''), 10)
  if (!Number.isFinite(cur) || typeof latestCode !== 'number' || !Number.isFinite(latestCode)) return false
  return latestCode > cur
}

/**
 * Fetch the manifest and compare to the installed build. Returns
 * `{ available: false }` off-native, on any network/parse error, or when up to
 * date. Never throws.
 */
export async function checkForUpdate(manifestUrl: string = DEFAULT_UPDATE_MANIFEST_URL): Promise<UpdateInfo> {
  if (!isNative()) return { available: false }
  const App = capPlugin<AppInfoPlugin>('App')
  if (!App?.getInfo) return { available: false }

  try {
    const info = await App.getInfo()
    const res = await fetch(manifestUrl, { cache: 'no-store' })
    if (!res.ok) return { available: false, currentVersion: info.version }
    const manifest = (await res.json()) as UpdateManifest
    return {
      available: isNewerBuild(info.build, manifest.versionCode),
      currentVersion: info.version,
      latestVersion: manifest.versionName,
      url: manifest.url,
      notes: manifest.notes,
    }
  } catch {
    return { available: false }
  }
}

/**
 * Open the APK download URL. On Android this hands the direct-download URL to
 * the system download manager. No-op off-native or without a URL.
 */
export function openUpdateDownload(url: string | undefined): void {
  if (!isNative() || !url || typeof window === 'undefined') return
  window.open(url, '_blank')
}
