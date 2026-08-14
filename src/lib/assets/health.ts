/**
 * Connection and asset health, as one verdict.
 *
 * Pure so the thresholds are testable and identical everywhere they are shown.
 * Three states only — an owner needs to know "fine / look at it / it's broken",
 * not a score.
 */

export type HealthState = 'green' | 'amber' | 'red'

export const HEALTH_LABEL: Record<HealthState, string> = {
  green: 'Healthy',
  amber: 'Attention',
  red: 'Error',
}

export interface ConnectionHealthInput {
  status?: string | null
  /** ISO timestamp of the last sync attempt, successful or not. */
  lastSyncedAt?: string | null
  /** ISO timestamp of the last sync that actually succeeded. */
  lastSuccessAt?: string | null
  lastError?: string | null
  /** ISO timestamp the access token expires. */
  tokenExpiresAt?: string | null
  /** Permissions the platform actually granted. */
  grantedScopes?: string[] | null
  /** Permissions this integration needs to function. */
  requiredScopes?: string[]
  /** How many assets this connection has discovered. */
  discoveredAssets?: number
  /** ISO 'now', passed in so the verdict is reproducible in tests. */
  now?: string
}

export interface HealthVerdict {
  state: HealthState
  /** Short, specific reasons — the UI lists them; the worst drives `state`. */
  reasons: string[]
  missingScopes: string[]
  /** Whole days until the token expires; null when unknown. Negative = expired. */
  daysToExpiry: number | null
  staleHours: number | null
}

const DAY = 86_400_000
const HOUR = 3_600_000

/** Sync older than this is suspicious; the daily crons run well inside it. */
const STALE_HOURS = 48
/** Below this, a token needs renewing before it silently breaks everything. */
const EXPIRY_WARN_DAYS = 7

export function assessHealth(input: ConnectionHealthInput): HealthVerdict {
  const now = input.now ? Date.parse(input.now) : Date.now()
  const reasons: string[] = []
  let state: HealthState = 'green'
  const worsen = (s: HealthState) => {
    if (s === 'red' || state === 'red') state = s === 'red' ? 'red' : state
    if (s === 'red') state = 'red'
    else if (s === 'amber' && state === 'green') state = 'amber'
  }

  // ── Hard failures ──────────────────────────────────────────────────────────
  if (input.status === 'revoked' || input.status === 'error' || input.status === 'needs_reauth') {
    reasons.push(input.status === 'needs_reauth' ? 'Needs reconnecting' : 'Connection reported an error')
    worsen('red')
  }
  if (input.status === 'disconnected') {
    reasons.push('Disconnected')
    worsen('red')
  }

  // ── Missing permissions ────────────────────────────────────────────────────
  // A missing scope is not cosmetic: it is exactly why Pages and Instagram
  // silently returned nothing while the connection looked "active".
  const granted = new Set(input.grantedScopes ?? [])
  const missingScopes = (input.requiredScopes ?? []).filter(s => !granted.has(s))
  if (missingScopes.length && (input.grantedScopes?.length ?? 0) > 0) {
    reasons.push(`Missing ${missingScopes.length} permission${missingScopes.length === 1 ? '' : 's'}`)
    worsen('red')
  }

  // ── Token expiry ───────────────────────────────────────────────────────────
  let daysToExpiry: number | null = null
  if (input.tokenExpiresAt) {
    const t = Date.parse(input.tokenExpiresAt)
    if (Number.isFinite(t)) {
      daysToExpiry = Math.floor((t - now) / DAY)
      if (daysToExpiry < 0) { reasons.push('Token expired'); worsen('red') }
      else if (daysToExpiry <= EXPIRY_WARN_DAYS) {
        reasons.push(`Token expires in ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}`)
        worsen('amber')
      }
    }
  }

  // ── Freshness ──────────────────────────────────────────────────────────────
  let staleHours: number | null = null
  const lastOk = input.lastSuccessAt ?? input.lastSyncedAt
  if (!lastOk) {
    reasons.push('Never synced')
    worsen('amber')
  } else {
    const t = Date.parse(lastOk)
    if (Number.isFinite(t)) {
      staleHours = Math.floor((now - t) / HOUR)
      if (staleHours > STALE_HOURS) {
        reasons.push(`Last successful sync ${Math.floor(staleHours / 24)}d ago`)
        worsen('amber')
      }
    }
  }

  // A recorded error that did not already set 'red'.
  if (input.lastError) {
    reasons.push(input.lastError.slice(0, 120))
    worsen('amber')
  }

  // ── Nothing discovered ─────────────────────────────────────────────────────
  // An authorised connection that found no assets is the quiet failure mode:
  // it looks connected and delivers nothing.
  if (input.discoveredAssets === 0) {
    reasons.push('No assets discovered')
    worsen('amber')
  }

  return { state, reasons, missingScopes, daysToExpiry, staleHours }
}
