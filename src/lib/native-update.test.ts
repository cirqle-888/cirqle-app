import { describe, it, expect } from 'vitest'
import { isNewerBuild } from './native-update'

describe('isNewerBuild', () => {
  it('is true when the latest versionCode is greater', () => {
    expect(isNewerBuild('12', 15)).toBe(true)
    expect(isNewerBuild(12, 13)).toBe(true)
  })

  it('is false when equal or older', () => {
    expect(isNewerBuild('15', 15)).toBe(false)
    expect(isNewerBuild(20, 19)).toBe(false)
  })

  it('is false (conservative) for missing or non-numeric inputs', () => {
    expect(isNewerBuild(undefined, 10)).toBe(false)
    expect(isNewerBuild('12', undefined)).toBe(false)
    expect(isNewerBuild('abc', 10)).toBe(false)
    expect(isNewerBuild('12', NaN)).toBe(false)
  })
})
