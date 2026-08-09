'use client'

import { useState } from 'react'
import { Plus, Trash2, Loader2, Check, X, Layers, ExternalLink } from 'lucide-react'
import { upsertOfferGroup, deleteOfferGroup, type OfferGroupRow } from './actions'
import { FigmaLink } from '@/components/offer/figma-link'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

// Matches the rest of this settings page. Theme TOKENS, not hardcoded white —
// this page renders on a light background, where text-white is invisible.
const inputCls =
  'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'

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
  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so Remove would
  // silently do nothing there.
  const [removeTarget, setRemoveTarget] = useState<OfferGroupRow | null>(null)

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
    const res = await deleteOfferGroup(group.id)
    if (!res.ok) { setErr(res.error || 'Could not delete'); return }
    update(groups.filter(g => g.id !== group.id))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Layers className="w-3.5 h-3.5 text-violet-500" /> Categories
          <span className="text-muted-foreground font-normal">{groups.length || 'none'}</span>
        </div>
        {!draft && (
          <button
            onClick={() => setDraft(emptyDraft())}
            className="flex items-center gap-1 text-xs font-medium text-violet-500 hover:text-violet-400 transition-colors"
          >
            <Plus className="w-3 h-3" /> Add category
          </button>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
        {isPull
          ? 'Each category reads one tab of the client’s master sheet. Leave this empty if their sheet has a single list.'
          : 'Only needed when a client gets more than one flyer (e.g. Groceries and Vegetables). Give each category its OWN Google Sheet — the Figma plugin reads only the first tab of a sheet, so two categories sharing one sheet would leave the second one unread. With no categories, this client keeps using the single Sheet link above.'}
      </p>

      {groups.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {groups.map(group => {
            const figma = group.integrations?.figma?.file_url
            return (
              <div key={group.id} className="flex items-center gap-2 rounded-xl bg-secondary border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-foreground truncate">{group.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {isPull
                      ? (group.master_tab_name ? `Reads tab “${group.master_tab_name}”` : 'No source tab set')
                      : (group.sheet_url
                          ? `Own sheet${group.sheet_tab_name ? ` · tab “${group.sheet_tab_name}”` : ''}`
                          : 'Uses the client’s main sheet')}
                    {group.last_pulled_at && ` · pulled ${new Date(group.last_pulled_at).toLocaleDateString()}`}
                  </div>
                </div>
                {group.sheet_url && (
                  <a href={group.sheet_url} target="_blank" rel="noopener noreferrer" title="Open this category's Google Sheet"
                     className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-background transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                {figma && (
                  <FigmaLink url={figma} title="Open in the Figma desktop app"
                     className="shrink-0 px-2 py-1 rounded-lg text-[11px] font-semibold text-violet-500 hover:bg-violet-500/10 transition-colors">
                    Figma
                  </FigmaLink>
                )}
                <button onClick={() => setDraft(toDraft(group))}
                        className="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors px-2">
                  Edit
                </button>
                <button onClick={() => setRemoveTarget(group)} title="Remove category"
                        className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {draft && (
        <div className="rounded-xl bg-secondary/60 border border-violet-500/25 p-3 space-y-2">
          <label className="block">
            <span className="block text-[11px] font-medium text-muted-foreground mb-1">Category name</span>
            <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
                   placeholder="e.g. Vegetables" className={inputCls} autoFocus />
          </label>

          {isPull ? (
            <label className="block">
              <span className="block text-[11px] font-medium text-muted-foreground mb-1">Tab in the client’s master sheet</span>
              <input value={draft.masterTabName} onChange={e => setDraft({ ...draft, masterTabName: e.target.value })}
                     placeholder="e.g. Vegetables — must match exactly" className={inputCls} />
            </label>
          ) : (
            <>
              <label className="block">
                <span className="block text-[11px] font-medium text-muted-foreground mb-1">Google Sheet for this category</span>
                <input value={draft.sheetUrl} onChange={e => setDraft({ ...draft, sheetUrl: e.target.value })}
                       placeholder="https://docs.google.com/spreadsheets/d/…" className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-muted-foreground mb-1">
                  Tab name <span className="font-normal">— leave blank, Figma reads the first tab only</span>
                </span>
                <input value={draft.sheetTabName} onChange={e => setDraft({ ...draft, sheetTabName: e.target.value })}
                       placeholder="Offers" className={inputCls} />
              </label>
            </>
          )}

          <label className="block">
            <span className="block text-[11px] font-medium text-muted-foreground mb-1">Figma file link</span>
            <input value={draft.figmaUrl} onChange={e => setDraft({ ...draft, figmaUrl: e.target.value })}
                   placeholder="https://www.figma.com/design/…" className={inputCls} />
          </label>

          <details>
            <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
              Advanced: own Apps Script for this category
            </summary>
            <input value={draft.appsScriptUrl} onChange={e => setDraft({ ...draft, appsScriptUrl: e.target.value })}
                   placeholder="https://script.google.com/macros/s/…/exec" className={inputCls + ' mt-2'} />
          </details>

          {err && <div className="text-[11px] text-red-500">{err}</div>}

          <div className="flex items-center gap-2 pt-1">
            <button onClick={() => void save()} disabled={saving || !draft.name.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              {draft.id ? 'Save' : 'Add'}
            </button>
            <button onClick={() => { setDraft(null); setErr(null) }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
        </div>
      )}
      {removeTarget && (
        <ConfirmDialog
          title={`Remove the “${removeTarget.name}” category?`}
          body="Products already saved under it stay in their campaigns and move back to the default list. Nothing the client submitted is lost."
          confirmLabel="Remove category"
          danger
          onConfirm={() => { const g = removeTarget; setRemoveTarget(null); void remove(g) }}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  )
}
