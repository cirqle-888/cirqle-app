'use client'

import { useState } from 'react'
import Link from 'next/link'
import Combobox from '@/components/ui/combobox'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  ArrowLeft, Plus, Copy, Check, Ban, RefreshCw, Link2, Building2, Megaphone,
  Globe, AlertTriangle, Loader2, Pencil, X,
} from 'lucide-react'
import {
  createIntakeLink, revokeIntakeLink, regenerateIntakeLink,
  saveAgency, deactivateAgency, type AgencyInput,
} from './actions'

const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

const TYPE_META: Record<string, { label: string; icon: any; cls: string }> = {
  client:  { label: 'Client',  icon: Building2, cls: 'bg-violet-500/12 text-violet-300 border-violet-500/25' },
  agency:  { label: 'Agency',  icon: Megaphone, cls: 'bg-blue-500/12 text-blue-400 border-blue-500/25' },
  generic: { label: 'Generic', icon: Globe,     cls: 'bg-secondary text-muted-foreground border-border' },
}

export default function IntakeLinksClient({
  migrated, initialLinks, initialAgencies, clients, appUrl,
}: {
  migrated: boolean
  initialLinks: any[]
  initialAgencies: any[]
  clients: { id: string; name: string; code?: string }[]
  appUrl: string
}) {
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [links, setLinks] = useState(initialLinks)
  const [agencies, setAgencies] = useState(initialAgencies)
  const [creating, setCreating] = useState(false)
  const [newType, setNewType] = useState<'client' | 'agency' | 'generic'>('client')
  const [newClientId, setNewClientId] = useState('')
  const [newAgencyId, setNewAgencyId] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [agencyForm, setAgencyForm] = useState<AgencyInput | null>(null)
  const [agencySaving, setAgencySaving] = useState(false)

  const urlFor = (token: string) => `${appUrl}/intake/${token}`

  async function copyUrl(link: any) {
    await navigator.clipboard.writeText(urlFor(link.token))
    setCopied(link.id); setTimeout(() => setCopied(null), 1500)
  }

  async function handleCreate() {
    setCreating(true)
    const res = await createIntakeLink({
      type: newType,
      client_id: newType === 'client' ? newClientId : null,
      agency_id: newType === 'agency' ? newAgencyId : null,
      label: newLabel,
    })
    setCreating(false)
    if (res.ok && res.data) {
      setLinks(prev => [res.data!.row, ...prev])
      setNewLabel(''); setNewClientId(''); setNewAgencyId('')
      success('Intake link created', 'Copy the URL and share it')
    } else toastError('Could not create link', res.error)
  }

  async function handleRevoke(link: any) {
    if (!confirm('Revoke this link? Anyone using the URL will see "link expired".')) return
    setBusy(link.id)
    const res = await revokeIntakeLink(link.id)
    setBusy(null)
    if (res.ok) setLinks(prev => prev.map(l => l.id === link.id ? { ...l, is_active: false } : l))
    else toastError('Revoke failed', res.error)
  }

  async function handleRegenerate(link: any) {
    if (!confirm('Regenerate? The old URL dies immediately and a new one is issued.')) return
    setBusy(link.id)
    const res = await regenerateIntakeLink(link.id)
    setBusy(null)
    if (res.ok && res.data) {
      setLinks(prev => [res.data!.row, ...prev.map(l => l.id === link.id ? { ...l, is_active: false } : l)])
      success('Link regenerated', 'Share the new URL — the old one is dead')
    } else toastError('Regenerate failed', res.error)
  }

  async function handleAgencySave() {
    if (!agencyForm) return
    setAgencySaving(true)
    const res = await saveAgency(agencyForm)
    setAgencySaving(false)
    if (res.ok && res.data) {
      const row = res.data.row
      setAgencies(prev => agencyForm.id ? prev.map(a => a.id === row.id ? row : a) : [...prev, row])
      setAgencyForm(null)
      success(`Agency "${row.name}" saved`)
    } else toastError('Could not save agency', res.error)
  }

  async function handleAgencyDeactivate(a: any) {
    if (!confirm(`Deactivate ${a.name}? Their intake links will be revoked too.`)) return
    const res = await deactivateAgency(a.id)
    if (res.ok) {
      setAgencies(prev => prev.filter(x => x.id !== a.id))
      setLinks(prev => prev.map(l => l.agency_id === a.id ? { ...l, is_active: false } : l))
    } else toastError('Deactivate failed', res.error)
  }

  const activeLinks = links.filter(l => l.is_active)
  const revokedLinks = links.filter(l => !l.is_active)

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
      <Link href="/dashboard/settings" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="w-4 h-4" /> Back to Settings
      </Link>
      <div className="flex items-center gap-2.5 mb-1">
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center"><Link2 className="w-4.5 h-4.5 text-primary" /></div>
        <div>
          <h1 className="text-lg font-bold">Client &amp; Agency Intake Links</h1>
          <p className="text-xs text-muted-foreground">Share a link so clients/agencies can submit requests — no login, no app access.</p>
        </div>
      </div>

      {!migrated && (
        <div className="mt-4 flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-300">
            The Request Portal tables aren&apos;t set up yet. Run <code className="font-mono text-xs">supabase/migrations/20260610120000_request_portal.sql</code> in the Supabase SQL editor first.
          </p>
        </div>
      )}

      {/* Create link */}
      <div className="bg-card border border-border rounded-2xl p-5 mt-5">
        <p className="font-semibold text-sm mb-3">New intake link</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Type</label>
            <select value={newType} onChange={e => setNewType(e.target.value as any)} className={inputCls}>
              <option value="client">Client (scoped to one client)</option>
              <option value="agency">Agency (scoped to one agency)</option>
              <option value="generic">Generic (anyone with the link)</option>
            </select>
          </div>
          {newType === 'client' && (
            <div>
              <label className={labelCls}>Client</label>
              <Combobox options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
                value={newClientId} onChange={setNewClientId} placeholder="Search client…" sortKey="clients" />
            </div>
          )}
          {newType === 'agency' && (
            <div>
              <label className={labelCls}>Agency</label>
              <Combobox options={agencies.map(a => ({ id: a.id, label: a.name }))}
                value={newAgencyId} onChange={setNewAgencyId} placeholder="Search agency…" />
            </div>
          )}
          <div>
            <label className={labelCls}>Label <span className="text-muted-foreground/60">(optional)</span></label>
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} className={inputCls} placeholder="e.g. Sea Star — main" />
          </div>
        </div>
        <button onClick={handleCreate}
          disabled={creating || !migrated || (newType === 'client' && !newClientId) || (newType === 'agency' && !newAgencyId)}
          className="mt-4 flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create link
        </button>
      </div>

      {/* Active links */}
      <p className="font-semibold text-sm mt-6 mb-2">Active links ({activeLinks.length})</p>
      <div className="space-y-2">
        {activeLinks.length === 0 && (
          <div className="bg-card border border-border rounded-xl px-5 py-8 text-center text-sm text-muted-foreground">No active links yet.</div>
        )}
        {activeLinks.map(l => {
          const meta = TYPE_META[l.type] || TYPE_META.generic
          const who = l.type === 'client' ? (l.client ? `${l.client.name}${l.client.code ? ' · ' + l.client.code : ''}` : '—')
            : l.type === 'agency' ? (l.agency?.name || '—') : 'Anyone with the link'
          return (
            <div key={l.id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3">
              <span className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${meta.cls}`}>{meta.label}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{who}{l.label ? <span className="text-muted-foreground font-normal"> · {l.label}</span> : null}</p>
                <p className="text-[11px] font-mono text-muted-foreground/70 truncate">{urlFor(l.token)}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => copyUrl(l)} title="Copy URL"
                  className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                  {copied === l.id ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => handleRegenerate(l)} disabled={busy === l.id} title="Regenerate (old URL dies)"
                  className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => handleRevoke(l)} disabled={busy === l.id} title="Revoke"
                  className="p-1.5 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-40">
                  <Ban className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Agencies */}
      <div className="flex items-center justify-between mt-8 mb-2">
        <p className="font-semibold text-sm">Agencies ({agencies.length})</p>
        <button onClick={() => setAgencyForm({ name: '' })}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
          <Plus className="w-3.5 h-3.5" /> Add agency
        </button>
      </div>

      {agencyForm && (
        <div className="bg-card border border-border rounded-2xl p-5 mb-3">
          <div className="flex items-center justify-between mb-3">
            <p className="font-semibold text-sm">{agencyForm.id ? 'Edit agency' : 'New agency'}</p>
            <button onClick={() => setAgencyForm(null)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className={labelCls}>Name *</label>
              <input autoFocus value={agencyForm.name} onChange={e => setAgencyForm(f => f && ({ ...f, name: e.target.value }))} className={inputCls} placeholder="e.g. BrightAds Media" /></div>
            <div><label className={labelCls}>Contact name</label>
              <input value={agencyForm.contact_name || ''} onChange={e => setAgencyForm(f => f && ({ ...f, contact_name: e.target.value }))} className={inputCls} /></div>
            <div><label className={labelCls}>Email</label>
              <input value={agencyForm.email || ''} onChange={e => setAgencyForm(f => f && ({ ...f, email: e.target.value }))} className={inputCls} /></div>
            <div><label className={labelCls}>Phone</label>
              <input value={agencyForm.phone || ''} onChange={e => setAgencyForm(f => f && ({ ...f, phone: e.target.value }))} className={inputCls} /></div>
          </div>
          <button onClick={handleAgencySave} disabled={agencySaving || !agencyForm.name.trim()}
            className="mt-4 flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
            {agencySaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save agency
          </button>
        </div>
      )}

      <div className="space-y-2">
        {agencies.map(a => (
          <div key={a.id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3">
            <Megaphone className="w-4 h-4 text-blue-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{a.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">{[a.contact_name, a.email, a.phone].filter(Boolean).join(' · ') || '—'}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => setAgencyForm({ id: a.id, name: a.name, contact_name: a.contact_name || '', email: a.email || '', phone: a.phone || '' })}
                className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"><Pencil className="w-3.5 h-3.5" /></button>
              <button onClick={() => handleAgencyDeactivate(a)}
                className="p-1.5 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"><Ban className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        ))}
      </div>

      {/* Revoked */}
      {revokedLinks.length > 0 && (
        <details className="mt-6">
          <summary className="text-xs text-muted-foreground cursor-pointer">Revoked links ({revokedLinks.length})</summary>
          <div className="space-y-1.5 mt-2">
            {revokedLinks.map(l => (
              <div key={l.id} className="bg-card/50 border border-border/50 rounded-xl px-4 py-2 flex items-center gap-3 opacity-60">
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-secondary text-muted-foreground border-border shrink-0">{TYPE_META[l.type]?.label || l.type}</span>
                <p className="text-xs truncate flex-1">{l.client?.name || l.agency?.name || 'Generic'}{l.label ? ` · ${l.label}` : ''}</p>
                <span className="text-[10px] text-red-400/70 shrink-0">revoked</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
