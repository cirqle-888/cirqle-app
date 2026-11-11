/**
 * Temporary passwords — an admin resets someone's password (Settings →
 * Employees → Reset password) and passes the temporary one on. The account
 * is flagged in `app_metadata.temp_password` (only the service role can write
 * app_metadata, so a user cannot set or fake it). After signing in with it,
 * the person is offered — not forced — to set their own; see
 * components/auth/temp-password-prompt.tsx.
 */

export const TEMP_PASSWORD_FLAG = 'temp_password'

/** Same minimum as Change password in the profile menu. */
export const MIN_PASSWORD_LENGTH = 8

export function hasTemporaryPassword(appMetadata: Record<string, unknown> | null | undefined): boolean {
  return appMetadata?.[TEMP_PASSWORD_FLAG] === true
}

/** null = fine; otherwise the message to show. */
export function newPasswordError(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password !== confirm) return 'The two passwords do not match.'
  return null
}
