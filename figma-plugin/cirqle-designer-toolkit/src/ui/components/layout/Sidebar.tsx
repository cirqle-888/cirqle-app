import { useMemo, useState } from 'react';
import { MODULES } from '@shared/constants';
import type { ViewId } from '@shared/types';
import { useToolkitStore } from '@ui/state/store';
import { Icon, type IconName } from '@ui/components/common/Icon';
import { SearchInput } from '@ui/components/common/SearchInput';
import { useSettings } from '@ui/state/useSettings';
import { isHidden, moreTools, yourTools } from '@ui/lib/toolOrganizer';

export function Sidebar() {
  const activeModule = useToolkitStore((s) => s.activeModule);
  const setActiveModule = useToolkitStore((s) => s.setActiveModule);
  const { settings } = useSettings();
  const [query, setQuery] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);

  const searching = query.trim().length > 0;

  // Search sweeps every module — including hidden ones, so nothing is ever
  // unreachable. Outside of search, hidden tools stay out of the interface.
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return MODULES.filter(
      (m) => m.label.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)
    );
  }, [query]);

  const primary = yourTools(settings);
  const secondary = moreTools(settings, primary);

  const item = (id: ViewId, label: string, icon: IconName, shortcut?: string, badge?: string) => (
    <SidebarItem
      key={id}
      label={label}
      icon={icon}
      shortcut={shortcut}
      badge={badge}
      active={activeModule === id}
      onClick={() => setActiveModule(id)}
    />
  );

  return (
    <nav className="cdt-sidebar" aria-label="Modules">
      <div className="cdt-sidebar__brand">
        <div className="cdt-sidebar__logo">CT</div>
        <div>
          <div className="cdt-sidebar__title">Cirqle Designer Toolkit</div>
          <div className="cdt-sidebar__subtitle">All-in-one productivity suite</div>
        </div>
      </div>

      <SearchInput
        placeholder="Search tools…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search modules"
      />

      {searching ? (
        <div className="cdt-sidebar__section">
          <div className="cdt-sidebar__section-label">Results</div>
          {searchResults.map((m) =>
            item(m.id, m.label, m.icon as IconName, m.shortcut, isHidden(settings, m.id) ? 'Hidden' : undefined)
          )}
          {searchResults.length === 0 && <div className="cdt-sidebar__empty">No tools match "{query}"</div>}
        </div>
      ) : (
        <>
          <div className="cdt-sidebar__section">
            {item('home', 'Home', 'home')}
          </div>

          {primary.length > 0 && (
            <div className="cdt-sidebar__section">
              <div className="cdt-sidebar__section-label">Your tools</div>
              {primary.map((m) => item(m.id, m.label, m.icon as IconName, m.shortcut))}
            </div>
          )}

          {secondary.length > 0 && (
            <div className="cdt-sidebar__section">
              <button
                className="cdt-sidebar__toggle"
                onClick={() => setMoreOpen((o) => !o)}
                aria-expanded={moreOpen}
              >
                <Icon name={moreOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                <span>{primary.length > 0 ? 'More tools' : 'All tools'}</span>
                <span className="cdt-sidebar__toggle-count">{secondary.length}</span>
              </button>
              {moreOpen && secondary.map((m) => item(m.id, m.label, m.icon as IconName, m.shortcut))}
            </div>
          )}
        </>
      )}

      <div className="cdt-sidebar__footer">
        {item('settings', 'Settings', 'settings', '⌘,')}
      </div>
    </nav>
  );
}

function SidebarItem({
  label,
  icon,
  shortcut,
  badge,
  active,
  onClick,
}: {
  label: string;
  icon: IconName;
  shortcut?: string;
  badge?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={['cdt-sidebar__item', active ? 'cdt-sidebar__item--active' : ''].join(' ')} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span className="cdt-sidebar__item-label">{label}</span>
      {badge ? <span className="cdt-sidebar__item-badge">{badge}</span> : null}
      {shortcut ? <span className="cdt-sidebar__item-shortcut">{shortcut}</span> : null}
    </button>
  );
}
