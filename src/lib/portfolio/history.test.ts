import { describe, it, expect } from 'vitest'
import {
  initHistory, pushHistory, undo, redo, canUndo, canRedo, resetHistory, HISTORY_LIMIT,
} from './history'

describe('history', () => {
  it('starts with nowhere to go', () => {
    const h = initHistory('a')
    expect(h.present).toBe('a')
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })

  it('walks back and forward through edits', () => {
    let h = initHistory('a')
    h = pushHistory(h, 'b')
    h = pushHistory(h, 'c')
    expect(h.present).toBe('c')

    h = undo(h); expect(h.present).toBe('b')
    h = undo(h); expect(h.present).toBe('a')
    expect(canUndo(h)).toBe(false)

    h = redo(h); expect(h.present).toBe('b')
    h = redo(h); expect(h.present).toBe('c')
    expect(canRedo(h)).toBe(false)
  })

  it('does nothing at either end rather than throwing', () => {
    const h = initHistory('a')
    expect(undo(h)).toBe(h)
    expect(redo(h)).toBe(h)
  })

  it('drops the redo stack once a new edit is made', () => {
    // Redoing onto a branch that no longer exists would restore a state the
    // user never created.
    let h = pushHistory(pushHistory(initHistory('a'), 'b'), 'c')
    h = undo(h)
    expect(canRedo(h)).toBe(true)
    h = pushHistory(h, 'd')
    expect(canRedo(h)).toBe(false)
    expect(h.present).toBe('d')
  })

  it('ignores a push that changes nothing', () => {
    // A pointermove too small to move a coordinate must not cost an undo step.
    const h = pushHistory(initHistory('a'), 'b')
    expect(pushHistory(h, 'b')).toBe(h)
  })

  it('coalesces a tagged run into one undoable step', () => {
    // One brush stroke is one undo, not one per sampled point.
    let h = initHistory('empty')
    h = pushHistory(h, 'stroke-1', 'drag-7')
    h = pushHistory(h, 'stroke-2', 'drag-7')
    h = pushHistory(h, 'stroke-3', 'drag-7')
    expect(h.present).toBe('stroke-3')
    expect(h.past).toEqual(['empty'])
    expect(undo(h).present).toBe('empty')
  })

  it('starts a new step when the tag changes', () => {
    let h = initHistory('empty')
    h = pushHistory(h, 'a1', 'drag-1')
    h = pushHistory(h, 'b1', 'drag-2')
    expect(h.past).toEqual(['empty', 'a1'])
    expect(undo(h).present).toBe('a1')
  })

  it('does not coalesce an untagged edit into a tagged one', () => {
    let h = initHistory('empty')
    h = pushHistory(h, 'brushed', 'drag-1')
    h = pushHistory(h, 'added an area')
    expect(undo(h).present).toBe('brushed')
  })

  it('keeps the most recent steps when the limit is reached', () => {
    let h = initHistory(0)
    for (let i = 1; i <= HISTORY_LIMIT + 5; i++) h = pushHistory(h, i)
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    expect(h.present).toBe(HISTORY_LIMIT + 5)
    // The oldest states are gone; the reachable floor moved up.
    expect(h.past[0]).toBe(5)
  })

  it('never mutates the history it is given', () => {
    const h = pushHistory(initHistory('a'), 'b')
    const snapshot = JSON.stringify(h)
    undo(h); redo(h); pushHistory(h, 'c')
    expect(JSON.stringify(h)).toBe(snapshot)
  })

  it('resets to a state from outside the editor with no way back', () => {
    const h = resetHistory('loaded')
    expect(h.present).toBe('loaded')
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })
})
