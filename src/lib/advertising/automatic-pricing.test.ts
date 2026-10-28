import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { advertisingRate, campaignBillingIsLocked, resolveAutomaticAdvertisingRate } from './automatic-pricing'

function db(results: Record<string, { data: unknown; error?: unknown }>) {
  return { from(table: string) {
    const result = { error: null, ...results[table] }
    const query = { select: () => query, eq: () => query, maybeSingle: async () => result,
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve) }
    return query
  } } as unknown as SupabaseClient
}

describe('automatic advertising pricing', () => {
  it('uses Mezza 30%, preserving other clients 75% and explicit free rates', () => {
    expect(advertisingRate('ad', 30, 30)?.value).toBe(30)
    expect(advertisingRate('ad', 30, 75)?.value).toBe(75)
    expect(advertisingRate('ad', 30, 0)?.value).toBe(0)
    expect(advertisingRate('ad', 30, null)?.value).toBe(30)
  })
  it('does not silently interpret missing or invalid rates as free', () => {
    for (const value of [null, undefined, '', -1, 'invalid', Infinity]) {
      expect(advertisingRate('ad', value, null)).toBeNull()
    }
  })
  it('loads client-specific pricing from the configured service', async () => {
    const admin = db({ services: { data: { id: 'ad', default_price: 30 } }, client_service_pricing: { data: { price: 75 } } })
    expect(await resolveAutomaticAdvertisingRate(admin, 'client')).toEqual({ serviceId: 'ad', type: 'percent', value: 75 })
  })
  it('does not fall back to a default when the client pricing query fails', async () => {
    const admin = db({ services: { data: { id: 'ad', default_price: 30 } }, client_service_pricing: { data: null, error: { message: 'offline' } } })
    await expect(resolveAutomaticAdvertisingRate(admin, 'client')).rejects.toThrow('offline')
  })
  it('allows draft billing but locks sent, paid and reviewed invoices', async () => {
    for (const status of ['draft', 'sent', 'paid', 'reviewed']) {
      const admin = db({ invoices: { data: [] }, invoice_items: { data: [{ invoice: { status } }] } })
      expect(await campaignBillingIsLocked(admin, 'project', 'task')).toBe(status !== 'draft')
    }
  })
  it('locks campaign invoices and fails closed on unreadable history', async () => {
    expect(await campaignBillingIsLocked(db({ invoices: { data: [{ status: 'paid' }] } }), 'p')).toBe(true)
    expect(await campaignBillingIsLocked(db({ invoices: { data: null, error: 'offline' } }), 'p')).toBe(true)
  })
})
