import type { IconName } from './Icon';
import { Icon } from './Icon';
import type { ReactNode } from 'react';

export function EmptyState({ icon = 'search', title, description, action }: { icon?: IconName; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="cdt-empty">
      <Icon name={icon} size={28} />
      <div className="cdt-empty__title">{title}</div>
      {description ? <div className="cdt-empty__desc">{description}</div> : null}
      {action}
    </div>
  );
}
