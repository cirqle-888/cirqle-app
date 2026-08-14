'use client'

/**
 * Client-side loader for the recharts bundle.
 *
 * `next/dynamic` with `ssr: false` is only legal inside a Client Component —
 * calling it from the server page is a build error, and a Server Component
 * dynamically importing a Client Component gets no code-splitting anyway
 * (next/dist/docs/01-app/02-guides/lazy-loading.md). So the boundary lives
 * here: the server page imports this module like any other client component,
 * and the ~95 KB of recharts still loads lazily, on the client, only when this
 * report is actually rendered.
 *
 * Same arrangement as reports/_charts.tsx, which is pulled in this way from
 * reports-client.tsx.
 */

import dynamic from 'next/dynamic'
import type { GrowthPoint } from './_growth-charts'

export const RevenueMarginChart = dynamic(
  () => import('./_growth-charts').then(m => m.RevenueMarginChart),
  {
    ssr: false,
    loading: () => <div className="h-[260px] animate-pulse rounded-lg bg-secondary/40" />,
  },
)

export const Sparkline = dynamic(
  () => import('./_growth-charts').then(m => m.Sparkline),
  {
    ssr: false,
    loading: () => <div className="h-12 animate-pulse rounded bg-secondary/40" />,
  },
)

export type { GrowthPoint }
