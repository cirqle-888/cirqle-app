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

  let services: { id: string; name: string; category: string | null; brand_id: string | null }[] = []
  try {
    const { data, error } = await admin.from('services')
      .select('id, name, brand_id, category:service_categories(name)')
      .eq('is_active', true).order('name')
    if (!error) {
      services = (data ?? []).map((s: any) => ({
        id: s.id, name: s.name, brand_id: s.brand_id ?? null,
        category: (Array.isArray(s.category) ? s.category[0]?.name : s.category?.name) ?? null,
      }))
    }
  } catch { /* brand column not migrated — the page shows the migration notice */ }

  return <ManageBrandsClient brands={brands} services={services} migrated={brands.length > 0} />
}
