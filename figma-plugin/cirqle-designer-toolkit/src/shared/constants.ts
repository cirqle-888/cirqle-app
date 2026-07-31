import type { ModuleId } from './types';

export const STORAGE_KEYS = {
  settings: 'cdt:settings',
  history: 'cdt:history',
  macros: 'cdt:macros',
  renamePresets: 'cdt:rename-presets',
  templateRules: 'cdt:template-rules',
  activityLog: 'cdt:activity-log',
} as const;

export interface ModuleMeta {
  id: ModuleId;
  label: string;
  shortLabel: string;
  description: string;
  icon: string; // key into the Icon component's glyph map
  shortcut?: string; // display string, e.g. "⌘⇧R"
}

/** Central registry the Sidebar, Command Palette and router all read from —
 * add a module here and it shows up everywhere consistently. */
export const MODULES: ModuleMeta[] = [
  { id: 'rename', label: 'Bulk Rename', shortLabel: 'Rename', description: 'Find & replace, prefixes, numbering, regex and smart variables.', icon: 'rename', shortcut: '⌘⇧R' },
  { id: 'cleaner', label: 'Cleaner', shortLabel: 'Cleaner', description: 'Find and remove hidden, empty, duplicate and off-canvas clutter.', icon: 'cleaner', shortcut: '⌘⇧C' },
  { id: 'accessibility', label: 'Accessibility Checker', shortLabel: 'A11y', description: 'WCAG contrast, readability, touch targets, colour-blindness sim.', icon: 'a11y', shortcut: '⌘⇧A' },
  { id: 'automator', label: 'Automator', shortLabel: 'Automator', description: 'Reusable multi-step macros across selection, page or document.', icon: 'automator', shortcut: '⌘⇧M' },
  { id: 'templateValidator', label: 'Template Validator', shortLabel: 'Validator', description: 'Verify required #layer contracts before a template ships.', icon: 'validator', shortcut: '⌘⇧V' },
  { id: 'componentManager', label: 'Component Manager', shortLabel: 'Components', description: 'Detached/broken instances, unused & duplicate components.', icon: 'components' },
  { id: 'assetManager', label: 'Asset Manager', shortLabel: 'Assets', description: 'Duplicate/large/unused images, compression, replace, export.', icon: 'assets' },
  { id: 'exportManager', label: 'Export Manager', shortLabel: 'Export', description: 'Batch export with naming presets, scales and folder structure.', icon: 'export', shortcut: '⌘⇧E' },
  { id: 'analytics', label: 'Document Analytics', shortLabel: 'Analytics', description: 'Counts, complexity and performance score for this file.', icon: 'analytics' },
  { id: 'designQA', label: 'Design QA', shortLabel: 'Design QA', description: 'Spacing, radius, shadow, typography and colour consistency.', icon: 'qa' },
  { id: 'settings', label: 'Settings', shortLabel: 'Settings', description: 'Theme, language, autosave, history and performance mode.', icon: 'settings', shortcut: '⌘,' },
];

export const RENAME_VARIABLES = [
  { token: '{n}', description: 'Index, no padding (1, 2, 3…)' },
  { token: '{nn}', description: 'Zero-padded index (01, 02…10, 11)' },
  { token: '{type}', description: "Node type (Frame, Text, Component…)" },
  { token: '{parent}', description: "Parent layer's name" },
  { token: '{page}', description: 'Current page name' },
  { token: '{date}', description: 'Today\'s date (YYYY-MM-DD)' },
  { token: '{index}', description: 'Alias of {n}, kept for readability in long rules' },
] as const;

export const DEFAULT_CHUNK_SIZE = 250;
export const MAX_LAYERS_WARNING_THRESHOLD = 10_000;
