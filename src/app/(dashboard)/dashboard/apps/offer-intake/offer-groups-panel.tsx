'use client'

import { useState } from 'react'
import { Plus, Trash2, Loader2, Check, X, Layers, ExternalLink } from 'lucide-react'
import { upsertOfferGroup, deleteOfferGroup, type OfferGroupRow } from './actions'

const inputCls =
  'w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-violet-500/50 transition-colors'

type Draft = {
  id?: string
  name: string
  sheetUrl: string
  sheetTabName: string
  masterTabName: string
  appsScriptUrl: string
  figmaUrl: string
}

const emptyDraft = (): Draft => ({
  id: undefined, name: '', sheetUrl: '', sheetTabName: '', masterTabName: '', appsScriptUrl: '', figmaUrl: '',
})

function toDraft(group: OfferGroupRow): Draft {
  return {
    id: group.id,
    name: group.name,
    sheetUrl: group.sheet_url || '',
    sheetTabName: group.sheet_tab_name || '',
    masterTabName: group.master_tab_name || '',
    appsScriptUrl: group.apps_script_url || '',
    figmaUrl: group.integrations?.figma?.file_url || '',
  }
}

/**
 * Per-client offer categories — one flyer output stream each (Groceries,
 * Vegetables, …), with its own Google Sheet and Figma file.
 *
 * A client with none of these behaves exactly as before: the sync keeps using
 * the client-level Sheet link, and the intake editor shows no tabs. Categories
 * are only worth adding when a client genuinely produces separate flyers.
 */
export function OfferGroupsPanel({
  clientId,
  flowMode,
  groups: initialGroups,
  onChanged,
}: {
  clientId: string
  flowMode: 'push' | 'pull' | 'manual'
  groups: OfferGroupRow[]
  onChanged?: (groups: OfferGroupRow[]) => void
}) {
  const [groups, setGroups] = useState(initialGroups)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const isPull = flowMode === 'pull'

  function update(next: OfferGroupRow[]) {
    setGroups(next)
    onChanged?.(next)
  }

  async function save() {
    if (!draft) return
    setSaving(true); setErr(null)
    const res = await upsertOfferGroup({
      id: draft.id,
      clientId,
      name: draft.name,
      sheetUrl: draft.sheetUrl,
      sheetTabName: draft.sheetTabName,
      masterTabName: draft.masterTabName,
      appsScriptUrl: draft.appsScriptUrl,
      figmaUrl: draft.figmaUrl,
    })
    setSaving(false)
    if (!res.ok) { setErr(res.error || 'Could not save'); return }

    const row: OfferGroupRow = {
      id: res.data!.id,
      client_id: clientId,
      name: draft.name.trim(),
      slug: draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      sheet_url: draft.sheetUrl.trim() || null,
      sheet_tab_name: draft.sheetTabName.trim() || null,
      master_tab_name: draft.masterTabName.trim() || null,
      apps_script_url: draft.appsScriptUrl.trim() || null,
      integrations: draft.figmaUrl.trim() ? { figma: { file_url: draft.figmaUrl.trim() } } : {},
      display_order: groups.length,
      is_active: true,
      last_pulled_at: groups.find(g => g.id === res.data!.id)?.last_pulled_at ?? null,
    }
    update(draft.id ? groups.map(g => (g.id === row.id ? row : g)) : [...groups, row])
    setDraft(null)
  }

  async function remove(group: OfferGroupRow) {
    if (!confirm(`Remove the “${group.name}” category? Products already saved under it stay in their campaigns and move back to the default list.`)) return
    const res = await deleteOfferGroup(group.id)
    if (!res.ok) { setErr(res.error || 'Could not delete'); return }
    update(groups.filter(g => g.id !== group.id))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-white/70">
          <Layers className="w-3.5 h-3.5 text-violet-400" /> Categories
          <span className="text-white/30 font-normal">{groups.length || 'none'}</span>
        </div>
        {!draft && (
          <button
            onClick={() => setDraft(emptyDraft())}
            className="flex items-center gap-1 text-xs font-medium text-violet-300 hover:text-violet-200 transition-colors"
          >
            <Plus className="w-3 h-3" /> Add category
          </button>
        )}
      </div>

      <p className="text-[11px] text-white/35 mb-3 leading-relaxed">
        {isPull
          ? 'Each category reads one tab of the client’s master sheet. Leave this empty if their sheet has a single list.'
          : 'Only needed when a client gets more than one flyer (e.g. Groceries and Vegetables). Give each category its OWN Google Sheet — the Figma plugin reads only the first tab of a sheet, so two categories sharing one sheet would leave the second one unread. With no categories, this client keeps using the single Sheet link above.'}
      </p>

      {groups.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {groups.map(group => {
            const figma = group.integrations?.figma?.file_url
            return (
              <div key={group.id} className="flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white/80 truncate">{group.name}</div>
                  <div className="text-[11px] text-white/35 truncate">
                    {isPull
                      ? (group.master_tab_name ? `Reads tab “${group.master_tab_name}”` : 'No source tab set')
                      : (group.sheet_url
                          ? `Own sheet${group.sheet_tab_name ? ` · tab “${group.sheet_tab_name}”` : ''}`
                          : 'Uses the client’s main sheet')}
                    {group.last_pulled_at && ` · pulled ${new Date(group.last_pulled_at).toLocaleDateString()}`}
                  </div>
                </div>
                {figma && (
                  <a href={figma} target="_blank" rel="noopener noreferrer" title="Open the Figma file"
                     className="shrink-0 p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                <button onClick={() => setDraft(toDraft(group))}
                        className="shrink-0 text-[11px] font-medium text-white/50 hover:text-white transition-colors px-2">
                  Edit
                </button>
                <button onClick={() => void remove(group)} title="Remove category"
                        className="shrink-0 p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {draft && (
        <div className="rounded-xl bg-white/5 border border-violet-500/25 p-3 space-y-2">
          <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
                 placeholder="Category name (e.g. Vegetables)" className={inputCls} autoFocus />

          {isPull ? (
            <input value={draft.masterTabName} onChange={e => setDraft({ ...draft, masterTabName: e.target.value })}
                   placeholder="Tab name in the client's master sheet (e.g. Vegetables)" className={inputCls} />
          ) : (
            <>
              <input value={draft.sheetUrl} onChange={e => setDraft({ ...draft, sheetUrl: e.target.value })}
                     placeholder="Google Sheet link for this category — give it its own sheet" className={inputCls} />
              <input value={draft.sheetTabName} onChange={e => setDraft({ ...draft, sheetTabName: e.target.value })}
                     placeholder="Tab name (leave blank — Figma reads the first tab only)" className={inputCls} />
            </>
          )}

          <input value={draft.figmaUrl} onChange={e => setDraft({ ...draft, figmaUrl: e.target.value })}
                 placeholder="Figma file link (optional)" className={inputCls} />

          <details>
            <summary className="text-[11px] text-white/35 cursor-pointer hover:text-white/60 transition-colors">
              Advanced: own Apps Script for this category
            </summary>
            <input value={draft.appsScriptUrl} onChange={e => setDraft({ ...draft, appsScriptUrl: e.target.value })}
                   placeholder="https://script.google.com/macros/s/…/exec" className={inputCls + ' mt-2'} />
          </details>

          {err && <div className="text-[11px] text-red-300">{err}</div>}

          <div className="flex items-center gap-2 pt-1">
            <button onClick={() => void save()} disabled={saving || !draft.name.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              {draft.id ? 'Save' : 'Add'}
            </button>
            <button onClick={() => { setDraft(null); setErr(null) }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white/50 hover:text-white transition-colors">
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
