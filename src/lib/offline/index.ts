/**
 * Offline mutation queue — public API.
 *
 * Binds the pure engine (engine.ts) to real adapters: @capacitor/preferences /
 * localStorage for durability and @capacitor/network / navigator.onLine for
 * connectivity. Exposes an adoption surface that wraps existing Server Actions
 * WITHOUT modifying them:
 *
 *   registerOfflineOp('cashbook.create', createCashbookEntry)   // once, at boot
 *   const { queued } = await runOrQueue('cashbook.create', args) // at call site
 *
 * When online, runOrQueue runs the action immediately. When offline (or the
 * action throws a transport error), it persists the op and returns so the UI can
 * show an optimistic result; the engine replays it automatically on reconnect.
 * Business-logic and server actions are untouched — this is a pure wrapper.
 *
 * SSR-safe: all browser/plugin access is lazy and guarded. On web/desktop the
 * queue still works (localStorage + navigator.onLine); it simply rarely has
 * anything to hold because the browser is usually online.
 */
import { createSyncQueue, type OpHandler, type QueueState, type QueuedOp } from './engine'
import { storageGet, storageSet } from './storage'
import { isOnlineCached, checkOnline, onNetworkChange } from './network'

const QUEUE_KEY = 'cirqle:offline:queue:v1'

// Local mirror of registered handlers so runOrQueue can invoke them directly
// when online (the engine only invokes them during a flush).
const handlers = new Map<string, OpHandler>()

const queue = createSyncQueue({
  isOnline: isOnlineCached,
  load: async () => {
    const raw = await storageGet(QUEUE_KEY)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as QueuedOp[]) : []
    } catch { return [] }
  },
  persist: async (ops) => { await storageSet(QUEUE_KEY, JSON.stringify(ops)) },
  onDeadLetter: (op, err) => {
    // Surfaced for observability; the op is already dropped.
    if (typeof console !== 'undefined') {
      console.warn('[offline] dropped op after max retries:', op.name, err)
    }
  },
})

let initialized = false
function ensureInit() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  void queue.hydrate().then(() => { void queue.flush() })
  void checkOnline().then(online => queue.setOnline(online))
  onNetworkChange(online => queue.setOnline(online))
}

/**
 * Register an offline-capable operation. Call once (e.g. from a boot module)
 * per mutation you want to survive offline. The handler is typically an existing
 * Server Action; it is never modified.
 */
export function registerOfflineOp<A>(name: string, handler: (args: A) => Promise<unknown>): void {
  const h = handler as OpHandler
  handlers.set(name, h)
  queue.register(name, h)
  ensureInit()
}

export interface RunOrQueueResult<T> {
  /** True if the op was persisted for later instead of completing now. */
  queued: boolean
  /** The action's result when it ran online; the optimistic value when queued. */
  result?: T
}

/**
 * Run a registered op now if online; otherwise (or on a transport failure)
 * persist it and return the optimistic value. Never throws for connectivity
 * reasons — business errors from the action still reject as usual when online.
 */
export async function runOrQueue<T = unknown>(
  name: string,
  args: unknown,
  opts?: { dedupeKey?: string; optimistic?: T },
): Promise<RunOrQueueResult<T>> {
  ensureInit()
  const handler = handlers.get(name)
  if (!handler) throw new Error(`Offline op "${name}" is not registered`)

  if (isOnlineCached()) {
    try {
      const result = (await handler(args)) as T
      return { queued: false, result }
    } catch (err) {
      // Only queue transport failures; re-throw anything that looks like a real
      // application error so callers can handle it (validation, auth, etc.).
      if (!isTransportError(err)) throw err
      await queue.enqueue(name, args, { dedupeKey: opts?.dedupeKey })
      return { queued: true, result: opts?.optimistic }
    }
  }

  await queue.enqueue(name, args, { dedupeKey: opts?.dedupeKey })
  return { queued: true, result: opts?.optimistic }
}

/** Explicitly enqueue without attempting an immediate run. */
export async function enqueueMutation(
  name: string,
  args: unknown,
  opts?: { dedupeKey?: string },
): Promise<void> {
  ensureInit()
  await queue.enqueue(name, args, opts)
}

/** Subscribe to queue state (size + flushing) for a status indicator. */
export function subscribeQueue(listener: (state: QueueState) => void): () => void {
  ensureInit()
  return queue.subscribe(listener)
}

/** Force a drain attempt (e.g. a manual "retry now" button). */
export function flushQueue(): Promise<{ processed: number; remaining: number }> {
  ensureInit()
  return queue.flush()
}

/**
 * Subscribe to online/offline transitions. Emits the current value immediately.
 * Returns an unsubscribe function.
 */
export function subscribeOnline(listener: (online: boolean) => void): () => void {
  ensureInit()
  listener(isOnlineCached())
  void checkOnline().then(listener)
  return onNetworkChange(listener)
}

/**
 * Heuristic: a failed fetch/Server Action call caused by connectivity throws a
 * TypeError ("Failed to fetch" / "Load failed" / "NetworkError"), unlike an
 * application error which the action returns as data. We only queue the former.
 */
function isTransportError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('failed to fetch')
    || msg.includes('load failed')
    || msg.includes('network')
    || msg.includes('fetch failed')
}
