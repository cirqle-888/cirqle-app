import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadOrgGraph, loadOrgMembers } from '@/lib/org/units'
import OrganizationClient from './organization-client'

export const dynamic = 'force-dynamic'

/**
 * Organization — departments, teams, branches, regions, client groups.
 *
 * Intentionally minimal. Most of this is unused on day one; the value is that
 * the model is already in place, so growing into it never requires a schema
 * change or a migration of live financial data.
 */
export default async function OrganizationSettingsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canManage = isAdmin || hasPermission(me, PERMS.SETTINGS_MANAGE_ORG)
  if (me && !canManage) redirect('/dashboard/settings')

  const admin = createAdminClient()
  const [{ units, scopes }, members] = await Promise.all([
    loadOrgGraph(admin),
    loadOrgMembers(admin),
  ])

  // Scope ids for deletion — loadOrgGraph returns the mapping, not the row ids.
  let scopeRows: { id: string; unit_id: string; client_id: string | null; service_category_id: string | null; service_id: string | null }[] = []
  try {
    const { data } = await admin.from('org_unit_scopes').select('id, unit_id, client_id, service_category_id, service_id')
    scopeRows = (data ?? []) as typeof scopeRows
  } catch { /* pre-migration */ }

  // CQID only — employee names are private and never sent to the browser.
  const [empRes, clientRes, svcRes, catRes] = await Promise.all([
    admin.from('employees').select('id, cqid').eq('is_active', true).order('cqid'),
    admin.from('clients').select('id, name').eq('is_active', true).order('name'),
    admin.from('services').select('id, name').eq('is_active', true).order('name'),
    admin.from('service_categories').select('id, name').eq('is_active', true).order('display_order'),
  ])

  return (
    <OrganizationClient
      units={units}
      members={members}
      scopeRows={scopeRows}
      employees={(empRes.data ?? []) as { id: string; cqid: string }[]}
      clients={(clientRes.data ?? []) as { id: string; name: string }[]}
      services={(svcRes.data ?? []) as { id: string; name: string }[]}
      categories={(catRes.data ?? []) as { id: string; name: string }[]}
      migrated={scopes.length > 0 || units.length > 0 || scopeRows.length > 0}
    />
  )
}
