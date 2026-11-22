'use client'

/**
 * Pick one of Cirqle's own brands. '' means the default brand (Cirqle itself),
 * which is how every unbranded row reads — so the default brand is the ''
 * option, and an explicit default id coming in is shown as '' too.
 *
 * Loads the list itself (once per page) so any form can drop it in without
 * threading brands through props. Renders nothing while there is only one
 * brand, or before brands exist in the database.
 */

import { useEffect, useState } from 'react'
import { listBrandOptions } from '@/app/(dashboard)/dashboard/cirqle-accounts/actions'

export interface BrandOption { id: string; name: string; color: string | null; isDefault: boolean; taskLabel?: string | null }

let cache: Promise<BrandOption[]> | null = null
function loadOptions(): Promise<BrandOption[]> {
  cache ??= listBrandOptions().then(r => (r.ok && r.data ? r.data : []), () => [])
  return cache
}

/** The brands, for callers that need the list too (labels, chips). */
export function useBrandOptions(): BrandOption[] {
  const [opts, setOpts] = useState<BrandOption[]>([])
  useEffect(() => { let live = true; void loadOptions().then(o => { if (live) setOpts(o) }); return () => { live = false } }, [])
  return opts
}

export function BrandSelect({
  value, onChange, label = 'Brand', hint, className, selectClassName, disabled,
}: {
  value: string | null | undefined
  onChange: (brandId: string) => void
  label?: string
  hint?: string
  className?: string
  selectClassName?: string
  disabled?: boolean
}) {
  const options = useBrandOptions()
  if (options.length < 2) return null
  const def = options.find(o => o.isDefault)
  const shown = !value || value === def?.id ? '' : value

  return (
    <div className={className}>
      <label className="block text-xs font-medium text-muted-foreground mb-1.5">{label}</label>
      <select
        value={shown}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
        className={selectClassName ?? 'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50'}
      >
        {options.map(o => (
          <option key={o.id} value={o.isDefault ? '' : o.id}>
            {o.name}{o.isDefault ? ' (default)' : ''}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
