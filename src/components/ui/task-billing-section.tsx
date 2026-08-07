'use client'

/**
 * Task Billing Section — the ONE financial UI for every task editing surface.
 *
 * Rendered identically by the Add Task form, the shared Edit Task modal, and
 * therefore the Contributions task editor. It owns the whole money area of a
 * task form: retainer coverage, the "Bill as extra" decision, the pricing-type
 * card, the quantity inputs, and the price explanation.
 *
 * Do not re-implement any of this in a form. Previously the coverage card and
 * the Bill-as-extra toggle existed only inside the Add Task modal, so the Edit
 * modal recomputed the raw service price on save, tripped the server's
 * anti-double-billing guard, and could not save a covered task at all. A second
 * copy of this JSX is how that happens again.
 *
 * The arithmetic lives in `@/lib/tasks/pricing`; this file only renders it.
 */

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle, ExternalLink, Hash, Clock } from 'lucide-react'
import type { RetainerCoverageInfo } from '@/lib/agreements/coverage'
import {
  computeTaskAmount, resolveUnitPrice, isBillingSuppressed, applyCoverageExtraPrice,
  type ClientPricingLike, type ServiceLike,
} from '@/lib/tasks/pricing'

const inputCls =
  'w-full bg-background border border-input rounded-lg px-3 py-2 text-sm shadow-sm ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

export interface TaskBillingSectionProps {
  services: ServiceLike[]
  clientPricings?: ClientPricingLike[]
  clientId: string | null | undefined
  serviceId: string | null | undefined

  /** Form values, held as strings by both host forms. */
  quantity: string
  hours: string
  spend: string
  onChange: (patch: { quantity?: string; hours?: string; spend?: string }) => void

  coverage: RetainerCoverageInfo | null
  billAsExtra: boolean
  onBillAsExtraChange: (next: boolean) => void

  /** False for users without pricing access: quantity inputs, no money. */
  showFinancials?: boolean

  /**
   * Variant tasks bill as a frozen share of their parent. Pass the stored amount
   * to render a read-only, clearly-explained price instead of the live matrix —
   * recomputing would overwrite e.g. a ₹40 derived price with the ₹200 full one.
   */
  lockedAmount?: number | null
  lockedCurrency?: string
  lockedNote?: ReactNode

  /** Host-computed amount (manual override / variant math). Defaults to the engine. */
  amount?: number
  /** Host-computed per-unit display price. Defaults to the resolved unit price. */
  unitPriceDisplay?: number
  /** Extra controls rendered inside the pricing card (e.g. quick-set price). */
  footer?: ReactNode
}

export function TaskBillingSection({
  services, clientPricings = [], clientId, serviceId,
  quantity, hours, spend, onChange,
  coverage, billAsExtra, onBillAsExtraChange,
  showFinancials = true,
  lockedAmount = null, lockedCurrency, lockedNote,
  amount, unitPriceDisplay, footer,
}: TaskBillingSectionProps) {
  const { pricingType, unitPrice, currency, fromClientMatrix, fromAgreementExtra } =
    applyCoverageExtraPrice(
      resolveUnitPrice({ services, clientPricings, clientId, serviceId }),
      coverage, billAsExtra,
    )
  const suppressed = isBillingSuppressed({ covered: !!coverage, billAsExtra })
  const engineAmount = computeTaskAmount({ pricingType, unitPrice, quantity, hours, spend })
  const total = amount ?? engineAmount
  const shownUnit = unitPriceDisplay ?? unitPrice
  const serviceSelected = services.some(s => s.id === serviceId)

  const creativesInput = (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">Number of creatives</label>
      <input type="number" min="1" step="1" value={quantity}
        onChange={e => onChange({ quantity: e.target.value })}
        className={inputCls} placeholder="1" />
    </div>
  )

  // ── Variant: frozen price, never recomputed ────────────────────────────────
  if (lockedAmount != null) {
    if (!showFinancials) return null
    return (
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
          Price ({lockedCurrency || currency})
        </label>
        <input readOnly value={lockedAmount} className={inputCls + ' opacity-60 cursor-not-allowed'} />
        {lockedNote && (
          <p className="text-[11px] text-amber-500/90 mt-1.5 flex items-start gap-1.5">
            <span aria-hidden>🔗</span><span>{lockedNote}</span>
          </p>
        )}
      </div>
    )
  }

  return (
    <>
      {/* ── Covered by an active retainer: the retainer IS the invoice ──────── */}
      {coverage && suppressed && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-500" />
              <span className="text-xs font-semibold uppercase tracking-wide text-green-600 dark:text-green-400">
                Covered by Retainer
              </span>
            </div>
            <Link href={`/dashboard/agreements/${coverage.agreementId}`} target="_blank"
              className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              {coverage.agreementNumber} <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
          {showFinancials && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {coverage.monthlyRetainer != null && (
                <div>
                  <div className="text-[10px] text-muted-foreground">Monthly retainer</div>
                  <div className="font-semibold text-sm">{coverage.currency} {coverage.monthlyRetainer}</div>
                </div>
              )}
              {coverage.creativeAllocation != null && (
                <div>
                  <div className="text-[10px] text-muted-foreground">Creative allocation</div>
                  <div className="font-semibold text-sm">{coverage.currency} {coverage.creativeAllocation}</div>
                </div>
              )}
              {coverage.workUnitValue != null ? (
                <div>
                  <div className="text-[10px] text-muted-foreground">Work value (pays team)</div>
                  <div className="font-semibold text-sm">
                    {coverage.currency} {coverage.workUnitValue}
                    <span className="text-[10px] text-muted-foreground font-normal"> /task</span>
                  </div>
                </div>
              ) : coverage.allocatedUnitValue != null && (
                <div>
                  <div className="text-[10px] text-muted-foreground">Allocated unit value</div>
                  <div className="font-semibold text-sm">
                    {coverage.currency} {coverage.allocatedUnitValue}
                    <span className="text-[10px] text-muted-foreground font-normal"> /unit</span>
                  </div>
                </div>
              )}
              <div>
                <div className="text-[10px] text-muted-foreground">Usage</div>
                <div className="font-semibold text-sm">
                  {coverage.delivered} of {coverage.includedQuantity ?? '—'}
                  <span className="text-[10px] text-muted-foreground font-normal"> · {coverage.remaining} left</span>
                </div>
              </div>
            </div>
          )}
          {pricingType === 'fixed_per_creative' && <div className="max-w-[180px]">{creativesInput}</div>}
          {/* Commitment used up → suggest billing this one as extra work. */}
          {showFinancials && coverage.includedQuantity != null && coverage.remaining === 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <p className="text-[11px] text-amber-700 dark:text-amber-300">
                All {coverage.includedQuantity} included tasks are used this period — this looks like
                extra work{coverage.extraUnitPrice != null
                  ? ` (agreed extra rate: ${coverage.currency} ${coverage.extraUnitPrice}/task)` : ''}.
              </p>
            </div>
          )}
          <div className="flex items-center justify-between pt-1 border-t border-green-500/15">
            <p className="text-[11px] text-muted-foreground">
              No client charge — the monthly retainer is the invoice.
            </p>
            {/* Charging on top of the retainer is a billing decision — reserved
                for users who can see pricing in the first place. */}
            {showFinancials && (
              <button type="button" onClick={() => onBillAsExtraChange(true)}
                className="text-[11px] font-medium text-amber-600 dark:text-amber-400 hover:underline whitespace-nowrap">
                Bill as extra work →
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Covered but deliberately billed on top ──────────────────────────── */}
      {coverage && billAsExtra && showFinancials && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 flex items-center justify-between gap-3">
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Extra work beyond the {coverage.includedQuantity ?? ''} included — this task bills the client
            {fromAgreementExtra
              ? <> at the agreed extra rate ({coverage.currency} {coverage.extraUnitPrice}/task).</>
              : ' normally.'}
          </p>
          <button type="button" onClick={() => onBillAsExtraChange(false)}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground whitespace-nowrap">
            Back to retainer
          </button>
        </div>
      )}

      {/* ── Pricing card — hidden while the retainer absorbs the cost ───────── */}
      {!suppressed && showFinancials && serviceSelected && (
        <div className={`rounded-xl border p-4 space-y-3 ${
          pricingType === 'fixed_per_creative'  ? 'bg-blue-500/5 border-blue-500/20' :
          pricingType === 'retainer'            ? 'bg-green-500/5 border-green-500/20' :
          pricingType === 'percentage_of_spend' ? 'bg-purple-500/5 border-purple-500/20' :
                                                  'bg-amber-500/5 border-amber-500/20'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {pricingType === 'fixed_per_creative'  && <Hash className="w-3.5 h-3.5 text-blue-400" />}
              {pricingType === 'retainer'            && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
              {pricingType === 'hourly'              && <Clock className="w-3.5 h-3.5 text-amber-400" />}
              {pricingType === 'percentage_of_spend' && <span className="text-sm font-bold text-purple-400">%</span>}
              <span className={`text-xs font-semibold uppercase tracking-wide ${
                pricingType === 'fixed_per_creative'  ? 'text-blue-400' :
                pricingType === 'retainer'            ? 'text-green-400' :
                pricingType === 'percentage_of_spend' ? 'text-purple-400' : 'text-amber-400'
              }`}>
                {pricingType === 'fixed_per_creative'  ? 'Fixed per Creative' :
                 pricingType === 'retainer'            ? 'Retainer' :
                 pricingType === 'percentage_of_spend' ? '% of Client Spend' : 'Hourly'}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {fromAgreementExtra
                ? `Agreement extra rate: ${currency} ${shownUnit}`
                : pricingType === 'percentage_of_spend'
                ? shownUnit > 0 ? `Your rate: ${shownUnit}%` : 'No % set'
                : fromClientMatrix
                  ? `Client price: ${currency} ${shownUnit}`
                  : shownUnit > 0 ? `Default: ${currency} ${shownUnit}` : 'No price set'}
            </span>
          </div>

          {pricingType === 'fixed_per_creative' && (
            <div className="flex items-end gap-3">
              <div className="flex-1">{creativesInput}</div>
              <div className="text-right pb-2">
                <p className="text-xs text-muted-foreground">{shownUnit} × {quantity || 1}</p>
                <p className="text-lg font-bold">{currency} {total.toLocaleString()}</p>
              </div>
            </div>
          )}

          {pricingType === 'percentage_of_spend' && (
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs text-muted-foreground mb-1">
                  Client&apos;s total ad spend ({currency})
                </label>
                <input type="number" min="0" step="0.01" value={spend}
                  onChange={e => onChange({ spend: e.target.value })}
                  className={inputCls} placeholder="e.g. 1000" />
              </div>
              <div className="text-right pb-2">
                <p className="text-xs text-muted-foreground">{shownUnit}% of {spend || 0}</p>
                <p className="text-lg font-bold text-purple-400">{currency} {total.toLocaleString()}</p>
              </div>
            </div>
          )}

          {pricingType === 'retainer' && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Monthly retainer — auto-filled</p>
              <p className="text-lg font-bold text-green-400">{currency} {total.toLocaleString()}</p>
            </div>
          )}

          {pricingType === 'hourly' && (
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs text-muted-foreground mb-1">Hours worked</label>
                <input type="number" min="0.5" step="0.5" value={hours}
                  onChange={e => onChange({ hours: e.target.value })}
                  className={inputCls} placeholder="1" />
              </div>
              <div className="text-right pb-2">
                <p className="text-xs text-muted-foreground">{shownUnit}/hr × {hours || 1}h</p>
                <p className="text-lg font-bold">{currency} {total.toLocaleString()}</p>
              </div>
            </div>
          )}

          {footer}
        </div>
      )}

      {/* ── No pricing access: quantity only, so financials stay hidden ─────── */}
      {!showFinancials && !suppressed && serviceSelected && (
        pricingType === 'fixed_per_creative' ? creativesInput :
        pricingType === 'hourly' ? (
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Hours worked</label>
            <input type="number" min="0.5" step="0.5" value={hours}
              onChange={e => onChange({ hours: e.target.value })}
              className={inputCls} placeholder="1" />
          </div>
        ) : null
      )}
    </>
  )
}
