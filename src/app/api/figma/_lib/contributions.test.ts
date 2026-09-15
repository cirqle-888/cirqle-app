import { describe, it, expect } from 'vitest'
import {
  diffProducts,
  flattenName,
  findParameter,
  parametersForService,
  resolveFlyerParameters,
  type Parameter,
  type ParameterSet,
} from './contributions'

/**
 * The bug these tests hold shut:
 *
 * Both flyer routes used to search every parameter in the workspace by name.
 * There are 64, they span eight departments, and "creatives" matched **Ad
 * Creative Setup** in the Ad Campaign Management Group — so a flyer's card
 * count was written into a paid-advertising metric. Nothing in the UI would
 * have shown it; the number was simply wrong.
 *
 * `WORKSPACE` below is the real parameter set, names and groups as they are in
 * the live catalog, trimmed to the ones that matter here. The test that counts
 * is "a flyer service never resolves a parameter from another department".
 */

const FLYER_DESIGN = 'grp-flyer-design'
const FLYER_PRODUCTS = 'grp-flyer-products'
const AD_CAMPAIGN = 'grp-ad-campaign'
const VIDEO = 'grp-video'

const WORKSPACE: Parameter[] = [
  // Flyer Design Group
  { id: 'p-design', name: 'Design', input_type: 'percentage', group_id: FLYER_DESIGN },
  { id: 'p-design-cleanup', name: 'Design Cleanup', input_type: 'count', group_id: FLYER_DESIGN },
  { id: 'p-date-change', name: 'Date Change', input_type: 'count', group_id: FLYER_DESIGN },
  { id: 'p-title-change', name: 'Title Change', input_type: 'count', group_id: FLYER_DESIGN },
  // Flyer Products Group
  { id: 'p-products', name: 'Products', input_type: 'count', group_id: FLYER_PRODUCTS },
  { id: 'p-photo', name: 'Photo Updating', input_type: 'count', group_id: FLYER_PRODUCTS },
  { id: 'p-price', name: 'Price Updating', input_type: 'count', group_id: FLYER_PRODUCTS },
  { id: 'p-name', name: 'Product Name Updating', input_type: 'count', group_id: FLYER_PRODUCTS },
  { id: 'p-limit', name: 'Limit Updating', input_type: 'count', group_id: FLYER_PRODUCTS },
  { id: 'p-tags', name: 'Add Special Tags', input_type: 'count', group_id: FLYER_PRODUCTS },
  { id: 'p-sheet', name: 'Sheet Updating', input_type: 'count', group_id: FLYER_PRODUCTS },
  { id: 'p-layout', name: 'Layout Change', input_type: 'count', group_id: FLYER_PRODUCTS },
  // Another department entirely — the source of the bug.
  { id: 'p-ad-creative', name: 'Ad Creative Setup', input_type: 'count', group_id: AD_CAMPAIGN },
  { id: 'p-campaign-setup', name: 'Campaign Setup', input_type: 'count', group_id: AD_CAMPAIGN },
  { id: 'p-motion', name: 'Motion Graphics', input_type: 'count', group_id: VIDEO },
]

/** A stand-in for the service-role client: only the two tables this reads. */
function fakeAdmin(groupsByService: Record<string, string[]>, opts: { parameters?: Parameter[] } = {}) {
  const parameters = opts.parameters ?? WORKSPACE
  return {
    from(table: string) {
      if (table === 'parameters') {
        return { select: async () => ({ data: parameters }) }
      }
      if (table === 'group_services') {
        return {
          select: () => ({
            eq: async (_col: string, serviceId: string) => ({
              data: (groupsByService[serviceId] ?? []).map(group_id => ({ group_id })),
            }),
          }),
        }
      }
      throw new Error('unexpected table ' + table)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const FLYER_SERVICE = 'svc-offer-flyer'
const groups = { [FLYER_SERVICE]: [FLYER_DESIGN, FLYER_PRODUCTS] }

describe('flattenName', () => {
  it('reduces a name to its letters', () => {
    expect(flattenName('Product Name Updating')).toBe('productnameupdating')
    expect(flattenName('Design Cleanup (Variable)')).toBe('designcleanupvariable')
    expect(flattenName(null)).toBe('')
  })
})

describe('parametersForService', () => {
  it('narrows to the groups linked to the service', async () => {
    const set = await parametersForService(fakeAdmin(groups), FLYER_SERVICE)
    expect(set.scoped).toBe(true)
    expect(set.params.map(p => p.id)).not.toContain('p-ad-creative')
    expect(set.params.map(p => p.id)).toContain('p-products')
  })

  it('drops percentage parameters — a save counts, it does not judge', async () => {
    const set = await parametersForService(fakeAdmin(groups), FLYER_SERVICE)
    expect(set.params.map(p => p.id)).not.toContain('p-design')
  })

  it('falls back to the whole workspace when the service has no groups, and says so', async () => {
    const set = await parametersForService(fakeAdmin({}), 'svc-unconfigured')
    expect(set.scoped).toBe(false)
    expect(set.params.map(p => p.id)).toContain('p-ad-creative')
  })

  it('falls back when no service is known at all', async () => {
    const set = await parametersForService(fakeAdmin(groups), null)
    expect(set.scoped).toBe(false)
  })

  it('falls back when the linked groups hold no count parameters', async () => {
    const admin = fakeAdmin(
      { 'svc-empty': ['grp-empty'] },
      { parameters: [{ id: 'p-only', name: 'Design', input_type: 'percentage', group_id: 'grp-empty' }] },
    )
    const set = await parametersForService(admin, 'svc-empty')
    expect(set.scoped).toBe(false)
  })
})

describe('resolveFlyerParameters', () => {
  it('finds every count a flyer save can fill in', async () => {
    const p = resolveFlyerParameters(await parametersForService(fakeAdmin(groups), FLYER_SERVICE))
    expect(p).toMatchObject({
      products: 'p-products',
      price: 'p-price',
      productName: 'p-name',
      photo: 'p-photo',
      limit: 'p-limit',
      specialTags: 'p-tags',
      layout: 'p-layout',
      sheet: 'p-sheet',
      date: 'p-date-change',
    })
    expect(p.missing).toEqual([])
    expect(p.scoped).toBe(true)
  })

  it('never reaches into another department for "creative"', async () => {
    const set = await parametersForService(fakeAdmin(groups), FLYER_SERVICE)
    // The exact lookup the build report performs.
    const creative = findParameter(set, n => n.includes('creative') || n === 'designs' || n === 'cards')
    expect(creative).toBeNull()
  })

  it('reports a parameter the workspace does not have instead of guessing', async () => {
    const admin = fakeAdmin(
      { [FLYER_SERVICE]: [FLYER_PRODUCTS] },
      { parameters: WORKSPACE.filter(p => p.id !== 'p-photo' && p.group_id === FLYER_PRODUCTS) },
    )
    const p = resolveFlyerParameters(await parametersForService(admin, FLYER_SERVICE))
    expect(p.photo).toBeNull()
    expect(p.missing).toContain('Photo Updating')
    // The ones that do exist are unaffected.
    expect(p.products).toBe('p-products')
  })

  it('does not mistake "Date Change" for any other date-ish name', () => {
    const set: ParameterSet = {
      scoped: true,
      params: [
        { id: 'p-due', name: 'Due Date', input_type: 'count', group_id: FLYER_DESIGN },
        { id: 'p-date-change', name: 'Date Change', input_type: 'count', group_id: FLYER_DESIGN },
      ],
    }
    expect(resolveFlyerParameters(set).date).toBe('p-date-change')
  })
})

describe('diffProducts', () => {
  const row = (over: Partial<{ name: string; price: number; mrp: number | null; weight: string; page: number; image_url: string; hasBadge: boolean; badgeCount: number }> = {}) => ({
    name: 'Rice Ponni', price: 53, mrp: null, weight: '5kg', page: 1,
    image_url: 'https://cdn/rice.png', ...over,
  })

  it('counts nothing when nothing moved', () => {
    const d = diffProducts([row()], [row()])
    expect(d).toMatchObject({ added: 0, name: 0, price: 0, photo: 0, limit: 0, specialTags: 0, layout: 0 })
    expect(d.touched).toBe(false)
  })

  it('counts each kind of edit once, on the row it happened to', () => {
    const before = [row(), row({ name: 'Sugar' }), row({ name: 'Oil' })]
    const after = [
      row({ price: 49 }),                       // price
      row({ name: 'Sugar White' }),             // name
      row({ name: 'Oil', weight: '1L' }),       // limit
    ]
    const d = diffProducts(before, after)
    expect(d).toMatchObject({ price: 1, name: 1, limit: 1, photo: 0, added: 0 })
    expect(d.touched).toBe(true)
  })

  it('treats an MRP change as a price change', () => {
    expect(diffProducts([row({ mrp: null })], [row({ mrp: 60 })]).price).toBe(1)
  })

  it('counts a photo arriving, changing, and being cleared', () => {
    expect(diffProducts([row({ image_url: '' })], [row()]).photo).toBe(1)
    expect(diffProducts([row()], [row({ image_url: 'https://cdn/other.png' })]).photo).toBe(1)
    expect(diffProducts([row()], [row({ image_url: '' })]).photo).toBe(1)
  })

  it('counts a badge gained but not one removed', () => {
    expect(diffProducts([{ ...row(), hasBadge: false }], [{ ...row(), badgeCount: 1 }]).specialTags).toBe(1)
    expect(diffProducts([{ ...row(), hasBadge: true }], [{ ...row(), badgeCount: 0 }]).specialTags).toBe(0)
    // Already had one, still has one — nothing was added.
    expect(diffProducts([{ ...row(), hasBadge: true }], [{ ...row(), badgeCount: 2 }]).specialTags).toBe(0)
  })

  it('counts a row that moved page, and ignores an absent page defaulting to 1', () => {
    expect(diffProducts([row({ page: 1 })], [row({ page: 2 })]).layout).toBe(1)
    expect(diffProducts([{ ...row(), page: undefined }], [row({ page: 1 })]).layout).toBe(0)
  })

  it('counts extra rows as additions, never as edits', () => {
    const d = diffProducts([row()], [row(), row({ name: 'New' }), row({ name: 'Also new' })])
    expect(d.added).toBe(2)
    expect(d.name).toBe(0)
  })

  it('does not count removed rows as anything', () => {
    const d = diffProducts([row(), row({ name: 'Sugar' })], [row()])
    expect(d.added).toBe(0)
    expect(d.name).toBe(0)
    expect(d.touched).toBe(false)
  })

  it('ignores whitespace-only differences', () => {
    expect(diffProducts([row({ name: 'Rice Ponni' })], [row({ name: '  Rice Ponni  ' })]).name).toBe(0)
  })

  it('is empty for a first save, where there is nothing to compare against', () => {
    const d = diffProducts([], [row(), row({ name: 'Sugar' })])
    expect(d.added).toBe(2)
    expect(d.name + d.price + d.photo + d.limit + d.specialTags + d.layout).toBe(0)
  })

  it('reports touched when the only change is an added row', () => {
    expect(diffProducts([row()], [row(), row({ name: 'New' })]).touched).toBe(true)
  })
})
