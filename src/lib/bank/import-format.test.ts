import { describe, it, expect } from 'vitest'
import { buildExtractionPrompt, buildStatementTemplate, STATEMENT_HEADER } from './import-format'
import { guessColumns, parseStatementRows } from '@/lib/reconcile/parse'

/**
 * The prompt and the parser are two halves of one contract, so the tests that
 * matter are the ones that hold them together: the header the prompt asks for
 * must be the header the parser reads, and the template must survive a round
 * trip through the importer it is a template for.
 */

describe('the statement template', () => {
  it('round-trips through the parser it was written for', () => {
    const rows = buildStatementTemplate('HDFC Current')
      .split('\n')
      .map(r => r.split(',').map(c => c.replace(/^"|"$/g, '')))

    const map = guessColumns(rows[0])
    const got = parseStatementRows(rows.slice(1), map as Parameters<typeof parseStatementRows>[1], { convention: 'bank' })

    expect(got.problems).toEqual([])
    // 25,000 in and 1,180 out — the signs the app uses everywhere downstream.
    expect(got.lines.map(l => l.amount)).toEqual([25000, -1180])
    expect(got.lines.map(l => l.balanceAfter)).toEqual([125000, 123820])
    expect(got.lines[0].txnDate).toBe('2026-07-01')
  })
})

describe('the extraction prompt', () => {
  const prompt = buildExtractionPrompt({
    accountNames: ['HDFC Current', 'ICICI Savings'],
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
  })

  it('asks for exactly the header the parser reads', () => {
    expect(prompt).toContain(STATEMENT_HEADER)
  })

  it('names every account, so a row can say which one it is', () => {
    expect(prompt).toContain('- HDFC Current')
    expect(prompt).toContain('- ICICI Savings')
    expect(prompt).toMatch(/SEPARATE .*csv block/i)
  })

  it('pins the date format, which is the whole day-first ambiguity', () => {
    expect(prompt).toContain('YYYY-MM-DD')
    expect(prompt).toMatch(/Not DD\/MM, not MM\/DD/)
  })

  it('forbids exactly the things that quietly corrupt an import', () => {
    expect(prompt).toMatch(/Never both\. Never neither\./)
    expect(prompt).toMatch(/Do NOT skip any transaction/)
    expect(prompt).toMatch(/Do NOT invent/)
    expect(prompt).toMatch(/opening balance, closing balance, sub-totals/)
    expect(prompt).toMatch(/UNREADABLE/)
  })

  it('carries the period when there is one, and stays quiet when there is not', () => {
    expect(prompt).toContain('between 2026-07-01 and 2026-07-31')
    const open = buildExtractionPrompt({ accountNames: ['HDFC Current'] })
    expect(open).not.toMatch(/Only include transactions dated between/)
  })

  it('still produces a usable prompt with no accounts set up', () => {
    const bare = buildExtractionPrompt({ accountNames: [] })
    expect(bare).toContain(STATEMENT_HEADER)
    expect(bare).toMatch(/type your account names here/)
  })
})
