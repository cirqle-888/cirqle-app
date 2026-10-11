import { describe, it, expect } from 'vitest'
import {
  DRAFT_TTL_MS,
  draftKey,
  isDraftKey,
  isForeignDraftKey,
  encodeDraft,
  decodeDraft,
  isMeaningfulDraft,
  formatLastSaved,
  type DraftScope,
} from './model'

const NOW = Date.UTC(2026, 9, 11, 9, 0, 0)
const me: DraftScope = { employeeId: 'emp-1', workspaceId: 'ws-1' }
const colleague: DraftScope = { employeeId: 'emp-2', workspaceId: 'ws-1' }
const otherWorkspace: DraftScope = { employeeId: 'emp-1', workspaceId: 'ws-2' }

const write = (scope: DraftScope, form: string, data: unknown, at = NOW) =>
  encodeDraft(scope, form, data, at)

describe('keys', () => {
  it('separates employees and workspaces', () => {
    const k = draftKey(me, 'task.new')
    expect(k).not.toBe(draftKey(colleague, 'task.new'))
    expect(k).not.toBe(draftKey(otherWorkspace, 'task.new'))
    expect(k).not.toBe(draftKey(me, 'request.new'))
  })

  it('recognises its own keys and nothing else', () => {
    expect(isDraftKey(draftKey(me, 'task.new'))).toBe(true)
    expect(isDraftKey('cirqle-favorites-cache')).toBe(false)
  })

  it('identifies another account’s drafts for sweeping, and leaves others alone', () => {
    expect(isForeignDraftKey(draftKey(colleague, 'task.new'), me)).toBe(true)
    expect(isForeignDraftKey(draftKey(otherWorkspace, 'task.new'), me)).toBe(true)
    expect(isForeignDraftKey(draftKey(me, 'task.new'), me)).toBe(false)
    // Not a draft at all — must not be swept.
    expect(isForeignDraftKey('cirqle:offline:queue:v1', me)).toBe(false)
  })
})

describe('reading a draft back', () => {
  it('round-trips the data and the save time', () => {
    const d = decodeDraft<{ title: string }>(write(me, 'task.new', { title: 'Brochure' }), me, 'task.new', NOW)
    expect(d?.data.title).toBe('Brochure')
    expect(d?.savedAt).toBe(NOW)
  })

  it('refuses another employee’s draft even under a matching key', () => {
    // The envelope repeats the scope, so copied storage or a reused key still
    // cannot surface someone else's typing.
    const raw = write(colleague, 'task.new', { title: 'Theirs' })
    expect(decodeDraft(raw, me, 'task.new', NOW)).toBeNull()
  })

  it('refuses another workspace’s draft', () => {
    expect(decodeDraft(write(otherWorkspace, 'task.new', { title: 'x' }), me, 'task.new', NOW)).toBeNull()
  })

  it('refuses a draft belonging to a different form', () => {
    expect(decodeDraft(write(me, 'request.new', { title: 'x' }), me, 'task.new', NOW)).toBeNull()
  })

  it('refuses an expired draft', () => {
    const raw = write(me, 'task.new', { title: 'old' }, NOW - DRAFT_TTL_MS - 1)
    expect(decodeDraft(raw, me, 'task.new', NOW)).toBeNull()
  })

  it('keeps a draft right up to the TTL', () => {
    const raw = write(me, 'task.new', { title: 'old' }, NOW - DRAFT_TTL_MS)
    expect(decodeDraft(raw, me, 'task.new', NOW)).not.toBeNull()
  })

  it('keeps a draft whose clock ran ahead', () => {
    // A device clock change is not a reason to throw away real typing.
    const raw = write(me, 'task.new', { title: 'future' }, NOW + 60_000)
    expect(decodeDraft(raw, me, 'task.new', NOW)).not.toBeNull()
  })

  it('never throws on rubbish, it just declines', () => {
    for (const raw of [null, '', 'not json', '{}', '[]', '{"v":99}', JSON.stringify({ v: 1 })]) {
      expect(decodeDraft(raw, me, 'task.new', NOW)).toBeNull()
    }
  })
})

describe('is there anything in it', () => {
  it('ignores an untouched form', () => {
    expect(isMeaningfulDraft({ title: '', client: null, notes: '   ', items: [], tags: {} })).toBe(false)
  })

  it('notices any filled field', () => {
    expect(isMeaningfulDraft({ title: '', client: 'acme' })).toBe(true)
    expect(isMeaningfulDraft({ amount: 0 })).toBe(true)
    expect(isMeaningfulDraft({ billable: false })).toBe(true)
    expect(isMeaningfulDraft({ items: [{ desc: 'Logo' }] })).toBe(true)
  })

  it('looks inside nested rows, not just the top level', () => {
    expect(isMeaningfulDraft({ items: [{ desc: '', qty: '' }] })).toBe(false)
  })
})

describe('last saved', () => {
  const at = (ms: number) => formatLastSaved(NOW - ms, NOW)

  it('reads as relative while the work is current', () => {
    expect(at(2_000)).toBe('just now')
    expect(at(30_000)).toBe('30 seconds ago')
    expect(at(60_000)).toBe('1 minute ago')
    expect(at(10 * 60_000)).toBe('10 minutes ago')
    expect(at(3 * 3_600_000)).toBe('3 hours ago')
  })

  it('reads as a date once relative stops being useful', () => {
    // "37 hours ago" tells someone recovering Tuesday's draft nothing.
    expect(at(37 * 3_600_000)).toMatch(/Oct/)
  })
})
