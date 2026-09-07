'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { createWebsiteAdminClient, websiteSupabaseConfigured } from '@/lib/supabase/website-admin'
import { logActivity } from '@/lib/activity/log'
import type { FlyerRow, PortfolioCollection, UploadTarget, WorkFormat, WorkKind, WorkVariant } from '@/lib/portfolio/types'
import { VIDEO_EXT_BY_TYPE, WORK_FORMATS } from '@/lib/portfolio/types'

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
const FLYERS_BUCKET = 'flyers'

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
  kind: WorkKind | null
  format: WorkFormat | null
  media_path: string | null
  external_url: string | null
  duration_seconds: number | null
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

const COLLECTION_SELECT =
  'id,slug,title,eyebrow,position,work_brands(id,slug,name,tagline,position,work_items(id,slug,title,width,height,variants,published,position,kind,media_path,external_url,duration_seconds))'

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
    .select(COLLECTION_SELECT)
    .order('position')

  if (error) {
    if (isMissingRelation(error)) {
      return { ok: false, error: 'The website project has no portfolio tables yet. Run cirqle-website/supabase/schema.sql in its SQL editor.' }
    }
    return { ok: false, error: error.message }
  }

  const publicBase = `${process.env.WEBSITE_SUPABASE_URL}/storage/v1/object/public/${BUCKET}`
  const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position

  const collections: PortfolioCollection[] = ((data ?? []) as unknown as CollectionRow[]).map((collection) => ({
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
          kind: item.kind ?? 'image',
          format: item.format ?? 'post',
          mediaPath: item.media_path,
          externalUrl: item.external_url,
          durationSeconds: item.duration_seconds,
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
  kind?: WorkKind
  mediaPath?: string | null
  externalUrl?: string | null
  durationSeconds?: number | null
  format?: WorkFormat
}): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const slug = slugify(input.slug)
  const title = input.title.trim()
  const kind: WorkKind = input.kind ?? 'image'
  // Guess the format from what was uploaded, so nothing lands untagged: a clip
  // or a linked reel is a reel, a tall still is a story frame, the rest are
  // posts. Whoever uploads can correct it on the card afterwards.
  const format: WorkFormat =
    input.format && WORK_FORMATS.includes(input.format)
      ? input.format
      : kind !== 'image'
        ? 'reel'
        : input.width > 0 && input.height / input.width >= 1.5
          ? 'story'
          : 'post'
  if (!slug) return { ok: false, error: 'That file name cannot be turned into a web address.' }
  if (!title) return { ok: false, error: 'Give the creative a title.' }
  if (kind === 'image' && !input.variants.length) return { ok: false, error: 'The image did not produce any sizes.' }
  if (kind === 'video' && !input.mediaPath) return { ok: false, error: 'The video file was not uploaded.' }

  const externalUrl = input.externalUrl?.trim() || null
  if (kind === 'reel' && !externalUrl) return { ok: false, error: 'Paste the link where the reel plays.' }
  if (externalUrl) {
    // A prefix test alone let "https://" through, which then threw inside
    // new URL() while rendering the dashboard and blanked the whole page.
    let host = ''
    try {
      const parsed = new URL(externalUrl)
      host = parsed.hostname
      if (parsed.protocol !== 'https:') host = ''
    } catch {
      host = ''
    }
    if (!host) return { ok: false, error: 'That does not look like a link. It should start with https:// and include a site, like https://www.instagram.com/reel/...' }
  }

  const site = createWebsiteAdminClient()

  // Uploading over an existing slug replaces that creative, which is intended.
  // What is not intended is leaving the file it replaced behind: the row that
  // named it is about to be overwritten, so nothing could ever reach it again.
  const { data: existing } = await site
    .from('work_items')
    .select('media_path,variants')
    .eq('brand_id', input.brandId)
    .eq('slug', slug)
    .maybeSingle()

  const superseded: string[] = []
  if (existing) {
    const keptVariants = new Set(input.variants.map((v) => v.path))
    for (const v of (existing.variants ?? []) as WorkVariant[]) {
      if (v.path && !keptVariants.has(v.path)) superseded.push(v.path)
    }
    const oldMedia = existing.media_path as string | null
    if (oldMedia && oldMedia !== (input.mediaPath ?? null)) superseded.push(oldMedia)
  }

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
        kind,
        format,
        media_path: input.mediaPath ?? null,
        external_url: externalUrl,
        duration_seconds: input.durationSeconds ?? null,
        // A link-only reel has no artwork of its own, so record a sane ratio
        // rather than zero, which the check constraint rejects.
        width: input.width || 1080,
        height: input.height || 1920,
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

  if (superseded.length) {
    // Best effort: a stranded file is untidy, not broken, so it must not fail
    // an upload that has already succeeded.
    const { error: removeErr } = await site.storage.from(BUCKET).remove(superseded)
    if (removeErr) console.error('Portfolio: could not remove superseded files for', slug, removeErr.message)
  }

  void logActivity({ actorId: guard.employeeId, entityType: 'portfolio_item', entityId: slug, action: 'created', note: `Published "${title}" to the website portfolio` })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function updateWorkItem(
  id: string,
  patch: { title?: string; published?: boolean; format?: WorkFormat },
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
  if (patch.format !== undefined) {
    if (!WORK_FORMATS.includes(patch.format)) return { ok: false, error: 'That is not a format we publish.' }
    update.format = patch.format
  }
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
  const { data: row } = await site.from('work_items').select('slug,title,variants,media_path').eq('id', id).maybeSingle()

  const { error } = await site.from('work_items').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  const paths = ((row?.variants ?? []) as WorkVariant[]).map((v) => v.path).filter(Boolean)
  if (row?.media_path) paths.push(row.media_path as string)
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

  // Collect every file under the brand before the cascade removes the rows.
  // Videos live in media_path, not variants — missing them left 50 MB objects
  // stranded in a public bucket with nothing left to reference them.
  const { data: rows } = await site.from('work_items').select('variants,media_path').eq('brand_id', id)
  const paths = ((rows ?? []) as { variants: WorkVariant[] | null; media_path: string | null }[])
    .flatMap((row) => [...(row.variants ?? []).map((v) => v.path), row.media_path])
    .filter((path): path is string => Boolean(path))

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

// ─── Video uploads ───────────────────────────────────────────────────────────

/**
 * One signed URL for the video file itself. The browser PUTs the file straight
 * to storage, so a 50 MB reel never passes through this server.
 */
export async function createVideoUploadUrl(input: {
  collectionSlug: string
  brandSlug: string
  slug: string
  contentType: string
}): Promise<ActionResult<{ uploadUrl: string; path: string }>> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }

  // The bucket is public, so an unchecked extension would let something else
  // be served from our own domain.
  const ext = VIDEO_EXT_BY_TYPE[input.contentType?.toLowerCase().split(';')[0].trim()]
  if (!ext) return { ok: false, error: 'Videos must be MP4, WebM or MOV.' }

  const collectionSlug = slugify(input.collectionSlug)
  const brandSlug = slugify(input.brandSlug)
  const slug = slugify(input.slug)
  if (!collectionSlug || !brandSlug || !slug) {
    return { ok: false, error: 'That file name cannot be turned into a web address.' }
  }

  const path = `${collectionSlug}/${brandSlug}/${slug}.${ext}`
  const site = createWebsiteAdminClient()
  const { data, error } = await site.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true })
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not prepare the upload.' }
  return { ok: true, data: { uploadUrl: data.signedUrl, path } }
}

// ─── Supermarket flyers ──────────────────────────────────────────────────────

/** Every flyer page, in the order the website flips through them. */
export async function listFlyers(): Promise<ActionResult<FlyerRow[]>> {
  const guard = await requireReadPermission(PERMS.PORTFOLIO_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }

  const site = createWebsiteAdminClient()
  const { data, error } = await site
    .from('flyers')
    .select('id,title,width,height,variants,published,position')
    .order('position')

  if (error) {
    if (isMissingRelation(error)) {
      return { ok: false, error: 'The website project has no flyers table yet. Re-run cirqle-website/supabase/schema.sql in its SQL editor.' }
    }
    return { ok: false, error: error.message }
  }

  const publicBase = `${process.env.WEBSITE_SUPABASE_URL}/storage/v1/object/public/${FLYERS_BUCKET}`
  return {
    ok: true,
    data: ((data ?? []) as unknown as FlyerRow[]).map((row) => {
      const variants = [...(row.variants ?? [])].sort((a, b) => a.width - b.width)
      return { ...row, variants, previewUrl: variants[0] ? `${publicBase}/${variants[0].path}` : '' }
    }),
  }
}

export async function createFlyerUploadUrls(input: {
  slug: string
  widths: number[]
}): Promise<ActionResult<UploadTarget[]>> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }

  const slug = slugify(input.slug)
  if (!slug) return { ok: false, error: 'That file name cannot be turned into a web address.' }

  const widths = input.widths.filter((w) => Number.isInteger(w) && w > 0 && w <= 4000)
  if (!widths.length) return { ok: false, error: 'No image sizes were requested.' }

  // Flyers are replaced weekly and names repeat, so a stamp keeps a new upload
  // from overwriting the page it is meant to sit beside.
  const stamp = Date.now().toString(36)
  const site = createWebsiteAdminClient()
  const targets: UploadTarget[] = []

  for (const width of widths) {
    const path = `${slug}-${stamp}-${width}.webp`
    const { data, error } = await site.storage.from(FLYERS_BUCKET).createSignedUploadUrl(path, { upsert: true })
    if (error || !data) return { ok: false, error: error?.message ?? 'Could not prepare the upload.' }
    targets.push({ width, uploadUrl: data.signedUrl, path })
  }

  return { ok: true, data: targets }
}

export async function saveFlyer(input: {
  title: string
  width: number
  height: number
  variants: WorkVariant[]
}): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.variants.length) return { ok: false, error: 'The image did not produce any sizes.' }

  const site = createWebsiteAdminClient()
  const { data: last } = await site
    .from('flyers')
    .select('position')
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { error } = await site.from('flyers').insert({
    title: input.title.trim(),
    width: input.width,
    height: input.height,
    variants: input.variants,
    published: true,
    position: ((last?.position as number | undefined) ?? 0) + 10,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function updateFlyer(
  id: string,
  patch: { title?: string; published?: boolean },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const update: Record<string, unknown> = {}
  if (patch.title !== undefined) update.title = patch.title.trim()
  if (patch.published !== undefined) update.published = patch.published
  if (!Object.keys(update).length) return { ok: true }

  const site = createWebsiteAdminClient()
  const { error } = await site.from('flyers').update(update).eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function deleteFlyer(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const site = createWebsiteAdminClient()
  const { data: row } = await site.from('flyers').select('title,variants').eq('id', id).maybeSingle()

  const { error } = await site.from('flyers').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  const paths = ((row?.variants ?? []) as WorkVariant[]).map((v) => v.path).filter(Boolean)
  if (paths.length) {
    const { error: removeErr } = await site.storage.from(FLYERS_BUCKET).remove(paths)
    if (removeErr) console.error('Portfolio: could not remove flyer files', removeErr.message)
  }

  void logActivity({ actorId: guard.employeeId, entityType: 'portfolio_item', entityId: id, action: 'deleted', note: `Removed flyer "${row?.title ?? 'untitled'}" from the website` })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Persist a new page order for the flyers. */
export async function reorderFlyers(ids: string[]): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!ids.length) return { ok: true }

  const site = createWebsiteAdminClient()
  for (let i = 0; i < ids.length; i++) {
    const { error } = await site.from('flyers').update({ position: (i + 1) * 10 }).eq('id', ids[i])
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}
