/**
 * REGRESSION GUARD for the contribution write path.
 *
 * The scoring panel inside the task edit modal once wrote to `contributions`,
 * `task_tools` and `contribution_scores` directly from the browser. RLS only
 * checks `contributions.edit`, so that path silently skipped BOTH protections
 * the server action enforces:
 *
 *   • the closed-month guard (isTaskMonthProtected) — a locked month could be
 *     edited from the task modal while the Contributions page refused it;
 *   • manual-override preservation — curated earnings were deleted and
 *     replaced by a freshly computed figure.
 *
 * Neither failure produces a type error or a runtime error. The save reports
 * success and the damage is only visible later, in money. So this reads the
 * source: the panel must funnel through saveTaskContributions, and must not
 * regain a direct write to any of the three tables.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const PANEL = 'src/components/ui/contribution-entry-panel.tsx'
const src = readFileSync(join(process.cwd(), PANEL), 'utf8')

/** Write verbs, as they appear chained onto a PostgREST query builder. */
const WRITES = ['insert', 'delete', 'update', 'upsert']
const GUARDED_TABLES = ['contributions', 'task_tools', 'contribution_scores']

describe('the entry panel saves through the guarded server action', () => {
  it('calls saveTaskContributions', () => {
    expect(src).toMatch(/import\s*\{[^}]*saveTaskContributions[^}]*\}\s*from/)
    expect(src).toMatch(/await\s+saveTaskContributions\(/)
  })

  it.each(GUARDED_TABLES)('never writes to `%s` directly', table => {
    // Matches `.from('x').insert(`, `.from('x').delete()`, and the same split
    // across lines — the shape a reintroduced browser write would take.
    const direct = new RegExp(
      `from\\(['"]${table}['"]\\)\\s*(?:\\r?\\n\\s*)?\\.\\s*(?:${WRITES.join('|')})\\b`,
    )
    expect(src).not.toMatch(direct)
  })

  it('keeps the draft when the server refuses the save', () => {
    // A refusal (closed month, missing permission) must not cost the user the
    // values they just typed — the clear must sit after the ok check.
    const save = src.slice(src.indexOf('async function handleSave'))
    const body = save.slice(0, save.indexOf('\n  }'))
    expect(body).toMatch(/if\s*\(!res\.ok\)/)
    expect(body.indexOf('if (!res.ok)')).toBeLessThan(body.indexOf('removeItem(draftKey)'))
  })

  it('re-reads the saved scores instead of echoing the local computation', () => {
    // An overridden row keeps its old figure; trusting the local calculation
    // would display a number the database does not hold.
    const save = src.slice(src.indexOf('async function handleSave'))
    expect(save.slice(0, save.indexOf('\n  }'))).toMatch(/setExistingScores\(saved\)/)
  })
})
