'use server'

/**
 * Enter / leave view-as. Two tiny actions, deliberately in their own file so
 * the cookie is written in exactly two places and nowhere else.
 *
 * Entering is admin-gated here, and gated AGAIN in resolveViewAs on every
 * subsequent request — the cookie is never trusted on its own. Leaving is
 * ungated on purpose: getting back to yourself must never be blocked, whatever
 * state the session is in.
 */

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { loadCurrentUser, invalidateUserCache, VIEW_AS_COOKIE } from '@/lib/permissions/check'

interface ActionResult { ok: boolean; error?: string }

export async function startViewAs(employeeId: string): Promise<ActionResult> {
  const me = await loadCurrentUser()
  if (!me) return { ok: false, error: 'Not signed in.' }
  // Already previewing → refuse rather than hop straight to another employee.
  // Chaining would make "who am I really?" depend on cookie history.
  if (me.isViewAs) return { ok: false, error: 'Already previewing — exit first.' }
  if (!me.isAdmin) return { ok: false, error: 'Only admins can preview another account.' }
  if (!employeeId) return { ok: false, error: 'Pick an employee.' }
  if (employeeId === me.employeeId) return { ok: false, error: 'That is already you.' }

  const supabase = await createClient()
  const { data: target } = await supabase
    .from('employees').select('id').eq('id', employeeId).maybeSingle()
  if (!target) return { ok: false, error: 'Employee not found.' }

  const jar = await cookies()
  jar.set(VIEW_AS_COOKIE, employeeId, {
    httpOnly: true,          // never readable from client JS
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60,         // an hour. A preview left open for a day is a
                             // session quietly pretending to be someone else.
  })
  invalidateUserCache()      // the 30s cache must not serve the pre-preview user
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function stopViewAs(): Promise<ActionResult> {
  const jar = await cookies()
  jar.delete(VIEW_AS_COOKIE)
  invalidateUserCache()
  revalidatePath('/', 'layout')
  return { ok: true }
}
