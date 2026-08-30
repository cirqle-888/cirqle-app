import { describe, it, expect } from 'vitest'
import { shouldReportPresent, type ActivitySignals } from './activity'
import { DESKTOP_IDLE_AWAY_MS } from './status'

const IDLE_S = DESKTOP_IDLE_AWAY_MS / 1000

function sig(over: Partial<ActivitySignals>): ActivitySignals {
  return { device: 'web', visible: true, appActive: null, desktop: null, ...over }
}

describe('browser', () => {
  it('follows tab visibility', () => {
    expect(shouldReportPresent(sig({ visible: true }))).toBe(true)
    expect(shouldReportPresent(sig({ visible: false }))).toBe(false)
  })
})

describe('desktop', () => {
  const desktop = (idleSeconds: number, locked = false, visible = true) =>
    sig({ device: 'desktop', visible, desktop: { idleSeconds, locked } })

  it('stays present with the window hidden — the whole point of the OS signal', () => {
    // The regression this rule exists for: docking the app or clicking into
    // the editor used to mark people Away three minutes later.
    expect(shouldReportPresent(desktop(10, false, /* visible */ false))).toBe(true)
  })

  it('goes quiet once the machine sits untouched', () => {
    expect(shouldReportPresent(desktop(IDLE_S - 1))).toBe(true)
    expect(shouldReportPresent(desktop(IDLE_S))).toBe(false)
    expect(shouldReportPresent(desktop(IDLE_S + 60))).toBe(false)
  })

  it('a locked screen wins even with input a second ago', () => {
    // Locking is an explicit "I am leaving"; idle time hasn't caught up yet.
    expect(shouldReportPresent(desktop(1, /* locked */ true))).toBe(false)
  })

  it('an older build with no bridge falls back to visibility, not to assuming presence', () => {
    const noBridge = (visible: boolean) => sig({ device: 'desktop', visible, desktop: null })
    expect(shouldReportPresent(noBridge(true))).toBe(true)
    expect(shouldReportPresent(noBridge(false))).toBe(false)
  })
})

describe('mobile', () => {
  const mobile = (appActive: boolean | null, visible = true) =>
    sig({ device: 'mobile', visible, appActive })

  it('follows the app state when the plugin answers', () => {
    expect(shouldReportPresent(mobile(true))).toBe(true)
    expect(shouldReportPresent(mobile(false))).toBe(false)
  })

  it('a backgrounded app is gone even if the webview still claims visible', () => {
    // iOS freezes a backgrounded webview mid-frame; the last visibility value
    // it reported can be stale, so the plugin has to win.
    expect(shouldReportPresent(mobile(false, /* visible */ true))).toBe(false)
  })

  it('falls back to visibility when the plugin is absent', () => {
    expect(shouldReportPresent(mobile(null, true))).toBe(true)
    expect(shouldReportPresent(mobile(null, false))).toBe(false)
  })
})

describe('the asymmetry the rule is built around', () => {
  it('no platform reports present without some positive evidence', () => {
    // Nothing visible, nothing foregrounded, no desktop bridge → silence on
    // every platform. A false "Available" is the expensive mistake.
    for (const device of ['web', 'desktop', 'mobile'] as const) {
      expect(shouldReportPresent(sig({ device, visible: false, appActive: false }))).toBe(false)
    }
  })
})
