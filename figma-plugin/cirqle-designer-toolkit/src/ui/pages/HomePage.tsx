import type { KeyboardEvent } from 'react';
import type { ModuleMeta } from '@shared/constants';
import type { ModuleId } from '@shared/types';
import { useToolkitStore } from '@ui/state/store';
import { useSettings } from '@ui/state/useSettings';
import { Icon, type IconName } from '@ui/components/common/Icon';
import {
  ORGANIZABLE_MODULES,
  isHidden,
  isPinned,
  recentTools,
  usageOf,
} from '@ui/lib/toolOrganizer';

/** Home is the launchpad: pinned tools first, recent ones a click away, and
 * the full catalogue below — minus anything the user has hidden. */
export function HomePage() {
  const setActiveModule = useToolkitStore((s) => s.setActiveModule);
  const setSettingsTab = useToolkitStore((s) => s.setSettingsTab);
  const setCommandPaletteOpen = useToolkitStore((s) => s.setCommandPaletteOpen);
  const { settings, update } = useSettings();

  const pinned = ORGANIZABLE_MODULES.filter((m) => isPinned(settings, m.id) && !isHidden(settings, m.id));
  const recents = recentTools(settings).filter((m) => !isPinned(settings, m.id));
  const rest = ORGANIZABLE_MODULES.filter((m) => !isPinned(settings, m.id) && !isHidden(settings, m.id)).sort(
    (a, b) => usageOf(settings, b.id) - usageOf(settings, a.id)
  );
  const hiddenCount = ORGANIZABLE_MODULES.filter((m) => isHidden(settings, m.id)).length;

  const togglePin = (id: ModuleId) => {
    const next = isPinned(settings, id)
      ? settings.pinnedTools.filter((t) => t !== id)
      : [...settings.pinnedTools, id];
    void update({ pinnedTools: next });
  };

  const openManageTools = () => {
    setSettingsTab('tools');
    setActiveModule('settings');
  };

  return (
    <div className="cdt-home">
      <button className="cdt-home__search" onClick={() => setCommandPaletteOpen(true)}>
        <Icon name="search" size={14} />
        <span>Search tools and actions…</span>
        <kbd>⌘K</kbd>
      </button>

      {pinned.length > 0 && (
        <div className="cdt-section">
          <div className="cdt-section__title">Pinned</div>
          <div className="cdt-home__grid">
            {pinned.map((m) => (
              <ToolCard
                key={m.id}
                meta={m}
                pinned
                onOpen={() => setActiveModule(m.id)}
                onTogglePin={() => togglePin(m.id)}
              />
            ))}
          </div>
        </div>
      )}

      {recents.length > 0 && (
        <div className="cdt-section">
          <div className="cdt-section__title">Recent</div>
          <div className="cdt-home__chips">
            {recents.map((m) => (
              <button key={m.id} className="cdt-home__chip" onClick={() => setActiveModule(m.id)}>
                <Icon name={m.icon as IconName} size={13} />
                {m.shortLabel}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="cdt-section">
        <div className="cdt-section__title">{pinned.length > 0 ? 'All tools' : 'Tools'}</div>
        {pinned.length === 0 && (
          <div className="cdt-text-muted">Pin the ones you use — they move to the top and into the sidebar.</div>
        )}
        <div className="cdt-home__grid">
          {rest.map((m) => (
            <ToolCard
              key={m.id}
              meta={m}
              pinned={false}
              onOpen={() => setActiveModule(m.id)}
              onTogglePin={() => togglePin(m.id)}
            />
          ))}
        </div>
        {rest.length === 0 && pinned.length === 0 && (
          <div className="cdt-text-muted">All tools are hidden — bring them back from Manage tools.</div>
        )}
      </div>

      <button className="cdt-home__manage" onClick={openManageTools}>
        <Icon name="eye" size={13} />
        Manage tools{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
      </button>
    </div>
  );
}

function ToolCard({
  meta,
  pinned,
  onOpen,
  onTogglePin,
}: {
  meta: ModuleMeta;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  // A div with button semantics, not a <button> — the pin control nests
  // inside, and nested native buttons are invalid HTML.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };

  return (
    <div className="cdt-tool-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={onKeyDown}>
      <div className="cdt-tool-card__head">
        <Icon name={meta.icon as IconName} size={16} />
        <span className="cdt-tool-card__label">{meta.label}</span>
        <button
          className={['cdt-tool-card__pin', pinned ? 'cdt-tool-card__pin--on' : ''].join(' ')}
          aria-label={pinned ? `Unpin ${meta.label}` : `Pin ${meta.label}`}
          title={pinned ? 'Unpin' : 'Pin to top'}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
        >
          <Icon name="star" size={13} />
        </button>
      </div>
      <div className="cdt-tool-card__desc">{meta.description}</div>
      {meta.shortcut ? <kbd className="cdt-tool-card__shortcut">{meta.shortcut}</kbd> : null}
    </div>
  );
}
