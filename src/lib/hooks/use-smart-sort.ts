'use client'

// ─── Smart Sort Utility ───────────────────────────────────────────────────────
// Tracks per-item usage (count + lastUsed) in localStorage keyed by `sortKey`.
// Sort order: recently used → frequently used → never used (alphabetical).

const STORE_PREFIX = 'cq_smart_'
const RECENT_MS    = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface SortEntry { count: number; lastUsed: string }

/** Read raw usage map from localStorage (safe — returns {} on any error) */
export function readSortData(sortKey: string): Record<string, SortEntry> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORE_PREFIX + sortKey)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

/** Increment usage count + lastUsed for one item */
export function trackUsage(sortKey: string, id: string) {
  if (!sortKey || !id || typeof window === 'undefined') return
  try {
    const data = readSortData(sortKey)
    data[id] = { count: (data[id]?.count || 0) + 1, lastUsed: new Date().toISOString() }
    localStorage.setItem(STORE_PREFIX + sortKey, JSON.stringify(data))
  } catch {}
}

/**
 * Seed sort data from server-side task history WITHOUT overwriting real user clicks.
 * Call this once on component mount (client-side only).
 * tasks: array of { clientId, serviceId, taskDate, createdAt }
 */
export function seedFromTasks(
  tasks: Array<{ clientId?: string; serviceId?: string; taskDate?: string; createdAt?: string }>
) {
  if (typeof window === 'undefined') return

  const clientData: Record<string, SortEntry> = readSortData('clients')
  const serviceData: Record<string, SortEntry> = readSortData('services')

  // Process tasks newest-first so lastUsed is the most recent task date
  const sorted = [...tasks].sort((a, b) =>
    (b.taskDate || b.createdAt || '').localeCompare(a.taskDate || a.createdAt || '')
  )

  for (const t of sorted) {
    // Only seed if no real user-click data exists yet (count === 0 or undefined)
    if (t.clientId) {
      const existing = clientData[t.clientId]
      const taskTs = t.taskDate || t.createdAt || new Date().toISOString()
      if (!existing) {
        clientData[t.clientId] = { count: 1, lastUsed: taskTs }
      } else {
        // Augment count but never push lastUsed further than real clicks
        clientData[t.clientId] = {
          count: existing.count + 1,
          lastUsed: existing.lastUsed > taskTs ? existing.lastUsed : taskTs,
        }
      }
    }
    if (t.serviceId) {
      const existing = serviceData[t.serviceId]
      const taskTs = t.taskDate || t.createdAt || new Date().toISOString()
      if (!existing) {
        serviceData[t.serviceId] = { count: 1, lastUsed: taskTs }
      } else {
        serviceData[t.serviceId] = {
          count: existing.count + 1,
          lastUsed: existing.lastUsed > taskTs ? existing.lastUsed : taskTs,
        }
      }
    }
  }

  try {
    localStorage.setItem(STORE_PREFIX + 'clients', JSON.stringify(clientData))
    localStorage.setItem(STORE_PREFIX + 'services', JSON.stringify(serviceData))
  } catch {}
}

export type SortBadge = 'recent' | 'frequent' | undefined

/** Sort options by smart order and tag each with a badge */
export function smartSort<T extends { id: string; label: string }>(
  options: T[],
  data: Record<string, SortEntry>,
): Array<T & { _badge: SortBadge }> {
  const now = Date.now()
  const recent:   Array<T & { _badge: SortBadge }> = []
  const frequent: Array<T & { _badge: SortBadge }> = []
  const unused:   Array<T & { _badge: SortBadge }> = []

  for (const opt of options) {
    const e = data[opt.id]
    if (!e) { unused.push({ ...opt, _badge: undefined }); continue }
    const age = now - new Date(e.lastUsed).getTime()
    if (age <= RECENT_MS) recent.push({ ...opt, _badge: 'recent' as const })
    else                  frequent.push({ ...opt, _badge: 'frequent' as const })
  }

  recent.sort((a, b) => data[b.id].lastUsed.localeCompare(data[a.id].lastUsed))
  frequent.sort((a, b) => {
    const d = (data[b.id]?.count || 0) - (data[a.id]?.count || 0)
    return d !== 0 ? d : a.label.localeCompare(b.label)
  })
  unused.sort((a, b) => a.label.localeCompare(b.label))

  return [...recent, ...frequent, ...unused]
}
