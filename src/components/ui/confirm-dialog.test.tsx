import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * ConfirmDialog gained an optional typed confirmation for irreversible
 * actions. The two things worth pinning are that it stays OPTIONAL — 40-odd
 * existing callers rely on a single click — and that when it IS set, the
 * confirm button is genuinely disabled rather than merely styled as such.
 */
const SRC = readFileSync(join(process.cwd(), 'src/components/ui/confirm-dialog.tsx'), 'utf8')

describe('ConfirmDialog typed confirmation', () => {
  it('is optional, so existing callers keep single-click confirm', () => {
    expect(SRC).toMatch(/requireTypedText\?:\s*string/)
    // No prop passed → unlocked from the start.
    expect(SRC).toContain('!requireTypedText ||')
  })

  it('disables the confirm button, not just its styling', () => {
    expect(SRC).toMatch(/disabled=\{!unlocked\}/)
  })

  it('compares trimmed, so a stray pasted space is not a wall', () => {
    expect(SRC).toMatch(/typed\.trim\(\)\s*===\s*requireTypedText\.trim\(\)/)
  })

  it('does not let Enter bypass the gate', () => {
    expect(SRC).toMatch(/e\.key === 'Enter' && unlocked/)
  })

  it('is a client component — it holds state now', () => {
    expect(SRC.trimStart().startsWith("'use client'")).toBe(true)
  })
})
