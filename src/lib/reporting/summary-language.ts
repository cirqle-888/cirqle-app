import type { RenderData } from './types'
export function malayalamSummary(data: Pick<RenderData, 'config' | 'project' | 'kpi' | 'campaigns'>): string {
  const money = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  const lines = [`${data.config.dateFrom} മുതൽ ${data.config.dateTo} വരെ പരസ്യത്തിനായി ${money(data.kpi.primary.spend)} ചെലവായി.`]
  const labels: Record<string, string> = { leads: 'ലീഡുകൾ', messages: 'സംഭാഷണങ്ങൾ', purchases: 'പർച്ചേസുകൾ', clicks: 'ക്ലിക്കുകൾ (എല്ലാം)' }
  const d = data.kpi.derived
  if (data.campaigns?.length) {
    lines.push(`${data.campaigns.length} ക്യാമ്പെയ്‌നുകളുടെ വിവരങ്ങൾ താഴെ പ്രത്യേകം നൽകിയിട്ടുണ്ട്. വ്യത്യസ്ത ലക്ഷ്യങ്ങളിലുള്ള ഫലങ്ങൾ കൂട്ടിച്ചേർത്തിട്ടില്ല.`)
  } else if (d.result?.metric) {
    lines.push(`${labels[d.result.metric] ?? d.result.label}: ${d.results == null ? 'വിവരങ്ങൾ ലഭ്യമല്ല' : d.results.toLocaleString('en-IN')}.`)
    lines.push(d.costPerResult == null ? 'ഒരു ഫലത്തിനുള്ള ചെലവ് കണക്കാക്കാൻ മതിയായ വിവരങ്ങളില്ല.' : `ഒരു ഫലത്തിനുള്ള പരസ്യച്ചെലവ് ${money(d.costPerResult)} ആണ്.`)
  } else {
    lines.push(`പരസ്യം ${data.kpi.primary.impressions.toLocaleString('en-IN')} തവണ പ്രദർശിപ്പിച്ചു.`)
  }
  lines.push('അടുത്ത നടപടി: ഫലങ്ങൾ പരിശോധിച്ച് അടുത്ത ക്യാമ്പെയ്ൻ അപ്ഡേറ്റ് തീരുമാനിക്കുക.')
  return lines.join('\n')
}
