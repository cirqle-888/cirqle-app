import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/ownership/engine', () => ({ loadAwardsForPayslip: async () => [] }))
vi.mock('@/lib/settings/company-settings', () => ({ getCompanySettings: async () => ({}) }))
import { companyFromSettings } from './build-payslip'

describe('companyFromSettings', () => {
  it('uses what is saved in Settings → Company', () => {
    expect(companyFromSettings({ company_name: 'Cirqle Works', company_email: 'team@cirqle.work', company_phone: '+918301839488', company_website: 'https://www.cirqle.work' }))
      .toEqual({ name: 'Cirqle Works', email: 'team@cirqle.work', phone: '+918301839488', website: 'www.cirqle.work' })
  })
  it('falls back per field, never printing "undefined" or a blank', () => {
    const c = companyFromSettings({ company_phone: '   ' })
    expect(c.phone).toBe('+91 81295 34377')
    expect(c.name).toBe('Cirqle Works')
  })
})
