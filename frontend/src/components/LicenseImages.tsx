import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api';
import { toast } from './Toast';
import { Button } from './ui';

/** Scans kept per license — mirrors the server cap. */
export const LICENSE_IMAGE_MAX = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp';

export interface LicenseImageMeta {
  id: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

/**
 * Scans sit behind an authenticated route, so they are fetched as a blob (a
 * plain <img src> cannot send the bearer token) and the object URL is revoked
 * when the tile goes away.
 */
function useImageBlob(licenseId: string, imageId: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let created: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/licenses/${licenseId}/images/${imageId}`, {
          headers: { Authorization: `Bearer ${getToken() ?? ''}` },
        });
        if (!res.ok) return;
        created = URL.createObjectURL(await res.blob());
        if (!cancelled) setUrl(created);
      } catch {
        /* a missing preview never breaks the row or the dialog */
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [licenseId, imageId]);
  return url;
}

function Tile({ licenseId, image, canManage, onOpen, onRemoved }: {
  licenseId: string;
  image: LicenseImageMeta;
  canManage: boolean;
  onOpen: () => void;
  onRemoved: () => void;
}) {
  const url = useImageBlob(licenseId, image.id);
  const [removing, setRemoving] = useState(false);

  const remove = async () => {
    setRemoving(true);
    try {
      await api(`/licenses/${licenseId}/images/${image.id}`, { method: 'DELETE' });
      toast('Picture removed');
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
        aria-label="View picture"
        title={`${Math.max(1, Math.round(image.size / 1024))} KB`}
        className="block aspect-[4/3] w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50 hover:border-gold"
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
          title="Remove this picture"
          aria-label="Remove this picture"
          className="absolute right-1 top-1 h-6 w-6 rounded-full border border-gray-200 bg-white/90 text-xs leading-none text-red-600 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:text-gray-300"
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * License scans — the certificate pages of one company licence, up to five
 * pictures. Stored privately on the server (EXIF stripped) and only served to
 * staff with import/export license access.
 */
export function LicenseImages({ licenseId, canManage, onChanged }: {
  licenseId: string;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const [images, setImages] = useState<LicenseImageMeta[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Never clears `error` here: an upload finishes with a message of its own
  // ("the rest were skipped") that the reload that follows must not wipe.
  const reload = useCallback(async () => {
    try {
      setImages(await api<LicenseImageMeta[]>(`/licenses/${licenseId}/images`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load pictures');
      setImages([]);
    }
  }, [licenseId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const changed = () => {
    void reload();
    onChanged?.();
  };

  /** One pick may hold several pictures: they are sent one by one, and the
   *  ones that no longer fit are refused here before the round trip. */
  const upload = async (picked: File[]) => {
    setError('');
    const room = LICENSE_IMAGE_MAX - (images?.length ?? 0);
    const files = picked.slice(0, room);
    if (files.length === 0) return;
    setBusy(true);
    let added = 0;
    let failure = '';
    for (const file of files) {
      // mirror the server rules so an obviously wrong file never leaves the browser
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        failure = 'Only JPEG, PNG or WebP images are allowed';
        continue;
      }
      if (file.size > MAX_BYTES) {
        failure = 'Picture too large (max 5 MB)';
        continue;
      }
      try {
        const token = getToken();
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(`/api/licenses/${licenseId}/images`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        });
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        if (!res.ok) throw new Error(body.message ?? `Upload failed (${res.status})`);
        added += 1;
      } catch (e) {
        failure = e instanceof Error ? e.message : 'Upload failed';
      }
    }
    setBusy(false);
    if (picked.length > files.length) failure = `Only ${room} more picture${room === 1 ? '' : 's'} fit — the rest were skipped`;
    if (failure) setError(failure);
    if (added) toast(added === 1 ? 'Picture added' : `${added} pictures added`);
    changed();
    if (inputRef.current) inputRef.current.value = '';
  };

  const list = images ?? [];
  const full = list.length >= LICENSE_IMAGE_MAX;

  return (
    <section aria-label="License pictures">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-800">
          🗂️ License pictures{' '}
          <span className={`text-xs font-normal ${full ? 'text-amber-700' : 'text-gray-400'}`}>
            {list.length}/{LICENSE_IMAGE_MAX}
          </span>
        </h3>
        {canManage && (
          <Button
            variant="ghost"
            onClick={() => inputRef.current?.click()}
            disabled={full || busy}
            title={full ? `Up to ${LICENSE_IMAGE_MAX} pictures — remove one first` : `Choose up to ${LICENSE_IMAGE_MAX - list.length} picture(s)`}
          >
            {busy ? 'Uploading…' : '+ Add pictures'}
          </Button>
        )}
      </div>

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 px-3 py-4 text-center text-xs text-gray-400">
          {images === null ? 'Loading…' : canManage ? 'No picture yet — use “+ Add pictures”.' : 'No picture uploaded.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {list.map((image) => (
            <Tile
              key={image.id}
              licenseId={licenseId}
              image={image}
              canManage={canManage}
              onOpen={() => setPreview(image.id)}
              onRemoved={changed}
            />
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          if (picked.length) void upload(picked);
        }}
      />

      {preview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={() => setPreview(null)}>
          <div className="w-full max-w-4xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex justify-end pb-2">
              <button className="text-lg leading-none text-white/80 hover:text-white" onClick={() => setPreview(null)} aria-label="Close picture">
                ×
              </button>
            </div>
            <Preview licenseId={licenseId} imageId={preview} />
          </div>
        </div>
      )}
    </section>
  );
}

function Preview({ licenseId, imageId }: { licenseId: string; imageId: string }) {
  const url = useImageBlob(licenseId, imageId);
  return (
    <div className="rounded-lg bg-white p-2">
      {url ? (
        <img src={url} alt="License picture" className="mx-auto max-h-[75vh] w-auto rounded" />
      ) : (
        <div className="py-20 text-center text-sm text-gray-400">Loading picture…</div>
      )}
    </div>
  );
}
