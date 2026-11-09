'use client'

/**
 * "This job came through <staff> — pay them X%" — inside the task editor.
 *
 * Renders nothing unless the viewer manages rewards (payroll.manage_ownership)
 * AND the referral migration has run, so for everyone else the editor is
 * exactly as before. The values are lifted to the modal so the ordinary Save
 * button saves them; see TaskEditModal.
 */

import AppSelect from './app-select'
import { referralCommission } from '@/lib/ownership/referral'

export interface ReferralDraft {
  loaded: boolean
  available: boolean
  locked: boolean
  employees: { id: string; cqid: string }[]
  by: string
  pct: string
  initialBy: string
  initialPct: string
}

export const EMPTY_REFERRAL: ReferralDraft = {
  loaded: false, available: false, locked: false, employees: [],
  by: '', pct: '', initialBy: '', initialPct: '',
}

export const referralDirty = (r: ReferralDraft) =>
  r.available && !r.locked && (r.by !== r.initialBy || (r.pct.trim() || '') !== (r.initialPct.trim() || ''))

const inputCls = 'w-full bg-background border border-input rounded-lg px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function TaskReferralSection({
  value, onChange, billingInr, taskDate, showAmounts,
}: {
  value: ReferralDraft
  onChange: (patch: Partial<ReferralDraft>) => void
  /** The job's billing in ₹ — what the % is taken of. */
  billingInr: number
  taskDate: string
  /** Hide the ₹ preview from someone who cannot see task pricing. */
  showAmounts: boolean
}) {
  if (!value.loaded || !value.available) return null

  const pctNum = Number(value.pct)
  const valid = value.by && value.pct.trim() !== '' && pctNum > 0 && pctNum <= 100
  const payout = valid ? referralCommission(billingInr, pctNum) : 0
  const m = /^(\d{4})-(\d{2})/.exec(taskDate || '')
  const monthLabel = m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : 'the job’s month'

  return (
    <div className="rounded-xl border border-border/60 bg-secondary/30 p-3 space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-xs font-medium text-muted-foreground">Referral commission</label>
        {value.locked && <span className="text-[11px] text-muted-foreground">{monthLabel} payroll is closed</span>}
      </div>
      <div className="grid grid-cols-[1fr_6.5rem] gap-2">
        <AppSelect
          aria-label="Referred by"
          value={value.by}
          disabled={value.locked}
          onChange={e => onChange({ by: e.target.value, pct: e.target.value ? value.pct : '' })}
        >
          <option value="">No referral</option>
          {value.employees.map(e => <option key={e.id} value={e.id}>{e.cqid}</option>)}
        </AppSelect>
        <div className="relative">
          <input
            type="number" inputMode="decimal" min={0} max={100} step="0.5"
            aria-label="Commission percent"
            placeholder="%"
            value={value.pct}
            disabled={value.locked || !value.by}
            onChange={e => onChange({ pct: e.target.value })}
            className={inputCls + ' pr-7'}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
        </div>
      </div>
      {/* Says what will actually happen, so nobody has to work out where it lands. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {!value.by
          ? 'Pick the staff member this job came through to pay them a share of it.'
          : !valid
            ? 'Enter a % between 0 and 100.'
            : showAmounts
              ? <>Pays <span className="font-semibold text-foreground">₹{payout.toLocaleString('en-IN')}</span> into {monthLabel} payroll.</>
              : <>Pays {pctNum}% of this job into {monthLabel} payroll.</>}
      </p>
    </div>
  )
}
