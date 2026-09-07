'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { createWebsiteAdminClient, websiteSupabaseConfigured } from '@/lib/supabase/website-admin'
import { logActivity } from '@/lib/activity/log'
import type { PortfolioCollection, UploadTarget, WorkVariant } from '@/lib/portfolio/types'

/**
 * Website portfolio — reads and writes the SEPARATE Supabase project that
 * serves cirqle.work. Every call here uses that project's service role key,
 * which never leaves the server.
 */

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

const REVALIDATE = '/dashboard/portfolio'
const BUCKET = 'work'

const SETUP_HINT =
  'The website Supabase project is not configured yet. Add WEBSITE_SUPABASE_URL and WEBSITE_SUPABASE_SERVICE_ROLE_KEY, then reload.'

/** Rows exactly as PostgREST returns them for the nested select below. */
interface ItemRow {
  id: string
  slug: string
  title: string
  width: number
  height: number
  variants: WorkVariant[] | null
  published: boolean
  position: number
}
interface BrandRow {
  id: string
  slug: string
  name: string
  tagline: string | null
  position: number
  work_items: ItemRow[] | null
}
interface CollectionRow {
  id: string
  slug: string
  title: string
  eyebrow: string
  position: number
  work_brands: BrandRow[] | null
}

const isMissingRelation = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? ''))

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)

// ─── Read ────────────────────────────────────────────────────────────────────

/** Everything in the website portfolio, published and not, ready for the editor. */
export async function listPortfolio(): Promise<ActionResult<PortfolioCollection[]>> {
  const guard = await requireReadPermission(PERMS.PORTFOLIO_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }

  const site = createWebsiteAdminClient()
  const { data, error } = await site
    .from('work_collections')
    .select(
      'id,slug,title,eyebrow,position,work_brands(id,slug,name,tagline,position,work_items(id,slug,title,width,height,variants,published,position))',
    )
    .order('position')

  if (error) {
    if (isMissingRelation(error)) {
      return { ok: false, error: 'The website project has no portfolio tables yet. Run cirqle-website/supabase/schema.sql in its SQL editor.' }
    }
    return { ok: false, error: error.message }
  }

  const publicBase = `${process.env.WEBSITE_SUPABASE_URL}/storage/v1/object/public/${BUCKET}`
  const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position

  const collections: PortfolioCollection[] = ((data ?? []) as CollectionRow[]).map((collection) => ({
    id: collection.id,
    slug: collection.slug,
    title: collection.title,
    eyebrow: collection.eyebrow,
    position: collection.position,
    brands: [...(collection.work_brands ?? [])].sort(byPosition).map((brand) => ({
      id: brand.id,
      slug: brand.slug,
      name: brand.name,
      tagline: brand.tagline,
      position: brand.position,
      items: [...(brand.work_items ?? [])].sort(byPosition).map((item) => {
        const variants: WorkVariant[] = [...(item.variants ?? [])].sort((x, y) => x.width - y.width)
        // Smallest rendition is plenty for a thumbnail in the editor.
        const thumb = variants[0]
        return {
          id: item.id,
          slug: item.slug,
          title: item.title,
          width: item.width,
          height: item.height,
          variants,
          published: item.published,
          position: item.position,
          previewUrl: thumb ? `${publicBase}/${thumb.path}` : '',
        }
      }),
    })),
  }))

  return { ok: true, data: collections }
}

// ─── Uploading ───────────────────────────────────────────────────────────────

/**
 * Prepare one signed upload URL per rendition. The browser resizes and encodes
 * the image, then PUTs each blob straight to storage, so large artwork never
 * passes through this server.
 */
export async function createWorkUploadUrls(input: {
  collectionSlug: string
  brandSlug: string
  slug: string
  widths: number[]
}): Promise<ActionResult<UploadTarget[]>> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }

  const collectionSlug = slugify(input.collectionSlug)
  const brandSlug = slugify(input.brandSlug)
  const slug = slugify(input.slug)
  if (!collectionSlug || !brandSlug || !slug) return { ok: false, error: 'That file name cannot be turned into a web address.' }

  // The bucket is public, so only ever hand out .webp paths — an arbitrary
  // extension here would let something else be served from our own domain.
  const widths = input.widths.filter((w) => Number.isInteger(w) && w > 0 && w <= 4000)
  if (!widths.length) return { ok: false, error: 'No image sizes were requested.' }

  const site = createWebsiteAdminClient()
  const targets: UploadTarget[] = []

  for (const width of widths) {
    const path = `${collectionSlug}/${brandSlug}/${slug}-${width}.webp`
    const { data, error } = await site.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true })
    if (error || !data) return { ok: false, error: error?.message ?? 'Could not prepare the upload.' }
    targets.push({ width, uploadUrl: data.signedUrl, path })
  }

  return { ok: true, data: targets }
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export async function saveWorkItem(input: {
  brandId: string
  slug: string
  title: string
  width: number
  height: number
  variants: WorkVariant[]
}): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const slug = slugify(input.slug)
  const title = input.title.trim()
  if (!slug) return { ok: false, error: 'That file name cannot be turned into a web address.' }
  if (!title) return { ok: false, error: 'Give the creative a title.' }
  if (!input.variants.length) return { ok: false, error: 'The image did not produce any sizes.' }

  const site = createWebsiteAdminClient()

  // New items go to the end of the brand.
  const { data: last } = await site
    .from('work_items')
    .select('position')
    .eq('brand_id', input.brandId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { error } = await site
    .from('work_items')
    .upsert(
      {
        brand_id: input.brandId,
        slug,
        title,
        width: input.width,
        height: input.height,
        variants: input.variants,
        published: true,
        position: ((last?.position as number | undefined) ?? 0) + 10,
      },
      { onConflict: 'brand_id,slug' },
    )

  if (error) {
    if (error.code === '23505') return { ok: false, error: 'A creative with that name already exists for this brand.' }
    return { ok: false, error: error.message }
  }

  void logActivity({ actorId: guard.employeeId, entityType: 'portfolio_item', entityId: slug, action: 'created', note: `Published "${title}" to the website portfolio` })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function updateWorkItem(
  id: string,
  patch: { title?: string; published?: boolean },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const update: Record<string, unknown> = {}
  if (patch.title !== undefined) {
    const title = patch.title.trim()
    if (!title) return { ok: false, error: 'Give the creative a title.' }
    update.title = title
  }
  if (patch.published !== undefined) update.published = patch.published
  if (!Object.keys(update).length) return { ok: true }

  const site = createWebsiteAdminClient()
  const { error } = await site.from('work_items').update(update).eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function deleteWorkItem(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const site = createWebsiteAdminClient()

  // Read the rendition paths first so the files go with the row.
  const { data: row } = await site.from('work_items').select('slug,title,variants').eq('id', id).maybeSingle()

  const { error } = await site.from('work_items').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  const paths = ((row?.variants ?? []) as WorkVariant[]).map((v) => v.path).filter(Boolean)
  if (paths.length) {
    // A storage failure here leaves orphaned files, not a broken gallery, so
    // it must not fail the whole action.
    const { error: removeErr } = await site.storage.from(BUCKET).remove(paths)
    if (removeErr) console.error('Portfolio: could not remove files for', row?.slug, removeErr.message)
  }

  void logActivity({ actorId: guard.employeeId, entityType: 'portfolio_item', entityId: id, action: 'deleted', note: `Removed "${row?.title ?? 'a creative'}" from the website portfolio` })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Persist a new order for the creatives inside one brand. */
export async function reorderWorkItems(ids: string[]): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!ids.length) return { ok: true }

  const site = createWebsiteAdminClient()
  for (let i = 0; i < ids.length; i++) {
    const { error } = await site.from('work_items').update({ position: (i + 1) * 10 }).eq('id', ids[i])
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Brands ──────────────────────────────────────────────────────────────────

export async function saveBrand(input: {
  id?: string
  collectionId: string
  name: string
  tagline: string
  slug?: string
}): Promise<ActionResult<{ id: string; slug: string }>> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the brand a name.' }
  const slug = slugify(input.slug?.trim() || name)
  if (!slug) return { ok: false, error: 'That brand name cannot be turned into a web address.' }

  const site = createWebsiteAdminClient()
  const tagline = input.tagline.trim() || null

  if (input.id) {
    const { error } = await site.from('work_brands').update({ name, tagline }).eq('id', input.id)
    if (error) return { ok: false, error: error.message }
    revalidatePath(REVALIDATE)
    return { ok: true, data: { id: input.id, slug } }
  }

  const { data: last } = await site
    .from('work_brands')
    .select('position')
    .eq('collection_id', input.collectionId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data, error } = await site
    .from('work_brands')
    .insert({
      collection_id: input.collectionId,
      slug,
      name,
      tagline,
      position: ((last?.position as number | undefined) ?? 0) + 10,
    })
    .select('id,slug')
    .single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: 'A brand with that web address already exists in this collection.' }
    return { ok: false, error: error.message }
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: data.id as string, slug: data.slug as string } }
}

export async function deleteBrand(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const site = createWebsiteAdminClient()

  // Collect every rendition under the brand before the cascade removes the rows.
  const { data: rows } = await site.from('work_items').select('variants').eq('brand_id', id)
  const paths = ((rows ?? []) as { variants: WorkVariant[] | null }[])
    .flatMap((row) => (row.variants ?? []).map((v) => v.path))
    .filter(Boolean)

  const { error } = await site.from('work_brands').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  if (paths.length) {
    const { error: removeErr } = await site.storage.from(BUCKET).remove(paths)
    if (removeErr) console.error('Portfolio: could not remove brand files', removeErr.message)
  }

  void logActivity({ actorId: guard.employeeId, entityType: 'portfolio_item', entityId: id, action: 'deleted', note: 'Removed a brand from the website portfolio' })
  revalidatePath(REVALIDATE)
  return { ok: true }
}
