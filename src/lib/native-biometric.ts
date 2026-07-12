/**
 * Biometric authentication (Face ID / Touch ID / Android BiometricPrompt) for
 * an optional native app-lock.
 *
 * Drives the runtime-injected BiometricAuth plugin (@aparajita/capacitor-
 * biometric-auth, installed in mobile/package.json). Off-native every export is
 * a graceful no-op: availability is false and authenticate resolves false, so
 * callers simply skip the lock on web/desktop. No `@capacitor/*` dependency is
 * added to the web bundle — the plugin is only present at runtime in the shell.
 *
 * This is an opt-in capability: nothing here runs unless a caller (a future
 * app-lock gate) invokes it behind isNative().
 */
import { capPlugin, isNative } from '@/lib/native'

interface CheckBiometryResult {
  isAvailable: boolean
  strongBiometryIsAvailable?: boolean
  biometryType?: number
  reason?: string
  code?: string
}

interface AuthenticateOptions {
  reason?: string
  cancelTitle?: string
  allowDeviceCredential?: boolean
  iosFallbackTitle?: string
  androidTitle?: string
  androidSubtitle?: string
  androidConfirmationRequired?: boolean
}

interface BiometricAuthPlugin {
  checkBiometry: () => Promise<CheckBiometryResult>
  /** Resolves on success; throws (BiometryError) on cancel/failure. */
  authenticate: (options?: AuthenticateOptions) => Promise<void>
}

/**
 * True only if the device has biometric hardware enrolled AND the plugin is
 * present (native). Always false on web/desktop.
 */
export async function isBiometricAvailable(): Promise<boolean> {
  if (!isNative()) return false
  const Bio = capPlugin<BiometricAuthPlugin>('BiometricAuth')
  if (!Bio?.checkBiometry) return false
  try { return (await Bio.checkBiometry()).isAvailable === true } catch { return false }
}

/**
 * Prompt for biometric auth. Resolves true only on a successful verification;
 * false on cancel, failure, unavailability, or off-native. Never throws, so an
 * app-lock gate can treat the boolean directly. `allowDeviceCredential` lets the
 * OS fall back to PIN/passcode when biometrics fail.
 */
export async function authenticateBiometric(reason = 'Unlock Cirqle'): Promise<boolean> {
  if (!isNative()) return false
  const Bio = capPlugin<BiometricAuthPlugin>('BiometricAuth')
  if (!Bio?.authenticate) return false
  try {
    await Bio.authenticate({
      reason,
      cancelTitle: 'Cancel',
      allowDeviceCredential: true,
      androidTitle: 'Unlock Cirqle',
      androidSubtitle: 'Verify it is you',
      iosFallbackTitle: 'Use passcode',
    })
    return true
  } catch {
    return false
  }
}
