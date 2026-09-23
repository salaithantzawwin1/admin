import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Input } from './ui';
import { PasswordStrength } from './PasswordStrength';
import { useScrollLock, useFocusTrap } from './Modal';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  useScrollLock(true);
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    setError('');
    if (next.length < 8) return setError('New password must be at least 8 characters');
    if (next !== confirm) return setError('New passwords do not match');
    setLoading(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      setDone(true);
      setTimeout(onClose, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onMouseDown={onClose}>
      <div
        ref={trapRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Change password"
        className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6 outline-none animate-[modalIn_.15s_ease-out]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-gray-900 mb-4">Change password</h2>

        {done ? (
          <div className="text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2 mb-4">Password changed ✓</div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Current password</label>
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">New password</label>
              <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 8 characters" />
              <PasswordStrength value={next} />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Confirm new password</label>
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={submit} disabled={!current || !next || !confirm || loading}>
                {loading ? 'Saving…' : 'Change'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
