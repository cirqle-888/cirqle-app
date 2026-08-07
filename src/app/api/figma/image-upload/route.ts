import { NextRequest, NextResponse } from 'next/server'
import { FIGMA_CORS_HEADERS as CORS_HEADERS, figmaOptions, verifyFigmaAuth, logFigmaEvent } from '../_lib/auth'
import { isFeatureEnabled, FEATURE_DISABLED_BODY } from '@/lib/feature-flags'
import { mirrorProductToGlobalCatalog } from '@/lib/offer-catalog'

/**
 * POST /api/figma/image-upload — cleaned product shots travel from Figma into
 * the product database, so the cut-out a designer just made is reusable in
 * every future offer (client intake picker, plugin catalog search) instead of
 * dying inside one Figma file.
 *
 * Two-step, mirroring the app's existing signed-PUT flows (the plugin PUTs
 * bytes straight to storage; this route never proxies image bytes):
 *
 *  {mode:'sign', fileName, clientId}         → {uploadUrl, path, publicUrl}
 *  {mode:'confirm', path, publicUrl, productName, clientId, setPrimary?}
 *     → find-or-create the catalog product by name (the same mirror path
 *       every offer save runs), then record a product_catalog_images row
 *       with version 'flyer_ready'.
 *
 * PNG only — that is what figma.exportAsync produces, and a tighter allowlist
 * beats an open one on a bearer-secret route.
 *
 * Fully independent of campaign saving BY DESIGN: a failed upload is retried
 * from the plugin's per-row control and never blocks or fails a save.
 *
 * Feature-flagged: `feature_figma_image_upload`.
 */

export const dynamic = 'force-dynamic'

export const OPTIONS = figmaOptions

interface IncomingBody {
  mode?: 'sign' | 'confirm' | 'report-failure'
  fileName?: string
  clientId?: string
  // confirm:
  path?: string
  publicUrl?: string
  productName?: string
  setPrimary?: boolean
  // report-failure (health panel only):
  error?: string
}

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFigmaAuth(req)
    if (!auth.ok) return auth.response
    const admin = auth.admin

    if (!(await isFeatureEnabled(admin, 'feature_figma_image_upload', true))) {
      return NextResponse.json(FEATURE_DISABLED_BODY, { status: 403, headers: CORS_HEADERS })
    }

    const body = (await req.json().catch(() => null)) as IncomingBody | null
    const mode = body?.mode

    if (mode === 'report-failure') {
      // A PUT that died on the plugin side leaves no server trace — the
      // plugin reports it so the health panel sees real failure counts.
      void logFigmaEvent(admin, 'image_upload_failed', { plugin: auth.plugin, detail: body?.error || 'unreported' })
      return NextResponse.json({ ok: true }, { headers: CORS_HEADERS })
    }

    if (mode === 'sign') {
      const clientId = (body?.clientId || '').trim()
      if (!clientId) {
        return NextResponse.json({ ok: false, error: 'clientId is required.' }, { status: 400, headers: CORS_HEADERS })
      }
      // Path is server-composed — the plugin's fileName is only a hint and
      // never reaches storage, so no traversal/extension games.
      const path = `figma/${clientId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
      const { data, error } = await admin.storage.from('product-images').createSignedUploadUrl(path)
      if (error || !data) {
        return NextResponse.json({ ok: false, error: error?.message || 'Could not create the upload URL.' }, { status: 500, headers: CORS_HEADERS })
      }
      const { data: { publicUrl } } = admin.storage.from('product-images').getPublicUrl(path)
      return NextResponse.json({ ok: true, uploadUrl: data.signedUrl, path, publicUrl }, { headers: CORS_HEADERS })
    }

    if (mode === 'confirm') {
      const clientId = (body?.clientId || '').trim()
      const productName = (body?.productName || '').trim()
      const publicUrl = (body?.publicUrl || '').trim()
      const path = (body?.path || '').trim()
      if (!clientId || !productName || !publicUrl || !path.startsWith(`figma/${clientId}/`)) {
        return NextResponse.json(
          { ok: false, error: 'clientId, productName, publicUrl and a matching path are required.' },
          { status: 400, headers: CORS_HEADERS },
        )
      }

      // Find-or-create by name — identical to what an offer save would do, so
      // a product registered from Figma is a first-class catalog citizen.
      await mirrorProductToGlobalCatalog(admin, clientId, productName, null, null)

      const escaped = productName.replace(/[\\%_]/g, c => `\\${c}`)
      const { data: productRows } = await admin
        .from('product_catalog')
        .select('id')
        .ilike('name', escaped)
        .limit(1)
      const productId = (productRows?.[0] as { id?: string } | undefined)?.id
      if (!productId) {
        return NextResponse.json(
          { ok: false, error: `Couldn't register "${productName}" in the catalog. Try again.` },
          { status: 500, headers: CORS_HEADERS },
        )
      }

      const setPrimary = body?.setPrimary !== false
      if (setPrimary) {
        await admin.from('product_catalog_images')
          .update({ is_primary: false })
          .eq('product_id', productId)
          .eq('is_primary', true)
      }
      // version 'flyer_ready': this is the designer's cleaned cut-out, not a
      // raw client photo. source stays 'upload' (the schema's CHECK list);
      // the storage path (figma/…) records where it came from.
      const { error: imgErr } = await admin.from('product_catalog_images').insert({
        product_id: productId,
        version: 'flyer_ready',
        url: publicUrl,
        storage_path: path,
        source: 'upload',
        is_primary: setPrimary,
      })
      if (imgErr) {
        return NextResponse.json({ ok: false, error: imgErr.message }, { status: 500, headers: CORS_HEADERS })
      }
      if (setPrimary) {
        await admin.from('product_catalog').update({ image_url: publicUrl }).eq('id', productId)
        // The client's own picker row (if any) shows the cleaned shot too.
        await admin.from('client_product_catalog')
          .update({ image_url: publicUrl })
          .eq('client_id', clientId)
          .ilike('name', escaped)
      }

      void logFigmaEvent(admin, 'image_upload_ok', { plugin: auth.plugin })

      return NextResponse.json(
        { ok: true, productId, imageUrl: publicUrl, message: `Photo saved to ${productName} in the product database.` },
        { headers: CORS_HEADERS },
      )
    }

    return NextResponse.json({ ok: false, error: "mode must be 'sign' or 'confirm'." }, { status: 400, headers: CORS_HEADERS })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}
