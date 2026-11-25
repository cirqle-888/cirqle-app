import { describe, it, expect, afterEach } from 'vitest'
import { federationFromEnv, federationAudience, serviceAccountFromEnv, vercelOidcToken } from './google-auth'

const full = {
  GCP_PROJECT_ID: 'demo-project',
  GCP_PROJECT_NUMBER: '123456789',
  GCP_SERVICE_ACCOUNT_EMAIL: 'sender@demo-project.iam.gserviceaccount.com',
  GCP_WORKLOAD_IDENTITY_POOL_ID: 'vercel',
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: 'vercel',
}

describe('federationFromEnv', () => {
  it('reads the five identifiers', () => {
    expect(federationFromEnv(full)).toEqual({
      projectId: 'demo-project',
      projectNumber: '123456789',
      serviceAccount: 'sender@demo-project.iam.gserviceaccount.com',
      pool: 'vercel',
      provider: 'vercel',
    })
  })

  it('trims stray whitespace from a pasted value', () => {
    expect(federationFromEnv({ ...full, GCP_PROJECT_NUMBER: ' 123456789\n' })?.projectNumber).toBe('123456789')
  })

  it('is off unless every identifier is present', () => {
    for (const key of Object.keys(full)) {
      expect(federationFromEnv({ ...full, [key]: undefined })).toBeNull()
      expect(federationFromEnv({ ...full, [key]: '  ' })).toBeNull()
    }
    expect(federationFromEnv({})).toBeNull()
  })
})

describe('federationAudience', () => {
  it('names the provider the way Google expects', () => {
    expect(federationAudience(federationFromEnv(full)!)).toBe(
      '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel',
    )
  })
})

describe('serviceAccountFromEnv', () => {
  const sa = { project_id: 'demo-project', client_email: 'a@b.c', private_key: 'line1\\nline2' }

  it('accepts the JSON itself or its base64, and restores the key line breaks', () => {
    const json = JSON.stringify(sa)
    expect(serviceAccountFromEnv({ FCM_SERVICE_ACCOUNT: json })?.private_key).toBe('line1\nline2')
    expect(serviceAccountFromEnv({ FCM_SERVICE_ACCOUNT: Buffer.from(json).toString('base64') })?.project_id).toBe('demo-project')
  })

  it('is off when missing, malformed or incomplete', () => {
    expect(serviceAccountFromEnv({})).toBeNull()
    expect(serviceAccountFromEnv({ FCM_SERVICE_ACCOUNT: 'not json' })).toBeNull()
    expect(serviceAccountFromEnv({ FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'x' }) })).toBeNull()
  })
})

describe('vercelOidcToken', () => {
  const key = Symbol.for('@vercel/request-context')
  const g = globalThis as Record<symbol, unknown>
  const before = process.env.VERCEL_OIDC_TOKEN

  afterEach(() => {
    delete g[key]
    if (before === undefined) delete process.env.VERCEL_OIDC_TOKEN
    else process.env.VERCEL_OIDC_TOKEN = before
  })

  it('prefers the running request, then the environment', () => {
    process.env.VERCEL_OIDC_TOKEN = 'from-env'
    expect(vercelOidcToken()).toBe('from-env')
    g[key] = { get: () => ({ headers: { 'x-vercel-oidc-token': 'from-request' } }) }
    expect(vercelOidcToken()).toBe('from-request')
  })

  it('is null when Vercel supplied nothing', () => {
    delete process.env.VERCEL_OIDC_TOKEN
    expect(vercelOidcToken()).toBeNull()
    g[key] = { get: () => undefined }
    expect(vercelOidcToken()).toBeNull()
  })
})
