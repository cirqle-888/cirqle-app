/**
 * Shared domain types used on both sides of the plugin (main thread + UI).
 * Keep this file free of any Figma-typings-only or DOM-only types so it can
 * be imported from either bundle without pulling in the wrong globals.
 */

export type ModuleId =
  | 'rename'
  | 'cleaner'
  | 'accessibility'
  | 'automator'
  | 'templateValidator'
  | 'componentManager'
  | 'assetManager'
  | 'exportManager'
  | 'analytics'
  | 'designQA'
  | 'settings'
  | 'system';

/** What the UI can display: every module page, plus the Home screen (a
 * UI-only view — it has no main-thread handler, so it is not a ModuleId). */
export type ViewId = ModuleId | 'home';

/** Minimal, serialisable stand-in for a SceneNode — the main thread never
 * sends live Figma nodes across postMessage (they aren't structured-clonable
 * in a useful way), it sends these. */
export interface NodeRef {
  id: string;
  name: string;
  type: string;
  pageId: string;
  pageName: string;
  parentId: string | null;
  parentName: string | null;
  depth: number;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  visible: boolean;
}

export type Severity = 'info' | 'warning' | 'error';

export interface Issue<TMeta = Record<string, unknown>> {
  id: string;
  ruleId: string;
  severity: Severity;
  title: string;
  description: string;
  node?: NodeRef;
  meta?: TMeta;
  autoFixable: boolean;
}

export interface ProgressState {
  done: number;
  total: number;
  label?: string;
  indeterminate?: boolean;
}

export interface RunScope {
  scope: 'selection' | 'page' | 'document';
}

export interface OperationResult<T = unknown> {
  ok: boolean;
  data?: T;
  warnings?: string[];
  errorMessage?: string;
  durationMs: number;
  affectedCount: number;
}

export interface HistoryEntry {
  id: string;
  module: ModuleId;
  action: string;
  summary: string;
  timestamp: number;
  affectedNodeIds: string[];
  undoable: boolean;
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ToolkitSettings {
  theme: ThemeMode;
  language: string;
  autoSave: boolean;
  keepHistoryCount: number;
  performanceMode: 'auto' | 'balanced' | 'max-performance';
  chunkSize: number;
  favouriteActions: string[];
  pinnedTools: ModuleId[];
  recentlyUsed: ModuleId[];
  /** Tools the user removed from the main interface. Still reachable via
   * search and the command palette — hiding never disables a module. */
  hiddenTools: ModuleId[];
  /** How often each tool has been opened — drives the "Your tools" ranking
   * in the sidebar and the ordering on the Home screen. */
  usageCounts: Partial<Record<ModuleId, number>>;
}

export const DEFAULT_SETTINGS: ToolkitSettings = {
  theme: 'system',
  language: 'en',
  autoSave: true,
  keepHistoryCount: 100,
  performanceMode: 'auto',
  chunkSize: 250,
  favouriteActions: [],
  pinnedTools: [],
  recentlyUsed: [],
  hiddenTools: [],
  usageCounts: {},
};

export interface CommandDescriptor {
  id: string;
  module: ModuleId;
  title: string;
  subtitle?: string;
  keywords?: string[];
  shortcut?: string;
}
