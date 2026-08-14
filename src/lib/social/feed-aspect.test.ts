import { describe, it, expect } from 'vitest'
import {
  parseFeedAspect, aspectClass, aspectLabel,
  DEFAULT_FEED_ASPECT, FEED_ASPECT_OPTIONS,
} from './feed-aspect'

describe('parsing a stored aspect', () => {
  it('accepts every supported ratio', () => {
    expect(parseFeedAspect('1:1')).toBe('1:1')
    expect(parseFeedAspect('4:5')).toBe('4:5')
    expect(parseFeedAspect('3:4')).toBe('3:4')
  })

  it('falls back to the default when nothing is stored', () => {
    // A fresh install has no row; the planner must still render.
    expect(parseFeedAspect(null)).toBe(DEFAULT_FEED_ASPECT)
    expect(parseFeedAspect(undefined)).toBe(DEFAULT_FEED_ASPECT)
    expect(parseFeedAspect('')).toBe(DEFAULT_FEED_ASPECT)
  })

  it('falls back rather than break the grid on an unknown value', () => {
    // A typo, or a value written by a newer version. A wrong-but-valid crop is
    // recoverable; a collapsed layout is not.
    for (const bad of ['16:9', 'square', '4/5', '0:0', 'null']) {
      expect(parseFeedAspect(bad)).toBe(DEFAULT_FEED_ASPECT)
    }
  })

  it('defaults to portrait — what Instagram currently crops to', () => {
    expect(DEFAULT_FEED_ASPECT).toBe('4:5')
  })
})

describe('rendering', () => {
  it('gives every option a distinct Tailwind class', () => {
    const classes = FEED_ASPECT_OPTIONS.map(o => o.className)
    expect(new Set(classes).size).toBe(classes.length)
    expect(classes.every(c => c.startsWith('aspect-'))).toBe(true)
  })

  it('maps each ratio to its class', () => {
    expect(aspectClass('1:1')).toBe('aspect-square')
    expect(aspectClass('4:5')).toBe('aspect-[4/5]')
    expect(aspectClass('3:4')).toBe('aspect-[3/4]')
  })

  it('never returns an empty class, even for a value outside the union', () => {
    // Belt and braces: a cast-through from untyped data must not blank the grid.
    expect(aspectClass('nonsense' as never)).toBeTruthy()
  })

  it('labels every option for the settings control', () => {
    for (const o of FEED_ASPECT_OPTIONS) {
      expect(aspectLabel(o.value)).toBe(o.label)
      expect(o.hint.length).toBeGreaterThan(0)
    }
  })
})
