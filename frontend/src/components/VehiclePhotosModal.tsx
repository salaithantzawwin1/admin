import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api';
import { Modal } from './Modal';
import { toast } from './Toast';
import { Button, Empty } from './ui';

/** The three picture sections a vehicle carries (server: vehicle_photos.kind). */
export const VEHICLE_PHOTO_KINDS = ['PHOTO', 'REGISTRATION', 'DOCUMENT'] as const;
export type VehiclePhotoKind = (typeof VEHICLE_PHOTO_KINDS)[number];

/** Pictures kept per section — mirrors the server cap. */
export const VEHICLE_PHOTO_MAX_PER_KIND = 10;

export interface VehiclePhotoMeta {
  id: string;
  kind: VehiclePhotoKind;
  mimeType: string;
  size: number;
  updatedAt: string;
}

const SECTIONS: { kind: VehiclePhotoKind; label: string; icon: string; hint: string }[] = [
  { kind: 'PHOTO', label: 'Vehicle photo', icon: '🚚', hint: 'The car itself — the first picture is the thumbnail in the fleet table.' },
  { kind: 'REGISTRATION', label: 'Registration photo', icon: '📄', hint: 'Registration certificate / မှတ်ပုံတင် — plate, owner and expiry pages.' },
  { kind: 'DOCUMENT', label: 'Document photo', icon: '🗂️', hint: 'Insurance, road tax, inspection or any other paper kept on file.' },
];

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * Pictures sit behind an authenticated route, so they are fetched as a blob
 * (a plain <img src> cannot send the bearer token) and the object URL is
 * revoked when the element goes away or the picture is replaced.
 */
export function useVehiclePhotoBlob(vehicleId: string | undefined, photoId: string | undefined, version?: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let created: string | null = null;
    let cancelled = false;
    setUrl(null);
    if (vehicleId && photoId && version !== null) {
      void (async () => {
        try {
          const res = await fetch(`/api/fleet/vehicles/${vehicleId}/photos/${photoId}`, {
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
  }, [vehicleId, photoId, version]);
  return url;
}

/** One gallery tile — the picture, its size, and (for managers) a remove button. */
function PhotoTile({
  vehicleId,
  photo,
  canManage,
  onOpen,
  onRemoved,
}: {
  vehicleId: string;
  photo: VehiclePhotoMeta;
  canManage: boolean;
  onOpen: () => void;
  onRemoved: () => void;
}) {
  const url = useVehiclePhotoBlob(vehicleId, photo.id, photo.updatedAt);
  const [removing, setRemoving] = useState(false);

  const remove = async () => {
    setRemoving(true);
    try {
      await api(`/fleet/vehicles/${vehicleId}/photos/${photo.id}`, { method: 'DELETE' });
      toast('Photo removed');
      onRemoved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Remove failed', 'error');
      setRemoving(false);
    }
  };

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        title={`View photo · ${Math.max(1, Math.round(photo.size / 1024))} KB`}
        aria-label="View photo"
        className="block aspect-[4/3] w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50 hover:border-yellow-500"
      >
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-lg text-gray-300">📷</span>
        )}
      </button>
      {canManage && (
        <button
          type="button"
          onClick={() => void remove()}
          disabled={removing}
          title="Remove this photo"
          aria-label="Remove this photo"
          className="absolute right-1 top-1 h-6 w-6 rounded-full bg-white/90 border border-gray-200 text-xs leading-none text-red-600 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:text-gray-300"
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Vehicle photo gallery — up to ten pictures in each of the three sections
 * (vehicle, registration, other documents). Files are stored privately and only
 * served to signed-in staff with fleet access; EXIF/GPS is stripped on upload.
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
  const [busyKind, setBusyKind] = useState<VehiclePhotoKind | null>(null);
  // The lightbox is scoped to ONE section: viewing a vehicle photo only steps
  // through vehicle photos — registration pictures are opened from their own
  // gallery (close this one first), so a mixed stream never surprises anyone.
  const [preview, setPreview] = useState<{ kind: VehiclePhotoKind; index: number } | null>(null);
  const previewItems = preview ? photos.filter((p) => p.kind === preview.kind) : [];
  const current = preview ? previewItems[preview.index] : undefined;
  const inputRefs = useRef<Partial<Record<VehiclePhotoKind, HTMLInputElement | null>>>({});

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

  const upload = async (kind: VehiclePhotoKind, file: File) => {
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
    setBusyKind(kind);
    try {
      const token = getToken();
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/fleet/vehicles/${vehicle.id}/photos/${kind}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? `Upload failed (${res.status})`);
      toast('Photo added');
      saved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusyKind(null);
      const input = inputRefs.current[kind];
      if (input) input.value = '';
    }
  };

  const openPreview = (photo: VehiclePhotoMeta) => {
    const list = photos.filter((p) => p.kind === photo.kind);
    const i = list.findIndex((p) => p.id === photo.id);
    if (i >= 0) setPreview({ kind: photo.kind, index: i });
  };
  const previewUrl = useVehiclePhotoBlob(
    preview ? vehicle.id : undefined,
    current?.id,
    current?.updatedAt ?? null,
  );

  // ←/→ step inside the open section; Esc closes the picture, not the dialog
  useEffect(() => {
    if (!preview) return;
    const max = previewItems.length - 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setPreview(null);
      } else if (e.key === 'ArrowLeft') {
        e.stopImmediatePropagation();
        setPreview((p) => (p ? { ...p, index: Math.max(0, p.index - 1) } : p));
      } else if (e.key === 'ArrowRight') {
        e.stopImmediatePropagation();
        setPreview((p) => (p ? { ...p, index: Math.min(max, p.index + 1) } : p));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [preview, previewItems.length]);

  return (
    <Modal title={`Photos — ${vehicle.vehicleNo} ${vehicle.brandModel}`} onClose={onClose} error={error} wide>
      <div className="space-y-5">
        {SECTIONS.map((section) => {
          const items = photos.filter((p) => p.kind === section.kind);
          const full = items.length >= VEHICLE_PHOTO_MAX_PER_KIND;
          return (
            <section key={section.kind} aria-label={section.label}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-gray-800">
                    {section.icon} {section.label}{' '}
                    <span className={`text-xs font-normal ${full ? 'text-amber-700' : 'text-gray-400'}`}>
                      {items.length}/{VEHICLE_PHOTO_MAX_PER_KIND}
                    </span>
                  </h3>
                  <p className="text-[11px] leading-snug text-gray-500">{section.hint}</p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    onClick={() => inputRefs.current[section.kind]?.click()}
                    disabled={full || busyKind !== null}
                    title={full ? `Up to ${VEHICLE_PHOTO_MAX_PER_KIND} pictures per section — remove one first` : undefined}
                  >
                    {busyKind === section.kind ? 'Uploading…' : '+ Add photo'}
                  </Button>
                )}
              </div>

              {items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 px-3 py-4 text-center text-xs text-gray-400">
                  {canManage ? 'No picture yet — use “+ Add photo”.' : 'No picture uploaded.'}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  {items.map((photo) => (
                    <PhotoTile
                      key={photo.id}
                      vehicleId={vehicle.id}
                      photo={photo}
                      canManage={canManage}
                      onOpen={() => openPreview(photo)}
                      onRemoved={saved}
                    />
                  ))}
                </div>
              )}

              <input
                ref={(el) => { inputRefs.current[section.kind] = el; }}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(section.kind, file);
                }}
              />
            </section>
          );
        })}
      </div>

      <p className="mt-5 text-[11px] leading-snug text-gray-500">
        🔒 Pictures are stored privately on the server and only shown to signed-in staff with fleet access — never from a
        public folder. Camera EXIF (including GPS location) is stripped on upload; JPEG / PNG / WebP up to 5 MB each, and up
        to {VEHICLE_PHOTO_MAX_PER_KIND} pictures per section.
      </p>

      {preview && current && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onMouseDown={() => setPreview(null)}
        >
          <div className="w-full max-w-4xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 px-1 pb-2 text-xs text-white/80">
              <span className="truncate">
                {SECTIONS.find((s) => s.kind === preview.kind)?.icon}{' '}
                {SECTIONS.find((s) => s.kind === preview.kind)?.label}
                {previewItems.length > 1 && <> · {preview.index + 1} / {previewItems.length}</>}
                <span className="ml-2 text-white/50">(this section only)</span>
              </span>
              <button className="text-white/80 hover:text-white text-lg leading-none" onClick={() => setPreview(null)} aria-label="Close preview">
                ×
              </button>
            </div>
            <div className="flex items-center gap-2">
              {previewItems.length > 1 && (
                <button
                  type="button"
                  className="h-9 w-9 shrink-0 rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
                  onClick={() => setPreview((p) => (p ? { ...p, index: Math.max(0, p.index - 1) } : p))}
                  disabled={preview.index === 0}
                  aria-label="Previous photo in this section"
                >
                  ‹
                </button>
              )}
              <div className="flex-1 rounded-lg bg-white p-2">
                {previewUrl ? (
                  <img src={previewUrl} alt={SECTIONS.find((s) => s.kind === preview.kind)?.label} className="mx-auto max-h-[75vh] w-auto rounded" />
                ) : (
                  <Empty label="Loading photo…" />
                )}
              </div>
              {previewItems.length > 1 && (
                <button
                  type="button"
                  className="h-9 w-9 shrink-0 rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
                  onClick={() => setPreview((p) => (p ? { ...p, index: Math.min(previewItems.length - 1, p.index + 1) } : p))}
                  disabled={preview.index >= previewItems.length - 1}
                  aria-label="Next photo in this section"
                >
                  ›
                </button>
              )}
            </div>
            <div className="pt-2 text-center text-[11px] text-white/50">
              Close this view to open another section’s gallery (Esc / ×)
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
