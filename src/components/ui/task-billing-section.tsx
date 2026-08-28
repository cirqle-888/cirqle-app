'use client'

/**
 * Task Billing Section — the ONE financial UI for every task editing surface.
 *
 * Rendered identically by the Add Task form, the shared Edit Task modal, and
 * therefore the Contributions task editor. It owns the whole money area of a
 * task form: the pricing-type card, the quantity inputs, and the price
 * explanation. Do not re-implement any of this in a form.
 *
 * The arithmetic lives in `@/lib/tasks/pricing`; this file only renders it.
 *
 * The one exception is the package picker, which loads its own options. It
 * lives HERE rather than in each host form because both forms must offer the
 * identical choice — the two drifting apart is a bug this component already
 * exists to prevent.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle, Hash, Clock, Package as PackageIcon, AlertTriangle } from 'lucide-react'
import {
  computeTaskAmount, resolveUnitPrice,
  type ClientPricingLike, type ServiceLike,
} from '@/lib/tasks/pricing'
import { fetchClientPackages } from '@/app/(dashboard)/dashboard/tasks/actions'
import type { PackageOption } from '@/lib/packages/queries'
import { NO_CHARGE_REASONS, DEFAULT_NO_CHARGE_REASON } from '@/lib/tasks/billable'

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

  /** The task's date — decides which packages are running when it was done. */
  taskDate?: string | null
  /** Currently linked package, or '' for "bill separately". */
  packageId?: string | null
  /** Omit to hide the picker entirely (e.g. a surface that cannot save it). */
  onPackageChange?: (packageId: string | null) => void

  /**
   * Is the client charged for this task? A waived task KEEPS its price — the
   * amount is what pays the designer — and simply never reaches an invoice.
   * Omit `onBillableChange` to hide the control (a surface that cannot save it).
   */
  isBillable?: boolean
  noChargeReason?: string | null
  onBillableChange?: (patch: { isBillable: boolean; noChargeReason: string | null }) => void

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
  taskDate, packageId, onPackageChange,
  isBillable = true, noChargeReason = null, onBillableChange,
  showFinancials = true,
  lockedAmount = null, lockedCurrency, lockedNote,
  amount, unitPriceDisplay, footer,
}: TaskBillingSectionProps) {
  const { pricingType, unitPrice, currency, fromClientMatrix } =
    resolveUnitPrice({ services, clientPricings, clientId, serviceId })
  const engineAmount = computeTaskAmount({ pricingType, unitPrice, quantity, hours, spend })
  const total = amount ?? engineAmount
  const shownUnit = unitPriceDisplay ?? unitPrice
  const serviceSelected = services.some(s => s.id === serviceId)

  // Packages this client has running on the task's date. Loaded here so both
  // host forms offer exactly the same choice.
  const [packages, setPackages] = useState<PackageOption[]>([])
  useEffect(() => {
    if (!onPackageChange || !clientId) { setPackages([]); return }
    let cancelled = false
    fetchClientPackages(clientId, taskDate ?? null)
      .then(rows => { if (!cancelled) setPackages(rows) })
      .catch(() => { if (!cancelled) setPackages([]) })
    return () => { cancelled = true }
  }, [clientId, taskDate, onPackageChange])

  const chosen = packages.find(p => p.id === packageId)
  // The task's service isn't in the package. It would still link, but it can
  // never be covered by the fee — so say so rather than let it look included.
  const serviceOutsidePackage =
    !!chosen && !!serviceId && !chosen.serviceIds.includes(serviceId)

  // ── Billable or waived? ───────────────────────────────────────────────────
  // Every task, not just variants: a cover thrown in with a retainer, a
  // goodwill highlight icon and a rework are all ordinary tasks. Waiving
  // changes ONE thing — no invoice line. The price stays, which is what keeps
  // the designer's commission whole. Rendered above the locked-variant return
  // as well, so a free variant is expressible too.
  const billableControl = onBillableChange ? (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-medium text-muted-foreground">Billing</label>
        <select
          value={isBillable ? 'billable' : 'waived'}
          onChange={e => {
            const next = e.target.value === 'billable'
            onBillableChange({
              isBillable: next,
              noChargeReason: next ? null : (noChargeReason || DEFAULT_NO_CHARGE_REASON),
            })
          }}
          className={inputCls + ' w-auto min-w-[9.5rem]'}
        >
          <option value="billable">Billable</option>
          <option value="waived">Waived — don&rsquo;t bill</option>
        </select>
      </div>

      {!isBillable && (
        <>
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-medium text-muted-foreground">Waiver reason</label>
            <select
              value={noChargeReason || DEFAULT_NO_CHARGE_REASON}
              onChange={e => onBillableChange({ isBillable: false, noChargeReason: e.target.value })}
              className={inputCls + ' w-auto min-w-[9.5rem]'}
            >
              {NO_CHARGE_REASONS.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-muted-foreground">
            No invoice line for the client. The task keeps the value below, so it
            still counts as delivered work and still pays commission.
          </p>
        </>
      )}
    </div>
  ) : null

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
      <div className="space-y-3">
        {billableControl}
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
      {/* ── Part of a package? ────────────────────────────────────────────────
          Only appears when this client actually has one running on this date,
          so it costs nothing on the overwhelming majority of tasks. Choosing a
          package changes INVOICING only: the task keeps its Pricing-Matrix
          price and pays the team exactly as it would otherwise. */}
      {onPackageChange && packages.length > 0 && (
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-3 space-y-2">
          <label className="flex items-center gap-1.5 text-xs font-medium text-violet-600 dark:text-violet-300">
            <PackageIcon className="w-3.5 h-3.5" /> Part of a package
          </label>
          <select
            value={packageId ?? ''}
            onChange={e => onPackageChange(e.target.value || null)}
            className={inputCls}
          >
            <option value="">Bill this task separately</option>
            {packages.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}{p.billingType === 'monthly' ? ' (monthly)' : ' (one-time)'}
              </option>
            ))}
          </select>

          {chosen && !serviceOutsidePackage && (
            <p className="text-[11px] text-muted-foreground">
              Rolled into the <strong>{chosen.name}</strong>{' '}
              line on the invoice instead of billing on its own.
              Beyond what&rsquo;s included it bills{' '}
              {chosen.extraTaskPrice != null
                ? `${chosen.currency} ${chosen.extraTaskPrice}`
                : 'at the normal price'}.
            </p>
          )}

          {serviceOutsidePackage && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>
                This service isn&rsquo;t part of <strong>{chosen!.name}</strong>, so the package fee won&rsquo;t
                cover it and it will bill on its own. Add the service to the package, or bill separately.
              </span>
            </p>
          )}
        </div>
      )}

      {billableControl}

      {/* ── Pricing card ──────────────────────────────────────────────────── */}
      {showFinancials && serviceSelected && (
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
              {pricingType === 'percentage_of_spend'
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
      {!showFinancials && serviceSelected && (
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
