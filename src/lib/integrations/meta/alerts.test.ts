import { describe, expect, it, vi } from 'vitest'

// alerts.ts imports the notification writer, which pulls in server-only push.
vi.mock('@/lib/notifications/create', () => ({ notifyAdmins: vi.fn() }))

import { alertEpisodeOf } from './alerts'

describe('alertEpisodeOf', () => {
  it('drops the day so one breach maps to one episode', () => {
    expect(alertEpisodeOf('alert:reach_drop_pct:abc-123:2026-09-28'))
      .toBe(alertEpisodeOf('alert:reach_drop_pct:abc-123:2026-10-03'))
    expect(alertEpisodeOf('alert:reach_drop_pct:abc-123:2026-10-03')).toBe('reach_drop_pct:abc-123')
  })

  it('keeps metrics and clients apart', () => {
    expect(alertEpisodeOf('alert:cpl_above:abc-123:2026-10-03'))
      .not.toBe(alertEpisodeOf('alert:reach_drop_pct:abc-123:2026-10-03'))
    expect(alertEpisodeOf('alert:reach_drop_pct:abc-123:2026-10-03'))
      .not.toBe(alertEpisodeOf('alert:reach_drop_pct:xyz-789:2026-10-03'))
  })

  it('ignores keys that are not performance alerts', () => {
    expect(alertEpisodeOf('payroll_draft:2026-06')).toBeNull()
    expect(alertEpisodeOf(null)).toBeNull()
    expect(alertEpisodeOf(undefined)).toBeNull()
  })
})
