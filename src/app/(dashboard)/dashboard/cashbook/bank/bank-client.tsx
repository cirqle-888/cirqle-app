'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import {
  AlertTriangle, ArrowLeftRight, Check, ClipboardCopy, Copy, FileUp, Landmark,
  Link2, Loader2, RefreshCw, Sparkles, Tags, Unlink, X,
} from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { copyToClipboard } from '@/lib/clipboard'
import { buildExtractionPrompt, buildStatementTemplate, STATEMENT_HEADER } from '@/lib/bank/import-format'
import { periodLabel, type Period } from '@/lib/bank/period'
import { LINE_KINDS, LINE_KIND_MAP, suggestKind, type KindSummary } from '@/lib/bank/line-kinds'
import { buildHeader } from '@/lib/import/engine'
import { CASHBOOK_FIELDS } from '@/lib/import/schemas/financial'
import {
  guessColumns, parseStatementRows, parseStatementText,
  type ColumnMap, type ParsedLine, type ParseResult,
} from '@/lib/reconcile/parse'
import type { Hint } from '@/lib/reconcile/match'
import {
  analysePeriod, applyMatches, closePeriod, ignoreLine, importStatement, loadPeriod,
  reopenPeriod, setBalances, setLineKinds, type MismatchReport, type PeriodView,
} from './actions'

/**
 * Reconciling a bank statement against the cash book.
 *
 * THE QUESTION THE SCREEN IS BUILT AROUND is not "are these two lists equal"
 * but "where exactly do they differ, and which way". So the answer is stated
 * as three counts before any list appears:
 *
 *   AGREED      — on the statement and in the books
 *   MISSING     — the bank saw it, the books did not
 *   UNEXPLAINED — the books have it, the statement does not
 *
 * and every MISSING line carries a sentence about the nearest thing to it,
 * because "unmatched" on its own is a list of work rather than an answer. An
 * amount recorded eleven days late, or recorded as money in when it went out,
 * is already in the books and WRONG — which is far harder to spot by eye than
 * something simply absent, and is what this screen is really for.
 *
 * Nothing here decides anything. The matcher proposes, a person accepts, and a
 * period only closes when every line is accounted for AND the opening balance
 * plus the movement lands exactly on the closing balance.
 */

export interface AccountOption {
  id: string
  name: string
  type: string
  currency: string
  bankName: string | null
  last4: string | null
  reconcileFrom: string | null
  periods: Period[]
}

interface Props {
  accounts: AccountOption[]
  canManage: boolean
  migrationMissing: boolean
}

const money = (n: number, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n)

const num = (s: string): number | null => {
  const t = s.trim()
  if (t === '') return null
  const v = Number(t.replace(/[^\d.-]/g, ''))
  return Number.isFinite(v) ? v : null
}

const csvEscape = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`

export default function BankClient({ accounts, canManage, migrationMissing }: Props) {
  const { success, error: toastError, toasts, dismiss } = useToast()

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const account = accounts.find(a => a.id === accountId) ?? null

  /**
   * The period on screen.
   *
   * Whatever the person last picked or typed is kept as they switch accounts —
   * comparing the same month across two accounts is the common case, and
   * resetting to each account's newest period would fight them every time. A
   * period that is not one of this account's month presets still renders,
   * because the select carries an extra option for it.
   */
  const [chosen, setChosen] = useState<Period | null>(accounts[0]?.periods[0] ?? null)
  const period = useMemo<Period | null>(
    () => (account ? (chosen ?? account.periods[0] ?? null) : null),
    [account, chosen])

  const [answer, setAnswer] = useState<{ key: string; view: PeriodView | null }>({ key: '', view: null })
  const [report, setReport] = useState<{ key: string; data: MismatchReport | null }>({ key: '', data: null })
  const [reloads, setReloads] = useState(0)
  const [pending, startTransition] = useTransition()

  const [showImport, setShowImport] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [paste, setPaste] = useState('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [wrongAccount, setWrongAccount] = useState<string | null>(null)
  const [typedOpening, setTypedOpening] = useState<{ key: string; value: string }>({ key: '', value: '' })
  const [typedClosing, setTypedClosing] = useState<{ key: string; value: string }>({ key: '', value: '' })
  /** Which line the person is choosing entries for, and their picks so far. */
  const [picking, setPicking] = useState<{ lineId: string; entryIds: string[] } | null>(null)

  /**
   * The period, tagged with the question it answers.
   *
   * Loading is DERIVED from that tag rather than set when the effect starts. A
   * state write in an effect's body costs a second render pass every time the
   * account or period changes, and React's lint rule rightly refuses it.
   */
  const question = account && period ? `${account.id} :: ${period.start} :: ${period.end} :: ${reloads}` : ''
  const answered = answer.key === question
  const view = answered ? answer.view : null
  const loading = Boolean(question) && !answered

  useEffect(() => {
    if (!account || !period) return
    let live = true
    const key = `${account.id} :: ${period.start} :: ${period.end} :: ${reloads}`
    void loadPeriod(account.id, period).then(res => {
      if (!live) return
      if (!res.ok) toastError('Could not load the period', res.error)
      setAnswer({ key, view: res.data ?? null })
    })
    void analysePeriod(account.id, period).then(res => {
      if (!live) return
      setReport({ key, data: res.data ?? null })
    })
    return () => { live = false }
  }, [account, period, reloads, toastError])

  // Tagged like the period is, so a stale report never annotates a new one.
  // Derived from the stable `report.data` object rather than from a fresh
  // array each render, which is what lets the two maps below actually memoise.
  const analysed = report.key === question ? report.data : null
  const hints = useMemo(() => analysed?.hints ?? [], [analysed])
  const duplicates = useMemo(() => analysed?.duplicates ?? [], [analysed])
  const hintByLine = useMemo(() => new Map(hints.map(h => [h.lineId, h])), [hints])
  const duplicateIds = useMemo(
    () => new Set(duplicates.flatMap(d => d.entryIds)), [duplicates])

  /* ── Balances, typed off the statement ───────────────────────────────── */

  const openingInput = typedOpening.key === question
    ? typedOpening.value
    : (view?.openingBalance == null ? '' : String(view.openingBalance))
  const closingInput = typedClosing.key === question
    ? typedClosing.value
    : (view?.closingBalance == null ? '' : String(view.closingBalance))

  const balance = useMemo(() => {
    if (!view) return null
    const movement = Math.round(view.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100
    const opening = num(openingInput)
    const closing = num(closingInput)
    if (opening === null || closing === null) {
      return { movement, expectedClosing: null, difference: null, agrees: false }
    }
    const expectedClosing = Math.round((opening + movement) * 100) / 100
    const difference = Math.round((expectedClosing - closing) * 100) / 100
    return { movement, expectedClosing, difference, agrees: Math.abs(difference) < 0.005 }
  }, [view, openingInput, closingInput])

  const refresh = useCallback(() => { setReloads(n => n + 1) }, [])

  const entryById = useMemo(() => new Map((view?.entries ?? []).map(e => [e.id, e])), [view])
  const unmatchedLines = (view?.lines ?? []).filter(l => l.status === 'unmatched')
  const unclaimed = (view?.entries ?? []).filter(e => e.matchedLineId === null)
  const agreed = (view?.lines ?? []).filter(l => l.status === 'matched').length

  /* ── Getting a statement in ──────────────────────────────────────────── */

  function onPaste(text: string) {
    setPaste(text)
    setWrongAccount(null)
    if (!text.trim()) { setParsed(null); return }

    // A CSV (the app's own template, or a bank's export) is recognised by
    // having a header row the column guesser understands. Anything else is
    // treated as lines copied off a statement.
    const rows = text.split(/\r?\n/).filter(r => r.trim()).map(splitCsvLine)
    const found = findHeader(rows)
    if (found) {
      const mismatch = accountMismatch(rows, found.headerAt, account?.name ?? '')
      if (mismatch) { setWrongAccount(mismatch); setParsed(null); return }
      setParsed(parseStatementRows(rows.slice(found.headerAt + 1), found.map, { convention: 'bank' }))
      return
    }
    setParsed(parseStatementText(text, { convention: 'bank', openingBalance: num(openingInput) }))
  }

  async function onFile(file: File) {
    try {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv'
      let rows: unknown[][]
      if (isCsv) {
        rows = (await file.text()).split(/\r?\n/).filter(Boolean).map(splitCsvLine)
      } else {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false, raw: false })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false }) as unknown[][]
      }
      if (!rows.length) { toastError('That file has no rows'); return }

      const found = findHeader(rows)
      if (!found) {
        toastError('Could not find the columns',
          'No row looked like a header with a date, a description and an amount. Paste the lines instead, or use the template.')
        return
      }
      const mismatch = accountMismatch(rows, found.headerAt, account?.name ?? '')
      if (mismatch) { setWrongAccount(mismatch); setParsed(null); return }

      setWrongAccount(null)
      const result = parseStatementRows(rows.slice(found.headerAt + 1), found.map, { convention: 'bank' })
      setParsed(result)
      setPaste('')
      success(`Read ${result.lines.length} line${result.lines.length === 1 ? '' : 's'} from ${file.name}`)
    } catch (err) {
      toastError('Could not read that file', err instanceof Error ? err.message : undefined)
    }
  }

  function doImport(replace: boolean) {
    if (!account || !period || !parsed?.lines.length) return
    startTransition(async () => {
      const res = await importStatement({
        bankAccountId: account.id,
        period,
        lines: parsed.lines,
        openingBalance: num(openingInput),
        closingBalance: num(closingInput),
        replace,
      })
      if (!res.ok) { toastError('Import refused', res.error); return }
      success(`${res.data!.lineCount} lines imported`,
        res.data!.replaced ? 'The previous lines and matches were replaced.' : undefined)
      setShowImport(false); setPaste(''); setParsed(null)
      refresh()
    })
  }

  /* ── Matching ────────────────────────────────────────────────────────── */

  function autoMatch() {
    if (!account || !period) return
    startTransition(async () => {
      const res = await analysePeriod(account.id, period)
      if (!res.ok || !res.data) { toastError('Could not match', res.error); return }
      const proposals = res.data.proposals.filter(p => p.entryIds.length)
      if (!proposals.length) { toastError('Nothing to match', 'No statement line could be matched to an entry.'); return }
      const applied = await applyMatches({
        bankAccountId: account.id,
        matches: proposals.map(p => ({ lineId: p.lineId, entryIds: p.entryIds })),
        auto: true,
      })
      if (!applied.ok) { toastError('Could not save the matches', applied.error); return }
      const splits = proposals.filter(p => p.confidence === 'split').length
      success(`${applied.data!.linesMatched} matched`,
        splits ? `${splits} of them were splits — check those before closing.` : undefined)
      refresh()
    })
  }

  function savePicks() {
    if (!account || !picking) return
    startTransition(async () => {
      const res = await applyMatches({ bankAccountId: account.id, matches: [{ lineId: picking.lineId, entryIds: picking.entryIds }] })
      if (!res.ok) { toastError('Could not match', res.error); return }
      setPicking(null)
      refresh()
    })
  }

  function unmatch(lineId: string) {
    if (!account) return
    startTransition(async () => {
      const res = await applyMatches({ bankAccountId: account.id, matches: [{ lineId, entryIds: [] }] })
      if (!res.ok) { toastError('Could not unmatch', res.error); return }
      refresh()
    })
  }

  /** Set one line aside as a kind, or put it back when kind is null. */
  function classify(lineIds: string[], kind: string | null, note?: string) {
    if (!account || !lineIds.length) return
    startTransition(async () => {
      const res = await setLineKinds({ bankAccountId: account.id, lineIds, kind, note })
      if (!res.ok) { toastError('Could not set those aside', res.error); return }
      const label = kind === null ? null : LINE_KIND_MAP[kind]?.label
      success(kind === null
        ? `${res.data!.changed} line${res.data!.changed === 1 ? '' : 's'} back in play`
        : `${res.data!.changed} set aside as ${label}`)
      refresh()
    })
  }

  /**
   * Offer a kind for every unmatched line whose wording gives one away.
   *
   * Proposes in bulk but applies per kind, and only where `suggestKind` is
   * sure — 44 sweep lines is the difference between this being used and being
   * abandoned, while a guessed kind on a client receipt is a wrong total.
   */
  function suggestAll() {
    if (!view) return
    const byKind = new Map<string, string[]>()
    for (const line of view.lines) {
      if (line.status === 'matched' || line.lineKind) continue
      const kind = suggestKind(line.description)
      if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), line.id])
    }
    if (!byKind.size) { toastError('Nothing to suggest', 'No remaining line names itself clearly enough.'); return }
    const total = [...byKind.values()].reduce((n, ids) => n + ids.length, 0)
    const summary = [...byKind.entries()].map(([k, ids]) => `${ids.length} × ${LINE_KIND_MAP[k].label}`).join(', ')
    if (!window.confirm(`Set aside ${total} lines?\n\n${summary}\n\nYou can put any of them back afterwards.`)) return
    if (!account) return
    startTransition(async () => {
      for (const [kind, ids] of byKind) {
        const res = await setLineKinds({ bankAccountId: account.id, lineIds: ids, kind })
        if (!res.ok) { toastError('Could not set those aside', res.error); return }
      }
      success(`${total} lines set aside`, summary)
      refresh()
    })
  }

  function doIgnore(lineId: string) {
    const reason = window.prompt('Why does this line have no cash book entry?\n(an internal transfer recorded from the other side, a charge already booked elsewhere…)')
    if (reason === null) return
    startTransition(async () => {
      const res = await ignoreLine(lineId, reason)
      if (!res.ok) { toastError('Could not ignore the line', res.error); return }
      refresh()
    })
  }

  /* ── Balances and closing ────────────────────────────────────────────── */

  function saveBalances() {
    if (!view?.statementId) return
    startTransition(async () => {
      const res = await setBalances(view.statementId!, num(openingInput), num(closingInput))
      if (!res.ok) { toastError('Could not save the balances', res.error); return }
      refresh()
    })
  }

  function doClose() {
    if (!account || !period) return
    startTransition(async () => {
      const res = await closePeriod(account.id, period)
      if (!res.ok) { toastError('Cannot close this period yet', res.error); return }
      success('Period closed', 'Every line is accounted for and the balances agree.')
      refresh()
    })
  }

  function doReopen() {
    if (!view?.statementId) return
    startTransition(async () => {
      const res = await reopenPeriod(view.statementId!)
      if (!res.ok) { toastError('Could not reopen', res.error); return }
      refresh()
    })
  }

  /* ── Copying things out ──────────────────────────────────────────────── */

  async function copy(text: string, what: string) {
    if (await copyToClipboard(text)) success(`${what} copied`)
    else toastError(`Could not copy the ${what.toLowerCase()}`, 'Select it and copy manually.')
  }

  /**
   * The missing lines, as rows for the cash book's own bulk importer.
   *
   * The header comes from CASHBOOK_FIELDS rather than being typed out here, so
   * a column added to the importer cannot leave this export quietly stale.
   * Category is left blank on purpose: only a person can say what an expense
   * was for, and a guessed category is worse than an empty one.
   */
  function missingAsImportCsv(): string {
    const header = buildHeader(CASHBOOK_FIELDS).split(',')
    const rows = unmatchedLines.map(line => {
      const cells: Record<string, string> = {
        entry_date: line.txnDate,
        type: line.amount >= 0 ? 'inflow' : 'outflow',
        bank_account: account?.name ?? '',
        amount: String(Math.abs(line.amount)),
        currency: view?.currency ?? 'INR',
        description: line.description,
        reference: line.reference ?? '',
        notes: `From bank statement ${view?.label ?? ''}`.trim(),
      }
      return header.map(h => csvEscape(cells[h] ?? '')).join(',')
    })
    return [header.join(','), ...rows].join('\n')
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  if (migrationMissing) {
    return (
      <Shell>
        <Notice tone="warn" title="The database is not ready for this yet">
          Apply <code className="font-mono text-xs">supabase/migrations/20260922100000_bank_reconciliation.sql</code>{' '}
          in the Supabase SQL editor, then reload. It adds the three statement tables and two
          permissions; it changes no existing entry.
        </Notice>
      </Shell>
    )
  }

  if (!accounts.length) {
    return (
      <Shell>
        <Notice tone="info" title="No bank or cash accounts yet">
          Add one in <strong>Settings → Accounts</strong>, then set the date you want
          reconciliation to start from. Credit cards are reconciled separately, under
          <strong> Card Statements</strong>, because they bill on a cycle rather than a date range.
        </Notice>
      </Shell>
    )
  }

  return (
    <Shell>
      {/* ── Pickers ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Account
          <AppSelect value={accountId} onChange={e => setAccountId(e.target.value)} className="min-w-56">
            {accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}{a.last4 ? ` ····${a.last4}` : ''}{a.currency !== 'INR' ? ` (${a.currency})` : ''}
              </option>
            ))}
          </AppSelect>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Statement period
          <AppSelect
            value={period ? `${period.start}|${period.end}` : ''}
            onChange={e => {
              const [start, end] = e.target.value.split('|')
              if (start && end) setChosen({ start, end })
            }}
            className="min-w-52">
            {account?.periods.length
              ? account.periods.map(p => (
                <option key={p.start} value={`${p.start}|${p.end}`}>{periodLabel(p)}</option>
              ))
              : <option value="">No periods yet</option>}
            {period && !account?.periods.some(p => p.start === period.start && p.end === period.end) && (
              <option value={`${period.start}|${period.end}`}>{periodLabel(period)}</option>
            )}
          </AppSelect>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          …or an exact range
          <div className="flex items-center gap-1">
            <input type="date" value={period?.start ?? ''}
              onChange={e => period && e.target.value && setChosen({ start: e.target.value, end: period.end })}
              className="rounded-md border bg-background px-2 py-1.5 text-sm" />
            <span className="text-muted-foreground">–</span>
            <input type="date" value={period?.end ?? ''}
              onChange={e => period && e.target.value && setChosen({ start: period.start, end: e.target.value })}
              className="rounded-md border bg-background px-2 py-1.5 text-sm" />
          </div>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setShowPrompt(v => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-accent">
            <Sparkles className="h-4 w-4" /> Convert a PDF
          </button>
          {canManage && view && view.status === 'open' && (
            <>
              <button onClick={() => setShowImport(v => !v)} disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">
                <FileUp className="h-4 w-4" /> {view.lines.length ? 'Re-import' : 'Import statement'}
              </button>
              {view.lines.length > 0 && (
                <button onClick={suggestAll} disabled={pending}
                  title="Set aside every line that names itself — sweeps, cashback, interest, bank charges"
                  className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">
                  <Tags className="h-4 w-4" /> Suggest kinds
                </button>
              )}
              {view.lines.length > 0 && (
                <button onClick={autoMatch} disabled={pending || unmatchedLines.length === 0}
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

      {showPrompt && (
        <PromptPanel
          accounts={accounts} period={period}
          onCopyPrompt={() => copy(buildExtractionPrompt({
            accountNames: accounts.map(a => a.name),
            periodStart: period?.start ?? null,
            periodEnd: period?.end ?? null,
          }), 'Prompt')}
          onCopyTemplate={() => copy(buildStatementTemplate(account?.name ?? 'HDFC Current'), 'Template')}
          onClose={() => setShowPrompt(false)}
        />
      )}

      {showImport && canManage && (
        <ImportPanel
          paste={paste} parsed={parsed} pending={pending} wrongAccount={wrongAccount}
          accountName={account?.name ?? ''}
          openingInput={openingInput} closingInput={closingInput}
          setOpening={v => setTypedOpening({ key: question, value: v })}
          setClosing={v => setTypedClosing({ key: question, value: v })}
          hasExisting={Boolean(view?.lines.length)}
          onPaste={onPaste} onFile={onFile}
          onImport={doImport}
          onCancel={() => { setShowImport(false); setParsed(null); setPaste(''); setWrongAccount(null) }}
        />
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading the period…</p>}

      {view && !loading && (
        <>
          <BalanceStrip
            view={view} balance={balance} currency={view.currency}
            openingInput={openingInput} closingInput={closingInput}
            setOpening={v => setTypedOpening({ key: question, value: v })}
            setClosing={v => setTypedClosing({ key: question, value: v })}
            canManage={canManage} onSave={saveBalances} onClose={doClose}
            pending={pending} unmatchedCount={unmatchedLines.length}
          />

          <Verdict
            agreed={agreed}
            missing={unmatchedLines.length}
            unexplained={unclaimed.length}
            hasStatement={view.lines.length > 0}
            onCopyMissing={() => copy(missingAsImportCsv(), 'Missing entries')}
            canCopy={unmatchedLines.length > 0}
          />

          <KindsPanel kinds={view.kinds} currency={view.currency} />

          {duplicates.length > 0 && (
            <Notice tone="warn" title="Possible double entries">
              <ul className="mt-1 space-y-0.5">
                {duplicates.map((d, i) => <li key={i}>· {d.message}</li>)}
              </ul>
            </Notice>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* ── Statement lines ─────────────────────────────────────── */}
            <section className="rounded-xl border">
              <header className="flex items-center justify-between border-b px-4 py-2.5">
                <h3 className="text-sm font-semibold">On the statement</h3>
                <span className="text-xs text-muted-foreground">{view.lines.length} lines</span>
              </header>
              {view.lines.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  Nothing imported for this period yet. Use <strong>Convert a PDF</strong> to turn the
                  bank&rsquo;s file into the import format, then <strong>Import statement</strong>.
                </p>
              ) : (
                <ul className="divide-y">
                  {view.lines.map(line => (
                    <li key={line.id} className="px-4 py-2.5">
                      <div className="flex items-start gap-3">
                        <StatusDot status={line.status} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{line.description}</p>
                          <p className="text-xs text-muted-foreground">
                            {line.txnDate}
                            {line.reference && <span className="ml-2 font-mono">{line.reference}</span>}
                            {line.balanceAfter !== null && (
                              <span className="ml-2">bal {money(line.balanceAfter, view.currency)}</span>
                            )}
                          </p>
                          {line.status === 'ignored' && (
                            <p className="mt-0.5 text-xs italic text-muted-foreground">
                              {line.lineKind && LINE_KIND_MAP[line.lineKind]
                                ? LINE_KIND_MAP[line.lineKind].label
                                : 'Set aside'}
                              {line.ignoreReason ? ` — ${line.ignoreReason}` : ''}
                            </p>
                          )}
                          {line.status === 'unmatched' && hintByLine.get(line.id) && (
                            <HintLine hint={hintByLine.get(line.id)!} />
                          )}
                          {line.entryIds.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5 border-l-2 pl-2.5">
                              {line.entryIds.map(id => {
                                const e = entryById.get(id)
                                return (
                                  <li key={id} className="flex justify-between gap-2 text-xs text-muted-foreground">
                                    <span className="truncate">{e?.description || '(entry not in this period)'}</span>
                                    <span className="shrink-0 tabular-nums">{e ? money(e.amount, view.currency) : '—'}</span>
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
                          <p className={'text-sm font-medium tabular-nums ' + (line.amount >= 0 ? 'text-green-500' : '')}>
                            {money(line.amount, view.currency)}
                          </p>
                          {canManage && view.status === 'open' && (
                            <div className="mt-1 flex justify-end gap-1">
                              {line.status === 'unmatched' ? (
                                <>
                                  <button onClick={() => setPicking({ lineId: line.id, entryIds: [] })}
                                    className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent">
                                    <Link2 className="mr-0.5 inline h-3 w-3" />Match
                                  </button>
                                  {/* Set aside AS something. The old free-text
                                      Ignore is still there for the one-off that
                                      no kind describes, but a kind is what lets
                                      the line be counted afterwards. */}
                                  <select
                                    value=""
                                    onChange={e => e.target.value && classify([line.id], e.target.value)}
                                    disabled={pending}
                                    title="Set this line aside as…"
                                    className="rounded border bg-background px-1 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50">
                                    <option value="">Set aside…</option>
                                    {LINE_KINDS.map(k => (
                                      <option key={k.key} value={k.key} title={k.hint}>{k.label}</option>
                                    ))}
                                  </select>
                                  <button onClick={() => doIgnore(line.id)}
                                    className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent">Note…</button>
                                </>
                              ) : line.status === 'ignored' ? (
                                <button onClick={() => classify([line.id], null)} disabled={pending}
                                  className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50">
                                  <Unlink className="mr-0.5 inline h-3 w-3" />Put back
                                </button>
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
                          line={line} entries={view.entries} currency={view.currency}
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

            {/* ── The account's own entries ───────────────────────────── */}
            <section className="rounded-xl border">
              <header className="flex items-center justify-between border-b px-4 py-2.5">
                <h3 className="text-sm font-semibold">Recorded in the cash book</h3>
                <span className="text-xs text-muted-foreground">
                  {unclaimed.length} of {view.entries.length} unexplained
                </span>
              </header>
              {view.entries.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No cash book entries on this account in this period.
                </p>
              ) : (
                <ul className="divide-y">
                  {view.entries.map(e => (
                    <li key={e.id} className={'flex items-center gap-3 px-4 py-2.5 ' + (e.matchedLineId ? 'opacity-45' : '')}>
                      {e.matchedLineId
                        ? <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
                        : <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-orange-400" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          {e.description || '(no description)'}
                          {e.isTransfer && (
                            <span className="ml-1.5 inline-flex items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium text-purple-400">
                              <ArrowLeftRight className="h-2.5 w-2.5" />Transfer
                            </span>
                          )}
                          {duplicateIds.has(e.id) && (
                            <span className="ml-1.5 rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-400">
                              possible duplicate
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {e.entryDate}{e.categoryName ? ` · ${e.categoryName}` : ''}
                        </p>
                      </div>
                      <p className={'shrink-0 text-sm tabular-nums ' + (e.amount >= 0 ? 'text-green-500' : '')}>
                        {money(e.amount, view.currency)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {unclaimed.length > 0 && (
                <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                  An unexplained entry is in the books but not on this statement — it may be dated
                  into the wrong period, sit on the wrong account, or never have reached the bank.
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

/* ── CSV helpers ─────────────────────────────────────────────────────────── */

/** Split one CSV line, honouring quoted fields (which descriptions often need). */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map(c => c.trim())
}

/** The first row the column guesser recognises as a header, and its map. */
function findHeader(rows: readonly (readonly unknown[])[]): { headerAt: number; map: ColumnMap } | null {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const guess = guessColumns(rows[i].map(c => String(c ?? '')))
    if (guess.date !== undefined && guess.description !== undefined &&
        (guess.amount !== undefined || guess.debit !== undefined || guess.credit !== undefined)) {
      return { headerAt: i, map: guess as ColumnMap }
    }
  }
  return null
}

/**
 * Is this file actually for the account on screen?
 *
 * The template carries an `account` column precisely so that two accounts
 * extracted in one sitting cannot be imported into each other — the mistake
 * that produces a tidy-looking reconciliation of the wrong bank.
 */
function accountMismatch(
  rows: readonly (readonly unknown[])[],
  headerAt: number,
  selected: string,
): string | null {
  const header = rows[headerAt].map(c => String(c ?? '').trim().toLowerCase())
  const at = header.indexOf('account')
  if (at === -1 || !selected) return null

  const names = new Set(
    rows.slice(headerAt + 1)
      .map(r => String(r[at] ?? '').trim())
      .filter(Boolean))
  if (!names.size) return null

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const foreign = [...names].filter(n => norm(n) !== norm(selected))
  if (!foreign.length) return null
  return foreign.length === names.size
    ? `This file says it is for “${foreign[0]}”, but “${selected}” is selected. Switch account, or import the right file.`
    : `This file mixes accounts — it contains rows for ${foreign.map(f => `“${f}”`).join(', ')} as well as “${selected}”. Split it and import one account at a time.`
}

/* ── Pieces ─────────────────────────────────────────────────────────────── */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4 pb-24 pt-6 md:p-8">
      <div>
        <h2 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Landmark className="h-7 w-7" /> Bank Reconciliation
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Match a bank statement against the cash book, one account and one period at a time —
          and see exactly which transactions the two disagree about.
        </p>
      </div>
      {children}
    </div>
  )
}

function Notice({ tone, title, children }: { tone: 'warn' | 'info' | 'good'; title: string; children: React.ReactNode }) {
  const border = tone === 'warn' ? 'border-orange-500/40 bg-orange-500/5'
    : tone === 'good' ? 'border-green-500/40 bg-green-500/5' : 'bg-muted/40'
  return (
    <div className={'rounded-xl border p-4 ' + border}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        {tone === 'warn' && <AlertTriangle className="h-4 w-4 text-orange-500" />}{title}
      </p>
      <div className="mt-1 text-sm text-muted-foreground">{children}</div>
    </div>
  )
}

function StatusDot({ status }: { status: 'unmatched' | 'matched' | 'ignored' }) {
  const cls = status === 'matched' ? 'bg-green-500'
    : status === 'ignored' ? 'bg-muted-foreground/40' : 'bg-orange-400'
  return <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + cls} title={status} />
}

/** Why this line found nothing — the sentence that turns a list into an answer. */
function HintLine({ hint }: { hint: Hint }) {
  const tone = hint.kind === 'nothing-near' ? 'text-muted-foreground'
    : hint.kind === 'wrong-direction' ? 'text-orange-400' : 'text-amber-400'
  return <p className={'mt-1 text-xs ' + tone}>{hint.message}</p>
}

/**
 * The answer, before any list.
 *
 * Three counts in the three words a person actually uses: what agrees, what
 * the bank has that we do not, what we have that the bank does not.
 */
function Verdict({
  agreed, missing, unexplained, hasStatement, onCopyMissing, canCopy,
}: {
  agreed: number
  missing: number
  unexplained: number
  hasStatement: boolean
  onCopyMissing: () => void
  canCopy: boolean
}) {
  if (!hasStatement) return null
  if (missing === 0 && unexplained === 0) {
    return (
      <Notice tone="good" title="Everything agrees">
        All {agreed} statement line{agreed === 1 ? '' : 's'} matched a cash book entry, and no entry
        is left over.
      </Notice>
    )
  }
  return (
    <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-3">
      <Bucket n={agreed} label="Agreed" hint="on the statement and in the books" tone="good" />
      <Bucket n={missing} label="Missing from the cash book" hint="the bank recorded it, we did not" tone="bad" />
      <Bucket n={unexplained} label="Not on the statement" hint="we recorded it, the bank did not" tone="warn" />
      {canCopy && (
        <div className="sm:col-span-3">
          <button onClick={onCopyMissing}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs hover:bg-accent">
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy the {missing} missing line{missing === 1 ? '' : 's'} as a cash book import
          </button>
          <span className="ml-2 text-xs text-muted-foreground">
            Paste into Bulk Import → Cashbook Entries, add a category to each, and import.
          </span>
        </div>
      )}
    </div>
  )
}

function Bucket({ n, label, hint, tone }: { n: number; label: string; hint: string; tone: 'good' | 'bad' | 'warn' }) {
  const colour = n === 0 ? 'text-muted-foreground'
    : tone === 'good' ? 'text-green-500' : tone === 'bad' ? 'text-orange-400' : 'text-amber-400'
  return (
    <div>
      <p className={'text-2xl font-semibold tabular-nums ' + colour}>{n}</p>
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

/**
 * What was set aside, grouped — and what of it is not the company's.
 *
 * The reason the kinds exist. "Ignored" answers whether a period can close;
 * only a grouped total answers "how much cashback came in, and what do I move
 * out of this account", which is the question a mixed-use account actually
 * poses.
 */
function KindsPanel({ kinds, currency }: { kinds: KindSummary; currency: string }) {
  if (!kinds.groups.length) return null
  const owed = kinds.notCompanyFunds
  return (
    <div className="rounded-xl border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Set aside</h3>
        <span className="text-xs text-muted-foreground">
          {kinds.groups.reduce((n, g) => n + g.count, 0)} lines, not matched to the cash book
        </span>
      </div>

      <ul className="mt-2 divide-y">
        {kinds.groups.map(g => (
          <li key={g.kind.key} className="flex items-baseline gap-3 py-1.5">
            <span className="text-sm">{g.kind.label}</span>
            {g.kind.notCompanyFunds && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                not company funds
              </span>
            )}
            <span className="text-xs text-muted-foreground">{g.count} line{g.count === 1 ? '' : 's'}</span>
            <span className={'ml-auto shrink-0 text-sm tabular-nums ' + (g.total >= 0 ? 'text-green-500' : '')}>
              {money(g.total, currency)}
            </span>
          </li>
        ))}
      </ul>

      {kinds.groups.some(g => g.kind.notCompanyFunds) && (
        <div className="mt-2 flex flex-wrap items-baseline gap-2 border-t pt-2">
          <span className="text-sm font-medium">Not company funds, net</span>
          <span className={'text-base font-semibold tabular-nums ' + (owed >= 0 ? 'text-amber-400' : 'text-green-500')}>
            {money(owed, currency)}
          </span>
          <span className="text-xs text-muted-foreground">
            {owed > 0
              ? 'sitting in this account and belonging to someone else — move it out with an internal transfer in the Cash Book, which keeps both sides.'
              : owed < 0
                ? 'this account is out of pocket by that much on someone else’s behalf — move it in.'
                : 'nothing to settle.'}
          </span>
        </div>
      )}
    </div>
  )
}

function BalanceStrip({
  view, balance, currency, openingInput, closingInput, setOpening, setClosing,
  canManage, onSave, onClose, pending, unmatchedCount,
}: {
  view: PeriodView
  balance: { movement: number; expectedClosing: number | null; difference: number | null; agrees: boolean } | null
  currency: string
  openingInput: string
  closingInput: string
  setOpening: (v: string) => void
  setClosing: (v: string) => void
  canManage: boolean
  onSave: () => void
  onClose: () => void
  pending: boolean
  unmatchedCount: number
}) {
  const ready = unmatchedCount === 0 && balance?.agrees === true
  const locked = !canManage || !view.statementId || view.status === 'closed'
  return (
    <div className="flex flex-wrap items-end gap-4 rounded-xl border p-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Opening balance
        <input value={openingInput} onChange={e => setOpening(e.target.value)} onBlur={onSave}
          disabled={locked} placeholder="from the statement"
          className="w-36 rounded-md border bg-background px-2 py-1 text-sm tabular-nums disabled:opacity-50" />
      </label>
      <Figure label="Lines move it by" value={money(balance?.movement ?? 0, currency)} />
      <Figure label="So it should close at"
        value={balance?.expectedClosing === null ? '—' : money(balance!.expectedClosing!, currency)} />
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Statement closes at
        <input value={closingInput} onChange={e => setClosing(e.target.value)} onBlur={onSave}
          disabled={locked} placeholder="from the statement"
          className="w-36 rounded-md border bg-background px-2 py-1 text-sm tabular-nums disabled:opacity-50" />
      </label>
      <Figure
        label="Difference"
        value={balance?.difference === null ? '—' : money(balance!.difference!, currency)}
        tone={balance?.difference === null ? undefined : balance!.agrees ? 'good' : 'bad'}
      />

      <div className="ml-auto flex items-center gap-2">
        {view.status === 'closed' ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-3 py-1 text-xs font-medium text-green-500">
            <Check className="h-3.5 w-3.5" /> Closed
          </span>
        ) : canManage && (
          <button onClick={onClose} disabled={pending || !ready}
            title={ready ? 'Close this period' : 'Every line must be matched or ignored, and the balances must agree'}
            className="rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-40">
            Close period
          </button>
        )}
      </div>

      {balance && balance.difference !== null && !balance.agrees && (
        <p className="w-full text-xs text-orange-400">
          The imported lines do not carry the opening balance to the closing one. A line is missing
          from the import, or one was read the wrong way round — fix the import before matching,
          because no amount of matching will reveal it.
        </p>
      )}
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

/** The copy-and-go panel: hand a PDF to any assistant, paste the CSV back. */
function PromptPanel({
  accounts, period, onCopyPrompt, onCopyTemplate, onClose,
}: {
  accounts: AccountOption[]
  period: Period | null
  onCopyPrompt: () => void
  onCopyTemplate: () => void
  onClose: () => void
}) {
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4" /> Turn a PDF, CSV or screenshot into the import format
        </h3>
        <button onClick={onClose} className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
      </div>

      <ol className="space-y-1.5 text-sm text-muted-foreground">
        <li><strong className="text-foreground">1.</strong> Copy the prompt below.</li>
        <li>
          <strong className="text-foreground">2.</strong> Paste it into any AI assistant
          and attach your statement — a PDF, a CSV, a spreadsheet, or a photo of it.
        </li>
        <li>
          <strong className="text-foreground">3.</strong> Copy the CSV it returns and paste it
          into <strong className="text-foreground">Import statement</strong> here. If your statement
          covers several accounts, it returns one CSV block per account — import them one at a time,
          picking the matching account above each time.
        </li>
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onCopyPrompt}
          className="inline-flex items-center gap-1.5 rounded-lg border bg-accent/40 px-3 py-2 text-sm font-medium hover:bg-accent">
          <Copy className="h-4 w-4" /> Copy the prompt
        </button>
        <button onClick={onCopyTemplate}
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-accent">
          <Copy className="h-4 w-4" /> Copy a blank template
        </button>
        {period && (
          <span className="text-xs text-muted-foreground">
            The prompt asks only for {periodLabel(period)}.
          </span>
        )}
      </div>

      <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">It will come back as</p>
        <code className="block overflow-x-auto whitespace-pre font-mono">{STATEMENT_HEADER}</code>
        <p className="mt-1.5">
          Your account names are included in the prompt ({accounts.map(a => a.name).join(', ')}), so
          every row says which account it belongs to — and importing one account&rsquo;s statement
          into another is refused rather than silently accepted.
        </p>
      </div>
    </div>
  )
}

function ImportPanel({
  paste, parsed, pending, wrongAccount, accountName, openingInput, closingInput,
  setOpening, setClosing, hasExisting, onPaste, onFile, onImport, onCancel,
}: {
  paste: string
  parsed: ParseResult | null
  pending: boolean
  wrongAccount: string | null
  accountName: string
  openingInput: string
  closingInput: string
  setOpening: (v: string) => void
  setClosing: (v: string) => void
  hasExisting: boolean
  onPaste: (text: string) => void
  onFile: (file: File) => void
  onImport: (replace: boolean) => void
  onCancel: () => void
}) {
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Import this period&rsquo;s statement into {accountName}</h3>
        <button onClick={onCancel} className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Paste the CSV, or the statement lines
          <textarea
            value={paste} onChange={e => onPaste(e.target.value)} rows={8}
            placeholder={`${STATEMENT_HEADER}\n"HDFC Current","2026-07-01","NEFT CR SEA STAR","","25000.00","","125000.00"`}
            className="rounded-md border bg-background px-2 py-1.5 font-mono text-xs" />
        </label>
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            …or upload the bank&rsquo;s export
            <input type="file" accept=".csv,.xls,.xlsx"
              onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f) }}
              className="text-xs file:mr-2 file:rounded file:border file:bg-background file:px-2 file:py-1 file:text-xs" />
          </label>
          <div className="flex gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Opening balance
              <input value={openingInput} onChange={e => setOpening(e.target.value)}
                placeholder="e.g. 100000"
                className="w-36 rounded-md border bg-background px-2 py-1 text-sm tabular-nums" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Closing balance
              <input value={closingInput} onChange={e => setClosing(e.target.value)}
                placeholder="e.g. 123820"
                className="w-36 rounded-md border bg-background px-2 py-1 text-sm tabular-nums" />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Both are on the statement&rsquo;s summary. With them the import checks itself — a
            dropped line shows up before you match anything.
          </p>
        </div>
      </div>

      {wrongAccount && <Notice tone="warn" title="That is a different account">{wrongAccount}</Notice>}

      {parsed && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {parsed.lines.length} line{parsed.lines.length === 1 ? '' : 's'} read
            {parsed.problems.length > 0 && `, ${parsed.problems.length} could not be`}.
            {parsed.balanceChain?.used && ' The running balance was found and agrees, so every direction is checked rather than assumed.'}
          </p>
          {parsed.datesAmbiguous && (
            <Notice tone="warn" title="Check the dates">
              Some dates could be read either way round — 03/04 is 3 April day-first and 4 March
              month-first. They have been read <strong>day-first</strong>. Ask the assistant for
              YYYY-MM-DD, which the prompt already does, and this cannot arise.
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
                  <span className={'shrink-0 tabular-nums ' + (l.amount >= 0 ? 'text-green-500' : '')}>{l.amount}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={() => onImport(hasExisting)} disabled={pending || !parsed?.lines.length}
          className="rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">
          {pending ? 'Importing…' : hasExisting ? 'Replace this period’s lines' : 'Import'}
        </button>
        {hasExisting && (
          <span className="text-xs text-orange-400">
            This period already has lines — importing replaces them and every match made on them.
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
  entries: PeriodView['entries']
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
        Tick the entries that make up this line. Several is normal — one bank payment is often
        split so each part carries its own category.
      </p>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {available.length === 0 && <li className="text-xs text-muted-foreground">No unmatched entries in this period.</li>}
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
