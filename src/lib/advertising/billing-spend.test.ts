import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./ad-spend-invoicing', () => ({ getSpendBasis: vi.fn(), isDuplicateCampaignProject: vi.fn() }))
import { getSpendBasis } from './ad-spend-invoicing'
import { getBillingBasisNative } from './billing'
import { computeServiceCharge, spendWithGst } from './budget'
const project = { id: 'campaign', ad_account_id: null, provider_metadata: null }
describe('actual-spend service fee', () => {
  beforeEach(() => vi.clearAllMocks())
  it('does not charge against the ₹800 top-up before spending', async () => {
    vi.mocked(getSpendBasis).mockResolvedValue({ hasSpend: false, spendExGstInr: 0, spendInclGstInr: 0 })
    const admin = { from: vi.fn() } as unknown as SupabaseClient
    const basis = await getBillingBasisNative(admin, project, 'INR')
    expect(computeServiceCharge(basis, 'percent', 30)).toBe(0)
    expect(admin.from).not.toHaveBeenCalled()
  })
  it('uses gross actual spend once, without taxing funding or gross spend again', async () => {
    vi.mocked(getSpendBasis).mockResolvedValue({ hasSpend: true, spendExGstInr: 677.97, spendInclGstInr: 800 })
    const basis = await getBillingBasisNative({} as unknown as SupabaseClient, project, 'INR')
    expect(basis).toBe(800)
    expect(computeServiceCharge(basis, 'percent', 30)).toBe(240)
    expect(spendWithGst(677.97)).toBe(800)
  })
  it('updates the charge as actual spending changes', async () => {
    vi.mocked(getSpendBasis).mockResolvedValue({ hasSpend: true, spendExGstInr: 712.69, spendInclGstInr: 840.97 })
    expect(computeServiceCharge(await getBillingBasisNative({} as unknown as SupabaseClient, project, 'INR'), 'percent', 30)).toBe(252.29)
  })
})
