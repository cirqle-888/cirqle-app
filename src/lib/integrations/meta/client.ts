/**
 * Central Meta Graph API client.
 *
 * Every Meta HTTP call in Cirqle must go through this module so that:
 *  - the API version is pinned in exactly ONE place (META_API_VERSION),
 *  - appsecret_proof is attached to every request (Meta server-to-server best practice),
 *  - errors are normalized into MetaApiError with the Graph error code/subcode,
 *  - transient errors + rate limits are retried with exponential backoff,
 *  - cursor pagination is handled consistently,
 *  - tokens never appear in thrown error messages or logs.
 *
 * Verified against Meta docs, Aug 2026: current Graph/Marketing API version is v26.0
 * (released 2026-07-29). v19.0 was sunset on 2026-05-21.
 */

import { createHmac } from 'crypto'

/** Single source of truth for the pinned Graph API version. */
export const META_API_VERSION = process.env.META_API_VERSION || 'v26.0'

export const GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`
export const FACEBOOK_URL = `https://www.facebook.com/${META_API_VERSION}`

/** Graph error codes that are worth retrying (transient / throttling). */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006])

export class MetaApiError extends Error {
  readonly code: number | null
  readonly subcode: number | null
  readonly type: string | null
  readonly fbtraceId: string | null
  readonly httpStatus: number
  readonly isRateLimit: boolean
  readonly isAuthError: boolean

  constructor(httpStatus: number, body: any) {
    const err = body?.error ?? {}
    // Never include the raw URL/token in the message.
    super(err.error_user_msg || err.message || `Meta API error (HTTP ${httpStatus})`)
    this.name = 'MetaApiError'
    this.httpStatus = httpStatus
    this.code = typeof err.code === 'number' ? err.code : null
    this.subcode = typeof err.error_subcode === 'number' ? err.error_subcode : null
    this.type = err.type ?? null
    this.fbtraceId = err.fbtrace_id ?? null
    this.isRateLimit = this.code !== null && [4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004].includes(this.code)
    // 190 = invalid/expired token; 102 = session; 10/200-299 = permission errors
    this.isAuthError =
      this.code === 190 ||
      this.code === 102 ||
      this.code === 10 ||
      (this.code !== null && this.code >= 200 && this.code <= 299)
  }
}

export function metaAppCredentials(): { appId: string; appSecret: string } | null {
  const appId = process.env.META_APP_ID || process.env.META_CLIENT_ID
  const appSecret = process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET
  if (!appId || !appSecret) return null
  return { appId, appSecret }
}

/** HMAC-SHA256 of the access token with the app secret — required for server calls. */
export function appSecretProof(accessToken: string): string | null {
  const creds = metaAppCredentials()
  if (!creds) return null
  return createHmac('sha256', creds.appSecret).update(accessToken).digest('hex')
}

export interface MetaRequestOptions {
  /** Access token (user / page / system-user). Omit only for app-token-less endpoints. */
  token?: string
  /** Query params. Objects/arrays are JSON-stringified. */
  params?: Record<string, string | number | boolean | object | undefined | null>
  method?: 'GET' | 'POST' | 'DELETE'
  /** POST body params (form-encoded, the Graph convention). */
  body?: Record<string, string | number | boolean | object | undefined | null>
  /** Max retry attempts for transient errors (default 3). */
  retries?: number
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number
}

function serializeParams(
  params: Record<string, string | number | boolean | object | undefined | null> | undefined,
  search: URLSearchParams,
) {
  if (!params) return
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') search.set(key, JSON.stringify(value))
    else search.set(key, String(value))
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Perform a Graph API request. `path` is relative to the versioned root,
 * e.g. `me/adaccounts`, `act_123/insights`, `${igUserId}/media`.
 * A fully-qualified https:// URL (a `paging.next` link) is used verbatim.
 */
export async function metaGraph<T = any>(path: string, options: MetaRequestOptions = {}): Promise<T> {
  const { token, params, method = 'GET', body, retries = 3, timeoutMs = 30_000 } = options

  let url: URL
  if (path.startsWith('https://')) {
    url = new URL(path)
  } else {
    url = new URL(`${GRAPH_URL}/${path.replace(/^\//, '')}`)
  }
  serializeParams(params, url.searchParams)
  if (token) {
    url.searchParams.set('access_token', token)
    const proof = appSecretProof(token)
    if (proof) url.searchParams.set('appsecret_proof', proof)
  }

  let form: URLSearchParams | undefined
  if (body) {
    form = new URLSearchParams()
    serializeParams(body, form)
  }

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 2s, 8s, 30s (+ jitter) — rate-limit guidance is to back off fully.
      const base = [2_000, 8_000, 30_000][Math.min(attempt - 1, 2)]
      await sleep(base + Math.floor(Math.random() * 500))
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let res: Response
      try {
        res = await fetch(url.toString(), {
          method,
          body: form,
          signal: controller.signal,
          headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
        })
      } finally {
        clearTimeout(timer)
      }

      const json = await res.json().catch(() => ({}))
      if (res.ok) return json as T

      const apiError = new MetaApiError(res.status, json)
      const retryable = apiError.isRateLimit || (apiError.code !== null && RETRYABLE_CODES.has(apiError.code)) || res.status >= 500
      if (retryable && attempt < retries) {
        lastError = apiError
        continue
      }
      throw apiError
    } catch (err) {
      if (err instanceof MetaApiError) throw err
      // Network / abort errors are retryable.
      lastError = err
      if (attempt >= retries) {
        throw new Error(`Meta API request failed: ${err instanceof Error ? err.message : 'network error'}`)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Meta API request failed')
}

/**
 * Fetch all pages of a cursor-paginated edge. Caps at `maxPages` defensively.
 */
export async function metaGraphAll<T = any>(
  path: string,
  options: MetaRequestOptions & { maxPages?: number } = {},
): Promise<T[]> {
  const { maxPages = 50, ...rest } = options
  const out: T[] = []
  let next: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const res: { data?: T[]; paging?: { next?: string } } = next
      ? await metaGraph(next, { retries: rest.retries, timeoutMs: rest.timeoutMs })
      : await metaGraph(path, rest)
    if (Array.isArray(res.data)) out.push(...res.data)
    next = res.paging?.next ?? null
    if (!next) break
  }
  return out
}

/**
 * Exchange any valid user token (short- or long-lived) for a fresh long-lived
 * user token (~60 days). This is Meta's supported "refresh" path — it works as
 * long as the presented token is still valid, which is why the token-refresh
 * cron runs while tokens are ~7 days from expiry.
 */
export async function exchangeForLongLivedToken(
  token: string,
): Promise<{ access_token: string; expires_in?: number }> {
  const creds = metaAppCredentials()
  if (!creds) throw new Error('Meta OAuth not configured (META_APP_ID / META_APP_SECRET missing)')
  return metaGraph('oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: creds.appId,
      client_secret: creds.appSecret,
      fb_exchange_token: token,
    },
  })
}

/** Redact anything that looks like a token from free-form error text before storing it. */
export function redactTokens(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(/access_token=[^&\s"']+/gi, 'access_token=REDACTED').replace(/EAA[0-9A-Za-z]+/g, 'EAA…REDACTED')
}
