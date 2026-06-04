'use client'

/**
 * <CurrencyAmountInput> — the shared 3-way-synced FX money field.
 *
 * Used by both the cashbook entry form and the invoice pay panel so the
 * foreign → rate → INR math is identical everywhere. Editing any of the three
 * fields updates the others:
 *   • change Foreign  → INR  = foreign × rate
 *   • change Rate     → INR  = foreign × rate           (marks source = manual)
 *   • change INR      → rate = INR ÷ foreign            (marks source = manual)
 *   • change Currency → rate = settings rate, INR recomputed
 * When the currency equals the base currency (INR) the rate is hidden & locked
 * to 1 and the amount IS the INR amount.
 *
 * Values are kept as strings to match the existing form state and allow smooth
 * typing; callers parse with parseFloat on submit.
 */

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Currency } from '@/types'
import { round2, computeRate } from '@/lib/calculations/currency'

export type RateSource = 'api' | 'settings' | 'manual'

export interface FxFields {
  currency: Currency
  amount: string // foreign amount (in `currency`)
  rate: string // rate_to_inr (1 when currency === base)
  amountInr: string // INR base value
  rateSource: RateSource
}

interface Props {
  value: FxFields
  onChange: (v: FxFields) => void
  /** currency → rate_to_inr, from Settings/exchange_rates. */
  ratesMap: Record<string, number>
  baseCurrency?: Currency
  currencies?: Currency[]
  /** Optional value-date of the settings rate for the selected currency (hint). */
  rateDate?: string
  amountLabel?: string
  disabled?: boolean
  /** Lock only the foreign-amount field (e.g. cashbook "fully paid" auto-fill). */
  lockAmount?: boolean
  className?: string
  /**
   * If provided, a "Sync live rate" button appears next to the Rate field for
   * foreign currencies. The caller owns the server action call and calls back
   * with the fresh rate + rateDate so the component stays server-action-free.
   */
  onSyncRate?: (currency: string) => Promise<{ rate: number; rateDate: string } | null>
}

const DEFAULT_CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']

const num = (s: string) => parseFloat(s) || 0
const str = (n: number) => (Number.isFinite(n) ? String(n) : '')

export default function CurrencyAmountInput({
  value,
  onChange,
  ratesMap,
  baseCurrency = 'INR',
  currencies = DEFAULT_CURRENCIES,
  rateDate,
  amountLabel = 'Amount',
  disabled,
  lockAmount,
  className = '',
  onSyncRate,
}: Props) {
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncedDate, setSyncedDate] = useState<string | null>(null)

  async function handleSyncRate() {
    if (!onSyncRate || syncing) return
    setSyncing(true)
    setSyncError(null)
    try {
      const result = await onSyncRate(value.currency)
      if (!result) {
        setSyncError('Could not fetch live rate')
      } else {
        const rateStr = String(result.rate)
        const amountInr = value.amount === '' ? '' : String(round2(num(value.amount) * result.rate))
        onChange({ ...value, rate: rateStr, amountInr, rateSource: 'api' })
        setSyncedDate(result.rateDate)
      }
    } catch {
      setSyncError('Network error — try again')
    } finally {
      setSyncing(false)
    }
  }

  const isBase = value.currency === baseCurrency
  const fieldCls =
    'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50'
  const labelCls = 'text-[11px] font-medium text-muted-foreground'

  const emit = (patch: Partial<FxFields>) => onChange({ ...value, ...patch })

  function onCurrency(c: Currency) {
    if (c === baseCurrency) {
      emit({ currency: c, rate: '1', amountInr: value.amount, rateSource: 'manual' })
      return
    }
    const r = ratesMap[c]
    const rate = r ? String(r) : ''
    const amountInr = value.amount === '' ? '' : str(round2(num(value.amount) * num(rate)))
    emit({ currency: c, rate, amountInr, rateSource: r ? 'settings' : 'manual' })
  }

  function onAmount(s: string) {
    if (s === '') return emit({ amount: '', amountInr: '' })
    const amountInr = isBase ? s : str(round2(num(s) * num(value.rate)))
    emit({ amount: s, amountInr })
  }

  function onRate(s: string) {
    emit({ rate: s, amountInr: value.amount === '' ? '' : str(round2(num(value.amount) * num(s))), rateSource: 'manual' })
  }

  function onInr(s: string) {
    const rate = num(value.amount) > 0 ? String(computeRate(num(s), num(value.amount))) : value.rate
    emit({ amountInr: s, rate, rateSource: 'manual' })
  }

  return (
    <div className={`space-y-2.5 ${className}`}>
      <div className="grid grid-cols-[6.5rem_1fr] gap-2">
        <label className="block">
          <span className={labelCls}>Currency</span>
          <select
            disabled={disabled}
            value={value.currency}
            onChange={e => onCurrency(e.target.value as Currency)}
            className={`${fieldCls} mt-1`}
          >
            {currencies.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>{isBase ? `${amountLabel} (₹)` : `${amountLabel} (${value.currency})`}</span>
          <input
            disabled={disabled || lockAmount}
            required
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={value.amount}
            onChange={e => onAmount(e.target.value)}
            placeholder="0.00"
            className={`${fieldCls} mt-1`}
          />
        </label>
      </div>

      {!isBase && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="block">
              {/* Rate label row — sync button lives here when onSyncRate is provided */}
              <div className="flex items-center justify-between mb-1">
                <span className={labelCls}>Rate (1 {value.currency} = ₹)</span>
                {onSyncRate && (
                  <button
                    type="button"
                    onClick={handleSyncRate}
                    disabled={syncing || disabled}
                    title="Fetch live exchange rate"
                    className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`w-2.5 h-2.5 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? 'Syncing…' : 'Live rate'}
                  </button>
                )}
              </div>
              <input
                disabled={disabled}
                type="number"
                step="any"
                min="0"
                inputMode="decimal"
                value={value.rate}
                onChange={e => onRate(e.target.value)}
                placeholder="0.000000"
                className={fieldCls}
              />
            </div>
            <label className="block">
              <span className={labelCls}>= Amount (₹ INR)</span>
              <input
                disabled={disabled}
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={value.amountInr}
                onChange={e => onInr(e.target.value)}
                placeholder="0.00"
                className={`${fieldCls} mt-1`}
              />
            </label>
          </div>

          <div className="flex items-center gap-2 text-[11px] flex-wrap">
            <span
              className={`px-1.5 py-0.5 rounded font-medium ${
                value.rateSource === 'manual'
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-emerald-500/15 text-emerald-300'
              }`}
            >
              {value.rateSource === 'manual' ? 'Manual override' : 'Settings rate'}
            </span>
            {syncError && <span className="text-red-400">{syncError}</span>}
            {!syncError && syncedDate && (
              <span className="text-emerald-400">Synced {syncedDate}</span>
            )}
            {!syncError && !syncedDate && (
              !ratesMap[value.currency] && value.rateSource !== 'manual'
                ? <span className="text-amber-400">No saved rate — use Live rate button or enter manually</span>
                : rateDate && <span className="text-muted-foreground">Settings rate dated {rateDate}</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
