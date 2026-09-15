import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Contribution counts written automatically by the /api/figma/* routes.
 *
 * WHY THIS FILE EXISTS — the bug it closes:
 * Both the save route and the build report used to find their parameters by
 * searching every parameter in the workspace by name. There are 64, and the
 * names collide across departments: the build report's "creatives" lookup
 * (`name.includes('creative')`) matched **Ad Creative Setup**, which belongs
 * to the Ad Campaign Management Group — so a flyer's card count was written
 * into a paid-advertising metric on a flyer task. Nobody would have found
 * that by reading the contribution panel; it just quietly inflated the wrong
 * number.
 *
 * A parameter is only a candidate here if it belongs to a contribution group
 * that is linked to THIS TASK'S SERVICE (`group_services`). For the five
 * Offer Flyers services that narrows 64 parameters to the 15 in Flyer Design
 * Group + Flyer Products Group, which is exactly the set a flyer can earn.
 * A name that matches nothing in that set scores nothing — silence is the
 * correct answer, and far better than the nearest wrong parameter.
 *
 * FALLING BACK: a service with no groups linked yet would score nothing at
 * all, which would look like the feature being broken rather than unconfigured.
 * So an unlinked service falls back to the whole workspace — the old
 * behaviour — but `scoped: false` comes back with it so the caller can say
 * so out loud instead of pretending it worked.
 *
 * Everything here is best-effort: contributions are bookkeeping on top of a
 * saved offer, and must never fail the save that produced them.
 */

export interface Parameter {
  id: string
  name: string
  input_type: string | null
  group_id: string | null
}

export interface ParameterSet {
  /** Candidates, already filtered to count-type parameters. */
  params: Parameter[]
  /** False when this fell back to every parameter in the workspace. */
  scoped: boolean
}

/** Letters only, lower-cased: "Product Name Updating" → "productnameupdating". */
export function flattenName(value: string | null): string {
  return String(value || '').toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * The parameters a task for `serviceId` can earn, narrowed to its service's
 * contribution groups. Count-type only: a percentage parameter ("Design") is
 * a judgement someone makes, not something a save can count.
 */
export async function parametersForService(
  admin: SupabaseClient,
  serviceId: string | null,
): Promise<ParameterSet> {
  const { data: paramRows } = await admin
    .from('parameters')
    .select('id, name, input_type, group_id')
  const all = ((paramRows as Parameter[] | null) || [])
    .filter(p => (p.input_type || 'count') === 'count')

  if (!serviceId) return { params: all, scoped: false }

  const { data: links } = await admin
    .from('group_services')
    .select('group_id')
    .eq('service_id', serviceId)
  const groupIds = ((links as { group_id: string | null }[] | null) || [])
    .map(l => l.group_id)
    .filter((id): id is string => !!id)
  if (!groupIds.length) return { params: all, scoped: false }

  const scoped = all.filter(p => p.group_id && groupIds.includes(p.group_id))
  // A service whose groups hold no count parameters is configuration the
  // workspace has not finished; the whole list is no more correct than the
  // empty one, so say it is unscoped and let the caller report it.
  return scoped.length ? { params: scoped, scoped: true } : { params: all, scoped: false }
}

/** The first candidate whose flattened name satisfies `test`, or null. */
export function findParameter(set: ParameterSet, test: (flat: string) => boolean): string | null {
  return set.params.find(p => test(flattenName(p.name)))?.id || null
}

/**
 * The parameters a flyer save can fill in, by the role each plays.
 *
 * Matched by name so the workspace can rename and re-seed its own scoring
 * setup without a code change — but only ever within the service's own
 * groups, so a rename can make a count go missing and can no longer make it
 * land somewhere wrong.
 */
export interface FlyerParameters {
  products: string | null
  price: string | null
  productName: string | null
  photo: string | null
  limit: string | null
  specialTags: string | null
  layout: string | null
  sheet: string | null
  date: string | null
  /** Names this workspace has no parameter for — reported, never invented. */
  missing: string[]
  scoped: boolean
}

export function resolveFlyerParameters(set: ParameterSet): FlyerParameters {
  const pick = (label: string, test: (n: string) => boolean, missing: string[]) => {
    const id = findParameter(set, test)
    if (!id) missing.push(label)
    return id
  }
  const missing: string[] = []
  return {
    products: pick('Products', n => n === 'products' || n === 'productcount' || n === 'product', missing),
    price: pick('Price Updating', n => n.includes('price') && n.includes('updat'), missing),
    productName: pick('Product Name Updating', n => n.includes('name') && n.includes('updat'), missing),
    photo: pick('Photo Updating', n => n.includes('photo'), missing),
    limit: pick('Limit Updating', n => n.includes('limit'), missing),
    specialTags: pick('Add Special Tags', n => n.includes('tag'), missing),
    layout: pick('Layout Change', n => n.includes('layout'), missing),
    sheet: pick('Sheet Updating', n => n.includes('sheet'), missing),
    date: pick('Date Change', n => n.includes('date') && n.includes('chang'), missing),
    missing,
    scoped: set.scoped,
  }
}

/**
 * Add to (or set) one employee's count for one parameter on one task.
 *
 * `delta` accumulates — two saves that each changed three prices leave six.
 * `setTo` replaces, for the counts that describe the artefact rather than the
 * effort: a flyer is two pages however many times it was rebuilt.
 */
export async function bumpContribution(
  admin: SupabaseClient,
  opts: {
    taskId: string
    employeeId: string
    parameterId: string | null
    delta?: number
    setTo?: number
  },
): Promise<void> {
  const { taskId, employeeId, parameterId, delta = 0, setTo } = opts
  if (!parameterId) return
  if (setTo == null && delta <= 0) return

  const { data: row } = await admin
    .from('contributions')
    .select('value')
    .eq('task_id', taskId)
    .eq('employee_id', employeeId)
    .eq('parameter_id', parameterId)
    .maybeSingle()

  const current = Number((row as { value?: number } | null)?.value ?? NaN)
  if (Number.isFinite(current)) {
    const next = setTo != null ? setTo : current + delta
    if (next === current) return
    await admin
      .from('contributions')
      .update({ value: next })
      .eq('task_id', taskId)
      .eq('employee_id', employeeId)
      .eq('parameter_id', parameterId)
  } else {
    await admin.from('contributions').insert({
      task_id: taskId,
      employee_id: employeeId,
      parameter_id: parameterId,
      value: setTo != null ? setTo : delta,
    })
  }
}

/**
 * What one save changed, counted row by row.
 *
 * Rows are compared BY POSITION, which is the only identity a pasted list
 * has. It is not perfect — insert a row at the top and every row below it
 * looks edited — and that is why Offer Studio reads the campaign back after a
 * push and remembers each row's Cirqle product id: the NEXT save carries real
 * identities and this becomes exact. Position is the honest approximation
 * until then, and it is the same one the change log already uses.
 *
 * Only the FIRST `min(before, after)` rows are compared. Rows beyond that are
 * additions, counted separately as `added` — an added row is not an edit of
 * anything, and counting it as one would score the same work twice.
 */
export interface ProductBefore {
  name?: string | null
  price?: number | null
  mrp?: number | null
  weight?: string | null
  page?: number | null
  image_url?: string | null
  /** True when the row already carried any badge, single or multi. */
  hasBadge?: boolean
}

export interface ProductAfter {
  name?: string | null
  price?: number | null
  mrp?: number | null
  weight?: string | null
  page?: number | null
  image_url?: string | null
  /** How many badges the row carries after this save. */
  badgeCount?: number
}

export interface ProductDiff {
  added: number
  name: number
  price: number
  photo: number
  limit: number
  specialTags: number
  layout: number
  /** True when anything at all moved — what "Sheet Updating" records. */
  touched: boolean
}

export function diffProducts(before: ProductBefore[], after: ProductAfter[]): ProductDiff {
  const norm = (v: string | null | undefined) => String(v ?? '').trim()
  const diff: ProductDiff = {
    added: Math.max(0, after.length - before.length),
    name: 0, price: 0, photo: 0, limit: 0, specialTags: 0, layout: 0, touched: false,
  }

  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = before[i]
    const b = after[i]
    if (norm(a.name) !== norm(b.name)) diff.name++
    if ((a.price ?? null) !== (b.price ?? null) || (a.mrp ?? null) !== (b.mrp ?? null)) diff.price++
    if (norm(a.image_url) !== norm(b.image_url)) diff.photo++
    if (norm(a.weight) !== norm(b.weight)) diff.limit++
    // A badge REMOVED is not "Add Special Tags" — only one gained is.
    if (!a.hasBadge && (b.badgeCount ?? 0) > 0) diff.specialTags++
    // Page defaults to 1 on both sides: a row that never named a page has
    // not "moved" when the save states the 1 it always had.
    if ((a.page ?? 1) !== (b.page ?? 1)) diff.layout++
  }

  diff.touched = diff.added + diff.name + diff.price + diff.photo +
    diff.limit + diff.specialTags + diff.layout > 0
  return diff
}
