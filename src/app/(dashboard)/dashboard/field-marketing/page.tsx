import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import FieldClient from './field-client'
import type { FieldPlace, FieldTerritory } from '@/lib/field/types'

export const dynamic = 'force-dynamic'

/**
 * Field Marketing — door-to-door territory map. Physical prospects (supermarkets,
 * shops, business centres) plotted on a map, moved through their own pipeline,
 * with a visit log that shows what's already covered and what needs a follow-up.
 *
 * Server page: guard → load places / territories / employees via the admin
 * client → plain props. All interactivity lives in field-client.tsx; all writes
 * in actions.ts. fetchAll() returns [] for a table that doesn't exist yet, so
 * this route renders safely even before the migration is applied.
 */
export default async function FieldMarketingPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.FIELD_VIEW) || !me
  if (me && !canView) redirect('/dashboard')
  const canManage = isAdmin || hasPermission(me, PERMS.FIELD_MANAGE)

  const supabase = createAdminClient()

  const [placesRes, territoriesRes, employeesRes] = await Promise.all([
    fetchAll(supabase.from('field_places').select('*').order('created_at', { ascending: false })),
    fetchAll(supabase.from('field_territories').select('*').order('name')),
    supabase.from('employees').select('id, cqid, name').eq('is_active', true).order('cqid'),
  ])

  const places = (placesRes.data || []) as FieldPlace[]
  const territories = (territoriesRes.data || []) as FieldTerritory[]

  return (
    <FieldClient
      places={places}
      territories={territories}
      employees={(employeesRes.data || []) as never[]}
      canManage={canManage}
      meEmployeeId={me?.employeeId ?? null}
    />
  )
}
