import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect } from 'vitest'
import { isDuplicateCampaignProject } from './ad-spend-invoicing'
import { findBillingTaskId } from './billing'

/**
 * Minimal Supabase stand-in: every builder method chains, and awaiting the
 * builder resolves whatever the table was given. Enough to pin the QUERY
 * SHAPE, which is where both of these bugs actually lived.
 */
function fakeAdmin(tables: Record<string, { data?: unknown[]; error?: unknown }>) {
  const calls: { table: string; filters: [string, unknown][] }[] = []
  const from = (table: string) => {
    const record = { table, filters: [] as [string, unknown][] }
    calls.push(record)
    const result = tables[table] ?? { data: [] }
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null, ...result }).then(resolve),
    }
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'neq']) {
      builder[m] = (...args: unknown[]) => { record.filters.push([m, args]); return builder }
    }
    builder.maybeSingle = () => Promise.resolve({
      data: (result.data as unknown[] | undefined)?.[0] ?? null, error: (result as { error?: unknown }).error ?? null,
    })
    return builder
  }
  return { admin: { from } as unknown as SupabaseClient, calls }
}

const OLD = { id: 'old', created_at: '2026-06-29T00:00:00Z', ad_account_id: null }
const NEW = { id: 'new', created_at: '2026-10-27T00:00:00Z', ad_account_id: 'acct-1' }
const project = (p: Partial<typeof NEW> & { id: string }) =>
  ({ id: p.id, ad_account_id: p.ad_account_id ?? null, provider_metadata: { campaign_id: '12345' } })

describe('isDuplicateCampaignProject', () => {
  it('treats a re-import of a pre-ad-account campaign as the duplicate', async () => {
    // Exactly the 27 Oct MEZZA case: the original carries no ad_account_id,
    // so the re-import used to count as its own campaign and bill twice.
    const { admin } = fakeAdmin({ ad_projects: { data: [OLD, NEW] }, ad_campaigns: { data: [] } })
    expect(await isDuplicateCampaignProject(admin, project(NEW))).toBe(true)
  })

  it('leaves the original of that pair billing', async () => {
    const { admin } = fakeAdmin({ ad_projects: { data: [OLD, NEW] }, ad_campaigns: { data: [] } })
    expect(await isDuplicateCampaignProject(admin, project(OLD))).toBe(false)
  })

  it('does not query ad_projects by ad_account_id', async () => {
    // The old query filtered on it, which is why a null-account twin could
    // never be found. Matching is on the campaign id, narrowed afterwards.
    const { admin, calls } = fakeAdmin({ ad_projects: { data: [OLD, NEW] }, ad_campaigns: { data: [] } })
    await isDuplicateCampaignProject(admin, project(NEW))
    const eqs = calls.find(c => c.table === 'ad_projects')!.filters
      .filter(([m]) => m === 'eq').map(([, args]) => (args as unknown[])[0])
    expect(eqs).toEqual(['provider_metadata->>campaign_id'])
  })

  it('keeps two different accounts apart', async () => {
    const other = { id: 'other', created_at: '2026-01-01T00:00:00Z', ad_account_id: 'acct-2' }
    const { admin } = fakeAdmin({ ad_projects: { data: [other, NEW] }, ad_campaigns: { data: [] } })
    expect(await isDuplicateCampaignProject(admin, project(NEW))).toBe(false)
  })

  it('lets the registry hand billing to the newer project', async () => {
    const { admin } = fakeAdmin({
      ad_projects: { data: [OLD, NEW] },
      ad_campaigns: { data: [{ project_id: 'new', ad_account_id: 'acct-1' }] },
    })
    expect(await isDuplicateCampaignProject(admin, project(NEW))).toBe(false)
    const { admin: admin2 } = fakeAdmin({
      ad_projects: { data: [OLD, NEW] },
      ad_campaigns: { data: [{ project_id: 'new', ad_account_id: 'acct-1' }] },
    })
    expect(await isDuplicateCampaignProject(admin2, project(OLD))).toBe(true)
  })

  it('keeps billing on the original when the registry points at an empty re-import', async () => {
    // Live data on 9 Nov 2026: MEZZA's June project holds task #1809 at ₹300,
    // and the 27 Oct re-import holds nothing. The re-import is the duplicate.
    const tables = {
      ad_projects: { data: [OLD, NEW] },
      ad_campaigns: { data: [{ project_id: 'new', ad_account_id: 'acct-1' }] },
      ad_project_tasks: { data: [{ project_id: 'old', task_id: 'task-1809' }] },
      tasks: { data: [{ id: 'task-1809' }] },
    }
    expect(await isDuplicateCampaignProject(fakeAdmin(tables).admin, project(NEW))).toBe(true)
    expect(await isDuplicateCampaignProject(fakeAdmin(tables).admin, project(OLD))).toBe(false)
  })

  it('ignores a billing task that has been deleted', async () => {
    const tables = {
      ad_projects: { data: [OLD, NEW] },
      ad_campaigns: { data: [{ project_id: 'new', ad_account_id: 'acct-1' }] },
      ad_project_tasks: { data: [{ project_id: 'old', task_id: 'deleted' }] },
      tasks: { data: [] },
    }
    // Neither can bill, so the registry pointer decides as it always did.
    expect(await isDuplicateCampaignProject(fakeAdmin(tables).admin, project(NEW))).toBe(false)
    expect(await isDuplicateCampaignProject(fakeAdmin(tables).admin, project(OLD))).toBe(true)
  })

  it('is never a duplicate without a platform campaign id', async () => {
    const { admin, calls } = fakeAdmin({})
    expect(await isDuplicateCampaignProject(admin, { id: 'manual', ad_account_id: null, provider_metadata: null })).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('findBillingTaskId', () => {
  it('skips the deleted task and returns the live one', async () => {
    const { admin } = fakeAdmin({
      ad_project_tasks: { data: [{ task_id: 'deleted' }, { task_id: 'live' }] },
      tasks: { data: [{ id: 'live' }] },
    })
    expect(await findBillingTaskId(admin, 'p1')).toBe('live')
  })

  it('is null when every linked task is in the trash', async () => {
    const { admin } = fakeAdmin({
      ad_project_tasks: { data: [{ task_id: 'deleted' }] },
      tasks: { data: [] },
    })
    expect(await findBillingTaskId(admin, 'p1')).toBeNull()
  })

  it('is null when the campaign has no linked task', async () => {
    const { admin } = fakeAdmin({ ad_project_tasks: { data: [] } })
    expect(await findBillingTaskId(admin, 'p1')).toBeNull()
  })

  it('falls back to the first link where tasks have no deleted_at column', async () => {
    const { admin } = fakeAdmin({
      ad_project_tasks: { data: [{ task_id: 't1' }, { task_id: 't2' }] },
      tasks: { error: { message: 'column tasks.deleted_at does not exist' } },
    })
    expect(await findBillingTaskId(admin, 'p1')).toBe('t1')
  })
})
