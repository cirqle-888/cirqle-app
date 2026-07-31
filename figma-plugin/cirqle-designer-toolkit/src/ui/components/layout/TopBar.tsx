import { MODULES } from '@shared/constants';
import { useToolkitStore } from '@ui/state/store';
import { IconButton } from '@ui/components/common/Button';

export function TopBar() {
  const activeModule = useToolkitStore((s) => s.activeModule);
  const setCommandPaletteOpen = useToolkitStore((s) => s.setCommandPaletteOpen);
  const selectionCount = useToolkitStore((s) => s.selectionCount);
  const meta = activeModule === 'home' ? undefined : MODULES.find((m) => m.id === activeModule);
  const title = activeModule === 'home' ? 'Home' : meta?.label ?? 'Cirqle Designer Toolkit';
  const desc = activeModule === 'home' ? 'Your pinned and most-used tools, one click away.' : meta?.description;

  return (
    <header className="cdt-topbar">
      <div>
        <h1 className="cdt-topbar__title">{title}</h1>
        {desc ? <p className="cdt-topbar__desc">{desc}</p> : null}
      </div>
      <div className="cdt-topbar__actions">
        <span className="cdt-topbar__selection">{selectionCount} selected</span>
        <IconButton icon="command" label="Command palette (⌘K)" onClick={() => setCommandPaletteOpen(true)} />
      </div>
    </header>
  );
}
