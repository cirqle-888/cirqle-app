import { useCallback, useEffect } from 'react';
import { useToolkitStore } from './store';
import { requestPlugin } from '@ui/lib/bridge';
import type { ToolkitSettings } from '@shared/types';

/** Loads settings from figma.clientStorage (via the main thread) once on
 * mount, and exposes an `update` that optimistically applies then persists. */
export function useSettings() {
  const settings = useToolkitStore((s) => s.settings);
  const settingsLoaded = useToolkitStore((s) => s.settingsLoaded);
  const setSettings = useToolkitStore((s) => s.setSettings);

  useEffect(() => {
    if (settingsLoaded) return;
    requestPlugin<ToolkitSettings>('settings', 'get').promise.then(setSettings).catch(() => {
      /* fall back to defaults already in the store */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  const update = useCallback(
    async (patch: Partial<ToolkitSettings>) => {
      setSettings({ ...settings, ...patch });
      const saved = await requestPlugin<ToolkitSettings>('settings', 'update', patch).promise;
      setSettings(saved);
    },
    [settings, setSettings]
  );

  const reset = useCallback(async () => {
    const saved = await requestPlugin<ToolkitSettings>('settings', 'reset').promise;
    setSettings(saved);
  }, [setSettings]);

  return { settings, settingsLoaded, update, reset };
}
