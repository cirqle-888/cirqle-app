'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { refLabel } from '@/lib/requests/core'
import CaptionCanvasEditor from './caption-canvas'
import {
  DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable,
  pointerWithin, type DragEndEvent,
} from '@dnd-kit/core'
import {
  CONTENT_TYPES, CONTENT_TYPE_LABEL, CONTENT_TYPE_CHIP, VARIANT_TYPES,
  PLATFORMS, PLATFORM_LABEL, platformLabels, contentTypeWithVariants,
  PROGRESS_LABEL, PROGRESS_CHIP, resolveItemProgress, isClosedRequestStatus,
  formatShortDateRange, type CaptionCanvas,
  type ItemProgress,
} from '@/lib/social/plan'
import {
  createSocialCalendar, updateSocialCalendar, deleteSocialCalendar,
  addCalendarItem, updateCalendarItem, deleteCalendarItem, pushItemsToRequests,
  revertItemToPlanned, saveContentTypeServiceMap,
  quickAddIdea, moveCalendarItem, getRefUploadUrl,
  type ItemInput,
} from './actions'
import {
  CalendarDays, Loader2, Plus, Send, Trash2, Archive, ExternalLink, RotateCcw, X,
  Settings2, FileDown, FileSpreadsheet, FileText, Lightbulb, Upload, LayoutGrid,
  Link2, Clipboard, PanelRightClose, PanelRightOpen,
  Bold, Italic, Underline, Strikethrough, List, ListOrdered, Heading2, Quote,
  Link as LinkIcon, Highlighter, Palette, Smile, Eraser,
  AlignLeft, AlignCenter, AlignRight, CalendarRange,
} from 'lucide-react'

// ─── Types (mirror the page's selects) ────────────────────────────────────────

interface CalendarRow {
  id: string
  client_id: string
  month: string                 // YYYY-MM-01
  title: string | null
  status: 'draft' | 'active' | 'archived'
  notes: string | null
  client?: { id: string; name: string; code: string } | null
  items?: { id: string; status: string; request_id: string | null }[]
}

interface ItemRow {
  id: string
  calendar_id: string
  /** null = undated idea living on the Idea Board backlog */
  scheduled_date: string | null
  /** end of a multi-day run (campaign/SEO); null for single-day items */
  scheduled_end_date?: string | null
  title: string
  content_type: string
  platforms: string[] | null
  caption: string | null
  notes: string | null
  status: string
  request_id: string | null
  service_id?: string | null
  variants?: string[] | null
  reference_url?: string | null
  reference_urls?: string[] | null
  caption_canvas?: CaptionCanvas | null
  request?: {
    id: string
    ref_no: number | null
    status: string
    promoted_task_id: string | null
    promoted_task?: { id: string; task_number: number | null; status: string } | null
  } | null
}

interface Props {
  migrated: boolean
  calendars: CalendarRow[]
  selectedId: string | null
  initialItems: ItemRow[]
  clients: { id: string; name: string; code: string }[]
  services?: { id: string; name: string }[]
  /** Team-configured content-type → service defaults (Service defaults gear). */
  serviceMap?: Record<string, string>
  /** Branding/company keys for the PDF export (same template family as invoices). */
  companySettings?: Record<string, string>
  canManage: boolean
}

// Service assignment is fully automatic (server-side, from the Service-defaults
// mapping + keyword fallback in @/lib/social/plan) — planners never pick one.
// The gear-icon "Service defaults" modal below is where the team edits that
// mapping; `services`/`serviceMap` props exist only to power it.

// ── Rich caption editor ───────────────────────────────────────────────────────
// Self-contained contenteditable editor with a full formatting toolbar
// (emphasis, headings, quote, lists, alignment, colour, highlight, links,
// emoji). Emits HTML; the server sanitizes to the caption allowlist and the
// PDF renders the same formatting. execCommand is legacy but universally
// supported and exactly right for a caption field.

const CAPTION_COLORS = ['#111827', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']
const CAPTION_HIGHLIGHTS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#e9d5ff']
const CAPTION_EMOJI = ['✨', '🔥', '🎉', '✅', '👉', '⭐', '💥', '🛍️', '📣', '❤️', '🎁', '⏰', '📍', '💯']

// Toolbar button + separator — module-scope so they keep a stable identity
// across editor re-renders (defining them inline would remount every keystroke).
function EditorTool({ icon, title, on, disabled }: {
  icon: React.ReactNode; title: string; on: () => void; disabled?: boolean
}) {
  return (
    <button type="button" tabIndex={-1} disabled={disabled} title={title}
      onMouseDown={e => { e.preventDefault(); on() }}
      className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background transition-colors disabled:opacity-50">
      {icon}
    </button>
  )
}
const EditorSep = () => <span className="w-px h-4 bg-border mx-0.5 shrink-0" />

function RichTextEditor({
  value, onChange, disabled = false, placeholder, onPasteImage,
}: {
  value: string
  onChange: (html: string) => void
  disabled?: boolean
  placeholder?: string
  /** Image pasted into the caption — routed to the reference gallery. */
  onPasteImage?: (file: File) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [openMenu, setOpenMenu] = useState<null | 'color' | 'highlight' | 'emoji' | 'link'>(null)
  const [linkUrl, setLinkUrl] = useState('')
  // Opening a toolbar popover moves focus out of the contenteditable and the
  // caret is lost, so stash the range first and put it back before running the
  // command — otherwise "Insert link" would apply to nothing.
  const savedRange = useRef<Range | null>(null)

  useEffect(() => {
    const el = ref.current
    if (el && el.innerHTML !== (value || '') && document.activeElement !== el) {
      el.innerHTML = value || ''
    }
  }, [value])

  // css=true makes execCommand emit inline styles (needed for colour/align);
  // css=false keeps semantic tags (b/i/u). We toggle per command so output
  // stays predictable for the sanitizer.
  const run = (command: string, value?: string, css = false) => {
    const el = ref.current
    if (!el || disabled) return
    el.focus()
    try { document.execCommand('styleWithCSS', false, css ? 'true' : 'false') } catch { /* older engines */ }
    document.execCommand(command, false, value)
    onChange(el.innerHTML)
    setOpenMenu(null)
  }

  const insert = (text: string) => {
    const el = ref.current
    if (!el || disabled) return
    el.focus()
    document.execCommand('insertText', false, text)
    onChange(el.innerHTML)
    setOpenMenu(null)
  }

  const saveSelection = () => {
    const sel = window.getSelection()
    savedRange.current = sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)
      ? sel.getRangeAt(0).cloneRange()
      : null
  }

  // window.prompt() is not available here (Next 16 blocks it in the App Router
  // dev runtime and browsers suppress it in some embeds), so the link tool is
  // an inline popover instead of a modal prompt.
  const openLinkMenu = () => {
    if (disabled) return
    saveSelection()
    setLinkUrl('')
    setOpenMenu(m => (m === 'link' ? null : 'link'))
  }

  const applyLink = () => {
    const el = ref.current
    const url = linkUrl.trim()
    if (!el || !/^(https?:|mailto:)/i.test(url)) return
    el.focus()
    const r = savedRange.current
    if (r) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    }
    try { document.execCommand('styleWithCSS', false, 'false') } catch { /* older engines */ }
    if (!r || r.collapsed) {
      // Nothing selected — drop the URL in as its own link rather than no-op.
      const safe = url.replace(/"/g, '&quot;')
      const text = url.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      document.execCommand('insertHTML', false, `<a href="${safe}">${text}</a>`)
    } else {
      document.execCommand('createLink', false, url)
    }
    onChange(el.innerHTML)
    setLinkUrl('')
    setOpenMenu(null)
  }

  // Images are NOT part of the caption allowlist, so an inline paste would be
  // embedded as a base64 blob here and then silently stripped on save. Catch it
  // and hand the file to the reference gallery, where images actually belong.
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const img = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'))
    if (img && onPasteImage) {
      e.preventDefault()
      onPasteImage(img)
    }
  }

  const empty = !value || !value.replace(/<[^>]*>|&nbsp;|&#65279;/g, '').trim()

  return (
    <div className={`rounded-lg border border-border bg-secondary overflow-visible ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-0.5 px-1.5 py-1 border-b border-border/60 bg-secondary/60 relative">
        <EditorTool disabled={disabled} icon={<Bold className="w-3.5 h-3.5" />} title="Bold (⌘B)" on={() => run('bold')} />
        <EditorTool disabled={disabled} icon={<Italic className="w-3.5 h-3.5" />} title="Italic (⌘I)" on={() => run('italic')} />
        <EditorTool disabled={disabled} icon={<Underline className="w-3.5 h-3.5" />} title="Underline (⌘U)" on={() => run('underline')} />
        <EditorTool disabled={disabled} icon={<Strikethrough className="w-3.5 h-3.5" />} title="Strikethrough" on={() => run('strikeThrough')} />
        <EditorSep />
        <EditorTool disabled={disabled} icon={<Heading2 className="w-3.5 h-3.5" />} title="Heading" on={() => run('formatBlock', '<h3>')} />
        <EditorTool disabled={disabled} icon={<Quote className="w-3.5 h-3.5" />} title="Quote" on={() => run('formatBlock', '<blockquote>')} />
        <EditorTool disabled={disabled} icon={<List className="w-3.5 h-3.5" />} title="Bullet list" on={() => run('insertUnorderedList')} />
        <EditorTool disabled={disabled} icon={<ListOrdered className="w-3.5 h-3.5" />} title="Numbered list" on={() => run('insertOrderedList')} />
        <EditorSep />
        <EditorTool disabled={disabled} icon={<AlignLeft className="w-3.5 h-3.5" />} title="Align left" on={() => run('justifyLeft', undefined, true)} />
        <EditorTool disabled={disabled} icon={<AlignCenter className="w-3.5 h-3.5" />} title="Align center" on={() => run('justifyCenter', undefined, true)} />
        <EditorTool disabled={disabled} icon={<AlignRight className="w-3.5 h-3.5" />} title="Align right" on={() => run('justifyRight', undefined, true)} />
        <EditorSep />
        {/* Colour / highlight / emoji popovers */}
        <div className="relative">
          <EditorTool disabled={disabled} icon={<Palette className="w-3.5 h-3.5" />} title="Text colour" on={() => setOpenMenu(m => m === 'color' ? null : 'color')} />
          {openMenu === 'color' && (
            <div className="absolute top-8 left-0 z-50 flex gap-1 p-1.5 rounded-lg border border-border bg-card shadow-xl">
              {CAPTION_COLORS.map(c => (
                <button key={c} type="button" title={c} onMouseDown={e => { e.preventDefault(); run('foreColor', c, true) }}
                  className="w-5 h-5 rounded-full border border-black/10" style={{ backgroundColor: c }} />
              ))}
            </div>
          )}
        </div>
        <div className="relative">
          <EditorTool disabled={disabled} icon={<Highlighter className="w-3.5 h-3.5" />} title="Highlight" on={() => setOpenMenu(m => m === 'highlight' ? null : 'highlight')} />
          {openMenu === 'highlight' && (
            <div className="absolute top-8 left-0 z-50 flex gap-1 p-1.5 rounded-lg border border-border bg-card shadow-xl">
              {CAPTION_HIGHLIGHTS.map(c => (
                <button key={c} type="button" title={c} onMouseDown={e => { e.preventDefault(); run('hiliteColor', c, true) }}
                  className="w-5 h-5 rounded border border-black/10" style={{ backgroundColor: c }} />
              ))}
              <button type="button" title="No highlight" onMouseDown={e => { e.preventDefault(); run('hiliteColor', 'transparent', true) }}
                className="w-5 h-5 rounded border border-border flex items-center justify-center text-muted-foreground"><X className="w-3 h-3" /></button>
            </div>
          )}
        </div>
        <div className="relative">
          <EditorTool disabled={disabled} icon={<LinkIcon className="w-3.5 h-3.5" />} title="Insert link" on={openLinkMenu} />
          {openMenu === 'link' && (
            <div className="absolute top-8 left-0 z-50 flex items-center gap-1 p-1.5 rounded-lg border border-border bg-card shadow-xl">
              <input
                autoFocus
                value={linkUrl}
                onChange={e => setLinkUrl(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); applyLink() }
                  if (e.key === 'Escape') { e.preventDefault(); setOpenMenu(null) }
                }}
                placeholder="https://…"
                className="w-56 bg-secondary border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:border-primary/50"
              />
              <button type="button" onMouseDown={e => { e.preventDefault(); applyLink() }}
                disabled={!/^(https?:|mailto:)/i.test(linkUrl.trim())}
                className="px-2 py-1 rounded-md text-xs font-medium gradient-bg text-white disabled:opacity-40">
                Add
              </button>
            </div>
          )}
        </div>
        <div className="relative">
          <EditorTool disabled={disabled} icon={<Smile className="w-3.5 h-3.5" />} title="Emoji" on={() => setOpenMenu(m => m === 'emoji' ? null : 'emoji')} />
          {openMenu === 'emoji' && (
            <div className="absolute top-8 left-0 z-50 grid grid-cols-7 gap-0.5 p-1.5 rounded-lg border border-border bg-card shadow-xl w-56">
              {CAPTION_EMOJI.map(e => (
                <button key={e} type="button" onMouseDown={ev => { ev.preventDefault(); insert(e) }}
                  className="w-7 h-7 rounded hover:bg-secondary text-base">{e}</button>
              ))}
            </div>
          )}
        </div>
        <EditorSep />
        <EditorTool disabled={disabled} icon={<Eraser className="w-3.5 h-3.5" />} title="Clear formatting" on={() => run('removeFormat')} />
      </div>
      <div className="relative">
        {empty && placeholder && (
          <div className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground/60">{placeholder}</div>
        )}
        <div
          ref={ref}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={e => onChange((e.target as HTMLDivElement).innerHTML)}
          onPaste={handlePaste}
          className="min-h-[110px] max-h-64 overflow-y-auto px-3 py-2 text-sm focus:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:text-base [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-bold [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:underline"
        />
      </div>
    </div>
  )
}

// Pull an image off the clipboard (a pasted screenshot) as a File for upload.
async function readImageFromClipboard(): Promise<File | null> {
  try {
    if (!navigator.clipboard?.read) return null
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(t => t.startsWith('image/'))
      if (type) {
        const blob = await item.getType(type)
        return new File([blob], `ref-${type.split('/')[1] || 'png'}`, { type })
      }
    }
  } catch { /* permission denied / unsupported */ }
  return null
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// UTC-based YYYY-MM-DD — used when stepping through a date range so the day
// count never drifts by a timezone offset.
const ymdUTC = (d: Date) => d.toISOString().slice(0, 10)

/** A campaign running over a year is a typo, not a plan — bounds range walks. */
const MAX_RANGE_DAYS = 366

// Idea Board collapse preference, backed by localStorage and read through
// useSyncExternalStore. NOT a lazy useState: the server has no localStorage, so
// it always renders the expanded tree — a lazy initialiser would make the
// client's first render disagree, and collapsed/expanded are structurally
// different trees, so that is a real hydration mismatch rather than a cosmetic
// one. getServerSnapshot pins hydration to "expanded", then React swaps in the
// stored preference immediately after.
const BOARD_KEY = 'social:boardCollapsed'
const boardStore = {
  subscribe(cb: () => void) {
    window.addEventListener('storage', cb)
    window.addEventListener(BOARD_KEY, cb)
    return () => {
      window.removeEventListener('storage', cb)
      window.removeEventListener(BOARD_KEY, cb)
    }
  },
  // Returns a primitive, so repeated calls stay referentially stable.
  get(): boolean {
    try { return localStorage.getItem(BOARD_KEY) === '1' } catch { return false }
  },
  set(next: boolean) {
    try { localStorage.setItem(BOARD_KEY, next ? '1' : '0') } catch { /* no storage */ }
    window.dispatchEvent(new Event(BOARD_KEY)) // same-tab listeners; `storage` only fires cross-tab
  },
}

const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

// serviceId deliberately absent: the server auto-assigns it from the content type.
const EMPTY_ITEM: ItemInput = {
  scheduledDate: '', scheduledEndDate: '', title: '', contentType: 'post', platforms: [], caption: '', notes: '', variants: [], referenceUrls: [], captionCanvas: null,
}

/** Effective reference list (array supersedes the legacy single field). */
const itemRefs = (it: { reference_urls?: string[] | null; reference_url?: string | null }): string[] =>
  it.reference_urls?.length ? it.reference_urls : (it.reference_url ? [it.reference_url] : [])

// ── Drag & drop building blocks ──────────────────────────────────────────────
// Item chips and idea cards are draggable; day cells and the Idea Board are
// droppable. The pointer sensor needs 6px of travel before a drag starts, so
// plain clicks still open the edit modal.

function DraggableItem({ id, disabled, children }: { id: string; disabled?: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id, disabled })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 60, position: 'relative' } : undefined}
      className={`${isDragging ? 'opacity-90 shadow-xl cursor-grabbing' : disabled ? '' : 'cursor-grab'} touch-none`}
    >
      {children}
    </div>
  )
}

function DroppableZone({ id, className, activeClassName, disabled, children }: {
  id: string; className: string; activeClassName: string; disabled?: boolean; children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled })
  return (
    <div ref={setNodeRef} className={`${className} ${isOver && !disabled ? activeClassName : ''}`}>
      {children}
    </div>
  )
}

export default function SocialCalendarClient({
  migrated, calendars, selectedId, initialItems, clients, services = [], serviceMap = {}, companySettings = {}, canManage,
}: Props) {
  const router = useRouter()
  const toast = useToast()

  const selected = calendars.find(c => c.id === selectedId) ?? null
  const items = initialItems

  // ── New-plan modal ──────────────────────────────────────────────────────────
  const [showNewPlan, setShowNewPlan] = useState(false)
  const [planForm, setPlanForm] = useState({
    clientId: '', month: new Date().toISOString().slice(0, 7), title: '', notes: '',
  })
  const [savingPlan, setSavingPlan] = useState(false)

  // ── Item modal (add or edit) ────────────────────────────────────────────────
  const [itemModal, setItemModal] = useState<{ mode: 'add' | 'edit'; itemId?: string } | null>(null)
  const [itemForm, setItemForm] = useState<ItemInput>(EMPTY_ITEM)
  const [savingItem, setSavingItem] = useState(false)
  // ── Service-defaults editor (content type → service mapping) ───────────────
  const [showServiceDefaults, setShowServiceDefaults] = useState(false)
  const [serviceMapDraft, setServiceMapDraft] = useState<Record<string, string>>({})
  const [savingServiceMap, setSavingServiceMap] = useState(false)

  // ── Export (branded A4 PDF / Excel / monthly report) ────────────────────────
  const [exporting, setExporting] = useState<'pdf' | 'excel' | 'report' | null>(null)

  // Client-facing rows for a chosen subset of items. Scheduled work only —
  // undated brainstorm ideas are internal until they're placed on a day.
  function buildExportInput(subset?: (it: ItemRow) => boolean) {
    const serviceName = (id?: string | null) => services.find(s => s.id === id)?.name ?? ''
    const rows = items
      .filter(it => it.scheduled_date && (subset ? subset(it) : true))
      .sort((a, b) => a.scheduled_date!.localeCompare(b.scheduled_date!))
      .map(it => ({
        date: it.scheduled_date!,
        endDate: it.scheduled_end_date ?? null,
        title: it.title,
        // "Post + Story" — the client sees every format this creative ships in.
        contentType: contentTypeWithVariants(it.content_type, it.variants),
        platforms: platformLabels(it.platforms, true),
        service: serviceName(it.service_id),
        status: PROGRESS_LABEL[resolveItemProgress(it.status, it.request)],
        caption: it.caption,
        imageUrls: itemRefs(it),
        canvas: it.caption_canvas ?? null,
      }))
    return {
      clientName: selected?.client?.name ?? '',
      monthLabel: selected ? monthLabel(selected.month) : '',
      planTitle: selected?.title ?? null,
      rows,
    }
  }

  // The monthly report shows only DELIVERED / COMPLETED work — what the client
  // actually received this month.
  const isDeliveredWork = (it: ItemRow) => {
    const p = resolveItemProgress(it.status, it.request)
    return p === 'delivered' || p === 'done'
  }
  const deliveredCount = useMemo(() => items.filter(it => it.scheduled_date && isDeliveredWork(it)).length, [items])

  async function exportPlan(kind: 'pdf' | 'excel') {
    if (!selected || !items.length || exporting) return
    setExporting(kind)
    try {
      const { downloadPlanPdf, downloadPlanExcel } = await import('@/lib/social/plan-export')
      if (kind === 'pdf') await downloadPlanPdf(buildExportInput(), companySettings)
      else await downloadPlanExcel(buildExportInput())
      toast.success(kind === 'pdf' ? 'Plan PDF downloaded' : 'Plan Excel downloaded')
    } catch (e) {
      toast.toastError('Export failed', e instanceof Error ? e.message : 'Please try again.')
    } finally {
      setExporting(null)
    }
  }

  async function exportReport() {
    if (!selected || exporting) return
    const input = buildExportInput(isDeliveredWork)
    if (!input.rows.length) { toast.toastError('Nothing to report yet', 'The monthly report lists delivered/completed work — none this month.'); return }
    setExporting('report')
    try {
      const { downloadReportPdf } = await import('@/lib/social/plan-export')
      await downloadReportPdf(input, companySettings)
      toast.success('Monthly report downloaded')
    } catch (e) {
      toast.toastError('Report failed', e instanceof Error ? e.message : 'Please try again.')
    } finally {
      setExporting(null)
    }
  }

  async function submitServiceMap() {
    setSavingServiceMap(true)
    const res = await saveContentTypeServiceMap(serviceMapDraft)
    setSavingServiceMap(false)
    if (!res.ok) { toast.toastError('Could not save the defaults', res.error); return }
    setShowServiceDefaults(false)
    toast.success('Service defaults saved', 'New items now preselect these services per content type.')
    router.refresh()
  }
  const [busy, setBusy] = useState<string | null>(null)   // 'push-all' | 'push:<id>' | 'delete:<id>' | 'archive'

  // ── Canvas state: view toggle, quick-add, drag & drop ──────────────────────
  const [viewMode, setViewMode] = useState<'calendar' | 'board'>('calendar')
  const [quickTitle, setQuickTitle] = useState('')
  const [quickType, setQuickType] = useState<string>('post')
  const [quickBusy, setQuickBusy] = useState(false)
  const [refUploading, setRefUploading] = useState(false)
  const [refLink, setRefLink] = useState('')
  // Caption has two views: the written brief and the free-drag layout board.
  const [copyTab, setCopyTab] = useState<'text' | 'canvas'>('text')
  const canvasBlockCount = (itemForm.captionCanvas as CaptionCanvas | null)?.blocks?.length ?? 0

  /** Upload for canvas blocks — same storage path as reference images, but the
   *  URL goes into a board block instead of the reference gallery. */
  const uploadImageForCanvas = async (file: File): Promise<string | null> => {
    try {
      const res = await getRefUploadUrl(file.name)
      if (!res.ok || !res.data) { toast.toastError('Upload failed', res.error); return null }
      const put = await fetch(res.data.uploadUrl, {
        method: 'PUT', headers: { 'Content-Type': file.type }, body: file,
      })
      if (!put.ok) { toast.toastError('Upload failed', 'Storage rejected the file.'); return null }
      return res.data.publicUrl
    } catch (e) {
      toast.toastError('Upload failed', e instanceof Error ? e.message : 'Please try again.')
      return null
    }
  }
  // Collapsible Idea Board (persisted, expanded by default).
  const boardCollapsed = useSyncExternalStore(boardStore.subscribe, boardStore.get, () => false)
  const toggleBoard = () => boardStore.set(!boardCollapsed)
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  async function submitQuickIdea() {
    const title = quickTitle.trim()
    if (!title || quickBusy || !selected) return
    setQuickBusy(true)
    const res = await quickAddIdea(selected.id, title, quickType)
    setQuickBusy(false)
    if (!res.ok) { toast.toastError('Could not add the idea', res.error); return }
    setQuickTitle('')
    router.refresh()
  }

  async function handleDragEnd(e: DragEndEvent) {
    const itemId = String(e.active.id)
    const over = e.over?.id != null ? String(e.over.id) : null
    if (!over) return
    const item = items.find(i => i.id === itemId)
    if (!item) return
    const targetDate = over === 'idea-board' ? null : over.startsWith('day:') ? over.slice(4) : undefined
    if (targetDate === undefined || targetDate === item.scheduled_date) return
    const res = await moveCalendarItem(itemId, targetDate)
    if (!res.ok) { toast.toastError('Could not move the item', res.error); return }
    router.refresh()
  }

  function openEdit(it: ItemRow) {
    setRefLink('')
    setItemForm({
      scheduledDate: it.scheduled_date ?? '', scheduledEndDate: it.scheduled_end_date ?? '',
      title: it.title, contentType: it.content_type, platforms: it.platforms ?? [],
      caption: it.caption ?? '', notes: it.notes ?? '',
      variants: it.variants ?? [], referenceUrls: itemRefs(it),
      captionCanvas: it.caption_canvas ?? null,
    })
    // Open straight onto whichever view this item actually uses.
    setCopyTab(it.caption_canvas?.blocks?.length ? 'canvas' : 'text')
    setItemModal({ mode: 'edit', itemId: it.id })
  }

  const addReference = (url: string) => setItemForm(p => {
    const u = url.trim()
    const list = p.referenceUrls ?? []
    if (!u || list.includes(u) || list.length >= 8) return p
    return { ...p, referenceUrls: [...list, u] }
  })
  const removeReference = (idx: number) => setItemForm(p => ({
    ...p, referenceUrls: (p.referenceUrls ?? []).filter((_, i) => i !== idx),
  }))

  async function uploadReference(file: File) {
    setRefUploading(true)
    try {
      const res = await getRefUploadUrl(file.name)
      if (!res.ok || !res.data) { toast.toastError('Upload failed', res.error); return }
      const put = await fetch(res.data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
      if (!put.ok) { toast.toastError('Upload failed', 'Storage rejected the file.'); return }
      addReference(res.data.publicUrl)
      toast.success('Reference image added')
    } catch (e) {
      // Call sites fire-and-forget this; without a catch a dropped connection
      // becomes an unhandled rejection and the user sees nothing at all.
      toast.toastError('Upload failed', e instanceof Error ? e.message : 'Please try again.')
    } finally {
      setRefUploading(false)
    }
  }

  async function pasteReference() {
    try {
      const file = await readImageFromClipboard()
      if (!file) { toast.toastError('No image on the clipboard', 'Copy an image first, then Paste.'); return }
      await uploadReference(file)
    } catch (e) {
      toast.toastError('Paste failed', e instanceof Error ? e.message : 'Could not read the clipboard.')
    }
  }

  const editingItem = itemModal?.mode === 'edit'
    ? items.find(i => i.id === itemModal.itemId) ?? null
    : null
  const editingProgress: ItemProgress | null = editingItem
    ? resolveItemProgress(editingItem.status, editingItem.request)
    : null
  const editingFrozen = !!editingItem?.request?.promoted_task_id
  const requestIsClosed = isClosedRequestStatus(editingItem?.request?.status)

  // ── Derived: month grid + per-day items + progress counts ──────────────────
  const grid = useMemo(() => {
    if (!selected) return []
    const [y, m] = selected.month.split('-').map(Number)
    const first = new Date(y, m - 1, 1)
    const start = new Date(y, m - 1, 1 - first.getDay())
    const cells: { date: Date; key: string; inMonth: boolean }[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      cells.push({ date: d, key: ymd(d), inMonth: d.getMonth() === m - 1 })
    }
    return cells
  }, [selected])

  const itemsByDate = useMemo(() => {
    const map = new Map<string, ItemRow[]>()
    for (const it of items) {
      if (!it.scheduled_date) continue // undated → Idea Board lane
      const day = map.get(it.scheduled_date)
      if (day) day.push(it)
      else map.set(it.scheduled_date, [it])
    }
    return map
  }, [items])

  /** Undated ideas — the brainstorming backlog. */
  const ideaBacklog = useMemo(() => items.filter(i => !i.scheduled_date), [items])

  // Range items (start → end) render a full chip on the start day and a slim
  // continuation bar on every later covered day, so a campaign's span is visible.
  const continuationsByDate = useMemo(() => {
    const map = new Map<string, ItemRow[]>()
    for (const it of items) {
      const start = it.scheduled_date, end = it.scheduled_end_date
      if (!start || !end || end <= start) continue
      const d = new Date(start + 'T00:00:00Z')
      d.setUTCDate(d.getUTCDate() + 1)
      // Bounded: a mistyped end year ("2926") would otherwise walk ~a million
      // days, allocating two ISO strings each, and lock up the tab.
      for (let n = 0; n < MAX_RANGE_DAYS && ymdUTC(d) <= end; n++, d.setUTCDate(d.getUTCDate() + 1)) {
        const key = ymdUTC(d)
        const arr = map.get(key); if (arr) arr.push(it); else map.set(key, [it])
      }
    }
    return map
  }, [items])

  const progressCounts = useMemo(() => {
    const counts: Record<ItemProgress, number> = {
      planned: 0, requested: 0, in_progress: 0, delivered: 0, done: 0, cancelled: 0,
    }
    for (const it of items) counts[resolveItemProgress(it.status, it.request)]++
    return counts
  }, [items])

  const unpushed = items.filter(i => i.status === 'planned' && !i.request_id)

  // ── Actions ────────────────────────────────────────────────────────────────

  async function submitNewPlan() {
    setSavingPlan(true)
    const res = await createSocialCalendar({
      clientId: planForm.clientId, month: planForm.month,
      title: planForm.title || null, notes: planForm.notes || null,
    })
    setSavingPlan(false)
    if (!res.ok || !res.data) { toast.toastError('Could not create the plan', res.error); return }
    setShowNewPlan(false)
    setPlanForm({ clientId: '', month: new Date().toISOString().slice(0, 7), title: '', notes: '' })
    toast.success('Plan created')
    router.push(`/dashboard/social-calendar?calendar=${res.data.id}`)
    router.refresh()
  }

  async function submitItem() {
    if (!selected || !itemModal) return
    setSavingItem(true)
    const res = itemModal.mode === 'add'
      ? await addCalendarItem(selected.id, itemForm)
      : await updateCalendarItem(itemModal.itemId!, itemForm)
    setSavingItem(false)
    if (!res.ok) { toast.toastError('Could not save the item', res.error); return }
    setItemModal(null)
    // A pending migration can silently drop columns — say so rather than
    // showing a plain success while the planner's board went nowhere.
    if (res.warning) toast.toastError('Saved with missing data', res.warning)
    else toast.success(itemModal.mode === 'add' ? 'Item planned' : 'Item updated')
    router.refresh()
  }

  async function removeItem(itemId: string) {
    setBusy(`delete:${itemId}`)
    const res = await deleteCalendarItem(itemId)
    setBusy(null)
    if (!res.ok) { toast.toastError('Could not remove the item', res.error); return }
    setItemModal(null)
    toast.success('Item removed')
    router.refresh()
  }

  async function push(itemIds: string[]) {
    if (!selected || itemIds.length === 0) return
    setBusy(itemIds.length === 1 ? `push:${itemIds[0]}` : 'push-all')
    const res = await pushItemsToRequests(selected.id, itemIds)
    setBusy(null)
    if (!res.ok || !res.data) { toast.toastError('Could not send to Requests', res.error); return }
    const { pushed, failed } = res.data
    if (failed > 0) toast.toastError(`${pushed} sent, ${failed} failed`, 'Check the Requests inbox and retry the rest.')
    else toast.success(`${pushed} item${pushed === 1 ? '' : 's'} sent to Requests`, 'They now appear in the Requests inbox as planned work.')
    setItemModal(null)
    router.refresh()
  }

  async function replanItem(itemId: string) {
    setBusy(`replan:${itemId}`)
    const res = await revertItemToPlanned(itemId)
    setBusy(null)
    if (!res.ok) { toast.toastError('Could not re-plan the item', res.error); return }
    setItemModal(null)
    toast.success('Item back to planned', 'You can edit it and send it to Requests again.')
    router.refresh()
  }

  async function archivePlan() {
    if (!selected) return
    setBusy('archive')
    const res = await updateSocialCalendar(selected.id, { status: selected.status === 'archived' ? 'active' : 'archived' })
    setBusy(null)
    if (!res.ok) { toast.toastError('Could not update the plan', res.error); return }
    toast.success(selected.status === 'archived' ? 'Plan restored' : 'Plan archived')
    router.refresh()
  }

  async function removePlan() {
    if (!selected) return
    setBusy('delete-plan')
    const res = await deleteSocialCalendar(selected.id)
    setBusy(null)
    if (!res.ok) { toast.toastError('Could not delete the plan', res.error); return }
    toast.success('Plan deleted')
    router.push('/dashboard/social-calendar')
    router.refresh()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!migrated) {
    return (
      <div className="space-y-6">
        <Header title="Social Calendar" subtitle="Plan client content and feed it into the Requests pipeline" />
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          The social calendar needs a database migration. Apply <code>supabase/migrations/20260716120000_social_calendar.sql</code> to enable this module.
        </div>
      </div>
    )
  }

  // Idea Board panel — defined here (a plain JSX value, not a component, so it
  // keeps its identity across renders) and rendered AFTER the month grid, which
  // puts it on the RIGHT. The app's primary navigation already owns the left
  // edge; a second left panel competed with it and pushed the calendar off-centre.
  const ideaBoardPanel = boardCollapsed ? (
    // Stretches to the calendar's full height rather than floating as a short
    // box with dead space beside it — and a tall rail is a far easier drop
    // target when dragging an idea back out of the month.
    <DroppableZone
      id="idea-board"
      className="shrink-0 bg-card border border-border rounded-xl transition-colors self-stretch"
      activeClassName="border-primary/50 bg-primary/5"
    >
      <button onClick={toggleBoard} title="Expand Idea Board"
        className="w-full h-full lg:w-11 flex lg:flex-col items-center lg:justify-start justify-center gap-2 py-2 lg:py-3 text-muted-foreground hover:text-foreground hover:bg-secondary/40 rounded-xl transition-colors">
        <PanelRightOpen className="w-4 h-4 shrink-0" />
        <Lightbulb className="w-4 h-4 text-amber-500 shrink-0" />
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary border border-border shrink-0">{ideaBacklog.length}</span>
        <span className="hidden lg:block text-[10px] font-semibold [writing-mode:vertical-rl] tracking-wide mt-1">Idea Board</span>
      </button>
    </DroppableZone>
  ) : (
    <DroppableZone
      id="idea-board"
      className="w-full lg:w-72 shrink-0 bg-card border border-border rounded-xl transition-colors self-start lg:sticky lg:top-4 overflow-hidden"
      activeClassName="border-primary/50 bg-primary/5"
    >
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2 bg-secondary/40">
        <Lightbulb className="w-4 h-4 text-amber-500 shrink-0" />
        <span className="text-sm font-semibold">Idea Board</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-background text-muted-foreground border border-border">{ideaBacklog.length}</span>
        <button onClick={toggleBoard} title="Collapse Idea Board"
          className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-background transition-colors">
          <PanelRightClose className="w-3.5 h-3.5" />
        </button>
      </div>
      {canManage && (
        <div className="p-2.5 border-b border-border/60 space-y-1.5">
          <input
            value={quickTitle}
            onChange={e => setQuickTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submitQuickIdea() }}
            placeholder="Type an idea, press Enter…"
            className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary/50 transition-colors"
          />
          <div className="flex items-center gap-1.5">
            <AppSelect value={quickType} onChange={e => setQuickType(e.target.value)} className="flex-1 text-xs">
              {CONTENT_TYPES.map(t => <option key={t} value={t}>{CONTENT_TYPE_LABEL[t]}</option>)}
            </AppSelect>
            <button onClick={() => void submitQuickIdea()} disabled={quickBusy || !quickTitle.trim()}
              className="p-2 rounded-lg gradient-bg text-white disabled:opacity-50">
              {quickBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      )}
      <div className="p-2.5 space-y-1.5 min-h-[64px] max-h-[calc(100vh-16rem)] overflow-y-auto">
        {ideaBacklog.length === 0 && (
          <p className="text-[11px] text-muted-foreground/60 text-center py-3">
            Brainstorm here — add ideas without a date,<br />then drag them onto a day.
          </p>
        )}
        {ideaBacklog.map(it => (
          <DraggableItem key={it.id} id={it.id} disabled={!canManage}>
            <button
              onClick={() => openEdit(it)}
              className={`w-full text-left rounded-lg border px-2 py-1.5 text-[11px] leading-tight hover:opacity-85 ${CONTENT_TYPE_CHIP[it.content_type as keyof typeof CONTENT_TYPE_CHIP] ?? CONTENT_TYPE_CHIP.other}`}
            >
              <span className="flex items-start gap-1.5">
                {itemRefs(it)[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={itemRefs(it)[0]} alt="" className="w-7 h-7 rounded object-cover shrink-0 border border-black/10" />
                )}
                <span className="min-w-0">
                  <span className="font-medium block">{it.title}</span>
                  <span className="opacity-80">{contentTypeWithVariants(it.content_type, it.variants)}</span>
                </span>
              </span>
            </button>
          </DraggableItem>
        ))}
      </div>
    </DroppableZone>
  )

  return (
    // Header is a full-bleed sticky bar with its own padding, so it sits as a
    // SIBLING of the padded content — wrapping both in one padded div would
    // inset the bar and break its edge-to-edge border. Same shape as the
    // Clients page; without the padding here the content butted straight up
    // against the nav rail.
    <>
      <Header
        title="Social Calendar"
        subtitle="Plan a month of client content, then send planned items to the Requests inbox — they ride the normal request → task pipeline from there"
      />
      <div className="p-4 md:p-6 space-y-5">

      {/* ── Toolbar: plan picker + primary actions + export group ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
        <div className="min-w-[240px] flex-1 sm:flex-none">
          <Combobox
            options={calendars.map(c => {
              const total = c.items?.length ?? 0
              const sent = c.items?.filter(i => i.request_id).length ?? 0
              return {
                id: c.id,
                label: `${c.client?.name ?? 'Client'} — ${monthLabel(c.month)}`,
                sub: `${c.title ? c.title + ' · ' : ''}${total} items · ${sent} in requests${c.status === 'archived' ? ' · archived' : ''}`,
              }
            })}
            value={selected?.id ?? ''}
            onChange={id => { if (id) { router.push(`/dashboard/social-calendar?calendar=${id}`); router.refresh() } }}
            placeholder={calendars.length ? 'Pick a plan…' : 'No plans yet'}
            sortKey="social_calendars"
          />
        </div>
        {canManage && (
          <button
            onClick={() => setShowNewPlan(true)}
            className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> New Plan
          </button>
        )}
        {canManage && services.length > 0 && (
          <button
            onClick={() => { setServiceMapDraft({ ...serviceMap }); setShowServiceDefaults(true) }}
            title="Choose which service each content type's design request carries"
            className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="w-4 h-4" />
          </button>
        )}

        {selected && (
          <div className="flex items-center gap-1.5 ml-auto flex-wrap justify-end">
            {/* Export group */}
            {items.length > 0 && (
              <div className="flex items-center rounded-lg border border-border bg-secondary overflow-hidden">
                <button onClick={() => void exportPlan('pdf')} disabled={!!exporting}
                  title="Plan PDF — the full month plan (same design as invoices)"
                  className="inline-flex items-center gap-1.5 px-2.5 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-background disabled:opacity-50">
                  {exporting === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} <span className="hidden sm:inline">Plan PDF</span>
                </button>
                <span className="w-px h-5 bg-border" />
                <button onClick={() => void exportReport()} disabled={!!exporting}
                  title={`Monthly client report — delivered/completed work only${deliveredCount ? ` (${deliveredCount})` : ''}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-background disabled:opacity-50">
                  {exporting === 'report' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} <span className="hidden sm:inline">Report</span>
                  {deliveredCount > 0 && <span className="text-[10px] px-1 rounded bg-green-500/15 text-green-600 dark:text-green-400">{deliveredCount}</span>}
                </button>
                <span className="w-px h-5 bg-border" />
                <button onClick={() => void exportPlan('excel')} disabled={!!exporting}
                  title="Download the plan as an Excel sheet"
                  className="inline-flex items-center gap-1.5 px-2.5 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-background disabled:opacity-50">
                  {exporting === 'excel' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />} <span className="hidden sm:inline">Excel</span>
                </button>
              </div>
            )}
            {canManage && (
              <>
                {unpushed.length > 0 && (
                  <button
                    onClick={() => push(unpushed.map(i => i.id))}
                    disabled={busy === 'push-all'}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-500 px-3 py-2 text-sm font-medium hover:bg-blue-500/20 disabled:opacity-50"
                  >
                    {busy === 'push-all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Send {unpushed.length} to Requests
                  </button>
                )}
                <button
                  onClick={archivePlan}
                  disabled={busy === 'archive'}
                  title={selected.status === 'archived' ? 'Restore plan' : 'Archive plan'}
                  className="rounded-lg border border-border px-2.5 py-2 text-muted-foreground hover:text-foreground hover:bg-secondary"
                >
                  <Archive className="w-4 h-4" />
                </button>
                {items.every(i => !i.request_id) && (
                  <button
                    onClick={removePlan}
                    disabled={busy === 'delete-plan'}
                    title="Delete plan (only while nothing was sent to Requests)"
                    className="rounded-lg border border-border px-2.5 py-2 text-muted-foreground hover:text-red-500 hover:bg-secondary"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {!selected ? (
        <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
          <CalendarDays className="w-8 h-8 mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            No content plans yet. {canManage ? 'Create one to start planning a client’s month.' : ''}
          </p>
        </div>
      ) : (
        <>
          {/* ── Plan header: client + month + progress chips ── */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{selected.client?.name}</span>
            <span className="text-xs text-muted-foreground">· {monthLabel(selected.month)}</span>
            {selected.title && <span className="text-xs text-muted-foreground">· {selected.title}</span>}
            {selected.status === 'archived' && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">Archived</span>
            )}
            <div className="flex flex-wrap items-center gap-1.5 ml-auto">
              {(Object.keys(progressCounts) as ItemProgress[])
                .filter(k => progressCounts[k] > 0)
                .map(k => (
                  <span key={k} className={`text-[10px] px-2 py-0.5 rounded-full border ${PROGRESS_CHIP[k]}`}>
                    {progressCounts[k]} {PROGRESS_LABEL[k]}
                  </span>
                ))}
            </div>
          </div>

          {/* ── View toggle ── */}
          <div className="flex items-center gap-1 -mt-1">
            {([['calendar', 'Calendar', CalendarDays], ['board', 'Board', LayoutGrid]] as const).map(([key, label, Icon]) => (
              <button key={key} onClick={() => setViewMode(key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  viewMode === key ? 'bg-primary/10 text-primary border-primary/30' : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}>
                <Icon className="w-3.5 h-3.5" /> {label}
              </button>
            ))}
          </div>

          {viewMode === 'calendar' ? (
          <DndContext sensors={dndSensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
          <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-start">

            {/* ── Month grid — the main focus, so it leads the row ── */}
            <div className="flex-1 w-full min-w-0 bg-card border border-border rounded-xl overflow-hidden">
              <div className="grid grid-cols-7 border-b border-border">
                {WEEKDAYS.map(d => (
                  <div key={d} className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-center">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {grid.map(cell => {
                  const dayItems = itemsByDate.get(cell.key) ?? []
                  const spans = continuationsByDate.get(cell.key) ?? []
                  return (
                    <DroppableZone
                      key={cell.key}
                      id={`day:${cell.key}`}
                      disabled={!cell.inMonth}
                      className={`min-h-[96px] border-b border-r border-border/50 align-top transition-colors ${cell.inMonth ? '' : 'bg-secondary/20 opacity-50'}`}
                      activeClassName="bg-primary/10"
                    >
                      <div
                        className={`h-full w-full p-1.5 ${canManage && cell.inMonth ? 'cursor-pointer hover:bg-secondary/30 transition-colors' : ''}`}
                        onClick={() => {
                          if (!canManage || !cell.inMonth) return
                          setItemForm({ ...EMPTY_ITEM, scheduledDate: cell.key })
                          setCopyTab('text')
                          setItemModal({ mode: 'add' })
                        }}
                      >
                        <div className="text-[10px] text-muted-foreground">{cell.date.getDate()}</div>
                        <div className="mt-1 space-y-1">
                          {dayItems.map(it => {
                            const progress = resolveItemProgress(it.status, it.request)
                            const refs = itemRefs(it)
                            const isRange = !!it.scheduled_end_date && it.scheduled_end_date > (it.scheduled_date ?? '')
                            return (
                              <DraggableItem key={it.id} id={it.id} disabled={!canManage || !!it.request?.promoted_task_id}>
                                <button
                                  onClick={e => { e.stopPropagation(); openEdit(it) }}
                                  className={`w-full text-left rounded-md border px-1.5 py-1 text-[10px] leading-tight hover:opacity-80 ${isRange ? 'border-l-[3px]' : ''} ${CONTENT_TYPE_CHIP[it.content_type as keyof typeof CONTENT_TYPE_CHIP] ?? CONTENT_TYPE_CHIP.other}`}
                                  title={`${it.title} — ${PROGRESS_LABEL[progress]}${isRange ? ` · ${formatShortDateRange(it.scheduled_date, it.scheduled_end_date)}` : ''}`}
                                >
                                  <span className="flex items-center gap-1">
                                    {refs[0] && (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img src={refs[0]} alt="" className="w-4 h-4 rounded-sm object-cover shrink-0" />
                                    )}
                                    {refs.length > 1 && <span className="text-[8px] px-1 rounded bg-black/10 shrink-0">{refs.length}</span>}
                                    <span className="font-medium block truncate">{it.title}</span>
                                  </span>
                                  <span className="flex items-center gap-1 opacity-80">
                                    {isRange
                                      ? <>{CONTENT_TYPE_LABEL[it.content_type as keyof typeof CONTENT_TYPE_LABEL] ?? it.content_type} → {formatShortDateRange(it.scheduled_date, it.scheduled_end_date).split(' – ')[1]}</>
                                      : <>{contentTypeWithVariants(it.content_type, it.variants)}{(it.platforms?.length ?? 0) > 0 && <> · {platformLabels(it.platforms, true)}</>}</>}
                                    <span className={`ml-auto inline-block w-1.5 h-1.5 rounded-full ${progress === 'planned' ? 'bg-gray-400' : progress === 'requested' ? 'bg-blue-400' : progress === 'in_progress' ? 'bg-amber-400' : progress === 'delivered' ? 'bg-purple-400' : progress === 'done' ? 'bg-green-500' : 'bg-red-400'}`} />
                                  </span>
                                </button>
                              </DraggableItem>
                            )
                          })}
                          {/* Continuation bars for multi-day items covering this day. */}
                          {spans.map(it => (
                            <button key={`span-${it.id}`} onClick={e => { e.stopPropagation(); openEdit(it) }}
                              title={`${it.title} · ${formatShortDateRange(it.scheduled_date, it.scheduled_end_date)}`}
                              className={`w-full flex items-center gap-1 rounded-sm border-l-[3px] px-1 py-0.5 text-[9px] opacity-70 hover:opacity-100 truncate ${CONTENT_TYPE_CHIP[it.content_type as keyof typeof CONTENT_TYPE_CHIP] ?? CONTENT_TYPE_CHIP.other}`}>
                              <span className="opacity-70">⟶</span>
                              <span className="truncate">{it.title}{it.scheduled_end_date === cell.key ? ' (ends)' : ''}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </DroppableZone>
                  )
                })}
              </div>
            </div>

            {/* ── Idea Board — undated brainstorm backlog, right-hand rail ── */}
            {ideaBoardPanel}
          </div>
          </DndContext>
          ) : (

          /* ── Board view — pipeline columns ── */
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 items-start">
            {([
              ['idea', 'Ideas', ideaBacklog],
              ['planned', PROGRESS_LABEL.planned, items.filter(i => i.scheduled_date && resolveItemProgress(i.status, i.request) === 'planned')],
              ['requested', PROGRESS_LABEL.requested, items.filter(i => resolveItemProgress(i.status, i.request) === 'requested')],
              ['in_progress', PROGRESS_LABEL.in_progress, items.filter(i => resolveItemProgress(i.status, i.request) === 'in_progress')],
              ['delivered', PROGRESS_LABEL.delivered, items.filter(i => resolveItemProgress(i.status, i.request) === 'delivered')],
              ['done', PROGRESS_LABEL.done, items.filter(i => resolveItemProgress(i.status, i.request) === 'done')],
            ] as const).map(([key, label, colItems]) => (
              <div key={key} className="bg-card border border-border rounded-xl">
                <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                  {key === 'idea' && <Lightbulb className="w-3.5 h-3.5 text-amber-500" />}
                  <span className="text-xs font-semibold">{label}</span>
                  <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">{colItems.length}</span>
                </div>
                <div className="p-2 space-y-1.5 min-h-[80px] max-h-[480px] overflow-y-auto">
                  {colItems.map(it => (
                    <button key={it.id} onClick={() => openEdit(it)}
                      className={`w-full text-left rounded-lg border px-2 py-1.5 text-[11px] leading-tight hover:opacity-85 ${CONTENT_TYPE_CHIP[it.content_type as keyof typeof CONTENT_TYPE_CHIP] ?? CONTENT_TYPE_CHIP.other}`}>
                      <span className="flex items-start gap-1.5">
                        {itemRefs(it)[0] && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={itemRefs(it)[0]} alt="" className="w-7 h-7 rounded object-cover shrink-0 border border-black/10" />
                        )}
                        <span className="min-w-0">
                          <span className="font-medium block">{it.title}</span>
                          <span className="opacity-80 block">{contentTypeWithVariants(it.content_type, it.variants)}</span>
                          {it.scheduled_date && <span className="opacity-60">{formatShortDateRange(it.scheduled_date, it.scheduled_end_date)}</span>}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          )}
          <p className="text-[11px] text-muted-foreground -mt-2">
            {canManage ? 'Brainstorm on the Idea Board and drag ideas onto days · drag between days to reschedule · click any card to edit or send it to Requests. ' : ''}
            Sent items appear in the <Link href="/dashboard/requests" className="text-primary hover:underline">Requests inbox</Link> with
            a “planned” chip; once started there, progress flows back here automatically.
          </p>
        </>
      )}

      {/* ── New Plan modal ── */}
      {showNewPlan && (
        <ModalOverlay onClose={() => setShowNewPlan(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="font-semibold">New Content Plan</h2>
              <button onClick={() => setShowNewPlan(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Client *</label>
                <Combobox
                  options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
                  value={planForm.clientId}
                  onChange={id => setPlanForm(p => ({ ...p, clientId: id }))}
                  placeholder="Search client…"
                  sortKey="clients"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Month *</label>
                  <input
                    type="month" value={planForm.month}
                    onChange={e => setPlanForm(p => ({ ...p, month: e.target.value }))}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Label</label>
                  <input
                    type="text" value={planForm.title}
                    onChange={e => setPlanForm(p => ({ ...p, title: e.target.value }))}
                    placeholder="e.g. Diwali push"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Notes</label>
                <textarea
                  value={planForm.notes} rows={2}
                  onChange={e => setPlanForm(p => ({ ...p, notes: e.target.value }))}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
                />
              </div>
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-border">
              <button onClick={() => setShowNewPlan(false)} className="flex-1 bg-secondary text-sm font-medium py-2 rounded-lg hover:bg-secondary/80">Cancel</button>
              <button
                onClick={submitNewPlan}
                disabled={savingPlan || !planForm.clientId || !planForm.month}
                className="flex-1 gradient-bg text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 disabled:opacity-50"
              >
                {savingPlan ? 'Creating…' : 'Create Plan'}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ── Service defaults modal (content type → service mapping) ── */}
      {showServiceDefaults && (
        <ModalOverlay onClose={() => setShowServiceDefaults(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="font-semibold">Service defaults</h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Planners only pick a content type — the service on each design request is assigned
                  automatically from this mapping. “Auto” guesses from the service names.
                </p>
              </div>
              <button onClick={() => setShowServiceDefaults(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="px-5 py-4 space-y-2.5 max-h-[60dvh] overflow-y-auto">
              {CONTENT_TYPES.map(t => (
                <div key={t} className="grid grid-cols-[7rem_1fr] items-center gap-3">
                  <span className="text-sm text-muted-foreground">{CONTENT_TYPE_LABEL[t]}</span>
                  <AppSelect
                    value={serviceMapDraft[t] ?? ''}
                    onChange={e => setServiceMapDraft(p => {
                      const next = { ...p }
                      if (e.target.value) next[t] = e.target.value
                      else delete next[t]
                      return next
                    })}
                  >
                    <option value="">Auto (match by service name)</option>
                    {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </AppSelect>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
              <button onClick={() => setShowServiceDefaults(false)} className="bg-secondary text-sm font-medium px-4 py-2 rounded-lg hover:bg-secondary/80">Cancel</button>
              <button
                onClick={submitServiceMap}
                disabled={savingServiceMap}
                className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {savingServiceMap && <Loader2 className="w-4 h-4 animate-spin" />}
                Save defaults
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ── Item modal (add / edit) ── */}
      {itemModal && selected && (
        <ModalOverlay onClose={() => setItemModal(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="font-semibold">{itemModal.mode === 'add' ? 'Plan an item' : 'Edit item'}</h2>
                {editingItem?.request && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono">{refLabel(editingItem.request.ref_no ?? 0)}</span>
                    {editingProgress && (
                      <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${PROGRESS_CHIP[editingProgress]}`}>
                        {PROGRESS_LABEL[editingProgress]}
                      </span>
                    )}
                    {editingItem.request.promoted_task?.task_number != null && (
                      <span className="font-mono text-green-500">Task #{editingItem.request.promoted_task.task_number}</span>
                    )}
                    <Link href={`/dashboard/requests?focus=${editingItem.request.id}`} className="text-primary hover:underline inline-flex items-center gap-0.5">
                      open in Requests <ExternalLink className="w-3 h-3" />
                    </Link>
                  </p>
                )}
              </div>
              <button onClick={() => setItemModal(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>

            <div className="px-5 py-4 space-y-3 max-h-[65dvh] overflow-y-auto">
              {editingFrozen && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  This item is already a task — the plan entry is frozen. Manage it from the Tasks page.
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Title *</label>
                <input
                  type="text" value={itemForm.title} disabled={editingFrozen}
                  onChange={e => setItemForm(p => ({ ...p, title: e.target.value }))}
                  placeholder="e.g. Diwali teaser reel"
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none disabled:opacity-60"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                    {itemForm.scheduledEndDate ? 'Start date' : 'Date'} <span className="text-muted-foreground/60">(blank = Idea Board)</span>
                  </label>
                  <input
                    type="date" value={itemForm.scheduledDate ?? ''} disabled={editingFrozen}
                    onChange={e => setItemForm(p => ({ ...p, scheduledDate: e.target.value }))}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Content type *</label>
                  <AppSelect
                    value={itemForm.contentType} disabled={editingFrozen}
                    onChange={e => {
                      const contentType = e.target.value
                      setItemForm(p => ({
                        ...p,
                        contentType,
                        // The new main type can't also be a variant of itself.
                        variants: (p.variants ?? []).filter(v => v !== contentType),
                      }))
                    }}
                  >
                    {CONTENT_TYPES.map(t => <option key={t} value={t}>{CONTENT_TYPE_LABEL[t]}</option>)}
                  </AppSelect>
                </div>
              </div>
              {/* Multi-day run (campaigns, SEO sprints, email series). */}
              {itemForm.scheduledEndDate ? (
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                      <CalendarRange className="inline w-3.5 h-3.5 mr-1 -mt-0.5" /> End date <span className="text-muted-foreground/60">(runs over a period)</span>
                    </label>
                    <input
                      type="date" value={itemForm.scheduledEndDate ?? ''} min={itemForm.scheduledDate || undefined} disabled={editingFrozen}
                      onChange={e => setItemForm(p => ({ ...p, scheduledEndDate: e.target.value }))}
                      className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none disabled:opacity-60"
                    />
                  </div>
                  {!editingFrozen && (
                    <button type="button" onClick={() => setItemForm(p => ({ ...p, scheduledEndDate: '' }))}
                      className="mb-0.5 p-2 rounded-lg text-muted-foreground hover:text-red-500 border border-border" title="Single day">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ) : (!editingFrozen && itemForm.scheduledDate && (
                <button type="button"
                  onClick={() => setItemForm(p => ({ ...p, scheduledEndDate: p.scheduledDate }))}
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
                  <CalendarRange className="w-3.5 h-3.5" /> Runs over a period (add end date)
                </button>
              ))}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Also as <span className="text-muted-foreground/60">(size/format variants of the same creative — e.g. a post that also goes out as a story)</span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {VARIANT_TYPES.filter(t => t !== itemForm.contentType).map(t => {
                    const on = (itemForm.variants ?? []).includes(t)
                    return (
                      <button
                        key={t} type="button" disabled={editingFrozen}
                        onClick={() => setItemForm(f => ({
                          ...f,
                          variants: on ? (f.variants ?? []).filter(x => x !== t) : [...(f.variants ?? []), t],
                        }))}
                        className={`px-2.5 py-1 rounded-full text-xs border transition-colors disabled:opacity-60 ${on
                          ? 'bg-primary/15 text-primary border-primary/30 font-medium'
                          : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}
                      >
                        + {CONTENT_TYPE_LABEL[t]}
                      </button>
                    )
                  })}
                </div>
              </div>
              {/* No Service field here on purpose: the server assigns it
                  automatically from the content type (Service defaults gear). */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Platforms</label>
                <div className="flex flex-wrap gap-1.5">
                  {PLATFORMS.map(p => {
                    const on = itemForm.platforms.includes(p)
                    return (
                      <button
                        key={p} type="button" disabled={editingFrozen}
                        onClick={() => setItemForm(f => ({
                          ...f,
                          platforms: on ? f.platforms.filter(x => x !== p) : [...f.platforms, p],
                        }))}
                        className={`px-2.5 py-1 rounded-full text-xs border transition-colors disabled:opacity-60 ${on
                          ? 'bg-primary/15 text-primary border-primary/30 font-medium'
                          : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}
                      >
                        {PLATFORM_LABEL[p]}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="block text-xs font-medium text-muted-foreground">Caption / copy</label>
                  <div className="flex items-center gap-1 ml-auto">
                    {([['text', 'Text'], ['canvas', 'Canvas']] as const).map(([key, label]) => (
                      <button key={key} type="button" onClick={() => setCopyTab(key)}
                        className={`px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors ${
                          copyTab === key
                            ? 'bg-primary/10 text-primary border-primary/30'
                            : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}>
                        {label}
                        {key === 'canvas' && canvasBlockCount > 0 && (
                          <span className="ml-1 text-[9px] opacity-70">{canvasBlockCount}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
                {copyTab === 'text' ? (
                  <RichTextEditor
                    value={itemForm.caption ?? ''}
                    onChange={caption => setItemForm(p => ({ ...p, caption }))}
                    disabled={editingFrozen}
                    placeholder="Draft caption for the designer…"
                    onPasteImage={f => void uploadReference(f)}
                  />
                ) : (
                  <CaptionCanvasEditor
                    value={(itemForm.captionCanvas as CaptionCanvas | null) ?? null}
                    onChange={c => setItemForm(p => ({ ...p, captionCanvas: c }))}
                    disabled={editingFrozen}
                    onUploadImage={uploadImageForCanvas}
                  />
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Reference images <span className="text-muted-foreground/60">(mood board — what the creative should look like)</span>
                </label>
                {(itemForm.referenceUrls?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {(itemForm.referenceUrls ?? []).map((url, i) => (
                      <div key={`${url}-${i}`} className="relative group">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="" className="w-16 h-16 rounded-lg object-cover border border-border" />
                        {!editingFrozen && (
                          <button type="button" onClick={() => removeReference(i)}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-card border border-border text-muted-foreground hover:text-red-500 flex items-center justify-center shadow opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Remove">
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {!editingFrozen && (itemForm.referenceUrls?.length ?? 0) < 8 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <label className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-xs text-muted-foreground hover:text-foreground cursor-pointer ${refUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                      {refUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Upload
                      <input type="file" accept="image/*" className="hidden" disabled={refUploading}
                        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadReference(f) }} />
                    </label>
                    <button type="button" onClick={() => void pasteReference()} disabled={refUploading}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                      title="Paste a copied image / screenshot">
                      <Clipboard className="w-3.5 h-3.5" /> Paste
                    </button>
                    <div className="relative flex-1 min-w-[160px]">
                      <Link2 className="w-3.5 h-3.5 text-muted-foreground/50 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="url" value={refLink}
                        onChange={e => setRefLink(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addReference(refLink); setRefLink('') } }}
                        placeholder="…or paste an image link + Enter"
                        className="w-full bg-secondary border border-border rounded-lg pl-8 pr-3 py-2 text-xs focus:outline-none"
                      />
                    </div>
                    {refLink.trim() && (
                      <button type="button" onClick={() => { addReference(refLink); setRefLink('') }}
                        className="px-2.5 py-2 rounded-lg gradient-bg text-white text-xs">Add</button>
                    )}
                  </div>
                )}
                {(itemForm.referenceUrls?.length ?? 0) === 0 && editingFrozen && (
                  <p className="text-[11px] text-muted-foreground/60">No reference images.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Internal notes</label>
                <textarea
                  value={itemForm.notes ?? ''} rows={2} disabled={editingFrozen}
                  onChange={e => setItemForm(p => ({ ...p, notes: e.target.value }))}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none disabled:opacity-60"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2 px-5 py-4 border-t border-border">
              {itemModal.mode === 'edit' && !editingFrozen && (
                <button
                  onClick={() => removeItem(itemModal.itemId!)}
                  disabled={busy === `delete:${itemModal.itemId}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-red-500 disabled:opacity-50"
                >
                  {busy === `delete:${itemModal.itemId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Remove
                </button>
              )}
              {itemModal.mode === 'edit' && editingItem && !editingItem.request_id && editingItem.status === 'planned' && (
                <button
                  onClick={() => push([itemModal.itemId!])}
                  disabled={busy === `push:${itemModal.itemId}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-500 px-3 py-2 text-sm font-medium hover:bg-blue-500/20 disabled:opacity-50"
                >
                  {busy === `push:${itemModal.itemId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Send to Requests
                </button>
              )}
              {/* Escape hatch: the inbox closed this item's request, so without
                  a way back to 'planned' the item is a dead end (push skips
                  anything already linked). */}
              {itemModal.mode === 'edit' && editingItem && !editingFrozen && requestIsClosed && (
                <button
                  onClick={() => replanItem(itemModal.itemId!)}
                  disabled={busy === `replan:${itemModal.itemId}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
                  title="Its request was closed in the inbox — unlink and plan it again"
                >
                  {busy === `replan:${itemModal.itemId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  Re-plan
                </button>
              )}
              <div className="flex-1" />
              <button onClick={() => setItemModal(null)} className="bg-secondary text-sm font-medium px-4 py-2 rounded-lg hover:bg-secondary/80">Close</button>
              {!editingFrozen && (
                <button
                  onClick={submitItem}
                  disabled={savingItem || !itemForm.title.trim()}
                  className="gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-50"
                >
                  {savingItem ? 'Saving…' : itemModal.mode === 'add' ? 'Plan Item' : 'Save Changes'}
                </button>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
      </div>
    </>
  )
}
