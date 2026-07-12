import { describe, it, expect, vi } from 'vitest'
import { createSyncQueue, type QueuedOp, type SyncQueueDeps } from './engine'

/**
 * Build a queue with deterministic deps: a controllable `online` flag, an
 * in-memory persistence store, and a scheduler that CAPTURES deferred flushes
 * instead of running them (so each flush pass is driven explicitly by the test).
 */
function makeQueue(overrides: Partial<SyncQueueDeps> = {}) {
  let online = true
  let store: QueuedOp[] = []
  const scheduled: Array<{ fn: () => void; ms: number }> = []
  const deadLetters: Array<{ op: QueuedOp; error: unknown }> = []

  const deps: SyncQueueDeps = {
    isOnline: () => online,
    load: async () => store.slice(),
    persist: async (ops) => { store = ops.slice() },
    now: () => 1_000,
    genId: (() => { let n = 0; return () => `id-${++n}` })(),
    schedule: (fn, ms) => { scheduled.push({ fn, ms }) },
    onDeadLetter: (op, error) => { deadLetters.push({ op, error }) },
    backoff: (attempts) => attempts * 100,
    maxAttempts: 3,
    ...overrides,
  }
  const q = createSyncQueue(deps)
  return {
    q,
    getStore: () => store,
    scheduled,
    deadLetters,
    setOnline: (v: boolean) => { online = v },
  }
}

describe('offline sync engine', () => {
  it('runs a queued op when online and dequeues it', async () => {
    const { q, getStore } = makeQueue()
    const handler = vi.fn(async () => ({ ok: true }))
    q.register('cashbook.create', handler)

    await q.enqueue('cashbook.create', { amount: 500 })
    expect(q.size()).toBe(1)

    await q.flush()

    expect(handler).toHaveBeenCalledWith({ amount: 500 })
    expect(q.size()).toBe(0)
    expect(getStore()).toHaveLength(0)
  })

  it('holds ops while offline and drains on reconnect', async () => {
    const h = makeQueue()
    const handler = vi.fn(async () => undefined)
    h.q.register('task.create', handler)
    h.setOnline(false)

    await h.q.enqueue('task.create', { title: 'A' })
    await h.q.flush() // offline → no-op
    expect(handler).not.toHaveBeenCalled()
    expect(h.q.size()).toBe(1)

    h.setOnline(true)
    await h.q.flush()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(h.q.size()).toBe(0)
  })

  it('dequeues on a business-level rejection (resolve, do not retry)', async () => {
    const { q } = makeQueue()
    // Server responded with ok:false — it processed the request; retrying is wrong.
    const handler = vi.fn(async () => ({ ok: false, error: 'duplicate' }))
    q.register('invoice.void', handler)

    await q.enqueue('invoice.void', { id: 'inv1' })
    await q.flush()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(q.size()).toBe(0)
  })

  it('retries on a thrown transport error with backoff, then succeeds', async () => {
    const h = makeQueue()
    let calls = 0
    const handler = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error('network down')
      return { ok: true }
    })
    h.q.register('payment.record', handler)

    await h.q.enqueue('payment.record', { amt: 10 })

    await h.q.flush() // attempt 1 → throws, attempts=1, retry scheduled
    expect(h.q.size()).toBe(1)
    expect(h.q.peek()[0].attempts).toBe(1)
    expect(h.scheduled.some(s => s.ms === 100)).toBe(true)

    await h.q.flush() // attempt 2 → throws, attempts=2
    expect(h.q.peek()[0].attempts).toBe(2)

    await h.q.flush() // attempt 3 → succeeds
    expect(h.q.size()).toBe(0)
    expect(calls).toBe(3)
  })

  it('dead-letters an op after maxAttempts transport failures', async () => {
    const h = makeQueue() // maxAttempts = 3
    const handler = vi.fn(async () => { throw new Error('always fails') })
    h.q.register('sync.thing', handler)

    await h.q.enqueue('sync.thing', { x: 1 })
    await h.q.flush() // attempts=1
    await h.q.flush() // attempts=2
    expect(h.q.size()).toBe(1)
    await h.q.flush() // attempts=3 → dead-letter
    expect(h.q.size()).toBe(0)
    expect(h.deadLetters).toHaveLength(1)
    expect(h.deadLetters[0].op.name).toBe('sync.thing')
  })

  it('collapses ops sharing a dedupeKey to the newest', async () => {
    const { q } = makeQueue()
    const handler = vi.fn(async () => undefined)
    q.register('flag.toggle', handler)

    await q.enqueue('flag.toggle', { on: true }, { dedupeKey: 'flag:42' })
    await q.enqueue('flag.toggle', { on: false }, { dedupeKey: 'flag:42' })
    expect(q.size()).toBe(1)
    expect(q.peek()[0].args).toEqual({ on: false })

    await q.flush()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ on: false })
  })

  it('leaves an op queued when no handler is registered yet', async () => {
    const { q } = makeQueue()
    await q.enqueue('not.registered.yet', { a: 1 })
    await q.flush()
    expect(q.size()).toBe(1) // not dropped — waits for its handler
  })

  it('hydrates persisted ops from storage', async () => {
    const persisted: QueuedOp[] = [
      { id: 'p1', name: 'task.create', args: { title: 'restored' }, createdAt: 1, attempts: 0 },
    ]
    const { q } = makeQueue({ load: async () => persisted })
    const handler = vi.fn(async () => undefined)
    q.register('task.create', handler)

    await q.hydrate()
    expect(q.size()).toBe(1)
    await q.flush()
    expect(handler).toHaveBeenCalledWith({ title: 'restored' })
    expect(q.size()).toBe(0)
  })
})
