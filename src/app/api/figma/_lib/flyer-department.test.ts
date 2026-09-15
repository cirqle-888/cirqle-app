import { describe, it, expect } from 'vitest'
import { offerFlyerDepartment, resolveFlyerService } from './flyer-department'

/**
 * The offer-flyer department is found by matching a CATEGORY NAME that anyone
 * can edit in Settings → Services. These tests pin the two behaviours that
 * makes acceptable:
 *
 *   · a rename never empties the dropdowns (fail open), and
 *   · a rename never passes silently (`matched: false` + a reason a person
 *     can act on).
 *
 * And the one it makes necessary: a service id from outside the department is
 * substituted rather than trusted, so a supermarket flyer cannot be filed as
 * "Video Editing" by a stale client.
 */

interface Fixture {
  categories?: { id: string; name: string }[]
  services?: { id: string; name: string; category_id: string; is_active?: boolean }[]
  settings?: Record<string, string>
}

const OFFER_FLYERS = { id: 'cat-flyers', name: 'Offer Flyers' }
const VIDEO = { id: 'cat-video', name: 'Video' }

const DEFAULT_FIXTURE: Required<Fixture> = {
  categories: [OFFER_FLYERS, VIDEO],
  services: [
    { id: 'svc-offer-flyer', name: 'Offer Flyer', category_id: OFFER_FLYERS.id },
    { id: 'svc-a3', name: 'A3 Offer Flyer', category_id: OFFER_FLYERS.id },
    { id: 'svc-updating', name: 'Offer Flyer Updating', category_id: OFFER_FLYERS.id },
    { id: 'svc-revised', name: 'Revised Offer Flyer', category_id: OFFER_FLYERS.id },
    { id: 'svc-extra', name: 'Extra Design on Offer Flyer', category_id: OFFER_FLYERS.id },
    { id: 'svc-video', name: 'Video Editing', category_id: VIDEO.id },
  ],
  settings: {},
}

/** A stand-in for the service-role client: the three tables this reads. */
function fakeAdmin(fixture: Fixture = {}) {
  const f = { ...DEFAULT_FIXTURE, ...fixture }
  const active = f.services.filter(s => s.is_active !== false)

  const chain = (rows: unknown[]) => {
    const self: Record<string, unknown> = {}
    const step = () => self
    self.eq = step
    self.in = step
    self.order = step
    self.limit = step
    self.maybeSingle = async () => ({ data: (rows as unknown[])[0] ?? null })
    // Awaiting the builder itself is how the route reads a list.
    self.then = (resolve: (v: { data: unknown[] }) => unknown) => resolve({ data: rows })
    return self
  }

  return {
    from(table: string) {
      if (table === 'company_settings') {
        return {
          select: () => ({
            eq: (_c: string, key: string) => ({
              maybeSingle: async () => ({
                data: f.settings[key] ? { value: f.settings[key] } : null,
              }),
            }),
          }),
        }
      }
      if (table === 'service_categories') {
        return {
          select: () => ({
            eq: (_c: string, name: string) => chain(f.categories.filter(c => c.name === name)),
          }),
        }
      }
      if (table === 'services') {
        return {
          select: () => ({
            eq: () => ({
              in: (_c: string, ids: string[]) => chain(active.filter(s => ids.includes(s.category_id))),
              ilike: (_c: string, pattern: string) => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: active.find(s => s.name.toLowerCase() === pattern.toLowerCase()) ?? null,
                  }),
                }),
              }),
            }),
          }),
        }
      }
      throw new Error('unexpected table ' + table)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('offerFlyerDepartment', () => {
  it('returns only the category\'s services, with the default flagged', async () => {
    const d = await offerFlyerDepartment(fakeAdmin())
    expect(d.matched).toBe(true)
    expect(d.services.map(s => s.name)).toEqual([
      'Offer Flyer', 'A3 Offer Flyer', 'Offer Flyer Updating', 'Revised Offer Flyer',
      'Extra Design on Offer Flyer',
    ])
    expect(d.services.map(s => s.name)).not.toContain('Video Editing')
    expect(d.defaultServiceId).toBe('svc-offer-flyer')
    expect(d.services.find(s => s.isDefault)?.id).toBe('svc-offer-flyer')
  })

  it('fails open with a reason when the category has been renamed', async () => {
    const d = await offerFlyerDepartment(fakeAdmin({ categories: [{ id: 'c', name: 'Flyers' }, VIDEO] }))
    expect(d.matched).toBe(false)
    expect(d.serviceIds).toEqual([])
    expect(d.reason).toContain('Offer Flyers')
    expect(d.reason).toContain('offer_flyer_category')
  })

  it('follows the workspace\'s own category name when one is configured', async () => {
    const admin = fakeAdmin({
      categories: [{ id: 'cat-flyers', name: 'Supermarket Flyers' }],
      settings: { offer_flyer_category: 'Supermarket Flyers' },
    })
    const d = await offerFlyerDepartment(admin)
    expect(d.matched).toBe(true)
    expect(d.categoryName).toBe('Supermarket Flyers')
  })

  it('says so when the department has no "Offer Flyer" to default to', async () => {
    const admin = fakeAdmin({
      services: [{ id: 'svc-a3', name: 'A3 Offer Flyer', category_id: OFFER_FLYERS.id }],
    })
    const d = await offerFlyerDepartment(admin)
    expect(d.matched).toBe(true)
    expect(d.defaultServiceId).toBeNull()
    expect(d.reason).toContain('no service on its task')
  })

  it('ignores archived services', async () => {
    const admin = fakeAdmin({
      services: [
        { id: 'svc-offer-flyer', name: 'Offer Flyer', category_id: OFFER_FLYERS.id },
        { id: 'svc-old', name: 'Old Flyer', category_id: OFFER_FLYERS.id, is_active: false },
      ],
    })
    const d = await offerFlyerDepartment(admin)
    expect(d.services.map(s => s.id)).toEqual(['svc-offer-flyer'])
  })
})

describe('resolveFlyerService', () => {
  it('keeps a service that really is in the department', async () => {
    const r = await resolveFlyerService(fakeAdmin(), 'svc-updating')
    expect(r.serviceId).toBe('svc-updating')
    expect(r.substituted).toBe(false)
  })

  it('substitutes the default for a service from another department', async () => {
    const r = await resolveFlyerService(fakeAdmin(), 'svc-video')
    expect(r.serviceId).toBe('svc-offer-flyer')
    expect(r.substituted).toBe(true)
  })

  it('substitutes the default for a stale or unknown id', async () => {
    const r = await resolveFlyerService(fakeAdmin(), 'svc-deleted-last-year')
    expect(r.serviceId).toBe('svc-offer-flyer')
    expect(r.substituted).toBe(true)
  })

  it('defaults to "Offer Flyer" when nothing was asked for', async () => {
    const r = await resolveFlyerService(fakeAdmin(), null)
    expect(r.serviceId).toBe('svc-offer-flyer')
    expect(r.substituted).toBe(false)
  })

  it('trusts the caller when the department cannot be resolved at all', async () => {
    // Nothing to check membership against — dropping the choice would be worse.
    const admin = fakeAdmin({ categories: [VIDEO] })
    const r = await resolveFlyerService(admin, 'svc-updating')
    expect(r.serviceId).toBe('svc-updating')
    expect(r.substituted).toBe(false)
  })

  it('falls back to the workspace-wide "Offer Flyer" when there is no department', async () => {
    const admin = fakeAdmin({ categories: [VIDEO] })
    const r = await resolveFlyerService(admin, null)
    expect(r.serviceId).toBe('svc-offer-flyer')
  })
})
