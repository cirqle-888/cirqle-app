import React from 'react'
import type { RenderData } from '../types'
/** Additional pages preserve readable summary and campaign detail in every PDF. */
export function supplementElements(data: RenderData, width: number, height: number): React.ReactElement[] {
  const pages: React.ReactElement[] = []
  const money = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  const shell = (title: string, children: React.ReactNode, key: string) => <div key={key} style={{ width, height, display: 'flex', flexDirection: 'column', padding: 72, gap: 28, backgroundColor: '#fff', color: '#171727', fontFamily: 'Noto Sans, Noto Sans Malayalam', fontSize: 25 }}>
    <div style={{ display: 'flex', color: '#6D28D9', fontSize: 35, fontWeight: 700 }}>{title}</div>
    <div style={{ display: 'flex', fontSize: 22 }}>{data.project.clientName} · {data.config.dateFrom} — {data.config.dateTo}</div>
    {children}
    <div style={{ display: 'flex', marginTop: 'auto', color: '#666', fontSize: 18 }}>Cirqle · Saved report snapshot</div>
  </div>
  // Conservative chunks keep long edited summaries readable without truncating.
  if (data.ai.executiveSummary && (data.config.summaryOverride || data.config.language === 'ml')) {
    const words = data.ai.executiveSummary.split(/\s+/)
    for (let i = 0; i < words.length; i += 100) pages.push(shell(data.config.language === 'ml' ? 'റിപ്പോർട്ട് സംഗ്രഹം' : 'Client summary',
      <div style={{ display: 'flex', lineHeight: 1.8 }}>{words.slice(i, i + 100).join(' ')}</div>, `summary-${i}`))
  }
  const rows = data.campaigns ?? []
  for (let i = 0; i < rows.length; i += 4) pages.push(shell('Campaign results', <div style={{ display: 'flex', flexDirection: 'column', gap: 25 }}>
    {rows.slice(i, i + 4).map(row => <div key={row.projectId} style={{ display: 'flex', flexDirection: 'column', padding: 22, gap: 8, border: '1px solid #ddd', borderRadius: 12 }}>
      <div style={{ display: 'flex', fontWeight: 700 }}>{row.campaignName.length > 180 ? `${row.campaignName.slice(0, 177)}…` : row.campaignName}</div>
      <div style={{ display: 'flex' }}>Ad spend: {money(row.spend)}</div>
      <div style={{ display: 'flex' }}>{row.resultLabel ?? 'Results'}: {row.results == null ? 'Not available' : row.results.toLocaleString('en-IN')}</div>
      <div style={{ display: 'flex' }}>{row.costLabel ?? 'Cost per result'}: {row.costPerResult == null ? 'Not available' : money(row.costPerResult)}</div>
    </div>)}
  </div>, `campaigns-${i}`))
  return pages
}
