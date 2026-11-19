import { useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';
import { toast } from './Toast';
import { Button, Input } from './ui';

/**
 * Close an overdue ride by hand — the only way back into the pool for a held car
 * (release / reassign are refused while the ride is out).
 *
 * Records the return reading and frees the car, but deliberately does NOT stamp
 * the driver's 🏁 Back at office tap: that column feeds the discipline report and
 * faking it would hide the very miss this feature exists to expose.
 */
export function CloseTripModal({
  requestId,
  vehicleNo,
  departureKm,
  onClose,
  onClosed,
}: {
  requestId: string;
  /** the car whose ride is being closed — named in the explanation */
  vehicleNo?: string | null;
  /** departure reading the return km must not go below (null = unknown) */
  departureKm: number | null;
  onClose: () => void;
  /** the close landed — the panel should reload */
  onClosed: () => void;
}) {
  const [km, setKm] = useState('');
  const [estimated, setEstimated] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const value = Number(km);
  const kmOk =
    km.trim() !== '' &&
    Number.isInteger(value) &&
    value >= 0 &&
    (departureKm == null || value >= departureKm);
  const reasonOk = !estimated || reason.trim().length >= 5;
  const distance = kmOk && departureKm != null ? value - departureKm : null;

  // POSTs the close ONLY — the odometer endpoints need a dashboard photo, so a
  // km-only pre-post would be rejected before the close ever ran (the close
  // writes the BACK reading, and its photo, itself).
  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      await api(`/cars/requests/${requestId}/trip/close`, {
        method: 'POST',
        body: {
          endOdoKm: value,
          estimated,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      toast('Trip closed — the car is back in the pool');
      onClosed();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal title="Close trip manually" onClose={() => { if (!saving) onClose(); }} error={error}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-gray-500">
          Records the return reading, frees {vehicleNo ?? 'the car'} and its driver, and completes the request.
          The driver's 🏁 Back at office tap stays unrecorded on purpose — it belongs in the discipline report.
        </p>
        {departureKm != null && (
          <div className="text-xs text-gray-500">
            Departure reading: <b>{departureKm.toLocaleString()} km</b>
          </div>
        )}
        <div>
          <label className="block text-xs text-gray-500 mb-1" htmlFor="close-odo-km">Return odometer (km)</label>
          <Input
            id="close-odo-km"
            type="number"
            min={departureKm ?? 0}
            step={1}
            placeholder="e.g. 341651"
            value={km}
            onChange={(e) => setKm(e.target.value)}
          />
          {km.trim() !== '' && !kmOk && (
            <div className="text-[11px] text-red-600 mt-1">
              Enter whole kilometres{departureKm != null ? ` — not below the departure reading (${departureKm.toLocaleString()} km)` : ''}.
            </div>
          )}
          {distance != null && (
            <div className="text-[11px] text-gray-500 mt-1">Distance: {distance.toLocaleString()} km</div>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            checked={estimated}
            onChange={(e) => { setEstimated(e.target.checked); if (!e.target.checked) setReason(''); }}
            className="h-3.5 w-3.5 rounded border-gray-300 text-gold focus:ring-gold/50"
          />
          Return km is an estimate / could not be read
        </label>
        {estimated && (
          <div>
            <label className="block text-xs text-gray-500 mb-1" htmlFor="close-odo-reason">Reason (required)</label>
            <Input
              id="close-odo-reason"
              placeholder="Why is the reading an estimate? (e.g. driver phoned it in)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {reason.trim().length > 0 && !reasonOk && (
              <div className="text-[11px] text-red-600 mt-1">At least 5 characters — the next reader needs to know why it is a guess.</div>
            )}
          </div>
        )}
        <p className="text-[11px] text-gray-400">
          The requester is notified, the driver gets a Telegram message, and both the reading and the manual close are audited.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={saving || !kmOk || !reasonOk} onClick={() => void submit()}>
            {saving ? 'Closing…' : 'Close trip'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
