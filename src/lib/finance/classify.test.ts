import { describe, it, expect } from 'vitest'
import {
  deriveWorkScope,
  deriveEntryScope,
  isScopeColumnMissing,
  withoutScope,
  retryWithoutScope,
  missingColumnName,
  withoutKeys,
  retryWithoutMissingColumns,
} from './classify'

describe('deriveWorkScope', () => {
  it('client work when a client is linked', () => {
    expect(deriveWorkScope('c1')).toBe('client')
  })
  it('company work when no client', () => {
    expect(deriveWorkScope(null)).toBe('company')
    expect(deriveWorkScope(undefined)).toBe('company')
    expect(deriveWorkScope('')).toBe('company')
  })
})

describe('deriveEntryScope (mirrors trg_derive_cashbook_scope)', () => {
  it('client tag wins', () => {
    expect(deriveEntryScope({ clientId: 'c1', employeeId: 'e1' })).toBe('client')
  })
  it('employee → company (salaries, advances)', () => {
    expect(deriveEntryScope({ employeeId: 'e1' })).toBe('company')
  })
  it('transfer legs → company', () => {
    expect(deriveEntryScope({ transferRef: 't1' })).toBe('company')
  })
  it('payroll reference → company', () => {
    expect(deriveEntryScope({ reference: 'payroll:abc' })).toBe('company')
  })
  it('category default company → company', () => {
    expect(deriveEntryScope({ categoryDefaultScope: 'company' })).toBe('company')
  })
  it('category default client does NOT force client (needs a client_id) — untriaged', () => {
    expect(deriveEntryScope({ categoryDefaultScope: 'client' })).toBeNull()
  })
  it('ambiguous → null (triage, never guess)', () => {
    expect(deriveEntryScope({})).toBeNull()
  })
})

describe('isScopeColumnMissing', () => {
  it('detects PostgREST unknown-column (PGRST204)', () => {
    expect(isScopeColumnMissing({
      code: 'PGRST204',
      message: "Could not find the 'scope' column of 'cashbook_entries' in the schema cache",
    })).toBe(true)
  })
  it('detects raw Postgres 42703', () => {
    expect(isScopeColumnMissing({
      code: '42703',
      message: 'column "scope" of relation "tasks" does not exist',
    })).toBe(true)
  })
  it('ignores other missing columns', () => {
    expect(isScopeColumnMissing({
      code: 'PGRST204',
      message: "Could not find the 'billing_snapshot' column of 'tasks' in the schema cache",
    })).toBe(false)
  })
  it('ignores unrelated errors and null', () => {
    expect(isScopeColumnMissing({ code: '23505', message: 'duplicate key value violates "scope"' })).toBe(false)
    expect(isScopeColumnMissing(null)).toBe(false)
  })
})

describe('withoutScope', () => {
  it('strips only scope', () => {
    expect(withoutScope({ a: 1, scope: 'company' })).toEqual({ a: 1 })
  })
})

describe('retryWithoutScope', () => {
  it('returns first result when it succeeds', async () => {
    const res = await retryWithoutScope(async () => ({ error: null, data: 1 }))
    expect(res.data).toBe(1)
  })
  it('retries stripped exactly once on missing scope column', async () => {
    const calls: boolean[] = []
    const res = await retryWithoutScope(async (strip) => {
      calls.push(strip)
      return strip
        ? { error: null, data: 'stripped' }
        : { error: { code: 'PGRST204', message: "Could not find the 'scope' column of 'tasks' in the schema cache" }, data: null }
    })
    expect(calls).toEqual([false, true])
    expect(res.data).toBe('stripped')
  })
  it('does not retry on other errors', async () => {
    const calls: boolean[] = []
    const res = await retryWithoutScope(async (strip) => {
      calls.push(strip)
      return { error: { code: '23505', message: 'duplicate' }, data: null }
    })
    expect(calls).toEqual([false])
    expect(res.error?.code).toBe('23505')
  })
})

describe('missingColumnName', () => {
  it('reads the column out of both error shapes', () => {
    expect(missingColumnName({ code: 'PGRST204', message: "Could not find the 'markup_type' column of 'cashbook_entries'" })).toBe('markup_type')
    expect(missingColumnName({ code: '42703', message: 'column "scope" of relation "cashbook_entries" does not exist' })).toBe('scope')
  })

  it('is null for any other failure — a real error must not be retried away', () => {
    expect(missingColumnName({ code: '23505', message: 'duplicate key value' })).toBeNull()
    expect(missingColumnName(null)).toBeNull()
    expect(missingColumnName({ code: 'PGRST204', message: 'no quoted name here' })).toBeNull()
  })
})

describe('withoutKeys', () => {
  it('drops only the named keys', () => {
    expect(withoutKeys({ a: 1, scope: 'company', markup_type: 'none' }, ['scope', 'markup_type'])).toEqual({ a: 1 })
  })

  it('returns the row untouched when nothing is omitted', () => {
    const row = { a: 1 }
    expect(withoutKeys(row, [])).toBe(row)
  })
})

describe('retryWithoutMissingColumns', () => {
  const missing = (col: string) => ({ error: { code: 'PGRST204', message: `Could not find the '${col}' column` } })

  it('drops columns one at a time until the write lands', async () => {
    const seen: string[][] = []
    const res = await retryWithoutMissingColumns(async omit => {
      seen.push([...omit])
      if (!omit.includes('scope')) return missing('scope')
      if (!omit.includes('markup_type')) return missing('markup_type')
      return { error: null }
    })
    expect(res.error).toBeNull()
    expect(seen).toEqual([[], ['scope'], ['scope', 'markup_type']])
  })

  it('returns a real error without retrying', async () => {
    let calls = 0
    const res = await retryWithoutMissingColumns(async () => {
      calls++
      return { error: { code: '23505', message: 'duplicate key' } }
    })
    expect(calls).toBe(1)
    expect(res.error?.code).toBe('23505')
  })

  it('stops rather than looping when the same column is named twice', async () => {
    let calls = 0
    const res = await retryWithoutMissingColumns(async () => {
      calls++
      return missing('scope')
    })
    expect(calls).toBe(2)          // first attempt, one retry, then give up
    expect(res.error).not.toBeNull()
  })

  it('is bounded by maxAttempts even with fresh column names each time', async () => {
    let calls = 0
    const res = await retryWithoutMissingColumns(async () => missing(`col_${calls++}`), 3)
    expect(calls).toBe(3)
    expect(res.error).not.toBeNull()
  })
})
