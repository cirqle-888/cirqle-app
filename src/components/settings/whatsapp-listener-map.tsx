'use client'

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  LISTENER_KEYS, isChatId, parseGroupList, parseGroupNames, parseNumberRows, parseSeen, phoneMatchKey,
  serializeGroupList, serializeNumberList, type NumberRow,
} from '@/lib/whatsapp-listener/rules'
import { ACCESS_KEY, NO_ACCESS, parseAccess, serializeAccess, type ChatAccess } from '@/lib/whatsapp-listener/insights'

/**
 * The WhatsApp listener's two mappings as tables:
 *   groups  → which Cirqle client each WhatsApp chat belongs to
 *   numbers → which phone numbers are Cirqle's own (never filed as requests)
 * and, per chat, who is responsible for it and who may read it in Cirqle.
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
  /** Active employees, for "Responsible" and "Who can see". */
  staff: { id: string; cqid?: string | null; name?: string | null }[]
  /** Active departments, to share a chat with a whole team at once. */
  departments?: { id: string; name: string }[]
}

interface GroupRow { id: string; client: string }

const cell = 'px-2 py-1.5 align-middle'
const input = 'w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-xs'
const th = 'px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground'

export default function WhatsAppListenerMap({ settings, onChange, clients, people, staff, departments = [] }: Props) {
  // Rows live here while editing, so a half-typed row is not lost on the way
  // through the text format; every change is written back as text for Save.
  const [groups, setGroups] = useState<GroupRow[]>(() =>
    [...parseGroupList(settings[LISTENER_KEYS.groups])].map(([id, client]) => ({ id, client })))
  const [names, setNames] = useState<Record<string, string>>(() => parseGroupNames(settings[LISTENER_KEYS.groupNames]))
  const [numbers, setNumbers] = useState<NumberRow[]>(() => parseNumberRows(settings[LISTENER_KEYS.staffNumbers]))
  const [access, setAccess] = useState<Record<string, ChatAccess>>(() => parseAccess(settings[ACCESS_KEY]))
  const [newChatId, setNewChatId] = useState('')
  const [bulkDept, setBulkDept] = useState('')

  const clientNames = clients.filter(c => c.is_active !== false).map(c => c.name).sort((a, b) => a.localeCompare(b))
  const known = new Set(clients.map(c => c.name.toLowerCase()))

  function saveGroups(next: GroupRow[], nextNames = names) {
    setGroups(next)
    onChange(LISTENER_KEYS.groups, serializeGroupList(next))
    // Keep names only for chats still listed.
    const kept = Object.fromEntries(next.map(g => [g.id, (nextNames[g.id] || '').trim()]).filter(([, n]) => n))
    setNames(nextNames)
    onChange(LISTENER_KEYS.groupNames, JSON.stringify(kept))
    // A chat taken off the list loses its sharing too.
    onChange(ACCESS_KEY, serializeAccess(access, next.map(g => g.id)))
  }
  function saveAccess(chatId: string, change: Partial<ChatAccess>) {
    const next = { ...access, [chatId]: { ...(access[chatId] ?? NO_ACCESS), ...change } }
    setAccess(next)
    onChange(ACCESS_KEY, serializeAccess(next, groups.map(g => g.id)))
  }
  /** Shares every listed chat with one department in a single step. */
  function shareAllWith(departmentId: string) {
    if (!departmentId) return
    const next = { ...access }
    for (const g of groups) {
      const a: ChatAccess = { ...NO_ACCESS, ...next[g.id] }
      if (!a.departments.includes(departmentId)) next[g.id] = { ...a, departments: [...a.departments, departmentId] }
    }
    setAccess(next)
    onChange(ACCESS_KEY, serializeAccess(next, groups.map(g => g.id)))
  }
  // Staff show by CQID until names are unlocked, like everywhere else in the app.
  const { dn } = usePrivacy()
  const staffSorted = staff.map(e => ({ id: e.id, label: dn(e) })).sort((a, b) => a.label.localeCompare(b.label))
  const staffName = new Map(staffSorted.map(e => [e.id, e.label]))
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
          Each WhatsApp chat, the client it belongs to, who looks after it and who may read it in Cirqle.
          A chat that is not in this table is never read. {groups.length} listed.
        </p>
        <p className="text-[11px] text-muted-foreground/60 mb-1.5">
          Admins can read every chat. The responsible person can read their chat and is told when something in it is waiting on Cirqle.
        </p>
        {departments.length > 0 && groups.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-[11px] text-muted-foreground">Share every chat below with a department:</span>
            <AppSelect aria-label="Department to share every chat with" value={bulkDept} onChange={e => setBulkDept(e.target.value)} className="!text-xs !h-8 !w-auto">
              <option value="">Pick a department</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </AppSelect>
            <button type="button" disabled={!bulkDept} onClick={() => { shareAllWith(bulkDept); setBulkDept('') }}
              className="h-8 px-3 rounded-md text-xs border border-border bg-card hover:bg-secondary disabled:opacity-50">
              Add to all chats
            </button>
            <span className="text-[11px] text-muted-foreground/60">Nothing is saved until you press Save Settings.</span>
          </div>
        )}
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-xs min-w-[860px]">
            <thead className="bg-secondary/50 border-b border-border">
              <tr>
                <th className={th}>WhatsApp chat</th>
                <th className={th}>Cirqle client</th>
                <th className={th}>Responsible</th>
                <th className={th}>Who can see</th>
                <th className={`${th} w-8`}><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {groups.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-3 text-[11px] text-muted-foreground">No chats yet. Add one below.</td></tr>
              )}
              {groups.map((g, i) => {
                const unknownClient = !!g.client && !known.has(g.client.toLowerCase())
                // Spread over the defaults so a row saved before a field existed still has every field.
                const a: ChatAccess = { ...NO_ACCESS, ...access[g.id] }
                const label = names[g.id] || g.id
                const shared = [
                  ...departments.filter(d => a.departments.includes(d.id)).map(d => d.name),
                  ...(a.viewers.map(id => staffName.get(id)).filter(Boolean) as string[]),
                ]
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
                      <AppSelect
                        aria-label={`Responsible for ${label}`}
                        value={a.owner && staffName.has(a.owner) ? a.owner : ''}
                        onChange={e => saveAccess(g.id, { owner: e.target.value || null })}
                        className="!text-xs !h-8"
                      >
                        <option value="">{a.departments.length ? 'Whole department' : 'Nobody (admins are told)'}</option>
                        {staffSorted.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
                      </AppSelect>
                    </td>
                    <td className={cell}>
                      <AppSelect
                        aria-label={`Who can see ${label}`}
                        value={a.everyone ? 'everyone' : 'chosen'}
                        onChange={e => saveAccess(g.id, { everyone: e.target.value === 'everyone' })}
                        className="!text-xs !h-8"
                      >
                        <option value="chosen">Admins, chosen departments and people</option>
                        <option value="everyone">Everyone with Requests</option>
                      </AppSelect>
                      {!a.everyone && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-primary">
                            {shared.length ? `Shared with ${shared.join(', ')}` : 'Share with a department or people'}
                          </summary>
                          <div className="mt-1 max-h-48 overflow-y-auto border border-border rounded-md p-1.5 space-y-1">
                            {departments.length > 0 && <p className="text-[10px] font-medium text-muted-foreground">Departments</p>}
                            {departments.map(d => (
                              <label key={d.id} className="flex items-center gap-1.5 text-[11px]">
                                <input
                                  type="checkbox"
                                  checked={a.departments.includes(d.id)}
                                  onChange={ev => saveAccess(g.id, { departments: ev.target.checked ? [...a.departments, d.id] : a.departments.filter(v => v !== d.id) })}
                                />
                                {d.name}
                              </label>
                            ))}
                            {departments.length > 0 && <p className="pt-1 text-[10px] font-medium text-muted-foreground">People</p>}
                            {staffSorted.map(e => (
                              <label key={e.id} className="flex items-center gap-1.5 text-[11px]">
                                <input
                                  type="checkbox"
                                  checked={a.viewers.includes(e.id)}
                                  onChange={ev => saveAccess(g.id, { viewers: ev.target.checked ? [...a.viewers, e.id] : a.viewers.filter(v => v !== e.id) })}
                                />
                                {e.label}
                              </label>
                            ))}
                          </div>
                        </details>
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
