'use client'

/**
 * Shared budget editor — used by the New Campaign form and the project detail
 * Budget tab so the two-budget math + daily-budget auto-calc live in ONE place.
 *
 * Total mode:  enter the lump-sum ad spend directly.
 * Daily mode:  enter a per-day budget + pick a duration (7/14/30 days or the
 *              campaign's start→end date range); the total auto-calculates.
 * Either way the resolved total feeds computeBudgetTotals (subtotal/tax/grand).
 */

import { useMemo } from 'react'
import { DURATION_PRESETS } from '@/lib/advertising/types'
import { computeBudgetTotals, resolveAdSpend } from '@/lib/advertising/budget'

export interface BudgetValue {
  mode: 'total' | 'daily'
  adBudget: string
  dailyBudget: string
  durationPreset: string // '7' | '14' | '30' | 'custom'
  currency: string
  scType: 'fixed' | 'percent'
  scValue: string
  taxPercent: string
  /** When a service defines the pricing, the charge is auto-derived; flip this to edit it by hand. */
  overrideServiceCharge: boolean
}

export function emptyBudget(over: Partial<BudgetValue> = {}): BudgetValue {
  return {
    mode: 'total', adBudget: '', dailyBudget: '', durationPreset: '7',
    currency: 'INR', scType: 'fixed', scValue: '', taxPercent: '', overrideServiceCharge: false, ...over,
  }
}

/** Resolve the total ad spend + day count for the current value (shared with the parents' submit). */
export function resolveBudget(v: BudgetValue, startDate?: string | null, endDate?: string | null) {
  return resolveAdSpend({
    mode: v.mode, adBudget: v.adBudget, dailyBudget: v.dailyBudget,
    durationPreset: v.durationPreset, startDate, endDate,
  })
}

const inr = (v: number) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

export interface DerivedPricing {
  serviceName: string
  isPercent: boolean
  value: number
}

export default function BudgetFields({
  value, onChange, startDate, endDate, disabled = false, derivedPricing = null,
}: {
  value: BudgetValue
  onChange: (patch: Partial<BudgetValue>) => void
  startDate?: string | null
  endDate?: string | null
  disabled?: boolean
  derivedPricing?: DerivedPricing | null
}) {
  const { adSpend, days } = resolveBudget(value, startDate, endDate)
  const totals = useMemo(() => computeBudgetTotals({
    adBudget: adSpend,
    serviceChargeType: value.scType,
    serviceChargeValue: Number(value.scValue) || 0,
    taxPercent: Number(value.taxPercent) || 0,
  }), [adSpend, value.scType, value.scValue, value.taxPercent])

  const field = 'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-pink-500/40 disabled:opacity-60'
  const labelCls = 'block text-xs font-medium text-muted-foreground mb-1'
  const isDaily = value.mode === 'daily'
  const customNoDates = isDaily && value.durationPreset === 'custom' && days === 0

  return (
    <div className="space-y-3">
      {/* Budget type toggle */}
      <div>
        <label className={labelCls}>Budget type</label>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {(['total', 'daily'] as const).map(m => (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ mode: m })}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                value.mode === m ? 'bg-pink-500/15 text-pink-600 dark:text-pink-400' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {m === 'total' ? 'Total spend' : 'Daily budget'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {!isDaily ? (
          <div>
            <label className={labelCls}>Advertising spend (platform budget)</label>
            <input type="number" min="0" step="0.01" value={value.adBudget} disabled={disabled}
              onChange={e => onChange({ adBudget: e.target.value })} className={field} placeholder="20000" />
          </div>
        ) : (
          <>
            <div>
              <label className={labelCls}>Daily budget</label>
              <input type="number" min="0" step="0.01" value={value.dailyBudget} disabled={disabled}
                onChange={e => onChange({ dailyBudget: e.target.value })} className={field} placeholder="3000" />
            </div>
            <div>
              <label className={labelCls}>Duration</label>
              <select value={value.durationPreset} disabled={disabled}
                onChange={e => onChange({ durationPreset: e.target.value })} className={field}>
                {DURATION_PRESETS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
          </>
        )}
        <div>
          <label className={labelCls}>Currency</label>
          <input value={value.currency} disabled={disabled}
            onChange={e => onChange({ currency: e.target.value.toUpperCase() })} className={field} placeholder="INR" />
        </div>
      </div>

      {/* Daily-budget readout */}
      {isDaily && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${customNoDates ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'border-border bg-secondary/50 text-muted-foreground'}`}>
          {customNoDates
            ? 'Set a start and end date above to calculate the total from the daily budget.'
            : <>Total = <strong>{inr(Number(value.dailyBudget) || 0)}</strong>/day × <strong>{days}</strong> day{days === 1 ? '' : 's'} = <strong className="text-foreground">{inr(adSpend)}</strong></>}
        </div>
      )}

      {/* Service charge — auto-derived from the service's pricing when available,
          with an optional manual override. */}
      {derivedPricing && !value.overrideServiceCharge ? (
        <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Service Charge</span>
            <span className="text-lg font-semibold">{inr(totals.serviceCharge)}</span>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border/50 pt-3">
            <div>
              Derived from<br />
              <strong className="text-foreground">{derivedPricing.serviceName}</strong><br />
              {derivedPricing.isPercent ? `${derivedPricing.value}% of Client Spend` : `Fixed Price ${inr(derivedPricing.value)}`}
            </div>
            {!disabled && (
              <button type="button" onClick={() => onChange({ overrideServiceCharge: true })}
                className="shrink-0 rounded-md bg-background px-3 py-1.5 font-medium text-foreground shadow-sm border border-border hover:bg-secondary">
                Override
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {derivedPricing && !disabled && (
            <button type="button" onClick={() => onChange({ overrideServiceCharge: false })}
              className="text-xs font-medium text-pink-600 dark:text-pink-400 hover:underline">
              ← Use Service Pricing
            </button>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Service charge type</label>
              <select value={value.scType} disabled={disabled}
                onChange={e => onChange({ scType: e.target.value as 'fixed' | 'percent' })} className={field}>
                <option value="fixed">Fixed amount</option>
                <option value="percent">Percent of ad spend</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{value.scType === 'percent' ? 'Service charge (%)' : 'Service charge (amount)'}</label>
              <input type="number" min="0" step="0.01" value={value.scValue} disabled={disabled}
                onChange={e => onChange({ scValue: e.target.value })} className={field} placeholder={value.scType === 'percent' ? '15' : '3000'} />
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Tax (%)</label>
          <input type="number" min="0" step="0.01" value={value.taxPercent} disabled={disabled}
            onChange={e => onChange({ taxPercent: e.target.value })} className={field} placeholder="18" />
        </div>
      </div>

      {/* Auto-calculated totals */}
      <div className="rounded-lg bg-secondary/50 p-3 text-sm space-y-1">
        <Row label={isDaily ? `Advertising spend (${days} day${days === 1 ? '' : 's'})` : 'Advertising spend'} value={inr(totals.adSpend)} />
        <Row label="Service charge" value={inr(totals.serviceCharge)} />
        <Row label="Subtotal" value={inr(totals.subtotal)} />
        <Row label={`Tax (${Number(value.taxPercent) || 0}%)`} value={inr(totals.tax)} />
        <Row label="Grand total" value={inr(totals.grandTotal)} bold />
      </div>
    </div>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${bold ? 'font-semibold border-t border-border pt-1 mt-1' : 'text-muted-foreground'}`}>
      <span>{label}</span><span className="tabular-nums">{value}</span>
    </div>
  )
}
