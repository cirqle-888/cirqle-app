import { describe, it, expect } from 'vitest'
import { pickPackageForTask, isAutoLinkCandidate, type AutoLinkTaskLike } from './auto-link'
import type { PackageOption } from './queries'

const POSTER = 'svc-poster'
const LOGO = 'svc-logo'
const HIGHLIGHT = 'svc-highlight-icons'

function pkg(over: Partial<PackageOption> = {}): PackageOption {
  return {
    id: 'pkg-social', name: 'Social Media Management', billingType: 'monthly',
    currency: 'AED', extraTaskPrice: null, serviceIds: [POSTER], ...over,
  }
}

function task(over: Partial<AutoLinkTaskLike> = {}): AutoLinkTaskLike {
  return {
    id: 't1', client_id: 'client-1', service_id: POSTER,
    task_date: '2026-08-14', package_id: null, ...over,
  }
}

describe('pickPackageForTask', () => {
  it('picks the package that includes the service', () => {
    expect(pickPackageForTask([pkg()], POSTER)).toBe('pkg-social')
  })

  it('picks nothing when no package includes it', () => {
    // A logo delivered for a poster-only retainer bills on its own — the client
    // never bought it as part of the bundle.
    expect(pickPackageForTask([pkg()], LOGO)).toBeNull()
  })

  it('picks nothing without a service', () => {
    expect(pickPackageForTask([pkg()], null)).toBeNull()
    expect(pickPackageForTask([], POSTER)).toBeNull()
  })

  it('takes the first when two packages both include the service', () => {
    // activePackagesForClient orders newest first: the one signed most recently
    // is the deal the work was sold under.
    const newer = pkg({ id: 'pkg-new' })
    const older = pkg({ id: 'pkg-old' })
    expect(pickPackageForTask([newer, older], POSTER)).toBe('pkg-new')
  })
})

describe('isAutoLinkCandidate', () => {
  it('accepts an ordinary new task with a client and a service', () => {
    expect(isAutoLinkCandidate(task())).toBe(true)
  })

  it('never overwrites a package that is already set', () => {
    // Either a human picked it or an earlier link ran; both beat a fresh guess.
    expect(isAutoLinkCandidate(task({ package_id: 'pkg-chosen' }))).toBe(false)
  })

  it('never links WAIVED work', () => {
    // The highlight-icon rule: free work must not eat the client's allowance,
    // or a goodwill freebie silently spends one of their 15 paid posters.
    expect(isAutoLinkCandidate(task({ is_billable: false }))).toBe(false)
    expect(isAutoLinkCandidate(task({ is_billable: false, service_id: HIGHLIGHT }))).toBe(false)
  })

  it('links a task whose flag is merely unset', () => {
    expect(isAutoLinkCandidate(task({ is_billable: null }))).toBe(true)
  })

  it('skips internal work, serviceless work and deleted rows', () => {
    expect(isAutoLinkCandidate(task({ client_id: null }))).toBe(false)
    expect(isAutoLinkCandidate(task({ service_id: null }))).toBe(false)
    expect(isAutoLinkCandidate(task({ deleted_at: '2026-08-01' }))).toBe(false)
    expect(isAutoLinkCandidate(null)).toBe(false)
  })
})
