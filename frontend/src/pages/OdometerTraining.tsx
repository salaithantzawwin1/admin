import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader, Card, Button, Badge } from '../components/ui';

/**
 * Training screen for the offline seven-segment reader.
 *
 * The reader has no model to download: its classifier is the digit glyphs an
 * administrator labels here. Pick a stored dashboard photo, the reader shows the
 * LCD row it found and the digits it cut out, type the reading the photo really
 * shows, and those glyphs (plus where the row sat in the cluster) are saved —
 * the reader recognises that dashboard from then on, with no key and no internet.
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

interface Digit {
  index: number;
  box: { x: number; y: number; w: number; h: number };
  guess: string | null;
  score: number;
  patch: string;
}

interface Analysis {
  assignmentId: string;
  stage: string;
  photoUrl: string;
  cluster: { x: number; y: number; w: number; h: number };
  roi: { x: number; y: number; w: number; h: number };
  polarity: string;
  roiPreview: string;
  digits: Digit[];
  guessKm: number | null;
  templates: number;
}

export default function OdometerTraining() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selected, setSelected] = useState<Photo | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [km, setKm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  async function pick(photo: Photo) {
    setSelected(photo);
    setAnalysis(null);
    setError(null);
    setNotice(null);
    setKm(photo.typedKm ? String(photo.typedKm) : '');
    setBusy(true);
    try {
      const result = await api<Analysis>('/cars/odometer/training/analyze', {
        method: 'POST',
        body: { assignmentId: photo.assignmentId, stage: photo.stage },
      });
      setAnalysis(result);
      if (result.guessKm) setKm(String(result.guessKm));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
    setNotice(null);
    try {
      const result = await api<{ stored: number; km: number; stats: Stats }>('/cars/odometer/training/label', {
        method: 'POST',
        body: { assignmentId: selected.assignmentId, stage: selected.stage, km: value },
      });
      setStats(result.stats);
      setNotice(`Saved ${result.stored} digit glyphs for ${result.km.toLocaleString()} km — the reader can use this dashboard now.`);
      setAnalysis(null);
      setSelected(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const digits = analysis?.digits ?? [];

  return (
    <div>
      <PageHeader
        title="Odometer training"
        subtitle="Teach the offline reader this fleet's seven-segment displays — no API key, no internet."
      />

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}
      {notice && <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">{notice}</div>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
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
                  <div key={d} className={`rounded-lg border px-2 py-1 text-center ${n >= 3 ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'}`}>
                    <div className="font-mono text-sm text-gray-900">{d}</div>
                    <div className="text-[11px] text-gray-500">{n}</div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-gray-400 mt-3">
              The reader only reports a reading when every digit matches a labelled glyph and is clearly ahead of the next
              candidate — a doubtful photo is a miss, never a wrong number.
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
                  {selected.vehicleNo ?? 'Vehicle'} · {selected.stage === 'READY' ? 'Departure' : 'Return'} · LCD row found at{' '}
                  {analysis ? `${Math.round(analysis.roi.w)}×${Math.round(analysis.roi.h)} px inside the cluster` : '…'}
                </p>
              </div>

              <img src={selected.photoUrl} alt="Dashboard photo" className="w-full rounded-lg border border-gray-200" />

              {busy && !analysis && <p className="text-sm text-gray-500">Looking for the LCD row…</p>}

              {analysis && (
                <>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">LCD row it cut out</div>
                    <img src={analysis.roiPreview} alt="LCD row" className="w-full rounded border border-gray-200 bg-black" />
                  </div>

                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                      {digits.length} digit glyph{digits.length === 1 ? '' : 's'} cut from that row
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {digits.map((d) => (
                        <div key={d.index} className="text-center">
                          <img src={d.patch} alt={`digit ${d.index}`} className="h-16 w-auto rounded border border-gray-200 bg-black" />
                          <div className="text-[11px] text-gray-500 mt-1">
                            {d.guess ?? '?'} {d.guess ? `(${Math.round(d.score * 100)}%)` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
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
                        className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-gold focus:outline-none"
                      />
                      <Button onClick={save} disabled={busy || !km}>
                        {busy ? 'Saving…' : 'Save as training data'}
                      </Button>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      The number must match the glyph count above ({digits.length}) — label a steadier photo if it does not.
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
