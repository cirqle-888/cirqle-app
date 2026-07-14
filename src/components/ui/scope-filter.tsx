'use client'

/**
 * Shared finance-scope filter — mirrors the date-filter.tsx pattern:
 * a value type + pure matcher + label helper + a drop-in control.
 *
 * Scope is the client/company dimension from the Finance Foundation
 * (docs/FINANCE-FOUNDATION.md): 'untriaged' selects records whose scope
 * hasn't been classified yet.
 */

import AppSelect from '@/components/ui/app-select'

export type ScopeFilterValue = '' | 'client' | 'company' | 'untriaged'

export const SCOPE_FILTER_OPTIONS: { value: ScopeFilterValue; label: string }[] = [
  { value: '', label: 'All books' },
  { value: 'client', label: 'Client work' },
  { value: 'company', label: 'Company (Cirqle)' },
  { value: 'untriaged', label: 'Untriaged' },
]

/** Pure matcher usable inside any list-page filter pipeline. */
export function matchesScopeFilter(
  value: ScopeFilterValue,
  scope: string | null | undefined,
): boolean {
  if (!value) return true
  if (value === 'untriaged') return scope == null || scope === ''
  return scope === value
}

export function getScopeFilterLabel(value: ScopeFilterValue): string {
  return SCOPE_FILTER_OPTIONS.find(o => o.value === value)?.label ?? 'All books'
}

export function ScopeFilter({ value, onChange, className }: {
  value: ScopeFilterValue
  onChange: (v: ScopeFilterValue) => void
  className?: string
}) {
  return (
    <AppSelect value={value} onChange={e => onChange(e.target.value as ScopeFilterValue)} className={className}>
      {SCOPE_FILTER_OPTIONS.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </AppSelect>
  )
}
