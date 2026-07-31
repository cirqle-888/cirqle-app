import type { RunScope } from '@shared/types';

/**
 * Node-type filter keys the UI exposes as checkboxes, mapped to actual Figma
 * node concepts. Kept independent from Figma's `SceneNode['type']` union so
 * this file (and renameEngine.ts, which never imports it) can stay pure/DOM
 * & figma-free — the mapping from these keys to real nodes is resolved on
 * the main-thread side, in index.ts's `matchesTypeFilter()`:
 *
 *   FRAME     -> node.type === 'FRAME'
 *   COMPONENT -> node.type === 'COMPONENT' (or 'COMPONENT_SET')
 *   INSTANCE  -> node.type === 'INSTANCE'
 *   GROUP     -> node.type === 'GROUP'
 *   TEXT      -> node.type === 'TEXT'
 *   VECTOR    -> node.type === 'VECTOR'
 *   IMAGE     -> any node with a `fills` array containing a visible paint of
 *                type 'IMAGE' (fills can legitimately be `figma.mixed`, which
 *                is treated as "no match" rather than thrown on)
 *   SECTION   -> node.type === 'SECTION'
 *
 * An empty array means "no filter" — every walked node is a candidate.
 */
export type NodeTypeFilterKey =
  | 'FRAME'
  | 'COMPONENT'
  | 'INSTANCE'
  | 'GROUP'
  | 'TEXT'
  | 'VECTOR'
  | 'IMAGE'
  | 'SECTION';

export type NodeTypeFilter = NodeTypeFilterKey[];

export interface FindReplaceConfig {
  enabled: boolean;
  /** Plain substring (mode: 'plain') or a regex source (mode: 'regex'). */
  find: string;
  /** Replacement text. May itself contain smart-variable tokens; if
   * mode is 'regex' it may also contain capture-group refs like `$1`. */
  replace: string;
  mode: 'plain' | 'regex';
  /** Regex flags used when mode === 'regex'. 'g' is always implied even if
   * the caller omits it, so a single rule replaces every match, not just
   * the first. */
  flags: string;
  /** Only meaningful when mode === 'plain'. */
  caseSensitive: boolean;
}

export interface AffixConfig {
  enabled: boolean;
  /** Literal text, may contain smart-variable tokens e.g. "icon-{nn}-". */
  value: string;
}

export interface NumberingConfig {
  /** When false, {n}/{nn}/{index} tokens are left untouched (literal) rather
   * than resolved — lets a user type a literal "{n}" without triggering
   * numbering, and makes it obvious in a preview if they forgot to enable
   * it. When true they resolve using startNumber/padding below. */
  enabled: boolean;
  /** First number assigned to the first node in the batch. Default 1. */
  startNumber: number;
  /** 'auto' zero-pads {nn} to the width of the highest number in the batch
   * (e.g. 1..12 -> "01".."12"). {n} is never padded regardless of this
   * setting. 'none' still resolves {nn} but without padding (same as {n}). */
  padding: 'auto' | 'none';
}

/**
 * A single rename rule combining every supported transform. All sub-rules
 * are independently toggle-able so the UI can build one rule that does
 * "prefix + sequential number + suffix" (or find & replace + regex +
 * numbering, etc.) in a single preview/apply pass. See renameEngine.ts's
 * `buildNewName` doc comment for the exact application order.
 */
export interface RenameRule {
  findReplace: FindReplaceConfig;
  prefix: AffixConfig;
  suffix: AffixConfig;
  numbering: NumberingConfig;
}

export function createDefaultRenameRule(): RenameRule {
  return {
    findReplace: { enabled: false, find: '', replace: '', mode: 'plain', flags: 'g', caseSensitive: false },
    prefix: { enabled: false, value: '' },
    suffix: { enabled: false, value: '' },
    numbering: { enabled: false, startNumber: 1, padding: 'auto' },
  };
}

export interface RenamePayload {
  scope: RunScope['scope'];
  typeFilter: NodeTypeFilter;
  rule: RenameRule;
}

export interface RenamePreviewRow {
  id: string;
  oldName: string;
  newName: string;
  /** Set (and newName === oldName) when this row's rule application failed,
   * e.g. an invalid regex — the row is still reported instead of aborting
   * the whole batch. */
  error?: string;
}

export interface RenamePreviewResult {
  rows: RenamePreviewRow[];
  total: number;
}

export interface RenameApplyResult {
  renamedCount: number;
  errorCount: number;
  errors: Array<{ id: string; error: string }>;
  /** Present only when at least one node was actually renamed — pass this
   * back to the 'undo' action to revert. */
  undoToken?: string;
}

export interface RenameUndoPayload {
  token: string;
}
