'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getReports } from '@/lib/recruitment/actions'
import { STAGE_LABELS, type RecruitmentReports } from '@/lib/recruitment/types'
import { useToast, ToastContainer } from '@/components/ui/toast'

function pct(n: number): string { return `${Math.round(n * 100)}%` }

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-foreground/10 bg-card p-4">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-2xl font-semibold text-foreground">{value}</div>
      {sub && <div className="text-xs text-muted-foreground/70 mt-0.5">{sub}</div>}
    </div>
  )
}

export default function ReportsClient() {
  const [data, setData] = useState<RecruitmentReports | null>(null)
  const [loading, setLoading] = useState(true)
  const { toasts, dismiss, error: toastError } = useToast()

  useEffect(() => {
    getReports().then(res => {
      if (res.ok) setData(res.data)
      else toastError('Could not load reports', res.error)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  if (!data) return <div className="p-6 text-sm text-muted-foreground">No data available.</div>

  const monthDelta = data.applicationsLastMonth
    ? Math.round(((data.applicationsThisMonth - data.applicationsLastMonth) / data.applicationsLastMonth) * 100)
    : null

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Recruitment Reports</h1>
        <p className="text-sm text-muted-foreground">Pipeline health at a glance.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard label="Applications this month" value={String(data.applicationsThisMonth)} sub={monthDelta !== null ? `${monthDelta >= 0 ? '+' : ''}${monthDelta}% vs last month` : undefined} />
        <StatCard label="Total applications" value={String(data.totalApplications)} />
        <StatCard label="Conversion rate" value={pct(data.conversionRate)} sub="Reached Selected or later" />
        <StatCard label="Interview success rate" value={pct(data.interviewSuccessRate)} sub={`${data.totalInterviewsHeld} interviews held`} />
        <StatCard label="Offer acceptance rate" value={pct(data.offerAcceptanceRate)} sub={`${data.totalOffersSent} offers sent`} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-foreground/10 bg-card p-4">
          <h2 className="text-sm font-semibold mb-3">By hiring source</h2>
          <div className="space-y-2">
            {data.bySource.map(s => (
              <div key={s.source} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground capitalize">{s.source.replace(/_/g, ' ')}</span>
                <span className="font-medium">{s.count}</span>
              </div>
            ))}
            {data.bySource.length === 0 && <p className="text-xs text-muted-foreground/60">No applications yet.</p>}
          </div>
        </div>

        <div className="rounded-2xl border border-foreground/10 bg-card p-4">
          <h2 className="text-sm font-semibold mb-3">By pipeline stage</h2>
          <div className="space-y-2">
            {data.byStage.map(s => (
              <div key={s.stage} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{STAGE_LABELS[s.stage]}</span>
                <span className="font-medium">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
