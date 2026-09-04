/**
 * What a Cash Book entry should be called, before anyone types.
 *
 * Description is the line every later screen shows — the Cash Book list, the
 * expense line on a client's invoice, a P&L drilldown. It is the one field
 * that has to read like a sentence a person wrote, and it was the one field
 * the form asked for last and offered no help with.
 *
 * These are SUGGESTIONS. The rule everywhere they are used: propose while the
 * field is untouched, and never overwrite a word the user typed.
 */

export interface DescribeInput {
  /** Invoice numbers this receipt settles, in order. */
  invoiceNumbers?: string[]
  /** Client on the invoice, or tagged on the entry. */
  clientName?: string | null
  /** Cash Book category name, e.g. "Printing & Stationery". */
  categoryName?: string | null
  /** Free-form spend tags already picked, e.g. ["Printing Cost", "For Client"]. */
  tags?: string[]
  /** Employee a salary / reimbursement entry is for. */
  employeeName?: string | null
}

/** "a, b and c" — the way a person writes a list. */
function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * Tags read better than a category when they say something the category does
 * not. "Printing Cost" under a "Printing & Stationery" category adds nothing,
 * so the category wins; "Photoshop and Canva" does add something, so it wins.
 */
function describeWhat(tags: string[] | undefined, category: string): string {
  const useful = (tags || [])
    .map(t => t.trim())
    .filter(Boolean)
    // "For Client" is already recorded by the client field itself.
    .filter(t => !/^for\s+client$/i.test(t))
    // Drop anything that just restates the category, in either direction
    // ("Printing Cost" vs "Printing & Stationery").
    .filter(t => {
      if (!category) return true
      const c = category.toLowerCase()
      const l = t.toLowerCase()
      const head = l.split(/\s+/)[0]
      return !c.includes(l) && !l.includes(c) && !(head.length > 3 && c.includes(head))
    })

  // A long tag list is noise, not a name.
  if (useful.length === 0 || useful.length > 3) return category
  return joinWords(useful)
}

/**
 * The best description for what has been filled in so far, or '' when nothing
 * known would beat an empty box.
 *
 * Deliberately returns '' rather than something vague: a description that only
 * repeats the category — on an entry that already shows its category — adds
 * nothing, and an auto-filled non-answer is worse than a blank one, because it
 * looks like somebody meant it.
 */
export function suggestEntryDescription(input: DescribeInput): string {
  const client = (input.clientName || '').trim()
  const category = (input.categoryName || '').trim()
  const employee = (input.employeeName || '').trim()
  const invoices = (input.invoiceNumbers || []).filter(Boolean)

  // 1. Settling invoices — the most specific thing we can say.
  if (invoices.length > 0) {
    return `Payment for ${invoices.join(', ')}${client ? ` — ${client}` : ''}`
  }

  // 2. Someone's salary or reimbursement.
  if (employee) return category ? `${category} — ${employee}` : ''

  // 3. A cost bought for a client: what it was, and who it was for. The case
  //    the form never helped with, and the one people type out every time.
  if (client) {
    const what = describeWhat(input.tags, category)
    return `${what || 'Expense'} for ${client}`
  }

  // 4. Nothing but a category, which is already its own field on screen.
  return ''
}
