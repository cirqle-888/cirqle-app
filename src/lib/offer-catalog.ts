import type { createAdminClient } from '@/lib/supabase/admin'

/**
 * The merged product catalog a client (or their designer) picks from, and the
 * save-time mirror into the global Product Catalog.
 *
 * ONE implementation shared by:
 *  - the client intake form (getOfferPageData in
 *    src/app/intake/offer/[token]/actions.ts), and
 *  - the Cirqle Studio plugin's catalog endpoints (/api/figma/catalog).
 *
 * Moving it here (out of the 'use server' actions file) is what lets an API
 * route import it without dragging server-action semantics along.
 */

type Admin = ReturnType<typeof createAdminClient>

/** The shape the offer editor's picker consumes, from either source. */
export interface CatalogRow {
  id: string
  name: string
  weight?: string | null
  category?: string | null
  image_url?: string | null
}

export interface CatalogEntryImage {
  id: string
  url: string
  is_primary: boolean
  created_at: string
}

export type CatalogEntry = CatalogRow & { images?: CatalogEntryImage[] }

/**
 * Approved shared-catalog products this client may use, shaped like the rows
 * client_product_catalog returns so the editor treats them identically.
 *
 * A product is available when it carries no region ("sells everywhere") or its
 * region matches the client's. Every row is NULL today, so everyone sees
 * everything — correct while all clients are in Kerala, and the filter is
 * already in place for the first Dubai client.
 *
 * Degrades to an empty list rather than throwing if migration 20260722060000
 * has not been applied yet, since this feeds a client-facing form: losing the
 * shared suggestions is survivable, breaking the offer editor is not.
 */
async function loadSharedCatalogFor(
  admin: Admin,
  client: { id: string; region?: string | null },
  q?: string,
  limit = 1000,
): Promise<CatalogRow[]> {
  const approved = () => {
    let query = admin
      .from('product_catalog')
      .select('id, name, weight, category, image_url')
      .eq('status', 'active')
      .eq('review_status', 'approved')
    if (q) query = query.ilike('name', `%${escapeLike(q)}%`)
    return query
  }

  // `region.is.null` keeps unrestricted products; the second arm adds the
  // client's own. A client with no region set sees only unrestricted ones,
  // which is the safe reading of "we have not decided yet".
  //
  // Region is client data, so it is matched against a strict pattern before
  // going anywhere near a PostgREST filter string — a comma or a dot in it
  // would otherwise be read as more filter syntax.
  const region = /^[A-Za-z0-9_-]{1,32}$/.test(client.region || '') ? client.region : null
  const scoped = region
    ? approved().or(`region.is.null,region.eq.${region}`)
    : approved().is('region', null)

  const withRegion = await scoped.order('name').limit(limit)
  if (!withRegion.error) return (withRegion.data || []) as CatalogRow[]

  const plain = await approved().order('name').limit(limit)
  if (!plain.error) return (plain.data || []) as CatalogRow[]

  // review_status missing too — pre-produce-library schema. Nothing to add.
  return []
}

/** Escape ilike wildcards in client-supplied text. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, c => `\\${c}`)
}

/**
 * The client's own catalog + region-scoped approved global catalog, the
 * client's row winning name collisions, each entry enriched with its global
 * image HISTORY (newest first) matched by lowercased name.
 *
 * `q` narrows both sources by name (used by the plugin's search); the app
 * intake passes no `q` and gets the full picker exactly as before.
 */
export async function getMergedClientCatalog(
  admin: Admin,
  client: { id: string; region?: string | null },
  q?: string,
  limit?: number,
): Promise<CatalogEntry[]> {
  let ownQuery = admin
    .from('client_product_catalog')
    .select('*')
    .eq('client_id', client.id)
    .eq('is_active', true)
  if (q) ownQuery = ownQuery.ilike('name', `%${escapeLike(q)}%`)
  const ownRes = await ownQuery.order('name')
  const ownCatalog = (ownRes.data || []) as CatalogRow[]

  // The picker is the client's OWN past products plus everything approved in
  // the shared catalog that is available in their region.
  //
  // Without the second half the shared library is unreachable: a shop owner
  // typing "Tomato" sees a suggestion only if they have sent Tomato before, so
  // the curated produce items — local names, cut-out photos — help nobody.
  const globalCatalog = await loadSharedCatalogFor(admin, client, q)

  // The client's own row wins on a name clash — it carries their weight and
  // the photo they last used, which is more specific than the library's.
  const key = (row: CatalogRow) => row.name.trim().toLowerCase()
  const seen = new Set(ownCatalog.map(key))
  let catalog = [...ownCatalog, ...globalCatalog.filter(g => !seen.has(key(g)))]
  if (limit && catalog.length > limit) catalog = catalog.slice(0, limit)

  // Attach each catalog item's image HISTORY (newest first) from the global
  // Product Catalog, matched by name (same dedup key mirrorProductToGlobalCatalog
  // uses) — lets the picker offer past photos instead of just the latest.
  if (!catalog.length) return catalog
  const { data: globalProducts } = await admin
    .from('product_catalog')
    .select('id, name, images:product_catalog_images(id, url, is_primary, created_at)')
    .in('name', catalog.map(c => c.name.trim()))
  type GlobalRow = { id: string; name: string; images?: CatalogEntryImage[] | null }
  const byName = new Map(((globalProducts || []) as GlobalRow[]).map(g => [g.name.trim().toLowerCase(), g]))
  return catalog.map(c => {
    const g = byName.get(c.name.trim().toLowerCase())
    const images = (g?.images || []).slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    return { ...c, images }
  })
}

/** Find-or-create the global product_catalog row for this name, assign it to
 * the client, and — if a new image URL was submitted — record it in the
 * image history (newest upload becomes primary). Runs on every offer save
 * (per product) and on plugin-side catalog writes. */
export async function mirrorProductToGlobalCatalog(
  admin: Admin,
  clientId: string,
  name: string,
  weight: string | null,
  imageUrl: string | null,
): Promise<void> {
  if (!name) return

  // Dedup case-insensitively by name. Two fixes over the previous
  // `.ilike(name).maybeSingle()`:
  //  - names are client-supplied, and ilike treats % and _ in them as
  //    wildcards, so "50% Off Rice" matched unrelated rows. Escaped here.
  //  - maybeSingle() THROWS when more than one row matches, which is a normal
  //    state for a shared catalog. limit(1) takes the first instead.
  const { data: existingRows } = await admin
    .from('product_catalog')
    .select('id, image_url')
    .ilike('name', escapeLike(name))
    .limit(1)
  const existing = existingRows?.[0] as { id: string } | undefined

  let productId = existing?.id as string | undefined

  if (!productId) {
    // A name nobody has used before — this is a genuinely new product arriving
    // with a client's offer list, which is when new products actually turn up.
    // It goes in as PENDING so staff can set the category, tidy the title and
    // add the local-language name before it joins the shared library.
    //
    // This does NOT hold up the client's flyer: the offer reads
    // client_product_catalog, so the product is usable in this week's offer
    // immediately. Review governs only whether it becomes part of the global
    // catalog that every other client can draw on.
    const { data: created } = await admin
      .from('product_catalog')
      .insert({
        name,
        weight,
        image_url: imageUrl,
        review_status: 'pending',
        submitted_by_client_id: clientId,
        submitted_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    productId = (created as { id?: string } | null)?.id
  }

  if (!productId) return

  if (imageUrl) {
    const { data: alreadyRecorded } = await admin
      .from('product_catalog_images')
      .select('id').eq('product_id', productId).eq('url', imageUrl).maybeSingle()
    if (!alreadyRecorded) {
      // New photo for this product — it becomes the primary (newest = primary).
      await admin.from('product_catalog_images').update({ is_primary: false }).eq('product_id', productId).eq('is_primary', true)
      await admin.from('product_catalog_images').insert({
        product_id: productId, version: 'original', url: imageUrl, source: 'upload', is_primary: true,
      })
      await admin.from('product_catalog').update({ image_url: imageUrl }).eq('id', productId)
    }
  }

  await admin
    .from('client_product_assignments')
    .upsert({ client_id: clientId, product_id: productId, is_active: true }, { onConflict: 'client_id,product_id' })
}
