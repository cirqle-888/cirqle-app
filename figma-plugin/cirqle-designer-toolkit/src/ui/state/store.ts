import { create } from 'zustand';
import type { ToolkitSettings, ViewId } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { generateId } from '@shared/id';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  durationMs: number;
}

export interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  resolve: (confirmed: boolean) => void;
}

export type SettingsTab = 'general' | 'tools' | 'history' | 'activity' | 'shortcuts';

interface ToolkitStore {
  activeModule: ViewId;
  setActiveModule: (module: ViewId) => void;

  /** Which tab the Settings page opens on — lets Home's "manage tools" link
   * land directly on the Tools tab instead of General. */
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  selectionCount: number;
  setSelectionCount: (count: number) => void;

  settings: ToolkitSettings;
  settingsLoaded: boolean;
  setSettings: (settings: ToolkitSettings) => void;

  toasts: Toast[];
  pushToast: (toast: Omit<Toast, 'id' | 'durationMs'> & { durationMs?: number }) => void;
  dismissToast: (id: string) => void;

  confirmRequest: ConfirmRequest | null;
  requestConfirm: (req: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>;
  resolveConfirm: (confirmed: boolean) => void;
}

export const useToolkitStore = create<ToolkitStore>((set, get) => ({
  activeModule: 'home',
  setActiveModule: (module) => set({ activeModule: module }),

  settingsTab: 'general',
  setSettingsTab: (tab) => set({ settingsTab: tab }),

  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  selectionCount: 0,
  setSelectionCount: (count) => set({ selectionCount: count }),

  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  setSettings: (settings) => set({ settings, settingsLoaded: true }),

  toasts: [],
  pushToast: (toast) =>
    set((s) => ({
      toasts: [...s.toasts, { id: generateId('toast'), durationMs: 4000, ...toast }],
    })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  confirmRequest: null,
  requestConfirm: (req) =>
    new Promise<boolean>((resolve) => {
      set({ confirmRequest: { ...req, resolve } });
    }),
  resolveConfirm: (confirmed) => {
    get().confirmRequest?.resolve(confirmed);
    set({ confirmRequest: null });
  },
}));
