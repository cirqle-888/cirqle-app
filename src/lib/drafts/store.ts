/**
 * Durable binding for form drafts.
 *
 * Reuses the offline layer's storage adapter (`@/lib/offline/storage`), so a
 * draft survives a WebView cache eviction on native through Capacitor
 * Preferences and falls back to localStorage on web/desktop — and degrades to
 * a silent no-op when storage is unavailable (private mode, quota, SSR).
 * Nothing here throws: losing the ability to *save* a draft must never break
 * the form, and a form that cannot save a draft is exactly as usable as one
 * that never had the feature.
 *
 * The model (`model.ts`) decides what a draft is and whether one may be
 * offered back. This file only moves bytes.
 */
import { storageGet, storageSet, storageRemove } from '@/lib/offline/storage'
import {
  draftKey, encodeDraft, decodeDraft, isForeignDraftKey,
  type DraftScope, type DraftEnvelope,
} from './model'

export async function readDraft<T>(
  scope: DraftScope,
  formKey: string,
  now: number = Date.now(),
): Promise<DraftEnvelope<T> | null> {
  const raw = await storageGet(draftKey(scope, formKey))
  const envelope = decodeDraft<T>(raw, scope, formKey, now)
  // Refused for any reason — wrong scope, wrong version, expired, corrupt —
  // so stop carrying it around.
  if (raw && !envelope) await storageRemove(draftKey(scope, formKey))
  return envelope
}

export async function writeDraft<T>(
  scope: DraftScope,
  formKey: string,
  data: T,
  now: number = Date.now(),
): Promise<void> {
  await storageSet(draftKey(scope, formKey), encodeDraft(scope, formKey, data, now))
}

export async function clearDraft(scope: DraftScope, formKey: string): Promise<void> {
  await storageRemove(draftKey(scope, formKey))
}

/**
 * Drop every draft that does not belong to the current employee+workspace.
 *
 * Reading is already safe without this — `decodeDraft` refuses a foreign
 * envelope — so this is hygiene, not a security control: on a shared device it
 * stops one person's unsent typing sitting in storage after someone else signs
 * in, and it keeps the store from growing without bound.
 *
 * localStorage only. Capacitor Preferences has no enumeration in the wrapper
 * this builds on, and native installs are single-account in practice, so there
 * is nothing to sweep there.
 */
export function pruneForeignDrafts(scope: DraftScope): void {
  if (typeof localStorage === 'undefined') return
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && isForeignDraftKey(key, scope)) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch { /* private mode / blocked storage — nothing to clean up anyway */ }
}
