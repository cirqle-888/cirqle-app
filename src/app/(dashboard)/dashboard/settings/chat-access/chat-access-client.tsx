'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Building2, Check, Loader2, Search, ShieldCheck, User, X } from 'lucide-react'
import Header from '@/components/layout/header'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import { ACCESS_MODE_LABEL, effectiveRule, type ChatAccessContext, type ChatAccessMode, type ChatAccessRule } from '@/lib/chat/access'
import { saveChatAccessRule, removeChatAccessRule, type ChatAccessSettings } from '../../chat/actions-plus'

type Subject = { type: 'department' | 'employee'; id: string }
const MODE_HELP: Record<ChatAccessMode, string> = {
  everyone: 'Can chat with anyone in the company.',
  own_department: 'Can chat only with people in the same department.',
  custom: 'Same department, plus the departments and people you tick below.',
  none: 'Cannot start or continue direct chats. Channels they are in still work.',
}

export default function ChatAccessClient({ settings, error }: { settings: ChatAccessSettings | null; error: string | null }) {
  const { revealNames } = usePermissions()
  const [rules, setRules] = useState<ChatAccessRule[]>(settings?.rules ?? [])
  const [saving, setSaving] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Subject | null>(null)

  const departments = useMemo(() => settings?.departments ?? [], [settings])
  const employees = useMemo(() => settings?.employees ?? [], [settings])
  const label = (e: { name: string; cqid: string }) => displayEmployee(e, { revealNames, canReveal: true })
  const deptName = (id: string) => departments.find(d => d.id === id)?.name ?? 'Department'

  const ctx: ChatAccessContext = useMemo(() => ({
    rules,
    departmentsByEmployee: new Map(employees.map(e => [e.id, new Set(e.departmentIds)])),
    adminIds: new Set(employees.filter(e => e.isAdmin).map(e => e.id)),
    defaultVisible: () => null,
  }), [rules, employees])

  const ruleFor = (s: Subject) => rules.find(r => r.subjectType === s.type && r.subjectId === s.id) ?? null

  async function save(s: Subject, patch: Partial<Pick<ChatAccessRule, 'mode' | 'departmentIds' | 'employeeIds'>> | null) {
    const key = `${s.type}:${s.id}`
    const before = rules
    setSaving(key); setMessage(null)
    if (patch === null) {
      setRules(rules.filter(r => !(r.subjectType === s.type && r.subjectId === s.id)))
      const res = await removeChatAccessRule(s.type, s.id)
      if (!res.ok) { setRules(before); setMessage({ ok: false, text: res.error }) } else setMessage({ ok: true, text: 'Saved' })
    } else {
      const current = ruleFor(s)
      const next: ChatAccessRule = {
        subjectType: s.type, subjectId: s.id,
        mode: patch.mode ?? current?.mode ?? 'own_department',
        departmentIds: patch.departmentIds ?? current?.departmentIds ?? [],
        employeeIds: patch.employeeIds ?? current?.employeeIds ?? [],
      }
      setRules([...rules.filter(r => !(r.subjectType === s.type && r.subjectId === s.id)), next])
      const res = await saveChatAccessRule(next)
      if (!res.ok) { setRules(before); setMessage({ ok: false, text: res.error }) } else setMessage({ ok: true, text: 'Saved' })
    }
    setSaving(null)
  }

  if (!settings) {
    return (
      <div className="space-y-5">
        <Header title="Chat access" subtitle="Who can chat with whom" />
        <p className="text-sm text-red-500">{error ?? 'Could not load chat access.'}</p>
      </div>
    )
  }

  const shownEmployees = employees.filter(e => {
    const t = q.trim().toLowerCase()
    return !t || e.cqid.toLowerCase().includes(t) || (revealNames && e.name.toLowerCase().includes(t))
  })

  // A plain function, not a component: a component declared inside another is
  // re-created on every render and would remount each row (closing its menu).
  const renderRow = ({ subject, title, sub, icon: Icon, defaultLabel }: {
    subject: Subject; title: string; sub: string; icon: typeof User; defaultLabel: string
  }) => {
    const rule = ruleFor(subject)
    const key = `${subject.type}:${subject.id}`
    const isOpen = open?.type === subject.type && open.id === subject.id
    const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id])
    return (
      <div key={key} className="border-b border-border last:border-b-0">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{title}</p>
            <p className="truncate text-xs text-muted-foreground">{sub}</p>
          </div>
          {saving === key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <select
            aria-label={`Chat access for ${title}`}
            value={rule?.mode ?? ''}
            onChange={e => {
              const v = e.target.value as ChatAccessMode | ''
              if (v === '') { void save(subject, null); setOpen(null) }
              else { void save(subject, { mode: v }); setOpen(v === 'custom' ? subject : null) }
            }}
            className="h-9 max-w-full rounded-lg border border-border bg-secondary px-2 text-sm"
          >
            <option value="">{defaultLabel}</option>
            {(Object.keys(ACCESS_MODE_LABEL) as ChatAccessMode[]).map(m => <option key={m} value={m}>{ACCESS_MODE_LABEL[m]}</option>)}
          </select>
          {rule?.mode === 'custom' && (
            <button onClick={() => setOpen(isOpen ? null : subject)} className="h-9 rounded-lg border border-border px-3 text-sm text-muted-foreground hover:text-foreground">
              {isOpen ? 'Done' : `Chosen: ${rule.departmentIds.length + rule.employeeIds.length}`}
            </button>
          )}
        </div>
        {rule && <p className="px-4 pb-3 pl-11 text-xs text-muted-foreground">{MODE_HELP[rule.mode]}</p>}
        {rule?.mode === 'custom' && isOpen && (
          <div className="space-y-3 border-t border-border bg-muted/30 px-4 py-3 pl-11">
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Also these departments</p>
              <div className="flex flex-wrap gap-1.5">
                {departments.filter(d => !(subject.type === 'department' && d.id === subject.id)).map(d => {
                  const on = rule.departmentIds.includes(d.id)
                  return (
                    <button key={d.id} onClick={() => void save(subject, { departmentIds: toggle(rule.departmentIds, d.id) })}
                      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm ${on ? 'border-violet-500/60 bg-violet-500/15' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                      {on && <Check className="h-3 w-3" />}{d.name}
                    </button>
                  )
                })}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Also these people</p>
              <div className="flex flex-wrap gap-1.5">
                {employees.filter(e => !(subject.type === 'employee' && e.id === subject.id) && !e.isAdmin).map(e => {
                  const on = rule.employeeIds.includes(e.id)
                  return (
                    <button key={e.id} onClick={() => void save(subject, { employeeIds: toggle(rule.employeeIds, e.id) })}
                      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm ${on ? 'border-violet-500/60 bg-violet-500/15' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                      {on && <Check className="h-3 w-3" />}{label(e)}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5 pb-10">
      <Header title="Chat access" subtitle="Decide who can chat with whom — by department, and person by person" />
      <Link href="/dashboard/chat" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to chat
      </Link>

      {!settings.ready && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          The chat upgrade has not been applied to the database yet, so rules cannot be saved.
        </p>
      )}

      <div className="rounded-2xl border border-border bg-card p-4 text-sm leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-2 font-medium text-foreground"><ShieldCheck className="h-4 w-4 text-violet-500" /> How it works</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>A rule on a <b className="text-foreground">department</b> applies to everyone in it. A rule on a <b className="text-foreground">person</b> wins over their department.</li>
          <li>It controls who a person can find, start a direct chat with, keep chatting with, and add to a group.</li>
          <li>Both sides must be allowed. If Social Media is “own department only”, nobody outside can message them either.</li>
          <li>Admins are never cut off — anyone can reach an admin and an admin can reach anyone.</li>
          <li>With no rule, people can reach the colleagues they share work with (as before).</li>
        </ul>
      </div>

      {message && (
        <p className={`flex items-center gap-1.5 text-sm ${message.ok ? 'text-green-500' : 'text-red-500'}`}>
          {message.ok ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />} {message.text}
        </p>
      )}

      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">Departments</div>
        {departments.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">No departments are set up yet (Settings → Departments).</p>}
        {departments.map(d => {
          const count = employees.filter(e => e.departmentIds.includes(d.id)).length
          return renderRow({ subject: { type: 'department', id: d.id }, title: d.name, icon: Building2,
            sub: `${count} ${count === 1 ? 'person' : 'people'}`, defaultLabel: 'Default (shared work)' })
        })}
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">People</span>
          <div className="ml-auto flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search" className="w-36 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
        </div>
        {shownEmployees.map(e => {
          const eff = effectiveRule(ctx, e.id)
          const depts = e.departmentIds.map(deptName).join(', ') || 'No department'
          const follows = e.isAdmin ? 'Admin — always reaches everyone'
            : eff && eff.source === 'department' ? `From department: ${ACCESS_MODE_LABEL[eff.mode]}` : 'Default (shared work)'
          return renderRow({ subject: { type: 'employee', id: e.id }, title: label(e), icon: User,
            sub: depts, defaultLabel: `Follow department — ${follows.replace('From department: ', '')}` })
        })}
        {shownEmployees.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">Nobody matches.</p>}
      </section>
    </div>
  )
}
