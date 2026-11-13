'use client'

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import {
  LISTENER_KEYS, isChatId, parseGroupList, parseGroupNames, parseNumberRows, parseSeen, phoneMatchKey,
  serializeGroupList, serializeNumberList, type NumberRow,
} from '@/lib/whatsapp-listener/rules'

/**
 * The WhatsApp listener's two mappings as tables:
 *   groups  → which Cirqle client each WhatsApp chat belongs to
 *   numbers → which phone numbers are Cirqle's own (never filed as requests)
 *
 * A friendlier editor over the same company_settings text the listener reads
 * (see lib/whatsapp-listener/rules.ts), so nothing changes on the listener side.
 */

interface Props {
  settings: Record<string, string>
  onChange: (key: string, value: string) => void
  clients: { name: string; is_active?: boolean | null }[]
  /** Names offered as suggestions in the "Who" column. */
  people: string[]
}

interface GroupRow { id: string; client: string }

const cell = 'px-2 py-1.5 align-middle'
const input = 'w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-xs'
const th = 'px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground'

export default function WhatsAppListenerMap({ settings, onChange, clients, people }: Props) {
  // Rows live here while editing, so a half-typed row is not lost on the way
  // through the text format; every change is written back as text for Save.
  const [groups, setGroups] = useState<GroupRow[]>(() =>
    [...parseGroupList(settings[LISTENER_KEYS.groups])].map(([id, client]) => ({ id, client })))
  const [names, setNames] = useState<Record<string, string>>(() => parseGroupNames(settings[LISTENER_KEYS.groupNames]))
  const [numbers, setNumbers] = useState<NumberRow[]>(() => parseNumberRows(settings[LISTENER_KEYS.staffNumbers]))
  const [newChatId, setNewChatId] = useState('')

  const clientNames = clients.filter(c => c.is_active !== false).map(c => c.name).sort((a, b) => a.localeCompare(b))
  const known = new Set(clients.map(c => c.name.toLowerCase()))

  function saveGroups(next: GroupRow[], nextNames = names) {
    setGroups(next)
    onChange(LISTENER_KEYS.groups, serializeGroupList(next))
    // Keep names only for chats still listed.
    const kept = Object.fromEntries(next.map(g => [g.id, (nextNames[g.id] || '').trim()]).filter(([, n]) => n))
    setNames(nextNames)
    onChange(LISTENER_KEYS.groupNames, JSON.stringify(kept))
  }
  function saveNumbers(next: NumberRow[]) {
    setNumbers(next)
    onChange(LISTENER_KEYS.staffNumbers, serializeNumberList(next))
  }

  const addId = newChatId.trim()
  const canAdd = isChatId(addId) && !groups.some(g => g.id === addId)
  function addGroup(id: string) {
    if (!isChatId(id) || groups.some(g => g.id === id)) return
    saveGroups([...groups, { id, client: '' }])
    setNewChatId('')
  }

  const listed = new Set(groups.map(g => g.id))
  const seen = Object.entries(parseSeen(settings[LISTENER_KEYS.seen]))
    .filter(([id]) => !listed.has(id))
    .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))

  const keyCount = new Map<string, number>()
  for (const r of numbers) { const k = phoneMatchKey(r.number); if (k) keyCount.set(k, (keyCount.get(k) || 0) + 1) }

  return (
    <div className="space-y-5">
      {/* ── Groups → clients ── */}
      <div>
        <p className="text-xs font-medium text-foreground mb-0.5">Chats to read</p>
        <p className="text-[11px] text-muted-foreground/60 mb-1.5">
          Each WhatsApp chat and the client it belongs to. A chat that is not in this table is never read. {groups.length} listed.
        </p>
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-xs min-w-[520px]">
            <thead className="bg-secondary/50 border-b border-border">
              <tr>
                <th className={th}>WhatsApp chat</th>
                <th className={th}>Cirqle client</th>
                <th className={`${th} w-8`}><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {groups.length === 0 && (
                <tr><td colSpan={3} className="px-3 py-3 text-[11px] text-muted-foreground">No chats yet. Add one below.</td></tr>
              )}
              {groups.map((g, i) => {
                const unknownClient = !!g.client && !known.has(g.client.toLowerCase())
                return (
                  <tr key={g.id}>
                    <td className={cell}>
                      <input
                        aria-label={`Name for chat ${g.id}`}
                        value={names[g.id] || ''}
                        onChange={e => saveGroups(groups, { ...names, [g.id]: e.target.value })}
                        placeholder="Group name"
                        className={input}
                      />
                      <code className="block mt-0.5 text-[10px] text-muted-foreground/60 select-all break-all">{g.id}</code>
                    </td>
                    <td className={cell}>
                      <AppSelect
                        aria-label={`Client for ${names[g.id] || g.id}`}
                        value={g.client}
                        onChange={e => saveGroups(groups.map((r, j) => (j === i ? { ...r, client: e.target.value } : r)))}
                        className="!text-xs !h-8"
                      >
                        <option value="">No client (internal chat)</option>
                        {unknownClient && <option value={g.client}>{g.client} (not in Cirqle)</option>}
                        {clientNames.map(n => <option key={n} value={n}>{n}</option>)}
                      </AppSelect>
                      {unknownClient && (
                        <p className="mt-0.5 text-[10px] text-amber-500">No client with this name. Pick one, or add the client first.</p>
                      )}
                    </td>
                    <td className={cell}>
                      <button
                        type="button"
                        onClick={() => saveGroups(groups.filter((_, j) => j !== i))}
                        aria-label={`Stop reading ${names[g.id] || g.id}`}
                        title="Stop reading this chat"
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      ><X className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {seen.length > 0 && (
          <div className="mt-2">
            <p className="text-[11px] text-muted-foreground mb-1">
              Seen but not listed: chats the listener number is in. Nothing from them is stored except this line.
            </p>
            <ul className="divide-y divide-border border border-border rounded-lg">
              {seen.map(([id, info]) => (
                <li key={id} className="px-3 py-1.5 text-[11px] flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <code className="select-all break-all">{id}</code>
                    <span className="text-muted-foreground"> · last message from {info.by || 'unknown'} · {new Date(info.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                  </span>
                  <button type="button" onClick={() => addGroup(id)} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-secondary hover:text-foreground text-muted-foreground">
                    <Plus className="w-3 h-3" /> Read this chat
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            aria-label="Chat id to add"
            value={newChatId}
            onChange={e => setNewChatId(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGroup(addId) } }}
            placeholder="Chat id, e.g. 120363021234567890@g.us"
            spellCheck={false}
            className={`${input} font-mono flex-1 min-w-[220px]`}
          />
          <button type="button" disabled={!canAdd} onClick={() => addGroup(addId)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border bg-secondary text-xs disabled:opacity-40">
            <Plus className="w-3 h-3" /> Add chat
          </button>
          {addId && !canAdd && (
            <span className="text-[11px] text-amber-500">{listed.has(addId) ? 'Already in the table.' : 'Not a chat id. It ends in @g.us for a group.'}</span>
          )}
        </div>
      </div>

      {/* ── Cirqle numbers ── */}
      <div>
        <p className="text-xs font-medium text-foreground mb-0.5">Cirqle numbers</p>
        <p className="text-[11px] text-muted-foreground/60 mb-1.5">
          Every number Cirqle people post from: shared Cirqle lines, personal numbers used for work, and freelancers.
          Messages from these are never filed as requests, whoever is using the phone. Active employees&apos; saved phones count too.
        </p>
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-xs min-w-[420px]">
            <thead className="bg-secondary/50 border-b border-border">
              <tr>
                <th className={th}>Number</th>
                <th className={th}>Who uses it</th>
                <th className={`${th} w-8`}><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {numbers.length === 0 && (
                <tr><td colSpan={3} className="px-3 py-3 text-[11px] text-muted-foreground">No numbers yet. Add one below.</td></tr>
              )}
              {numbers.map((r, i) => {
                const key = phoneMatchKey(r.number)
                const problem = !r.number.trim() ? null : !key ? 'Not a full phone number.' : (keyCount.get(key) || 0) > 1 ? 'This number is in the table twice.' : null
                return (
                  <tr key={i}>
                    <td className={cell}>
                      <input
                        aria-label={`Number, row ${i + 1}`}
                        inputMode="tel"
                        value={r.number}
                        onChange={e => saveNumbers(numbers.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)))}
                        placeholder="+91 98765 43210"
                        className={`${input} font-mono`}
                      />
                      {problem && <p className="mt-0.5 text-[10px] text-amber-500">{problem}</p>}
                    </td>
                    <td className={cell}>
                      <input
                        aria-label={`Who uses the number, row ${i + 1}`}
                        list="wa-listener-people"
                        value={r.who}
                        onChange={e => saveNumbers(numbers.map((x, j) => (j === i ? { ...x, who: e.target.value } : x)))}
                        placeholder="e.g. Design line (shared), or Safoora (personal)"
                        className={input}
                      />
                    </td>
                    <td className={cell}>
                      <button
                        type="button"
                        onClick={() => saveNumbers(numbers.filter((_, j) => j !== i))}
                        aria-label={`Remove number, row ${i + 1}`}
                        title="Remove this number"
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      ><X className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <datalist id="wa-listener-people">
          {people.map(p => <option key={p} value={p} />)}
        </datalist>
        <button type="button" onClick={() => saveNumbers([...numbers, { number: '', who: '' }])} className="mt-2 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border bg-secondary text-xs">
          <Plus className="w-3 h-3" /> Add number
        </button>
      </div>
    </div>
  )
}
