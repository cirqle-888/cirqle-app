'use client'

import React from 'react'
import type { RenderData } from '@/lib/reporting/types'

function formatCurrency(amount: number, currency: string = 'INR') {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount)
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
            <div className="bg-card border border-border p-4 rounded-xl">
              <div className="text-sm text-muted-foreground mb-1">Spend</div>
              <div className="text-2xl font-semibold">{formatCurrency(kpi.primary.spend)}</div>
            </div>
            <div className="bg-card border border-border p-4 rounded-xl">
              <div className="text-sm text-muted-foreground mb-1">Revenue</div>
              <div className="text-2xl font-semibold">{formatCurrency(kpi.primary.revenue)}</div>
            </div>
            <div className="bg-card border border-border p-4 rounded-xl">
              <div className="text-sm text-muted-foreground mb-1">ROAS</div>
              <div className="text-2xl font-semibold">{kpi.primary.roas.toFixed(2)}x</div>
            </div>
            <div className="bg-card border border-border p-4 rounded-xl">
              <div className="text-sm text-muted-foreground mb-1">Leads</div>
              <div className="text-2xl font-semibold">{formatNumber(kpi.primary.leads)}</div>
            </div>
            <div className="bg-card border border-border p-4 rounded-xl">
              <div className="text-sm text-muted-foreground mb-1">Cost per Lead</div>
              <div className="text-2xl font-semibold">{formatCurrency(kpi.primary.cpl)}</div>
            </div>
            <div className="bg-card border border-border p-4 rounded-xl">
              <div className="text-sm text-muted-foreground mb-1">Clicks</div>
              <div className="text-2xl font-semibold">{formatNumber(kpi.primary.clicks)}</div>
            </div>
            <div className="bg-card border border-border p-4 rounded-xl">
              <div className="text-sm text-muted-foreground mb-1">CTR</div>
              <div className="text-2xl font-semibold">{formatPercent(kpi.primary.ctr)}</div>
            </div>
            <div className="bg-card border border-border p-4 rounded-xl">
              <div className="text-sm text-muted-foreground mb-1">CPC</div>
              <div className="text-2xl font-semibold">{formatCurrency(kpi.primary.cpc)}</div>
            </div>
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
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/50 text-muted-foreground border-b border-border">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium text-right">Spend</th>
                  <th className="px-4 py-3 font-medium text-right">Impressions</th>
                  <th className="px-4 py-3 font-medium text-right">Clicks</th>
                  <th className="px-4 py-3 font-medium text-right">Leads</th>
                  <th className="px-4 py-3 font-medium text-right">CPR</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {kpi.dailySeries.map((row, idx) => (
                  <tr key={idx} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">{row.date}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(row.spend)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(row.impressions)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(row.clicks)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(row.leads)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(row.cpr)}</td>
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
