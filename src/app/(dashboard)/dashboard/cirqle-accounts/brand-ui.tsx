/** Small presentational pieces shared by the Brands pages. */

import type { Brand } from '@/lib/brands/brands'

export const compact = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString('en-IN')
}

export const inr = (v: number | null | undefined, dp = 0) =>
  v == null ? '—' : `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: dp })}`

/** The brand's logo, or its initial on its colour. */
export function BrandMark({ brand, size = 32 }: { brand: Pick<Brand, 'name' | 'color' | 'logo_url'>; size?: number }) {
  if (brand.logo_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={brand.logo_url} alt="" width={size} height={size}
      className="shrink-0 rounded-lg object-cover border border-border bg-white" style={{ width: size, height: size }} />
  }
  return (
    <span aria-hidden="true"
      className="shrink-0 inline-flex items-center justify-center rounded-lg font-semibold text-white"
      style={{ width: size, height: size, background: brand.color || '#64748b', fontSize: Math.round(size * 0.42) }}>
      {brand.name.trim().charAt(0).toUpperCase()}
    </span>
  )
}
