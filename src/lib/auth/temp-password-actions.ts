'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { TEMP_PASSWORD_FLAG, MIN_PASSWORD_LENGTH } from './temp-password'

/**
 * The signed-in person is done with their temporary password: either they
 * set their own (`newPassword`), or they chose to keep the temporary one
 * (`null`). Both clear the flag so they are not asked again.
 *
 * Acts only on the account in the caller's own session cookie — never on an
 * id passed in — so nobody can change someone else's password through it.
 */
export async function finishTemporaryPassword(newPassword: string | null): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  if (newPassword !== null && newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` }
  }

  const admin = createAdminClient()
  const { error } = await admin.auth.admin.updateUserById(user.id, {
    ...(newPassword !== null ? { password: newPassword } : {}),
    app_metadata: { ...(user.app_metadata ?? {}), [TEMP_PASSWORD_FLAG]: false },
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
