/**
 * A short-lived Google access token for Firebase Cloud Messaging.
 *
 * Two ways in, tried in this order:
 *
 * 1. KEYLESS (what production uses). Vercel hands every function a signed
 *    identity token saying "this is the cirqle-app project, production". Google
 *    is told once to trust that statement (a workload identity pool), exchanges
 *    it for a token of its own, and that token is allowed to act as the Firebase
 *    service account. No secret is stored anywhere — which matters because the
 *    cirqle.work Google organisation blocks downloadable service-account keys.
 *    Needs GCP_PROJECT_ID, GCP_PROJECT_NUMBER, GCP_SERVICE_ACCOUNT_EMAIL,
 *    GCP_WORKLOAD_IDENTITY_POOL_ID and GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID —
 *    identifiers, not secrets.
 *
 * 2. KEY. A service-account JSON in FCM_SERVICE_ACCOUNT, for a host that has no
 *    identity token of its own.
 *
 * With neither configured this returns null and nothing is sent. No SDK: both
 * routes are a couple of HTTPS calls. Setup is in docs/MOBILE_NATIVE.md.
 */

import 'server-only'
import { createSign } from 'node:crypto'

export interface FcmAccess { projectId: string; token: string }

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const TIMEOUT_MS = 8000

// ── keyless ────────────────────────────────────────────────────────────────

export interface Federation {
  projectId: string
  projectNumber: string
  serviceAccount: string
  pool: string
  provider: string
}

/** The keyless settings, or null unless every one of them is present. */
export function federationFromEnv(env: Record<string, string | undefined> = process.env): Federation | null {
  const f = {
    projectId: env.GCP_PROJECT_ID?.trim(),
    projectNumber: env.GCP_PROJECT_NUMBER?.trim(),
    serviceAccount: env.GCP_SERVICE_ACCOUNT_EMAIL?.trim(),
    pool: env.GCP_WORKLOAD_IDENTITY_POOL_ID?.trim(),
    provider: env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID?.trim(),
  }
  if (!f.projectId || !f.projectNumber || !f.serviceAccount || !f.pool || !f.provider) return null
  return f as Federation
}

/** The name Google knows the Vercel identity provider by. */
export function federationAudience(f: Federation): string {
  return `//iam.googleapis.com/projects/${f.projectNumber}/locations/global/workloadIdentityPools/${f.pool}/providers/${f.provider}`
}

/**
 * Vercel's identity token for the running function. At runtime it arrives as
 * the `x-vercel-oidc-token` request header, which Vercel exposes through its
 * request context (the same place @vercel/oidc reads it); during a build, and
 * locally after `vercel env pull`, it is the VERCEL_OIDC_TOKEN variable.
 */
export function vercelOidcToken(): string | null {
  try {
    const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
      | { get?: () => { headers?: Record<string, string | undefined> } | undefined }
      | undefined
    const fromRequest = ctx?.get?.()?.headers?.['x-vercel-oidc-token']
    if (fromRequest) return fromRequest
  } catch { /* no request context — fall through */ }
  return process.env.VERCEL_OIDC_TOKEN || null
}

async function googleError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const j = JSON.parse(text) as { error_description?: string; error?: string | { message?: string } }
    const msg = j.error_description ?? (typeof j.error === 'string' ? j.error : j.error?.message)
    if (msg) return `${res.status} ${msg}`
  } catch { /* not JSON */ }
  return `${res.status} ${text.slice(0, 200)}`
}

async function keylessToken(f: Federation): Promise<{ token: string; expires: number }> {
  const identity = vercelOidcToken()
  if (!identity) throw new Error('no Vercel identity token on this request (is OIDC federation on for the project?)')

  // 1. Google swaps Vercel's identity token for a Google one.
  const sts = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: federationAudience(f),
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: identity,
    }),
  })
  if (!sts.ok) throw new Error(`Google refused the Vercel identity: ${await googleError(sts)}`)
  const federated = (await sts.json() as { access_token?: string }).access_token
  if (!federated) throw new Error('Google returned no token for the Vercel identity')

  // 2. That token is allowed to act as the Firebase service account, for messaging only.
  const imp = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(f.serviceAccount)}:generateAccessToken`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${federated}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ scope: [FCM_SCOPE] }),
    },
  )
  if (!imp.ok) throw new Error(`could not act as the Firebase service account: ${await googleError(imp)}`)
  const out = await imp.json() as { accessToken?: string; expireTime?: string }
  if (!out.accessToken) throw new Error('Google returned no access token for the service account')
  const expires = out.expireTime ? Math.floor(Date.parse(out.expireTime) / 1000) : Math.floor(Date.now() / 1000) + 3600
  return { token: out.accessToken, expires }
}

// ── key ────────────────────────────────────────────────────────────────────

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

/** The service account in FCM_SERVICE_ACCOUNT (the JSON itself or its base64), or null. */
export function serviceAccountFromEnv(env: Record<string, string | undefined> = process.env): ServiceAccount | null {
  const raw = env.FCM_SERVICE_ACCOUNT
  if (!raw) return null
  try {
    // A multi-line key is awkward in some env editors, so base64 is accepted too.
    const parsed = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as Partial<ServiceAccount>
    if (parsed.project_id && parsed.client_email && parsed.private_key) {
      return { project_id: parsed.project_id, client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, '\n') }
    }
  } catch { /* malformed — stays off */ }
  return null
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url')

async function keyToken(sa: ServiceAccount): Promise<{ token: string; expires: number }> {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Google refused the service-account key: ${await googleError(res)}`)
  const json = await res.json() as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('Google returned no token for the service-account key')
  return { token: json.access_token, expires: now + (json.expires_in ?? 3600) }
}

// ── one door ───────────────────────────────────────────────────────────────

let cached: { token: string; expires: number } | null = null
// After a failure, wait before asking Google again: a misconfiguration would
// otherwise cost two refused calls (and a log line) for every notification.
let quietUntil = 0
const RETRY_AFTER_S = 300

/**
 * Where to send and the token to send with, or null when push to the phone
 * apps is not configured or Google will not issue a token right now. Never
 * throws; a refusal is logged once per retry window, without any token in it.
 */
export async function fcmAccess(): Promise<FcmAccess | null> {
  const federation = federationFromEnv()
  const account = federation ? null : serviceAccountFromEnv()
  const projectId = federation?.projectId ?? account?.project_id
  if (!projectId) return null

  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.expires - 60 > now) return { projectId, token: cached.token }
  if (now < quietUntil) return null
  try {
    cached = federation ? await keylessToken(federation) : await keyToken(account!)
    return { projectId, token: cached.token }
  } catch (e) {
    cached = null
    quietUntil = now + RETRY_AFTER_S
    console.warn(`[push] phone-app push is off for ${RETRY_AFTER_S / 60} min: ${e instanceof Error ? e.message : 'unknown error'}`)
    return null
  }
}
