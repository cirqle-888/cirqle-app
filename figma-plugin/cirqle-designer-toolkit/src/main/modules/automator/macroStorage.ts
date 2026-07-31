/** CRUD over the persisted macro list (STORAGE_KEYS.macros). Each macro is a
 * named, ordered sequence of { actionType, params } steps — see
 * actions/actionTypes.ts for the Macro/MacroStep shapes. */
import { STORAGE_KEYS } from '@shared/constants';
import { generateId } from '@shared/id';
import { loadJSON, saveJSON } from '../../utils/storage';
import type { Macro, MacroStep } from './actions/actionTypes';

export async function listMacros(): Promise<Macro[]> {
  return loadJSON<Macro[]>(STORAGE_KEYS.macros, []);
}

export async function getMacro(id: string): Promise<Macro | null> {
  const macros = await listMacros();
  return macros.find((m) => m.id === id) ?? null;
}

export interface SaveMacroInput {
  id?: string;
  name: string;
  description: string;
  steps: MacroStep[];
}

/** Upserts by id: if `id` is provided and matches an existing macro, that
 * macro is updated in place (preserving createdAt); otherwise a new macro
 * is created and prepended. */
export async function saveMacro(input: SaveMacroInput): Promise<Macro> {
  const macros = await listMacros();
  const now = Date.now();

  if (input.id) {
    const index = macros.findIndex((m) => m.id === input.id);
    if (index >= 0) {
      const existing = macros[index]!;
      const updated: Macro = {
        ...existing,
        name: input.name,
        description: input.description,
        steps: input.steps,
        updatedAt: now,
      };
      macros[index] = updated;
      await saveJSON(STORAGE_KEYS.macros, macros);
      return updated;
    }
  }

  const created: Macro = {
    id: input.id ?? generateId('macro'),
    name: input.name,
    description: input.description,
    steps: input.steps,
    createdAt: now,
    updatedAt: now,
  };
  macros.unshift(created);
  await saveJSON(STORAGE_KEYS.macros, macros);
  return created;
}

export async function deleteMacro(id: string): Promise<Macro[]> {
  const macros = await listMacros();
  const next = macros.filter((m) => m.id !== id);
  await saveJSON(STORAGE_KEYS.macros, next);
  return next;
}

export async function duplicateMacro(id: string): Promise<Macro | null> {
  const macros = await listMacros();
  const original = macros.find((m) => m.id === id);
  if (!original) return null;

  const now = Date.now();
  const copy: Macro = {
    ...original,
    id: generateId('macro'),
    name: `${original.name} copy`,
    createdAt: now,
    updatedAt: now,
    steps: original.steps.map((s) => ({ ...s })),
  };
  macros.unshift(copy);
  await saveJSON(STORAGE_KEYS.macros, macros);
  return copy;
}

type ImportableMacro = Pick<Macro, 'name' | 'steps'> & Partial<Pick<Macro, 'id' | 'createdAt' | 'updatedAt' | 'description'>>;

/** Loose runtime shape check for imported macro JSON — the UI accepts a
 * pasted-JSON textarea, so this has to reject garbage without throwing on
 * anything merely "extra". Doesn't validate individual step `params`
 * shapes against their ActionType (that's the same trust boundary as a
 * hand-built macro from the UI's own step editor). */
export function isValidMacroShape(value: unknown): value is ImportableMacro {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || v.name.length === 0) return false;
  if (!Array.isArray(v.steps)) return false;
  return v.steps.every((step) => {
    if (typeof step !== 'object' || step === null) return false;
    const s = step as Record<string, unknown>;
    return typeof s.actionType === 'string' && 'params' in s;
  });
}

export async function importMacro(raw: unknown): Promise<Macro> {
  if (!isValidMacroShape(raw)) {
    throw new Error('Invalid macro JSON — expected an object like { name, description?, steps: [{ actionType, params }] }');
  }
  return saveMacro({ name: raw.name, description: raw.description ?? '', steps: raw.steps });
}
