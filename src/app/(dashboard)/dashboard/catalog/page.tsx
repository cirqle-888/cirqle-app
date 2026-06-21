import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { redirect } from 'next/navigation'
import CatalogClient from './catalog-client'

export const dynamic = 'force-dynamic'

export default async function CatalogPage() {
  const empId = await resolveCurrentEmployeeId()
  if (!empId) redirect('/login')

  const admin = createAdminClient()

  const [productsRes, clientsRes] = await Promise.all([
    admin
      .from('product_catalog')
      .select(`
        id, product_code, name, weight, category, brand, barcode,
        image_url, status, notes, created_at, updated_at,
        images:product_catalog_images(id, version, url, is_primary),
        assignments:client_product_assignments(client_id, is_active, client:clients(name))
      `)
      .order('name')
      .limit(500),
    admin
      .from('clients')
      .select('id, name')
      .eq('is_active', true)
      .order('name'),
  ])

  const products = productsRes.data || []
  const clients = clientsRes.data || []

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
