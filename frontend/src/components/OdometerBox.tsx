import { useEffect, useState } from 'react';
import { getToken } from '../api';
import { Modal } from './Modal';
import { toast } from './Toast';
import { Button, Input } from './ui';

/** The odometer fields an assignment carries (server: car_assignments). */
export interface OdometerAssignment {
  id: string;
  /** departure ("Ready") reading — car leaving the office */
  startOdoKm?: number | null;
  startOdoAt?: string | null;
  startOdoPhoto?: string | null;
  /** return ("Back at Office") reading */
  endOdoKm?: number | null;
  endOdoAt?: string | null;
  endOdoPhoto?: string | null;
}

type Stage = 'READY' | 'BACK';

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp';
const STAGE_LABEL: Record<Stage, string> = { READY: 'Departure (Ready)', BACK: 'Return (Back at office)' };

/** Odometers sit behind an authenticated route, so they load as a blob. */
function useOdoPhoto(assignmentId: string, stage: Stage, version?: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let created: string | null = null;
    let cancelled = false;
    setUrl(null);
    if (version) {
      void (async () => {
        try {
          const res = await fetch(`/api/cars/assignments/${assignmentId}/odometer/${stage}/photo`, {
            headers: { Authorization: `Bearer ${getToken() ?? ''}` },
          });
          if (!res.ok) return;
          created = URL.createObjectURL(await res.blob());
          if (!cancelled) setUrl(created);
        } catch {
          /* a missing photo never breaks the card */
        }
      })();
    }
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [assignmentId, stage, version]);
  return url;
}

/** Small clickable thumbnail of one dashboard photo (opens in a new tab). */
function OdoThumb({ assignmentId, stage, version, label }: { assignmentId: string; stage: Stage; version?: string | null; label: string }) {
  const url = useOdoPhoto(assignmentId, stage, version);
  if (!version) return null;
  return (
    <a
      href={url ?? '#'}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => !url && e.preventDefault()}
      title={`${label} — odometer photo`}
      className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
    >
      📷 {url ? <img src={url} alt={`${label} odometer`} className="h-8 w-12 object-cover rounded border border-gray-200" /> : 'photo'}
    </a>
  );
}

/**
 * Odometer (car kilo) of one trip — the departure reading comes from the driver's
 * "Ready" tap and the return reading from "Back at office". Usage for the trip is
 * the difference; the monthly per-vehicle total is the sum of these.
 *
 * Administration can record a reading when the driver phoned it in (the same
 * action stamps the stage, frees the car and closes the request), or correct a
 * mistyped number. A reading always needs the dashboard photo as evidence.
 */
export function OdometerBox({
  assignment,
  canManage,
  onSaved,
}: {
  assignment?: OdometerAssignment | null;
  canManage: boolean;
  onSaved?: () => void;
}) {
  const [stage, setStage] = useState<Stage | null>(null);
  const [km, setKm] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!assignment) return null;
  const start = assignment.startOdoKm ?? null;
  const end = assignment.endOdoKm ?? null;
  const usage = start != null && end != null ? end - start : null;

  const open = (s: Stage) => {
    setStage(s);
    setKm(String((s === 'READY' ? assignment.startOdoKm : assignment.endOdoKm) ?? ''));
    setFile(null);
    setError('');
  };

  const save = async () => {
    if (!stage) return;
    const reading = Number(km);
    if (!Number.isInteger(reading) || reading < 0) {
      setError('Enter the odometer as whole kilometres');
      return;
    }
    if (!file && !(stage === 'READY' ? assignment.startOdoPhoto : assignment.endOdoPhoto)) {
      setError('Attach the dashboard photo — it is the evidence for this reading');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('stage', stage);
      fd.append('km', String(reading));
      if (file) fd.append('file', file);
      const res = await fetch(`/api/cars/assignments/${assignment.id}/odometer`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
        throw new Error(msg || `Could not save the reading (${res.status})`);
      }
      const saved = await res.json().catch(() => null);
      toast(
        saved?.usageKm != null
          ? `Odometer saved — this trip used ${Number(saved.usageKm).toLocaleString()} km`
          : 'Odometer saved',
      );
      setStage(null);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the reading');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-gray-600">🛣️ Odometer</span>
        <span className="flex items-center gap-1">
          🚦
          {start != null ? (
            <>
              <b className="text-gray-800">{start.toLocaleString()} km</b>
              <OdoThumb assignmentId={assignment.id} stage="READY" version={assignment.startOdoPhoto} label="Departure" />
            </>
          ) : (
            <span className="text-amber-700">not recorded</span>
          )}
          {canManage && (
            <button type="button" className="text-blue-600 hover:underline" onClick={() => open('READY')}>
              {start != null ? 'edit' : 'record'}
            </button>
          )}
        </span>
        <span className="flex items-center gap-1">
          🏁
          {end != null ? (
            <>
              <b className="text-gray-800">{end.toLocaleString()} km</b>
              <OdoThumb assignmentId={assignment.id} stage="BACK" version={assignment.endOdoPhoto} label="Return" />
            </>
          ) : (
            <span className="text-amber-700">not recorded</span>
          )}
          {canManage && (
            <button type="button" className="text-blue-600 hover:underline" onClick={() => open('BACK')}>
              {end != null ? 'edit' : 'record'}
            </button>
          )}
        </span>
        {usage != null && (
          <span className="px-2 py-0.5 rounded-full border border-green-200 bg-green-50 text-green-700 font-medium">
            {usage.toLocaleString()} km this trip
          </span>
        )}
      </div>

      {stage && (
        <Modal title={`${STAGE_LABEL[stage]} — odometer`} onClose={() => setStage(null)}>
          <div className="space-y-3">
            <div>
              <label htmlFor="odo-km" className="block text-xs text-gray-500 mb-1">
                Kilo (km) on the dashboard *
              </label>
              <Input
                id="odo-km"
                type="number"
                min={0}
                inputMode="numeric"
                value={km}
                onChange={(e) => setKm(e.target.value)}
                placeholder="e.g. 45210"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                {stage === 'BACK' && start != null
                  ? `Departure was ${start.toLocaleString()} km — the return cannot be lower.`
                  : 'Whole kilometres, exactly as the dashboard shows.'}
              </p>
            </div>
            <div>
              <label htmlFor="odo-photo" className="block text-xs text-gray-500 mb-1">
                Dashboard photo {stage === 'READY' ? '(departure)' : '(return)'}
                {(stage === 'READY' ? assignment.startOdoPhoto : assignment.endOdoPhoto) ? ' — optional, an existing photo is kept' : ' *'}
              </label>
              <input
                id="odo-photo"
                type="file"
                accept={ACCEPT}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > MAX_BYTES) {
                    setError('Photo too large (max 5 MB)');
                    setFile(null);
                    return;
                  }
                  setError('');
                  setFile(f);
                }}
                className="block w-full text-xs text-gray-600 file:mr-2 file:rounded-md file:border file:border-gray-300 file:bg-white file:px-2 file:py-1 file:text-xs file:font-medium hover:file:bg-gray-50"
              />
            </div>
            {error && <div className="text-sm text-red-600 bg-red-50 rounded px-2 py-1">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStage(null)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={busy || !km.trim()}>
                {busy ? 'Saving…' : 'Save reading'}
              </Button>
            </div>
            <p className="text-[11px] text-gray-400">
              Saving a stage that the driver has not tapped yet records the tap too — the car is freed and the request
              closed exactly as if the driver pressed it in Telegram.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
