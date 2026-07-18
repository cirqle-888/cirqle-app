'use client'

import { usePrivacy } from '@/contexts/privacy-context'

/**
 * EmployeeName — the ONE sanctioned way to render an employee's name in the UI.
 *
 * Employee real names are sensitive: they must show only when privacy is
 * unlocked, and show the CQID (e.g. "CQID001") otherwise. This component wraps
 * `dn()` so no call site has to remember the rule — pass the whole employee and
 * it renders the right thing.
 *
 * Do NOT write `{emp.name}` in JSX; the `no-restricted-syntax` ESLint rule
 * flags it. Use `<EmployeeName emp={emp} />` (or `dn(emp)` for a bare string).
 */
export function EmployeeName({
  emp,
  className,
  as: Tag = 'span',
}: {
  emp: { cqid?: string | null; name?: string | null } | null | undefined
  className?: string
  /** Element to render as (default <span>). */
  as?: 'span' | 'div' | 'p'
}) {
  const { dn } = usePrivacy()
  return <Tag className={className}>{dn(emp)}</Tag>
}
