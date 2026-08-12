import { describe, it, expect } from 'vitest'

/**
 * Work value gets its own currency (migration 20260812100000).
 *
 * Work value pays the TEAM; the item's `currency` bills the CLIENT. Tying them
 * together forced an INR-paying agency to express team pay in AED, and the
 * rupee figure then moved with the exchange rate — the same AED 20 stamped
 * ₹518.09 on one task and ₹518.71 on another.
 *
 * These tests pin the resolution rule the DB stamp implements as
 * `COALESCE(work_unit_currency, currency)`, so a future edit to either side
 * cannot silently reinterpret existing agreements.
 */

/** Mirror of the SQL: COALESCE(work_unit_currency, currency). */
const resolveWorkCurrency = (
  item: { currency: string; work_unit_currency?: string | null },
): string => item.work_unit_currency || item.currency

/** Mirror of the stamp: value × qty × fx(resolved currency). */
const stampInr = (
  item: { currency: string; work_unit_currency?: string | null; work_unit_value: number | null },
  quantity: number,
  fx: Record<string, number>,
): number | null => {
  if (item.work_unit_value == null) return null
  const cur = resolveWorkCurrency(item)
  return Math.round(item.work_unit_value * quantity * (fx[cur] ?? 1) * 100) / 100
}

const FX = { INR: 1, AED: 25.94 }

describe('work-value currency resolution', () => {
  it('BACK-COMPAT: a legacy item (no work currency) still converts from its billing currency', () => {
    // Every one of the 8 existing work values is this shape. Behaviour must be
    // byte-identical to before the migration.
    const legacy = { currency: 'AED', work_unit_currency: null, work_unit_value: 75 }
    expect(resolveWorkCurrency(legacy)).toBe('AED')
    expect(stampInr(legacy, 1, FX)).toBe(1945.5)
  })

  it('an INR work value is stamped exactly as typed', () => {
    const item = { currency: 'AED', work_unit_currency: 'INR', work_unit_value: 1945.5 }
    expect(stampInr(item, 1, FX)).toBe(1945.5)
  })

  it('an INR work value does NOT drift when the exchange rate moves', () => {
    const item = { currency: 'AED', work_unit_currency: 'INR', work_unit_value: 500 }
    const before = stampInr(item, 1, { INR: 1, AED: 25.94 })
    const after = stampInr(item, 1, { INR: 1, AED: 26.71 })   // AED strengthens
    expect(before).toBe(500)
    expect(after).toBe(500)
    expect(after).toBe(before)
  })

  it('a legacy AED work value DOES drift — the behaviour this change escapes', () => {
    const legacy = { currency: 'AED', work_unit_currency: null, work_unit_value: 20 }
    const before = stampInr(legacy, 1, { INR: 1, AED: 25.9045 })
    const after = stampInr(legacy, 1, { INR: 1, AED: 25.9355 })
    expect(before).not.toBe(after)          // 518.09 vs 518.71, as seen live
  })

  it('quantity multiplies the work value in either currency', () => {
    const inr = { currency: 'AED', work_unit_currency: 'INR', work_unit_value: 500 }
    expect(stampInr(inr, 3, FX)).toBe(1500)
    const aed = { currency: 'AED', work_unit_currency: null, work_unit_value: 20 }
    expect(stampInr(aed, 2, FX)).toBe(1037.6)
  })

  it('no work value set stays null regardless of currency', () => {
    expect(stampInr({ currency: 'AED', work_unit_currency: 'INR', work_unit_value: null }, 1, FX)).toBeNull()
  })

  it('an explicit currency equal to the billing currency behaves like legacy', () => {
    const explicit = { currency: 'AED', work_unit_currency: 'AED', work_unit_value: 75 }
    const legacy = { currency: 'AED', work_unit_currency: null, work_unit_value: 75 }
    expect(stampInr(explicit, 1, FX)).toBe(stampInr(legacy, 1, FX))
  })
})
