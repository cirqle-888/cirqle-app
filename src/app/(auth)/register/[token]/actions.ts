'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export interface RegistrationInput {
  token: string
  email: string
  password: string
  name: string
  phone: string
  dateOfBirth: string
  emergencyContactName: string
  emergencyContactPhone: string
  avatarUrl?: string | null
}

export interface RegistrationResult {
  ok: boolean
  error?: string
}

export async function completeRegistration(input: RegistrationInput): Promise<RegistrationResult> {
  const admin = createAdminClient()

  // 1. Re-validate token + load employee
  const { data: emp, error: empErr } = await admin
    .from('employees')
    .select('id, invite_token_expires_at, auth_id, is_archived')
    .eq('invite_token', input.token)
    .maybeSingle()

  if (empErr || !emp) return { ok: false, error: 'Invitation not found.' }
  if (emp.auth_id)      return { ok: false, error: 'This account is already registered. Please sign in.' }
  if (emp.is_archived)  return { ok: false, error: 'This account has been archived.' }
  if (emp.invite_token_expires_at && new Date(emp.invite_token_expires_at) < new Date()) {
    return { ok: false, error: 'This invitation has expired. Ask your admin for a new link.' }
  }

  // 2. Validate inputs
  if (!input.email || !input.password || !input.name || !input.dateOfBirth) {
    return { ok: false, error: 'Please fill in all required fields.' }
  }
  if (input.password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' }
  }

  // 2b. Check if this email already has an auth account
  const { data: existingUsers } = await admin.auth.admin.listUsers()
  const emailTaken = existingUsers?.users?.some(u => u.email?.toLowerCase() === input.email.toLowerCase())
  if (emailTaken) {
    return { ok: false, error: 'An account with this email already exists. Please sign in or use a different email address.' }
  }

  // 3. Create auth user
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  })
  if (createErr || !created.user) {
    const msg = createErr?.message || ''
    if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('duplicate')) {
      return { ok: false, error: 'An account with this email already exists. Please sign in instead.' }
    }
    return { ok: false, error: 'Could not create account. Please try again or contact your administrator.' }
  }

  // 4. Link auth user to employee, set fields, clear token
  const { error: updateErr } = await admin
    .from('employees')
    .update({
      auth_id: created.user.id,
      email: input.email,
      name: input.name,
      phone: input.phone || null,
      date_of_birth: input.dateOfBirth,
      emergency_contact_name: input.emergencyContactName || null,
      emergency_contact_phone: input.emergencyContactPhone || null,
      avatar_url: input.avatarUrl || null,
      invite_token: null,
      invite_token_expires_at: null,
      registered_at: new Date().toISOString(),
    })
    .eq('id', emp.id)

  if (updateErr) {
    // Roll back auth user
    await admin.auth.admin.deleteUser(created.user.id).catch(() => {})
    return { ok: false, error: 'Could not finalize registration: ' + updateErr.message }
  }

  // 5. Sign in this user in the server context (cookies set automatically)
  const supabase = await createClient()
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  })
  if (signInErr) {
    return { ok: true, error: 'Account created, please sign in.' }
  }

  return { ok: true }
}
