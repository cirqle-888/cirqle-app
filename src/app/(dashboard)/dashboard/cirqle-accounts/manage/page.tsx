import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadBrands } from '@/lib/brands/load'
import ManageBrandsClient from './manage-client'

export const dynamic = 'force-dynamic'

/** Add and edit Cirqle's brands, and say which brand sells each service. */
export default async function ManageBrandsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (!(isAdmin || hasPermission(me, PERMS.SETTINGS_MANAGE_COMPANY))) redirect('/dashboard/cirqle-accounts')

  const admin = createAdminClient()
  const brands = await loadBrands(admin)

  let services: { id: string; name: string; category: string | null; category_id: string | null; brand_id: string | null }[] = []
  try {
    const { data, error } = await admin.from('services')
      .select('id, name, brand_id, category_id, category:service_categories(name)')
      .eq('is_active', true).order('name')
    if (!error) {
      services = (data ?? []).map((s: any) => ({
        id: s.id, name: s.name, brand_id: s.brand_id ?? null, category_id: s.category_id ?? null,
        category: (Array.isArray(s.category) ? s.category[0]?.name : s.category?.name) ?? null,
      }))
    }
  } catch { /* brand column not migrated — the page shows the migration notice */ }

  // Departments (service categories) and which brand owns each.
  let departments: { id: string; name: string; brand_id: string | null }[] = []
  let departmentsMigrated = false
  try {
    const { data, error } = await admin.from('service_categories').select('id, name, brand_id').eq('is_active', true).order('display_order')
    if (!error) { departments = (data ?? []) as typeof departments; departmentsMigrated = true }
  } catch { /* brand_id not migrated */ }

  // People, by CQID only, and who is on each brand as a whole.
  let employees: { id: string; cqid: string | null }[] = []
  let members: { employee_id: string; brand_id: string }[] = []
  let staffMigrated = false
  try {
    const [emps, mem] = await Promise.all([
      admin.from('employees').select('id, cqid').eq('is_active', true).order('cqid'),
      admin.from('employee_brands').select('employee_id, brand_id'),
    ])
    employees = (emps.data ?? []) as typeof employees
    if (!mem.error) { members = (mem.data ?? []) as typeof members; staffMigrated = true }
  } catch { /* table not migrated */ }

  return (
    <ManageBrandsClient
      brands={brands}
      services={services}
      migrated={brands.length > 0}
      departments={departments}
      departmentsMigrated={departmentsMigrated}
      employees={employees}
      members={members}
      staffMigrated={staffMigrated}
    />
  )
}
