import { describe, it, expect } from 'vitest'
import {
  ownerTypeOf, belongsToClient, isCirqleOwned, isUnassigned, isManuallyAssigned,
  resolveDiscoveredOwner, forClient, forCirqle, unassignedOnly,
  partitionByOwner, requiresConfirmation,
} from './ownership'
import type { OwnedAsset } from './ownership'

const CLIENT_A = 'client-a'
const CLIENT_B = 'client-b'

const asset = (over: Partial<OwnedAsset> = {}): OwnedAsset => ({
  owner_type: 'client', client_id: CLIENT_A, assigned_at: null, ...over,
})

describe('ownerTypeOf', () => {
  it('defaults to client, so rows written before this feature read unchanged', () => {
    expect(ownerTypeOf({ client_id: CLIENT_A })).toBe('client')
    expect(ownerTypeOf({ owner_type: null, client_id: CLIENT_A })).toBe('client')
  })

  it('treats an unrecognised value as unassigned — an unknown owner fails CLOSED', () => {
    // The dangerous alternative is defaulting to 'client', which would put a
    // corrupt row into whichever client's report its client_id points at.
    expect(ownerTypeOf({ owner_type: 'garbage', client_id: CLIENT_A })).toBe('unassigned')
    expect(ownerTypeOf({ owner_type: 'CLIENT', client_id: CLIENT_A })).toBe('unassigned')
  })
})

describe('client data isolation', () => {
  it('shows a client only its own assets', () => {
    expect(belongsToClient(asset({ client_id: CLIENT_A }), CLIENT_A)).toBe(true)
    expect(belongsToClient(asset({ client_id: CLIENT_B }), CLIENT_A)).toBe(false)
  })

  it('NEVER shows a Cirqle-owned asset to a client — even one carrying that client id', () => {
    // The exact leak this feature exists to prevent: an asset that used to
    // belong to a client, later reclassified as Cirqle's, keeps its old
    // client_id. owner_type must win.
    const reclassified = asset({ owner_type: 'cirqle', client_id: CLIENT_A })
    expect(belongsToClient(reclassified, CLIENT_A)).toBe(false)
    expect(isCirqleOwned(reclassified)).toBe(true)
  })

  it('never shows an unassigned asset to a client, even with a client id', () => {
    const pending = asset({ owner_type: 'unassigned', client_id: CLIENT_A })
    expect(belongsToClient(pending, CLIENT_A)).toBe(false)
    expect(isUnassigned(pending)).toBe(true)
  })

  it('refuses a blank or missing client id rather than matching everything', () => {
    expect(belongsToClient(asset(), '')).toBe(false)
    expect(belongsToClient(asset({ client_id: null }), CLIENT_A)).toBe(false)
    expect(belongsToClient(asset({ client_id: undefined }), CLIENT_A)).toBe(false)
  })

  it('leaks nothing across a realistic mixed set', () => {
    const all = [
      asset({ client_id: CLIENT_A }),
      asset({ client_id: CLIENT_B }),
      asset({ owner_type: 'cirqle', client_id: null }),
      asset({ owner_type: 'cirqle', client_id: CLIENT_A }),   // reclassified
      asset({ owner_type: 'unassigned', client_id: null }),
      asset({ owner_type: 'garbage', client_id: CLIENT_A }),  // corrupt
    ]
    const a = forClient(all, CLIENT_A)
    expect(a).toHaveLength(1)
    expect(a.every(x => x.client_id === CLIENT_A && x.owner_type === 'client')).toBe(true)

    expect(forClient(all, CLIENT_B)).toHaveLength(1)
    expect(forCirqle(all)).toHaveLength(2)
    expect(unassignedOnly(all)).toHaveLength(2)   // the explicit one + the corrupt one
  })

  it('partitions with no overlap, so agency totals cannot double-count', () => {
    const all = [
      asset({ client_id: CLIENT_A }),
      asset({ client_id: CLIENT_B }),
      asset({ owner_type: 'cirqle' }),
      asset({ owner_type: 'unassigned', client_id: null }),
    ]
    const p = partitionByOwner(all)
    expect(p.client).toHaveLength(2)
    expect(p.cirqle).toHaveLength(1)
    expect(p.unassigned).toHaveLength(1)
    expect(p.client.length + p.cirqle.length + p.unassigned.length).toBe(all.length)
    // No asset appears in two buckets.
    for (const c of p.client) expect(p.cirqle).not.toContain(c)
  })
})

describe('sync must never overwrite a human decision', () => {
  it('keeps a manual assignment when rediscovery runs under another client', () => {
    const existing = asset({
      owner_type: 'client', client_id: CLIENT_B, assigned_at: '2026-08-13T00:00:00Z',
    })
    expect(resolveDiscoveredOwner(existing, CLIENT_A))
      .toEqual({ owner_type: 'client', client_id: CLIENT_B })
  })

  it('keeps Cirqle ownership through a reconnect', () => {
    // The costly regression: reconnecting re-stamps Cirqle's own Page as a
    // client's, and the agency's own spend lands in a client invoice.
    const existing = asset({
      owner_type: 'cirqle', client_id: null, assigned_at: '2026-08-13T00:00:00Z',
    })
    expect(resolveDiscoveredOwner(existing, CLIENT_A))
      .toEqual({ owner_type: 'cirqle', client_id: null })
  })

  it('leaves an untriaged known asset alone rather than re-stamping it', () => {
    const existing = asset({ owner_type: 'unassigned', client_id: null, assigned_at: null })
    expect(resolveDiscoveredOwner(existing, CLIENT_A))
      .toEqual({ owner_type: 'unassigned', client_id: null })
  })

  it('defaults a brand-new asset to the connection client', () => {
    expect(resolveDiscoveredOwner(null, CLIENT_A))
      .toEqual({ owner_type: 'client', client_id: CLIENT_A })
  })

  it('marks a new asset unassigned when there is no client to fall back on', () => {
    expect(resolveDiscoveredOwner(null, null))
      .toEqual({ owner_type: 'unassigned', client_id: null })
  })

  it('reports manual assignment from assigned_at alone', () => {
    expect(isManuallyAssigned(asset({ assigned_at: '2026-08-13T00:00:00Z' }))).toBe(true)
    expect(isManuallyAssigned(asset({ assigned_at: null }))).toBe(false)
    expect(isManuallyAssigned(asset({}))).toBe(false)
  })
})

describe('which moves need an explicit confirmation', () => {
  const at = (ownerType: 'client' | 'cirqle' | 'unassigned', clientId: string | null) =>
    ({ ownerType, clientId })

  it('confirms anything involving Cirqle ownership', () => {
    expect(requiresConfirmation(at('client', CLIENT_A), at('cirqle', null))).toBe(true)
    expect(requiresConfirmation(at('cirqle', null), at('client', CLIENT_A))).toBe(true)
  })

  it('confirms moving between two clients — reporting and money move with it', () => {
    expect(requiresConfirmation(at('client', CLIENT_A), at('client', CLIENT_B))).toBe(true)
  })

  it('does not nag on the normal triage path', () => {
    expect(requiresConfirmation(at('unassigned', null), at('client', CLIENT_A))).toBe(false)
    expect(requiresConfirmation(at('unassigned', null), at('cirqle', null))).toBe(true) // still Cirqle
  })

  it('does nothing when the owner has not actually changed', () => {
    expect(requiresConfirmation(at('client', CLIENT_A), at('client', CLIENT_A))).toBe(false)
    expect(requiresConfirmation(at('cirqle', null), at('cirqle', null))).toBe(false)
  })
})
