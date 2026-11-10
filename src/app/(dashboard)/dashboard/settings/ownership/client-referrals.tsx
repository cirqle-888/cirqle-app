'use client'

/**
 * Inside the built-in "Referral commission" program: the clients that came
 * through someone. Set once here and every job of that client in the date
 * range carries the referral — new ones by a database trigger, existing ones
 * when this is saved (see setClientReferral). A job can still be set on its
 * own in its edit window.
 */

import { useState } from 'react'
import { Plus, Loader2, Pencil, X } from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import { referralCommission } from '@/lib/ownership/referral'
import { setClientReferral } from './actions'

export interface ClientReferralRow {
  clientId: string
  employeeId: string
  percent: number
  from: string
  until: string | null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const niceDate = (d: string) => {
  const [y, m, day] = d.split('-').map(Number)
  return y && m && day ? `${day} ${MONTHS[m - 1]} ${y}` : d
}
const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`

interface Draft { clientId: string; employeeId: string; pct: string; from: string; until: string; editing: boolean }

export function ClientReferrals({
  clients, employees, referrals, thisMonth, monthLabel, defaultFrom, onSaved, onError, onConfirm,
}: {
  clients: { id: string; name: string }[]
  employees: { id: string; cqid: string }[]
  /** null = the client-referral migration has not run yet. */
  referrals: ClientReferralRow[] | null
  /** clientId → this month's referred jobs and what they pay. */
  thisMonth: Record<string, { jobs: number; earnedInr: number }>
  monthLabel: string
  /** YYYY-MM-DD — the 1st of the current month. */
  defaultFrom: string
  onSaved: (title: string, detail?: string) => void
  onError: (title: string, detail?: string) => void
  onConfirm: (p: { title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void
}) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  if (referrals === null) {
    return (
      <p className="text-xs text-muted-foreground">
        To set a referral once for a whole client, run{' '}
        <code className="rounded bg-secondary px-1">supabase/migrations/20261110200000_client_referral.sql</code>{' '}
        in the Supabase SQL editor.
      </p>
    )
  }

  const clientName = (id: string) => clients.find(c => c.id === id)?.name ?? 'Inactive client'
  const cqid = (id: string) => employees.find(e => e.id === id)?.cqid ?? 'Inactive staff'
  const taken = new Set(referrals.map(r => r.clientId))
  const sorted = [...referrals].sort((a, b) => clientName(a.clientId).localeCompare(clientName(b.clientId)))

  const pctNum = Number(draft?.pct)
  const draftValid = !!draft && !!draft.clientId && !!draft.employeeId
    && draft.pct.trim() !== '' && pctNum > 0 && pctNum <= 100
    && !!draft.from && (!draft.until || draft.until >= draft.from)

  function resultToast(name: string, res: { jobsUpdated: number; jobsLocked: number } | undefined, removed = false) {
    const n = res?.jobsUpdated ?? 0
    const parts = [
      n ? `${n} existing job${n === 1 ? '' : 's'} updated.` : 'No existing jobs needed changing.',
      res?.jobsLocked ? `${res.jobsLocked} in paid months left as they were.` : '',
    ].filter(Boolean)
    onSaved(removed ? `Referral removed from ${name}` : `Referral saved for ${name}`, parts.join(' '))
  }

  async function save() {
    if (!draft || !draftValid) return
    setBusy('save')
    const res = await setClientReferral(draft.clientId, draft.employeeId, pctNum, draft.from, draft.until || null)
    setBusy(null)
    if (!res.ok) { onError('Could not save', res.error); return }
    resultToast(clientName(draft.clientId), res.data)
    setDraft(null)
  }

  function remove(r: ClientReferralRow) {
    const name = clientName(r.clientId)
    onConfirm({
      title: `Remove the referral from ${name}?`,
      body: `New ${name} jobs stop paying ${cqid(r.employeeId)}. Jobs in unpaid months that got it from this client are cleared too; paid months and jobs set by hand stay as they are.`,
      confirmLabel: 'Remove referral',
      danger: true,
      onConfirm: async () => {
        setBusy(r.clientId)
        const res = await setClientReferral(r.clientId, null, null, null, null)
        setBusy(null)
        if (!res.ok) { onError('Could not remove', res.error); return }
        resultToast(name, res.data, true)
      },
    })
  }

  const field = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm'

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-foreground">
          Clients that came through someone
          <span className="ml-1.5 font-normal text-muted-foreground">· every job of the client pays the referral</span>
        </p>
        {!draft && (
          <button
            onClick={() => setDraft({ clientId: '', employeeId: '', pct: '', from: defaultFrom, until: '', editing: false })}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-secondary"
          >
            <Plus className="h-3.5 w-3.5" /> Add client
          </button>
        )}
      </div>

      {sorted.length === 0 && !draft && (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          None yet. Add a client and its jobs will carry the referral automatically, so nobody has to remember it on each job.
        </p>
      )}

      {sorted.length > 0 && (
        <div className="divide-y divide-border rounded-lg border border-border">
          {sorted.map(r => {
            const m = thisMonth[r.clientId]
            return (
              <div key={r.clientId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{clientName(r.clientId)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {cqid(r.employeeId)} · {r.percent}% · from {niceDate(r.from)}{r.until ? ` to ${niceDate(r.until)}` : ', no end date'}
                  </p>
                </div>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {monthLabel}: {m ? <>{m.jobs} job{m.jobs === 1 ? '' : 's'} · <span className="font-semibold text-foreground">{inr(m.earnedInr)}</span></> : 'no jobs yet'}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setDraft({ clientId: r.clientId, employeeId: r.employeeId, pct: String(r.percent), from: r.from, until: r.until ?? '', editing: true })}
                    disabled={busy !== null}
                    aria-label={`Edit referral for ${clientName(r.clientId)}`}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => remove(r)}
                    disabled={busy !== null}
                    aria-label={`Remove referral for ${clientName(r.clientId)}`}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                  >
                    {busy === r.clientId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {draft && (
        <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem_6rem] gap-2">
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">Client</label>
              <AppSelect value={draft.clientId} disabled={draft.editing} onChange={e => setDraft({ ...draft, clientId: e.target.value })}>
                <option value="">— select —</option>
                {clients.filter(c => !taken.has(c.id) || c.id === draft.clientId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </AppSelect>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">Referred by</label>
              <AppSelect value={draft.employeeId} onChange={e => setDraft({ ...draft, employeeId: e.target.value })}>
                <option value="">— select —</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.cqid}</option>)}
              </AppSelect>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">Commission</label>
              <div className="relative">
                <input
                  type="number" inputMode="decimal" min={0} max={100} step="0.5" placeholder="%"
                  value={draft.pct} onChange={e => setDraft({ ...draft, pct: e.target.value })}
                  aria-label="Commission percent" className={field + ' pr-7'}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">Jobs dated from</label>
              <input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} className={field} />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">Until <span className="font-normal">(optional)</span></label>
              <input type="date" value={draft.until} min={draft.from || undefined} onChange={e => setDraft({ ...draft, until: e.target.value })} className={field} />
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {draftValid
              ? <>Every {clientName(draft.clientId)} job dated {niceDate(draft.from)}{draft.until ? ` to ${niceDate(draft.until)}` : ' onwards'} pays{' '}
                  {cqid(draft.employeeId)} {pctNum}% of its billing (₹10,000 job → {inr(referralCommission(10000, pctNum))}).{' '}
                  Jobs already in that range without a referral get it now, except in paid months. A job set differently by hand keeps its own.</>
              : draft.until && draft.from && draft.until < draft.from
                ? 'The end date is before the start date.'
                : 'Pick the client, who it came through and their %.'}
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDraft(null)} disabled={busy === 'save'}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50">Cancel</button>
            <button onClick={save} disabled={!draftValid || busy === 'save'}
              className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
              {busy === 'save' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
