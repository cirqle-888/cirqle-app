'use client'

import { useRef } from 'react'

/**
 * Public hosted-invoice viewer. Renders the same invoice HTML the Invoices page
 * prints (via the shared renderInvoiceHtml) inside an iframe, with a branded top
 * bar + "Download PDF" button that triggers the browser's print-to-PDF on the
 * iframe document. No login, no app chrome.
 */
export default function PublicInvoiceView({
  html, invoiceNumber, companyName, logoUrl,
}: {
  html: string
  invoiceNumber: string
  companyName: string
  logoUrl?: string
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)

  const downloadPdf = () => {
    const w = frameRef.current?.contentWindow
    if (w) { w.focus(); w.print() }
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: '#0b1020' }}>
      {/* Branded top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '12px 16px', background: '#111827', color: '#fff',
        position: 'sticky', top: 0, zIndex: 10, borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {logoUrl
            ? <img src={logoUrl} alt={companyName} style={{ height: 26, objectFit: 'contain' }} />
            : <span style={{ fontWeight: 800, fontSize: 16 }}>{companyName}</span>}
          <span style={{ fontSize: 13, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            Invoice {invoiceNumber}
          </span>
        </div>
        <button
          onClick={downloadPdf}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
            background: 'linear-gradient(135deg,#7c3aed,#a855f7)', color: '#fff', border: 'none',
            padding: '8px 16px', borderRadius: 10, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          ⬇ Download PDF
        </button>
      </div>

      {/* Invoice document */}
      <div style={{ flex: 1, padding: '16px', overflowX: 'auto' }}>
        <iframe
          ref={frameRef}
          srcDoc={html}
          title={`Invoice ${invoiceNumber}`}
          style={{
            display: 'block', margin: '0 auto',
            width: '100%', minWidth: 750, maxWidth: 860, height: '80vh', minHeight: 600,
            border: 'none', background: '#fff', borderRadius: 12,
            boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
          }}
        />
      </div>

      <p style={{ textAlign: 'center', fontSize: 11, color: '#6b7280', padding: '4px 0 16px' }}>
        Tap <strong style={{ color: '#9ca3af' }}>Download PDF</strong> and choose “Save as PDF” to keep a copy.
      </p>
    </div>
  )
}
