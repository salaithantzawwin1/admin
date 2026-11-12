import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api';
import { PageHeader, Card, Button, Badge } from '../components/ui';

/**
 * Training screen for the offline seven-segment reader.
 *
 * The reader has no model to download: its classifier is the digit glyphs an
 * administrator labels here. Pick a stored dashboard photo, then either let the
 * reader find the ODO row (it knows where these dashboards put it after the
 * first label) or drag a box around the digits yourself — a phone photo has
 * glare, a clock and a speedometer, and the first photo of a new dashboard needs
 * that human hint. Type the reading the photo really shows and the glyphs, plus
 * the row position, are saved: no key, no internet, nothing to deploy.
 */

interface Stats {
  perDigit: Record<string, number>;
  total: number;
  calibrations: number;
  ready: boolean;
}

interface Photo {
  assignmentId: string;
  stage: string;
  vehicleNo: string | null;
  typedKm: number | null;
  at: string | null;
  photoUrl: string;
  labelled: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Digit {
  index: number;
  box: Box;
  guess: string | null;
  score: number;
  patch: string;
}

interface Analysis {
  assignmentId: string;
  stage: string;
  photoUrl: string;
  row: Box;
  label: Box | null;
  roi: Box;
  polarity: string;
  roiPreview: string;
  digits: Digit[];
  guessKm: number | null;
  templates: number;
}

function normalize(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    x: Math.max(0, Math.min(a.x, b.x)),
    y: Math.max(0, Math.min(a.y, b.y)),
    w: Math.min(1, Math.abs(a.x - b.x)),
    h: Math.min(1, Math.abs(a.y - b.y)),
  };
}

export default function OdometerTraining() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selected, setSelected] = useState<Photo | null>(null);
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [mark, setMark] = useState<Box | null>(null);
  const [km, setKm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([
      api<Stats>('/cars/odometer/training/stats'),
      api<Photo[]>('/cars/odometer/training/photos?limit=40'),
    ]);
    setStats(s);
    setPhotos(p);
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  // The photo endpoint is Bearer-protected, so an <img src> gets a 401: fetch the
  // bytes with the session token and show them from an object URL instead.
  useEffect(() => {
    if (!selected) {
      setPhotoSrc(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(selected.photoUrl, {
          headers: { Authorization: `Bearer ${getToken() ?? ''}` },
        });
        if (!res.ok) throw new Error(`photo could not be loaded (HTTP ${res.status})`);
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPhotoSrc(objectUrl);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selected]);

  async function analyze(box: Box | null) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { assignmentId: selected.assignmentId, stage: selected.stage };
      if (box) {
        body.boxX = box.x;
        body.boxY = box.y;
        body.boxW = box.w;
        body.boxH = box.h;
      }
      const result = await api<Analysis>('/cars/odometer/training/analyze', { method: 'POST', body });
      setAnalysis(result);
      if (result.guessKm && !km) setKm(String(result.guessKm));
    } catch (e) {
      setAnalysis(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pick(photo: Photo) {
    setSelected(photo);
    setAnalysis(null);
    setMark(null);
    setError(null);
    setNotice(null);
    setKm(photo.typedKm ? String(photo.typedKm) : '');
  }

  async function save() {
    if (!selected) return;
    const value = Number(km.replace(/\D/g, ''));
    if (!value) {
      setError('Type the reading the photo shows');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { assignmentId: selected.assignmentId, stage: selected.stage, km: value };
      if (mark) {
        body.boxX = mark.x;
        body.boxY = mark.y;
        body.boxW = mark.w;
        body.boxH = mark.h;
      }
      const result = await api<{ stored: number; km: number; stats: Stats }>('/cars/odometer/training/label', {
        method: 'POST',
        body,
      });
      setStats(result.stats);
      setNotice(
        `Saved ${result.stored} digit glyphs for ${result.km.toLocaleString()} km — the reader can use this dashboard now.`,
      );
      setAnalysis(null);
      setSelected(null);
      setMark(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pointOf(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height))),
    };
  }

  const digits = analysis?.digits ?? [];
  const glyphCount = digits.length;

  return (
    <div>
      <PageHeader
        title="Odometer training"
        subtitle="Teach the offline reader this fleet's seven-segment displays — no API key, no internet."
      />

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}
      {notice && <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">{notice}</div>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold text-gray-900">What the reader knows</h2>
              <Badge color={stats?.ready ? 'green' : 'yellow'}>{stats?.ready ? 'Ready' : 'Learning'}</Badge>
            </div>
            <p className="text-sm text-gray-500 mb-3">
              {stats ? `${stats.total} digit glyphs from ${stats.calibrations} labelled photo(s).` : 'Loading…'}
            </p>
            <div className="grid grid-cols-5 gap-2">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => {
                const n = stats?.perDigit?.[String(d)] ?? 0;
                return (
                  <div
                    key={d}
                    className={`rounded-lg border px-2 py-1 text-center ${n >= 3 ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'}`}
                  >
                    <div className="font-mono text-sm text-gray-900">{d}</div>
                    <div className="text-[11px] text-gray-500">{n}</div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-gray-400 mt-3">
              A reading is reported only when every digit matches a labelled glyph and clearly beats the next candidate — a
              doubtful photo is a miss, never a wrong number.
            </p>
          </Card>

          <Card className="p-4">
            <h2 className="font-semibold text-gray-900 mb-2">Photos to label</h2>
            {!photos.length && <p className="text-sm text-gray-500">No stored dashboard photos yet.</p>}
            <div className="max-h-[26rem] overflow-y-auto divide-y divide-gray-100">
              {photos.map((p) => {
                const active = selected?.assignmentId === p.assignmentId && selected?.stage === p.stage;
                return (
                  <button
                    key={`${p.assignmentId}:${p.stage}`}
                    onClick={() => pick(p)}
                    disabled={busy}
                    className={`w-full text-left px-2 py-2 hover:bg-gray-50 disabled:opacity-60 ${active ? 'bg-amber-50' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900">
                        {p.vehicleNo ?? 'Vehicle'} · {p.stage === 'READY' ? 'Departure' : 'Return'}
                      </span>
                      {p.labelled && <Badge color="green">labelled</Badge>}
                    </div>
                    <div className="text-xs text-gray-500">
                      {p.at ? new Date(p.at).toLocaleDateString() : ''}
                      {p.typedKm != null ? ` · driver typed ${p.typedKm.toLocaleString()} km` : ''}
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>
        </div>

        <Card className="p-4">
          {!selected && <p className="text-sm text-gray-500">Pick a photo on the left to see what the reader finds.</p>}
          {selected && (
            <div className="space-y-4">
              <div>
                <h2 className="font-semibold text-gray-900">The reader's view</h2>
                <p className="text-xs text-gray-500">
                  Drag a box around the ODO digits, or let the reader find them — after one labelled photo of a dashboard it
                  already knows where to look.
                </p>
              </div>

              {!photoSrc && !error && <p className="text-sm text-gray-500">Loading the photo…</p>}
              {photoSrc && (
                <div
                  className="relative select-none touch-none cursor-crosshair rounded-lg overflow-hidden border border-gray-200"
                  onPointerDown={(e) => {
                    dragFrom.current = pointOf(e);
                    setMark(null);
                    setAnalysis(null);
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!dragFrom.current) return;
                    const box = normalize(dragFrom.current, pointOf(e));
                    if (box.w > 0.005 && box.h > 0.003) setMark(box);
                  }}
                  onPointerUp={() => {
                    dragFrom.current = null;
                  }}
                >
                  <img src={photoSrc} alt="Dashboard photo" className="w-full block" draggable={false} />
                  {mark && (
                    <div
                      className="absolute border-2 border-amber-400 bg-amber-300/20"
                      style={{
                        left: `${mark.x * 100}%`,
                        top: `${mark.y * 100}%`,
                        width: `${mark.w * 100}%`,
                        height: `${mark.h * 100}%`,
                      }}
                    />
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => analyze(mark)} disabled={busy || !photoSrc}>
                  {busy ? 'Reading…' : mark ? 'Read the marked row' : 'Find the ODO row'}
                </Button>
                {mark && (
                  <Button variant="ghost" onClick={() => setMark(null)} disabled={busy}>
                    Clear box
                  </Button>
                )}
                {mark && (
                  <span className="text-xs text-gray-500">
                    marked {Math.round(mark.w * 100)}% × {Math.round(mark.h * 100)}%
                  </span>
                )}
              </div>

              {analysis && (
                <>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                      Row it cut out · {glyphCount} glyph{glyphCount === 1 ? '' : 's'} · {analysis.polarity}
                    </div>
                    <img src={analysis.roiPreview} alt="ODO row" className="w-full rounded border border-gray-200 bg-black" />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {digits.map((d) => (
                      <div key={d.index} className="text-center">
                        <img
                          src={d.patch}
                          alt={`digit ${d.index}`}
                          className="h-16 w-auto rounded border border-gray-200 bg-black"
                        />
                        <div className="text-[11px] text-gray-500 mt-1">
                          {d.guess ?? '?'} {d.guess ? `(${Math.round(d.score * 100)}%)` : ''}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="odo-km">
                      Reading shown in the photo
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="odo-km"
                        value={km}
                        onChange={(e) => setKm(e.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                        placeholder={analysis.guessKm ? String(analysis.guessKm) : '341363'}
                        className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none"
                      />
                      <Button onClick={save} disabled={busy || !km}>
                        {busy ? 'Saving…' : 'Save as training data'}
                      </Button>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      The number must have {glyphCount} digits to match the glyphs above — if it does not, drag a tighter box
                      around the digits (or pick a clearer photo).
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
