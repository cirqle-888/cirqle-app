'use client'

import { useRef, useState, useEffect } from 'react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, Download, Share2, FileText, Loader2, Check, ChevronDown } from 'lucide-react'
import {
  isDesktop, desktop, effectiveShareAction, rememberLastShareAction,
  RECEIPT_SHARE_LABELS, RECEIPT_SHARE_HINTS, type ReceiptShareAction,
} from '@/lib/desktop'

/**
 * Shareable "Payment Received" receipt.
 *
 * The export image is drawn with the Canvas 2D API (see `renderReceiptCanvas`),
 * NOT html2canvas. The whole app theme is built on oklch() colours, which Chrome
 * serialises as lab()/oklab(); html2canvas@1.4.1 throws "unsupported color
 * function lab" the instant it parses any themed element (page chrome, even an
 * inline <svg> whose stroke inherits the themed currentColor). Drawing straight
 * to a canvas with hex literals sidesteps all CSS colour parsing — every pixel
 * is fully under our control, so the output is identical on every device.
 *
 * The on-screen card below is a faithful live preview; the canvas reproduces it.
 * Output is a 4:5 portrait PNG (designed at 432×540, rendered at scale 2.6 →
 * ~1123×1404) suitable for WhatsApp / Photos, plus an optional matching PDF.
 */

export interface ReceiptInput {
  receiptNo: string
  defaultClientName: string
  amount: number
  currency: string
  dateISO: string
  method?: string
  reference?: string
  invoices: { number: string; outstanding?: number }[]
  /**
   * Workspace branding from Settings → Company. All optional — the renderer
   * falls back to the hardcoded Cirqle defaults if any field is missing.
   *
   * `companyLogoUrl` must be served with `Access-Control-Allow-Origin: *` (or
   * be same-origin) or the canvas export will silently fall back to the
   * default mark — the preview still shows the user's logo via a plain <img>.
   */
  companyLogoUrl?: string
  companyName?: string
  companyPhone?: string
  companyWebsite?: string
}

interface Props {
  input: ReceiptInput
  onClose: () => void
}

const CURRENCY_SYMBOL: Record<string, string> = {
  INR: '₹', AED: 'د.إ ', SAR: '﷼ ', USD: '$', QAR: 'ر.ق ', GBP: '£', EUR: '€',
}

// Card design dimensions (4:5). Captured at higher scale for crisp output.
const CARD_W = 432
const CARD_H = 540
const CAPTURE_SCALE = 2.6

function fmtAmount(n: number, currency: string) {
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `
  return sym + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * Async image loader for the workspace logo. `crossOrigin = 'anonymous'`
 * keeps the canvas un-tainted so `.toBlob()` / `.toDataURL()` succeed; the
 * URL host must reply with `Access-Control-Allow-Origin: *` (or be same-
 * origin). Resolves to null on any failure so the caller can fall back to
 * the hardcoded gradient mark without throwing.
 */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/**
 * Draw the 4:5 receipt straight onto a high-DPI canvas using hex colours only.
 * No DOM / html2canvas → no oklch/lab parsing → reliable on every device.
 */
export async function renderReceiptCanvas(
  input: ReceiptInput,
  opts: { clientName: string; note: string },
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(CARD_W * CAPTURE_SCALE)
  canvas.height = Math.round(CARD_H * CAPTURE_SCALE)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  // Wait for webfonts so text metrics & rendering are stable.
  try { await (document as Document & { fonts?: FontFaceSet }).fonts?.ready } catch { /* noop */ }
  // Pre-load the workspace logo (if configured) BEFORE drawing so the brand
  // row can use it. Null means no logo or CORS-blocked → draw the default.
  const logoImg = input.companyLogoUrl ? await loadImage(input.companyLogoUrl) : null
  ctx.scale(CAPTURE_SCALE, CAPTURE_SCALE)
  drawReceipt(ctx, input, opts, logoImg)
  return canvas
}

function drawReceipt(
  ctx: CanvasRenderingContext2D,
  input: ReceiptInput,
  opts: { clientName: string; note: string },
  logoImg: HTMLImageElement | null,
) {
  const W = CARD_W
  const H = CARD_H
  const clientName = opts.clientName
  const note = opts.note
  const balanceDue = input.invoices.reduce((s, i) => s + Math.max(0, i.outstanding ?? 0), 0)
  const invoiceLabel = input.invoices.length ? input.invoices.map(i => i.number).join(', ') : '—'
  const dateLabel = input.dateISO
    ? new Date(input.dateISO).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''

  // ── tiny helpers ──────────────────────────────────────────────
  const lin = (x0: number, y0: number, x1: number, y1: number, c0: string, c1: string) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1)
    g.addColorStop(0, c0); g.addColorStop(1, c1); return g
  }
  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }
  const setLS = (px: number) => {
    try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px}px` } catch { /* unsupported */ }
  }
  const truncate = (text: string, maxW: number) => {
    if (ctx.measureText(text).width <= maxW) return text
    let t = text
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
    return `${t}…`
  }

  // ── background (dark base + indigo glow at top centre) ────────
  ctx.fillStyle = '#0b1120'
  ctx.fillRect(0, 0, W, H)
  ctx.save()
  ctx.translate(216, -26)
  ctx.scale(1.25, 0.85) // elliptical glow ≈ radial-gradient(120% 80% …)
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 330)
  glow.addColorStop(0, '#1e1b4b')
  glow.addColorStop(0.6, 'rgba(11,17,32,0)')
  ctx.fillStyle = glow
  ctx.fillRect(-460, -460, 920, 920)
  ctx.restore()

  ctx.textBaseline = 'top'

  // ── brand row: workspace logo, or fallback gradient circle + wordmark ──
  if (logoImg) {
    // Fit the logo into a 140×40 box at top-left, preserving aspect ratio.
    // Vertical-centered around y=54 so it lines up with the receipt-no column
    // on the right. Most agency wordmarks are wider than tall — width caps
    // first; very square marks are limited by the 40-px height.
    const targetH = 40
    const aspect = logoImg.width / logoImg.height || 1
    const targetW = Math.min(140, targetH * aspect)
    const drawH = aspect > 140 / targetH ? 140 / aspect : targetH
    const drawW = aspect > 140 / targetH ? 140 : targetW
    ctx.drawImage(logoImg, 32, 54 - drawH / 2, drawW, drawH)
  } else {
    // Default: gradient circle + Cirqle wordmark (original look).
    ctx.fillStyle = lin(32, 34, 72, 74, '#7c3aed', '#60a5fa')
    ctx.beginPath(); ctx.arc(52, 54, 20, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = '#ffffff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.2
    const ax = (x: number) => 41 + x * 0.9167
    const ay = (y: number) => 43 + y * 0.9167
    ctx.beginPath()
    ctx.moveTo(ax(8), ay(16)); ctx.lineTo(ax(16), ay(8))
    ctx.moveTo(ax(16), ay(8)); ctx.lineTo(ax(10), ay(8))
    ctx.moveTo(ax(16), ay(8)); ctx.lineTo(ax(16), ay(14))
    ctx.stroke()

    ctx.textAlign = 'left'
    ctx.fillStyle = '#ffffff'; ctx.font = `700 18px ${FONT}`; setLS(-0.3)
    ctx.fillText(input.companyName || 'cirqle', 82, 43)
    ctx.fillStyle = '#94a3b8'; ctx.font = `600 8px ${FONT}`; setLS(2.2)
    ctx.fillText('DESIGN', 83, 64)
    setLS(0)
  }

  // receipt no (right aligned)
  ctx.textAlign = 'right'
  ctx.fillStyle = '#64748b'; ctx.font = `600 9px ${FONT}`; setLS(0.7)
  ctx.fillText('RECEIPT NO.', 400, 41)
  setLS(0)
  ctx.fillStyle = '#cbd5e1'; ctx.font = `600 11px ${MONO}`
  ctx.fillText(input.receiptNo, 400, 53)

  // ── hero: gradient check badge ────────────────────────────────
  ctx.save()
  ctx.shadowColor = 'rgba(124,58,237,0.45)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 8
  ctx.fillStyle = lin(184, 100, 248, 164, '#7c3aed', '#60a5fa')
  ctx.beginPath(); ctx.arc(216, 132, 32, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
  ctx.strokeStyle = '#ffffff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 4
  const cx = (x: number) => 199 + x * 1.4167
  const cy = (y: number) => 115 + y * 1.4167
  ctx.beginPath(); ctx.moveTo(cx(5), cy(12.5)); ctx.lineTo(cx(10), cy(17.5)); ctx.lineTo(cx(19), cy(7)); ctx.stroke()

  // PAYMENT RECEIVED + amount
  ctx.textAlign = 'center'
  ctx.fillStyle = '#a5b4fc'; ctx.font = `600 12px ${FONT}`; setLS(2.6)
  ctx.fillText('PAYMENT RECEIVED', 217, 180)
  setLS(0)
  ctx.fillStyle = '#ffffff'; ctx.font = `800 38px ${FONT}`; setLS(-0.6)
  ctx.fillText(fmtAmount(input.amount, input.currency), 216, 194)
  setLS(0)

  // ── details panel ─────────────────────────────────────────────
  const rows: { label: string; value: string; mono: boolean }[] = [
    { label: 'Received from', value: clientName || '—', mono: false },
    { label: 'Invoice Ref', value: invoiceLabel, mono: true },
    { label: 'Date', value: dateLabel, mono: false },
  ]
  if (input.method) rows.push({ label: 'Method', value: input.method, mono: false })
  if (input.reference) rows.push({ label: 'Reference', value: input.reference, mono: true })

  const panelX = 32
  const panelW = 368
  const panelTop = 256
  const padX = 16
  const padY = 14
  const rowH = 16
  const rowGap = 9
  const bodyH = rows.length * rowH + (rows.length - 1) * rowGap
  const balanceH = balanceDue > 0.01 ? 10 + rowH : 0
  const panelH = padY * 2 + bodyH + balanceH

  ctx.fillStyle = 'rgba(255,255,255,0.04)'; roundRect(panelX, panelTop, panelW, panelH, 14); ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 1
  roundRect(panelX + 0.5, panelTop + 0.5, panelW - 1, panelH - 1, 13.5); ctx.stroke()

  const valMaxW = (panelW - padX * 2) * 0.62
  let ry = panelTop + padY
  for (const r of rows) {
    ctx.textAlign = 'left'; ctx.fillStyle = '#94a3b8'; ctx.font = `400 11.5px ${FONT}`
    ctx.fillText(r.label, panelX + padX, ry + 1)
    ctx.textAlign = 'right'; ctx.fillStyle = '#e5e7eb'; ctx.font = `600 12.5px ${r.mono ? MONO : FONT}`
    ctx.fillText(truncate(r.value, valMaxW), panelX + panelW - padX, ry)
    ry += rowH + rowGap
  }
  if (balanceDue > 0.01) {
    const divY = ry - rowGap + 9
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(panelX + padX, divY); ctx.lineTo(panelX + panelW - padX, divY); ctx.stroke()
    const by = divY + 7
    ctx.textAlign = 'left'; ctx.fillStyle = '#fbbf24'; ctx.font = `600 12px ${FONT}`
    ctx.fillText('Balance due', panelX + padX, by)
    ctx.textAlign = 'right'; ctx.font = `700 13px ${FONT}`
    ctx.fillText(fmtAmount(balanceDue, input.currency), panelX + panelW - padX, by)
  }

  // ── footer (pinned to bottom) + thank-you note ────────────────
  const footY = H - 26 - 11
  // Compose footer from company settings: "{website} · {phone}". Either part
  // can be missing — separator is inserted only when both are present so we
  // never render a dangling middle dot.
  const footerParts = [input.companyWebsite, input.companyPhone].filter(Boolean)
  const footerLeft = footerParts.length ? footerParts.join(' · ') : 'cirqle.work · +91 81295 34377'
  ctx.textAlign = 'left'; ctx.fillStyle = '#64748b'; ctx.font = `400 9.5px ${FONT}`
  ctx.fillText(footerLeft, 32, footY)
  ctx.textAlign = 'right'
  ctx.fillText('Computer-generated receipt', 400, footY)
  const divY2 = footY - 12
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(32, divY2); ctx.lineTo(400, divY2); ctx.stroke()
  ctx.textAlign = 'center'; ctx.fillStyle = '#c4b5fd'; ctx.font = `500 12.5px ${FONT}`
  ctx.fillText(truncate(note || 'Thank you for your payment!', 360), 216, divY2 - 27)
}

export default function ReceiptModal({ input, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  // Container that constrains the preview to the modal width. We measure it
  // with a ResizeObserver and derive a CSS scale so the 432-wide card always
  // fits without horizontal scrolling, regardless of device width.
  const previewContainerRef = useRef<HTMLDivElement>(null)
  const [previewScale, setPreviewScale] = useState(1)
  const [clientName, setClientName] = useState(input.defaultClientName || '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'png' | 'share' | 'pdf' | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  // Desktop-only: which "share to linked WhatsApp" action the split button runs,
  // and whether the little action picker is open.
  const onDesktop = isDesktop()
  const [shareAction, setShareAction] = useState<ReceiptShareAction>(() => (onDesktop ? effectiveShareAction() : 'copy'))
  const [shareMenuOpen, setShareMenuOpen] = useState(false)

  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      setPreviewScale(w >= CARD_W ? 1 : w / CARD_W)
    })
    obs.observe(el)
    // Set immediately on mount so there's no flash at full size
    const initialW = el.getBoundingClientRect().width
    if (initialW > 0 && initialW < CARD_W) setPreviewScale(initialW / CARD_W)
    return () => obs.disconnect()
  }, [])

  const balanceDue = input.invoices.reduce((s, i) => s + Math.max(0, i.outstanding ?? 0), 0)
  const invoiceLabel = input.invoices.length
    ? input.invoices.map(i => i.number).join(', ')
    : '—'
  const dateLabel = input.dateISO
    ? new Date(input.dateISO).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''

  function renderCanvas(): Promise<HTMLCanvasElement | null> {
    return renderReceiptCanvas(input, { clientName, note })
  }

  function flashDone() {
    setDone(true)
    setTimeout(() => setDone(false), 1800)
  }

  async function exportImage(share: boolean) {
    setBusy(share ? 'share' : 'png')
    setError('')
    try {
      const canvas = await renderCanvas()
      if (!canvas) return
      const blob: Blob | null = await new Promise(res => canvas.toBlob(res, 'image/png', 0.97))
      if (!blob) return
      const file = new File([blob], `Cirqle-Receipt-${input.receiptNo}.png`, { type: 'image/png' })

      // Web Share API w/ files → lets the user push straight to WhatsApp / Photos.
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
      if (share && nav.canShare?.({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: 'Payment Receipt', text: `Payment receipt — ${input.receiptNo}` })
          flashDone()
          return
        } catch {
          // user cancelled or share failed → fall through to download
        }
      }

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      flashDone()
    } catch (e) {
      console.error('Receipt image export failed', e)
      setError('Could not generate the receipt image. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  // Desktop: render the receipt PNG and hand it to the Electron shell, which
  // copies it to the clipboard + focuses WhatsApp (copy), auto-pastes into the
  // open chat (paste), or saves + reveals it in Finder (download).
  async function shareToWhatsApp(action: ReceiptShareAction) {
    const bridge = desktop()
    if (!bridge?.shareReceipt) return
    setBusy('share')
    setError('')
    setShareMenuOpen(false)
    setShareAction(action)
    rememberLastShareAction(action)
    try {
      const canvas = await renderCanvas()
      if (!canvas) return
      const dataUrl = canvas.toDataURL('image/png', 0.97)
      const res = await bridge.shareReceipt(dataUrl, `Cirqle-Receipt-${input.receiptNo}.png`, action, `Payment receipt — ${input.receiptNo}`)
      if (res?.ok) flashDone()
      else setError('Could not share to WhatsApp. Try the Image button and drag it in.')
    } catch (e) {
      console.error('Receipt share to WhatsApp failed', e)
      setError('Could not share to WhatsApp. Try the Image button and drag it in.')
    } finally {
      setBusy(null)
    }
  }

  async function exportPdf() {
    setBusy('pdf')
    setError('')
    try {
      const canvas = await renderCanvas()
      if (!canvas) return
      const img = canvas.toDataURL('image/png')
      const { default: jsPDF } = await import('jspdf')
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'px', format: [canvas.width, canvas.height] })
      pdf.addImage(img, 'PNG', 0, 0, canvas.width, canvas.height)
      pdf.save(`Cirqle-Receipt-${input.receiptNo}.pdf`)
      flashDone()
    } catch (e) {
      console.error('Receipt PDF export failed', e)
      setError('Could not generate the receipt PDF. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[92dvh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-secondary/30 shrink-0">
          <div>
            <h2 className="font-semibold text-sm">Payment Receipt</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">Save as image or PDF, then share anywhere</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="overflow-y-auto p-5 space-y-4">
          {/* Editable fields */}
          <div className="grid grid-cols-1 gap-3">
            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Received from</span>
              <input
                value={clientName}
                onChange={e => setClientName(e.target.value)}
                placeholder="Client / payer name"
                className="mt-1 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Note (optional)</span>
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="e.g. Thank you for your business"
                maxLength={80}
                className="mt-1 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </label>
          </div>

          {/* ── Live preview ──────────────────────────────────────────
              The card is designed at CARD_W × CARD_H (432 × 540 px).
              On narrow viewports (mobile) we scale it down proportionally
              so it always fits inside the modal without horizontal scroll.
              The scale is derived from the container's measured width via
              ResizeObserver — the container is 100% wide so it never
              overflows the modal itself.
              Export quality (canvas at CAPTURE_SCALE=2.6) is unaffected —
              we only scale the DOM preview, not the canvas dimensions.   */}
          <div
            ref={previewContainerRef}
            style={{
              width: '100%',
              // Reserve exactly the scaled height so the parent layout
              // doesn't collapse or create extra whitespace.
              height: Math.round(CARD_H * previewScale),
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                // Always render at the native 432 × 540 design size, then
                // scale down via transform. transform-origin: top left so
                // the card aligns with the left edge of the container.
                position: 'absolute',
                top: 0,
                left: 0,
                transformOrigin: 'top left',
                transform: previewScale < 1 ? `scale(${previewScale})` : 'none',
              }}
            >
              <div
                ref={cardRef}
                style={{
                  width: CARD_W,
                  height: CARD_H,
                  position: 'relative',
                  overflow: 'hidden',
                  background:
                    'radial-gradient(120% 80% at 50% -10%, #1e1b4b 0%, #0b1120 55%)',
                  color: '#ffffff',
                  fontFamily:
                    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
                  boxSizing: 'border-box',
                  padding: '34px 32px 26px',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {/* Brand row — workspace logo if configured, else default gradient mark + wordmark */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {input.companyLogoUrl ? (
                    // Logo from Settings → Company. `maxWidth/maxHeight` keeps any
                    // aspect ratio inside the brand box; object-fit:contain prevents
                    // squashing. The plain <img> doesn't need CORS for the on-screen
                    // preview — only the canvas export does (handled separately).
                    <img
                      src={input.companyLogoUrl}
                      alt={input.companyName || 'Workspace logo'}
                      style={{ maxWidth: 140, maxHeight: 40, objectFit: 'contain' }}
                    />
                  ) : (
                    <>
                      <div
                        style={{
                          width: 40, height: 40, borderRadius: '50%',
                          background: 'linear-gradient(135deg, #7c3aed, #60a5fa)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                          <path d="M8 16L16 8M16 8H10M16 8V14" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
                        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>{input.companyName || 'cirqle'}</span>
                        <span style={{ fontSize: 8, letterSpacing: '0.28em', color: '#94a3b8', fontWeight: 600 }}>DESIGN</span>
                      </div>
                    </>
                  )}
                  <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                    <div style={{ fontSize: 9, color: '#64748b', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Receipt No.</div>
                    <div style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>{input.receiptNo}</div>
                  </div>
                </div>

                {/* Hero */}
                <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div
                    style={{
                      width: 64, height: 64, borderRadius: '50%',
                      background: 'linear-gradient(135deg, #7c3aed, #60a5fa)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: '0 8px 28px rgba(124,58,237,0.45)',
                    }}
                  >
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
                      <path d="M5 12.5L10 17.5L19 7" stroke="#ffffff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div style={{ marginTop: 14, fontSize: 12, letterSpacing: '0.22em', color: '#a5b4fc', fontWeight: 600 }}>
                    PAYMENT RECEIVED
                  </div>
                  <div style={{ marginTop: 8, fontSize: 38, fontWeight: 800, letterSpacing: '-0.02em', color: '#ffffff' }}>
                    {fmtAmount(input.amount, input.currency)}
                  </div>
                </div>

                {/* Details */}
                <div
                  style={{
                    marginTop: 22,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 14,
                    padding: '14px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 9,
                  }}
                >
                  <DetailRow label="Received from" value={clientName || '—'} />
                  <DetailRow label="Invoice Ref" value={invoiceLabel} mono />
                  <DetailRow label="Date" value={dateLabel} />
                  {input.method ? <DetailRow label="Method" value={input.method} /> : null}
                  {input.reference ? <DetailRow label="Reference" value={input.reference} mono /> : null}
                  {balanceDue > 0.01 ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 9, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                      <span style={{ fontSize: 12, color: '#fbbf24', fontWeight: 600 }}>Balance due</span>
                      <span style={{ fontSize: 13, color: '#fbbf24', fontWeight: 700 }}>{fmtAmount(balanceDue, input.currency)}</span>
                    </div>
                  ) : null}
                </div>

                {/* Thank-you / note + footer */}
                <div style={{ marginTop: 'auto', paddingTop: 16 }}>
                  <div style={{ fontSize: 12.5, color: '#c4b5fd', textAlign: 'center', fontWeight: 500 }}>
                    {note || 'Thank you for your payment!'}
                  </div>
                  <div
                    style={{
                      marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      fontSize: 9.5, color: '#64748b',
                    }}
                  >
                    <span>{[input.companyWebsite, input.companyPhone].filter(Boolean).join(' · ') || 'cirqle.work · +91 81295 34377'}</span>
                    <span>Computer-generated receipt</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Action bar */}
        {error && (
          <div className="px-3 pt-2 shrink-0">
            <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">{error}</p>
          </div>
        )}
        <div className="border-t border-border p-3 flex items-center gap-2 shrink-0 bg-secondary/20">
          {onDesktop ? (
            /* Desktop: split button → share to the linked WhatsApp pane, chevron picks how. */
            <div className="relative flex-1 flex">
              <button
                onClick={() => shareToWhatsApp(shareAction)}
                disabled={busy !== null}
                title={RECEIPT_SHARE_HINTS[shareAction]}
                className="flex-1 flex items-center justify-center gap-1.5 gradient-bg text-white pl-4 pr-3 py-2.5 rounded-l-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {busy === 'share' ? <Loader2 className="w-4 h-4 animate-spin" /> : done ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
                {shareAction === 'download' ? 'Save & Reveal' : 'Send to WhatsApp'}
              </button>
              <button
                onClick={() => setShareMenuOpen(o => !o)}
                disabled={busy !== null}
                aria-label="Choose how to share"
                className="gradient-bg text-white px-2 py-2.5 rounded-r-lg border-l border-white/20 hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
              {shareMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShareMenuOpen(false)} />
                  <div className="absolute bottom-full left-0 mb-1.5 z-50 w-72 bg-card border border-border rounded-xl shadow-2xl shadow-black/40 overflow-hidden p-1">
                    {(['copy', 'paste', 'download'] as ReceiptShareAction[]).map(a => (
                      <button
                        key={a}
                        onClick={() => shareToWhatsApp(a)}
                        className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-secondary transition-colors flex items-start gap-2"
                      >
                        <span className="mt-0.5 w-4 shrink-0">{shareAction === a && <Check className="w-3.5 h-3.5 text-primary" />}</span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-foreground">{RECEIPT_SHARE_LABELS[a]}</span>
                          <span className="block text-[11px] text-muted-foreground leading-snug">{RECEIPT_SHARE_HINTS[a]}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              onClick={() => exportImage(true)}
              disabled={busy !== null}
              className="flex-1 flex items-center justify-center gap-1.5 gradient-bg text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {busy === 'share' ? <Loader2 className="w-4 h-4 animate-spin" /> : done ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
              Share
            </button>
          )}
          <button
            onClick={() => exportImage(false)}
            disabled={busy !== null}
            className="flex items-center justify-center gap-1.5 bg-secondary border border-border px-3.5 py-2.5 rounded-lg text-sm font-medium hover:bg-secondary/70 transition-colors disabled:opacity-50"
            title="Download PNG image"
          >
            {busy === 'png' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            <span className="hidden sm:inline">Image</span>
          </button>
          <button
            onClick={exportPdf}
            disabled={busy !== null}
            className="flex items-center justify-center gap-1.5 bg-secondary border border-border px-3.5 py-2.5 rounded-lg text-sm font-medium hover:bg-secondary/70 transition-colors disabled:opacity-50"
            title="Download PDF"
          >
            {busy === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            <span className="hidden sm:inline">PDF</span>
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
      <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{label}</span>
      <span
        style={{
          fontSize: 12.5,
          color: '#e5e7eb',
          fontWeight: 600,
          textAlign: 'right',
          fontFamily: mono ? 'ui-monospace, monospace' : 'inherit',
          maxWidth: '62%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  )
}
