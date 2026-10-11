'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { createWebsiteAdminClient, websiteSupabaseConfigured } from '@/lib/supabase/website-admin'
import { logActivity } from '@/lib/activity/log'
import {
  SHOWCASE_COLUMNS, defaultAltText, isOwnStoragePath, nextPosition, pathFromPublicUrl,
  positionsFor, publicUrlFor, rowToEntry, uniqueShowcaseSlug, validateShowcaseInput, clampFocal,
  type ShowcaseEntry, type ShowcaseInput, type ShowcaseRow,
} from '@/lib/portfolio/showcase'

/**
 * Website Presentation — reads and writes `work_showcases` in the SEPARATE
 * Supabase project that serves cirqle.work, with that project's service-role
 * key, which never leaves the server.
 *
 * The upload itself reuses the gallery's signed-URL actions (`createWorkUploadUrls`,
 * `createVideoUploadUrl` in ./actions): the browser PUTs files straight to the
 * `work` bucket under `showcase/<slug>/`, then hands THIS file the storage
 * paths. Paths, not URLs — see lib/portfolio/showcase for why.
 */

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

const BUCKET = 'work'
const REVALIDATE = '/dashboard/portfolio'
const TABLE = 'work_showcases'

const SETUP_HINT =
  'The website Supabase project is not configured yet. Add WEBSITE_SUPABASE_URL and WEBSITE_SUPABASE_SERVICE_ROLE_KEY, then reload.'

const TABLE_HINT =
  'The website database has no presentation table yet. Run cirqle-website/supabase/work-showcases.sql in the WEBSITE Supabase project’s SQL editor (not the Cirqle ERP one), then reload.'

/** PostgREST says "schema cache" when a table or column is missing. */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === 'PGRST205' || error.code === '42P01'
    || /schema cache|does not exist/i.test(error.message ?? '')
}

function friendly(error: { code?: string; message?: string }): string {
  if (isMissingTable(error)) return TABLE_HINT
  if (error.code === '23505') return 'A presentation with that web address already exists. Try a slightly different client name.'
  if (error.code === '23514') return 'The website database rejected that combination of fields. Check that any video has a poster frame, then try again.'
  return error.message ?? 'Something went wrong.'
}

function publicBase(): string {
  return (process.env.WEBSITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** Every presentation, published or not, in the order the website lists them. */
export async function listShowcases(): Promise<ActionResult<ShowcaseEntry[]>> {
  // Read guard, not the write guard: this only lists, and the write guard
  // refuses during an access preview, which would show a previewing admin a
  // broken panel instead of a narrower one.
  const guard = await requireReadPermission(PERMS.PORTFOLIO_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }

  const site = createWebsiteAdminClient()
  const { data, error } = await site
    .from(TABLE)
    .select(SHOWCASE_COLUMNS)
    .order('position', { ascending: true })
    .order('slug', { ascending: true })
  if (error) return { ok: false, error: friendly(error) }

  return { ok: true, data: ((data ?? []) as unknown as ShowcaseRow[]).map((r) => rowToEntry(r, publicBase())) }
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/**
 * Create or update a presentation.
 *
 * On create the slug is chosen here, once, and then never changes — it is the
 * storage folder, so the browser asks for it first (`reserveShowcaseSlug`) in
 * order to upload into the right place before saving.
 */
export async function saveShowcase(
  input: ShowcaseInput & { slug: string; published?: boolean },
): Promise<ActionResult<ShowcaseEntry>> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }

  const slug = (input.slug ?? '').trim()
  const checked = validateShowcaseInput(input, slug)
  if (!checked.ok) return { ok: false, error: checked.errors.join(' ') }

  const site = createWebsiteAdminClient()
  const base = publicBase()
  const version = Date.now()

  // What an edit replaces, so superseded files can be cleaned up afterwards.
  let previous: ShowcaseRow | null = null
  if (input.id) {
    const { data, error } = await site.from(TABLE).select(SHOWCASE_COLUMNS).eq('id', input.id).maybeSingle()
    if (error) return { ok: false, error: friendly(error) }
    if (!data) return { ok: false, error: 'That presentation no longer exists. Reload the page.' }
    previous = data as unknown as ShowcaseRow
    // The slug is the folder the files live in — never let an edit move it.
    if (previous.slug !== slug) return { ok: false, error: 'A presentation’s web address cannot be changed.' }
  }

  const urlOf = (path: string | null): string | null =>
    path && isOwnStoragePath(slug, path) ? publicUrlFor(base, BUCKET, path, version) : null

  const d = input.desktop
  const m = input.mobile
  const row = {
    slug,
    client_name: input.clientName.trim(),
    category: input.category.trim(),
    description: input.description.trim(),
    alt_text: input.altText.trim() || defaultAltText(input.clientName, input.category),
    project_path: input.projectPath?.trim() || null,
    media_type: d.type,
    media_url: urlOf(d.path) as string,
    poster_url: d.type === 'video' ? urlOf(d.posterPath) : null,
    focal_x: clampFocal(d.focalX),
    focal_y: clampFocal(d.focalY),
    mobile_media_url: m ? urlOf(m.path) : null,
    mobile_media_type: m ? m.type : null,
    mobile_poster_url: m && m.type === 'video' ? urlOf(m.posterPath) : null,
    mobile_focal_x: m ? clampFocal(m.focalX) : null,
    mobile_focal_y: m ? clampFocal(m.focalY) : null,
  }

  let saved: ShowcaseRow | null = null
  if (previous) {
    // Publish state and order are changed by their own actions, so an edit
    // cannot silently unpublish or reshuffle anything.
    const { data, error } = await site.from(TABLE).update(row).eq('id', previous.id).select(SHOWCASE_COLUMNS).single()
    if (error) return { ok: false, error: friendly(error) }
    saved = data as unknown as ShowcaseRow
  } else {
    const { data: existing, error: listErr } = await site.from(TABLE).select('position')
    if (listErr) return { ok: false, error: friendly(listErr) }
    const position = nextPosition(((existing ?? []) as { position: number | null }[]).map((r) => ({ position: r.position ?? 0 })))
    const { data, error } = await site
      .from(TABLE)
      // New presentations start unpublished: uploading and previewing is not
      // the same decision as putting it on the live site.
      .insert({ ...row, position, published: input.published === true })
      .select(SHOWCASE_COLUMNS)
      .single()
    if (error) return { ok: false, error: friendly(error) }
    saved = data as unknown as ShowcaseRow
  }

  if (previous) await removeSuperseded(site, base, previous, saved)

  void logActivity({
    actorId: guard.employeeId, entityType: 'portfolio_item', entityId: slug,
    action: previous ? 'updated' : 'created',
    note: `${previous ? 'Updated' : 'Created'} the website presentation for "${row.client_name}"`,
  })
  revalidatePath(REVALIDATE)
  return { ok: true, data: rowToEntry(saved, base) }
}

/**
 * A slug for a new presentation, chosen before anything is uploaded.
 *
 * The files go to `showcase/<slug>/`, so the slug has to exist — and be
 * unique — before the first byte is sent.
 */
export async function reserveShowcaseSlug(clientName: string): Promise<ActionResult<string>> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }
  if (!clientName.trim()) return { ok: false, error: 'Enter the client name first.' }

  const site = createWebsiteAdminClient()
  const { data, error } = await site.from(TABLE).select('slug')
  if (error) return { ok: false, error: friendly(error) }
  return { ok: true, data: uniqueShowcaseSlug(clientName, ((data ?? []) as { slug: string }[]).map((r) => r.slug)) }
}

export async function setShowcasePublished(id: string, published: boolean): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }

  const site = createWebsiteAdminClient()
  const { data, error } = await site.from(TABLE).update({ published }).eq('id', id).select('slug, client_name').maybeSingle()
  if (error) return { ok: false, error: friendly(error) }
  if (!data) return { ok: false, error: 'That presentation no longer exists. Reload the page.' }

  void logActivity({
    actorId: guard.employeeId, entityType: 'portfolio_item', entityId: data.slug,
    action: 'updated',
    note: `${published ? 'Published' : 'Unpublished'} the website presentation for "${data.client_name}"`,
  })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function reorderShowcases(ids: string[]): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }
  if (!ids.length) return { ok: true }

  const site = createWebsiteAdminClient()
  for (const { id, position } of positionsFor(ids)) {
    const { error } = await site.from(TABLE).update({ position }).eq('id', id)
    if (error) return { ok: false, error: friendly(error) }
  }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function deleteShowcase(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PORTFOLIO_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!websiteSupabaseConfigured()) return { ok: false, error: SETUP_HINT }

  const site = createWebsiteAdminClient()
  const { data: row, error: readErr } = await site.from(TABLE).select(SHOWCASE_COLUMNS).eq('id', id).maybeSingle()
  if (readErr) return { ok: false, error: friendly(readErr) }
  if (!row) return { ok: true } // already gone

  const { error } = await site.from(TABLE).delete().eq('id', id)
  if (error) return { ok: false, error: friendly(error) }

  // Best effort, and only after the row is gone: an orphaned file is untidy,
  // a row pointing at a deleted file is a broken public page.
  await removeFiles(site, filesOf(publicBase(), row as unknown as ShowcaseRow))

  const r = row as unknown as ShowcaseRow
  void logActivity({
    actorId: guard.employeeId, entityType: 'portfolio_item', entityId: r.slug, action: 'deleted',
    note: `Removed the website presentation for "${r.client_name}"`,
  })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Storage tidy-up ─────────────────────────────────────────────────────────

/** Storage paths a row currently points at. */
function filesOf(base: string, row: ShowcaseRow): string[] {
  return [row.media_url, row.poster_url, row.mobile_media_url, row.mobile_poster_url]
    .map((u) => pathFromPublicUrl(base, BUCKET, u))
    .filter((p): p is string => !!p && isOwnStoragePath(row.slug, p))
}

async function removeFiles(site: ReturnType<typeof createWebsiteAdminClient>, paths: string[]) {
  if (!paths.length) return
  const { error } = await site.storage.from(BUCKET).remove(paths)
  if (error) console.error('Presentation: could not remove stored files', paths, error.message)
}

/** Delete files an edit replaced and nothing references any more. */
async function removeSuperseded(
  site: ReturnType<typeof createWebsiteAdminClient>,
  base: string,
  before: ShowcaseRow,
  after: ShowcaseRow,
) {
  const keep = new Set(filesOf(base, after))
  await removeFiles(site, filesOf(base, before).filter((p) => !keep.has(p)))
}
