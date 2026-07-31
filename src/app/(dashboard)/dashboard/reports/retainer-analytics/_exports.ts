// Client-side export helpers. xlsx (~400KB) and jspdf (~350KB) are imported
// lazily so they only load when the user actually clicks Excel/PDF.

export type Cell = string | number

export async function exportXlsx(opts: {
  filename: string
  sheetName: string
  headers: string[]
  rows: Cell[][]
}) {
  const XLSX = await import('xlsx')
  const aoa = [opts.headers, ...opts.rows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  // Auto column widths from the longest cell in each column.
  ws['!cols'] = opts.headers.map((h, i) => ({
    wch: Math.min(48, Math.max(String(h).length, ...opts.rows.map(r => String(r[i] ?? '').length)) + 2),
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, opts.sheetName.slice(0, 31))
  XLSX.writeFile(wb, opts.filename)
}

export async function exportPdf(opts: {
  filename: string
  title: string
  subtitle?: string
  generatedAt: string
  filters?: string[]
  kpis?: { label: string; value: string }[]
  headers: string[]
  rows: Cell[][]
  landscape?: boolean
}) {
  const { jsPDF } = await import('jspdf')
  const landscape = opts.landscape ?? opts.headers.length > 6
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 32
  let y = margin

  // ── Branding header ──
  doc.setFillColor(124, 58, 237)
  doc.rect(0, 0, pageW, 6, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(124, 58, 237)
  doc.text('CIRQLE WORKS', margin, y + 6)
  doc.setTextColor(30, 30, 30); doc.setFontSize(16)
  y += 24
  doc.text(opts.title, margin, y)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(120, 120, 120)
  y += 14
  if (opts.subtitle) { doc.text(opts.subtitle, margin, y); y += 12 }
  doc.text(`Generated ${opts.generatedAt}`, margin, y); y += 12
  if (opts.filters && opts.filters.length) { doc.text(`Filters: ${opts.filters.join(' · ')}`, margin, y); y += 12 }

  // ── KPI summary ──
  if (opts.kpis && opts.kpis.length) {
    y += 6
    doc.setDrawColor(230, 230, 230); doc.line(margin, y, pageW - margin, y); y += 14
    const perRow = landscape ? 5 : 3
    const cw = (pageW - margin * 2) / perRow
    opts.kpis.forEach((k, i) => {
      const col = i % perRow
      const x = margin + col * cw
      if (col === 0 && i > 0) y += 30
      doc.setFontSize(8); doc.setTextColor(140, 140, 140); doc.text(k.label, x, y)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(30, 30, 30); doc.text(k.value, x, y + 13)
      doc.setFont('helvetica', 'normal')
    })
    y += 34
  }

  // ── Table ──
  const cols = opts.headers.length
  const tableW = pageW - margin * 2
  const colW = tableW / cols
  const rowH = 16
  const drawHeader = () => {
    doc.setFillColor(244, 244, 248); doc.rect(margin, y, tableW, rowH, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(90, 90, 90)
    opts.headers.forEach((h, i) => doc.text(String(h).slice(0, 22), margin + i * colW + 3, y + 11))
    y += rowH
  }
  y += 6; drawHeader()
  doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40); doc.setFontSize(7.5)
  for (const row of opts.rows) {
    if (y + rowH > pageH - margin) { doc.addPage(); y = margin; drawHeader(); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(40, 40, 40) }
    row.forEach((c, i) => doc.text(String(c ?? '').slice(0, 24), margin + i * colW + 3, y + 11))
    doc.setDrawColor(238, 238, 238); doc.line(margin, y + rowH, margin + tableW, y + rowH)
    y += rowH
  }

  // ── Page numbers ──
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p); doc.setFontSize(7.5); doc.setTextColor(150, 150, 150)
    doc.text(`Page ${p} of ${pages}`, pageW - margin, pageH - 14, { align: 'right' })
  }

  doc.save(opts.filename)
}
