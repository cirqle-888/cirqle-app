import { describe, it, expect } from 'vitest'
import { isKeyboardOpen, KEYBOARD_MIN_HEIGHT } from './keyboard'

describe('isKeyboardOpen', () => {
  it('is open when the viewport lost a keyboard-sized slice and a field has focus', () => {
    expect(isKeyboardOpen(800, 480, true)).toBe(true)
    expect(isKeyboardOpen(800, 800 - KEYBOARD_MIN_HEIGHT, true)).toBe(true)
  })

  it('is closed at full height, or after a small change like a toolbar hiding', () => {
    expect(isKeyboardOpen(800, 800, true)).toBe(false)
    expect(isKeyboardOpen(800, 744, true)).toBe(false)
  })

  it('is closed when nothing that takes typing has focus', () => {
    // A split-screen or folded phone can be short without any keyboard.
    expect(isKeyboardOpen(800, 480, false)).toBe(false)
  })

  it('is closed on nonsense input rather than hiding the nav by mistake', () => {
    expect(isKeyboardOpen(NaN, 480, true)).toBe(false)
    expect(isKeyboardOpen(800, NaN, true)).toBe(false)
  })
})
