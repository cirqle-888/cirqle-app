import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { round2 } from './currency'

/**
 * One money-rounding rule for the whole app.
 *
 * `Math.round(n * 100) / 100` is the obvious way to round money and it is
 * subtly wrong: binary floats put 1.005 at 100.49999999999999 once multiplied,
 * so it rounds DOWN to 1.00 where a person (and the ledger) expects 1.01.
 * `round2` adds Number.EPSILON to correct that.
 *
 * Before this audit both spellings were in the tree — eleven copies, seven of
 * them unguarded — including `profit.ts`, which declares itself "THE profit
 * engine — one calculation, every consumer", while `pnl.ts` used the guarded
 * form. Two modules could therefore report the same figure a paisa apart.
 *
 * The first suite pins the behaviour; the second stops a local copy from
 * quietly reappearing.
 */

describe('round2 rounds money the way the ledger does', () => {
  it('rounds .xx5 midpoints UP, where naive float rounding goes down', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(1.015)).toBe(1.02)
    expect(round2(1.025)).toBe(1.03)
    expect(round2(0.145)).toBe(0.15)
    expect(round2(0.285)).toBe(0.29)
    expect(round2(0.565)).toBe(0.57)
  })

  it('leaves already-2dp values alone', () => {
    for (const v of [0, 1, 10.5, 99.99, 1234.56, 1_00_000.01]) {
      expect(round2(v)).toBe(v)
    }
  })

  it('handles zero and negative amounts', () => {
    expect(round2(0)).toBe(0)
    expect(round2(-1.234)).toBe(-1.23)
    expect(round2(-0.005)).toBe(-0)
  })

  it('COERCES NaN AND undefined TO ZERO — documented, not endorsed', () => {
    // `(n || 0)` makes every falsy input 0, so a failed parse or a missing
    // column silently becomes a real, confident-looking 0.00 instead of
    // surfacing as an error. This test pins CURRENT behaviour so the coercion
    // is visible rather than a surprise; it is logged in the audit as an
    // error-handling finding, and changing it would need every call site
    // checked for what a null amount should actually mean.
    expect(round2(NaN as unknown as number)).toBe(0)
    expect(round2(undefined as unknown as number)).toBe(0)
    expect(round2(null as unknown as number)).toBe(0)
  })

  it('survives large totals without losing paise', () => {
    expect(round2(12_345_678.905)).toBe(12345678.91)
  })
})

describe('no module re-implements money rounding locally', () => {
  // Walk src/lib rather than a fixed list, so a new file is covered the day it
  // is written. The check is textual on purpose: the failure mode is someone
  // typing the naive form afresh, not importing a wrong helper.
  const ROOT = join(process.cwd(), 'src', 'lib')

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
    }
    return out
  }

  it('every money round-to-2dp goes through currency.ts round2', () => {
    // Matches `Math.round(<expr> * 100) / 100` WITHOUT an epsilon guard.
    const naive = /Math\.round\((?![^)]*EPSILON)[^)]*\*\s*100\s*\)\s*\/\s*100/
    const offenders: string[] = []

    for (const file of walk(ROOT)) {
      // currency.ts is where the canonical implementation lives.
      if (file.endsWith(join('calculations', 'currency.ts'))) continue
      const src = readFileSync(file, 'utf8')
      for (const [i, line] of src.split('\n').entries()) {
        // Skip comments — the explanation of this very rule quotes the naive
        // form, and a doc comment is not a call site.
        const code = line.replace(/\/\/.*$/, '').trim()
        if (code.startsWith('*') || code.startsWith('/*')) continue
        if (naive.test(code)) offenders.push(`${file.replace(process.cwd() + '/', '')}:${i + 1}`)
      }
    }

    expect(
      offenders,
      `Import { round2 } from '@/lib/calculations/currency' instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })
})
