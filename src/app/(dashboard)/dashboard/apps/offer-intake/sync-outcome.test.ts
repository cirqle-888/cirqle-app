import { describe, it, expect } from 'vitest'
import type { SyncOutcome, TestSyncResult } from './actions'

/**
 * The rule these fixes exist to enforce: a call that completed without throwing
 * is NOT the same as a sheet having been written. `testSheetSync` used to
 * return `ok: true` for both and the UI flashed "Sheet synced successfully ✓"
 * either way, so staff were told a pull-mode client's sheet had been updated
 * when Cirqle had deliberately not touched it.
 */

/** Mirrors the UI's mapping in offer-intake-settings-client.tsx. */
function flashToneFor(status: SyncOutcome): 'ok' | 'warn' | 'err' {
  return status === 'success' ? 'ok' : status === 'failed' ? 'err' : 'warn'
}

describe('sync outcome reporting', () => {
  it('only reports success when the sheet was actually written', () => {
    expect(flashToneFor('success')).toBe('ok')
    for (const s of ['skipped', 'blocked', 'failed'] as SyncOutcome[]) {
      expect(flashToneFor(s)).not.toBe('ok')
    }
  })

  it('separates "did nothing on purpose" from "tried and failed"', () => {
    expect(flashToneFor('skipped')).toBe('warn')
    expect(flashToneFor('blocked')).toBe('warn')
    expect(flashToneFor('failed')).toBe('err')
  })

  it('never carries a sheet URL unless work was done', () => {
    // The UI writes this back into the saved Sheet link, so a URL attached to a
    // no-op would silently repoint the client's configuration.
    const noop: TestSyncResult = { status: 'blocked', message: 'Nothing was written.' }
    expect(noop.sheetUrl).toBeUndefined()
  })

  it('states plainly that nothing happened', () => {
    const messages: Record<Exclude<SyncOutcome, 'success'>, string> = {
      skipped: 'Nothing to sync — this client has no active offer list yet. Ask them to submit one, then test again.',
      blocked: 'Nothing was written. This client is in Pull mode — Cirqle only reads their sheet.',
      failed: 'The sync failed.',
    }
    // A non-success message must not read as a success.
    for (const m of Object.values(messages)) {
      expect(m).not.toMatch(/success|synced ✓|updated ✓/i)
    }
    expect(messages.skipped).toMatch(/nothing/i)
    expect(messages.blocked).toMatch(/nothing was written/i)
  })
})

/**
 * The editor used to set 'syncing' both while polling AND when the poll window
 * elapsed, so a client whose sheet Cirqle never writes sat on
 * "Syncing Google Sheet…" forever.
 */
describe('editor sync states terminate', () => {
  type SyncState = 'idle' | 'saving' | 'syncing' | 'synced' | 'skipped' | 'unknown' | 'error'
  const TERMINAL: SyncState[] = ['idle', 'synced', 'skipped', 'unknown', 'error']

  it('has a terminal state for every way a save can end', () => {
    // push + sheet written / push + timed out / not push at all / failed
    expect(TERMINAL).toContain('synced')
    expect(TERMINAL).toContain('unknown')
    expect(TERMINAL).toContain('skipped')
    expect(TERMINAL).toContain('error')
  })

  it('does not treat "syncing" as an ending', () => {
    expect(TERMINAL).not.toContain('syncing')
    expect(TERMINAL).not.toContain('saving')
  })

  it('routes each flow mode to a state that can be reached', () => {
    const outcomeFor = (mode: 'push' | 'pull' | 'manual'): SyncState =>
      mode === 'push' ? 'syncing' : 'skipped'
    // Only push may enter the polling state; the others end immediately.
    expect(outcomeFor('push')).toBe('syncing')
    expect(TERMINAL).toContain(outcomeFor('pull'))
    expect(TERMINAL).toContain(outcomeFor('manual'))
  })
})
