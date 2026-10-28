'use client'

import React from 'react'
import type { RenderData } from '@/lib/reporting/types'
import { describeDataQuality } from '@/lib/reporting/data-quality'
import { resultHeadline } from '@/lib/reporting/result-display'

function formatCurrency(amount: number, currency: string = 'INR') {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatCurrency2(amount: number, currency: string = 'INR') {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
}

function Tile({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`border p-4 rounded-xl ${accent ? 'bg-primary/[0.04] border-primary/30' : 'bg-card border-border'}`}>
      <div className="text-sm text-muted-foreground mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  )
}

function formatNumber(num: number) {
  return new Intl.NumberFormat('en-IN').format(num)
}

function formatPercent(num: number) {
  return num.toFixed(2) + '%'
}

export default function WebReportViewer({ data }: { data: RenderData }) {
  const { project, kpi, brand, ai, template } = data
  const { sections } = template
  const coverage = describeDataQuality(data.dataQuality)
  // Rule-based summaries already include the note; don't say it twice.
  const dataNote = coverage && !(sections.executiveSummary && ai.executiveSummary?.includes(coverage)) ? coverage : null
  const pr = kpi.periodReach
  const singleDay = data.config.dateFrom === data.config.dateTo
  const result = resultHeadline(kpi, project.campaignType)
  const showAllocationBalance = !data.campaigns || data.campaigns.length <= 1

  return (
    <div className="bg-background text-foreground max-w-5xl mx-auto p-4 sm:p-8 md:p-12 space-y-12">
      
      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-border pb-6 gap-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{project.campaignName}</h1>
          <p className="text-muted-foreground mt-1">
            {project.clientName} • {project.platform}
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Reporting Period: {data.config.dateFrom} to {data.config.dateTo}
          </p>
        </div>
        {brand.agencyLogoUrl && (
          <img 
            src={brand.agencyLogoUrl} 
            alt={brand.agencyName} 
            className="h-12 object-contain" 
          />
        )}
      </header>

      {dataNote && (
        <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {dataNote}
        </div>
      )}

      {/* Executive Summary */}
      {sections.executiveSummary && ai.executiveSummary && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-border pb-2">Executive Summary</h2>
          <p className="text-muted-foreground leading-relaxed">
            {ai.executiveSummary}
          </p>
        </section>
      )}

      {/* KPI Cards */}
      {sections.kpiScorecard && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-border pb-2">Key Performance Indicators</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Tile label="Spend" value={formatCurrency(kpi.primary.spend)} sub="excl. GST" />
            {/* The campaign's own result — conversations, purchases, leads… */}
            <Tile label={result.label} value={result.value == null ? '—' : formatNumber(result.value)}
              sub={result.reason ?? (result.partial ? 'recorded on only some days' : undefined)} accent />
            <Tile label={result.costLabel} value={result.cost == null ? '—' : formatCurrency2(result.cost)} accent />
            <Tile
              label={pr?.available || singleDay ? 'Reach' : 'Reach (sum of daily)'}
              value={formatNumber(pr?.available ? pr.value : kpi.primary.reach)}
              sub={!pr?.available && !singleDay ? 'Counts a person once per day reached' : undefined}
            />
            <Tile label="Impressions" value={formatNumber(kpi.primary.impressions)} />
            <Tile label="Clicks" value={formatNumber(kpi.primary.clicks)} />
            <Tile label="CTR" value={kpi.primary.impressions > 0 ? formatPercent(kpi.primary.ctr) : '—'} />
            <Tile label="CPC" value={kpi.primary.clicks > 0 ? formatCurrency2(kpi.primary.cpc) : '—'} />
            {/* Revenue only where sales are tracked — "Not tracked" tiles on a
                messages campaign were noise. */}
            {kpi.primary.revenue > 0 && (
              <>
                <Tile label="Revenue" value={formatCurrency(kpi.primary.revenue)} />
                <Tile label="ROAS" value={`${kpi.primary.roas.toFixed(2)}x`} />
              </>
            )}
          </div>
        </section>
      )}

      {/* Campaign breakdown (client reports) — each campaign under its own objective */}
      {data.campaigns && data.campaigns.length > 1 && (
        <section className="space-y-4" aria-labelledby="campaign-breakdown">
          <h2 id="campaign-breakdown" className="text-xl font-semibold border-b border-border pb-2">Campaigns</h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Campaign</th>
                  <th scope="col" className="px-4 py-3 font-medium">Result</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Cost per result</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Spend</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map(c => (
                  <tr key={c.projectId} className="border-t border-border">
                    <td className="px-4 py-3">{c.campaignName}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {c.resultLabel ? <>{c.results == null ? '—' : formatNumber(c.results)} <span className="text-muted-foreground">{c.resultLabel.toLowerCase()}</span></> : <span className="text-muted-foreground">No result metric</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.costPerResult == null ? '—' : formatCurrency(c.costPerResult)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(c.spend)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* AI Insights */}
      {sections.aiInsights && ai.keyInsights.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-border pb-2">AI Insights & Analysis</h2>
          <ul className="list-disc pl-5 space-y-2 text-muted-foreground">
            {ai.keyInsights.map((insight, idx) => (
              <li key={idx} className="leading-relaxed">{insight}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Daily Performance */}
      {sections.dailyBreakdown && kpi.dailySeries.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-border pb-2">Daily Performance</h2>
          <p className="text-xs text-muted-foreground">Spend excludes GST. Balance to Spend is the closing allocated wallet balance after actual cost including GST, not the live Meta account balance.</p>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/50 text-muted-foreground border-b border-border">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium text-right">Spend</th>
                  <th className="px-4 py-3 font-medium text-right">Impressions</th>
                  <th className="px-4 py-3 font-medium text-right">Clicks</th>
                  <th className="px-4 py-3 font-medium text-right">{result.label}</th>
                  <th className="px-4 py-3 font-medium text-right">{result.costLabel}</th>
                  {showAllocationBalance && <th className="px-4 py-3 font-medium text-right whitespace-nowrap">Balance to Spend</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {kpi.dailySeries.map((row, idx) => (
                  <tr key={idx} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">{row.date}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(row.spend)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(row.impressions)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(row.clicks)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.results == null ? '—' : formatNumber(row.results)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.cpr == null ? '—' : formatCurrency2(row.cpr)}</td>
                    {showAllocationBalance && <td className="px-4 py-3 text-right tabular-nums">{Number.isFinite(row.remainingAllocation) ? formatCurrency2(row.remainingAllocation) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

    </div>
  )
}
