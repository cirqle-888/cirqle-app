import { describe, it, expect } from 'vitest'
import { brandForInvoice, brandKey, brandOf, normalizeHex, parseBrandIdentities, slugify, sortBrands, type Brand, type BrandInvoiceIdentity } from './brands'
import { computeBrandPnl } from './pnl'

const brand = (o: Partial<Brand>): Brand => ({
  id: 'x', name: 'X', slug: 'x', tagline: null, color: null, logo_url: null, whatsapp_number: null, website: null,
  is_default: false, is_active: true, show_on_invoices: false, display_order: 0, ...o,
})

const works = brand({ id: 'works', name: 'Cirqle Works', slug: 'cirqle-works', is_default: true, display_order: 0 })
const flyers = brand({ id: 'flyers', name: 'Cirqle Flyers', slug: 'cirqle-flyers', display_order: 1 })
const memoura = brand({ id: 'memoura', name: 'Memoura', slug: 'memoura', display_order: 2 })
const brands = [works, flyers, memoura]

describe('brand resolution', () => {
  it('reads NULL as the default brand', () => {
    expect(brandOf(null, brands)?.id).toBe('works')
    expect(brandKey(undefined, brands)).toBe('works')
  })
  it('keeps an explicit brand, and falls back for an unknown id', () => {
    expect(brandOf('memoura', brands)?.id).toBe('memoura')
    expect(brandOf('gone', brands)?.id).toBe('works')
  })
  it('has no brand at all when none exist', () => {
    expect(brandOf(null, [])).toBeNull()
  })
  it('sorts by display order, default first among equals', () => {
    const b = [brand({ id: 'b', name: 'B', display_order: 1 }), brand({ id: 'a', name: 'A', display_order: 1, is_default: true })]
    expect(sortBrands(b).map(x => x.id)).toEqual(['a', 'b'])
  })
})

describe('slugify / normalizeHex', () => {
  it('makes url-safe slugs', () => {
    expect(slugify('Cirqle Flyers')).toBe('cirqle-flyers')
    expect(slugify('  Mémoura & Co. ')).toBe('memoura-co')
    expect(slugify('!!!')).toBe('brand')
  })
  it('accepts only real hex colours', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('#7C3AED')).toBe('#7c3aed')
    expect(normalizeHex('purple')).toBeNull()
  })
})

describe('brandForInvoice', () => {
  const ids: BrandInvoiceIdentity[] = [
    { name: 'Cirqle Flyers', tagline: null, logoUrl: null, whatsapp: '+91 1', serviceIds: ['svc-flyer'], serviceNames: ['offer flyer'] },
    { name: 'Memoura', tagline: null, logoUrl: null, whatsapp: null, serviceIds: ['svc-gift'], serviceNames: ['photo gift'] },
  ]
  it('brands an invoice whose every line is one brand', () => {
    expect(brandForInvoice([{ service: { id: 'svc-flyer' } }, { task: { service: { name: 'Offer Flyer' } } }], ids)?.name).toBe('Cirqle Flyers')
  })
  it('stays plain for a mixed invoice', () => {
    expect(brandForInvoice([{ service: { id: 'svc-flyer' } }, { service: { id: 'svc-gift' } }], ids)).toBeNull()
  })
  it('stays plain when any line belongs to no printing brand', () => {
    expect(brandForInvoice([{ service: { id: 'svc-flyer' } }, { service: { id: 'svc-logo', name: 'Logo Design' } }], ids)).toBeNull()
  })
  it('ignores lines with no service (expenses) but needs at least one vote', () => {
    expect(brandForInvoice([{ service: { id: 'svc-gift' } }, {}], ids)?.name).toBe('Memoura')
    expect(brandForInvoice([{}], ids)).toBeNull()
  })
  it('parses the cached identities defensively', () => {
    expect(parseBrandIdentities('not json')).toEqual([])
    expect(parseBrandIdentities(JSON.stringify(ids))).toHaveLength(2)
  })
})

describe('computeBrandPnl', () => {
  const base = {
    brands,
    serviceBrand: new Map<string, string | null>([['svc-flyer', 'flyers'], ['svc-logo', null]]),
    earningsByTask: new Map<string, number>([['t1', 100], ['t3', 50]]),
    campaigns: [
      { id: 'c1', client_id: null, brand_id: 'memoura' },
      { id: 'c2', client_id: 'client-1', brand_id: null },   // client campaign: never a brand cost
    ],
    spendByCampaign: new Map([['c1', 1000], ['c2', 9999]]),
    entries: [
      { id: 'e1', type: 'outflow', amount_inr: 300, brand_id: 'memoura', scope: 'company' },
      { id: 'e2', type: 'inflow', amount_inr: 2000, brand_id: 'memoura', scope: 'company' },
      { id: 'e3', type: 'outflow', amount_inr: 5000, brand_id: 'memoura', scope: 'company' },   // wallet top-up
      { id: 'e4', type: 'outflow', amount_inr: 70, brand_id: 'flyers', scope: 'client', client_id: 'k' },
    ],
    walletFundingEntryIds: new Set(['e3']),
  }

  it('puts client revenue on the brand that sells the service, and labour with it', () => {
    const rows = computeBrandPnl({
      ...base,
      tasks: [
        { id: 't1', client_id: 'k', service_id: 'svc-flyer', billing_amount_inr: 1500 },
        { id: 't2', client_id: 'k', service_id: 'svc-logo', billing_amount_inr: 4000 },
        { id: 't3', client_id: 'k', service_id: 'svc-flyer', billing_amount_inr: 800, is_billable: false },
        { id: 't4', client_id: null, service_id: 'svc-flyer', billing_amount_inr: 0 },
      ],
    })
    const f = rows.find(r => r.brandId === 'flyers')!
    const w = rows.find(r => r.brandId === 'works')!
    expect(f.revenueInr).toBe(1500)            // waived t3 earns nothing…
    expect(f.directLabourInr).toBe(150)        // …but its labour still counts
    expect(f.billedTasks).toBe(1)
    expect(w.revenueInr).toBe(4000)            // unbranded service → default brand
    expect(f.brandExpensesInr).toBe(0)         // client-scoped entry ignored
  })

  it('charges company ad spend with GST and tagged cash-book lines, skipping wallet top-ups', () => {
    const m = computeBrandPnl({ ...base, tasks: [] }).find(r => r.brandId === 'memoura')!
    expect(m.adSpendInr).toBe(1180)
    expect(m.brandExpensesInr).toBe(300)
    expect(m.otherIncomeInr).toBe(2000)
    expect(m.resultInr).toBe(2000 - 1180 - 300)
  })

  it('gives every brand a row, even an empty one', () => {
    expect(computeBrandPnl({ ...base, tasks: [], campaigns: [], entries: [] }).map(r => r.brandId).sort())
      .toEqual(['flyers', 'memoura', 'works'])
  })
})
