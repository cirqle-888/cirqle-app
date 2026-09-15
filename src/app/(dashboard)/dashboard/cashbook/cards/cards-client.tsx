'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { AlertTriangle, Check, CreditCard, FileUp, Link2, Loader2, RefreshCw, Unlink, X } from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { parseStatementText, parseStatementRows, guessColumns, type ParsedLine, type ParseResult } from '@/lib/cards/parse'
import {
  applyMatches, closeCycle, ignoreLine, importStatement, loadCycle, proposeMatches,
  reopenCycle, setStatementTotal, type CycleView,
} from './actions'

/**
 * Reconciling a card statement against the cashbook.
 *
 * The screen is two columns because the question is: does what the bank
 * charged match what we recorded? Statement lines on the left, the card's own
 * cashbook entries on the right, and a line's matched entries shown beneath
 * it — including the SPLIT case, where one charge was recorded as several
 * entries so each could carry its own category.
 *
 * Nothing here decides anything. The matcher proposes, a person accepts, and
 * a cycle only closes when every line is accounted for AND the arithmetic
 * agrees with the statement's own total.
 */

export interface CardCycle { start: string; end: string; label: string }

export interface CardOption {
  id: string
  name: string
  currency: string
  last4: string | null
  statementDay: number | null
  dueDay: number | null
  creditLimit: number | null
  reconcileFrom: string | null
  cycles: CardCycle[]
}

interface Props {
  cards: CardOption[]
  canManage: boolean
  migrationMissing: boolean
}

const money = (n: number, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n)

export default function CardsClient({ cards, canManage, migrationMissing }: Props) {
  const { success, error: toastError, toasts, dismiss } = useToast()
  const [cardId, setCardId] = useState(cards[0]?.id ?? '')
  const card = cards.find(c => c.id === cardId) ?? null
  const [chosenCycleEnd, setCycleEnd] = useState(cards[0]?.cycles[0]?.end ?? '')
  // The chosen cycle only counts if THIS card has it; otherwise its newest.
  const cycleEnd = useMemo(() => {
    const own = cards.find(c => c.id === cardId)
    if (!own) return ''
    return own.cycles.some(c => c.end === chosenCycleEnd) ? chosenCycleEnd : (own.cycles[0]?.end ?? '')
  }, [cards, cardId, chosenCycleEnd])
  const [answer, setAnswer] = useState<{ key: string; view: CycleView | null }>({ key: '', view: null })
  const [reloads, setReloads] = useState(0)
  const [pending, startTransition] = useTransition()

  const [paste, setPaste] = useState('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [typed, setTyped] = useState<{ key: string; value: string }>({ key: '', value: '' })
  const [showImport, setShowImport] = useState(false)
  /** Which line the person is choosing entries for, and their picks so far. */
  const [picking, setPicking] = useState<{ lineId: string; entryIds: string[] } | null>(null)

  /**
   * The cycle, tagged with the question it answers.
   *
   * Loading is DERIVED from that tag rather than set when the effect starts.
   * A state write in an effect's body costs a second render pass every time
   * the card or cycle changes, and React's lint rule rightly refuses it — the
   * same reason offer-studio's ImagePicker is shaped this way.
   */
  const question = card ? card.id + ' :: ' + cycleEnd + ' :: ' + reloads : ''
  const answered = answer.key === question
  const view = answered ? answer.view : null
  const loading = Boolean(question) && !answered

  useEffect(() => {
    if (!card || !cycleEnd) return
    let live = true
    void loadCycle(card.id, cycleEnd).then(res => {
      if (!live) return
      if (!res.ok || !res.data) { toastError('Could not load the cycle', res.error) }
      setAnswer({ key: card.id + ' :: ' + cycleEnd + ' :: ' + reloads, view: res.data ?? null })
    })
    return () => { live = false }
  }, [card, cycleEnd, reloads, toastError])

  /**
   * The statement total, typed off the PDF.
   *
   * Tagged like the cycle is, so switching card or cycle shows that cycle's
   * total without an effect writing state — and a half-typed number is kept
   * while the person is still on the same cycle.
   */
  const totalInput = typed.key === question
    ? typed.value
    : (view?.statementTotal == null ? '' : String(view.statementTotal))
  const setTotalInput = (value: string) => setTyped({ key: question, value })

  const refresh = useCallback(async () => { setReloads(n => n + 1) }, [])

  const balance = useMemo(() => {
    if (!view) return null
    const linesTotal = Math.round(view.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100
    if (view.statementTotal === null) return { linesTotal, difference: null, agrees: false }
    const difference = Math.round((linesTotal - view.statementTotal) * 100) / 100
    return { linesTotal, difference, agrees: Math.abs(difference) < 0.005 }
  }, [view])

  const entryById = useMemo(
    () => new Map((view?.entries ?? []).map(e => [e.id, e])), [view])

  const unmatchedCount = view?.lines.filter(l => l.status === 'unmatched').length ?? 0
  const unclaimed = (view?.entries ?? []).filter((e: CycleView['entries'][number]) => e.matchedLineId === null)

  /* ── Import ──────────────────────────────────────────────────────────── */

  function onPaste(text: string) {
    setPaste(text)
    setParsed(text.trim() ? parseStatementText(text) : null)
  }

  async function onFile(file: File) {
    try {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv'
      let rows: unknown[][]
      if (isCsv) {
        const text = await file.text()
        // A bank's CSV is simple enough that a split is honest here; anything
        // with quoted commas comes through the spreadsheet path below.
        rows = text.split(/\r?\n/).filter(Boolean).map(r => r.split(','))
      } else {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false, raw: false })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false }) as unknown[][]
      }
      if (!rows.length) { toastError('That file has no rows'); return }

      // Find the header row: the first row the column guesser recognises.
      let headerAt = -1
      let map: ReturnType<typeof guessColumns> = {}
      for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const guess = guessColumns(rows[i].map(c => String(c ?? '')))
        if (guess.date !== undefined && guess.description !== undefined &&
            (guess.amount !== undefined || guess.debit !== undefined || guess.credit !== undefined)) {
          headerAt = i; map = guess; break
        }
      }
      if (headerAt === -1) {
        toastError('Could not find the columns',
          'No row looked like a header with a date, a description and an amount. Paste the lines instead.')
        return
      }
      const result = parseStatementRows(rows.slice(headerAt + 1), map as Parameters<typeof parseStatementRows>[1])
      setParsed(result)
      setPaste('')
      success(`Read ${result.lines.length} line${result.lines.length === 1 ? '' : 's'} from ${file.name}`)
    } catch (err) {
      toastError('Could not read that file', err instanceof Error ? err.message : undefined)
    }
  }

  function doImport(replace: boolean) {
    if (!card || !parsed?.lines.length) return
    const total = totalInput.trim() === '' ? null : Number(totalInput.replace(/[^\d.-]/g, ''))
    startTransition(async () => {
      const res = await importStatement({
        bankAccountId: card.id, cycleEnd, lines: parsed.lines,
        statementTotal: Number.isFinite(total as number) ? (total as number) : null,
        replace,
      })
      if (!res.ok) { toastError('Import refused', res.error); return }
      success(`${res.data!.lineCount} lines imported`, res.data!.replaced ? 'The previous lines and matches were replaced.' : undefined)
      setShowImport(false); setPaste(''); setParsed(null)
      await refresh()
    })
  }

  /* ── Matching ────────────────────────────────────────────────────────── */

  function autoMatch() {
    if (!card) return
    startTransition(async () => {
      const res = await proposeMatches(card.id, cycleEnd)
      if (!res.ok || !res.data) { toastError('Could not match', res.error); return }
      const proposals = res.data.proposals.filter(p => p.entryIds.length)
      if (!proposals.length) { toastError('Nothing to match', 'No statement line could be matched to an entry.'); return }
      const applied = await applyMatches({
        bankAccountId: card.id,
        matches: proposals.map(p => ({ lineId: p.lineId, entryIds: p.entryIds })),
        auto: true,
      })
      if (!applied.ok) { toastError('Could not save the matches', applied.error); return }
      const splits = proposals.filter(p => p.confidence === 'split').length
      success(`${applied.data!.linesMatched} matched`,
        splits ? `${splits} of them were splits — check those before closing.` : undefined)
      await refresh()
    })
  }

  function savePicks() {
    if (!card || !picking) return
    startTransition(async () => {
      const res = await applyMatches({
        bankAccountId: card.id,
        matches: [{ lineId: picking.lineId, entryIds: picking.entryIds }],
      })
      if (!res.ok) { toastError('Could not match', res.error); return }
      setPicking(null)
      await refresh()
    })
  }

  function unmatch(lineId: string) {
    if (!card) return
    startTransition(async () => {
      const res = await applyMatches({ bankAccountId: card.id, matches: [{ lineId, entryIds: [] }] })
      if (!res.ok) { toastError('Could not unmatch', res.error); return }
      await refresh()
    })
  }

  function doIgnore(lineId: string) {
    const reason = window.prompt('Why does this line have no entry?\n(the bill payment, an annual fee already recorded elsewhere…)')
    if (reason === null) return
    startTransition(async () => {
      const res = await ignoreLine(lineId, reason)
      if (!res.ok) { toastError('Could not ignore the line', res.error); return }
      await refresh()
    })
  }

  /* ── Closing ─────────────────────────────────────────────────────────── */

  function saveTotal() {
    if (!view?.statementId) return
    const value = totalInput.trim() === '' ? null : Number(totalInput.replace(/[^\d.-]/g, ''))
    if (value !== null && !Number.isFinite(value)) { toastError('That is not a number'); return }
    startTransition(async () => {
      const res = await setStatementTotal(view.statementId!, value)
      if (!res.ok) { toastError('Could not save the total', res.error); return }
      await refresh()
    })
  }

  function doClose() {
    if (!card) return
    startTransition(async () => {
      const res = await closeCycle(card.id, cycleEnd)
      if (!res.ok) { toastError('Cannot close this cycle yet', res.error); return }
      success('Cycle closed', 'Every line is accounted for and the totals agree.')
      await refresh()
    })
  }

  function doReopen() {
    if (!view?.statementId) return
    startTransition(async () => {
      const res = await reopenCycle(view.statementId!)
      if (!res.ok) { toastError('Could not reopen', res.error); return }
      await refresh()
    })
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  if (migrationMissing) {
    return (
      <Shell>
        <Notice tone="warn" title="The database is not ready for this yet">
          Apply <code className="font-mono text-xs">supabase/migrations/20260915100000_card_reconciliation.sql</code>{' '}
          in the Supabase SQL editor, then reload. It adds the card columns on accounts and
          the three statement tables; it changes no existing entry.
        </Notice>
      </Shell>
    )
  }

  if (!cards.length) {
    return (
      <Shell>
        <Notice tone="info" title="No credit card accounts yet">
          Add one in <strong>Settings → Accounts</strong> with the type <strong>credit_card</strong>, then
          give it a statement day (the day of the month its cycle closes) and the date you want
          reconciliation to start from. Record card purchases against that account, and pay the
          bill as an internal transfer from your bank to it.
        </Notice>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Card
          <AppSelect value={cardId} onChange={e => setCardId(e.target.value)} className="min-w-52">
            {cards.map(c => (
              <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` ····${c.last4}` : ''}</option>
            ))}
          </AppSelect>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Billing cycle
          <AppSelect value={cycleEnd} onChange={e => setCycleEnd(e.target.value)} className="min-w-56">
            {card?.cycles.length
              ? card.cycles.map(c => <option key={c.end} value={c.end}>{c.label}</option>)
              : <option value="">No closed cycles yet</option>}
          </AppSelect>
        </label>

        {card && !card.statementDay && (
          <Notice tone="warn" title="This card has no statement day">
            Set one in Settings → Accounts, so the app knows where its billing cycle starts and ends.
          </Notice>
        )}

        <div className="ml-auto flex items-center gap-2">
          {canManage && view && view.status === 'open' && (
            <>
              <button onClick={() => setShowImport(v => !v)} disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">
                <FileUp className="h-4 w-4" /> {view.lines.length ? 'Re-import' : 'Import statement'}
              </button>
              {view.lines.length > 0 && (
                <button onClick={autoMatch} disabled={pending || unmatchedCount === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Match automatically
                </button>
              )}
            </>
          )}
          {canManage && view?.status === 'closed' && (
            <button onClick={doReopen} disabled={pending}
              className="rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">Reopen</button>
          )}
        </div>
      </div>

      {showImport && canManage && (
        <ImportPanel
          paste={paste} parsed={parsed} pending={pending}
          totalInput={totalInput} setTotalInput={setTotalInput}
          hasExisting={Boolean(view?.lines.length)}
          onPaste={onPaste} onFile={onFile}
          onImport={doImport} onCancel={() => { setShowImport(false); setParsed(null); setPaste('') }}
        />
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading the cycle…</p>}

      {view && !loading && (
        <>
          <BalanceStrip
            view={view} balance={balance} currency={card?.currency ?? 'INR'}
            totalInput={totalInput} setTotalInput={setTotalInput}
            canManage={canManage} onSaveTotal={saveTotal} onClose={doClose}
            pending={pending} unmatchedCount={unmatchedCount}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            {/* ── Statement lines ─────────────────────────────────────── */}
            <section className="rounded-xl border">
              <header className="flex items-center justify-between border-b px-4 py-2.5">
                <h3 className="text-sm font-semibold">On the statement</h3>
                <span className="text-xs text-muted-foreground">{view.lines.length} lines</span>
              </header>
              {view.lines.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  Nothing imported for this cycle yet.
                </p>
              ) : (
                <ul className="divide-y">
                  {view.lines.map(line => (
                    <li key={line.id} className="px-4 py-2.5">
                      <div className="flex items-start gap-3">
                        <StatusDot status={line.status} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{line.description}</p>
                          <p className="text-xs text-muted-foreground">{line.txnDate}</p>
                          {line.status === 'ignored' && line.ignoreReason && (
                            <p className="mt-0.5 text-xs italic text-muted-foreground">Ignored — {line.ignoreReason}</p>
                          )}
                          {line.entryIds.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5 border-l-2 pl-2.5">
                              {line.entryIds.map(id => {
                                const e = entryById.get(id)
                                return (
                                  <li key={id} className="flex justify-between gap-2 text-xs text-muted-foreground">
                                    <span className="truncate">{e?.description || '(entry not in this cycle)'}</span>
                                    <span className="shrink-0 tabular-nums">{e ? money(e.amount, card?.currency) : '—'}</span>
                                  </li>
                                )
                              })}
                              {line.entryIds.length > 1 && (
                                <li className="pt-0.5 text-[11px] text-muted-foreground">
                                  split across {line.entryIds.length} entries
                                </li>
                              )}
                            </ul>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={'text-sm font-medium tabular-nums ' + (line.amount < 0 ? 'text-green-500' : '')}>
                            {money(line.amount, card?.currency)}
                          </p>
                          {canManage && view.status === 'open' && (
                            <div className="mt-1 flex justify-end gap-1">
                              {line.status === 'unmatched' ? (
                                <>
                                  <button onClick={() => setPicking({ lineId: line.id, entryIds: [] })}
                                    className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent">
                                    <Link2 className="mr-0.5 inline h-3 w-3" />Match
                                  </button>
                                  <button onClick={() => doIgnore(line.id)}
                                    className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent">Ignore</button>
                                </>
                              ) : (
                                <button onClick={() => unmatch(line.id)} disabled={pending}
                                  className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50">
                                  <Unlink className="mr-0.5 inline h-3 w-3" />Undo
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {picking?.lineId === line.id && (
                        <EntryPicker
                          line={line} entries={view.entries} currency={card?.currency ?? 'INR'}
                          picked={picking.entryIds} pending={pending}
                          onToggle={id => setPicking(p => p && ({
                            ...p,
                            entryIds: p.entryIds.includes(id) ? p.entryIds.filter(x => x !== id) : [...p.entryIds, id],
                          }))}
                          onSave={savePicks} onCancel={() => setPicking(null)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── The card's own entries ──────────────────────────────── */}
            <section className="rounded-xl border">
              <header className="flex items-center justify-between border-b px-4 py-2.5">
                <h3 className="text-sm font-semibold">Recorded on this card</h3>
                <span className="text-xs text-muted-foreground">
                  {unclaimed.length} of {view.entries.length} unmatched
                </span>
              </header>
              {view.entries.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No cashbook entries on this card in this cycle. Record card purchases against
                  the card account, dated the day they were charged.
                </p>
              ) : (
                <ul className="divide-y">
                  {view.entries.map((e: CycleView['entries'][number]) => (
                    <li key={e.id} className={'flex items-center gap-3 px-4 py-2.5 ' + (e.matchedLineId ? 'opacity-45' : '')}>
                      {e.matchedLineId
                        ? <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
                        : <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-orange-400" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{e.description || '(no description)'}</p>
                        <p className="text-xs text-muted-foreground">{e.entryDate}</p>
                      </div>
                      <p className="shrink-0 text-sm tabular-nums">{money(e.amount, card?.currency)}</p>
                    </li>
                  ))}
                </ul>
              )}
              {unclaimed.length > 0 && (
                <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                  An unmatched entry is recorded on the card but not on this statement — it may
                  belong to the next cycle, or to a different card.
                </p>
              )}
            </section>
          </div>
        </>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </Shell>
  )
}

/* ── Pieces ─────────────────────────────────────────────────────────────── */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4 pb-24 pt-6 md:p-8">
      <div>
        <h2 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <CreditCard className="h-7 w-7" /> Card Statements
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Match each charge on a card statement to what the cash book recorded, one billing
          cycle at a time.
        </p>
      </div>
      {children}
    </div>
  )
}

function Notice({ tone, title, children }: { tone: 'warn' | 'info'; title: string; children: React.ReactNode }) {
  return (
    <div className={'rounded-xl border p-4 ' + (tone === 'warn' ? 'border-orange-500/40 bg-orange-500/5' : 'bg-muted/40')}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        {tone === 'warn' && <AlertTriangle className="h-4 w-4 text-orange-500" />}{title}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{children}</p>
    </div>
  )
}

function StatusDot({ status }: { status: 'unmatched' | 'matched' | 'ignored' }) {
  const cls = status === 'matched' ? 'bg-green-500'
    : status === 'ignored' ? 'bg-muted-foreground/40' : 'bg-orange-400'
  return <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + cls} title={status} />
}

function BalanceStrip({
  view, balance, currency, totalInput, setTotalInput, canManage, onSaveTotal, onClose, pending, unmatchedCount,
}: {
  view: CycleView
  balance: { linesTotal: number; difference: number | null; agrees: boolean } | null
  currency: string
  totalInput: string
  setTotalInput: (v: string) => void
  canManage: boolean
  onSaveTotal: () => void
  onClose: () => void
  pending: boolean
  unmatchedCount: number
}) {
  const ready = unmatchedCount === 0 && balance?.agrees === true
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border p-3">
      <Figure label="Lines add up to" value={money(balance?.linesTotal ?? 0, currency)} />
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Statement says
        <div className="flex gap-1">
          <input value={totalInput} onChange={e => setTotalInput(e.target.value)}
            onBlur={onSaveTotal} disabled={!canManage || !view.statementId || view.status === 'closed'}
            placeholder="total from the PDF"
            className="w-36 rounded-md border bg-background px-2 py-1 text-sm tabular-nums disabled:opacity-50" />
        </div>
      </label>
      <Figure
        label="Difference"
        value={balance?.difference === null ? '—' : money(balance!.difference!, currency)}
        tone={balance?.difference === null ? undefined : balance!.agrees ? 'good' : 'bad'}
      />
      <Figure label="Unmatched lines" value={String(unmatchedCount)} tone={unmatchedCount ? 'bad' : 'good'} />

      <div className="ml-auto flex items-center gap-2">
        {view.status === 'closed' ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-3 py-1 text-xs font-medium text-green-500">
            <Check className="h-3.5 w-3.5" /> Closed
          </span>
        ) : canManage && (
          <button onClick={onClose} disabled={pending || !ready}
            title={ready ? 'Close this cycle' : 'Every line must be matched or ignored, and the totals must agree'}
            className="rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-40">
            Close cycle
          </button>
        )}
      </div>
    </div>
  )
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={'text-sm font-semibold tabular-nums ' +
        (tone === 'good' ? 'text-green-500' : tone === 'bad' ? 'text-orange-400' : '')}>{value}</p>
    </div>
  )
}

function ImportPanel({
  paste, parsed, pending, totalInput, setTotalInput, hasExisting, onPaste, onFile, onImport, onCancel,
}: {
  paste: string
  parsed: ParseResult | null
  pending: boolean
  totalInput: string
  setTotalInput: (v: string) => void
  hasExisting: boolean
  onPaste: (text: string) => void
  onFile: (file: File) => void
  onImport: (replace: boolean) => void
  onCancel: () => void
}) {
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Import this cycle&rsquo;s statement</h3>
        <button onClick={onCancel} className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Paste the lines
          <textarea
            value={paste} onChange={e => onPaste(e.target.value)} rows={7}
            placeholder={'25/06/2026   ANTHROPIC CLAUDE.AI      2,286.83\n01/07/2026   GODADDY.COM 4806505        715.84'}
            className="rounded-md border bg-background px-2 py-1.5 font-mono text-xs" />
        </label>
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            …or upload the bank&rsquo;s export
            <input type="file" accept=".csv,.xls,.xlsx"
              onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f) }}
              className="text-xs file:mr-2 file:rounded file:border file:bg-background file:px-2 file:py-1 file:text-xs" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Statement total (optional now, required to close)
            <input value={totalInput} onChange={e => setTotalInput(e.target.value)}
              placeholder="e.g. 12450.75"
              className="w-44 rounded-md border bg-background px-2 py-1 text-sm tabular-nums" />
          </label>
        </div>
      </div>

      {parsed && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {parsed.lines.length} line{parsed.lines.length === 1 ? '' : 's'} read
            {parsed.problems.length > 0 && `, ${parsed.problems.length} could not be`}.
          </p>
          {parsed.datesAmbiguous && (
            <Notice tone="warn" title="Check the dates">
              Some dates could be read either way round — 03/04 is 3 April day-first and
              4 March month-first. They have been read <strong>day-first</strong>. If this
              statement is month-first, the charges will land in the wrong cycle.
            </Notice>
          )}
          {parsed.problems.length > 0 && (
            <ul className="max-h-24 space-y-0.5 overflow-y-auto rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
              {parsed.problems.slice(0, 8).map((p, i) => (
                <li key={i}><span className="font-mono">{p.raw.slice(0, 60)}</span> — {p.reason}</li>
              ))}
            </ul>
          )}
          {parsed.lines.length > 0 && (
            <ul className="max-h-40 divide-y overflow-y-auto rounded-md border text-xs">
              {parsed.lines.map((l: ParsedLine, i) => (
                <li key={i} className="flex justify-between gap-3 px-2 py-1">
                  <span className="shrink-0 text-muted-foreground">{l.txnDate}</span>
                  <span className="min-w-0 flex-1 truncate">{l.description}</span>
                  <span className={'shrink-0 tabular-nums ' + (l.amount < 0 ? 'text-green-500' : '')}>{l.amount}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={() => onImport(hasExisting)} disabled={pending || !parsed?.lines.length}
          className="rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">
          {pending ? 'Importing…' : hasExisting ? 'Replace this cycle’s lines' : 'Import'}
        </button>
        {hasExisting && (
          <span className="text-xs text-orange-400">
            This cycle already has lines — importing replaces them and every match made on them.
          </span>
        )}
      </div>
    </div>
  )
}

function EntryPicker({
  line, entries, currency, picked, pending, onToggle, onSave, onCancel,
}: {
  line: { id: string; amount: number }
  entries: CycleView['entries']
  currency: string
  picked: string[]
  pending: boolean
  onToggle: (id: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const sum = Math.round(picked.reduce((s, id) => s + (entries.find(e => e.id === id)?.amount ?? 0), 0) * 100) / 100
  const gap = Math.round((line.amount - sum) * 100) / 100
  const available = entries.filter(e => e.matchedLineId === null || picked.includes(e.id))
  return (
    <div className="mt-2 rounded-lg border bg-muted/30 p-2.5">
      <p className="mb-1.5 text-xs text-muted-foreground">
        Tick the entries that make up this charge. Several is normal — one charge is often
        split so each part carries its own category.
      </p>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {available.length === 0 && <li className="text-xs text-muted-foreground">No unmatched entries in this cycle.</li>}
        {available.map(e => (
          <li key={e.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent">
              <input type="checkbox" checked={picked.includes(e.id)} onChange={() => onToggle(e.id)} />
              <span className="shrink-0 text-muted-foreground">{e.entryDate}</span>
              <span className="min-w-0 flex-1 truncate">{e.description || '(no description)'}</span>
              <span className="shrink-0 tabular-nums">{money(e.amount, currency)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-3 border-t pt-2 text-xs">
        <span className="text-muted-foreground">Picked {money(sum, currency)}</span>
        <span className={Math.abs(gap) < 0.005 ? 'text-green-500' : 'text-orange-400'}>
          {Math.abs(gap) < 0.005 ? 'adds up exactly' : `${money(gap, currency)} to go`}
        </span>
        <div className="ml-auto flex gap-1.5">
          <button onClick={onCancel} className="rounded border px-2 py-1 hover:bg-accent">Cancel</button>
          <button onClick={onSave} disabled={pending || picked.length === 0}
            className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50">
            Match {picked.length > 1 ? `${picked.length} entries` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
