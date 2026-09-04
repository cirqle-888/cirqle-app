import { describe, it, expect } from 'vitest'
import { suggestEntryDescription } from './describe-entry'

describe('suggestEntryDescription', () => {
  it('names the invoices a receipt settles', () => {
    expect(suggestEntryDescription({
      invoiceNumbers: ['INV-2609-034'], clientName: 'Auto Plus Spare Parts',
    })).toBe('Payment for INV-2609-034 — Auto Plus Spare Parts')

    expect(suggestEntryDescription({
      invoiceNumbers: ['INV-2606-039', 'INV-2607-039'], clientName: 'Sea Star Catering and Hotel',
    })).toBe('Payment for INV-2606-039, INV-2607-039 — Sea Star Catering and Hotel')
  })

  it('describes a client cost as what it was, and who for', () => {
    expect(suggestEntryDescription({
      categoryName: 'Printing & Stationery', clientName: 'Sea Star Caters',
    })).toBe('Printing & Stationery for Sea Star Caters')
  })

  it('prefers tags when they say more than the category does', () => {
    expect(suggestEntryDescription({
      categoryName: 'Software', tags: ['Photoshop', 'Canva'], clientName: 'Hiba Hypermarket',
    })).toBe('Photoshop and Canva for Hiba Hypermarket')
  })

  it('ignores tags that only restate the category or the client link', () => {
    // "Printing Cost" adds nothing to "Printing & Stationery"; "For Client" is
    // already recorded by the client field itself.
    expect(suggestEntryDescription({
      categoryName: 'Printing & Stationery', tags: ['Printing Cost', 'For Client'], clientName: 'Sea Star Caters',
    })).toBe('Printing & Stationery for Sea Star Caters')
  })

  it('falls back to the category when the tag list is too long to be a name', () => {
    expect(suggestEntryDescription({
      categoryName: 'Marketing & Promotions', clientName: 'RG Group',
      tags: ['Reimbursement', 'Marketing', 'Food', 'Fuel', 'Parking Fee', 'Travel'],
    })).toBe('Marketing & Promotions for RG Group')
  })

  it('names the employee on a salary entry', () => {
    expect(suggestEntryDescription({ categoryName: 'Salary', employeeName: 'CQID004' }))
      .toBe('Salary — CQID004')
  })

  it('says nothing when only a category is known', () => {
    // The entry already shows its category — repeating it is not a description.
    expect(suggestEntryDescription({ categoryName: 'Printing & Stationery' })).toBe('')
    expect(suggestEntryDescription({})).toBe('')
  })

  it('an invoice payment outranks every other clue', () => {
    expect(suggestEntryDescription({
      invoiceNumbers: ['INV-1'], clientName: 'X', categoryName: 'Invoice', tags: ['a'], employeeName: 'Y',
    })).toBe('Payment for INV-1 — X')
  })

  it('tolerates blanks and whitespace without producing a ragged sentence', () => {
    expect(suggestEntryDescription({ clientName: '  ', categoryName: '  ' })).toBe('')
    expect(suggestEntryDescription({ clientName: 'Acme', categoryName: '' })).toBe('Expense for Acme')
  })
})
