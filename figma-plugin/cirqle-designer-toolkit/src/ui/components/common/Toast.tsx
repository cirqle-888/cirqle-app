import { useEffect } from 'react';
import { useToolkitStore, type Toast as ToastT } from '@ui/state/store';
import { Icon } from './Icon';

const ICON_BY_VARIANT = { info: 'info', success: 'check', warning: 'warning', error: 'error' } as const;

function ToastItem({ toast }: { toast: ToastT }) {
  const dismiss = useToolkitStore((s) => s.dismissToast);

  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => clearTimeout(t);
  }, [toast.id, toast.durationMs, dismiss]);

  return (
    <div className={`cdt-toast cdt-toast--${toast.variant}`} role="status">
      <Icon name={ICON_BY_VARIANT[toast.variant]} size={16} />
      <div className="cdt-toast__body">
        <div className="cdt-toast__title">{toast.title}</div>
        {toast.description ? <div className="cdt-toast__desc">{toast.description}</div> : null}
      </div>
      <button className="cdt-toast__close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToolkitStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="cdt-toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
