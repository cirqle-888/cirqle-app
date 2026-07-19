import { describe, expect, it } from 'vitest'
import { resolveDestinations, extractSheetId, type OfferGroup } from './routing'

const SHEET = 'https://docs.google.com/spreadsheets/d/1n1pEzbolP7RFYbjTQhB6OMlU6WVGB9DLO_PmeKjTzc/edit'
const SHEET_ID = '1n1pEzbolP7RFYbjTQhB6OMlU6WVGB9DLO_PmeKjTzc'
const GLOBAL = 'https://script.google.com/macros/s/AKfycb-shared/exec'
const LEGACY = 'https://script.google.com/macros/s/AKfycb-legacy/exec'
const SECRET = 'sharedsecret'

const product = (name: string, group_id: string | null = null) => ({ name, group_id, display_order: 0, page: 1 })

function group(over: Partial<OfferGroup> & { id: string; name: string }): OfferGroup {
  return { sheet_url: null, sheet_id: null, sheet_tab_name: null, apps_script_url: null, ...over }
}

describe('sync destination routing', () => {
  // The load-bearing guarantee of the whole categories feature: clients who
  // have no groups configured — every existing client — must resolve to the
  // exact single destination the pre-groups code produced.
  describe('clients with no groups behave exactly as before', () => {
    it('routes a legacy per-client webhook with an empty routePayload', () => {
      const products = [product('Rice'), product('Oil')]
      const res = resolveDestinations({
        client: { offer_sheet_webhook_url: LEGACY, offer_sheet_url: null },
        groups: [], products, globalWebhook: GLOBAL, sharedSecret: SECRET,
      })
      expect(res).toEqual({
        ok: true,
        destinations: [{ groupId: null, groupName: null, targetUrl: LEGACY, routePayload: {}, products }],
      })
    })

    it('routes the shared script with spreadsheetId + secret', () => {
      const products = [product('Rice')]
      const res = resolveDestinations({
        client: { offer_sheet_webhook_url: null, offer_sheet_url: SHEET },
        groups: [], products, globalWebhook: GLOBAL, sharedSecret: SECRET,
      })
      expect(res).toEqual({
        ok: true,
        destinations: [{
          groupId: null, groupName: null, targetUrl: GLOBAL,
          routePayload: { spreadsheetId: SHEET_ID, secret: SECRET }, products,
        }],
      })
    })

    it('prefers the legacy webhook over the shared script when both exist', () => {
      const res = resolveDestinations({
        client: { offer_sheet_webhook_url: LEGACY, offer_sheet_url: SHEET },
        groups: [], products: [product('Rice')], globalWebhook: GLOBAL, sharedSecret: SECRET,
      })
      expect(res.ok && res.destinations[0].targetUrl).toBe(LEGACY)
      expect(res.ok && res.destinations[0].routePayload).toEqual({})
    })

    it('keeps the original error messages', () => {
      const noSheet = resolveDestinations({
        client: { offer_sheet_webhook_url: null, offer_sheet_url: null },
        groups: [], products: [], globalWebhook: GLOBAL, sharedSecret: SECRET,
      })
      expect(noSheet).toEqual({ ok: false, error: expect.stringContaining('No Google Sheet linked') })

      const noScript = resolveDestinations({
        client: { offer_sheet_webhook_url: null, offer_sheet_url: null },
        groups: [], products: [], globalWebhook: '', sharedSecret: '',
      })
      expect(noScript).toEqual({ ok: false, error: expect.stringContaining('not set up yet') })

      const badLink = resolveDestinations({
        client: { offer_sheet_webhook_url: null, offer_sheet_url: 'https://example.com/nope' },
        groups: [], products: [], globalWebhook: GLOBAL, sharedSecret: SECRET,
      })
      expect(badLink).toEqual({ ok: false, error: expect.stringContaining('not a valid Google Sheets URL') })
    })
  })

  describe('grouped clients', () => {
    const groceries = group({ id: 'g1', name: 'Groceries', sheet_id: 'SHEET_G', sheet_tab_name: 'Offers' })
    const vegetables = group({ id: 'g2', name: 'Vegetables', sheet_id: 'SHEET_V' })

    it('sends each group only its own products, to its own spreadsheet', () => {
      const res = resolveDestinations({
        client: { offer_sheet_webhook_url: null, offer_sheet_url: SHEET },
        groups: [groceries, vegetables],
        products: [product('Rice', 'g1'), product('Tomato', 'g2'), product('Oil', 'g1')],
        globalWebhook: GLOBAL, sharedSecret: SECRET,
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.destinations).toHaveLength(2)

      const [g, v] = res.destinations
      expect(g.products.map(p => p.name)).toEqual(['Rice', 'Oil'])
      expect(g.routePayload).toEqual({ spreadsheetId: 'SHEET_G', secret: SECRET, sheetName: 'Offers' })
      expect(v.products.map(p => p.name)).toEqual(['Tomato'])
      expect(v.routePayload).toEqual({ spreadsheetId: 'SHEET_V', secret: SECRET })
    })

    it('lets a group override the script', () => {
      const custom = group({ id: 'g3', name: 'Bakery', apps_script_url: LEGACY })
      const res = resolveDestinations({
        client: { offer_sheet_webhook_url: null, offer_sheet_url: SHEET },
        groups: [custom], products: [product('Bun', 'g3')],
        globalWebhook: GLOBAL, sharedSecret: SECRET,
      })
      expect(res.ok && res.destinations[0].targetUrl).toBe(LEGACY)
    })

    it('skips groups with no products instead of blanking their sheet', () => {
      const res = resolveDestinations({
        client: { offer_sheet_webhook_url: null, offer_sheet_url: SHEET },
        groups: [groceries, vegetables], products: [product('Rice', 'g1')],
        globalWebhook: GLOBAL, sharedSecret: SECRET,
      })
      expect(res.ok && res.destinations.map(d => d.groupId)).toEqual(['g1'])
    })

    it('carries orphaned and ungrouped products into the first group', () => {
      const res = resolveDestinations({
        client: { offer_sheet_webhook_url: null, offer_sheet_url: SHEET },
        groups: [groceries, vegetables],
        products: [product('Tomato', 'g2'), product('Legacy', null), product('Deleted', 'gone')],
        globalWebhook: GLOBAL, sharedSecret: SECRET,
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      const first = res.destinations.find(d => d.groupId === 'g1')!
      expect(first.products.map(p => p.name)).toEqual(['Legacy', 'Deleted'])
    })

    it('refuses to route several sheetless groups through one bound script', () => {
      // That script writes to the single sheet it lives in, so each group would
      // silently overwrite the previous one.
      const res = resolveDestinations({
        client: { offer_sheet_webhook_url: LEGACY, offer_sheet_url: null },
        groups: [group({ id: 'a', name: 'Groceries' }), group({ id: 'b', name: 'Vegetables' })],
        products: [product('Rice', 'a'), product('Tomato', 'b')],
        globalWebhook: '', sharedSecret: '',
      })
      expect(res).toEqual({ ok: false, error: expect.stringContaining('overwrite each other') })
    })

    it('reports which category is misconfigured', () => {
      const res = resolveDestinations({
        client: { offer_sheet_webhook_url: null, offer_sheet_url: null },
        groups: [group({ id: 'g9', name: 'Vegetables' })],
        products: [product('Tomato', 'g9')],
        globalWebhook: '', sharedSecret: '',
      })
      expect(res).toEqual({ ok: false, error: expect.stringContaining('Vegetables') })
    })
  })
})

describe('extractSheetId', () => {
  it('accepts full links, sharing links and raw ids', () => {
    expect(extractSheetId(SHEET)).toBe(SHEET_ID)
    expect(extractSheetId(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing`)).toBe(SHEET_ID)
    expect(extractSheetId(SHEET_ID)).toBe(SHEET_ID)
    expect(extractSheetId('https://example.com')).toBeNull()
    expect(extractSheetId(null)).toBeNull()
  })
})
