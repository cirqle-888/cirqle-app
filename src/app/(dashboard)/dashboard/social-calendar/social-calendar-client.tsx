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
import { planPackageCalendar, cadenceLabel, suggestPlacements } from '@/lib/packages/calendar-coverage'
import type { PackageRow, PackageItemRow, PackageTaskLike } from '@/lib/packages/types'
import CaptionCanvasEditor from './caption-canvas'
import { DiscussButton } from '@/components/chat/discuss-button'
import {
  DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable,
  pointerWithin, type DragEndEvent,
} from '@dnd-kit/core'
import {
  CONTENT_TYPES, CONTENT_TYPE_LABEL, CONTENT_TYPE_CHIP, VARIANT_TYPES,
  PLATFORMS, PLATFORM_LABEL, platformLabels, contentTypeWithVariants,
  PROGRESS_LABEL, PROGRESS_CHIP, resolveItemProgress, isClosedRequestStatus,
  isUnrouted, canPullBack,
  formatShortDateRange, suggestServiceId, type CaptionCanvas,
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
  CalendarDays, Loader2, Plus, Send, Trash2, Archive, ExternalLink, RotateCcw, X, ListChecks,
  Package as PackageIcon, CheckCircle2, AlertTriangle,
  Settings2, FileDown, FileSpreadsheet, FileText, Lightbulb, Upload, LayoutGrid,
  Link2, Clipboard, PanelRightClose, PanelRightOpen,
  Bold, Italic, Underline, Strikethrough, List, ListOrdered, Heading2, Quote,
  Link as LinkIcon, Highlighter, Palette, Smile, Eraser,
  AlignLeft, AlignCenter, AlignRight, CalendarRange, ChevronDown,
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
  assigned_employee_id?: string | null
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
  /** Direct exit — a task created straight from the item, no request between.
   *  Both undefined pre-migration (20260825120000). */
  task_id?: string | null
  task?: { id: string; task_number: number | null; status: string; deleted_at: string | null } | null
}

interface Props {
  migrated: boolean
  calendars: CalendarRow[]
  selectedId: string | null
  initialItems: ItemRow[]
  /** Packages this client has committed to, with their included lines. */
  packages?: (PackageRow & { items: PackageItemRow[] })[]
  /** Tasks already linked to those packages — what has actually been delivered. */
  packageTasks?: (PackageTaskLike & { package_id: string })[]
  clients: { id: string; name: string; code: string }[]
  services?: { id: string; name: string }[]
  /** Variant tags used across every plan — autocomplete for the "Also as" field. */
  knownVariants?: string[]
  /** Active employees for the designer picker. CQID ONLY — employee names are
   *  private and are deliberately never sent to the browser. */
  employees?: { id: string; cqid: string }[]
  /** employeeId → department ids, derived from the service-scope tables. */
  employeeDepartments?: Record<string, string[]>
  /** employeeId → effective service ids (direct ∪ category-expanded). Scopes the
   *  designer picker to the people who actually work the item's service. */
  employeeServices?: Record<string, string[]>
  /** Active departments in display order — the picker's group headers. */
  departments?: { id: string; name: string }[]
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
function EditorTool({ icon, title, on, disabled, className = '' }: {
  icon: React.ReactNode; title: string; on: () => void; disabled?: boolean; className?: string
}) {
  return (
    <button type="button" tabIndex={-1} disabled={disabled} title={title}
      onMouseDown={e => { e.preventDefault(); on() }}
      className={`w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-background transition-colors disabled:opacity-50 ${className}`}>
      {icon}
    </button>
  )
}

function EditorGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center p-0.5 bg-background/50 border border-border/40 rounded-md shadow-sm gap-0.5">
      {children}
    </div>
  )
}

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
    <div className={`rounded-xl border border-border/80 bg-background overflow-visible shadow-sm focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 transition-all ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-border/40 bg-secondary/30 relative rounded-t-xl">
        
        {/* Typography */}
        <EditorGroup>
          <EditorTool disabled={disabled} icon={<Bold className="w-3.5 h-3.5" />} title="Bold (⌘B)" on={() => run('bold')} />
          <EditorTool disabled={disabled} icon={<Italic className="w-3.5 h-3.5" />} title="Italic (⌘I)" on={() => run('italic')} />
          <EditorTool disabled={disabled} icon={<Underline className="w-3.5 h-3.5" />} title="Underline (⌘U)" on={() => run('underline')} />
          <EditorTool disabled={disabled} icon={<Strikethrough className="w-3.5 h-3.5" />} title="Strikethrough" on={() => run('strikeThrough')} />
        </EditorGroup>
        
        {/* Structure */}
        <EditorGroup>
          <EditorTool disabled={disabled} icon={<Heading2 className="w-3.5 h-3.5" />} title="Heading" on={() => run('formatBlock', '<h3>')} />
          <EditorTool disabled={disabled} icon={<Quote className="w-3.5 h-3.5" />} title="Quote" on={() => run('formatBlock', '<blockquote>')} />
          <EditorTool disabled={disabled} icon={<List className="w-3.5 h-3.5" />} title="Bullet list" on={() => run('insertUnorderedList')} />
          <EditorTool disabled={disabled} icon={<ListOrdered className="w-3.5 h-3.5" />} title="Numbered list" on={() => run('insertOrderedList')} />
        </EditorGroup>
        
        {/* Alignment */}
        <EditorGroup>
          <EditorTool disabled={disabled} icon={<AlignLeft className="w-3.5 h-3.5" />} title="Align left" on={() => run('justifyLeft', undefined, true)} />
          <EditorTool disabled={disabled} icon={<AlignCenter className="w-3.5 h-3.5" />} title="Align center" on={() => run('justifyCenter', undefined, true)} />
          <EditorTool disabled={disabled} icon={<AlignRight className="w-3.5 h-3.5" />} title="Align right" on={() => run('justifyRight', undefined, true)} />
        </EditorGroup>

        <div className="flex-1" />

        {/* Inserts & Decorators */}
        <EditorGroup>
          <div className="relative">
            <EditorTool disabled={disabled} icon={<Palette className="w-3.5 h-3.5 text-blue-500" />} title="Text colour" on={() => setOpenMenu(m => m === 'color' ? null : 'color')} />
            {openMenu === 'color' && (
              <div className="absolute top-9 left-1/2 -translate-x-1/2 z-50 flex gap-1 p-1.5 rounded-lg border border-border bg-card shadow-xl animate-in fade-in zoom-in-95 duration-100">
                {CAPTION_COLORS.map(c => (
                  <button key={c} type="button" title={c} onMouseDown={e => { e.preventDefault(); run('foreColor', c, true) }}
                    className="w-5 h-5 rounded-full border border-black/10 hover:scale-110 transition-transform" style={{ backgroundColor: c }} />
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <EditorTool disabled={disabled} icon={<Highlighter className="w-3.5 h-3.5 text-amber-500" />} title="Highlight" on={() => setOpenMenu(m => m === 'highlight' ? null : 'highlight')} />
            {openMenu === 'highlight' && (
              <div className="absolute top-9 left-1/2 -translate-x-1/2 z-50 flex gap-1 p-1.5 rounded-lg border border-border bg-card shadow-xl animate-in fade-in zoom-in-95 duration-100">
                {CAPTION_HIGHLIGHTS.map(c => (
                  <button key={c} type="button" title={c} onMouseDown={e => { e.preventDefault(); run('hiliteColor', c, true) }}
                    className="w-5 h-5 rounded border border-black/10 hover:scale-110 transition-transform" style={{ backgroundColor: c }} />
                ))}
                <button type="button" title="No highlight" onMouseDown={e => { e.preventDefault(); run('hiliteColor', 'transparent', true) }}
                  className="w-5 h-5 rounded border border-border flex items-center justify-center text-muted-foreground hover:bg-secondary"><X className="w-3 h-3" /></button>
              </div>
            )}
          </div>
          <div className="relative">
            <EditorTool disabled={disabled} icon={<Smile className="w-3.5 h-3.5 text-emerald-500" />} title="Emoji" on={() => setOpenMenu(m => m === 'emoji' ? null : 'emoji')} />
            {openMenu === 'emoji' && (
              <div className="absolute top-9 left-1/2 -translate-x-1/2 z-50 grid grid-cols-7 gap-0.5 p-1.5 rounded-lg border border-border bg-card shadow-xl w-56 animate-in fade-in zoom-in-95 duration-100">
                {CAPTION_EMOJI.map(e => (
                  <button key={e} type="button" onMouseDown={ev => { ev.preventDefault(); insert(e) }}
                    className="w-7 h-7 flex justify-center items-center rounded hover:bg-secondary text-base hover:scale-110 transition-transform">{e}</button>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <EditorTool disabled={disabled} icon={<LinkIcon className="w-3.5 h-3.5" />} title="Insert link" on={openLinkMenu} />
            {openMenu === 'link' && (
              <div className="absolute top-9 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 p-1.5 rounded-lg border border-border bg-card shadow-xl animate-in fade-in zoom-in-95 duration-100">
                <input
                  autoFocus
                  value={linkUrl}
                  onChange={e => setLinkUrl(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); applyLink() }
                    if (e.key === 'Escape') { e.preventDefault(); setOpenMenu(null) }
                  }}
                  placeholder="https://…"
                  className="w-56 bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50"
                />
                <button type="button" onMouseDown={e => { e.preventDefault(); applyLink() }}
                  disabled={!/^(https?:|mailto:)/i.test(linkUrl.trim())}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-colors">
                  Add
                </button>
              </div>
            )}
          </div>
        </EditorGroup>
        
        {/* Clear */}
        <EditorGroup>
          <EditorTool disabled={disabled} icon={<Eraser className="w-3.5 h-3.5 text-red-400" />} title="Clear formatting" className="hover:text-red-500 hover:bg-red-500/10" on={() => run('removeFormat')} />
        </EditorGroup>
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
          className="min-h-[240px] max-h-[50dvh] overflow-y-auto px-3 py-2 text-sm focus:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:text-base [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-bold [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:underline"
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

/** "2026-08-31" → "31 Aug". A package cycle can span months, so name the month. */
const fmtDay = (date: string) => {
  const [, m, d] = String(date ?? '').split('-').map(Number)
  if (!m || !d) return '—'
  return `${d} ${MONTH_NAMES[m - 1]}`
}

// serviceId deliberately absent: the server auto-assigns it from the content type.
const EMPTY_ITEM: ItemInput = {
  scheduledDate: '', scheduledEndDate: '', title: '', contentType: 'post', platforms: [], caption: '', notes: '', variants: [], referenceUrls: [], captionCanvas: null, assignedEmployeeId: null,
}

/** Effective reference list (array supersedes the legacy single field). */
const itemRefs = (it: { reference_urls?: string[] | null; reference_url?: string | null }): string[] =>
  it.reference_urls?.length ? it.reference_urls : (it.reference_url ? [it.reference_url] : [])

// ── Drag & drop building blocks ──────────────────────────────────────────────
// Item chips and idea cards are draggable; day cells and the Idea Board are
// droppable. The pointer sensor needs 6px of travel before a drag starts, so
// plain clicks still open the edit modal.

/** One folded row in the item modal. Collapsed it still reports what it
 *  holds (the summary), so folding never hides data — it only hides empty
 *  fields. Top-level on purpose: defined inside the client component it would
 *  remount (and drop focus from) its inputs on every keystroke. */
function OptionalSection({ label, hint, summary, open, onToggle, children }: {
  label: string
  /** Long-form explanation — lives in the hover tooltip, not the row. */
  hint?: string
  /** Compact description of current content; null/'' = section is empty. */
  summary?: React.ReactNode
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <button
        type="button" onClick={onToggle} aria-expanded={open} title={hint}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors max-w-full"
      >
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        {label}
        {summary
          ? <span className="text-primary font-semibold truncate">· {summary}</span>
          : <span className="text-muted-foreground/60 font-normal">(optional)</span>}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  )
}

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
  knownVariants = [], employees = [], packages = [], packageTasks = [],
  employeeDepartments = {}, employeeServices = {}, departments = [],
}: Props) {
  const router = useRouter()
  const toast = useToast()

  const selected = calendars.find(c => c.id === selectedId) ?? null
  const items = initialItems

  // ── What the client's packages still need from this plan ──────────────────
  //
  // Derived from the live item list, so dragging a post into the month updates
  // "still to plan" immediately rather than after a refresh.
  const packageProgress = useMemo(() => {
    if (!selected?.month || packages.length === 0) return []
    const itemsByPackage = new Map<string, PackageItemRow[]>()
    for (const p of packages) itemsByPackage.set(p.id, p.items ?? [])

    const tasksByPackage = new Map<string, PackageTaskLike[]>()
    for (const t of packageTasks) {
      const arr = tasksByPackage.get(t.package_id)
      if (arr) arr.push(t)
      else tasksByPackage.set(t.package_id, [t])
    }

    return planPackageCalendar({
      packages,
      itemsByPackage,
      tasksByPackage,
      month: String(selected.month).slice(0, 7),
      calendarItems: items.map(it => ({
        id: it.id,
        service_id: (it as { service_id?: string | null }).service_id ?? null,
        scheduled_date: it.scheduled_date,
        // An item that already became a linked task is delivered, not planned.
        promotedTaskId: it.request?.promoted_task?.id ?? null,
      })),
      today: new Date().toISOString().slice(0, 10),
    })
  }, [selected?.month, packages, packageTasks, items])

  // Placement hints, on by default and dismissible.
  //
  // Initialised to `true` rather than read from localStorage, so the server and
  // the first client render agree; the stored preference is applied in an effect
  // straight after. Reading storage in the initialiser would hydrate a different
  // tree than the server sent.
  const serviceNameById = (id: string) => services.find(s => s.id === id)?.name ?? 'Deliverable'

  const [showHints, setShowHints] = useState(true)
  useEffect(() => {
    try { if (localStorage.getItem('social:planHints') === '0') setShowHints(false) } catch { /* no storage */ }
  }, [])
  const toggleHints = (next: boolean) => {
    setShowHints(next)
    try { localStorage.setItem('social:planHints', next ? '1' : '0') } catch { /* no storage */ }
  }

  // ── New-plan modal ──────────────────────────────────────────────────────────
  const [showNewPlan, setShowNewPlan] = useState(false)
  const [planForm, setPlanForm] = useState({
    clientId: '', month: new Date().toISOString().slice(0, 7), title: '', notes: '',
  })
  const [savingPlan, setSavingPlan] = useState(false)

  // ── Item modal (add or edit) ────────────────────────────────────────────────
  const [itemModal, setItemModal] = useState<{ mode: 'add' | 'edit'; itemId?: string } | null>(null)
  const [itemForm, setItemForm] = useState<ItemInput>(EMPTY_ITEM)
  // Optional metadata (Also as, Designer, Platforms, references, notes) folds
  // away instead of costing a permanent row each — the essentials stay: title,
  // date, type, caption. null = follow the item (auto-open when it already
  // holds data, so editing never hides anything); once the user toggles a
  // section, that choice sticks for the session.
  const [openSec, setOpenSec] = useState<Record<string, boolean | null>>({})
  const secOpen = (key: string, hasData: boolean) => openSec[key] ?? hasData
  const toggleSec = (key: string, hasData: boolean) =>
    setOpenSec(s => ({ ...s, [key]: !secOpen(key, hasData) }))
  // "Also as" free-text tag draft (Enter commits).
  const [variantDraft, setVariantDraft] = useState('')
  const [savingItem, setSavingItem] = useState(false)
  // Escape hatch for the designer picker's service scoping (below): off by
  // default so the list stays short, but one click away so a planner is never
  // blocked by a half-configured service assignment.
  const [showAllDesigners, setShowAllDesigners] = useState(false)
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
        status: PROGRESS_LABEL[resolveItemProgress(it.status, it.request, it.task)],
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
    const p = resolveItemProgress(it.status, it.request, it.task)
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
    setShowAllDesigners(false)
    setItemForm({
      scheduledDate: it.scheduled_date ?? '', scheduledEndDate: it.scheduled_end_date ?? '',
      title: it.title, contentType: it.content_type, platforms: it.platforms ?? [],
      assignedEmployeeId: it.assigned_employee_id ?? null,
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
    ? resolveItemProgress(editingItem.status, editingItem.request, editingItem.task)
    : null
  // Frozen = a task owns the schedule. Both exits qualify: promoted through
  // the inbox, or linked directly. A soft-deleted direct task does not freeze
  // anything — the item is editable again.
  const editingFrozen = !!editingItem?.request?.promoted_task_id
    || !!(editingItem?.task && !editingItem.task.deleted_at)
  const requestIsClosed = isClosedRequestStatus(editingItem?.request?.status)
  // Can the item still be sent anywhere? (nothing live attached to it)
  const editingUnrouted = !!editingItem && isUnrouted(editingItem)
  // Can it be pulled back to 'planned' in one click from here?
  const editingPullable = !!editingItem && canPullBack(editingItem)

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

  /** Local-midnight key for today — the same ymd() the grid cells use. */
  const todayKey = ymd(new Date())

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

  /**
   * Quiet placement hints — where the still-unplanned deliverables could go.
   *
   * A suggestion only. Nothing is written until the owner clicks one and types
   * a title; auto-filling the month would count as "planned" and erase the very
   * shortfall this is meant to surface.
   */
  const hintsByDate = useMemo(() => {
    const out = new Map<string, { date: string; serviceId: string; count: number; catchUp: boolean }>()
    if (!showHints || !canManage || packageProgress.length === 0) return out

    const today = ymd(new Date())
    for (const pp of packageProgress) {
      // The services this package covers, so a day busy with unrelated work
      // still reads as free for this one.
      const covered = new Set(pp.perService.map(s => s.serviceId))
      const days = grid.map(cell => {
        const dayItems = itemsByDate.get(cell.key) ?? []
        return {
          key: cell.key,
          inMonth: cell.inMonth,
          load: dayItems.length + (continuationsByDate.get(cell.key)?.length ?? 0),
          pkgLoad: dayItems.filter(i => {
            const sid = (i as { service_id?: string | null }).service_id
            return sid ? covered.has(sid) : false
          }).length,
        }
      })

      for (const p of suggestPlacements(pp, days, today)) {
        const found = out.get(p.date)
        // Several slots on one day collapse into a single row with a count, so
        // a hint never changes a cell's height no matter how far behind we are.
        if (found) { found.count += 1; found.catchUp = found.catchUp || p.catchUp }
        else out.set(p.date, { date: p.date, serviceId: p.serviceId, count: 1, catchUp: p.catchUp })
      }
    }
    return out
  }, [showHints, canManage, packageProgress, grid, itemsByDate, continuationsByDate])

  /**
   * Name the service on a hint only when it is actually ambiguous.
   *
   * With one kind of deliverable outstanding, "+ Social Media…" truncated into
   * eleven cells is repetition, not information — and repetition is exactly
   * what makes a gentle nudge start to nag. A bare "+" reads as an empty slot.
   */
  const hintServicesAmbiguous = useMemo(
    () => new Set([...hintsByDate.values()].map(h => h.serviceId)).size > 1,
    [hintsByDate],
  )

  const progressCounts = useMemo(() => {
    const counts: Record<ItemProgress, number> = {
      planned: 0, requested: 0, in_progress: 0, delivered: 0, done: 0, cancelled: 0,
    }
    for (const it of items) counts[resolveItemProgress(it.status, it.request, it.task)]++
    return counts
  }, [items])

  // Items that have taken neither exit — the bulk "Send" buttons act on these.
  const unpushed = items.filter(isUnrouted)

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

  /**
   * The direct exit. Nothing is created here — this hands off to the Tasks
   * page's Add Task form (prefilled), which is where task creation actually
   * lives: pricing, quantity, package and derived-billing logic all run there
   * and must not be duplicated. The item is claimed only once that form saves.
   */
  function sendToTask(itemId: string) {
    router.push(`/dashboard/tasks?fromSocialItem=${itemId}`)
  }

  async function replanItem(itemId: string) {
    const item = items.find(i => i.id === itemId)
    // Cancelling a live request is visible to the client (the portal timeline
    // gets a Cancelled entry), so it is worth one confirmation. Unlinking a
    // task or a request that is already closed is invisible — no prompt.
    const willCancelRequest = !!item?.request_id
      && !isClosedRequestStatus(item.request?.status)
      && !item.request?.promoted_task_id
    if (willCancelRequest) {
      const ref = item?.request?.ref_no ? `REQ-${String(item.request.ref_no).padStart(4, '0')}` : 'its request'
      if (!confirm(`Pull "${item?.title ?? 'this item'}" back to planned?\n\n${ref} will be cancelled in the inbox and the client will see it as Cancelled on their portal. The item returns to the calendar so you can edit and send it again.`)) return
    }
    setBusy(`replan:${itemId}`)
    const res = await revertItemToPlanned(itemId)
    setBusy(null)
    if (!res.ok) { toast.toastError('Could not pull the item back', res.error); return }
    setItemModal(null)
    toast.success('Item back to planned', 'You can edit it and send it again.')
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
            options={(() => {
              const opt = (c: (typeof calendars)[number]) => {
                const total = c.items?.length ?? 0
                const sent = c.items?.filter(i => i.request_id).length ?? 0
                const sub = `${c.title ? c.title + ' · ' : ''}${total} items · ${sent} in requests`
                return { id: c.id, label: `${c.client?.name ?? 'Client'} — ${monthLabel(c.month)}`, sub }
              }
              // Grouped by relevance, not creation order: what's being planned
              // now sits on top; finished months sink but stay one scroll away
              // (search still reaches everything flat).
              const thisMonth = new Date().toISOString().slice(0, 7)
              const key = (c: (typeof calendars)[number]) => c.month.slice(0, 7)
              const live = calendars.filter(c => c.status !== 'archived')
              return [
                ...live.filter(c => key(c) === thisMonth)
                  .map(c => ({ ...opt(c), group: 'This month' })),
                ...live.filter(c => key(c) > thisMonth)
                  .sort((a, b) => a.month.localeCompare(b.month))
                  .map(c => ({ ...opt(c), group: 'Upcoming' })),
                ...live.filter(c => key(c) < thisMonth)
                  .sort((a, b) => b.month.localeCompare(a.month))
                  .map(c => ({ ...opt(c), group: 'Past months' })),
                ...calendars.filter(c => c.status === 'archived')
                  .sort((a, b) => b.month.localeCompare(a.month))
                  .map(c => ({ ...opt(c), group: 'Archived' })),
              ]
            })()}
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
            {/* Plan discussion — chatter side panel, one room per plan */}
            <DiscussButton
              entityType="plan"
              entityId={selected.id}
              label="Discuss"
              panelTitle={`${selected.client?.name ?? 'Plan'} — ${monthLabel(selected.month)}`}
            />
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

          {/*
            ── Package commitment ──
            What this client is owed under a package, and whether the month on
            screen actually delivers it. Without this the planner is filling a
            calendar with no idea it is eight posts short of the retainer.
          */}
          {/*
            Settled packages — commitment met, or the cycle closed. No decision
            left to support, so however many there are they share ONE quiet
            line of chips instead of a row each. The chip links to the
            Packages page, which holds the full story.
          */}
          {packageProgress.some(pp => pp.remaining === 0 || pp.missed) && (
            <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-muted-foreground">
              {packageProgress.filter(pp => pp.remaining === 0 || pp.missed).map(pp => (
                <Link key={pp.packageId} href="/dashboard/packages"
                  title={pp.remaining === 0
                    ? `${pp.name} — all ${pp.included} delivered`
                    : `${pp.name} — cycle closed, ${pp.remaining} of ${pp.included} not delivered`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-border/50 bg-card/40 hover:text-foreground hover:border-border transition-colors">
                  {pp.remaining === 0
                    ? <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500 shrink-0" />
                    : <AlertTriangle className="w-2.5 h-2.5 text-amber-500 shrink-0" />}
                  <span className="truncate max-w-[12rem]">{pp.name}</span>
                  <span className="tabular-nums">
                    {pp.remaining === 0 ? pp.included : `${pp.delivered}/${pp.included}`}
                  </span>
                </Link>
              ))}
            </div>
          )}

          {packageProgress.filter(pp => pp.remaining > 0 && !pp.missed).map(pp => {
            const pct = pp.included > 0 ? Math.min(100, Math.round((pp.delivered / pp.included) * 100)) : 0
            const plannedPct = pp.included > 0 ? Math.min(100 - pct, Math.round((pp.planned / pp.included) * 100)) : 0
            const cadence = cadenceLabel(pp.cadence)

            return (
              <div key={pp.packageId} className="rounded-xl border border-border bg-card px-4 py-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <PackageIcon className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="text-xs font-semibold">{pp.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {pp.deadline
                      ? `${pp.isFirstCycle ? 'first cycle' : 'this cycle'} · ${fmtDay(pp.windowStart)} → ${fmtDay(pp.deadline)}`
                      /* Open-ended one-off: it has a start but no due date, and
                         inventing one would misstate the commitment. */
                      : `one-off · from ${fmtDay(pp.windowStart)}`}
                  </span>
                  <Link href="/dashboard/packages"
                    className="text-[11px] text-muted-foreground hover:text-foreground hover:underline ml-auto">
                    Package
                  </Link>
                </div>

                {/* Delivered (solid) then planned (hatched) against the commitment. */}
                <div className="mt-2 h-1.5 w-full rounded-full bg-secondary overflow-hidden flex">
                  <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  <div className="h-full bg-emerald-500/35" style={{ width: `${plannedPct}%` }} />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                  <span>
                    <span className="font-semibold tabular-nums">{pp.delivered}</span>
                    <span className="text-muted-foreground"> of {pp.included} delivered</span>
                  </span>
                  {/* Already a task, just not finished — needs doing, not planning. */}
                  {pp.scheduled > 0 && (
                    <span className="text-blue-600 dark:text-blue-400">
                      <span className="tabular-nums">{pp.scheduled}</span> in progress
                    </span>
                  )}
                  {pp.planned > 0 && (
                    <span className="text-muted-foreground">
                      <span className="tabular-nums text-foreground">{pp.planned}</span> planned here
                    </span>
                  )}
                  {/*
                    The number that costs money: owed, and not on the calendar
                    at all. Everything else on this screen is visible as a card;
                    this is the only place the absence shows up.
                  */}
                  {pp.unplanned > 0 && (
                    <span className="text-amber-600 dark:text-amber-400 font-medium">
                      <span className="tabular-nums">{pp.unplanned}</span> still to plan
                    </span>
                  )}
                  {/* The escape hatch, shown only on a package that actually has
                      something to suggest — a package whose remaining work is
                      already in hand has no days to offer. */}
                  {canManage && pp.unplanned > 0 && (
                    <button onClick={() => toggleHints(!showHints)}
                      className="text-muted-foreground hover:text-foreground underline decoration-dotted underline-offset-2">
                      {showHints ? 'hide suggested days' : 'suggest days'}
                    </button>
                  )}
                  {pp.remaining === 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                      Commitment met
                    </span>
                  )}
                  {pp.missed ? (
                    <span className="text-red-600 dark:text-red-400">
                      {pp.remaining} undelivered — the cycle has closed
                    </span>
                  ) : cadence && pp.daysLeft !== null && (
                    <span className="text-muted-foreground ml-auto inline-flex items-center gap-2">
                      {/* Pace verdict: where a steady schedule says the cycle
                          should be by today, versus what's actually finished. */}
                      {pp.pace === 'behind' && (
                        <span className="text-amber-600 dark:text-amber-400">
                          {pp.behind} behind pace
                        </span>
                      )}
                      {pp.pace === 'ahead' && (
                        <span className="text-emerald-600 dark:text-emerald-400">ahead of pace</span>
                      )}
                      {pp.pace === 'on_track' && (
                        <span className="text-emerald-600 dark:text-emerald-400">on pace</span>
                      )}
                      <span>{pp.daysLeft} day{pp.daysLeft === 1 ? '' : 's'} left · needs {cadence}</span>
                    </span>
                  )}
                </div>

                {/* Per included service, when the package commits to more than one. */}
                {pp.perService.length > 1 && (
                  <div className="mt-2 pt-2 border-t border-border/60 space-y-1">
                    {pp.perService.map(s => (
                      <div key={s.serviceId} className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground truncate">
                          {services.find(x => x.id === s.serviceId)?.name ?? 'Service'}
                        </span>
                        <span className="tabular-nums shrink-0 ml-3">
                          <span className="font-medium">{s.delivered}</span>
                          <span className="text-muted-foreground">/{s.included}</span>
                          {s.unplanned > 0 && (
                            <span className="ml-1.5 text-amber-600 dark:text-amber-400">
                              {s.unplanned} to plan
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

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
                  const hint = hintsByDate.get(cell.key)
                  return (
                    <DroppableZone
                      key={cell.key}
                      id={`day:${cell.key}`}
                      disabled={!cell.inMonth}
                      className={`min-h-[96px] border-b border-r border-border/50 align-top transition-colors ${cell.inMonth ? '' : 'bg-secondary/20 opacity-50'} ${cell.key === todayKey ? 'bg-primary/[0.06] ring-1 ring-inset ring-primary/30' : ''}`}
                      activeClassName="bg-primary/10"
                    >
                      <div
                        className={`flex flex-col h-full w-full p-1.5 ${canManage && cell.inMonth ? 'cursor-pointer hover:bg-secondary/30 transition-colors' : ''}`}
                        onClick={() => {
                          if (!canManage || !cell.inMonth) return
                          setItemForm({ ...EMPTY_ITEM, scheduledDate: cell.key })
                          setCopyTab('text')
                          setShowAllDesigners(false)
                          setItemModal({ mode: 'add' })
                        }}
                      >
                        <div className={cell.key === todayKey
                          ? 'text-[10px] font-semibold w-4 h-4 rounded-full bg-primary text-white flex items-center justify-center'
                          : 'text-[10px] text-muted-foreground'}>
                          {cell.date.getDate()}
                        </div>
                        <div className="mt-1 space-y-1">
                          {dayItems.map(it => {
                            const progress = resolveItemProgress(it.status, it.request, it.task)
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

                        {/*
                          Placement hint — a suggestion, not a booking.

                          `mt-auto` pins it to the bottom of the cell so it eats
                          the slack a short day already has instead of growing
                          the row; several suggestions on one day collapse into
                          one row with a count, so the height never varies with
                          how far behind the retainer is.

                          Deliberately colourless and dashed: the owner asked for
                          a gentle nudge, not a highlight, and a coloured chip
                          here would compete with the real item cards.
                        */}
                        {hint && (
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              setItemForm({
                                ...EMPTY_ITEM,
                                scheduledDate: cell.key,
                                serviceId: hint.serviceId,
                              })
                              setCopyTab('text')
                              setShowAllDesigners(false)
                              setItemModal({ mode: 'add' })
                            }}
                            title={hint.catchUp
                              ? `${serviceNameById(hint.serviceId)} — catch-up: the steady schedule had this done by now`
                              : `${serviceNameById(hint.serviceId)} — suggested to keep the package on track`}
                            /* Dashed = suggestion, always. The tint is one step
                               louder than before (the owner asked for "a little
                               bit highlighted"), amber-edged when it exists to
                               recover a pace shortfall. */
                            className={`mt-auto w-full flex items-center gap-1 rounded-sm border border-dashed px-1 py-0.5 text-[9px] transition-colors truncate ${
                              hint.catchUp
                                ? 'border-amber-500/50 bg-amber-500/[0.06] text-amber-600/80 dark:text-amber-400/80 hover:text-amber-600 dark:hover:text-amber-400 hover:border-amber-500'
                                : 'border-primary/40 bg-primary/[0.04] text-primary/60 hover:text-primary hover:border-primary/70'}`}
                          >
                            <span className="shrink-0">+</span>
                            {hintServicesAmbiguous && (
                              <span className="truncate">{serviceNameById(hint.serviceId)}</span>
                            )}
                            {hint.count > 1 && <span className="ml-auto shrink-0 tabular-nums">×{hint.count}</span>}
                          </button>
                        )}
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
              ['planned', PROGRESS_LABEL.planned, items.filter(i => i.scheduled_date && resolveItemProgress(i.status, i.request, i.task) === 'planned')],
              ['requested', PROGRESS_LABEL.requested, items.filter(i => resolveItemProgress(i.status, i.request, i.task) === 'requested')],
              ['in_progress', PROGRESS_LABEL.in_progress, items.filter(i => resolveItemProgress(i.status, i.request, i.task) === 'in_progress')],
              ['delivered', PROGRESS_LABEL.delivered, items.filter(i => resolveItemProgress(i.status, i.request, i.task) === 'delivered')],
              ['done', PROGRESS_LABEL.done, items.filter(i => resolveItemProgress(i.status, i.request, i.task) === 'done')],
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
          {/* max-w-2xl (not lg): the caption editor is the working surface of
              this form — the extra width keeps its toolbar to one row and
              gives the copy room to breathe. */}
          <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden">
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
                {/* Direct exit — no REQ to show, so the task itself is the
                    only reference the planner has. */}
                {editingItem?.task && !editingItem.task.deleted_at && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono text-emerald-500">Task #{editingItem.task.task_number ?? '—'}</span>
                    {editingProgress && (
                      <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${PROGRESS_CHIP[editingProgress]}`}>
                        {PROGRESS_LABEL[editingProgress]}
                      </span>
                    )}
                    <span className="text-muted-foreground/70">sent directly — no request</span>
                    <Link href={`/dashboard/tasks?q=%23${editingItem.task.task_number ?? ''}`} className="text-primary hover:underline inline-flex items-center gap-0.5">
                      open in Tasks <ExternalLink className="w-3 h-3" />
                    </Link>
                  </p>
                )}
              </div>
              <button onClick={() => setItemModal(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>

            <div className="px-5 py-4 space-y-3 max-h-[72dvh] overflow-y-auto">
              {editingFrozen && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  This item is already a task — the plan entry is frozen. Manage it from the Tasks page.
                  {editingPullable && ' Use Re-plan below to unlink it and edit the plan again; the task itself is left untouched.'}
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
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5" title="Leave blank to keep it on the Idea Board">
                    {itemForm.scheduledEndDate ? 'Start date' : 'Date'} <span className="text-muted-foreground/60">(blank = idea)</span>
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
              {/* Also as — Story is pinned as a one-tap chip (the variant that
                  actually gets used); everything else is a free-text tag so the
                  vocabulary can grow without a code change. Suggestions come
                  from tags already used across every plan, which is what stops
                  "reel"/"reels"/"Reel" fragmenting. */}
              {(() => {
                const chosen = itemForm.variants ?? []
                const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ')
                const label = (v: string) => (CONTENT_TYPE_LABEL as Record<string, string>)[v] ?? v.replace(/\b\w/g, c => c.toUpperCase())
                const addVariant = (raw: string) => {
                  const v = norm(raw)
                  setVariantDraft('')
                  if (!v || v === itemForm.contentType) return   // never duplicate the main type
                  setItemForm(f => (f.variants ?? []).includes(v) ? f : { ...f, variants: [...(f.variants ?? []), v] })
                }
                const removeVariant = (v: string) =>
                  setItemForm(f => ({ ...f, variants: (f.variants ?? []).filter(x => x !== v) }))

                const storyPinned = itemForm.contentType !== 'story'
                const storyOn = chosen.includes('story')
                const tags = chosen.filter(v => !(storyPinned && v === 'story'))
                const suggestions = [...new Set([...VARIANT_TYPES, ...(knownVariants ?? [])])]
                  .filter(v => v !== itemForm.contentType && !chosen.includes(v))

                return (
                  <OptionalSection
                    label="Also as"
                    hint="Size/format variants of the same creative — e.g. a post that also goes out as a story"
                    summary={chosen.length ? chosen.map(label).join(', ') : ''}
                    open={secOpen('variants', chosen.length > 0)}
                    onToggle={() => toggleSec('variants', chosen.length > 0)}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      {storyPinned && (
                        <button
                          type="button" disabled={editingFrozen}
                          onClick={() => storyOn ? removeVariant('story') : addVariant('story')}
                          className={`px-2.5 py-1 rounded-full text-xs border transition-colors disabled:opacity-60 ${storyOn
                            ? 'bg-primary/15 text-primary border-primary/30 font-medium'
                            : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}
                        >
                          {storyOn ? '✓ Story' : '+ Story'}
                        </button>
                      )}
                      {tags.map(v => (
                        <span key={v} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border bg-primary/15 text-primary border-primary/30 font-medium">
                          {label(v)}
                          {!editingFrozen && (
                            <button type="button" onClick={() => removeVariant(v)} title={`Remove ${label(v)}`}
                              className="opacity-60 hover:opacity-100">
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </span>
                      ))}
                      <input
                        list="variant-suggestions"
                        value={variantDraft}
                        disabled={editingFrozen}
                        onChange={e => {
                          // Picking from the datalist fires change with the full
                          // value — commit it straight away rather than making
                          // the user press Enter on a chosen suggestion.
                          const v = e.target.value
                          if (suggestions.some(sug => sug === norm(v))) addVariant(v)
                          else setVariantDraft(v)
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); addVariant(variantDraft) }
                          else if (e.key === 'Backspace' && !variantDraft && tags.length) removeVariant(tags[tags.length - 1])
                        }}
                        onBlur={() => addVariant(variantDraft)}
                        placeholder="+ type a variant, Enter…"
                        className="min-w-[9rem] flex-1 bg-transparent border-b border-dashed border-border focus:border-primary text-xs px-1 py-1 focus:outline-none placeholder:text-muted-foreground/50 disabled:opacity-60"
                      />
                      <datalist id="variant-suggestions">
                        {suggestions.map(v => <option key={v} value={v}>{label(v)}</option>)}
                      </datalist>
                    </div>
                  </OptionalSection>
                )
              })()}
              {/* No Service field here on purpose: the server assigns it
                  automatically from the content type (Service defaults gear). */}
              {/* Designer — optional. Answered at planning time it rides into
                  the pushed request's assigned_employee_id, so work arrives in
                  the inbox already earmarked; left blank, the inbox decides as
                  before. Never blocks planning. */}
              {(() => {
                // SCOPED TO THE ITEM'S SERVICE. This item becomes a request for
                // exactly one service (content type → Service defaults, same
                // resolution the server runs on save), so the picker offers the
                // people assigned to that service — directly or through its
                // department. An Offer-Flyers-only designer has no business
                // appearing under a social Post.
                //
                // Scoping is skipped, not narrowed to nothing, whenever it
                // cannot be trusted: no resolvable service, or nobody assigned
                // to it yet. A half-configured catalogue must never leave the
                // planner with an empty picker.
                const scopedServiceId = suggestServiceId(itemForm.contentType, services, serviceMap)
                const matches = scopedServiceId
                  ? employees.filter(e => (employeeServices[e.id] || []).includes(scopedServiceId))
                  : []
                const scoping = !showAllDesigners && matches.length > 0
                // The current assignee always stays in the list: an item
                // assigned before the mapping changed (or whose content type
                // was just edited) must not silently lose its designer.
                const assignedId = itemForm.assignedEmployeeId
                const visible = scoping
                  ? (assignedId && !matches.some(e => e.id === assignedId)
                      ? [...matches, ...employees.filter(e => e.id === assignedId)]
                      : matches)
                  : employees
                const hiddenCount = employees.length - visible.length
                const serviceName = services.find(s => s.id === scopedServiceId)?.name

                // Department headers only earn their keep on the full list,
                // where they help a planner browse. Once scoped to a single
                // service they are noise — and worse, they list anyone who
                // works several departments once per department.
                const grouped = scoping
                  ? []
                  : departments
                      .map(d => ({ d, emps: visible.filter(e => (employeeDepartments[e.id] || []).includes(d.id)) }))
                      .filter(g => g.emps.length > 0)
                // Employees with no department fall into a trailing group rather
                // than vanishing — an unassigned designer is still assignable.
                const placed = new Set(grouped.flatMap(g => g.emps.map(e => e.id)))
                const rest = visible.filter(e => !placed.has(e.id))
                const restLabel = scoping
                  ? (serviceName || 'Assigned to this service')
                  : (grouped.length ? 'No department' : 'All employees')

                return (
                  <OptionalSection
                    label="Designer"
                    hint="Optional — carries into the design request, so work arrives in the inbox already earmarked"
                    summary={assignedId ? (employees.find(e => e.id === assignedId)?.cqid ?? '') : ''}
                    open={secOpen('designer', !!assignedId)}
                    onToggle={() => toggleSec('designer', !!assignedId)}
                  >
                    <AppSelect
                      value={itemForm.assignedEmployeeId ?? ''}
                      disabled={editingFrozen}
                      onChange={e => setItemForm(f => ({ ...f, assignedEmployeeId: e.target.value || null }))}
                    >
                      <option value="">— Decide later —</option>
                      {grouped.map(({ d, emps }) => (
                        <optgroup key={d.id} label={d.name}>
                          {emps.map(emp => <option key={emp.id} value={emp.id}>{emp.cqid}</option>)}
                        </optgroup>
                      ))}
                      {rest.length > 0 && (
                        <optgroup label={restLabel}>
                          {rest.map(emp => <option key={emp.id} value={emp.id}>{emp.cqid}</option>)}
                        </optgroup>
                      )}
                    </AppSelect>
                    {scoping && hiddenCount > 0 && !editingFrozen && (
                      <p className="mt-1 text-[11px] text-muted-foreground/70">
                        Showing people assigned to {serviceName ? <span className="text-muted-foreground">{serviceName}</span> : 'this service'}.{' '}
                        <button type="button" onClick={() => setShowAllDesigners(true)}
                          className="underline underline-offset-2 hover:text-foreground">
                          Show all {employees.length}
                        </button>
                      </p>
                    )}
                    {!scoping && matches.length > 0 && !editingFrozen && (
                      <p className="mt-1 text-[11px] text-muted-foreground/70">
                        Showing everyone.{' '}
                        <button type="button" onClick={() => setShowAllDesigners(false)}
                          className="underline underline-offset-2 hover:text-foreground">
                          Only {serviceName || 'this service'}
                        </button>
                      </p>
                    )}
                  </OptionalSection>
                )
              })()}

              <OptionalSection
                label="Platforms"
                summary={itemForm.platforms.length > 0 ? platformLabels(itemForm.platforms, true) : ''}
                open={secOpen('platforms', itemForm.platforms.length > 0)}
                onToggle={() => toggleSec('platforms', itemForm.platforms.length > 0)}
              >
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
              </OptionalSection>
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
              <OptionalSection
                label="Reference images"
                hint="Mood board — what the creative should look like"
                summary={(itemForm.referenceUrls?.length ?? 0) > 0
                  ? `${itemForm.referenceUrls!.length} image${itemForm.referenceUrls!.length === 1 ? '' : 's'}` : ''}
                open={secOpen('refs', (itemForm.referenceUrls?.length ?? 0) > 0)}
                onToggle={() => toggleSec('refs', (itemForm.referenceUrls?.length ?? 0) > 0)}
              >
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
              </OptionalSection>
              <OptionalSection
                label="Internal notes"
                summary={itemForm.notes?.trim() ? '✓' : ''}
                open={secOpen('notes', !!itemForm.notes?.trim())}
                onToggle={() => toggleSec('notes', !!itemForm.notes?.trim())}
              >
                <textarea
                  value={itemForm.notes ?? ''} rows={2} disabled={editingFrozen}
                  onChange={e => setItemForm(p => ({ ...p, notes: e.target.value }))}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none disabled:opacity-60"
                />
              </OptionalSection>
            </div>

            <div className="flex flex-wrap gap-2 px-5 py-4 border-t border-border">
              {/* Per-item discussion — its own room, separate from the month
                  plan's. Edit mode only: an unsaved item has no id to hang a
                  conversation off. */}
              {itemModal.mode === 'edit' && itemModal.itemId && (
                <DiscussButton
                  entityType="plan_item"
                  entityId={itemModal.itemId}
                  label="Discuss"
                  panelTitle={itemForm.title?.trim() || 'Calendar item'}
                />
              )}
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
              {/* The two exits. Requests keeps the REQ trail and the client's
                  portal timeline; Tasks skips both and is for internal work
                  nobody outside the office follows. */}
              {itemModal.mode === 'edit' && editingUnrouted && (
                <button
                  onClick={() => push([itemModal.itemId!])}
                  disabled={busy === `push:${itemModal.itemId}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-500 px-3 py-2 text-sm font-medium hover:bg-blue-500/20 disabled:opacity-50"
                  title="Create a request in the inbox — the client sees it on their portal"
                >
                  {busy === `push:${itemModal.itemId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Send to Requests
                </button>
              )}
              {itemModal.mode === 'edit' && editingUnrouted && (
                <button
                  onClick={() => sendToTask(itemModal.itemId!)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-500 px-3 py-2 text-sm font-medium hover:bg-emerald-500/20 disabled:opacity-50"
                  title="Skip the inbox — opens Add Task prefilled. No REQ number, and nothing appears on the client portal."
                >
                  <ListChecks className="w-4 h-4" />
                  Send to Tasks
                </button>
              )}
              {/* Escape hatch, both directions: pull the item back to 'planned'
                  so it can be edited and sent again. Cancels a still-open
                  request on the way (one click instead of a round-trip through
                  the inbox); for a direct task it unlinks only and leaves the
                  task for the Tasks page to deal with. */}
              {itemModal.mode === 'edit' && editingPullable && (
                <button
                  onClick={() => replanItem(itemModal.itemId!)}
                  disabled={busy === `replan:${itemModal.itemId}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
                  title={
                    editingItem?.task && !editingItem.task.deleted_at
                      ? 'Unlink the task and plan this again — the task itself is left untouched'
                      : requestIsClosed
                        ? 'Its request was closed in the inbox — unlink and plan it again'
                        : 'Cancel its request and bring the item back to planned'
                  }
                >
                  {busy === `replan:${itemModal.itemId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  {requestIsClosed || (editingItem?.task && !editingItem.task.deleted_at) ? 'Re-plan' : 'Pull back'}
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
