import { useToolkitStore } from '@ui/state/store';
import { Button } from './Button';
import { Modal } from './Modal';

export function ConfirmDialog() {
  const req = useToolkitStore((s) => s.confirmRequest);
  const resolveConfirm = useToolkitStore((s) => s.resolveConfirm);

  if (!req) return null;

  return (
    <Modal onClose={() => resolveConfirm(false)} title={req.title}>
      <p className="cdt-text-muted">{req.description}</p>
      <div className="cdt-modal__actions">
        <Button variant="ghost" onClick={() => resolveConfirm(false)}>
          Cancel
        </Button>
        <Button variant={req.destructive ? 'danger' : 'primary'} onClick={() => resolveConfirm(true)}>
          {req.confirmLabel ?? 'Confirm'}
        </Button>
      </div>
    </Modal>
  );
}
