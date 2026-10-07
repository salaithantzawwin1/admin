import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { fmtDateTime } from '../util/yangonTime';
import { Button, Input, Select, Textarea } from './ui';

const EMPTY = {
  destination: '', purpose: '', startDate: '', endDate: '',
  passengers: 1, timeSlot: 'FULL_DAY', pickupLocation: '', description: '', specialRequest: '',
};

/** Local datetime-local string (YYYY-MM-DDTHH:mm) for a Date. */
function toLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Built-in half-day End clocks — replaced on mount by the Company Time Table
 *  (Settings) so the form and the Telegram flow share one source of truth. */
const SLOT_END_FALLBACK: Record<string, string> = { HALF_DAY_AM: '12:00', HALF_DAY_PM: '17:00' };

/** Same calendar day as a datetime-local string, at the given HH:mm. */
function atTime(dateLocal: string, hhmm: string): string {
  return `${dateLocal.slice(0, 10)}T${hhmm}`;
}

/** "17:30" → "5:30 PM" — the advisory text shows the Time Table clock. */
function fmtClock12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h)) return hhmm;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
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
  // Administration-blocked vehicle windows (service/inspection) overlapping the requested time
  const [blocked, setBlocked] = useState<{ vehicleNo: string; reason: string; startDate: string; endDate: string }[]>([]);
  // hand-back buffer (minutes) — "likely free from ~end+buffer" on the clash hint
  const [bufferMin, setBufferMin] = useState<number | null>(null);
  const [forceSubmit, setForceSubmit] = useState(false);
  // blur-tracking so "required" hints only appear once the user has been in the field
  const [touched, setTouched] = useState<{ destination?: boolean; startDate?: boolean; endDate?: boolean }>({});
  const touch = (k: 'destination' | 'startDate' | 'endDate') => setTouched((t) => ({ ...t, [k]: true }));
  // End is currently auto-filled from the half-day slot (follows Start changes
  // until the requester edits End manually)
  const [endPinned, setEndPinned] = useState(false);
  // half-day End clocks from Settings → Company Time Table (AM→morningEnd,
  // PM→eveningEnd); the built-in 12:00/17:00 stands until the fetch lands
  const [slotEnds, setSlotEnds] = useState<Record<string, string>>(SLOT_END_FALLBACK);
  // monotonic token for the clash-lookup effect (see effect below)
  const clashRun = useRef(0);
  const navigate = useNavigate();

  // Custom hours needs an explicit end; other slots may omit it (server defaults to 17:00 same day)
  const needsEnd = form.timeSlot === 'CUSTOM_HOURS';
  const valid = form.destination && form.startDate && (!needsEnd || form.endDate);

  // Slot picker: half-day slots own the End — the clock comes from the Company
  // Time Table (e.g. AM ends at morningEnd, PM at eveningEnd).
  // If the slot window already ended for the chosen Start (AM picked after noon),
  // nothing is prefilled (an auto-End would sit before the Start) — the advisory
  // hint below guides the requester instead, and submission stays possible.
  const changeSlot = (slot: string) => {
    const endClock = slotEnds[slot];
    if (endClock && form.startDate) {
      const end = atTime(form.startDate, endClock);
      if (end > form.startDate) {
        setEndPinned(true);
        setForm({ ...form, timeSlot: slot, endDate: end });
        return;
      }
      setEndPinned(false);
      setForm({ ...form, timeSlot: slot, endDate: '' });
      return;
    }
    setEndPinned(false);
    setForm({ ...form, timeSlot: slot });
  };

  // Company Time Table drives the half-day auto-End (Settings → Time Table is
  // the single source; if the fetch fails the built-in fallback clocks stand).
  useEffect(() => {
    api<{ morningEnd?: string; eveningEnd?: string }>('/settings/timetable')
      .then((t) =>
        setSlotEnds({
          HALF_DAY_AM: t.morningEnd || SLOT_END_FALLBACK.HALF_DAY_AM,
          HALF_DAY_PM: t.eveningEnd || SLOT_END_FALLBACK.HALF_DAY_PM,
        }),
      )
      .catch(() => {
        /* keep the built-in 12:00/17:00 fallback clocks */
      });
  }, []);

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

  // Half-day End follows the Start while the slot owns it (moving the date to
  // tomorrow moves the auto-End too); cleared when the slot window can't hold it.
  // slotEnds is a dep so a timetable that lands after the pick re-derives it.
  useEffect(() => {
    if (!endPinned) return;
    const endClock = slotEnds[form.timeSlot];
    if (!endClock) return;
    setForm((f) => {
      if (!f.startDate) return f;
      const end = atTime(f.startDate, endClock);
      return end > f.startDate ? { ...f, endDate: end } : { ...f, endDate: '' };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.startDate, form.timeSlot, endPinned, slotEnds]);

  // warn about same-vehicle double bookings when the window is fully known.
  // A run-token guards against the classic race: an older slow response landing
  // AFTER a newer one would overwrite the fresher clash list.
  useEffect(() => {
    if (!valid) return;
    const end = form.endDate || `${form.startDate.slice(0, 10)}T17:00`;
    const run = ++clashRun.current;
    api<{ conflicts: { request?: { docNumber: string }; startDate: string; endDate: string }[]; blockedWindows?: { vehicleNo: string; reason: string; startDate: string; endDate: string }[]; bufferMinutes?: number }>(
      `/cars/availability/conflicts?startDate=${encodeURIComponent(new Date(form.startDate).toISOString())}&endDate=${encodeURIComponent(new Date(end).toISOString())}`,
    )
      .then((r) => {
        if (clashRun.current !== run) return; // a newer keystroke already superseded us
        setClashes(r.conflicts ?? []);
        setBlocked(r.blockedWindows ?? []);
        setBufferMin(typeof r.bufferMinutes === 'number' ? r.bufferMinutes : null);
        setForceSubmit(false);
      })
      .catch(() => {
        if (clashRun.current !== run) return;
        setClashes([]);
        setBlocked([]);
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
          specialRequest: form.specialRequest || undefined,
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

  // inline field-level errors — the red border comes with an explanation
  const destError = touched.destination && !form.destination.trim() ? 'Destination is required' : undefined;
  const startError = touched.startDate && !form.startDate ? 'Start date is required' : undefined;
  const endBeforeStart = !!(form.endDate && form.startDate && form.endDate < form.startDate);
  const endError =
    (endBeforeStart && "End can't be before the start") ||
    (touched.endDate && needsEnd && !form.endDate ? 'End is required for custom hours' : undefined) ||
    undefined;
  const clashMsg = hasClash ? 'This window overlaps an existing booking — see the warning below' : undefined;

  // Advisory (non-blocking): the chosen half-day window is already over TODAY —
  // e.g. Half Day (AM) picked after noon. Past dates (deliberate backdating) and
  // future dates never trigger it.
  const slotEndClock = slotEnds[form.timeSlot];
  const slotEndStr = form.startDate && slotEndClock ? atTime(form.startDate, slotEndClock) : '';
  const isToday = !!form.startDate && form.startDate.slice(0, 10) === toLocal(new Date()).slice(0, 10);
  const slotPassed = !!(slotEndStr && isToday && slotEndStr <= toLocal(new Date()));

  return (
    <div className="space-y-3">
      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input placeholder="Destination *" error={destError} onBlur={() => touch('destination')} value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} />
        <Input placeholder="Pickup location (optional)" value={form.pickupLocation} onChange={(e) => setForm({ ...form, pickupLocation: e.target.value })} />
        <div>
          <label htmlFor="car-request-form-start-defaults-to-today-pick-the" className="block text-xs text-gray-500 mb-1">Start * (defaults to today, pick the time)</label>
          <Input id="car-request-form-start-defaults-to-today-pick-the" type="datetime-local" error={startError ?? clashMsg} onBlur={() => touch('startDate')} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            End {needsEnd ? '* (date prefilled — pick the hour)' : endPinned ? '(auto from Half Day — editable)' : '(optional estimate — defaults to 5:00 PM; Back at Office overrides)'}
          </label>
          <Input
            type="datetime-local"
            error={endError ?? clashMsg}
            describe="Estimate only — the driver's Back at Office frees the car early; empty = 5:00 PM assumed"
            onBlur={() => touch('endDate')}
            value={form.endDate}
            onChange={(e) => {
              setEndPinned(false); // manual edit — the slot no longer owns End
              setForm({ ...form, endDate: e.target.value });
            }}
            min={form.startDate || undefined}
            title="Estimate only — if the trip finishes early, the driver's Back at Office frees the car immediately; if you omit this, 5:00 PM is assumed"
          />
        </div>
        <Select value={form.timeSlot} onChange={(e) => changeSlot(e.target.value)}>
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
        <Input
          placeholder="Special request (optional)"
          describe="e.g. wait and call me · carrying goods — plan a load-capable car"
          value={form.specialRequest}
          onChange={(e) => setForm({ ...form, specialRequest: e.target.value })}
        />
      </div>
      <Textarea
        rows={2}
        placeholder="Details (optional)"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />

      {slotPassed && (
        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          🌅 The {form.timeSlot === 'HALF_DAY_AM' ? 'AM' : 'PM'} half of{' '}
          {new Date(form.startDate).toLocaleDateString()} already ended
          {' '}({fmtClock12(slotEndClock)}). You can still submit
          {' '}(e.g. for the record), but consider <strong>Half Day ({form.timeSlot === 'HALF_DAY_AM' ? 'PM' : 'AM'})</strong>
          {' '}or <strong>Custom hours</strong> instead.
        </div>
      )}

      {blocked.length > 0 && (
        <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
          <div className="font-medium">🛠 A vehicle is blocked for service / inspection during this window:</div>
          <ul className="mt-1 list-disc list-inside text-xs">
            {blocked.map((b, i) => (
              <li key={`${b.vehicleNo}-${i}`}>
                {b.vehicleNo}: {b.reason} — {fmtDateTime(b.startDate)} → {fmtDateTime(b.endDate)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasClash && (
        <div className="text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
          <div className="font-medium">⚠ Another request already covers this time window:</div>
          <ul className="mt-1 list-disc list-inside text-xs">
            {clashes.map((c, i) => (
              <li key={c.request?.docNumber ?? `idx-${i}`}>
                {c.request?.docNumber ?? '—'}: {fmtDateTime(c.startDate)} → {fmtDateTime(c.endDate)}
              </li>
            ))}
          </ul>
          <div className="mt-1 text-xs">
            You can still submit — Administration will check vehicle availability when assigning.
            {bufferMin != null && bufferMin > 0
              ? ` Keep in mind a car usually becomes free ~${bufferMin} min after its window ends.`
              : ''}
          </div>
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
