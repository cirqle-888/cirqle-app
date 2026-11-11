/**
 * Folding a duplicate monthly draft back into the real one.
 *
 * A client should have one draft per billing month. A second one ("-2") used
 * to appear whenever a task was finished while the month's invoice sat in
 * Reviewed: the database trigger only reused a `draft`, so it started a new
 * one and put the task there. Resync on the real invoice then saw the task as
 * already invoiced and left it where it was — the work never reached the
 * invoice anyone was looking at, and a task could end up on both.
 *
 * Resync now folds such duplicates in. This module decides, line by line, what
 * moves and what is dropped; the action does the writes.
 */

export interface MergeLine {
  id: string
  task_id: string | null
  /** Package fee / covered lines are rebuilt by the package sync, never moved. */
  package_id?: string | null
}

export interface MergeExpense {
  id: string
  cashbook_entry_id: string | null
}

export interface DraftMergePlan {
  /** Line ids to re-point at the target invoice. */
  moveLines: string[]
  /** Line ids to delete: the target already bills that task, or a package line. */
  dropLines: string[]
  moveExpenses: string[]
  /** The target already carries that cashbook entry. */
  dropExpenses: string[]
}

export function planDraftMerge(
  target: { lines: MergeLine[]; expenses: MergeExpense[] },
  sibling: { lines: MergeLine[]; expenses: MergeExpense[] },
): DraftMergePlan {
  const onTarget = new Set(target.lines.map(l => l.task_id).filter(Boolean))
  const expOnTarget = new Set(target.expenses.map(e => e.cashbook_entry_id).filter(Boolean))
  const plan: DraftMergePlan = { moveLines: [], dropLines: [], moveExpenses: [], dropExpenses: [] }

  for (const l of sibling.lines) {
    if (l.package_id) plan.dropLines.push(l.id)
    else if (l.task_id && onTarget.has(l.task_id)) plan.dropLines.push(l.id)
    else {
      plan.moveLines.push(l.id)
      if (l.task_id) onTarget.add(l.task_id)
    }
  }
  for (const e of sibling.expenses) {
    if (e.cashbook_entry_id && expOnTarget.has(e.cashbook_entry_id)) plan.dropExpenses.push(e.id)
    else {
      plan.moveExpenses.push(e.id)
      if (e.cashbook_entry_id) expOnTarget.add(e.cashbook_entry_id)
    }
  }
  return plan
}
