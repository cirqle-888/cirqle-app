/**
 * Derived Billing — a task priced as a function of OTHER tasks' billing.
 *
 * The case: "Social Media Handling" bills 30% of everything charged for Social
 * Media Poster / Stories / Reels that month. The derived task carries a RULE;
 * its client and month come from the task itself, so the rule stays portable
 * (the same shape works for any client, which is what makes templates useful).
 *
 * Pure and framework-free, exactly like `pricing.ts`: the Add Task form's live
 * preview and the server's authoritative recompute run THIS code, so what you
 * see before saving is what gets written. A second implementation for the
 * preview is how the two drift.
 *
 * ── The invariant everything else leans on ──────────────────────────────────
 * A derived task's basis NEVER contains another derived task (`isBasisTask`
 * rejects them). Consequences, all free:
 *   • cycles are structurally impossible — no A→B→A, no chains;
 *   • many rules may read the same sources (Handling 20% + Agency 5% +
 *     Management 10%), each computing independently from the originals;
 *   • any recompute is a pure function of non-derived rows, so concurrent
 *     recomputes converge and ordering never matters.
 * Do not "just allow one level of nesting" later. That is where this design
 * stops being safe.
 *
 * ── Why one versioned JSON rule instead of columns ──────────────────────────
 * Percentage is the only method needed today, but fixed / percent+fixed /
 * min-max / tiered / formula are all on the roadmap. Here they are new cases
 * in `computeRule` plus a `v` bump — not a migration each. Unknown method or
 * version REFUSES to compute rather than guessing, so an app rollback can
 * never mis-bill: the task simply holds its last amount.
 */

const r2 = (n: number) => Math.round(n * 100) / 100

// ─── The rule ────────────────────────────────────────────────────────────────

/** Bump when the rule's meaning changes. Older engines refuse newer rules. */
export const BILLING_RULE_VERSION = 1

export type BillingMethod = 'percent'

export interface BillingRuleOverride {
  /** Manual amount in the task's currency. Freezes recompute while present. */
  amount: number
  note?: string | null
  at?: string
  by?: string | null
}

export interface BillingRule {
  v: number
  method: BillingMethod
  /** percent method: 0–100 of the basis sum. */
  percent: number
  sources: {
    serviceIds: string[]
    /**
     * Reserved for future taxonomies (categories, tags). Deliberately NOT
     * implemented: tasks have no such taxonomy today, and building filter UI
     * against fields that don't exist is the redesign this shape avoids.
     */
    [k: string]: unknown
  }
  filters?: {
    /** Statuses excluded from the basis. Defaults to ['cancelled']. */
    statusNotIn?: string[]
    /** When set, ONLY these statuses count. */
    statusIn?: string[]
    [k: string]: unknown
  }
  /** Optional floor/ceiling on the computed amount, in INR. */
  clamps?: { minInr?: number | null; maxInr?: number | null }
  /** Manual lock. Present ⇒ recompute is frozen (see the sync module). */
  override?: BillingRuleOverride | null
  /** Standing rules: stop generating future occurrences, hold current amount. */
  paused?: boolean
  /** Archived instead of deleted — history stays intact. Implies paused. */
  archivedAt?: string | null
}

/** Statuses that never count toward a basis unless a rule says otherwise. */
export const DEFAULT_BASIS_EXCLUDED_STATUSES = ['cancelled'] as const

export interface ParsedRule { ok: true; rule: BillingRule }
export interface ParseError { ok: false; error: string }

/**
 * The single gate every write path runs through — a malformed rule can never
 * reach the database, and a rule from a NEWER app version is refused rather
 * than half-understood.
 */
export function parseBillingRule(input: unknown): ParsedRule | ParseError {
  if (input == null || typeof input !== 'object') return { ok: false, error: 'Rule is missing.' }
  const r = input as Record<string, unknown>

  const v = Number(r.v)
  if (!Number.isFinite(v) || v < 1) return { ok: false, error: 'Rule has no version.' }
  if (v > BILLING_RULE_VERSION) {
    return { ok: false, error: `This rule was created by a newer version of the app (v${v}). Update to edit it.` }
  }

  if (r.method !== 'percent') {
    return { ok: false, error: `Unsupported billing method "${String(r.method)}".` }
  }

  const percent = Number(r.percent)
  if (!Number.isFinite(percent) || percent <= 0) return { ok: false, error: 'Enter a percentage above 0.' }
  if (percent > 100) return { ok: false, error: 'Percentage cannot exceed 100.' }

  const sources = (r.sources ?? {}) as Record<string, unknown>
  const serviceIds = Array.isArray(sources.serviceIds)
    ? (sources.serviceIds as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
    : []
  if (serviceIds.length === 0) return { ok: false, error: 'Pick at least one source service.' }

  const rawFilters = (r.filters ?? {}) as Record<string, unknown>
  const strArr = (x: unknown): string[] | undefined =>
    Array.isArray(x) ? (x as unknown[]).filter((s): s is string => typeof s === 'string') : undefined

  const rawClamps = (r.clamps ?? {}) as Record<string, unknown>
  const num = (x: unknown): number | null => {
    const n = Number(x)
    return x === null || x === undefined || x === '' || !Number.isFinite(n) ? null : n
  }
  const minInr = num(rawClamps.minInr)
  const maxInr = num(rawClamps.maxInr)
  if (minInr != null && maxInr != null && minInr > maxInr) {
    return { ok: false, error: 'Minimum charge is above the maximum charge.' }
  }

  const ov = r.override as Record<string, unknown> | null | undefined
  let override: BillingRuleOverride | null = null
  if (ov && typeof ov === 'object') {
    const amount = Number(ov.amount)
    if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: 'Override amount is not a valid number.' }
    override = {
      amount: r2(amount),
      note: typeof ov.note === 'string' ? ov.note : null,
      at: typeof ov.at === 'string' ? ov.at : undefined,
      by: typeof ov.by === 'string' ? ov.by : null,
    }
  }

  return {
    ok: true,
    rule: {
      v: BILLING_RULE_VERSION,
      method: 'percent',
      percent,
      sources: { ...sources, serviceIds },
      filters: {
        ...(strArr(rawFilters.statusIn) ? { statusIn: strArr(rawFilters.statusIn) } : {}),
        statusNotIn: strArr(rawFilters.statusNotIn) ?? [...DEFAULT_BASIS_EXCLUDED_STATUSES],
      },
      clamps: { minInr, maxInr },
      override,
      paused: r.paused === true,
      archivedAt: typeof r.archivedAt === 'string' ? r.archivedAt : null,
    },
  }
}

/** A blank rule for the form to start from. */
export function emptyBillingRule(): BillingRule {
  return {
    v: BILLING_RULE_VERSION,
    method: 'percent',
    percent: 0,
    sources: { serviceIds: [] },
    filters: { statusNotIn: [...DEFAULT_BASIS_EXCLUDED_STATUSES] },
    clamps: { minInr: null, maxInr: null },
    override: null,
    paused: false,
    archivedAt: null,
  }
}

// ─── Task shapes ─────────────────────────────────────────────────────────────

export interface DerivedTaskLike {
  id?: string | null
  client_id?: string | null
  task_date?: string | null
  billing_mode?: string | null
  billing_rule?: unknown
}

export interface BasisTaskLike {
  id: string
  client_id?: string | null
  service_id?: string | null
  task_date?: string | null
  status?: string | null
  deleted_at?: string | null
  billing_mode?: string | null
  billing_amount?: number | null
  billing_amount_inr?: number | null
  currency?: string | null
}

export function isDerivedTask(t: { billing_mode?: string | null } | null | undefined): boolean {
  return t?.billing_mode === 'percent_of_services'
}

/** Statuses after which the client has been billed — the amount stops moving. */
export function isFrozenByStatus(status: string | null | undefined): boolean {
  return status === 'invoiced' || status === 'paid'
}

export function isRuleArchived(rule: BillingRule | null | undefined): boolean {
  return !!rule?.archivedAt
}

/** Paused or archived — a standing rule that should stop producing/updating. */
export function isRuleDormant(rule: BillingRule | null | undefined): boolean {
  return !!rule && (rule.paused === true || !!rule.archivedAt)
}

// ─── The period ──────────────────────────────────────────────────────────────

/**
 * The calendar month a derived task bills for, as [start, endExclusive).
 */
export function monthRange(taskDate: string): { start: string; endExclusive: string } {
  const [y, m] = taskDate.split('-').map(Number)
  const start = `${y}-${String(m).padStart(2, '0')}-01`
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return { start, endExclusive: `${ny}-${String(nm).padStart(2, '0')}-01` }
}

// ─── The basis ───────────────────────────────────────────────────────────────

export interface BasisContext {
  /** The derived task's own id — never counts itself. */
  id?: string | null
  clientId: string | null | undefined
  /** Any date inside the billing month. */
  taskDate: string
  rule: BillingRule
}

/**
 * Does this task feed the derived task's basis?
 *
 * ONE definition, shared by the client preview and the server query's
 * post-filter, so "18 matching tasks" in the form and the saved amount can
 * never disagree.
 */
export function isBasisTask(t: BasisTaskLike, ctx: BasisContext): boolean {
  if (!t) return false
  if (ctx.id && t.id === ctx.id) return false            // never itself
  if (t.deleted_at) return false
  // THE invariant: derived tasks never feed other derived tasks.
  if (isDerivedTask(t)) return false

  if (!t.client_id || t.client_id !== ctx.clientId) return false
  if (!t.service_id || !ctx.rule.sources.serviceIds.includes(t.service_id)) return false

  if (!t.task_date) return false
  const { start, endExclusive } = monthRange(ctx.taskDate)
  if (t.task_date < start || t.task_date >= endExclusive) return false

  const status = t.status ?? ''
  const f = ctx.rule.filters ?? {}
  if (f.statusIn && f.statusIn.length > 0) {
    if (!f.statusIn.includes(status)) return false
  }
  const notIn = f.statusNotIn ?? [...DEFAULT_BASIS_EXCLUDED_STATUSES]
  if (notIn.includes(status)) return false

  return true
}

export interface BasisSum {
  inr: number
  /** Native-currency sum, only when every contributing task shares a currency. */
  native: number | null
  uniformCurrency: string | null
  count: number
  taskIds: string[]
}

/**
 * Sum the basis.
 *
 * Sums the STORED amounts, which are already the effective client charge —
 * re-deriving list prices here would let this drift from what the client is
 * actually billed.
 */
export function sumBasis(sources: BasisTaskLike[]): BasisSum {
  let inr = 0
  let native = 0
  let currency: string | null = null
  let uniform = true
  const taskIds: string[] = []

  for (const t of sources) {
    const amtInr = Number(t.billing_amount_inr) || 0
    const amt = Number(t.billing_amount) || 0
    inr += amtInr
    native += amt
    taskIds.push(t.id)
    // Zero-amount rows can't spoil currency uniformity — they add nothing.
    if (amt !== 0 || amtInr !== 0) {
      const c = t.currency || 'INR'
      if (currency === null) currency = c
      else if (currency !== c) uniform = false
    }
  }

  return {
    inr: r2(inr),
    native: uniform ? r2(native) : null,
    uniformCurrency: uniform ? currency : null,
    count: sources.length,
    taskIds,
  }
}

// ─── The formula ─────────────────────────────────────────────────────────────

export interface ComputedAmounts {
  billingAmount: number
  billingAmountInr: number
  currency: string
}

/**
 * Apply the rule to a basis.
 *
 * INR is always computed (the pool/profit engines are INR); native currency is
 * preserved only when the sources agree on one, so an invoice line stays in
 * the client's own currency in the normal case and degrades to INR on a mix
 * rather than inventing a rate.
 *
 * Does NOT consider `override` — a manual lock means "don't recompute at all",
 * which is the caller's freeze decision, not a different arithmetic.
 */
export function computeRule(rule: BillingRule, basis: BasisSum): ComputedAmounts {
  let inr: number
  let native: number | null

  switch (rule.method) {
    case 'percent':
      inr = basis.inr * (rule.percent / 100)
      native = basis.native === null ? null : basis.native * (rule.percent / 100)
      break
    default: {
      // Unreachable while `percent` is the only method; keeps the switch
      // exhaustive so a future method can't be silently skipped.
      const never: never = rule.method
      throw new Error(`Unsupported billing method: ${String(never)}`)
    }
  }

  const min = rule.clamps?.minInr ?? null
  const max = rule.clamps?.maxInr ?? null
  if (min != null || max != null) {
    const clampedInr = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, inr))
    // Keep native proportional to the clamp so the two never disagree.
    if (native !== null && inr !== 0) native = native * (clampedInr / inr)
    else if (native !== null) native = clampedInr
    inr = clampedInr
  }

  const useNative = native !== null && basis.uniformCurrency !== null && basis.uniformCurrency !== 'INR'
  return {
    billingAmountInr: r2(inr),
    billingAmount: useNative ? r2(native as number) : r2(inr),
    currency: useNative ? (basis.uniformCurrency as string) : 'INR',
  }
}

// ─── Duplicate detection ─────────────────────────────────────────────────────

export interface DuplicateCandidate {
  id?: string | null
  clientId: string | null | undefined
  taskDate: string
  serviceIds: string[]
}

/**
 * Other derived tasks billing the same client, in the same month, off any of
 * the same source services — i.e. probably an accidental second "Handling".
 *
 * A WARNING, never a block: stacking Handling 20% + Agency 5% on the same
 * sources is a legitimate arrangement, so the user decides.
 */
export function findDuplicateRules(
  tasks: (BasisTaskLike & { title?: string | null; billing_rule?: unknown })[],
  candidate: DuplicateCandidate,
): { id: string; title: string | null }[] {
  if (!candidate.clientId || candidate.serviceIds.length === 0) return []
  const { start, endExclusive } = monthRange(candidate.taskDate)
  const wanted = new Set(candidate.serviceIds)

  return tasks.filter(t => {
    if (!isDerivedTask(t)) return false
    if (candidate.id && t.id === candidate.id) return false
    if (t.deleted_at) return false
    if (t.client_id !== candidate.clientId) return false
    if (!t.task_date || t.task_date < start || t.task_date >= endExclusive) return false
    const parsed = parseBillingRule(t.billing_rule)
    if (!parsed.ok) return false
    return parsed.rule.sources.serviceIds.some(id => wanted.has(id))
  }).map(t => ({ id: t.id, title: (t as { title?: string | null }).title ?? null }))
}
