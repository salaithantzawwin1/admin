import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api';
import { Modal } from './Modal';
import { toast } from './Toast';
import { Button, Empty } from './ui';

/** The three pictures a vehicle carries (server: vehicle_photos.kind). */
export const VEHICLE_PHOTO_KINDS = ['PHOTO', 'REGISTRATION', 'DOCUMENT'] as const;
export type VehiclePhotoKind = (typeof VEHICLE_PHOTO_KINDS)[number];

export interface VehiclePhotoMeta {
  kind: VehiclePhotoKind;
  mimeType: string;
  size: number;
  updatedAt: string;
}

const SLOTS: { kind: VehiclePhotoKind; label: string; hint: string }[] = [
  { kind: 'PHOTO', label: 'Vehicle photo', hint: 'The car itself — used as the thumbnail in the fleet table.' },
  { kind: 'REGISTRATION', label: 'Registration photo', hint: 'Registration certificate / မှတ်ပုံတင် — the page with the plate and expiry.' },
  { kind: 'DOCUMENT', label: 'Document photo', hint: 'Insurance, road tax or any other paper kept on file.' },
];

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * Pictures sit behind an authenticated route, so they are fetched as a blob
 * (a plain <img src> cannot send the bearer token) and the object URL is
 * revoked when the element goes away or the picture is replaced.
 */
export function useVehiclePhotoBlob(vehicleId: string | undefined, kind: VehiclePhotoKind, version?: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let created: string | null = null;
    let cancelled = false;
    setUrl(null);
    if (vehicleId && version !== null) {
      void (async () => {
        try {
          const res = await fetch(`/api/fleet/vehicles/${vehicleId}/photos/${kind}`, {
            headers: { Authorization: `Bearer ${getToken() ?? ''}` },
          });
          if (!res.ok) return;
          created = URL.createObjectURL(await res.blob());
          if (!cancelled) setUrl(created);
        } catch {
          /* a missing preview never breaks the row or the dialog */
        }
      })();
    }
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [vehicleId, kind, version]);
  return url;
}

/** One upload slot: preview, upload/replace, remove. */
function PhotoSlot({
  vehicleId,
  kind,
  label,
  hint,
  meta,
  canManage,
  onSaved,
  onOpen,
}: {
  vehicleId: string;
  kind: VehiclePhotoKind;
  label: string;
  hint: string;
  meta?: VehiclePhotoMeta;
  canManage: boolean;
  onSaved: () => void;
  onOpen: () => void;
}) {
  const url = useVehiclePhotoBlob(vehicleId, kind, meta ? meta.updatedAt : null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = () => inputRef.current?.click();

  const upload = async (file: File) => {
    setError(null);
    // mirror the server rules so an obviously wrong file never leaves the browser
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Only JPEG, PNG or WebP images are allowed');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('Photo too large (max 5 MB)');
      return;
    }
    setBusy(true);
    try {
      const token = getToken();
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/fleet/vehicles/${vehicleId}/photos/${kind}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? `Upload failed (${res.status})`);
      toast(`${label} saved`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      await api(`/fleet/vehicles/${vehicleId}/photos/${kind}`, { method: 'DELETE' });
      toast(`${label} removed`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-sm font-medium text-gray-800">{label}</div>
        {meta && <div className="text-[10px] text-gray-400">{Math.max(1, Math.round(meta.size / 1024))} KB</div>}
      </div>
      <button
        type="button"
        onClick={meta && url ? onOpen : canManage ? pick : undefined}
        title={meta ? `View ${label.toLowerCase()}` : canManage ? `Upload ${label.toLowerCase()}` : 'Not uploaded'}
        aria-label={meta ? `View ${label.toLowerCase()}` : `${label} not uploaded`}
        className="block w-full h-36 rounded-lg border border-dashed border-gray-300 bg-gray-50 overflow-hidden hover:border-yellow-500 disabled:cursor-default"
        disabled={!meta && !canManage}
      >
        {url ? (
          <img src={url} alt={label} className="h-full w-full object-contain" />
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-xs text-gray-400">
            <span className="text-2xl leading-none">📷</span>
            {meta ? 'Loading…' : canManage ? 'Click to upload' : 'Not uploaded'}
          </span>
        )}
      </button>
      <p className="mt-2 text-[11px] leading-snug text-gray-500">{hint}</p>
      {meta && <div className="mt-1 text-[10px] text-gray-400">updated {meta.updatedAt.slice(0, 10)}</div>}
      {error && <div className="mt-2 text-[11px] text-red-600 bg-red-50 rounded px-2 py-1">{error}</div>}
      {canManage && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={pick} disabled={busy}>
            {busy ? 'Working…' : meta ? 'Replace' : 'Upload'}
          </Button>
          {meta && (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="text-xs text-red-600 hover:underline disabled:text-gray-300"
            >
              Remove
            </button>
          )}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
    </div>
  );
}

/**
 * Vehicle photo register — the car itself, its registration certificate and one
 * document picture. Files are stored privately and only served to signed-in
 * staff with fleet.read; EXIF/GPS is stripped on upload.
 */
export function VehiclePhotosModal({
  vehicle,
  canManage,
  onClose,
  onChanged,
}: {
  vehicle: { id: string; vehicleNo: string; brandModel: string };
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [photos, setPhotos] = useState<VehiclePhotoMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<VehiclePhotoKind | null>(null);

  const reload = useCallback(async () => {
    try {
      setPhotos(await api<VehiclePhotoMeta[]>(`/fleet/vehicles/${vehicle.id}/photos`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load photos');
    }
  }, [vehicle.id]);

  useEffect(() => { void reload(); }, [reload]);

  const saved = () => { void reload(); onChanged(); };

  const previewUrl = useVehiclePhotoBlob(
    preview ? vehicle.id : undefined,
    preview ?? 'PHOTO',
    photos.find((p) => p.kind === preview)?.updatedAt ?? null,
  );

  return (
    <Modal title={`Photos — ${vehicle.vehicleNo} ${vehicle.brandModel}`} onClose={onClose} error={error} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {SLOTS.map((slot) => (
          <PhotoSlot
            key={slot.kind}
            vehicleId={vehicle.id}
            kind={slot.kind}
            label={slot.label}
            hint={slot.hint}
            meta={photos.find((p) => p.kind === slot.kind)}
            canManage={canManage}
            onSaved={saved}
            onOpen={() => setPreview(slot.kind)}
          />
        ))}
      </div>

      <p className="mt-4 text-[11px] leading-snug text-gray-500">
        🔒 Pictures are stored privately on the server and only shown to signed-in staff with fleet access — never from a
        public folder. Camera EXIF (including GPS location) is stripped on upload, and only JPEG / PNG / WebP up to 5 MB is
        accepted. Uploading again replaces that picture.
      </p>

      {preview && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onMouseDown={() => setPreview(null)}
        >
          <div className="max-h-[90vh] max-w-4xl overflow-auto rounded-lg bg-white p-2" onMouseDown={(e) => e.stopPropagation()}>
            {previewUrl ? (
              <img src={previewUrl} alt="Vehicle photo" className="max-h-[80vh] w-auto rounded" />
            ) : (
              <Empty label="Loading photo…" />
            )}
            <div className="flex justify-end pt-2">
              <Button variant="ghost" onClick={() => setPreview(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
