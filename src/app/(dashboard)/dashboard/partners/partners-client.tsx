'use client'

import { FormField, FormLabel, FormControl } from '@/components/ui/form'

import { useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { Plus, Handshake, ChevronRight, Edit2 } from 'lucide-react'
import { createPartner, updatePartner, type PartnerInput } from './actions'
import type { BusinessPartner } from '@/lib/partners/queries'

interface ClientRow { id: string; name: string; code: string; business_partner_id: string | null }

interface Props {
  initialPartners: BusinessPartner[]
  allClients: ClientRow[]
  canCreate: boolean
  canEdit: boolean
}

const EMPTY_FORM: PartnerInput = {
  partnerCode: '',
  name: '',
  company: null,
  phone: null,
  email: null,
  commissionType: null,
  commissionValue: null,
  notes: null,
}

/** Next sequential code (BP-001, BP-002, …) from the highest numeric suffix in use. */
function nextPartnerCode(existing: BusinessPartner[]): string {
  const nums = existing
    .map(p => parseInt((p.partner_code || '').replace(/\D/g, ''), 10))
    .filter(n => Number.isFinite(n))
  return `BP-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`
}

export default function PartnersClient({ initialPartners, allClients, canCreate, canEdit }: Props) {
  const [partners, setPartners] = useState(initialPartners)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<BusinessPartner | null>(null)
  const [form, setForm] = useState<PartnerInput>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY_FORM, partnerCode: nextPartnerCode(partners) })
    setError(null)
    setModalOpen(true)
  }

  function openEdit(p: BusinessPartner) {
    setEditing(p)
    setForm({
      partnerCode: p.partner_code,
      name: p.name,
      company: p.company,
      phone: p.phone,
      email: p.email,
      commissionType: p.commission_type,
      commissionValue: p.commission_value,
      notes: p.notes,
    })
    setError(null)
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setError('Partner name is required.')
      return
    }
    setSaving(true)
    setError(null)
    const result = editing
      ? await updatePartner(editing.id, form)
      : await createPartner(form)

    if (!result.ok) {
      setError(result.error || 'Something went wrong.')
      setSaving(false)
      return
    }

    if (editing) {
      setPartners(prev => prev.map(p => p.id === editing.id ? { ...p, ...toPartnerPatch(form) } : p))
    } else if ('data' in result && result.data) {
      setPartners(prev => [...prev, { id: result.data!.id, status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...toPartnerPatch(form) } as BusinessPartner])
    }
    setSaving(false)
    setModalOpen(false)
  }

  const clientCountByPartner = new Map<string, number>()
  for (const c of allClients) {
    if (!c.business_partner_id) continue
    clientCountByPartner.set(c.business_partner_id, (clientCountByPartner.get(c.business_partner_id) || 0) + 1)
  }

  return (
    <>
      <Header
        title="Business Partners"
        subtitle="Referral partners and their consolidated collection statements"
        actions={canCreate ? (
          <button onClick={openCreate} className="gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg flex items-center gap-1.5 hover:opacity-90">
            <Plus className="w-4 h-4" /> Add Partner
          </button>
        ) : undefined}
      />

      <div className="p-4 sm:p-6">
        {partners.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Handshake className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No business partners yet.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {partners.map(p => (
              <div key={p.id} className="bg-secondary border border-border rounded-xl p-4 hover:border-primary/40 transition-colors">
                <div className="flex items-start justify-between">
                  <Link href={`/dashboard/partners/${p.id}`} className="flex-1 min-w-0">
                    <div className="font-medium text-foreground truncate">{p.name}</div>
                    <div className="text-xs text-muted-foreground">{p.partner_code}{p.company ? ` · ${p.company}` : ''}</div>
                  </Link>
                  {canEdit && (
                    <button onClick={() => openEdit(p)} className="p-1.5 rounded-md hover:bg-background text-muted-foreground">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{clientCountByPartner.get(p.id) || 0} client(s)</span>
                  <span className={`px-2 py-0.5 rounded-full font-medium ${p.status === 'active' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>
                    {p.status === 'active' ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <Link href={`/dashboard/partners/${p.id}`} className="mt-3 flex items-center justify-center gap-1 text-xs font-medium text-primary hover:underline">
                  View dashboard <ChevronRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>

      {modalOpen && (
        <ModalOverlay onClose={() => setModalOpen(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-md p-5">
            <h2 className="text-base font-semibold text-foreground mb-4">{editing ? 'Edit Business Partner' : 'Add Business Partner'}</h2>
            <div className="space-y-3">
              <Field label="Partner Code (auto)" value={form.partnerCode} onChange={v => setForm(f => ({ ...f, partnerCode: v }))} />
              <Field label="Name *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} />
              <Field label="Company" value={form.company ?? ''} onChange={v => setForm(f => ({ ...f, company: v || null }))} />
              <Field label="Phone" value={form.phone ?? ''} onChange={v => setForm(f => ({ ...f, phone: v || null }))} />
              <Field label="Email" value={form.email ?? ''} onChange={v => setForm(f => ({ ...f, email: v || null }))} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Commission Type</label>
                  <select
                    value={form.commissionType ?? ''}
                    onChange={e => setForm(f => ({ ...f, commissionType: (e.target.value || null) as PartnerInput['commissionType'] }))}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                  >
                    <option value="">None</option>
                    <option value="percentage">Percentage</option>
                    <option value="flat">Flat</option>
                  </select>
                </div>
                <Field
                  label="Commission Value"
                  value={form.commissionValue?.toString() ?? ''}
                  onChange={v => setForm(f => ({ ...f, commissionValue: v ? Number(v) : null }))}
                  type="number"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Notes</label>
                <textarea
                  value={form.notes ?? ''}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value || null }))}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                  rows={2}
                />
              </div>
              {error && <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">{error}</div>}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setModalOpen(false)} className="flex-1 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving} className="flex-1 gradient-bg text-white text-sm font-medium py-2 rounded-lg disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </>
  )
}

function toPartnerPatch(form: PartnerInput) {
  return {
    partner_code: form.partnerCode,
    name: form.name,
    company: form.company,
    phone: form.phone,
    email: form.email,
    commission_type: form.commissionType,
    commission_value: form.commissionValue,
    notes: form.notes,
  }
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <FormField>
      <FormLabel className="block text-xs font-medium">{label}</FormLabel>
      <FormControl>
        <input
          type={type}
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground"
        />
      </FormControl>
    </FormField>
  )
}
