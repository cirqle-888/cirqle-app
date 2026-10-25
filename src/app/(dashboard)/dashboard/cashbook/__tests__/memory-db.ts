/* eslint-disable @typescript-eslint/no-explicit-any -- a test double for the untyped Supabase query builder: rows are whatever each test seeds. */
/**
 * A small in-memory stand-in for the Supabase query builder, for testing the
 * cash-book server actions end to end without a database.
 *
 * Covers only what those actions use: select / insert / update / delete;
 * eq, neq, is, in, not(col, 'is', null), gte, lte; order / limit (accepted,
 * order ignored); single / maybeSingle; `.select()` after a write; one level
 * of embedded relations declared in `relations`.
 *
 * Two things a real database does are configurable, because the actions
 * depend on them:
 *   · `missingColumns` — columns that do not exist yet (an unapplied
 *     migration). Touching one errors the way PostgREST does.
 *   · `triggers` — called after every write, so tests can reproduce the
 *     database triggers the actions rely on (allocation → invoice paid
 *     amount, allocation → payslip status, entry → allocation cascade).
 */

type Row = Record<string, any>
type Err = { code: string; message: string } | null

export interface Relation {
  table: string
  /** to-many: the column on `table` pointing back at this row's id. */
  foreignKey?: string
  /** to-one: the column on THIS row holding the other row's id. */
  localKey?: string
}

export interface MemoryDbOptions {
  missingColumns?: Record<string, string[]>
  relations?: Record<string, Record<string, Relation>>
  /** Return an error to refuse an insert (a unique index, a check). */
  beforeInsert?: (table: string, row: Row, db: MemoryDb) => Err
  /** After every insert / update, with the rows as they now are. */
  triggers?: (event: { table: string; op: 'insert' | 'update'; rows: Row[]; before: Row[] }, db: MemoryDb) => void
}

let idSeq = 0

export class MemoryDb {
  tables: Record<string, Row[]>
  log: { table: string; op: string; patch?: Row; ids: string[] }[] = []
  constructor(seed: Record<string, Row[]>, public opts: MemoryDbOptions = {}) {
    this.tables = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map(r => ({ ...r }))]))
  }
  rows(table: string): Row[] {
    return (this.tables[table] ??= [])
  }
  get(table: string, id: string): Row | undefined {
    return this.rows(table).find(r => r.id === id)
  }
  client() {
    return { from: (table: string) => new Query(this, table), rpc: async () => ({ data: null, error: null }) }
  }
  missing(table: string, cols: Iterable<string>): string | null {
    const gone = this.opts.missingColumns?.[table] ?? []
    for (const c of cols) if (gone.includes(c)) return c
    return null
  }
}

type Filter = (r: Row) => boolean

class Query implements PromiseLike<{ data: any; error: Err; count?: number }> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private filters: Filter[] = []
  private filterCols: string[] = []
  private payload: Row | Row[] | null = null
  private selectStr: string | null = null
  private returning = false
  private mode: 'many' | 'single' | 'maybeSingle' = 'many'
  private limitN: number | null = null

  constructor(private db: MemoryDb, private table: string) {}

  select(cols = '*') {
    if (this.op === 'select') this.selectStr = cols
    else { this.returning = true; this.selectStr = cols }
    return this
  }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = rows; return this }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this }
  delete() { this.op = 'delete'; return this }

  private where(col: string, f: Filter) { this.filterCols.push(col); this.filters.push(f); return this }
  eq(col: string, v: any) { return this.where(col, r => r[col] === v) }
  neq(col: string, v: any) { return this.where(col, r => r[col] !== v) }
  is(col: string, v: null | boolean) { return this.where(col, r => (v === null ? r[col] == null : r[col] === v)) }
  in(col: string, vs: any[]) { return this.where(col, r => vs.includes(r[col])) }
  not(col: string, op: string, v: any) {
    if (op !== 'is' || v !== null) throw new Error(`memory-db: not(${op}) unsupported`)
    return this.where(col, r => r[col] != null)
  }
  gte(col: string, v: any) { return this.where(col, r => r[col] >= v) }
  lte(col: string, v: any) { return this.where(col, r => r[col] <= v) }
  ilike(col: string, v: string) { return this.where(col, r => String(r[col] ?? '').toLowerCase() === v.toLowerCase()) }
  order() { return this }
  range() { return this }
  limit(n: number) { this.limitN = n; return this }
  single() { this.mode = 'single'; return this }
  maybeSingle() { this.mode = 'maybeSingle'; return this }

  then<A, B>(ok?: ((v: any) => A | PromiseLike<A>) | null, bad?: ((e: any) => B | PromiseLike<B>) | null) {
    return Promise.resolve().then(() => this.run()).then(ok, bad)
  }

  private columnError(col: string, write: boolean): { data: null; error: Err } {
    return write
      ? { data: null, error: { code: 'PGRST204', message: `Could not find the '${col}' column of '${this.table}' in the schema cache` } }
      : { data: null, error: { code: '42703', message: `column ${this.table}.${col} does not exist` } }
  }

  private selectedColumns(): string[] {
    // Top-level plain column names only (embeds are handled separately).
    if (!this.selectStr) return []
    let depth = 0, cur = ''
    const parts: string[] = []
    for (const ch of this.selectStr) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
    }
    parts.push(cur)
    return parts.map(p => p.trim()).filter(p => p && p !== '*' && !p.includes(':') && !p.includes('('))
  }

  private embed(row: Row): Row {
    const rels = this.db.opts.relations?.[this.table] ?? {}
    if (!this.selectStr) return { ...row }
    const out: Row = { ...row }
    for (const m of this.selectStr.matchAll(/(\w+):(\w+)(?:!\w+)?\(/g)) {
      const rel = rels[m[1]]
      if (!rel) continue
      if (rel.foreignKey) out[m[1]] = this.db.rows(rel.table).filter(o => o[rel.foreignKey!] === row.id).map(o => ({ ...o }))
      else if (rel.localKey) {
        const found = this.db.rows(rel.table).find(o => o.id === row[rel.localKey!])
        out[m[1]] = found ? { ...found } : null
      }
    }
    return out
  }

  private finish(rows: Row[]) {
    const shaped = rows.map(r => this.embed(r))
    if (this.mode === 'many') return { data: shaped, error: null }
    if (shaped.length === 0) {
      return this.mode === 'single'
        ? { data: null, error: { code: 'PGRST116', message: 'no rows' } }
        : { data: null, error: null }
    }
    if (shaped.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } }
    return { data: shaped[0], error: null }
  }

  private run(): { data: any; error: Err } {
    const all = this.db.rows(this.table)
    const gone = this.db.missing(this.table, [...this.filterCols, ...this.selectedColumns()])
    if (gone) return this.columnError(gone, false)
    const match = (r: Row) => this.filters.every(f => f(r))

    if (this.op === 'select') {
      let rows = all.filter(match)
      if (this.limitN != null) rows = rows.slice(0, this.limitN)
      return this.finish(rows)
    }

    if (this.op === 'insert') {
      const input = Array.isArray(this.payload) ? this.payload : [this.payload!]
      for (const r of input) {
        const g = this.db.missing(this.table, Object.keys(r))
        if (g) return this.columnError(g, true)
      }
      const created: Row[] = []
      for (const r of input) {
        const row = { id: `${this.table}-${++idSeq}`, deleted_at: null, ...r }
        const refused = this.db.opts.beforeInsert?.(this.table, row, this.db)
        if (refused) {
          // A statement is all or nothing: undo this statement's rows.
          for (const c of created) all.splice(all.indexOf(c), 1)
          return { data: null, error: refused }
        }
        all.push(row)
        created.push(row)
      }
      this.db.log.push({ table: this.table, op: 'insert', ids: created.map(r => r.id) })
      this.db.opts.triggers?.({ table: this.table, op: 'insert', rows: created, before: [] }, this.db)
      return this.returning ? this.finish(created) : { data: null, error: null }
    }

    if (this.op === 'update') {
      const patch = this.payload as Row
      const g = this.db.missing(this.table, Object.keys(patch))
      if (g) return this.columnError(g, true)
      const hit = all.filter(match)
      const before = hit.map(r => ({ ...r }))
      for (const r of hit) Object.assign(r, patch)
      this.db.log.push({ table: this.table, op: 'update', patch, ids: hit.map(r => r.id) })
      if (hit.length) this.db.opts.triggers?.({ table: this.table, op: 'update', rows: hit, before }, this.db)
      return this.returning ? this.finish(hit) : { data: null, error: null }
    }

    // delete
    const hit = all.filter(match)
    for (const r of hit) all.splice(all.indexOf(r), 1)
    this.db.log.push({ table: this.table, op: 'delete', ids: hit.map(r => r.id) })
    return { data: null, error: null }
  }
}

// ─── The cash book's own database rules, reproduced ──────────────────────────

/** Relations the cash-book actions embed. */
export const CASHBOOK_RELATIONS: MemoryDbOptions['relations'] = {
  cashbook_entries: {
    category: { table: 'cashbook_categories', localKey: 'category_id' },
    bank_account: { table: 'bank_accounts', localKey: 'bank_account_id' },
    allocations: { table: 'cashbook_invoice_allocations', foreignKey: 'cashbook_entry_id' },
    payroll_allocations: { table: 'cashbook_payroll_allocations', foreignKey: 'cashbook_entry_id' },
    expense_billings: { table: 'invoice_expense_items', foreignKey: 'cashbook_entry_id' },
  },
  invoice_expense_items: {
    invoice: { table: 'invoices', localKey: 'invoice_id' },
  },
}

/** Unique index cashbook_entries_one_live_reversal (migration 20261016100000). */
export function oneLiveReversal(table: string, row: Row, db: MemoryDb): Err {
  if (table !== 'cashbook_entries' || !row.reversal_of || row.deleted_at) return null
  const clash = db.rows(table).some(r => r.reversal_of === row.reversal_of && !r.deleted_at)
  return clash ? { code: '23505', message: 'duplicate key value violates unique constraint "cashbook_entries_one_live_reversal"' } : null
}

/**
 * sync_allocations_to_invoices, sync_payroll_payments (₹1 tolerance) and
 * cascade_cashbook_entry_soft_delete as of 20261016100000.
 */
export function cashbookTriggers(
  event: { table: string; op: 'insert' | 'update'; rows: Row[]; before: Row[] },
  db: MemoryDb,
): void {
  if (event.table === 'cashbook_invoice_allocations') {
    for (const invoiceId of new Set(event.rows.map(r => r.invoice_id))) {
      const inv = db.get('invoices', invoiceId)
      if (!inv) continue
      const paid = db.rows('cashbook_invoice_allocations')
        .filter(a => a.invoice_id === invoiceId && !a.deleted_at)
        .reduce((s, a) => s + Number(a.allocated_amount), 0)
      inv.paid_amount = paid
      inv.status = paid >= inv.total_amount - 0.01 ? 'paid' : paid > 0 ? 'partial' : 'sent'
    }
  }
  if (event.table === 'cashbook_payroll_allocations') {
    for (const payrollId of new Set(event.rows.map(r => r.payroll_id))) {
      const p = db.get('payroll', payrollId)
      if (!p) continue
      const paid = db.rows('cashbook_payroll_allocations')
        .filter(a => a.payroll_id === payrollId && !a.deleted_at)
        .reduce((s, a) => s + Number(a.allocated_amount), 0)
      p.status = paid >= p.net_salary - 1 ? 'paid' : 'pending'
    }
  }
  if (event.table === 'cashbook_entries' && event.op === 'update') {
    event.rows.forEach((entry, i) => {
      const was = event.before[i]
      if (was.deleted_at === entry.deleted_at) return
      for (const t of ['cashbook_invoice_allocations', 'cashbook_payroll_allocations']) {
        const hit = entry.deleted_at
          ? db.rows(t).filter(a => a.cashbook_entry_id === entry.id && !a.deleted_at)
          : db.rows(t).filter(a => a.cashbook_entry_id === entry.id && a.deleted_at === was.deleted_at && !a.released_by_entry_id)
        if (!hit.length) continue
        const before = hit.map(a => ({ ...a }))
        for (const a of hit) a.deleted_at = entry.deleted_at
        cashbookTriggers({ table: t, op: 'update', rows: hit, before }, db)
      }
    })
  }
}
