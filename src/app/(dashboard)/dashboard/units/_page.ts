import 'server-only'
import { redirect } from 'next/navigation'
import { loadCurrentUser } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { isInstalled } from '@/lib/units/load'
import { unitsOfEmployee, type MyUnit } from '@/lib/units/membership'

/** Managing units (create, edit, tag, assign): Admin only. */
export async function requireDepartmentSharesPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me || !me.isAdmin) redirect('/dashboard')
  const admin = createAdminClient()
  const installed = await isInstalled(admin)
  return { me, admin, installed }
}

/**
 * Viewing units: an Admin sees every unit; a team member sees only the units
 * they belong to (read-only); anyone else is sent away.
 */
export async function requireUnitViewer(): Promise<{
  me: NonNullable<Awaited<ReturnType<typeof loadCurrentUser>>>
  admin: ReturnType<typeof createAdminClient>
  installed: boolean
  /** null for an Admin (every unit); otherwise the viewer's own units. */
  myUnits: MyUnit[] | null
}> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  const admin = createAdminClient()
  const installed = await isInstalled(admin)
  if (me.isAdmin) return { me, admin, installed, myUnits: null }
  const myUnits = installed ? await unitsOfEmployee(admin, me.employeeId) : []
  if (!myUnits.length) redirect('/dashboard')
  return { me, admin, installed, myUnits }
}

export const ROOT = '/dashboard/units'

export const MONTH = /^\d{4}-\d{2}$/

export const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
