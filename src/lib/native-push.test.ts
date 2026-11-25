import { describe, it, expect, vi } from 'vitest'

// The module imports server actions; the pure helpers under test never call them.
vi.mock('@/lib/push/native-actions', () => ({ saveNativePushToken: vi.fn(), removeNativePushToken: vi.fn() }))

import { buildHasPush, pushTargetPath, PUSH_MIN_ANDROID_BUILD } from './native-push'

describe('buildHasPush', () => {
  it('is on from the first Firebase build', () => {
    expect(buildHasPush('android', String(PUSH_MIN_ANDROID_BUILD))).toBe(true)
    expect(buildHasPush('android', PUSH_MIN_ANDROID_BUILD + 3)).toBe(true)
  })

  it('is off for older builds, which would close on register()', () => {
    expect(buildHasPush('android', String(PUSH_MIN_ANDROID_BUILD - 1))).toBe(false)
    expect(buildHasPush('android', '1')).toBe(false)
  })

  it('is off when the build is unknown', () => {
    expect(buildHasPush('android', undefined)).toBe(false)
    expect(buildHasPush('android', '')).toBe(false)
    expect(buildHasPush('android', 'abc')).toBe(false)
  })

  it('is off on iOS and web', () => {
    expect(buildHasPush('ios', '99')).toBe(false)
    expect(buildHasPush('web', '99')).toBe(false)
  })
})

describe('pushTargetPath', () => {
  it('returns a path inside the app', () => {
    expect(pushTargetPath({ url: '/dashboard/chat?c=1' })).toBe('/dashboard/chat?c=1')
  })

  it('refuses anything that is not an in-app path', () => {
    expect(pushTargetPath({ url: 'https://example.com/x' })).toBeNull()
    expect(pushTargetPath({ url: '//example.com/x' })).toBeNull()
    expect(pushTargetPath({ url: '/\\example.com' })).toBeNull()
    expect(pushTargetPath({ url: 'dashboard' })).toBeNull()
    expect(pushTargetPath({ url: 42 })).toBeNull()
    expect(pushTargetPath({})).toBeNull()
    expect(pushTargetPath(undefined)).toBeNull()
  })
})

describe('the build script', () => {
  it('refuses a Firebase-less build from the same build number', async () => {
    const { readFile } = await import('node:fs/promises')
    const script = await readFile('mobile/scripts/build-android.sh', 'utf8')
    expect(script).toContain(`PUSH_MIN_CODE=${PUSH_MIN_ANDROID_BUILD}`)
  })
})
