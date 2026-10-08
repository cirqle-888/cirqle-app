import { describe, expect, it } from 'vitest'
import { isStaleBuildError, shouldAutoReload } from './stale-build'

describe('isStaleBuildError', () => {
  it('recognises a server action from an older build', () => {
    expect(isStaleBuildError(new Error('Server Action "7f3a9c" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action'))).toBe(true)
  })
  it('recognises missing lazy chunks across bundlers and browsers', () => {
    const chunk = Object.assign(new Error('Loading chunk 482 failed.'), { name: 'ChunkLoadError' })
    expect(isStaleBuildError(chunk)).toBe(true)
    expect(isStaleBuildError(new Error('Failed to load chunk /_next/static/chunks/abc123.js from module 991'))).toBe(true)
    expect(isStaleBuildError(new TypeError('Failed to fetch dynamically imported module: https://app.cirqle.work/_next/x.js'))).toBe(true)
    expect(isStaleBuildError(new TypeError('Importing a module script failed.'))).toBe(true)
  })
  it('leaves ordinary bugs alone', () => {
    expect(isStaleBuildError(new TypeError("Cannot read properties of undefined (reading 'name')"))).toBe(false)
    expect(isStaleBuildError(new Error('An unexpected response was received from the server.'))).toBe(false)
    expect(isStaleBuildError(null)).toBe(false)
    expect(isStaleBuildError('Loading chunk 1 failed')).toBe(false)
  })
})

describe('shouldAutoReload', () => {
  it('reloads the first time and again only after a minute', () => {
    expect(shouldAutoReload(null, 1_000_000)).toBe(true)
    expect(shouldAutoReload(1_000_000, 1_030_000)).toBe(false)
    expect(shouldAutoReload(1_000_000, 1_061_000)).toBe(true)
  })
})
