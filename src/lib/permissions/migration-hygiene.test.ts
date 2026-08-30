import { describe, it, expect } from 'vitest'
import { readdirSync } from 'fs'
import { join } from 'path'

/**
 * Migration filename hygiene.
 *
 * The Supabase CLI applies a migration only if its filename matches
 * `<timestamp>_name.sql`. Anything else is SKIPPED — with a notice, not an
 * error — so a mis-named file looks applied locally, passes review, and simply
 * never runs.
 *
 * On 2026-08-30 seventeen files in supabase/migrations/ had no timestamp. Every
 * CI `security` run skipped all seventeen and then died on the first timestamped
 * migration, which referenced a table those files were meant to have created.
 * The RLS check the job exists for never executed once in 242 runs.
 *
 * This test fails at commit time instead of silently at apply time.
 */
const MIGRATIONS = join(process.cwd(), 'supabase/migrations')

// The seventeen that already exist. They are grandfathered because renaming
// them changes nothing on its own: the base schema (clients, employees, tasks,
// invoices …) has no DDL in this repo at all, so the history cannot replay
// regardless. Fixing that needs a baseline dump from production — tracked
// separately. This list must only ever shrink.
const GRANDFATHERED = new Set([
  'backfill_foreign_task_billing_inr.sql',
  'cashbook_invoice_link.sql',
  'cashbook_invoice_link_fix.sql',
  'discount_logs.sql',
  'fix_unique_constraints.sql',
  'invoice_sequence.sql',
  'phase10_invoice_expense_items.sql',
  'phase11_expense_markup.sql',
  'phase1_soft_delete.sql',
  'phase2_audit_log.sql',
  'phase3_allocations.sql',
  'phase4_allocation_triggers.sql',
  'phase5_allocation_data_migration.sql',
  'phase6_auto_allocation_trigger.sql',
  'phase7_allocations_cascade.sql',
  'phase8_fix_auto_draft_dates.sql',
  'phase9_invoice_delete_cascade.sql',
])

describe('migration filenames', () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))

  it('every NEW migration is timestamped, so the CLI will actually apply it', () => {
    const untimestamped = files
      .filter((f) => !/^\d{8,14}_/.test(f))
      .filter((f) => !GRANDFATHERED.has(f))
    expect(
      untimestamped,
      'The Supabase CLI silently SKIPS files that are not <timestamp>_name.sql.\n' +
        'Rename these to a UTC timestamp prefix (e.g. 20260830120000_):\n  ' +
        untimestamped.join('\n  '),
    ).toEqual([])
  })

  it('the grandfathered list only shrinks', () => {
    const stillPresent = [...GRANDFATHERED].filter((f) => files.includes(f))
    expect(
      stillPresent.length,
      'A grandfathered file was renamed or removed — take it out of GRANDFATHERED too.',
    ).toBeLessThanOrEqual(GRANDFATHERED.size)
  })

  it('no NEW migration shares a timestamp prefix with another', () => {
    // Three pairs already collide. They are grandfathered rather than renamed
    // because renaming buys nothing today — the history cannot replay at all
    // until the base schema is captured — and each pair happens to be
    // independent (an offer-flyer change alongside an unrelated one), so their
    // arbitrary alphabetical order is harmless in practice. A NEW collision is
    // not harmless, because the next pair may well depend on each other.
    const GRANDFATHERED_CLASHES = new Set([
      '20260807100000',
      '20260807110000',
      '20260807120000',
    ])
    const seen = new Map<string, string[]>()
    for (const f of files) {
      const m = /^(\d{8,14})_/.exec(f)
      if (!m || GRANDFATHERED_CLASHES.has(m[1])) continue
      seen.set(m[1], [...(seen.get(m[1]) ?? []), f])
    }
    const clashes = [...seen.entries()].filter(([, v]) => v.length > 1)
    // Same-timestamp files apply in filename order, which is alphabetical and
    // therefore arbitrary with respect to their dependencies.
    expect(
      clashes.map(([ts, v]) => `${ts}: ${v.join(', ')}`),
      'Two migrations share a timestamp; their apply order is alphabetical, not intentional.',
    ).toEqual([])
  })
})
