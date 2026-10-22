import type { ReactNode } from 'react'
import Header from '@/components/layout/header'
import { ProfitSharingTabs } from './_components'
import { requireProfitSharingPage } from './_page'

/**
 * Profit Sharing — Admin only in this release (design §10, §12). The layout
 * checks access too, but every page and every action checks again: a layout
 * is not re-run on client navigation between its pages.
 */
export default async function ProfitSharingLayout({ children }: { children: ReactNode }) {
  await requireProfitSharingPage()
  return (
    <div className="space-y-0">
      <Header
        title="Profit Sharing"
        subtitle="Cirqle's own cash profit, the Capital Share and Business Reserve, investors' capital, and device valuations. Admin only."
      />
      <ProfitSharingTabs />
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6">{children}</div>
    </div>
  )
}
