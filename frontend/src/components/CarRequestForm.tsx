import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Input, Select } from './ui';

const EMPTY = {
  destination: '', purpose: '', startDate: '', endDate: '',
  passengers: 1, timeSlot: 'FULL_DAY', pickupLocation: '', description: '',
};

/** Local datetime-local string (YYYY-MM-DDTHH:mm) for a Date. */
function toLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Quick car-request form shared by the Car Requests page.
 * - Start defaults to now (employee picks the time only)
 * - End is optional (defaults to 5:00 PM same day server-side)
 * - Custom hours requires an explicit End
 * - Warns about clashing bookings for the same window before submitting
 *
 * Embeddable: pass `onCreated` to render inside a modal (no own navigation),
 * otherwise it navigates to the created request as before.
 */
export function CarRequestForm({ onCreated }: { onCreated?: (id: string) => void } = {}) {
  const [form, setForm] = useState(() => ({ ...EMPTY, startDate: toLocal(new Date()) }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clashes, setClashes] = useState<{ request?: { docNumber: string }; startDate: string; endDate: string }[]>([]);
  const [forceSubmit, setForceSubmit] = useState(false);
  // monotonic token for the clash-lookup effect (see effect below)
  const clashRun = useRef(0);
  const navigate = useNavigate();

  // Custom hours needs an explicit end; other slots may omit it (server defaults to 17:00 same day)
  const needsEnd = form.timeSlot === 'CUSTOM_HOURS';
  const valid = form.destination && form.startDate && (!needsEnd || form.endDate);

  // Custom hours: prefill End with the Start date (+1h) so the requester only
  // adjusts the hour — the date is already the same day.
  useEffect(() => {
    if (form.timeSlot === 'CUSTOM_HOURS' && form.startDate && !form.endDate) {
      const d = new Date(form.startDate);
      d.setHours(d.getHours() + 1);
      setForm((f) => ({ ...f, endDate: toLocal(d) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.timeSlot, form.startDate]);

  // warn about same-vehicle double bookings when the window is fully known.
  // A run-token guards against the classic race: an older slow response landing
  // AFTER a newer one would overwrite the fresher clash list.
  useEffect(() => {
    if (!valid) return;
    const end = form.endDate || `${form.startDate.slice(0, 10)}T17:00`;
    const run = ++clashRun.current;
    api<{ conflicts: { request?: { docNumber: string }; startDate: string; endDate: string }[] }>(
      `/cars/availability/conflicts?startDate=${encodeURIComponent(new Date(form.startDate).toISOString())}&endDate=${encodeURIComponent(new Date(end).toISOString())}`,
    )
      .then((r) => {
        if (clashRun.current !== run) return; // a newer keystroke already superseded us
        setClashes(r.conflicts ?? []);
        setForceSubmit(false);
      })
      .catch(() => {
        if (clashRun.current !== run) return;
        setClashes([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.startDate, form.endDate, form.timeSlot, valid]);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const created = await api<{ id?: string; request?: { id: string } }>('/cars/requests', {
        method: 'POST',
        body: {
          destination: form.destination,
          purpose: form.purpose,
          description: form.description,
          pickupLocation: form.pickupLocation,
          startDate: new Date(form.startDate).toISOString(),
          endDate: new Date(form.endDate || `${form.startDate.slice(0, 10)}T17:00`).toISOString(),
          passengers: Number(form.passengers),
          timeSlot: form.timeSlot,
        },
      });
      const id = created.id ?? created.request?.id;
      if (!id) throw new Error('Unexpected response');
      await api(`/requests/${id}/submit`, { method: 'POST' });
      setForm({ ...EMPTY, startDate: toLocal(new Date()) });
      setBusy(false);
      if (onCreated) onCreated(id); // modal usage: let the caller close + toast
      else navigate(`/requests/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  };

  const hasClash = clashes.length > 0 && !forceSubmit;

  return (
    <div className="space-y-3">
      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input placeholder="Destination *" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} />
        <Input placeholder="Pickup location (optional)" value={form.pickupLocation} onChange={(e) => setForm({ ...form, pickupLocation: e.target.value })} />
        <div>
          <label className="block text-xs text-gray-500 mb-1">Start * (defaults to today, pick the time)</label>
          <Input type="datetime-local" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            End {needsEnd ? '* (date prefilled — pick the hour)' : '(optional — defaults to 5:00 PM)'}
          </label>
          <Input
            type="datetime-local"
            value={form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            min={form.startDate || undefined}
          />
        </div>
        <Select value={form.timeSlot} onChange={(e) => setForm({ ...form, timeSlot: e.target.value })}>
          <option value="FULL_DAY">Full day</option>
          <option value="HALF_DAY_AM">Half day (AM)</option>
          <option value="HALF_DAY_PM">Half day (PM)</option>
          <option value="CUSTOM_HOURS">Custom hours</option>
        </Select>
        <Input
          type="number"
          min={1}
          placeholder="Passengers"
          value={form.passengers}
          onChange={(e) => {
            // '' / NaN (cleared input) must not poison the JSON body → fall back to 1
            const n = Number(e.target.value);
            setForm({ ...form, passengers: Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1 });
          }}
        />
        <Input placeholder="Purpose (optional)" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
      </div>
      <textarea
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
        rows={2}
        placeholder="Details (optional)"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />

      {hasClash && (
        <div className="text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
          <div className="font-medium">⚠ Another request already covers this time window:</div>
          <ul className="mt-1 list-disc list-inside text-xs">
            {clashes.map((c, i) => (
              <li key={c.request?.docNumber ?? `idx-${i}`}>
                {c.request?.docNumber ?? '—'}: {new Date(c.startDate).toLocaleString()} → {new Date(c.endDate).toLocaleString()}
              </li>
            ))}
          </ul>
          <div className="mt-1 text-xs">You can still submit — Administration will check vehicle availability when assigning.</div>
          <button className="mt-2 text-xs underline" onClick={() => setForceSubmit(true)}>
            Submit anyway
          </button>
        </div>
      )}

      <Button onClick={submit} disabled={!valid || busy}>
        {busy ? 'Submitting…' : 'Submit Car Request'}
      </Button>
    </div>
  );
}
