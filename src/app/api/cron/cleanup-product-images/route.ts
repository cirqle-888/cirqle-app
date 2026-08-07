import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { logCronRun } from '@/lib/cron/log'

/**
 * Scheduled product-image retention cleanup — permanently deletes old product
 * photos (storage object + product_catalog_images row) so the catalog doesn't
 * accumulate unlimited image history forever.
 *
 * Auth: same shared-secret pattern as /api/shortcut — `Authorization: Bearer
 * <CRON_SECRET>`, checked against the CRON_SECRET env var. Vercel Cron sends
 * this header automatically when CRON_SECRET is set in the project env vars
 * (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
 *
 *   GET /api/cron/cleanup-product-images
 *
 * Safety rules (never leave a product imageless or delete what's in active use):
 *  - Never deletes the current PRIMARY image of a product.
 *  - Never deletes a product's ONLY image, regardless of age.
 *  - Retention window defaults to 12 months; override via company_settings
 *    key `product_image_retention_months`.
 *
 * Schedule this in vercel.json → `crons`.
 */

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false // fail closed — never run unauthenticated
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const { data: settingRow } = await admin
    .from('company_settings').select('value').eq('key', 'product_image_retention_months').maybeSingle()
  const retentionMonths = Math.max(1, parseInt(settingRow?.value || '12', 10) || 12)
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - retentionMonths)
  const cutoffIso = cutoff.toISOString()

  // Candidates: old, not primary.
  const { data: candidates, error } = await admin
    .from('product_catalog_images')
    .select('id, product_id, storage_path, is_primary, created_at')
    .eq('is_primary', false)
    .lt('created_at', cutoffIso)

  if (error) {
    await logCronRun(admin, 'cleanup-product-images', false, undefined, error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  if (!candidates?.length) {
    await logCronRun(admin, 'cleanup-product-images', true, { deleted: 0, retentionMonths })
    return NextResponse.json({ ok: true, deleted: 0, retentionMonths })
  }

  // Never delete a product's only remaining image — count per product first.
  const productIds = [...new Set(candidates.map(c => c.product_id))]
  const { data: counts } = await admin
    .from('product_catalog_images')
    .select('product_id')
    .in('product_id', productIds)
  const totalByProduct = new Map<string, number>()
  for (const row of counts || []) totalByProduct.set(row.product_id, (totalByProduct.get(row.product_id) || 0) + 1)

  let deleted = 0
  const errors: string[] = []
  for (const img of candidates) {
    if ((totalByProduct.get(img.product_id) || 0) <= 1) continue // last image for this product — keep it
    if (img.storage_path) {
      const { error: removeErr } = await admin.storage.from('product-images').remove([img.storage_path])
      if (removeErr) { errors.push(`${img.id}: ${removeErr.message}`); continue }
    }
    const { error: delErr } = await admin.from('product_catalog_images').delete().eq('id', img.id)
    if (delErr) { errors.push(`${img.id}: ${delErr.message}`); continue }
    totalByProduct.set(img.product_id, (totalByProduct.get(img.product_id) || 1) - 1)
    deleted++
  }

  // Piggybacked housekeeping: prune plugin-health events (figma_events)
  // older than ~180 days. Pure observability data — best-effort, and a
  // missing table (pre-migration) is silently fine.
  try {
    const cutoff = new Date(Date.now() - 180 * 86400_000).toISOString()
    await admin.from('figma_events').delete().lt('created_at', cutoff)
  } catch { /* observability, never availability */ }

  await logCronRun(admin, 'cleanup-product-images', errors.length === 0, { deleted, retentionMonths }, errors.length ? errors.join('; ') : undefined)
  return NextResponse.json({ ok: errors.length === 0, deleted, retentionMonths, errors: errors.length ? errors : undefined })
}
