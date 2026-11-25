import { describe, it, expect, vi } from 'vitest'

// The module imports server actions; the pure helpers under test never call them.
vi.mock('@/lib/push/native-actions', () => ({ saveNativePushToken: vi.fn(), removeNativePushToken: vi.fn(), reportPushTap: vi.fn() }))

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

describe('a tapped notification', () => {
  const tap = { actionId: 'tap', notification: { id: 'm1', data: { url: '/dashboard/chat?c=abc', tag: 'msg:abc' } } }

  async function tapWith(landsOn: string) {
    vi.resetModules()
    vi.useFakeTimers()
    const assigned: string[] = []
    const location = { pathname: '/dashboard', assign: (to: string) => { assigned.push(to) } }
    ;(globalThis as unknown as { window: unknown }).window = {
      location,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {
          App: { getInfo: async () => ({ build: String(PUSH_MIN_ANDROID_BUILD) }) },
          PushNotifications: {
            checkPermissions: async () => ({ receive: 'denied' }),
            requestPermissions: async () => ({ receive: 'denied' }),
            register: async () => {},
            // The plugin hands a tap that started the app to the first listener at once.
            addListener: (event: string, cb: (d: unknown) => void) => {
              if (event === 'pushNotificationActionPerformed') cb(tap)
              return { remove: async () => {} }
            },
          },
        },
      },
    }
    const actions = await import('@/lib/push/native-actions')
    const report = vi.mocked(actions.reportPushTap).mockResolvedValue(undefined)
    const { startNativePush } = await import('./native-push')
    const opened: string[] = []
    await startNativePush((path) => { opened.push(path); location.pathname = landsOn })
    await vi.advanceTimersByTimeAsync(5000)
    vi.useRealTimers()
    return { opened, assigned, trace: report.mock.calls.at(-1)?.[0] }
  }

  it('opens the page the notification asked for, and says so in the log', async () => {
    const { opened, assigned, trace } = await tapWith('/dashboard/chat')
    expect(opened).toEqual(['/dashboard/chat?c=abc'])
    expect(assigned).toEqual([])
    expect(trace).toMatchObject({ target: '/dashboard/chat', from: '/dashboard', landed: '/dashboard/chat', hard: false, keys: ['url', 'tag'] })
  })

  it('loads the page outright when the in-app navigation never arrives', async () => {
    const { assigned, trace } = await tapWith('/dashboard')
    expect(assigned).toEqual(['/dashboard/chat?c=abc'])
    expect(trace).toMatchObject({ landed: '/dashboard', hard: true })
  })
})

describe('notification permission', () => {
  async function phone(receive: 'prompt' | 'granted' | 'denied') {
    vi.resetModules()
    const asked = vi.fn(async () => ({ receive: 'granted' as const }))
    const registered = vi.fn(async () => {})
    ;(globalThis as unknown as { window: unknown }).window = {
      location: { pathname: '/dashboard', assign: () => {} },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {
          App: { getInfo: async () => ({ build: String(PUSH_MIN_ANDROID_BUILD) }) },
          PushNotifications: {
            checkPermissions: async () => ({ receive }),
            requestPermissions: asked,
            register: registered,
            createChannel: async () => {},
            addListener: () => ({ remove: async () => {} }),
          },
        },
      },
    }
    const mod = await import('./native-push')
    return { mod, asked, registered }
  }

  it('is never asked for just because the app opened', async () => {
    const { mod, asked, registered } = await phone('prompt')
    await mod.startNativePush(() => {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(asked).not.toHaveBeenCalled()
    expect(registered).not.toHaveBeenCalled()
    expect(await mod.nativePushState()).toBe('ask')
  })

  it('registers quietly when notifications are already allowed', async () => {
    const { mod, asked, registered } = await phone('granted')
    await mod.startNativePush(() => {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(asked).not.toHaveBeenCalled()
    expect(registered).toHaveBeenCalled()
    expect(await mod.nativePushState()).toBe('on')
  })

  it('is asked for when the person turns notifications on', async () => {
    const { mod, asked } = await phone('prompt')
    void mod.enableNativePush()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(asked).toHaveBeenCalledTimes(1)
  })

  it('reports a refusal as blocked, and does not ask again by itself', async () => {
    const { mod, asked } = await phone('denied')
    await mod.startNativePush(() => {})
    expect(await mod.nativePushState()).toBe('blocked')
    expect(asked).not.toHaveBeenCalled()
  })
})
