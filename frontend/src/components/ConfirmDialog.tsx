import { ReactNode, useEffect, useRef, useState } from 'react';
import { Button, Textarea } from './ui';
import { useScrollLock, useFocusTrap } from './Modal';

/**
 * In-app styled replacement for window.confirm / window.prompt.
 *
 * - title + description explain the action
 * - optional "note for the requester" textarea (shown when withNote)
 * - confirm button uses the given variant (danger for destructive actions)
 * - busy state while the confirm handler runs
 * - if onConfirm throws, the dialog STAYS OPEN and the error is shown inside
 *   (submit errors must never be lost behind a closed dialog)
 */
export function ConfirmDialog({
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  withNote = false,
  notePlaceholder = 'Reason / note for the requester (optional)',
  onConfirm,
  onClose,
}: {
  title: string;
  description?: ReactNode;
  /** extra form fields rendered between description and the buttons */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger' | 'ghost';
  withNote?: boolean;
  notePlaceholder?: string;
  onConfirm: (note: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useScrollLock(true);
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => !busy && e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm(note);
    } catch (e) {
      // keep the dialog open — surface the failure where the user is looking
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onMouseDown={onClose}>
      <div
        ref={trapRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-white rounded-xl shadow-xl w-full max-w-md outline-none animate-[modalIn_.15s_ease-out]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">{title}</h2>
        </div>
        <div className="p-5 space-y-3">
          {description && <div className="text-sm text-gray-600">{description}</div>}
          {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
          {children}
          {withNote && (
            <Textarea
              rows={3}
              placeholder={notePlaceholder}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" disabled={busy} onClick={onClose}>{cancelLabel}</Button>
            <Button variant={variant} disabled={busy} onClick={run}>
              {busy ? 'Working…' : confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
