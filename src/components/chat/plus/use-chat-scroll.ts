'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Row { id: string; senderId: string | null }

/**
 * Scrolling for a message list, the way a messenger does it:
 *   · opening a chat lands on the "new messages" line, or the bottom
 *   · a new message scrolls down only if you were already at the bottom (or
 *     sent it yourself); otherwise a "new messages" button counts them
 *   · older messages loading at the top never move what you are reading
 *     (the scroller must set overflow-anchor: none — this hook does the
 *     correction itself, so every browser behaves the same, Safari included)
 *   · a picture that finishes loading keeps you pinned to the bottom
 */
export function useChatScroll({ conversationId, rows, meId, markerId, onReachTop }: {
  conversationId: string | null
  rows: readonly Row[]
  meId: string
  /** DOM id of the "new messages" line, when there is one for this open. */
  markerId: string | null
  onReachTop: () => void
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const topRef = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  const prev = useRef({ conv: null as string | null, first: null as string | null, last: null as string | null, len: 0, height: 0 })
  const [newBelow, setNewBelow] = useState(0)
  const [showJump, setShowJump] = useState(false)

  const toBottom = useCallback((smooth = false) => {
    const el = scrollerRef.current
    if (!el) return
    // Animate only a short hop; a long way back just lands there.
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > 2500
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !far ? 'smooth' : 'auto' })
    atBottom.current = true
    setNewBelow(0)
    setShowJump(false)
  }, [])

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const p = prev.current
    const first = rows[0]?.id ?? null, last = rows[rows.length - 1]?.id ?? null
    const opened = p.conv !== conversationId || (p.len === 0 && rows.length > 0)

    if (opened) {
      const marker = markerId ? document.getElementById(markerId) : null
      if (marker && rows.length) {
        marker.scrollIntoView({ block: 'center' })
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      } else {
        el.scrollTop = el.scrollHeight
        atBottom.current = true
      }
      // Deferred: no state change in the layout pass itself.
      queueMicrotask(() => { setNewBelow(0); setShowJump(!atBottom.current) })
    } else if (first !== p.first && last === p.last && rows.length > p.len) {
      // Older messages arrived above: stay on the message being read.
      el.scrollTop += el.scrollHeight - p.height
    } else if (last !== p.last && rows.length >= p.len) {
      const added = rows.slice(Math.max(0, p.len - 1)).filter(r => r.id !== p.last)
      const mine = rows[rows.length - 1]?.senderId === meId
      if (mine || atBottom.current) {
        // Instant, not animated: an animated scroll can be cut short (a hidden
        // tab, a second message arriving mid-way) and leave you above the bottom.
        el.scrollTop = el.scrollHeight
        atBottom.current = true
      } else {
        const fromOthers = added.filter(r => r.senderId !== meId).length
        if (fromOthers) queueMicrotask(() => { setNewBelow(n => n + fromOthers); setShowJump(true) })
      }
    }
    prev.current = { conv: conversationId, first, last, len: rows.length, height: el.scrollHeight }
  }, [rows, conversationId, markerId, meId])

  // Content that grows after layout (pictures, link previews) keeps the bottom pinned.
  useEffect(() => {
    const content = contentRef.current, el = scrollerRef.current
    if (!content || !el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight
      prev.current.height = el.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [conversationId])

  // Reaching the top loads earlier messages.
  const reachTop = useRef(onReachTop)
  useEffect(() => { reachTop.current = onReachTop }, [onReachTop])
  useEffect(() => {
    const top = topRef.current, el = scrollerRef.current
    if (!top || !el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && prev.current.len > 0) reachTop.current()
    }, { root: el, rootMargin: '200px 0px 0px 0px' })
    io.observe(top)
    return () => io.disconnect()
  }, [conversationId, rows.length])

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottom.current = gap < 80
    if (atBottom.current) { setNewBelow(0); setShowJump(false) }
    else setShowJump(gap > 320)
  }, [])

  return { scrollerRef, contentRef, topRef, onScroll, newBelow, showJump, toBottom }
}
