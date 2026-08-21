import { describe, it, expect } from 'vitest'
import { normalizeTaskTitle, toTitleCase, cleanTitle } from './title-case'

describe('normalizeTaskTitle', () => {
  it('title-cases an ordinary title', () => {
    expect(normalizeTaskTitle('onam offer')).toBe('Onam Offer')
  })

  it('fixes shouting', () => {
    expect(normalizeTaskTitle('MIDNIGHT SALE FLYER')).toBe('MIDNIGHT SALE FLYER')
    expect(normalizeTaskTitle('midnight sale')).toBe('Midnight Sale')
  })

  it('collapses whitespace and tidies dashes', () => {
    expect(normalizeTaskTitle('  onam   offer –poster ')).toBe('Onam Offer – Poster')
  })

  it('returns empty string for blank input rather than throwing', () => {
    expect(normalizeTaskTitle('')).toBe('')
    expect(normalizeTaskTitle('   ')).toBe('')
    expect(normalizeTaskTitle(null)).toBe('')
    expect(normalizeTaskTitle(undefined)).toBe('')
  })
})

describe('scripts without case', () => {
  // These are real titles from the task list. Getting this wrong corrupts them.
  it('leaves a Malayalam word untouched and cases the Latin words around it', () => {
    expect(normalizeTaskTitle('ഓണം bumper sale')).toBe('ഓണം Bumper Sale')
  })

  it('leaves an all-Malayalam title completely alone', () => {
    expect(normalizeTaskTitle('ഹാപ്പിയുടെ ഓണാസമ്മാനം')).toBe('ഹാപ്പിയുടെ ഓണാസമ്മാനം')
  })

  it('handles a Malayalam word in the small-word position', () => {
    expect(normalizeTaskTitle('ഓണം shopping fest')).toBe('ഓണം Shopping Fest')
  })
})

describe('things that must not be "corrected"', () => {
  it('keeps acronyms and format codes', () => {
    expect(normalizeTaskTitle('a3 offer flyer')).toBe('A3 Offer Flyer')
    expect(normalizeTaskTitle('A3 Offer Flyer')).toBe('A3 Offer Flyer')
    expect(normalizeTaskTitle('CQID report')).toBe('CQID Report')
  })

  it('keeps deliberate internal capitals — a brand is not a typo', () => {
    expect(normalizeTaskTitle('iPhone launch poster')).toBe('iPhone Launch Poster')
    expect(normalizeTaskTitle('eBay banner')).toBe('eBay Banner')
    expect(normalizeTaskTitle("McDonald's menu")).toBe("McDonald's Menu")
  })

  it('keeps a size code mid-title', () => {
    expect(normalizeTaskTitle('convert to A4')).toBe('Convert to A4')
  })
})

describe('small words', () => {
  it('lowercases joiners inside the title', () => {
    expect(normalizeTaskTitle('the magic of the east in every spray'))
      .toBe('The Magic of the East in Every Spray')
  })

  it('capitalises the first word even when it is a joiner', () => {
    expect(normalizeTaskTitle('the sacred essence')).toBe('The Sacred Essence')
  })

  it('keeps a joiner lowercase at the END too', () => {
    expect(normalizeTaskTitle('best deals for')).toBe('Best Deals for')
  })

  it('keeps a joiner lowercase before a trailing code', () => {
    expect(normalizeTaskTitle('onam offer convert to A4')).toBe('Onam Offer Convert to A4')
  })

  it('lowercases every joiner in the set', () => {
    expect(normalizeTaskTitle('poster for the client of a brand with logo in store'))
      .toBe('Poster for the Client of a Brand with Logo in Store')
  })
})

describe('idempotence', () => {
  // Titles are normalised on create and could be normalised again on edit;
  // a second pass must be a no-op or the text drifts.
  const cases = [
    'Onam Offer', 'ഓണം Bumper Sale', 'iPhone Launch Poster',
    'A3 Offer Flyer', 'The Magic of the East in Every Spray', 'Best Deals for',
  ]
  for (const c of cases) {
    it(`is stable for "${c}"`, () => {
      expect(normalizeTaskTitle(c)).toBe(c)
      expect(normalizeTaskTitle(normalizeTaskTitle(c))).toBe(normalizeTaskTitle(c))
    })
  }
})

describe('cleanTitle / toTitleCase are usable on their own', () => {
  it('cleanTitle only tidies, never cases', () => {
    expect(cleanTitle('  onam   offer ')).toBe('onam offer')
  })

  it('toTitleCase only cases, never tidies', () => {
    expect(toTitleCase('onam offer')).toBe('Onam Offer')
  })
})
