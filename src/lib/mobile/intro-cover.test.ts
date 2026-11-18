import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  runIntroCover, COVER_SRC, COVER_SHOW_MS, COVER_FADE_MS, COVER_LOAD_TIMEOUT_MS, type CoverRoot,
} from './intro-cover'

const timers = { setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms) }

describe('runIntroCover', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does nothing but hide the splash when there is no cover to show', async () => {
    const root: CoverRoot = { dataset: {} }
    const hideSplash = vi.fn(), loadImage = vi.fn()
    await runIntroCover(root, { ...timers, hideSplash, loadImage })
    expect(hideSplash).toHaveBeenCalledTimes(1)
    expect(loadImage).not.toHaveBeenCalled()
  })

  it('holds the splash until the image loads, shows the cover, then fades it out', async () => {
    const root: CoverRoot = { dataset: { introCover: 'show' } }
    const hideSplash = vi.fn()
    let loaded!: () => void
    const loadImage = vi.fn(() => new Promise<void>(r => { loaded = r }))
    const done = runIntroCover(root, { ...timers, hideSplash, loadImage })

    expect(loadImage).toHaveBeenCalledWith(COVER_SRC)
    await vi.advanceTimersByTimeAsync(500)
    expect(hideSplash).not.toHaveBeenCalled()      // image still loading

    loaded()
    await vi.advanceTimersByTimeAsync(0)
    expect(hideSplash).toHaveBeenCalledTimes(1)
    expect(root.dataset.introCover).toBe('show')

    await vi.advanceTimersByTimeAsync(COVER_SHOW_MS)
    expect(root.dataset.introCover).toBe('hide')

    await vi.advanceTimersByTimeAsync(COVER_FADE_MS)
    await done
    expect(root.dataset.introCover).toBeUndefined()
  })

  it('never leaves the app hidden: a broken or stalled image still ends', async () => {
    for (const loadImage of [
      () => Promise.reject(new Error('404')),      // broken
      () => new Promise<void>(() => {}),           // never answers
    ]) {
      const root: CoverRoot = { dataset: { introCover: 'show' } }
      const hideSplash = vi.fn()
      const done = runIntroCover(root, { ...timers, hideSplash, loadImage })
      await vi.advanceTimersByTimeAsync(COVER_LOAD_TIMEOUT_MS + COVER_SHOW_MS + COVER_FADE_MS)
      await done
      expect(hideSplash).toHaveBeenCalledTimes(1)
      expect(root.dataset.introCover).toBeUndefined()
    }
  })
})

describe('the three pieces agree with each other', () => {
  const root = process.cwd()
  const css = readFileSync(join(root, 'src/app/globals.css'), 'utf8')
  const init = readFileSync(join(root, 'public/theme-init.js'), 'utf8')

  it('the image the code preloads is the one the stylesheet draws, and it exists', () => {
    expect(css).toContain(`url('${COVER_SRC}')`)
    expect(() => readFileSync(join(root, 'public', COVER_SRC))).not.toThrow()
  })

  it('theme-init sets the attribute the stylesheet and this module read', () => {
    expect(init).toContain("setAttribute('data-intro-cover', 'show')")
    expect(css).toContain("html[data-intro-cover]::before")
  })

  it('the stylesheet has a failsafe that removes the cover without JavaScript', () => {
    expect(css).toMatch(/intro-cover-failsafe/)
  })

  it('theme-init.js is served before login (the proxy must not redirect it)', () => {
    const proxy = readFileSync(join(root, 'src/proxy.ts'), 'utf8')
    expect(proxy).toContain('theme-init\\\\.js$')
  })
})
