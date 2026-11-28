import Header from '@/components/layout/header'
import type { DeptConfig } from '@/lib/units/engine'
import { loadDepartments, loadLookups } from '@/lib/units/load'
import { monthStartISO } from '@/lib/utils/local-date'
import type { createAdminClient } from '@/lib/supabase/server'
import { DepartmentForm, type FormDefaults } from './_ui'

/** The create / edit screen, shared by new/ and [slug]/edit. */
export async function FormPage({ admin, me, dept }: {
  admin: ReturnType<typeof createAdminClient>
  me: { employeeId: string }
  dept: DeptConfig | null
}) {
  const [all, lookups] = await Promise.all([loadDepartments(admin), loadLookups(admin)])
  const taken: Record<string, string> = {}
  for (const d of all) {
    if (!d.isActive || d.id === dept?.id) continue
    for (const c of d.categoryIds) taken[c] = d.name
  }
  // A new agreement starts with the owner on the first line; the rest is theirs to fill.
  const defaults: FormDefaults = dept ? {
    id: dept.id, name: dept.name, kind: dept.kind, color: dept.color ?? '#7c3aed', categoryIds: dept.categoryIds,
    revenueBasis: dept.revenueBasis, sharesGeneralCosts: dept.sharesGeneralCosts, teamSeesResults: dept.teamSeesResults,
    startMonth: dept.startsOn.slice(0, 7), endMonth: dept.endsOn ? dept.endsOn.slice(0, 7) : '',
    notes: '', isActive: dept.isActive, partners: dept.partners.map(p => ({ employeeId: p.employeeId, sharePct: p.sharePct })),
    members: dept.members.map(m => ({ employeeId: m.employeeId, role: m.role })),
  } : {
    id: null, name: '', kind: 'department', color: '#7c3aed', categoryIds: [], revenueBasis: 'collected',
    sharesGeneralCosts: true, teamSeesResults: false,
    startMonth: monthStartISO(0).slice(0, 7), endMonth: '', notes: '', isActive: true,
    // Offered when the agreement box is ticked: the owner first, at 100 %.
    partners: [{ employeeId: me.employeeId, sharePct: 100 }],
    members: [],
  }
  if (dept) {
    const { data } = await admin.from('business_units').select('notes').eq('id', dept.id).maybeSingle()
    defaults.notes = (data as { notes?: string | null } | null)?.notes ?? ''
  }
  return (
    <>
      <Header
        title={dept ? `${dept.name} · Settings` : 'New unit'}
        subtitle={dept ? 'Its work, its team, and its agreement if it has one.' : 'A department or sub-brand of Cirqle, with its own team.'}
        crumbLabel={dept ? dept.name : undefined}
      />
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
        <div className="rounded-xl border border-border bg-card p-5">
          <DepartmentForm
            defaults={defaults}
            categories={lookups.categories.filter(c => c.isActive || defaults.categoryIds.includes(c.id))}
            takenCategories={taken}
            employees={lookups.employees}
          />
        </div>
      </div>
    </>
  )
}
