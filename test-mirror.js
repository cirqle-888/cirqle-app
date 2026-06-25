import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function run() {
  const name = 'Test Product Mirror 123'
  const imageUrl = 'https://lgqarkdmlyfpacyqhfha.supabase.co/storage/v1/object/public/test/123.png'
  
  // Try mirrorProductToGlobalCatalog logic directly
  const { data: existing } = await admin
    .from('product_catalog')
    .select('id, image_url')
    .ilike('name', name)
    .maybeSingle()

  let productId = existing?.id

  if (!productId) {
    const { data: created } = await admin
      .from('product_catalog')
      .insert({ name, weight: null, image_url: imageUrl })
      .select('id')
      .single()
    productId = created?.id
  }

  if (!productId) return console.log('Failed to create/find')

  if (imageUrl) {
    const { data: alreadyRecorded } = await admin
      .from('product_catalog_images')
      .select('id').eq('product_id', productId).eq('url', imageUrl).maybeSingle()
      
    if (!alreadyRecorded) {
      await admin.from('product_catalog_images').update({ is_primary: false }).eq('product_id', productId).eq('is_primary', true)
      await admin.from('product_catalog_images').insert({
        product_id: productId, version: 'original', url: imageUrl, source: 'upload', is_primary: true,
      })
      await admin.from('product_catalog').update({ image_url: imageUrl }).eq('id', productId)
    }
  }
  
  // Check what was saved
  const final = await admin.from('product_catalog').select('image_url, images:product_catalog_images(url, is_primary)').eq('id', productId).single()
  console.log(JSON.stringify(final.data, null, 2))
}
run()
