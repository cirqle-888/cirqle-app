/**
 * Pure offline mutation queue + sync engine.
 *
 * Deliberately dependency-free (no `@/lib/native`, no browser globals) so it is
 * fully unit-testable and reusable. All I/O — connectivity, persistence, timing
 * — is injected via SyncQueueDeps; the native/web adapters live in
 * `offline/index.ts`. The engine keeps the working set in memory (source of
 * truth) and mirrors it to durable storage on every change, so it still works
 * when persistence is unavailable.
 *
 * Retry contract: a handler that RESOLVES means the server responded (success
 * OR a business-level rejection) — the op is dequeued, never retried. A handler
 * that THROWS means a transport/network failure — the op stays queued, attempts
 * increments, and a backoff retry is scheduled, up to maxAttempts before it is
 * dead-lettered.
 */

export interface QueuedOp {
  id: string
  name: string
  args: unknown
  createdAt: number
  attempts: number
  /** Ops sharing a dedupeKey collapse to the newest (e.g. a toggled flag). */
  dedupeKey?: string
}

export type OpHandler = (args: unknown) => Promise<unknown>

export interface QueueState {
  size: number
  flushing: boolean
}

export interface SyncQueueDeps {
  isOnline: () => boolean | Promise<boolean>
  /** Hydrate persisted ops (returns [] if none / unavailable). */
  load: () => Promise<QueuedOp[]>
  /** Durably persist the full queue. Best-effort; may no-op. */
  persist: (ops: QueuedOp[]) => Promise<void>
  now?: () => number
  genId?: () => string
  /** Permanently dropped after maxAttempts transport failures. */
  onDeadLetter?: (op: QueuedOp, error: unknown) => void
  /** Delay before the next retry given the failed op's attempt count (1-based). */
  backoff?: (attempts: number) => number
  /** Schedule a deferred flush (injected for deterministic tests). */
  schedule?: (fn: () => void, ms: number) => void
  maxAttempts?: number
}

export interface SyncQueue {
  hydrate: () => Promise<void>
  register: (name: string, handler: OpHandler) => void
  enqueue: (name: string, args: unknown, opts?: { dedupeKey?: string }) => Promise<QueuedOp>
  flush: () => Promise<{ processed: number; remaining: number }>
  size: () => number
  peek: () => QueuedOp[]
  subscribe: (listener: (state: QueueState) => void) => () => void
  /** Notify the engine of a connectivity change; flushes on reconnect. */
  setOnline: (online: boolean) => void
}

const DEFAULT_MAX_ATTEMPTS = 8

export function createSyncQueue(deps: SyncQueueDeps): SyncQueue {
  const now = deps.now ?? (() => Date.now())
  const genId = deps.genId ?? (() => `${now()}-${Math.random().toString(36).slice(2, 10)}`)
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms) })
  const backoff = deps.backoff ?? ((attempts) => Math.min(30000, 1000 * 2 ** (attempts - 1)))
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  const handlers = new Map<string, OpHandler>()
  const listeners = new Set<(state: QueueState) => void>()
  let queue: QueuedOp[] = []
  let flushing = false
  let hydrated = false

  const notify = () => {
    const state: QueueState = { size: queue.length, flushing }
    listeners.forEach(l => { try { l(state) } catch { /* listener errors are their own problem */ } })
  }
  const save = () => { void deps.persist(queue.slice()).catch(() => {}) }

  async function hydrate() {
    if (hydrated) return
    hydrated = true
    try {
      const loaded = await deps.load()
      if (Array.isArray(loaded) && loaded.length) {
        // Merge persisted ops ahead of anything enqueued during hydration.
        queue = loaded.concat(queue)
        notify()
      }
    } catch { /* start empty */ }
  }

  function register(name: string, handler: OpHandler) {
    handlers.set(name, handler)
  }

  async function enqueue(name: string, args: unknown, opts?: { dedupeKey?: string }): Promise<QueuedOp> {
    const op: QueuedOp = {
      id: genId(), name, args, createdAt: now(), attempts: 0, dedupeKey: opts?.dedupeKey,
    }
    if (op.dedupeKey) queue = queue.filter(q => q.dedupeKey !== op.dedupeKey)
    queue.push(op)
    save()
    notify()
    // Try to drain immediately if we're online.
    schedule(() => { void flush() }, 0)
    return op
  }

  async function flush(): Promise<{ processed: number; remaining: number }> {
    if (flushing) return { processed: 0, remaining: queue.length }
    if (!(await deps.isOnline())) return { processed: 0, remaining: queue.length }

    flushing = true
    notify()
    let processed = 0
    let scheduledRetry = false

    // FIFO snapshot; removals are by id so concurrent enqueues are safe.
    const snapshot = queue.slice()
    for (const op of snapshot) {
      const handler = handlers.get(op.name)
      if (!handler) continue // no handler registered yet — leave for later

      try {
        await handler(op.args)
        queue = queue.filter(q => q.id !== op.id) // server responded → dequeue
        processed++
        save()
      } catch (err) {
        op.attempts++
        if (op.attempts >= maxAttempts) {
          queue = queue.filter(q => q.id !== op.id)
          save()
          try { deps.onDeadLetter?.(op, err) } catch { /* ignore */ }
        } else {
          save()
          // Transport failure — likely offline now. Stop and back off.
          schedule(() => { void flush() }, backoff(op.attempts))
          scheduledRetry = true
        }
        break
      }
    }

    flushing = false
    notify()

    // Anything still queued with a registered handler and no retry scheduled
    // (e.g. handler registered after enqueue) gets another near-term attempt.
    if (!scheduledRetry && queue.some(q => handlers.has(q.name))) {
      schedule(() => { void flush() }, backoff(1))
    }
    return { processed, remaining: queue.length }
  }

  function setOnline(online: boolean) {
    if (online && queue.length) schedule(() => { void flush() }, 0)
  }

  return {
    hydrate,
    register,
    enqueue,
    flush,
    size: () => queue.length,
    peek: () => queue.slice(),
    subscribe: (listener) => {
      listeners.add(listener)
      listener({ size: queue.length, flushing })
      return () => { listeners.delete(listener) }
    },
    setOnline,
  }
}
