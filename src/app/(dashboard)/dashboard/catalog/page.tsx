import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/permissions/check'
import { redirect } from 'next/navigation'
import { getIntakeKindsByClient } from '@/lib/services/intake-server'
import CatalogClient from './catalog-client'
import PendingSubmissions from './pending-submissions'
import { listPendingSubmissions } from './actions'

export const dynamic = 'force-dynamic'

const CATALOG_COLUMNS = `
  id, product_code, name, weight, category, brand, barcode,
  image_url, status, notes, created_at, updated_at,
  images:product_catalog_images(id, version, url, is_primary, created_at),
  assignments:client_product_assignments(client_id, is_active, client:clients(name))
`

/** Approved products only, tolerating a pre-migration schema. */
async function loadApprovedProducts(admin: ReturnType<typeof createAdminClient>) {
  const filtered = await admin
    .from('product_catalog')
    .select(`${CATALOG_COLUMNS}, names, review_status`)
    .eq('review_status', 'approved')
    .order('name')
    .limit(500)
  if (!filtered.error) return { data: filtered.data }

  const fallback = await admin
    .from('product_catalog').select(CATALOG_COLUMNS).order('name').limit(500)
  return { data: fallback.data }
}

export default async function CatalogPage() {
  const empId = await resolveCurrentEmployeeId()
  if (!empId) redirect('/login')

  const admin = createAdminClient()

  const [productsRes, clientsRes, kindsByClient, pendingRes] = await Promise.all([
    // Only approved products. A row still awaiting review appears in the queue
    // above; showing it here too would let staff edit and assign it to clients
    // before anyone had checked it, which is the whole thing the queue exists
    // to prevent. Falls back to the unfiltered list on 42703, so shipping this
    // ahead of migration 20260719140000 degrades to today's behaviour instead
    // of blanking the entire catalog.
    loadApprovedProducts(admin),
    admin
      .from('clients')
      .select('id, name, has_offer_flyer_service')
      .eq('is_active', true)
      .order('name'),
    getIntakeKindsByClient(),
    // Returns ok:false when the viewer lacks catalog.review_submissions, and an
    // empty list before migration 20260719140000 — both render nothing.
    listPendingSubmissions(),
  ])

  const pending = pendingRes.ok ? pendingRes.data?.items ?? [] : []

  const products = productsRes.data || []
  const clientsRaw = clientsRes.data || []
  const clients = clientsRaw.filter(c => kindsByClient.get(c.id)?.includes('offer_intake') || c.has_offer_flyer_service)

  // Derive filter options from loaded products
  const categories = [...new Set(products.map((p: any) => p.category).filter(Boolean))].sort()
  const brands = [...new Set(products.map((p: any) => p.brand).filter(Boolean))].sort()

  return (
    <>
      {pending.length > 0 && <PendingSubmissions items={pending} />}
      <CatalogClient
        initialProducts={products}
        clients={clients}
        categories={categories as string[]}
        brands={brands as string[]}
      />
    </>
  )
}
