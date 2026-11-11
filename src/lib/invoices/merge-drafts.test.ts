import { describe, it, expect } from 'vitest'
import { planDraftMerge } from './merge-drafts'

describe('planDraftMerge', () => {
  it('moves work the real draft lacks and drops what it already bills', () => {
    const plan = planDraftMerge(
      { lines: [{ id: 't1', task_id: 'happy' }], expenses: [{ id: 'te1', cashbook_entry_id: 'cb1' }] },
      {
        lines: [
          { id: 's1', task_id: 'best' },     // only on the duplicate → move
          { id: 's2', task_id: 'happy' },    // on both → drop, never bill twice
          { id: 's3', task_id: null },       // manual line → move
          { id: 's4', task_id: 'pkgTask', package_id: 'p1' }, // package sync rebuilds it
        ],
        expenses: [{ id: 'se1', cashbook_entry_id: 'cb1' }, { id: 'se2', cashbook_entry_id: 'cb2' }],
      },
    )
    expect(plan.moveLines).toEqual(['s1', 's3'])
    expect(plan.dropLines).toEqual(['s2', 's4'])
    expect(plan.moveExpenses).toEqual(['se2'])
    expect(plan.dropExpenses).toEqual(['se1'])
  })

  it('keeps one line when the duplicate itself bills a task twice', () => {
    const plan = planDraftMerge(
      { lines: [], expenses: [] },
      { lines: [{ id: 'a', task_id: 'x' }, { id: 'b', task_id: 'x' }], expenses: [] },
    )
    expect(plan.moveLines).toEqual(['a'])
    expect(plan.dropLines).toEqual(['b'])
  })
})
