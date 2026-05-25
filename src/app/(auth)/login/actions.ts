'use server'

import { createAdminClient } from '@/lib/supabase/admin'

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
