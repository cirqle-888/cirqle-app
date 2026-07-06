'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity/log'

/**
 * Records a successful sign-in on the employee's timeline (fire-and-forget).
 * Called by the login page AFTER signInWithPassword succeeds, so the session
 * cookie is present and the employee can be resolved server-side (never
 * trusting a client-supplied id).
 */
export async function recordLoginActivity(): Promise<void> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const admin = createAdminClient()
    const { data: emp } = await admin
      .from('employees').select('id').eq('auth_id', user.id).maybeSingle()
    if (!emp?.id) return
    void logActivity({
      actorId: emp.id, subjectId: emp.id,
      entityType: 'auth', entityId: emp.id, action: 'login',
    })
  } catch { /* never block login on logging */ }
}

/**
 * Resolves a login identifier (email OR CQID like "CQID001") to the
 * employee's real email address — which is what Supabase auth needs
 * to call signInWithPassword.
 *
 * - If the identifier contains '@', it's treated as an email and returned
 *   verbatim (lowercased + trimmed).
 * - Otherwise it's treated as a CQID and looked up in the employees table
 *   (case-insensitive). Active and archived employees can both attempt to
 *   log in; the archived flag is checked downstream by the existing
 *   `archived=1` redirect logic — keeping this action simple.
 *
 * Uses the admin client so the lookup works regardless of RLS on
 * `employees`. Only `email` is returned — nothing else is exposed.
 */
export async function resolveLoginEmail(
  identifier: string,
): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const raw = (identifier || '').trim()
  if (!raw) return { ok: false, error: 'Enter your email or CQID.' }

  // Looks like an email → use as-is.
  if (raw.includes('@')) {
    return { ok: true, email: raw.toLowerCase() }
  }

  // Otherwise treat as CQID. Normalise: uppercase, no spaces.
  const cqid = raw.toUpperCase().replace(/\s+/g, '')

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('employees')
    .select('email')
    .ilike('cqid', cqid)
    .maybeSingle()

  if (error) {
    return { ok: false, error: 'Lookup failed. Please try with your email instead.' }
  }
  if (!data?.email) {
    return { ok: false, error: 'No account found for that CQID. Use your email instead.' }
  }
  return { ok: true, email: data.email }
}

/**
 * Returns the company logo URL from the `company_settings` key/value table.
 * Used on the login page (where no user is authenticated yet) so the
 * workspace's own logo replaces the default Cirqle placeholder.
 *
 * Returns `null` if no logo has been uploaded — caller should fall back
 * to the default brand placeholder gracefully.
 */
export async function getCompanyLogo(): Promise<string | null> {
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('company_settings')
      .select('value')
      .eq('key', 'logo_url')
      .maybeSingle()
    const url = (data?.value || '').trim()
    return url || null
  } catch {
    return null
  }
}
