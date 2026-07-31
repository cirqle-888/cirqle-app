import { useEffect } from 'react';
import { ThemeProvider } from '@ui/components/layout/ThemeProvider';
import { Sidebar } from '@ui/components/layout/Sidebar';
import { TopBar } from '@ui/components/layout/TopBar';
import { ToastContainer } from '@ui/components/common/Toast';
import { ConfirmDialog } from '@ui/components/common/ConfirmDialog';
import { CommandPalette } from '@ui/components/CommandPalette/CommandPalette';
import { useToolkitStore } from '@ui/state/store';
import { useGlobalShortcuts } from '@ui/hooks/useGlobalShortcuts';
import { usePluginEvent } from '@ui/hooks/usePluginEvent';
import { requestPlugin } from '@ui/lib/bridge';
import type { ModuleId, ToolkitSettings } from '@shared/types';

import { HomePage } from '@ui/pages/HomePage';
import { RenamePage } from '@ui/pages/RenamePage';
import { CleanerPage } from '@ui/pages/CleanerPage';
import { AccessibilityPage } from '@ui/pages/AccessibilityPage';
import { AutomatorPage } from '@ui/pages/AutomatorPage';
import { TemplateValidatorPage } from '@ui/pages/TemplateValidatorPage';
import { ComponentManagerPage } from '@ui/pages/ComponentManagerPage';
import { AssetManagerPage } from '@ui/pages/AssetManagerPage';
import { ExportManagerPage } from '@ui/pages/ExportManagerPage';
import { AnalyticsPage } from '@ui/pages/AnalyticsPage';
import { DesignQAPage } from '@ui/pages/DesignQAPage';
import { SettingsPage } from '@ui/pages/SettingsPage';

const PAGES: Record<ModuleId, () => JSX.Element> = {
  rename: RenamePage,
  cleaner: CleanerPage,
  accessibility: AccessibilityPage,
  automator: AutomatorPage,
  templateValidator: TemplateValidatorPage,
  componentManager: ComponentManagerPage,
  assetManager: AssetManagerPage,
  exportManager: ExportManagerPage,
  analytics: AnalyticsPage,
  designQA: DesignQAPage,
  settings: SettingsPage,
  system: () => <></>,
};

/** Views that don't count as "using a tool" for the usage-based ranking. */
const UNTRACKED: ReadonlySet<string> = new Set(['home', 'settings', 'system']);

export function App() {
  useGlobalShortcuts();
  const activeModule = useToolkitStore((s) => s.activeModule);
  const setActiveModule = useToolkitStore((s) => s.setActiveModule);
  const setSelectionCount = useToolkitStore((s) => s.setSelectionCount);
  const pushToast = useToolkitStore((s) => s.pushToast);

  // Deep-link from a Figma menu command (see main/code.ts COMMAND_TO_MODULE).
  usePluginEvent<{ module: ModuleId }>('system', 'navigate', (payload) => {
    setActiveModule(payload.module);
  });

  usePluginEvent<{ count: number }>('system', 'selectionchange', (payload) => {
    setSelectionCount(payload.count);
  });

  useEffect(() => {
    requestPlugin<{ count: number }>('system', 'ping')
      .promise.catch(() => pushToast({ variant: 'error', title: 'Could not reach the plugin backend' }));
  }, [pushToast]);

  // Count a tool as "used" only after the user has stayed on it for a beat —
  // flicking past a module while exploring shouldn't promote it into the
  // sidebar. Only the usage fields from the response are merged back, so an
  // in-flight settings edit elsewhere in the UI can't be clobbered.
  useEffect(() => {
    if (UNTRACKED.has(activeModule)) return;
    const timer = setTimeout(() => {
      requestPlugin<ToolkitSettings>('settings', 'trackUsage', { module: activeModule })
        .promise.then((saved) => {
          const store = useToolkitStore.getState();
          store.setSettings({
            ...store.settings,
            usageCounts: saved.usageCounts,
            recentlyUsed: saved.recentlyUsed,
          });
        })
        .catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [activeModule]);

  const Page = activeModule === 'home' ? HomePage : PAGES[activeModule];

  return (
    <ThemeProvider>
      <div className="cdt-app">
        <Sidebar />
        <div className="cdt-main">
          <TopBar />
          <div className="cdt-page">
            <Page />
          </div>
        </div>
      </div>
      <ToastContainer />
      <ConfirmDialog />
      <CommandPalette />
    </ThemeProvider>
  );
}
