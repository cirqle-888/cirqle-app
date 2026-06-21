import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { redirect } from 'next/navigation'
import { getIntakeKindsByClient } from '@/lib/services/intake-server'
import CatalogClient from './catalog-client'

export const dynamic = 'force-dynamic'

export default async function CatalogPage() {
  const empId = await resolveCurrentEmployeeId()
  if (!empId) redirect('/login')

  const admin = createAdminClient()

  const [productsRes, clientsRes, kindsByClient] = await Promise.all([
    admin
      .from('product_catalog')
      .select(`
        id, product_code, name, weight, category, brand, barcode,
        image_url, status, notes, created_at, updated_at,
        images:product_catalog_images(id, version, url, is_primary, created_at),
        assignments:client_product_assignments(client_id, is_active, client:clients(name))
      `)
      .order('name')
      .limit(500),
    admin
      .from('clients')
      .select('id, name, has_offer_flyer_service')
      .eq('is_active', true)
      .order('name'),
    getIntakeKindsByClient(),
  ])

  const products = productsRes.data || []
  const clientsRaw = clientsRes.data || []
  const clients = clientsRaw.filter(c => kindsByClient.get(c.id)?.includes('offer_intake') || c.has_offer_flyer_service)

  // Derive filter options from loaded products
  const categories = [...new Set(products.map((p: any) => p.category).filter(Boolean))].sort()
  const brands = [...new Set(products.map((p: any) => p.brand).filter(Boolean))].sort()

  return (
    <CatalogClient
      initialProducts={products}
      clients={clients}
      categories={categories as string[]}
      brands={brands as string[]}
    />
  )
}
