'use client'

/**
 * The keyboard guide — `?` anywhere, or the hint in the search box.
 *
 * Mounted once in the dashboard layout. It owns the `?` key and nothing else;
 * every shortcut it lists stays implemented where it belongs (see
 * `@/lib/keyboard/shortcuts`), so this cannot change what any key does.
 *
 * `?` is Shift+/ on most layouts, and must not fire while somebody is typing —
 * a question mark in a client brief is far more common than a request for
 * help — so the handler ignores the event whenever the focus is in a field.
 */
import { useState, useEffect, useMemo } from 'react'
import { Keyboard, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { usePermissions } from '@/contexts/permission-context'
import { groupedShortcuts, formatChord, isApplePlatform } from '@/lib/keyboard/shortcuts'

/** Is the user typing? Then `?` is a question mark, not a request for help. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

export function KeyboardGuide() {
  const [open, setOpen] = useState(false)
  const { can } = usePermissions()

  // Resolved when the guide is opened, not during render: the server has no
  // platform to report, and rendering ⌘ on the server then swapping to Ctrl
  // on the client is a hydration mismatch. By the time anything opens this,
  // we are certainly on the client.
  const [apple, setApple] = useState(false)

  useEffect(() => {
    function reveal() {
      setApple(isApplePlatform())
      setOpen(true)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || isTypingTarget(e.target)) return
      e.preventDefault()
      // Unconditional: the value never changes for a given device, and a
      // state updater must stay pure.
      setApple(isApplePlatform())
      setOpen(o => !o)
    }
    // Also opened from the search box's hint, which has no key to press.
    window.addEventListener('keydown', onKey)
    window.addEventListener('cirqle:keyboard-guide', reveal)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('cirqle:keyboard-guide', reveal)
    }
  }, [])

  const groups = useMemo(() => groupedShortcuts(can), [can])

  if (!open) return null

  return (
    <ModalOverlay onClose={() => setOpen(false)}>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[30rem] max-w-full shadow-2xl max-h-[85dvh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-muted-foreground" />
            Keyboard shortcuts
          </h2>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {groups.map(group => (
            <section key={group.scope}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2">
                {group.label}
              </p>
              <ul className="space-y-1.5">
                {group.items.map(s => (
                  <li key={s.id} className="flex items-start justify-between gap-4">
                    <span className="text-xs text-foreground/85 leading-relaxed">{s.label}</span>
                    <span className="flex items-center gap-1 shrink-0 pt-0.5">
                      {formatChord(s.chord, apple).map((part, i) => (
                        <kbd
                          key={i}
                          className="min-w-[1.4rem] px-1.5 py-0.5 rounded-md bg-secondary border border-foreground/15 text-[10px] font-mono font-semibold text-center"
                        >
                          {part}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-border shrink-0">
          <p className="text-[11px] text-muted-foreground">
            Press <kbd className="px-1 py-0.5 rounded bg-secondary border border-foreground/15 font-mono text-[10px]">?</kbd>
            {' '}anywhere to open this list again.
          </p>
        </div>
      </div>
    </ModalOverlay>
  )
}

/** Open the guide from a click — used by the search box's hint. */
export function openKeyboardGuide() {
  window.dispatchEvent(new Event('cirqle:keyboard-guide'))
}
