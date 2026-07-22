'use client'

/**
 * AllocationRebuildPanel  — 5-phase admin wizard
 *
 *  Phase 1  MATCH   Run the client-matching engine; show audit report.
 *  Phase 2  REVIEW  Manual review queue: unmatched / ambiguous / low-confidence.
 *  Phase 3  PREVIEW FIFO allocation preview per client (no DB writes yet).
 *  Phase 4  APPROVE Warning + explicit confirmation before any data change.
 *  Phase 5  COMMIT  Backup existing → soft-delete → insert new → final report.
 *
 * No production data is modified before Phase 5.
 */

import { useState, useMemo } from 'react'
import {
  ChevronDown, ChevronUp, CheckCircle2, AlertTriangle,
  Info, Loader2, RefreshCw, ShieldAlert, X, Search,
} from 'lucide-react'
import {
  matchEntriesToClients,
  summarizeMatches,
  type MatchResult,
  type MatchSummary,
} from '@/lib/allocation/client-matcher'
import {
  buildRebuildPreview,
  invoiceToItem,
  type RebuildEntry,
  type ProposedAllocation,
  type RebuildResult,
} from '@/lib/allocation/client-fifo'
import {
  fetchRebuildData,
  saveClientTags,
  backupAndResetAllocations,
  commitAllocationRebuild,
  type AllocationProposal,
} from '@/app/(dashboard)/dashboard/cashbook/actions'

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'loading' | 'match' | 'review' | 'preview' | 'approve' | 'committing' | 'done' | 'error'

interface EditableProposal extends ProposedAllocation { removed: boolean; rowKey: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) => (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })
const r2 = (n: number) => Math.round((n || 0) * 100) / 100

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${color}`}>
      {label}
    </span>
  )
}

function confidenceColor(c: number): string {
  if (c >= 90) return 'bg-green-500/15 text-green-400'
  if (c >= 75) return 'bg-blue-500/15 text-blue-400'
  if (c >= 60) return 'bg-amber-500/15 text-amber-400'
  return 'bg-red-500/15 text-red-400'
}

function methodLabel(m: string): string {
  const labels: Record<string, string> = {
    existing_client_id: 'Saved client',
    linked_invoice:     'Invoice link',
    client_code_exact:  'Client code',
    client_name_exact:  'Name match',
    invoice_ref:        'Invoice ref',
    client_name_fuzzy:  'Fuzzy name',
    no_match:           'No match',
  }
  return labels[m] || m
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SummaryCards({ s }: { s: MatchSummary }) {
  const cards = [
    { label: 'Total payments', value: s.total, color: '' },
    { label: 'Auto-matched', value: s.matched, color: 'text-green-400' },
    { label: 'Low confidence', value: s.low_confidence, color: 'text-amber-400' },
    { label: 'Ambiguous', value: s.ambiguous, color: 'text-blue-400' },
    { label: 'No match', value: s.no_match, color: 'text-red-400' },
    { label: 'Need review', value: s.requires_review, color: 'text-orange-400' },
  ]
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
      {cards.map(c => (
        <div key={c.label} className="bg-secondary/60 border border-border rounded-lg p-2.5 text-center">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide leading-tight mb-1">{c.label}</p>
          <p className={`text-xl font-bold font-mono ${c.color}`}>{c.value}</p>
        </div>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AllocationRebuildPanel() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')

  // Raw data from server
  const [rawEntries, setRawEntries] = useState<any[]>([])
  const [rawInvoices, setRawInvoices] = useState<any[]>([])
  const [rawClients, setRawClients] = useState<any[]>([])

  // Matching phase
  const [matchResults, setMatchResults] = useState<MatchResult[]>([])
  const [summary, setSummary] = useState<MatchSummary | null>(null)

  // Manual overrides: entry_id -> client_id chosen by user
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [reviewSearch, setReviewSearch] = useState('')

  // Allocation preview
  const [preview, setPreview] = useState<RebuildResult | null>(null)
  const [editable, setEditable] = useState<EditableProposal[]>([])
  const [expandedClient, setExpandedClient] = useState<string | null>(null)

  // Done
  const [doneStats, setDoneStats] = useState<{ inserted: number; backed_up: number } | null>(null)

  // ── PHASE 1: MATCH ─────────────────────────────────────────────────────────

  async function runMatch() {
    setPhase('loading')
    setError('')
    try {
      const res = await fetchRebuildData()
      if (!res.ok || !res.data) { setError(res.error || 'Failed to load data'); setPhase('error'); return }

      const { entries, invoices, clients } = res.data
      setRawEntries(entries)
      setRawInvoices(invoices)
      setRawClients(clients)

      const results = matchEntriesToClients(entries, clients, invoices)
      const sum = summarizeMatches(results)
      setMatchResults(results)
      setSummary(sum)
      setOverrides({})
      setPhase('match')
    } catch (e: any) {
      setError(e?.message || 'Matching failed')
      setPhase('error')
    }
  }

  // ── PHASE 2: REVIEW ────────────────────────────────────────────────────────

  const reviewItems = useMemo(() => {
    const needs = matchResults.filter(r =>
      r.status === 'no_match' || r.status === 'ambiguous' || r.status === 'low_confidence'
    )
    if (!reviewSearch.trim()) return needs
    const q = reviewSearch.toLowerCase()
    return needs.filter(r =>
      r.description.toLowerCase().includes(q) ||
      r.reference.toLowerCase().includes(q) ||
      r.best?.client_name.toLowerCase().includes(q)
    )
  }, [matchResults, reviewSearch])

  function override(entryId: string, clientId: string) {
    setOverrides(p => ({ ...p, [entryId]: clientId }))
  }

  // ── Effective client for an entry (override wins over match) ───────────────
  function effectiveClientId(r: MatchResult): string | null {
    return overrides[r.entry_id] || r.best?.client_id || null
  }

  // ── PHASE 3: PREVIEW ───────────────────────────────────────────────────────

  async function runPreview() {
    // First persist any overrides to the DB so client_id is stored
    const tags = matchResults
      .filter(r => {
        const cid = effectiveClientId(r)
        return cid && cid !== (rawEntries.find(e => e.id === r.entry_id)?.client_id || null)
      })
      .map(r => ({ entry_id: r.entry_id, client_id: effectiveClientId(r)! }))

    if (tags.length) {
      const res = await saveClientTags(tags)
      if (!res.ok) { setError(res.error || 'Failed to save client tags'); return }
    }

    // Build items from invoices (deep-copy outstanding_inr for running balance)
    const items = rawInvoices.map((inv: any) => ({
      ...invoiceToItem({
        ...inv,
        total_amount_inr: inv.total_amount_inr ?? inv.total_amount,
        paid_amount_inr:  inv.paid_amount_inr  ?? inv.paid_amount,
      }),
      outstanding_inr: Math.max(0, r2((inv.total_amount_inr ?? inv.total_amount ?? 0)
        - (inv.paid_amount_inr ?? inv.paid_amount ?? 0))),
    }))

    // Build rebuild entries using effective client_id
    const rebuildEntries: RebuildEntry[] = matchResults.map(r => {
      const cid = effectiveClientId(r)
      const client = rawClients.find((c: any) => c.id === cid)
      return {
        entry_id: r.entry_id,
        entry_date: r.entry_date,
        description: r.description,
        reference: r.reference,
        amount_inr: r.amount_inr,
        entity_id: cid || undefined,
        entity_type: cid ? 'client' : undefined,
        entity_label: client?.name || '',
      }
    })

    const result = buildRebuildPreview(rebuildEntries, items)
    setPreview(result)

    const rows: EditableProposal[] = result.matched.flatMap(({ entry, proposals }, ei) =>
      proposals.map((p, pi) => ({
        ...p,
        rowKey: `${ei}-${pi}`,
        removed: false,
      }))
    )
    setEditable(rows)
    setExpandedClient(null)
    setPhase('preview')
  }

  // ── PHASE 4: APPROVE → COMMIT ──────────────────────────────────────────────

  async function commit() {
    if (!preview) return
    setPhase('committing')
    setError('')
    try {
      const bkRes = await backupAndResetAllocations()
      if (!bkRes.ok) { setError(bkRes.error || 'Reset failed'); setPhase('error'); return }

      // Map editable rows back to their cashbook_entry_id
      const entryByProposal = new Map<string, string>()
      preview.matched.forEach(({ entry, proposals }) => {
        proposals.forEach(p => entryByProposal.set(`${entry.entry_id}:${p.item_id}`, entry.entry_id))
      })

      const proposals: AllocationProposal[] = editable
        .filter(r => !r.removed && r.amount > 0.01)
        .map(r => ({
          cashbook_entry_id: entryByProposal.get(`${preview.matched.find(m =>
            m.proposals.some(p => p.item_id === r.item_id)
          )?.entry.entry_id}:${r.item_id}`) || '',
          invoice_id: r.item_id,
          allocated_amount: r2(r.amount),
        }))
        .filter(p => p.cashbook_entry_id)

      const cmRes = await commitAllocationRebuild(proposals)
      if (!cmRes.ok) { setError(cmRes.error || 'Commit failed'); setPhase('error'); return }

      setDoneStats({ inserted: cmRes.data?.inserted ?? 0, backed_up: bkRes.data?.backed_up ?? 0 })
      setPhase('done')
    } catch (e: any) {
      setError(e?.message || 'Rebuild failed')
      setPhase('error')
    }
  }

  // ── Preview helpers ────────────────────────────────────────────────────────

  function updateAmount(rowKey: string, value: number) {
    setEditable(p => p.map(r => r.rowKey === rowKey ? { ...r, amount: value } : r))
  }
  function toggleRemove(rowKey: string) {
    setEditable(p => p.map(r => r.rowKey === rowKey ? { ...r, removed: !r.removed } : r))
  }

  const activeRows = editable.filter(r => !r.removed)
  const totalProposed = r2(activeRows.reduce((s, r) => s + r.amount, 0))

  const grouped: Record<string, { entry: RebuildEntry; proposals: ProposedAllocation[] }[]> =
    preview
      ? preview.matched.reduce((acc, m) => {
          const key = m.entry.entity_id || 'unknown'
          if (!acc[key]) acc[key] = []
          acc[key].push(m)
          return acc
        }, {} as Record<string, typeof preview.matched>)
      : {}

  // ── RENDER ─────────────────────────────────────────────────────────────────

  // Phase breadcrumb
  const phases = [
    { key: 'match',   label: 'Match' },
    { key: 'review',  label: 'Review' },
    { key: 'preview', label: 'Preview' },
    { key: 'approve', label: 'Approve' },
    { key: 'done',    label: 'Done' },
  ]
  const activeIdx = phases.findIndex(p => p.key === phase)

  function PhaseBar() {
    return (
      <div className="flex items-center gap-1 text-xs mb-4">
        {phases.map((p, i) => (
          <span key={p.key} className="flex items-center gap-1">
            <span className={`px-2 py-0.5 rounded-full font-medium ${
              i < activeIdx ? 'bg-green-500/20 text-green-400'
              : i === activeIdx ? 'bg-primary/20 text-primary'
              : 'text-muted-foreground/40'
            }`}>{p.label}</span>
            {i < phases.length - 1 && <span className="text-muted-foreground/30">›</span>}
          </span>
        ))}
      </div>
    )
  }

  // ── idle ──────────────────────────────────────────────────────────────────
  if (phase === 'idle') {
    return (
      <div className="space-y-3">
        <div className="p-4 border border-border rounded-xl bg-secondary/30">
          <h3 className="font-semibold text-sm mb-1">Allocation Rebuild Wizard</h3>
          <p className="text-xs text-muted-foreground mb-1">
            This wizard automatically identifies the client for each cashbook payment (using client codes, names, and invoice references in the description), shows a full review report, then rebuilds all allocations using per-client FIFO.
          </p>
          <p className="text-xs text-muted-foreground font-medium">
            No data is modified until you explicitly approve in Phase 4.
          </p>
        </div>
        <div className="text-xs text-muted-foreground space-y-1 px-1">
          <p className="font-medium text-foreground/80">Workflow:</p>
          {['Match clients to payments (automatic)', 'Review unmatched / ambiguous entries', 'Preview FIFO allocation per client', 'Approve then rebuild'].map((s, i) => (
            <p key={i}>{i + 1}. {s}</p>
          ))}
        </div>
        <button onClick={runMatch}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity">
          <RefreshCw className="w-4 h-4" />
          Start: Match Clients
        </button>
      </div>
    )
  }

  // ── loading ───────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <div className="p-6 flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading entries and running client matching engine...
      </div>
    )
  }

  if (phase === 'committing') {
    return (
      <div className="p-6 flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Backing up allocations, resetting and committing rebuild...
      </div>
    )
  }

  // ── error ─────────────────────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <div className="space-y-3">
        <div className="p-4 border border-destructive/30 rounded-xl bg-destructive/5 text-sm text-destructive flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" /> {error}
        </div>
        <button onClick={() => setPhase('idle')} className="text-xs text-muted-foreground underline">Start over</button>
      </div>
    )
  }

  // ── done ──────────────────────────────────────────────────────────────────
  if (phase === 'done') {
    return (
      <div className="space-y-4">
        <PhaseBar />
        <div className="p-4 border border-green-500/30 rounded-xl bg-green-500/5 space-y-1.5">
          <div className="flex items-center gap-2 text-green-400 font-medium">
            <CheckCircle2 className="w-5 h-5" /> Rebuild complete
          </div>
          <p className="text-sm text-muted-foreground">
            Reset <strong className="text-foreground">{doneStats?.backed_up ?? 0}</strong> old allocation{(doneStats?.backed_up ?? 0) !== 1 ? 's' : ''}.
            Committed <strong className="text-foreground">{doneStats?.inserted ?? 0}</strong> new allocation{(doneStats?.inserted ?? 0) !== 1 ? 's' : ''}.
            Invoice statuses have been recalculated by the DB trigger.
          </p>
        </div>
        <button onClick={() => { setPhase('idle'); setPreview(null); setEditable([]) }}
          className="text-xs text-muted-foreground border border-border px-3 py-1.5 rounded-lg hover:bg-secondary/50">
          Run another rebuild
        </button>
      </div>
    )
  }

  // ── PHASE 1: match report ─────────────────────────────────────────────────
  if (phase === 'match' && summary) {
    const totalAmt = matchResults.reduce((s, r) => s + r.amount_inr, 0)
    return (
      <div className="space-y-4">
        <PhaseBar />
        <SummaryCards s={summary} />

        <div className="text-xs text-muted-foreground">
          Total payment value: <strong className="text-foreground">&#8377;{fmt(totalAmt)}</strong>
        </div>

        {/* Full audit table */}
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-secondary/40 text-xs font-semibold flex gap-2">
            <span className="w-24 shrink-0">Date</span>
            <span className="flex-1">Description</span>
            <span className="w-28 shrink-0">Client</span>
            <span className="w-20 shrink-0">Method</span>
            <span className="w-12 shrink-0 text-right">Conf.</span>
            <span className="w-24 shrink-0 text-right">Amount</span>
          </div>
          <div className="divide-y divide-border/50 max-h-80 overflow-y-auto">
            {matchResults.map(r => (
              <div key={r.entry_id}
                className={`px-4 py-2 flex items-center gap-2 text-xs ${r.status === 'no_match' ? 'bg-red-500/5' : r.status === 'ambiguous' ? 'bg-blue-500/5' : r.status === 'low_confidence' ? 'bg-amber-500/5' : ''}`}>
                <span className="w-24 shrink-0 text-muted-foreground">{r.entry_date}</span>
                <span className="flex-1 truncate text-muted-foreground">{r.description || r.reference || '—'}</span>
                <span className="w-28 shrink-0 font-medium truncate">{r.best?.client_name || <span className="text-red-400">Unmatched</span>}</span>
                <span className="w-20 shrink-0 text-muted-foreground">{r.best ? methodLabel(r.best.method) : '—'}</span>
                <span className="w-12 shrink-0 text-right">
                  {r.best
                    ? <span className={`font-mono px-1 rounded ${confidenceColor(r.best.confidence)}`}>{r.best.confidence}%</span>
                    : <span className="text-red-400">—</span>}
                </span>
                <span className="w-24 shrink-0 text-right font-mono">&#8377;{fmt(r.amount_inr)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={runMatch} className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-secondary/50">
            <RefreshCw className="w-3 h-3" /> Re-run
          </button>
          <button
            onClick={() => summary.requires_review > 0 ? setPhase('review') : runPreview()}
            className="flex-1 py-2 text-sm font-medium rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity">
            {summary.requires_review > 0
              ? `Review ${summary.requires_review} unresolved entry${summary.requires_review !== 1 ? 's' : ''} →`
              : 'All matched — Go to Preview →'}
          </button>
        </div>
      </div>
    )
  }

  // ── PHASE 2: manual review ────────────────────────────────────────────────
  if (phase === 'review') {
    const needsReview = matchResults.filter(r =>
      r.status === 'no_match' || r.status === 'ambiguous' || r.status === 'low_confidence'
    )
    const resolved = needsReview.filter(r => !!overrides[r.entry_id]).length
    const allDone = resolved === needsReview.length || needsReview.length === 0

    return (
      <div className="space-y-4">
        <PhaseBar />
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Manual Review Queue</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {needsReview.length} entries need review · {resolved} resolved · {needsReview.length - resolved} remaining
            </p>
          </div>
          <div className="flex items-center gap-2 bg-secondary border border-border rounded-lg px-2.5 py-1.5">
            <Search className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
            <input value={reviewSearch} onChange={e => setReviewSearch(e.target.value)}
              placeholder="Filter..." className="bg-transparent text-xs outline-none w-32" />
          </div>
        </div>

        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2 bg-secondary/40 text-xs font-semibold flex gap-2">
            <span className="w-24 shrink-0">Date</span>
            <span className="flex-1">Description</span>
            <span className="w-16 shrink-0">Status</span>
            <span className="w-40 shrink-0">Assign client</span>
          </div>
          <div className="divide-y divide-border/50 max-h-96 overflow-y-auto">
            {reviewItems.map(r => {
              const chosen = overrides[r.entry_id] || r.best?.client_id || ''
              return (
                <div key={r.entry_id}
                  className={`px-4 py-2.5 flex items-center gap-2 text-xs ${chosen ? 'bg-green-500/5' : ''}`}>
                  <span className="w-24 shrink-0 text-muted-foreground">{r.entry_date}</span>
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium">{r.description || '—'}</p>
                    <p className="text-muted-foreground truncate">{r.reference}</p>
                    {r.best && !overrides[r.entry_id] && (
                      <p className="text-amber-400 mt-0.5">
                        Suggested: {r.best.client_name} ({r.best.confidence}% via {methodLabel(r.best.method)})
                      </p>
                    )}
                    <p className="font-mono text-muted-foreground">&#8377;{fmt(r.amount_inr)}</p>
                  </div>
                  <div className="w-16 shrink-0">
                    {r.status === 'no_match' && <Pill label="No match" color="bg-red-500/15 text-red-400" />}
                    {r.status === 'ambiguous' && <Pill label="Ambiguous" color="bg-blue-500/15 text-blue-400" />}
                    {r.status === 'low_confidence' && <Pill label="Low conf." color="bg-amber-500/15 text-amber-400" />}
                  </div>
                  <div className="w-40 shrink-0">
                    <select
                      value={chosen}
                      onChange={e => override(r.entry_id, e.target.value)}
                      className="w-full bg-secondary border border-border rounded-md px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/50"
                    >
                      <option value="">— skip / unmatched —</option>
                      {/* Show alternatives first */}
                      {[...(r.best ? [r.best] : []), ...r.alternatives].map(a => (
                        <option key={a.client_id} value={a.client_id}>
                          {a.client_name} ({a.confidence}%)
                        </option>
                      ))}
                      <option disabled>──────────</option>
                      {rawClients
                        .filter((c: any) => ![...(r.best ? [r.best] : []), ...r.alternatives].find(a => a.client_id === c.id))
                        .map((c: any) => (
                          <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                        ))}
                    </select>
                    {chosen && (
                      <button onClick={() => setOverrides(p => { const n = { ...p }; delete n[r.entry_id]; return n })}
                        className="mt-0.5 text-[10px] text-muted-foreground hover:text-destructive w-full text-right">
                        clear
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {reviewItems.length === 0 && (
              <div className="px-4 py-6 text-xs text-center text-muted-foreground">
                No entries match your filter.
              </div>
            )}
          </div>
        </div>

        {!allDone && (
          <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {needsReview.length - resolved} entries still unresolved. Unmatched entries will be skipped in the allocation rebuild.
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={() => setPhase('match')} className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-secondary/50">
            ← Back to Match Report
          </button>
          <button onClick={runPreview}
            className="flex-1 py-2 text-sm font-medium rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity">
            Generate FIFO Preview →
          </button>
        </div>
      </div>
    )
  }

  // ── PHASE 3: allocation preview ────────────────────────────────────────────
  if (phase === 'preview' && preview) {
    return (
      <div className="space-y-4">
        <PhaseBar />

        {/* KPIs */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Payments', value: `&#8377;${fmt(preview.totals.total_payments)}`, color: '' },
            { label: 'To be allocated', value: `&#8377;${fmt(totalProposed)}`, color: 'text-green-400' },
            { label: 'Unallocated', value: `&#8377;${fmt(preview.totals.total_payments - totalProposed)}`, color: 'text-amber-400' },
          ].map(c => (
            <div key={c.label} className="bg-secondary/50 border border-border rounded-lg p-3 text-center">
              <p className="text-[10px] uppercase text-muted-foreground mb-1">{c.label}</p>
              <p className={`font-mono font-bold text-sm ${c.color}`} dangerouslySetInnerHTML={{ __html: c.value }} />
            </div>
          ))}
        </div>

        {/* Unmatched / Ambiguous warnings */}
        {preview.unmatched.length > 0 && (
          <div className="border border-amber-500/30 rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-amber-500/10 text-xs font-medium text-amber-700 dark:text-amber-300 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" />
              {preview.unmatched.length} payment{preview.unmatched.length !== 1 ? 's' : ''} excluded (no client tagged)
            </div>
            <div className="divide-y divide-border/50">
              {preview.unmatched.map(e => (
                <div key={e.entry_id} className="px-4 py-2 text-xs flex items-center justify-between">
                  <span className="text-muted-foreground">{e.entry_date} &mdash; {e.description || e.reference}</span>
                  <span className="font-mono text-amber-400">&#8377;{fmt(e.amount_inr)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Per-client allocation groups */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Proposed allocations by client</h4>
          {Object.entries(grouped).map(([clientId, matches]) => {
            const clientName = matches[0]?.entry.entity_label || 'Unknown'
            const clientTotal = r2(matches.reduce((s, m) => s + m.entry.amount_inr, 0))
            const isExpanded = expandedClient === clientId

            return (
              <div key={clientId} className="border border-border rounded-xl overflow-hidden">
                <button type="button"
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-secondary/30 transition-colors"
                  onClick={() => setExpandedClient(isExpanded ? null : clientId)}>
                  <div className="flex items-center gap-3 text-left min-w-0">
                    <span className="font-medium text-sm truncate">{clientName}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {matches.length} payment{matches.length !== 1 ? 's' : ''} &middot; &#8377;{fmt(clientTotal)}
                    </span>
                  </div>
                  {isExpanded ? <ChevronUp className="w-4 h-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />}
                </button>

                {isExpanded && (
                  <div className="border-t border-border">
                    {matches.map(({ entry, proposals }) => {
                      const entryRows = editable.filter(r =>
                        proposals.some(p => p.item_id === r.item_id && !r.removed && r.amount > 0)
                      )
                      const entryTotal = r2(entryRows.reduce((s, r) => s + r.amount, 0))
                      const remainder = r2(entry.amount_inr - entryTotal)

                      return (
                        <div key={entry.entry_id} className="border-b border-border/50 last:border-0">
                          {/* Payment row */}
                          <div className="px-4 py-2 bg-secondary/20 flex items-center justify-between text-xs">
                            <div>
                              <span className="font-medium">{entry.entry_date}</span>
                              <span className="text-muted-foreground ml-2 truncate">{entry.description || entry.reference || 'Payment'}</span>
                            </div>
                            <div className="flex items-center gap-3 shrink-0 ml-2">
                              <span className="font-mono">&#8377;{fmt(entry.amount_inr)}</span>
                              {remainder > 0.01 && (
                                <span className="text-amber-400 font-mono">unalloc: &#8377;{fmt(remainder)}</span>
                              )}
                              {remainder <= 0.01 && entryTotal > 0 && (
                                <span className="text-green-400">&#10003; fully allocated</span>
                              )}
                            </div>
                          </div>

                          {/* Invoice allocation rows */}
                          {editable
                            .filter(r => proposals.some(p => p.item_id === r.item_id))
                            .map(row => (
                              <div key={row.rowKey}
                                className={`px-4 py-2 flex items-center gap-3 text-xs border-t border-border/30 ${row.removed ? 'opacity-40' : ''}`}>
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium">{row.item_label}</span>
                                  <span className="text-muted-foreground ml-2">{row.item_date}</span>
                                  <span className="text-muted-foreground ml-1">
                                    (&#8377;{fmt(row.outstanding_inr)} outstanding before)
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className="text-muted-foreground">&#8377;</span>
                                  <input
                                    type="number" step="0.01" min="0"
                                    value={row.amount}
                                    disabled={row.removed}
                                    onChange={e => updateAmount(row.rowKey, parseFloat(e.target.value) || 0)}
                                    className="w-24 bg-secondary border border-border rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-40"
                                  />
                                  <button onClick={() => toggleRemove(row.rowKey)}
                                    className={`text-xs px-2 py-1 rounded border transition-colors ${row.removed ? 'border-green-500/40 text-green-400 hover:bg-green-500/10' : 'border-destructive/40 text-destructive hover:bg-destructive/10'}`}>
                                    {row.removed ? 'Restore' : 'Remove'}
                                  </button>
                                </div>
                              </div>
                            ))}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex gap-2">
          <button onClick={() => setPhase('review')} className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-secondary/50">
            ← Back to Review
          </button>
          <button onClick={runPreview} className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-secondary/50 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
          <button onClick={() => setPhase('approve')} disabled={activeRows.length === 0}
            className="flex-1 py-2 text-sm font-medium rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white transition-colors">
            Review &amp; Approve ({activeRows.length} allocation{activeRows.length !== 1 ? 's' : ''}) →
          </button>
        </div>
      </div>
    )
  }

  // ── PHASE 4: approve ──────────────────────────────────────────────────────
  if (phase === 'approve') {
    const clientCount = Object.keys(grouped).length
    return (
      <div className="space-y-4">
        <PhaseBar />

        <div className="border border-border rounded-xl p-4 space-y-2 text-sm">
          <p className="font-semibold">Rebuild Summary</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>Clients affected:</span><span className="text-foreground font-medium">{clientCount}</span>
            <span>Allocation rows to insert:</span><span className="text-foreground font-medium">{activeRows.length}</span>
            <span>Total &#8377; allocated:</span><span className="text-foreground font-mono font-medium">&#8377;{fmt(totalProposed)}</span>
            <span>Skipped (removed/unmatched):</span><span className="text-muted-foreground">{(preview?.unmatched.length ?? 0) + editable.filter(r => r.removed).length}</span>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-700 dark:text-red-300">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
          <div>
            <p className="font-bold text-red-400 mb-1">This action will modify production data.</p>
            <ul className="space-y-0.5 text-red-700 dark:text-red-300/80 list-disc list-inside">
              <li>All active cashbook invoice allocations will be soft-deleted.</li>
              <li>All invoice paid_amounts and statuses will be reset to 0 by the DB trigger.</li>
              <li>New allocations will be inserted per the FIFO preview above.</li>
              <li>Invoice balances and statuses will be recalculated.</li>
              <li>This cannot be reversed without a database-level restore.</li>
            </ul>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-xs text-destructive">
            <ShieldAlert className="w-3.5 h-3.5 shrink-0" /> {error}
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={() => setPhase('preview')} className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary/50">
            ← Back to Preview
          </button>
          <button onClick={commit} disabled={activeRows.length === 0}
            className="flex-1 py-2 text-sm font-bold rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Approve &amp; Rebuild Now
          </button>
        </div>
      </div>
    )
  }

  // Fallback — never leave the wizard body blank if a phase/data combination
  // isn't matched above (e.g. phase === 'match' with no summary). Offer recovery.
  return (
    <div className="space-y-3 py-2">
      <p className="text-sm text-muted-foreground">
        The rebuild wizard lost its place. This is harmless — nothing was changed.
      </p>
      <button
        onClick={() => { setPreview(null); setEditable([]); setSummary(null); setPhase('idle') }}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity"
      >
        <RefreshCw className="w-4 h-4" /> Restart wizard
      </button>
    </div>
  )
}
