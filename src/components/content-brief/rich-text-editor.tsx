'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Bold, Italic, Underline, Strikethrough, List, ListOrdered, Heading2, Quote,
  Link as LinkIcon, Highlighter, Palette, Smile, Eraser,
  AlignLeft, AlignCenter, AlignRight, X,
} from 'lucide-react'

// ── Rich caption editor (shared: Social Calendar + Requests Content Brief) ───────────────────────────────────────────────────────
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

export default function RichTextEditor({
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
  // Everyday tools show by default; the rest (underline, headings, alignment,
  // colour…) sit behind the "Aa" toggle so the toolbar isn't a wall of icons.
  const [allTools, setAllTools] = useState(false)
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
          {allTools && <EditorTool disabled={disabled} icon={<Underline className="w-3.5 h-3.5" />} title="Underline (⌘U)" on={() => run('underline')} />}
          {allTools && <EditorTool disabled={disabled} icon={<Strikethrough className="w-3.5 h-3.5" />} title="Strikethrough" on={() => run('strikeThrough')} />}
          <EditorTool disabled={disabled} icon={<List className="w-3.5 h-3.5" />} title="Bullet list" on={() => run('insertUnorderedList')} />
        </EditorGroup>

        {allTools && (
          <>
            {/* Structure */}
            <EditorGroup>
              <EditorTool disabled={disabled} icon={<Heading2 className="w-3.5 h-3.5" />} title="Heading" on={() => run('formatBlock', '<h3>')} />
              <EditorTool disabled={disabled} icon={<Quote className="w-3.5 h-3.5" />} title="Quote" on={() => run('formatBlock', '<blockquote>')} />
              <EditorTool disabled={disabled} icon={<ListOrdered className="w-3.5 h-3.5" />} title="Numbered list" on={() => run('insertOrderedList')} />
            </EditorGroup>
            {/* Alignment */}
            <EditorGroup>
              <EditorTool disabled={disabled} icon={<AlignLeft className="w-3.5 h-3.5" />} title="Align left" on={() => run('justifyLeft', undefined, true)} />
              <EditorTool disabled={disabled} icon={<AlignCenter className="w-3.5 h-3.5" />} title="Align center" on={() => run('justifyCenter', undefined, true)} />
              <EditorTool disabled={disabled} icon={<AlignRight className="w-3.5 h-3.5" />} title="Align right" on={() => run('justifyRight', undefined, true)} />
            </EditorGroup>
          </>
        )}

        <div className="flex-1" />

        {/* Inserts & Decorators */}
        <EditorGroup>
          {allTools && (<>
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
          </>)}
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
        {allTools && (
          <EditorGroup>
            <EditorTool disabled={disabled} icon={<Eraser className="w-3.5 h-3.5 text-red-400" />} title="Clear formatting" className="hover:text-red-500 hover:bg-red-500/10" on={() => run('removeFormat')} />
          </EditorGroup>
        )}
        <button type="button" onClick={() => setAllTools(v => !v)}
          title={allTools ? 'Fewer formatting tools' : 'More formatting — underline, headings, alignment, colour'}
          className={`h-7 px-2 rounded-md text-[11px] font-semibold transition-colors ${allTools ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
          Aa
        </button>
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
          className="min-h-[120px] max-h-[50dvh] overflow-y-auto px-3 py-2 text-sm focus:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:text-base [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-bold [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:underline"
        />
      </div>
    </div>
  )
}


// Pull an image off the clipboard (a pasted screenshot) as a File for upload.
export async function readImageFromClipboard(): Promise<File | null> {
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

