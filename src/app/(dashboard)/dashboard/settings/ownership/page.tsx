import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadPrograms } from '@/lib/ownership/engine'
import OwnershipClient from './ownership-client'

export const dynamic = 'force-dynamic'

/**
 * Ownership hub — where every reward program is configured.
 *
 * Configuration lives here, deliberately apart from the Financial Timeline
 * (the monthly operating surface). Programs change rarely; months are reviewed
 * constantly, and mixing the two would bloat the daily ritual.
 */
export default async function OwnershipSettingsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canManage = isAdmin || hasPermission(me, PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (me && !canManage) redirect('/dashboard/settings')

  const admin = createAdminClient()
  const { programs, rules } = await loadPrograms(admin)

  // Pickers. Employee NAMES are private by design — the picker shows CQIDs, so
  // the name never reaches the browser in the first place.
  const [empRes, desigRes, clientRes, svcRes, catRes, unitRes] = await Promise.all([
    admin.from('employees').select('id, cqid').eq('is_active', true).order('cqid'),
    admin.from('designations').select('id, name').order('display_order').order('name'),
    admin.from('clients').select('id, name').eq('is_active', true).order('name'),
    admin.from('services').select('id, name').eq('is_active', true).order('name'),
    admin.from('service_categories').select('id, name').eq('is_active', true).order('display_order'),
    admin.from('org_units').select('id, name, type').eq('is_active', true).order('name'),
  ])

  const now = new Date()

  return (
    <OwnershipClient
      programs={programs}
      rules={rules}
      employees={(empRes.data ?? []) as { id: string; cqid: string }[]}
      designations={(desigRes.data ?? []) as { id: string; name: string }[]}
      clients={(clientRes.data ?? []) as { id: string; name: string }[]}
      services={(svcRes.data ?? []) as { id: string; name: string }[]}
      categories={(catRes.data ?? []) as { id: string; name: string }[]}
      // Absent pre-migration — the unit scope option simply won't be offered.
      orgUnits={(unitRes.data ?? []) as { id: string; name: string; type: string }[]}
      currentMonth={now.getMonth() + 1}
      currentYear={now.getFullYear()}
    />
  )
}
