import { describe, it, expect } from 'vitest'
import { splitOfferSections, summariseSections } from './offer-sections'

/**
 * Fixtures are real Sea Star messages (Sea Star@Cirqle, 25 Jul 2026), kept
 * verbatim — blank lines, double spaces and all — because those irregularities
 * are exactly what the parser has to survive.
 */

const SUNDAY_100GM = `Sunday 100gm

Cashew 240  93
Cashew 320  90
Cashew Rosted 93
Pista 149
Badam 99
Kismiss Black Seed  49
Cherry  19
Tutty Frutty  10`

const WEIGHT_THEN_DAY = `1kg

Sunday


Avil  59
Sharkkara 53
Maida 42
Rice Noorjahan 39
Rice Jaya 48`

const DAY_THEN_WEIGHT = `Sunday

500gm


Rusk Brown 59
Rusk Yellow 74
Chips 129
Obc Biscuits 68`

const WITH_PAGE_HINTS = `${SUNDAY_100GM}

Sunday 3 page
Monday 2 page`

describe('splitOfferSections', () => {
  it('applies a combined "Sunday 100gm" header to every product below it', () => {
    const r = splitOfferSections(SUNDAY_100GM)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].day).toBe('Sunday')
    expect(r.sections[0].weight).toBe('100gm')
    expect(r.sections[0].lines).toHaveLength(8)
    expect(r.sections[0].lines[0]).toBe('Cashew 240  93')
  })

  it('accepts weight-then-day order with blank lines between', () => {
    const r = splitOfferSections(WEIGHT_THEN_DAY)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].weight).toBe('1kg')
    expect(r.sections[0].day).toBe('Sunday')
    expect(r.sections[0].lines).toHaveLength(5)
  })

  it('accepts day-then-weight order', () => {
    const r = splitOfferSections(DAY_THEN_WEIGHT)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].day).toBe('Sunday')
    expect(r.sections[0].weight).toBe('500gm')
  })

  it('starts a new section when the pack size changes mid-message', () => {
    const r = splitOfferSections(`Sunday 100gm\nCashew 93\n\n1kg\nAvil 59\nMaida 42`)
    expect(r.sections).toHaveLength(2)
    expect(r.sections[0]).toMatchObject({ day: 'Sunday', weight: '100gm' })
    expect(r.sections[1]).toMatchObject({ day: 'Sunday', weight: '1kg' })
    expect(r.sections[1].lines).toEqual(['Avil 59', 'Maida 42'])
  })

  it('splits a two-day message into separate days', () => {
    const r = splitOfferSections(`Sunday\n500gm\nRusk 59\n\nMonday\n1kg\nRice 48`)
    expect(r.sections).toHaveLength(2)
    expect(r.sections[0].day).toBe('Sunday')
    expect(r.sections[1].day).toBe('Monday')
    expect(r.days).toEqual(['Sunday', 'Monday'])
  })

  it('captures page hints without treating them as products', () => {
    const r = splitOfferSections(WITH_PAGE_HINTS)
    expect(r.pageHints).toEqual([
      { day: 'Sunday', pages: 3 },
      { day: 'Monday', pages: 2 },
    ])
    // The hint lines must never reach the product parser.
    expect(r.sections.flatMap(s => s.lines).join('\n')).not.toMatch(/page/i)
  })

  it('never mistakes a product priced like a weight for a header', () => {
    // "Chips 129" and "Cherry  19" have trailing numbers but no unit.
    const r = splitOfferSections(DAY_THEN_WEIGHT)
    expect(r.sections[0].lines).toContain('Chips 129')
  })

  it('normalises pack-size spellings so one flyer prints them consistently', () => {
    const r = splitOfferSections(`500 GMS\nA 1\n\n500g\nB 2\n\n2 Ltr\nC 3`)
    expect(r.sections.map(s => s.weight)).toEqual(['500gm', '500gm', '2ltr'])
  })

  it('keeps products that arrive before any header (weight/day null)', () => {
    const r = splitOfferSections(`Cashew 93\nPista 149`)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0]).toMatchObject({ day: null, weight: null })
    expect(r.sections[0].lines).toHaveLength(2)
  })

  it('produces no empty sections from consecutive headers', () => {
    const r = splitOfferSections(`Sunday\n\n500gm\n\nRusk 59`)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].lines).toEqual(['Rusk 59'])
  })

  it('summarises what a paste contains', () => {
    const s = summariseSections(splitOfferSections(WITH_PAGE_HINTS))
    expect(s).toContain('8 product lines')
    expect(s).toContain('days: Sunday, Monday')
    expect(s).toContain('packs: 100gm')
    expect(s).toContain('Sunday=3')
  })
})
