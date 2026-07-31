import type { ReactNode } from 'react';
import { IconButton } from './Button';

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="cdt-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={['cdt-modal', wide ? 'cdt-modal--wide' : ''].join(' ')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="cdt-modal__header">
          <h2>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="cdt-modal__body">{children}</div>
      </div>
    </div>
  );
}
