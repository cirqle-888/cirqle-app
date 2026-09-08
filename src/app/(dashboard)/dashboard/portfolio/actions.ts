'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { createWebsiteAdminClient, websiteSupabaseConfigured } from '@/lib/supabase/website-admin'
import { logActivity } from '@/lib/activity/log'
import type { CoverMode, FlyerRow, PortfolioCollection, UploadTarget, WorkFormat, WorkKind, WorkVariant } from '@/lib/portfolio/types'
import { VIDEO_EXT_BY_TYPE, WORK_FORMATS, formatsFor } from '@/lib/portfolio/types'

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
  caption: string | null
  width: number
  height: number
  variants: WorkVariant[] | null
  published: boolean
  position: number
  collection_position: number | null
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
  logo_path: string | null
  cover_mode: CoverMode | null
  cover_item_id: string | null
  cover_path: string | null
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

/**
 * One unknown field makes PostgREST reject an entire select, so the newer item
 * columns are dropped one at a time rather than as a block — the migrations
 * land in their own order, and a database that has `format` but not
 * `collection_position` should still show formats.
 */
const collectionSelect = (extra: { brand: readonly string[]; item: readonly string[] }) =>
  'id,slug,title,eyebrow,position,work_brands(id,slug,name,tagline,position,' +
  extra.brand.map((c) => `${c},`).join('') +
  'work_items(id,slug,title,width,height,variants,published,position,' +
  extra.item.map((c) => `${c},`).join('') +
  'kind,media_path,external_url,duration_seconds))'

/**
 * Most complete first; each fallback gives up exactly one column, newest
 * first, so a database part-way through the migrations still returns
 * everything it does have.
 */
const COLLECTION_SELECTS = [
  { brand: ['logo_path', 'cover_mode', 'cover_item_id', 'cover_path'], item: ['format', 'collection_position', 'caption'] },
  { brand: ['logo_path'], item: ['format', 'collection_position', 'caption'] },
  { brand: ['logo_path'], item: ['format', 'collection_position'] },
  { brand: ['logo_path'], item: ['format'] },
  { brand: [], item: ['format'] },
  { brand: [], item: [] },
] as const

/**
 * True when PostgREST rejected a write because a column does not exist yet.
 * Newer columns ship in code before their migration has been run against the
 * website database, and a save must not fail for the sake of an optional
 * field — see the add-*.sql files in cirqle-website/supabase.
 */
const isMissingColumn = (e: { code?: string; message?: string } | null, column: string) =>
  !!e && (e.code === 'PGRST204' || e.code === '42703') && (e.message ?? '').includes(column)

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
  let result = await site.from('work_collections').select(collectionSelect(COLLECTION_SELECTS[0])).order('position')
  for (let i = 1; i < COLLECTION_SELECTS.length; i++) {
    if (result.error?.code !== '42703' && result.error?.code !== 'PGRST204') break
    result = await site
      .from('work_collections')
      .select(collectionSelect(COLLECTION_SELECTS[i]))
      .order('position') as typeof result
  }
  const { data, error } = result

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
      logoUrl: brand.logo_path ? `${publicBase}/${brand.logo_path}` : null,
      logoPath: brand.logo_path,
      coverMode: brand.cover_mode ?? 'auto',
      coverItemId: brand.cover_item_id,
      coverPath: brand.cover_path,
      coverUrl: brand.cover_path ? `${publicBase}/${brand.cover_path}` : null,
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
          collectionPosition: item.collection_position ?? null,
          caption: item.caption ?? '',
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
  /** Decides which vocabulary the guessed format comes from. */
  collectionSlug?: string
}): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const slug = slugify(input.slug)
  const title = input.title.trim()
  const kind: WorkKind = input.kind ?? 'image'
  // Guess the format from what was uploaded, so nothing lands untagged: a clip
  // or a linked reel is a reel, a tall still is a story frame, the rest are
  // posts. Outside social media there is nothing in the file to go on — a logo
  // and a brandbook page look alike to a computer — so it falls to the first
  // type the collection offers, and whoever uploads corrects it on the card.
  const vocabulary = formatsFor(input.collectionSlug)
  const guessed: WorkFormat = vocabulary.includes('post')
    ? kind !== 'image'
      ? 'reel'
      : input.width > 0 && input.height / input.width >= 1.5
        ? 'story'
        : 'post'
    : vocabulary[0]
  const format: WorkFormat =
    input.format && WORK_FORMATS.includes(input.format) && vocabulary.includes(input.format)
      ? input.format
      : guessed
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

  const row = {
    brand_id: input.brandId,
    slug,
    title,
    kind,
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
  }

  // The format is worth recording but not worth losing an upload over. Two
  // ways it can be unsavable, and both end in the row going in without it:
  // the column may not exist yet, or it may exist with the older constraint
  // that predates the brand identity types (add-work-format.sql run,
  // add-brand-identity.sql not). The website infers a sane value meanwhile.
  const formatRejected = (e: { code?: string; message?: string } | null) =>
    isMissingColumn(e, 'format') || (e?.code === '23514' && (e.message ?? '').includes('format'))

  let { error } = await site.from('work_items').upsert({ ...row, format }, { onConflict: 'brand_id,slug' })
  if (formatRejected(error)) {
    ({ error } = await site.from('work_items').upsert(row, { onConflict: 'brand_id,slug' }))
  }

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
  patch: { title?: string; caption?: string; published?: boolean; format?: WorkFormat },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const update: Record<string, unknown> = {}
  if (patch.title !== undefined) {
    const title = patch.title.trim()
    if (!title) return { ok: false, error: 'Give the creative a title.' }
    update.title = title
  }
  // An empty caption is stored as null, not '': the website tests for a
  // caption, and "" would be a caption that says nothing.
  if (patch.caption !== undefined) update.caption = patch.caption.trim() || null
  if (patch.published !== undefined) update.published = patch.published
  if (patch.format !== undefined) {
    if (!WORK_FORMATS.includes(patch.format)) return { ok: false, error: 'That is not a format we publish.' }
    update.format = patch.format
  }
  if (!Object.keys(update).length) return { ok: true }

  const site = createWebsiteAdminClient()
  const { error } = await site.from('work_items').update(update).eq('id', id)
  if (isMissingColumn(error, 'format')) {
    return { ok: false, error: 'The website database has no format column yet. Run cirqle-website/supabase/add-work-format.sql in its SQL editor, then try again.' }
  }
  if (isMissingColumn(error, 'caption')) {
    return { ok: false, error: 'The website database has no caption column yet. Run cirqle-website/supabase/add-work-caption.sql in its SQL editor, then try again.' }
  }
  if (error?.code === '23514' && (error.message ?? '').includes('format')) {
    return { ok: false, error: 'The website database does not allow that format yet. Run cirqle-website/supabase/add-brand-identity.sql in its SQL editor, then try again.' }
  }
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

/**
 * Persist a hand-picked order for the collection's All view.
 *
 * Separate from `position`, which orders creatives inside one brand: the All
 * view runs across brands, so the two orders have nothing to say to each other.
 */
export async function reorderCollectionItems(ids: string[]): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!ids.length) return { ok: true }

  const site = createWebsiteAdminClient()
  for (let i = 0; i < ids.length; i++) {
    const { error } = await site.from('work_items').update({ collection_position: (i + 1) * 10 }).eq('id', ids[i])
    if (error) {
      if (isMissingColumn(error, 'collection_position')) {
        return { ok: false, error: 'The website database cannot store this order yet. Run cirqle-website/supabase/add-work-collection-order.sql in its SQL editor, then try again.' }
      }
      return { ok: false, error: error.message }
    }
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Persist the order the brands appear in — chips, and brand-by-brand views. */
export async function reorderBrands(ids: string[]): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!ids.length) return { ok: true }

  const site = createWebsiteAdminClient()
  for (let i = 0; i < ids.length; i++) {
    const { error } = await site.from('work_brands').update({ position: (i + 1) * 10 }).eq('id', ids[i])
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Brands ──────────────────────────────────────────────────────────────────

/**
 * Point a brand at its logo, or clear it.
 *
 * The file itself goes up through the same signed-URL path as artwork; this
 * only records where it landed. Clearing removes the file too, since nothing
 * else can reach it once the row stops naming it.
 */
export async function saveBrandLogo(id: string, path: string | null): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const site = createWebsiteAdminClient()
  const { data: existing } = await site.from('work_brands').select('logo_path').eq('id', id).maybeSingle()

  const { error } = await site.from('work_brands').update({ logo_path: path }).eq('id', id)
  if (isMissingColumn(error, 'logo_path')) {
    return { ok: false, error: 'The website database has no brand logo column yet. Run cirqle-website/supabase/add-brand-logos.sql in its SQL editor, then try again.' }
  }
  if (error) return { ok: false, error: error.message }

  const old = (existing?.logo_path as string | null) ?? null
  if (old && old !== path) {
    // Best effort: a stranded file is untidy, not broken.
    const { error: removeErr } = await site.storage.from(BUCKET).remove([old])
    if (removeErr) console.error('Portfolio: could not remove the old brand logo', removeErr.message)
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function saveBrand(input: {
  id?: string
  collectionId: string
  name: string
  tagline: string
  slug?: string
  coverMode?: CoverMode
  coverItemId?: string | null
  coverPath?: string | null
}): Promise<ActionResult<{ id: string; slug: string }>> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the brand a name.' }
  const slug = slugify(input.slug?.trim() || name)
  if (!slug) return { ok: false, error: 'That brand name cannot be turned into a web address.' }

  const site = createWebsiteAdminClient()
  const tagline = input.tagline.trim() || null

  // The cover columns are newer than the table, so they are dropped and the
  // write retried if the migration has not been run: renaming a brand must not
  // fail for the sake of a card setting.
  const cover: Record<string, unknown> = {}
  if (input.coverMode !== undefined) cover.cover_mode = input.coverMode
  if (input.coverItemId !== undefined) cover.cover_item_id = input.coverItemId
  if (input.coverPath !== undefined) cover.cover_path = input.coverPath

  if (input.id) {
    let { error } = await site.from('work_brands').update({ name, tagline, ...cover }).eq('id', input.id)
    if (Object.keys(cover).length && isMissingColumn(error, 'cover_')) {
      ({ error } = await site.from('work_brands').update({ name, tagline }).eq('id', input.id))
    }
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
  const FIELDS = 'id,title,width,height,variants,published,position'

  // booklet_continues is newer than the table, and PostgREST rejects the whole
  // select for one unknown column. Falling back keeps the panel usable before
  // add-flyer-booklets.sql has been run — every page simply reads as its own.
  type FlyerSelect = Record<string, unknown>
  let result = await site.from('flyers').select(`${FIELDS},booklet_continues`).order('position')
  if (result.error?.code === '42703') {
    result = await site.from('flyers').select(FIELDS).order('position') as typeof result
  }
  const data = result.data as FlyerSelect[] | null
  const error = result.error

  if (error) {
    if (isMissingRelation(error)) {
      return { ok: false, error: 'The website project has no flyers table yet. Re-run cirqle-website/supabase/schema.sql in its SQL editor.' }
    }
    return { ok: false, error: error.message }
  }

  const publicBase = `${process.env.WEBSITE_SUPABASE_URL}/storage/v1/object/public/${FLYERS_BUCKET}`
  return {
    ok: true,
    data: ((data ?? []) as unknown as (FlyerRow & { booklet_continues?: boolean | null })[]).map((row) => {
      const variants = [...(row.variants ?? [])].sort((a, b) => a.width - b.width)
      return {
        ...row,
        variants,
        bookletContinues: row.booklet_continues ?? false,
        previewUrl: variants[0] ? `${publicBase}/${variants[0].path}` : '',
      }
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
  patch: { title?: string; published?: boolean; bookletContinues?: boolean },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const update: Record<string, unknown> = {}
  if (patch.title !== undefined) update.title = patch.title.trim()
  if (patch.published !== undefined) update.published = patch.published
  if (patch.bookletContinues !== undefined) update.booklet_continues = patch.bookletContinues
  if (!Object.keys(update).length) return { ok: true }

  const site = createWebsiteAdminClient()
  const { error } = await site.from('flyers').update(update).eq('id', id)
  if (isMissingColumn(error, 'booklet_continues')) {
    return { ok: false, error: 'The website database has no booklet column yet. Run cirqle-website/supabase/add-flyer-booklets.sql in its SQL editor, then try again.' }
  }
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
