/**
 * The quotation writes, against a recording stand-in for the browser client.
 *
 * What matters is the order of the calls and what a failure leaves behind:
 * the browser has no transaction, so a failed edit must never strand a
 * quotation with no lines, or with old and new lines both.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a recording stand-in for the query builder */
import { describe, it, expect } from 'vitest'
import { createQuotation, deleteDraftQuotation, updateQuotation, type ExistingQuotation } from './save'
import type { QuotationFormValues } from './editing'

type Call = { table: string; op: string; payload?: any; filters: [string, string, unknown][] }
type Reply = { data?: any; error?: { message: string; code?: string } | null }

/**
 * Each query records itself and is answered by `respond`, which sees the whole
 * call (table, operation, payload, filters) once the chain is awaited.
 */
function fakeSupabase(respond: (c: Call) => Reply) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, op: 'select', filters: [] }
    let opSet = false
    const setOp = (op: string, payload?: any) => {
      // `.insert(...).select('id')`: the select is a returning clause, not the op.
      if (!opSet) { call.op = op; call.payload = payload; opSet = true }
      return q
    }
    const filter = (kind: string) => (col: string, val: unknown) => { call.filters.push([kind, col, val]); return q }
    const q: any = {
      select: () => (opSet ? q : setOp('select')),
      insert: (p: any) => setOp('insert', p),
      update: (p: any) => setOp('update', p),
      delete: () => setOp('delete'),
      eq: filter('eq'), neq: filter('neq'), in: filter('in'), like: filter('like'),
      single: () => q,
      then: (resolve: any, reject: any) => {
        calls.push(call)
        const r = respond(call)
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve, reject)
      },
    }
    return q
  }
  return { client: { from } as any, calls }
}

const has = (c: Call, kind: string, col: string, val?: unknown) =>
  c.filters.some(([k, cc, v]) => k === kind && cc === col && (val === undefined || JSON.stringify(v) === JSON.stringify(val)))

const form = (over: Partial<QuotationFormValues> = {}): QuotationFormValues => ({
  client_id: 'client-063', currency: 'INR', issue_date: '2026-10-19', valid_until: '2026-11-18',
  notes: '', terms: 'Payment due within 7 days of approval.',
  items: [
    { description: 'Curtain printing', quantity: 2, unit_price: 3500, total: 7000 },
    { description: 'Design', quantity: 1, unit_price: 1500, total: 1500 },
    { description: '', quantity: 1, unit_price: 0, total: 0 },
  ],
  ...over,
})

const existing = (over: Partial<ExistingQuotation> = {}): ExistingQuotation => ({
  id: 'q-1', quotation_number: 'QUO-2610-063', status: 'draft', client_id: 'client-063',
  issue_date: '2026-10-19', valid_until: '2026-11-18', currency: 'INR', total_amount: 8500,
  notes: '', terms: 'Payment due within 7 days of approval.', ...over,
})

/** A happy-path responder; `fail` makes one step error out. */
function responder(fail?: (c: Call) => Reply | undefined) {
  return (c: Call): Reply => {
    const f = fail?.(c)
    if (f) return f
    if (c.table === 'quotation_items' && c.op === 'select') return { data: [{ id: 'old-1' }, { id: 'old-2' }] }
    if (c.table === 'quotation_items' && c.op === 'insert') return { data: c.payload.map((_: any, i: number) => ({ id: `new-${i}` })) }
    if (c.table === 'quotations' && c.op === 'update') return { data: [{ id: 'q-1' }] }
    if (c.table === 'quotations' && c.op === 'select' && has(c, 'like', 'quotation_number')) return { data: [] }
    if (c.table === 'quotations' && c.op === 'select') return { data: { id: 'q-1', quotation_number: 'QUO-2610-063' } }
    if (c.table === 'quotations' && c.op === 'insert') return { data: { id: 'q-new' } }
    return { data: [] }
  }
}

describe('editing a quotation', () => {
  it('updates the header, adds the new lines, then removes exactly the old ones', async () => {
    const { client, calls } = fakeSupabase(responder())
    const res = await updateQuotation(client, existing(), form({ items: [{ description: 'Curtain printing', quantity: 3, unit_price: 3500, total: 0 }] }), '063')
    expect(res.ok).toBe(true)

    const ops = calls.map(c => `${c.table}.${c.op}`)
    expect(ops).toEqual([
      'quotation_items.select', 'quotations.update', 'quotation_items.insert', 'quotation_items.delete', 'quotations.select',
    ])
    const upd = calls[1]
    expect(upd.payload.total_amount).toBe(10500) // recomputed from the lines, not trusted from the form
    expect(upd.payload.quotation_number).toBe('QUO-2610-063') // same client + month: number kept
    expect(has(upd, 'in', 'status', ['draft', 'sent'])).toBe(true)
    expect(calls[2].payload).toEqual([
      { description: 'Curtain printing', quantity: 3, unit_price: 3500, total: 10500, display_order: 0, quotation_id: 'q-1', currency: 'INR' },
    ])
    expect(has(calls[3], 'in', 'id', ['old-1', 'old-2'])).toBe(true)
  })

  it('refuses an approved, rejected or converted quotation without touching the database', async () => {
    for (const status of ['approved', 'rejected', 'converted']) {
      const { client, calls } = fakeSupabase(responder())
      const res = await updateQuotation(client, existing({ status }), form(), '063')
      expect(res.ok).toBe(false)
      expect(calls).toEqual([])
    }
  })

  it('stops before changing lines when the status moved on meanwhile', async () => {
    const { client, calls } = fakeSupabase(responder(c => (c.table === 'quotations' && c.op === 'update' ? { data: [] } : undefined)))
    const res = await updateQuotation(client, existing(), form(), '063')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/changed status/)
    expect(calls.some(c => c.table === 'quotation_items' && c.op !== 'select')).toBe(false)
  })

  it('restores the header when the new lines fail to insert, and keeps the old lines', async () => {
    const { client, calls } = fakeSupabase(responder(c => (c.table === 'quotation_items' && c.op === 'insert' ? { error: { message: 'insert failed' } } : undefined)))
    const res = await updateQuotation(client, existing(), form({ notes: 'changed' }), '063')
    expect(res).toEqual({ ok: false, error: 'insert failed' })
    const updates = calls.filter(c => c.table === 'quotations' && c.op === 'update')
    expect(updates).toHaveLength(2)
    expect(updates[1].payload).toMatchObject({ total_amount: 8500, notes: '', quotation_number: 'QUO-2610-063' })
    expect(calls.some(c => c.table === 'quotation_items' && c.op === 'delete')).toBe(false)
  })

  it('removes the new lines and restores the header when the old lines fail to delete', async () => {
    const { client, calls } = fakeSupabase(responder(c =>
      c.table === 'quotation_items' && c.op === 'delete' && has(c, 'in', 'id', ['old-1', 'old-2'])
        ? { error: { message: 'delete failed' } } : undefined))
    const res = await updateQuotation(client, existing(), form(), '063')
    expect(res.ok).toBe(false)
    const deletes = calls.filter(c => c.table === 'quotation_items' && c.op === 'delete')
    expect(has(deletes[1], 'in', 'id', ['new-0', 'new-1'])).toBe(true)
    expect(calls.filter(c => c.table === 'quotations' && c.op === 'update')).toHaveLength(2)
  })

  it('renumbers a draft moved to another client, skipping numbers in use', async () => {
    const { client, calls } = fakeSupabase(responder(c =>
      c.table === 'quotations' && c.op === 'select' && has(c, 'like', 'quotation_number')
        ? { data: [{ quotation_number: 'QUO-2610-ABC' }] } : undefined))
    await updateQuotation(client, existing(), form({ client_id: 'client-abc' }), 'ABC')
    const lookup = calls.find(c => has(c, 'like', 'quotation_number'))!
    expect(has(lookup, 'neq', 'id', 'q-1')).toBe(true) // its own number never counts against it
    expect(calls.find(c => c.op === 'update')!.payload.quotation_number).toBe('QUO-2610-ABC-2')
  })

  it('keeps a sent quotation’s number even if its client changes', async () => {
    const { client, calls } = fakeSupabase(responder())
    await updateQuotation(client, existing({ status: 'sent' }), form({ client_id: 'client-abc' }), 'ABC')
    expect(calls.some(c => has(c, 'like', 'quotation_number'))).toBe(false)
    expect(calls.find(c => c.op === 'update')!.payload.quotation_number).toBe('QUO-2610-063')
  })
})

describe('creating a quotation', () => {
  it('takes the next free number when the client already has one this month', async () => {
    const { client, calls } = fakeSupabase(responder(c =>
      c.table === 'quotations' && c.op === 'select' && has(c, 'like', 'quotation_number')
        ? { data: [{ quotation_number: 'QUO-2610-063' }] } : undefined))
    const res = await createQuotation(client, form(), '063')
    expect(res.ok).toBe(true)
    const insert = calls.find(c => c.table === 'quotations' && c.op === 'insert')!
    expect(insert.payload).toMatchObject({ quotation_number: 'QUO-2610-063-2', status: 'draft', total_amount: 8500 })
    const items = calls.find(c => c.table === 'quotation_items' && c.op === 'insert')!
    expect(items.payload.map((i: any) => i.description)).toEqual(['Curtain printing', 'Design'])
  })

  it('retries the number when another save took it first', async () => {
    let inserts = 0
    const { client } = fakeSupabase(responder(c => {
      if (c.table === 'quotations' && c.op === 'insert' && inserts++ === 0) {
        return { error: { message: 'duplicate key', code: '23505' } }
      }
      return undefined
    }))
    const res = await createQuotation(client, form(), '063')
    expect(res.ok).toBe(true)
    expect(inserts).toBe(2)
  })

  it('removes the quotation again if its lines fail to save', async () => {
    const { client, calls } = fakeSupabase(responder(c => (c.table === 'quotation_items' && c.op === 'insert' ? { error: { message: 'nope' } } : undefined)))
    const res = await createQuotation(client, form(), '063')
    expect(res.ok).toBe(false)
    const del = calls.find(c => c.table === 'quotations' && c.op === 'delete')!
    expect(has(del, 'eq', 'id', 'q-new')).toBe(true)
  })
})

describe('deleting a quotation', () => {
  it('deletes only while it is still a draft', async () => {
    const { client, calls } = fakeSupabase(() => ({ data: [{ id: 'q-1' }] }))
    expect(await deleteDraftQuotation(client, 'q-1')).toEqual({ ok: true, value: null })
    expect(has(calls[0], 'eq', 'status', 'draft')).toBe(true)
    expect(has(calls[0], 'eq', 'id', 'q-1')).toBe(true)
  })

  it('reports a quotation that stopped being a draft instead of claiming success', async () => {
    const { client } = fakeSupabase(() => ({ data: [] }))
    const res = await deleteDraftQuotation(client, 'q-1')
    expect(res.ok).toBe(false)
  })
})
