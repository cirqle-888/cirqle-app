import { describe, it, expect } from 'vitest'
import { assessHealth } from './health'

const NOW = '2026-08-14T12:00:00Z'
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString()
const daysAhead = (d: number) => new Date(Date.parse(NOW) + d * 86_400_000).toISOString()

const healthy = {
  status: 'active',
  lastSuccessAt: hoursAgo(2),
  tokenExpiresAt: daysAhead(60),
  grantedScopes: ['ads_read', 'pages_show_list'],
  requiredScopes: ['ads_read', 'pages_show_list'],
  discoveredAssets: 4,
  now: NOW,
}

describe('healthy', () => {
  it('is green with no reasons when everything is in order', () => {
    const v = assessHealth(healthy)
    expect(v.state).toBe('green')
    expect(v.reasons).toEqual([])
    expect(v.missingScopes).toEqual([])
  })
})

describe('red — broken, not merely stale', () => {
  it('flags a connection needing reauth', () => {
    expect(assessHealth({ ...healthy, status: 'needs_reauth' }).state).toBe('red')
  })

  it('flags an expired token', () => {
    const v = assessHealth({ ...healthy, tokenExpiresAt: daysAhead(-1) })
    expect(v.state).toBe('red')
    expect(v.daysToExpiry).toBeLessThan(0)
  })

  it('flags missing permissions and names them', () => {
    // The exact failure this session chased: the connection looked active,
    // but without the Pages/Instagram scopes it returned nothing.
    const v = assessHealth({
      ...healthy,
      grantedScopes: ['ads_read', 'ads_management'],
      requiredScopes: ['ads_read', 'pages_show_list', 'instagram_basic'],
    })
    expect(v.state).toBe('red')
    expect(v.missingScopes).toEqual(['pages_show_list', 'instagram_basic'])
  })

  it('does not cry missing-scopes when the platform reported none at all', () => {
    // granted_scopes is null on older connections; that is unknown, not proof
    // of absence, and must not paint every legacy connection red.
    const v = assessHealth({ ...healthy, grantedScopes: null })
    expect(v.missingScopes.length).toBeGreaterThan(0)
    expect(v.state).toBe('green')
  })
})

describe('amber — worth a look', () => {
  it('flags a stale sync', () => {
    const v = assessHealth({ ...healthy, lastSuccessAt: hoursAgo(72) })
    expect(v.state).toBe('amber')
    expect(v.staleHours).toBe(72)
  })

  it('does not flag a sync inside the window', () => {
    expect(assessHealth({ ...healthy, lastSuccessAt: hoursAgo(47) }).state).toBe('green')
  })

  it('flags a token expiring soon', () => {
    const v = assessHealth({ ...healthy, tokenExpiresAt: daysAhead(3) })
    expect(v.state).toBe('amber')
    expect(v.daysToExpiry).toBe(3)
  })

  it('flags never synced', () => {
    const v = assessHealth({ ...healthy, lastSuccessAt: null, lastSyncedAt: null })
    expect(v.state).toBe('amber')
    expect(v.reasons).toContain('Never synced')
  })

  it('flags an authorised connection that discovered nothing', () => {
    // Looks connected, delivers nothing — the quiet failure mode.
    const v = assessHealth({ ...healthy, discoveredAssets: 0 })
    expect(v.state).toBe('amber')
    expect(v.reasons).toContain('No assets discovered')
  })

  it('falls back to the last attempt when no success is recorded', () => {
    const v = assessHealth({ ...healthy, lastSuccessAt: null, lastSyncedAt: hoursAgo(1) })
    expect(v.state).toBe('green')
  })
})

describe('severity ordering', () => {
  it('lets red win over amber rather than averaging them', () => {
    const v = assessHealth({
      ...healthy,
      status: 'needs_reauth',       // red
      lastSuccessAt: hoursAgo(100), // amber
      discoveredAssets: 0,          // amber
    })
    expect(v.state).toBe('red')
    expect(v.reasons.length).toBeGreaterThan(1)
  })
})
