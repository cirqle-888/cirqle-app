import { describe, it, expect } from 'vitest'
import { subscribeAfterAuth } from './realtime-auth'

function fakeClient() {
  const log: string[] = []
  let release: () => void = () => {}
  const auth = new Promise<void>((resolve) => { release = () => { log.push('auth ready'); resolve() } })
  const client = {
    realtime: { setAuth: () => auth },
    channel: (name: string) => ({
      subscribe: () => { log.push(`join ${name}`) },
      unsubscribe: () => { log.push(`leave ${name}`) },
    }),
  }
  return { client, log, release }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('subscribeAfterAuth', () => {
  it('holds the join until the socket knows who is signed in', async () => {
    const { client, log, release } = fakeClient()
    const channel = subscribeAfterAuth(client).channel('chat' as never)
    expect(channel.subscribe()).toBe(channel) // still chainable
    await tick()
    expect(log).toEqual([])
    release()
    await tick()
    expect(log).toEqual(['auth ready', 'join chat'])
  })

  it('never joins a channel that was removed while waiting', async () => {
    const { client, log, release } = fakeClient()
    const channel = subscribeAfterAuth(client).channel('chat' as never)
    channel.subscribe()
    channel.unsubscribe()
    release()
    await tick()
    expect(log).toEqual(['leave chat', 'auth ready'])
  })

  it('still joins when the token lookup fails', async () => {
    const log: string[] = []
    const client = {
      realtime: { setAuth: () => Promise.reject(new Error('offline')) },
      channel: (name: string) => ({ subscribe: () => { log.push(`join ${name}`) }, unsubscribe: () => {} }),
    }
    subscribeAfterAuth(client).channel('chat' as never).subscribe()
    await tick()
    expect(log).toEqual(['join chat'])
  })

  it('patches a client only once', async () => {
    const { client, log, release } = fakeClient()
    subscribeAfterAuth(subscribeAfterAuth(client)).channel('chat' as never).subscribe()
    release()
    await tick()
    expect(log.filter(l => l === 'join chat')).toHaveLength(1)
  })
})
