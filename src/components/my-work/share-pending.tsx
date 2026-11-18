'use client'

/**
 * Share button for My Work: sends one person's pending work to WhatsApp, as an
 * image card or as a text list, to a group or straight to that person.
 *
 * How each route reaches WhatsApp:
 *   Image  — phone (app or browser): the system share sheet, where WhatsApp
 *            then asks for the group or contact. Computer: copied to the
 *            clipboard (paste into WhatsApp Desktop / Web), or downloaded.
 *   Text   — a wa.me link: without a number WhatsApp asks which chat or group;
 *            "Send to <name>" opens that person's chat directly.
 *
 * The summary itself (what is pending, in what order) is my-work-share.ts.
 */
import { useEffect, useMemo, useState } from 'react'
import { Share2, Image as ImageIcon, Copy, Download, MessageCircle, Loader2, Check, X as XIcon, User } from 'lucide-react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { isNative } from '@/lib/native'
import { shareContent, saveBase64File, writeClipboard } from '@/lib/native-capabilities'
import {
  buildPendingSummary, pendingShareText, pendingCardHtml, whatsappUrl, type ShareableRow,
} from '@/lib/requests/my-work-share'
import { renderPendingCard, blobToBase64 } from '@/lib/requests/my-work-share-image'
import { employeeWhatsAppNumber } from '@/app/(dashboard)/dashboard/my-work/actions'
import { todayISO } from '@/lib/utils/local-date'

interface Props {
  /** Every row on the board — the share always covers the whole queue, not a client filter. */
  rows: readonly ShareableRow[]
  /** Shown on the card and in the message: "CQID004", or the person's first name on their own board. */
  owner: string
  /** Whose work this is; used to offer "Send to …" when they have a WhatsApp number. */
  employeeId?: string | null
  /** Label for the direct-message button ("CQID004"); omitted on your own board. */
  recipientLabel?: string | null
}

type Busy = null | 'share' | 'copy' | 'download'

export function SharePendingButton(props: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 h-[38px] px-3 rounded-lg border border-border bg-secondary text-sm text-muted-foreground hover:text-foreground transition-colors"
        title="Share pending work to WhatsApp"
      >
        <Share2 className="w-4 h-4" /> Share
      </button>
      {open && <ShareDialog {...props} onClose={() => setOpen(false)} />}
    </>
  )
}

function ShareDialog({ rows, owner, employeeId, recipientLabel, onClose }: Props & { onClose: () => void }) {
  const summary = useMemo(() => buildPendingSummary(owner, rows, todayISO()), [owner, rows])
  const text = useMemo(() => pendingShareText(summary), [summary])
  const fileName = `${owner.replace(/[^\w-]+/g, '-')}-pending-${summary.today}.png`

  const [tab, setTab] = useState<'image' | 'text'>('image')
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null)
  const [imageError, setImageError] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [done, setDone] = useState<string>('')
  const [phone, setPhone] = useState<string | null>(null)

  // Render the card once, when the dialog opens.
  useEffect(() => {
    let alive = true, url = ''
    renderPendingCard(pendingCardHtml(summary))
      .then(blob => { if (!alive) return; url = URL.createObjectURL(blob); setImage({ blob, url }) })
      .catch(() => { if (alive) setImageError('Could not create the image. The text version still works.') })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [summary])

  // The person's own WhatsApp, for "Send to …". Quietly absent when unknown.
  useEffect(() => {
    if (!employeeId || !recipientLabel) return
    let alive = true
    employeeWhatsAppNumber(employeeId).then(r => { if (alive && r.ok) setPhone(r.data ?? null) }).catch(() => {})
    return () => { alive = false }
  }, [employeeId, recipientLabel])

  const flash = (msg: string) => { setDone(msg); setTimeout(() => setDone(''), 2200) }

  const canShareFiles = useMemo(() => {
    if (typeof navigator === 'undefined' || !image) return false
    if (isNative()) return true
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
    try { return !!nav.canShare?.({ files: [new File([image.blob], fileName, { type: 'image/png' })] }) } catch { return false }
  }, [image, fileName])

  async function shareImage() {
    if (!image) return
    setBusy('share')
    try {
      if (isNative()) {
        // The app's WebView has no Web Share; save the PNG and hand its file
        // to the native share sheet, where WhatsApp picks group or contact.
        const uri = await saveBase64File(fileName, await blobToBase64(image.blob), 'image/png')
        if (uri && await shareContent({ files: [uri], dialogTitle: 'Share pending work' })) { flash('Shared'); return }
      } else {
        const file = new File([image.blob], fileName, { type: 'image/png' })
        await (navigator as Navigator).share({ files: [file], title: `${owner} — pending work` })
        flash('Shared')
        return
      }
    } catch { /* cancelled */ } finally { setBusy(null) }
  }

  async function copyImage() {
    if (!image) return
    setBusy('copy')
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })])
      flash('Image copied — paste it into WhatsApp')
    } catch {
      flash('Copying images is not supported here — use Download')
    } finally { setBusy(null) }
  }

  function downloadImage() {
    if (!image) return
    const a = document.createElement('a')
    a.href = image.url
    a.download = fileName
    document.body.appendChild(a); a.click(); a.remove()
    flash('Downloaded')
  }

  async function copyText() {
    if (await writeClipboard(text)) flash('Text copied')
  }

  const openWhatsApp = (to?: string | null) => window.open(whatsappUrl(text, to), '_blank', 'noopener,noreferrer')

  const btn = 'inline-flex items-center justify-center gap-1.5 h-10 px-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-50'
  const primary = `${btn} gradient-bg text-white`
  const secondary = `${btn} border border-border bg-secondary text-foreground hover:bg-secondary/70`
  const wa = `${btn} bg-[#25D366] text-white hover:bg-[#1fb257]`

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col min-h-0 max-h-[90dvh]">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold">Share pending work</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {summary.pending.length} to do{summary.overdueCount ? ` · ${summary.overdueCount} overdue` : ''}
              {summary.withClient.length ? ` · ${summary.withClient.length} with the client` : ''}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pt-3 shrink-0">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary p-1 w-fit">
            {([['image', 'Image', ImageIcon], ['text', 'List', MessageCircle]] as const).map(([key, label, Icon]) => (
              <button
                key={key} onClick={() => setTab(key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors
                  ${tab === key ? 'gradient-bg text-white' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {tab === 'image' ? (
            image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image.url} alt={`${owner} pending work`} className="w-full rounded-xl border border-border" />
            ) : imageError ? (
              <p className="text-sm text-red-400">{imageError}</p>
            ) : (
              <div className="h-48 flex items-center justify-center text-sm text-muted-foreground gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Creating image…
              </div>
            )
          ) : (
            <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed rounded-xl border border-border bg-secondary/50 p-3 font-sans">{text}</pre>
          )}
        </div>

        <div className="px-5 pb-5 pt-1 shrink-0 space-y-2">
          {done && (
            <p className="text-xs text-green-500 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> {done}</p>
          )}
          {tab === 'image' ? (
            <div className="grid grid-cols-2 gap-2">
              {canShareFiles ? (
                <button className={`${wa} col-span-2`} disabled={!image || !!busy} onClick={shareImage}>
                  {busy === 'share' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
                  Share image to WhatsApp…
                </button>
              ) : (
                <button className={`${primary} col-span-2`} disabled={!image || !!busy} onClick={copyImage}>
                  {busy === 'copy' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
                  Copy image — paste in WhatsApp
                </button>
              )}
              <button className={secondary} disabled={!image || !!busy} onClick={downloadImage}>
                <Download className="w-4 h-4" /> Download
              </button>
              <button className={secondary} onClick={() => setTab('text')}>
                <MessageCircle className="w-4 h-4" /> Send as list
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button className={`${wa} ${phone ? '' : 'col-span-2'}`} onClick={() => openWhatsApp()}>
                <MessageCircle className="w-4 h-4" /> Group or chat
              </button>
              {phone && recipientLabel && (
                <button className={wa} onClick={() => openWhatsApp(phone)}>
                  <User className="w-4 h-4" /> To {recipientLabel}
                </button>
              )}
              <button className={`${secondary} col-span-2`} onClick={copyText}>
                <Copy className="w-4 h-4" /> Copy text
              </button>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {tab === 'image'
              ? canShareFiles ? 'WhatsApp then asks which group or contact to send it to.' : 'On a computer, copy the image and paste it into a WhatsApp chat or group.'
              : `Opens WhatsApp with the list ready to send${phone && recipientLabel ? ` — to any group or chat, or straight to ${recipientLabel}` : ' — then pick the group or chat'}. Covers the whole board, not just the selected client.`}
          </p>
        </div>
      </div>
    </ModalOverlay>
  )
}
