import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadPrograms } from '@/lib/ownership/engine'
import { ACTIVITY_KINDS, isPayableLogPair, logKind, logKindLabel } from '@/lib/ownership/activity-kinds'
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

  // Current handler per client — empty before 20261006100000 runs.
  const { data: handlerRows } = await admin.from('client_handlers')
    .select('client_id, employee_id, effective_from').is('effective_to', null)
  const handlers = Object.fromEntries(((handlerRows ?? []) as { client_id: string; employee_id: string; effective_from: string }[])
    .map(h => [h.client_id, { employeeId: h.employee_id, from: h.effective_from }]))

  // Activities an "activities" program can count: the built-in kinds, then
  // every action the activity log has recorded with a person in the last year
  // — so work a new feature logs becomes payable here without a code change.
  const since = new Date(); since.setFullYear(since.getFullYear() - 1)
  const { data: logged } = await fetchAll(admin.from('activity_logs')
    .select('entity_type, action')
    .not('actor_id', 'is', null)
    .gte('created_at', since.toISOString())
    .order('id', { ascending: true }))
  const counts = new Map<string, { entityType: string; action: string; n: number }>()
  for (const r of (logged ?? []) as { entity_type: string; action: string }[]) {
    if (!isPayableLogPair(r.entity_type, r.action)) continue
    const k = logKind(r.entity_type, r.action)
    const c = counts.get(k) ?? { entityType: r.entity_type, action: r.action, n: 0 }
    c.n++
    counts.set(k, c)
  }
  const activityOptions = [
    ...Object.entries(ACTIVITY_KINDS).map(([key, v]) => ({ key, label: v.label, builtIn: true, count: null as number | null })),
    ...[...counts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([key, c]) => ({ key, label: logKindLabel(c.entityType, c.action), builtIn: false, count: c.n })),
  ]

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
      handlers={handlers}
      activityOptions={activityOptions}
      currentMonth={now.getMonth() + 1}
      currentYear={now.getFullYear()}
    />
  )
}
