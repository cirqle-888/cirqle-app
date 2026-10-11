/**
 * Preview and recovery for bulk actions.
 *
 * The server side of Cirqle's bulk actions already does the right thing: each
 * one loops the per-row action (so every row keeps its own permission check)
 * and returns `{ succeeded, failed }`. The UI then threw that away. A bulk
 * status change over twelve requests where three failed produced one toast —
 * "Some requests could not be updated" — with no indication of which three,
 * and the whole twelve still selected. The only way to finish the job was to
 * re-run all twelve and hope.
 *
 * This module turns that result into the three things the improvement plan
 * asks for:
 *
 *   · a count the user sees BEFORE the data changes (`describeBulkPlan`),
 *   · an honest report of a partial failure (`summariseBulkOutcome`), and
 *   · exactly the failed ids, so a retry re-runs only those (`retryableIds`).
 *
 * ── ON UNDO ───────────────────────────────────────────────────────────────
 *
 * The plan asks for Undo "where the server can enforce concurrency and
 * permissions". Permissions, yes — the per-row actions enforce them. But none
 * of these tables carries a version or an updated-at precondition, so an
 * "undo" would be a blind write of the previous value: if a colleague changed
 * one of those rows in between, undo would silently discard their edit. So
 * there is deliberately no undo here, and `summariseBulkOutcome` does not
 * pretend to offer one. Adding it means adding optimistic-concurrency checks
 * to the per-row actions first.
 *
 * Pure and dependency-free.
 */

/** What every bulk server action already returns. */
export interface BulkOutcome {
  succeeded: string[]
  failed: string[]
}

export type BulkTone = 'success' | 'partial' | 'failure' | 'empty'

export interface BulkReport {
  tone: BulkTone
  title: string
  /** One sentence; empty when the title says everything. */
  body: string
  /** Ids worth a second attempt — the failures, and nothing else. */
  retryable: string[]
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * The sentence shown before anything is written.
 *
 * Names the count and the action, because "Update" over a selection the user
 * made four scrolls ago is the moment a mis-click becomes twelve wrong rows.
 *
 * `verb` is bare — "approve", "archive", "file" — because the count and noun
 * are slotted in after it. Anything that belongs AFTER them ("under Digital
 * Setup") goes in `qualifier`; folding it into the verb produces "File them
 * under Digital Setup 2 clients."
 */
export function describeBulkPlan(
  count: number,
  verb: string,
  noun: string,
  qualifier?: string,
): string {
  const tail = qualifier?.trim() ? ` ${qualifier.trim()}` : ''
  if (count === 0) return `Nothing is selected, so there is nothing to ${verb}${tail}.`
  return `${verb[0].toUpperCase()}${verb.slice(1)} ${plural(count, noun)}${tail}. `
    + 'Each one is checked separately, so some may be refused — you will be told which.'
}

/**
 * Read a bulk result honestly.
 *
 * `attempted` is passed in rather than inferred from the outcome, so a server
 * that returns fewer rows than it was given (a crash halfway, a dropped
 * connection) is reported as a partial failure instead of a clean success.
 */
export function summariseBulkOutcome(
  outcome: BulkOutcome | null | undefined,
  attempted: readonly string[],
  noun: string,
): BulkReport {
  if (attempted.length === 0) {
    return { tone: 'empty', title: 'Nothing was selected', body: '', retryable: [] }
  }

  const succeeded = outcome?.succeeded ?? []
  const reported = new Set([...succeeded, ...(outcome?.failed ?? [])])
  // Anything the server never mentioned is a failure, not a success. Silence
  // is the one answer we must not read as "done".
  const unaccounted = attempted.filter(id => !reported.has(id))
  const failed = [...(outcome?.failed ?? []), ...unaccounted]

  if (failed.length === 0) {
    return {
      tone: 'success',
      title: `${plural(succeeded.length, noun)} updated`,
      body: '',
      retryable: [],
    }
  }

  if (succeeded.length === 0) {
    return {
      tone: 'failure',
      title: `None of the ${plural(failed.length, noun)} could be updated`,
      body: 'Nothing was changed.',
      retryable: failed,
    }
  }

  return {
    tone: 'partial',
    title: `${succeeded.length} of ${attempted.length} ${noun}${attempted.length === 1 ? '' : 's'} updated`,
    body: `${plural(failed.length, noun)} were refused and left unchanged.`,
    retryable: failed,
  }
}

/**
 * Ids to re-select after a partial failure.
 *
 * Narrowing the selection to the failures is what makes "Retry" safe: the
 * second attempt cannot re-apply the action to rows that already took it,
 * which for a status change is harmless but for anything that appends or
 * increments is not.
 */
export function retryableIds(report: BulkReport): string[] {
  return report.retryable
}
